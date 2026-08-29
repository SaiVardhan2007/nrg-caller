import { supabase } from "./supabaseClient.js";
import { showToast, escapeHtml, debounce, initColumnDragReorder, reapplyColumnOrder, initHorizontalScroll, populateFilterSelect, downloadExcel, exportTableToExcel } from "./utils.js";

// Wires a page's "⬇ Export Excel" button to dump its current (filtered/sorted) table as-is.
function wireExportBtn(btnId, tableId, filenamePrefix) {
  document.getElementById(btnId)?.addEventListener("click", () => {
    exportTableToExcel(document.getElementById(tableId), `${filenamePrefix}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  });
}

let placesCache = [];
let wired = false;
let stockWired = false;
let dashboardWired = false;
let bulkImportWired = false;
let dashboardBooks = new Map();
let latestTodayArea = null;
let latestTodayEvent = null;

// The "Add Sales" modal's reference data (book catalog, places, standard
// prices, current stock) needs 4 queries — 2 of them full-table scans over
// book_inward_stock/book_outward_stock — so re-running them on every single
// modal open was what made it feel slow to launch. Short TTL cache instead;
// invalidated immediately after a save since stock just changed.
let outwardModalDataCache = null;
let outwardModalDataCacheAt = 0;
const OUTWARD_MODAL_CACHE_TTL_MS = 60 * 1000;

async function getOutwardModalData() {
  if (outwardModalDataCache && Date.now() - outwardModalDataCacheAt < OUTWARD_MODAL_CACHE_TTL_MS) {
    return outwardModalDataCache;
  }
  const [bookCatalog, placeNames, eventNames, { data: standardPrices }, currentStock] = await Promise.all([
    fetchBookCatalog(), fetchPlaceNames(), fetchEventNames(),
    supabase.from("book_standard_prices").select("book_key,standard_selling_price"),
    fetchCurrentStockByKey(),
  ]);
  outwardModalDataCache = { bookCatalog, placeNames, eventNames, standardPrices: standardPrices || [], currentStock };
  outwardModalDataCacheAt = Date.now();
  return outwardModalDataCache;
}

function fmtMoney(n) {
  return "₹" + (Math.round((n || 0) * 100) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function bookKey(name, language) {
  return `${name}||${language || ""}`;
}

/* ======================= FILTER / SORT HELPERS =======================
   Generalized versions of Master Contact's search box, per-column header
   filters and sort dropdown (see admin.js renderContactsTable) — reused
   as-is across every Book Distribution table instead of rewriting per page. */

function distinctValues(rows, field) {
  return Array.from(new Set(rows.map((r) => r[field]).filter(Boolean))).sort();
}

// Renders a <select class="inline-edit"> in place of a free-text input for
// table cells whose values should come from a known set (Language, Sold
// Area, Event, Sold By, Place) — cuts down on typo'd variants of the same
// place/event fragmenting the filters and reports. The row's own current
// value is always included even if it's since fallen out of `values`, so
// editing a row never silently blanks a legacy/one-off value.
function editSelectHtml(field, values, current, extraClass = "") {
  const opts = new Set(values);
  if (current) opts.add(current);
  const sorted = Array.from(opts).sort();
  return `<select class="inline-edit${extraClass ? " " + extraClass : ""}" data-field="${field}">` +
    `<option value=""${current ? "" : " selected"}>— Select —</option>` +
    sorted.map((v) => `<option value="${escapeHtml(v)}"${v === current ? " selected" : ""}>${escapeHtml(v)}</option>`).join("") +
    `</select>`;
}

function groupBy(rows, field) {
  const map = new Map();
  rows.forEach((r) => {
    const key = r[field] || "";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  });
  return map;
}

function matchesSearch(row, term, fields) {
  if (!term) return true;
  return fields.some((f) => String(row[f] || "").toLowerCase().includes(term));
}

// "All" (default) applies no filter; picking a real value shows only rows
// with that value; picking the blank option ("") shows only untagged rows.
function matchesSelectFilters(row, filters) {
  for (const [selectId, field] of filters) {
    const val = document.getElementById(selectId)?.value ?? "__ALL__";
    if (val === "__ALL__") continue;
    const cellVal = row[field] || "";
    if (val === "" ? cellVal !== "" : cellVal !== val) return false;
  }
  return true;
}

// for free-text columns with no fixed value set — only "All" vs "Blank Only".
function matchesBlankOnlyFilters(row, filters) {
  for (const [selectId, field] of filters) {
    const val = document.getElementById(selectId)?.value ?? "__ALL__";
    if (val !== "__BLANK__") continue;
    if (row[field]) return false;
  }
  return true;
}

function matchesNumberFilters(row, filters) {
  for (const [inputId, field] of filters) {
    const raw = document.getElementById(inputId)?.value ?? "";
    if (raw === "") continue;
    const num = parseFloat(raw);
    if (Number.isNaN(num)) continue;
    if (Number(row[field] ?? NaN) !== num) return false;
  }
  return true;
}

// Every Book Distribution filter field lives in two places at once — the
// sidebar toolbar and a matching control embedded in its own <th> (the
// "click the column header, pick a value" ask) — kept in sync here so
// either one can be used interchangeably instead of drifting apart and
// silently AND-ing against each other.
function pairFilterControls(idA, idB, onChange) {
  const elA = document.getElementById(idA);
  const elB = document.getElementById(idB);
  if (!elA || !elB) return;
  const wire = (src, dst) => {
    if (src.tagName === "SELECT") {
      src.addEventListener("change", () => { dst.value = src.value; onChange(); });
    } else {
      src.addEventListener("input", debounce(() => { dst.value = src.value; onChange(); }, 200));
    }
  };
  wire(elA, elB);
  wire(elB, elA);
}

// Populates a sidebar <select> and its paired header <select> with the same
// distinct-value option list in one call.
function populatePairedSelect(idA, idB, values) {
  populateFilterSelect(document.getElementById(idA), values);
  populateFilterSelect(document.getElementById(idB), values);
}

// Click-to-edit for table cells: an <input>/<select class="inline-edit"> sits
// directly in the cell (borderless until hover/focus, see .inline-edit in
// theme.css) instead of a separate Edit button + modal — matches Master
// Contact / New Contacts elsewhere in the app. Saves straight to Supabase
// on change/blur.
function wireInlineEditCells(tbody, tableName, cache, { numberFields = [], requiredFields = [] } = {}, afterSave) {
  tbody.querySelectorAll(".inline-edit").forEach((el) => {
    el.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const field = e.target.dataset.field;
      const record = cache.find((x) => x.id === id);
      const raw = e.target.value.trim();

      if (requiredFields.includes(field) && !raw) {
        showToast(`${field.replace(/_/g, " ")} cannot be empty.`, "error");
        e.target.value = record[field] ?? "";
        return;
      }

      const value = numberFields.includes(field) ? (raw === "" ? null : Number(raw)) : (raw || null);
      const { error } = await supabase.from(tableName).update({ [field]: value }).eq("id", id);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        e.target.value = record[field] ?? "";
        return;
      }
      record[field] = value;
      if (afterSave) await afterSave();
    });
  });
}

function sortRows(rows, sortVal, defaultVal) {
  const [field, dir] = (sortVal || defaultVal).split("-");
  const ascending = dir !== "desc";
  return [...rows].sort((a, b) => {
    let av = a[field], bv = b[field];
    if (typeof av === "string" || typeof bv === "string") {
      av = (av || "").toLowerCase();
      bv = (bv || "").toLowerCase();
      return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    av = av ?? 0;
    bv = bv ?? 0;
    return ascending ? av - bv : bv - av;
  });
}

const PLACES_COLUMNS_KEY = "nrg-book-places-column-order";
const DEFAULT_PLACES_COLUMNS = ["S.No", "Name", "Description", "Map Link", ""];
const PLACES_BLANK_FILTERS = [["bp-filter-description", "description"], ["bp-filter-map-link", "map_link"]];
let placesFiltersWired = false;

export async function initPlaces() {
  wirePlaceModal();
  wirePlacesFilters();
  await loadPlaces();
}

async function loadPlaces() {
  const tbody = document.getElementById("book-places-body");
  tbody.innerHTML = `<tr><td colspan="5" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("book_places")
    .select("id,name,description,map_link")
    .order("name", { ascending: true });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading-row">Could not load places.</td></tr>`;
    return;
  }
  placesCache = data || [];
  applyPlacesFilters();
}

function renderPlacesRows(rows, emptyMessage) {
  const tbody = document.getElementById("book-places-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((p, idx) => `
    <tr data-id="${p.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Name"><input class="inline-edit" data-field="name" value="${escapeHtml(p.name)}" /></td>
      <td data-label="Description"><input class="inline-edit" data-field="description" value="${escapeHtml(p.description || "")}" /></td>
      <td data-label="Map Link">
        <div style="display:flex;align-items:center;gap:4px;">
          <input class="inline-edit" data-field="map_link" value="${escapeHtml(p.map_link || "")}" placeholder="https://" />
          ${p.map_link ? `<a href="${escapeHtml(p.map_link)}" target="_blank" rel="noopener noreferrer" class="cell-chip" title="Open Map">📍</a>` : ""}
        </div>
      </td>
      <td data-label="">
        <button type="button" class="cell-chip danger place-delete-btn" title="Delete">🗑 Delete</button>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".place-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deletePlace(btn.closest("tr").dataset.id));
  });
  wireInlineEditCells(tbody, "book_places", placesCache, { requiredFields: ["name"] }, loadPlaces);
  reapplyColumnOrder("book-places-table");
}

function applyPlacesFilters() {
  const search = document.getElementById("bp-search")?.value.trim().toLowerCase() || "";
  let rows = placesCache.filter((p) =>
    matchesSearch(p, search, ["name", "description"]) && matchesBlankOnlyFilters(p, PLACES_BLANK_FILTERS)
  );
  rows = sortRows(rows, document.getElementById("bp-sort")?.value, "name-asc");
  renderPlacesRows(rows, placesCache.length ? "No places match your filters." : "No places yet — add one to get started.");
}

function wirePlacesFilters() {
  if (placesFiltersWired) return;
  placesFiltersWired = true;
  document.getElementById("bp-search").addEventListener("input", debounce(applyPlacesFilters, 200));
  document.getElementById("bp-sort").addEventListener("change", applyPlacesFilters);
  pairFilterControls("bp-filter-description", "bp-th-filter-description", applyPlacesFilters);
  pairFilterControls("bp-filter-map-link", "bp-th-filter-map-link", applyPlacesFilters);
  wireExportBtn("bp-export-btn", "book-places-table", "Distribution_Places");
  initColumnDragReorder("book-places-table", { storageKey: PLACES_COLUMNS_KEY, columns: DEFAULT_PLACES_COLUMNS, resetBtnId: "bp-reset-columns-btn" });
  initHorizontalScroll("book-places-table-wrap");
}

async function deletePlace(id) {
  const p = placesCache.find((x) => x.id === id);
  if (!confirm(`Delete place "${p?.name || ""}"?`)) return;
  const { error } = await supabase.from("book_places").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  showToast("Place deleted", "success");
  await loadPlaces();
}

function openPlaceModal() {
  document.getElementById("book-place-name").value = "";
  document.getElementById("book-place-description").value = "";
  document.getElementById("book-place-map-link").value = "";
  document.getElementById("book-place-error").classList.add("hidden");
  document.getElementById("book-place-modal").classList.add("active");
}

function wirePlaceModal() {
  if (wired) return;
  wired = true;
  const modal = document.getElementById("book-place-modal");
  const errorEl = document.getElementById("book-place-error");

  document.getElementById("add-book-place-btn").onclick = () => openPlaceModal();
  document.getElementById("add-book-place-user-btn")?.addEventListener("click", () => openPlaceModal());
  document.getElementById("book-place-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("book-place-save-btn").onclick = async () => {
    const name = document.getElementById("book-place-name").value.trim();
    const description = document.getElementById("book-place-description").value.trim();
    const mapLink = document.getElementById("book-place-map-link").value.trim();

    if (!name) {
      errorEl.textContent = "Please enter a name for this place.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (mapLink && !/^https?:\/\//i.test(mapLink)) {
      errorEl.textContent = "Map link must be a valid URL starting with http:// or https://";
      errorEl.classList.remove("hidden");
      return;
    }

    const { error } = await supabase.from("book_places").insert({ name, description: description || null, map_link: mapLink || null });

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast("Place added", "success");
    await loadPlaces();
    await loadPlacesUser();
  };
}

/* ---- Add Places / Add Events: read-only-except-edit views for regular
   users (Book Distribution dashboard → "Add Places" / "Add Events") — same
   book_places/book_events tables as the admin pages above, minus delete and
   the search/sort/column-reorder toolbar. ---- */
let placesUserCache = [];

async function loadPlacesUser() {
  const tbody = document.getElementById("book-places-user-body");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="4" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("book_places")
    .select("id,name,description,map_link")
    .order("name", { ascending: true });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-row">Could not load places.</td></tr>`;
    return;
  }
  placesUserCache = data || [];
  renderPlacesUserRows(placesUserCache);
}

function renderPlacesUserRows(rows) {
  const tbody = document.getElementById("book-places-user-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted-text">No places yet — add one to get started.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((p, idx) => `
    <tr data-id="${p.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Name"><input class="inline-edit" data-field="name" value="${escapeHtml(p.name)}" /></td>
      <td data-label="Description"><input class="inline-edit" data-field="description" value="${escapeHtml(p.description || "")}" /></td>
      <td data-label="Map Link">
        <div style="display:flex;align-items:center;gap:4px;">
          <input class="inline-edit" data-field="map_link" value="${escapeHtml(p.map_link || "")}" placeholder="https://" />
          ${p.map_link ? `<a href="${escapeHtml(p.map_link)}" target="_blank" rel="noopener noreferrer" class="cell-chip" title="Open Map">📍</a>` : ""}
        </div>
      </td>
    </tr>
  `).join("");
  wireInlineEditCells(tbody, "book_places", placesUserCache, { requiredFields: ["name"] }, loadPlacesUser);
}

/* ======================= BOOK EVENTS =======================
   Mirrors Distribution Places exactly (own CRUD table: name/description/
   map_link) — an Event tag any book entry (Outward/Sales, Book Requests,
   Book Expenses) can carry alongside its Place. */

let eventsCache = [];
let eventModalWired = false;
const EVENTS_COLUMNS_KEY = "nrg-book-events-column-order";
const DEFAULT_EVENTS_COLUMNS = ["S.No", "Name", "Description", "Map Link", ""];
const EVENTS_BLANK_FILTERS = [["bev-filter-description", "description"], ["bev-filter-map-link", "map_link"]];
let eventsFiltersWired = false;

export async function initBookEvents() {
  wireEventModal();
  wireEventsFilters();
  await loadBookEvents();
}

async function loadBookEvents() {
  const tbody = document.getElementById("book-events-body");
  tbody.innerHTML = `<tr><td colspan="5" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("book_events")
    .select("id,name,description,map_link")
    .order("name", { ascending: true });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading-row">Could not load events.</td></tr>`;
    return;
  }
  eventsCache = data || [];
  applyEventsFilters();
}

function renderEventsRows(rows, emptyMessage) {
  const tbody = document.getElementById("book-events-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((e, idx) => `
    <tr data-id="${e.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Name"><input class="inline-edit" data-field="name" value="${escapeHtml(e.name)}" /></td>
      <td data-label="Description"><input class="inline-edit" data-field="description" value="${escapeHtml(e.description || "")}" /></td>
      <td data-label="Map Link">
        <div style="display:flex;align-items:center;gap:4px;">
          <input class="inline-edit" data-field="map_link" value="${escapeHtml(e.map_link || "")}" placeholder="https://" />
          ${e.map_link ? `<a href="${escapeHtml(e.map_link)}" target="_blank" rel="noopener noreferrer" class="cell-chip" title="Open Map">📍</a>` : ""}
        </div>
      </td>
      <td data-label="">
        <button type="button" class="cell-chip danger event-delete-btn" title="Delete">🗑 Delete</button>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".event-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteBookEvent(btn.closest("tr").dataset.id));
  });
  wireInlineEditCells(tbody, "book_events", eventsCache, { requiredFields: ["name"] }, loadBookEvents);
  reapplyColumnOrder("book-events-table");
}

function applyEventsFilters() {
  const search = document.getElementById("bev-search")?.value.trim().toLowerCase() || "";
  let rows = eventsCache.filter((e) =>
    matchesSearch(e, search, ["name", "description"]) && matchesBlankOnlyFilters(e, EVENTS_BLANK_FILTERS)
  );
  rows = sortRows(rows, document.getElementById("bev-sort")?.value, "name-asc");
  renderEventsRows(rows, eventsCache.length ? "No events match your filters." : "No events yet — add one to get started.");
}

function wireEventsFilters() {
  if (eventsFiltersWired) return;
  eventsFiltersWired = true;
  document.getElementById("bev-search").addEventListener("input", debounce(applyEventsFilters, 200));
  document.getElementById("bev-sort").addEventListener("change", applyEventsFilters);
  pairFilterControls("bev-filter-description", "bev-th-filter-description", applyEventsFilters);
  pairFilterControls("bev-filter-map-link", "bev-th-filter-map-link", applyEventsFilters);
  wireExportBtn("bev-export-btn", "book-events-table", "Book_Events");
  initColumnDragReorder("book-events-table", { storageKey: EVENTS_COLUMNS_KEY, columns: DEFAULT_EVENTS_COLUMNS, resetBtnId: "bev-reset-columns-btn" });
  initHorizontalScroll("book-events-table-wrap");
}

async function deleteBookEvent(id) {
  const e = eventsCache.find((x) => x.id === id);
  if (!confirm(`Delete event "${e?.name || ""}"?`)) return;
  const { error } = await supabase.from("book_events").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  showToast("Event deleted", "success");
  await loadBookEvents();
}

function openEventModal() {
  document.getElementById("book-event-name").value = "";
  document.getElementById("book-event-description").value = "";
  document.getElementById("book-event-map-link").value = "";
  document.getElementById("book-event-error").classList.add("hidden");
  document.getElementById("book-event-modal").classList.add("active");
}

function wireEventModal() {
  if (eventModalWired) return;
  eventModalWired = true;
  const modal = document.getElementById("book-event-modal");
  const errorEl = document.getElementById("book-event-error");

  document.getElementById("add-book-event-btn").onclick = () => openEventModal();
  document.getElementById("add-book-event-user-btn")?.addEventListener("click", () => openEventModal());
  document.getElementById("book-event-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("book-event-save-btn").onclick = async () => {
    const name = document.getElementById("book-event-name").value.trim();
    const description = document.getElementById("book-event-description").value.trim();
    const mapLink = document.getElementById("book-event-map-link").value.trim();

    if (!name) {
      errorEl.textContent = "Please enter a name for this event.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (mapLink && !/^https?:\/\//i.test(mapLink)) {
      errorEl.textContent = "Map link must be a valid URL starting with http:// or https://";
      errorEl.classList.remove("hidden");
      return;
    }

    const { error } = await supabase.from("book_events").insert({ name, description: description || null, map_link: mapLink || null });

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast("Event added", "success");
    await loadBookEvents();
    await loadEventsUser();
  };
}

let eventsUserCache = [];

async function loadEventsUser() {
  const tbody = document.getElementById("book-events-user-body");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="4" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("book_events")
    .select("id,name,description,map_link")
    .order("name", { ascending: true });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-row">Could not load events.</td></tr>`;
    return;
  }
  eventsUserCache = data || [];
  renderEventsUserRows(eventsUserCache);
}

function renderEventsUserRows(rows) {
  const tbody = document.getElementById("book-events-user-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted-text">No events yet — add one to get started.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((e, idx) => `
    <tr data-id="${e.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Name"><input class="inline-edit" data-field="name" value="${escapeHtml(e.name)}" /></td>
      <td data-label="Description"><input class="inline-edit" data-field="description" value="${escapeHtml(e.description || "")}" /></td>
      <td data-label="Map Link">
        <div style="display:flex;align-items:center;gap:4px;">
          <input class="inline-edit" data-field="map_link" value="${escapeHtml(e.map_link || "")}" placeholder="https://" />
          ${e.map_link ? `<a href="${escapeHtml(e.map_link)}" target="_blank" rel="noopener noreferrer" class="cell-chip" title="Open Map">📍</a>` : ""}
        </div>
      </td>
    </tr>
  `).join("");
  wireInlineEditCells(tbody, "book_events", eventsUserCache, { requiredFields: ["name"] }, loadEventsUser);
}

export async function initPlacesUser() {
  wirePlaceModal();
  await loadPlacesUser();
}

export async function initEventsUser() {
  wireEventModal();
  await loadEventsUser();
}

let inwardAdminWired = false;

async function openInwardModal() {
  document.getElementById("book-inward-name").value = "";
  document.getElementById("book-inward-language").value = "";
  document.getElementById("book-inward-price").value = "";
  document.getElementById("book-inward-quantity").value = "";
  document.getElementById("book-inward-from").value = "";
  document.getElementById("book-inward-error").classList.add("hidden");
  populateDatalist(document.getElementById("book-purchased-from-list"), await fetchPurchasedFromValues());
  document.getElementById("book-inward-modal").classList.add("active");
}

function wireInwardAdminModal(currentUser) {
  if (inwardAdminWired) return;
  inwardAdminWired = true;

  const modal = document.getElementById("book-inward-modal");
  const errorEl = document.getElementById("book-inward-error");

  document.getElementById("add-book-inward-admin-btn").onclick = () => openInwardModal();
  document.getElementById("add-book-dashboard-btn")?.addEventListener("click", () => openInwardModal());
  document.getElementById("book-inward-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("book-inward-save-btn").onclick = async () => {
    const name = document.getElementById("book-inward-name").value.trim();
    const language = document.getElementById("book-inward-language").value.trim();
    const price = document.getElementById("book-inward-price").value;
    const quantity = document.getElementById("book-inward-quantity").value;
    const purchasedFrom = document.getElementById("book-inward-from").value.trim();

    if (!name) {
      errorEl.textContent = "Please enter a name.";
      errorEl.classList.remove("hidden");
      return;
    }

    const payload = {
      name,
      language: language || null,
      purchase_price: price === "" ? null : Number(price),
      quantity: quantity === "" ? null : Number(quantity),
      purchased_from: purchasedFrom || null,
    };
    const { error } = await supabase.from("book_inward_stock").insert(payload);

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast("Inward stock added", "success");
    await initInwardTable(currentUser);
    await renderDashboard();
  };
}

const INWARD_COLUMNS_KEY = "nrg-book-inward-column-order";
const DEFAULT_INWARD_COLUMNS = ["S.No", "Time", "Name", "Language", "Purchase Price", "Quantity", "Purchased From", ""];
const INWARD_SELECT_FILTERS = [["bi-filter-language", "language"], ["bi-filter-from", "purchased_from"]];
const INWARD_NUMBER_FILTERS = [["bi-th-filter-price", "purchase_price"], ["bi-th-filter-qty", "quantity"]];
let inwardCache = [];
let inwardFiltersWired = false;
let currentInwardUser = null;

function renderInwardRows(rows, emptyMessage) {
  const tbody = document.getElementById("book-inward-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, idx) => `
    <tr data-id="${r.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Time">${new Date(r.created_at).toLocaleString()}</td>
      <td data-label="Name"><input class="inline-edit" data-field="name" value="${escapeHtml(r.name)}" /></td>
      <td data-label="Language">${editSelectHtml("language", distinctValues(inwardCache, "language"), r.language || "")}</td>
      <td data-label="Purchase Price"><input class="inline-edit" type="number" min="0" step="0.01" data-field="purchase_price" value="${r.purchase_price ?? ""}" /></td>
      <td data-label="Quantity"><input class="inline-edit" type="number" min="0" step="1" data-field="quantity" value="${r.quantity ?? ""}" /></td>
      <td data-label="Purchased From"><input class="inline-edit" data-field="purchased_from" list="book-purchased-from-list" value="${escapeHtml(r.purchased_from || "")}" /></td>
      <td data-label="">
        <button type="button" class="cell-chip danger inward-delete-btn" title="Delete">🗑 Delete</button>
      </td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".inward-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteInwardRow(btn.closest("tr").dataset.id));
  });
  wireInlineEditCells(tbody, "book_inward_stock", inwardCache, { numberFields: ["purchase_price", "quantity"], requiredFields: ["name"] }, async () => {
    populateDatalist(document.getElementById("book-purchased-from-list"), await fetchPurchasedFromValues());
    await renderDashboard();
  });
  reapplyColumnOrder("book-inward-table");
}

function applyInwardFilters() {
  const search = document.getElementById("bi-search")?.value.trim().toLowerCase() || "";
  let rows = inwardCache.filter((r) =>
    matchesSearch(r, search, ["name", "purchased_from"]) &&
    matchesSelectFilters(r, INWARD_SELECT_FILTERS) &&
    matchesNumberFilters(r, INWARD_NUMBER_FILTERS)
  );
  rows = sortRows(rows, document.getElementById("bi-sort")?.value, "created_at-desc");
  renderInwardRows(rows, inwardCache.length ? "No records match your filters." : "No records yet.");
}

function wireInwardFilters() {
  if (inwardFiltersWired) return;
  inwardFiltersWired = true;
  document.getElementById("bi-search").addEventListener("input", debounce(applyInwardFilters, 200));
  document.getElementById("bi-sort").addEventListener("change", applyInwardFilters);
  pairFilterControls("bi-filter-language", "bi-th-filter-language", applyInwardFilters);
  pairFilterControls("bi-filter-from", "bi-th-filter-from", applyInwardFilters);
  document.getElementById("bi-th-filter-price")?.addEventListener("input", debounce(applyInwardFilters, 200));
  document.getElementById("bi-th-filter-qty")?.addEventListener("input", debounce(applyInwardFilters, 200));
  wireExportBtn("bi-export-btn", "book-inward-table", "Inward_Stock");
  initColumnDragReorder("book-inward-table", { storageKey: INWARD_COLUMNS_KEY, columns: DEFAULT_INWARD_COLUMNS, resetBtnId: "bi-reset-columns-btn" });
  initHorizontalScroll("book-inward-table-wrap");
}

async function deleteInwardRow(id) {
  const r = inwardCache.find((x) => x.id === id);
  if (!confirm(`Delete inward entry "${r?.name || ""}"?`)) return;
  const { error } = await supabase.from("book_inward_stock").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  showToast("Inward stock entry deleted", "success");
  await initInwardTable(currentInwardUser);
  await renderDashboard();
}

export async function initInwardTable(currentUser) {
  currentInwardUser = currentUser;
  wireInwardAdminModal(currentUser);
  wireInwardFilters();
  const tbody = document.getElementById("book-inward-body");
  tbody.innerHTML = `<tr><td colspan="8" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("book_inward_stock")
    .select("id,name,language,purchase_price,quantity,purchased_from,created_at")
    .order("created_at", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="8" class="loading-row">Could not load inward stock.</td></tr>`;
    return;
  }
  inwardCache = data || [];
  populatePairedSelect("bi-filter-language", "bi-th-filter-language", distinctValues(inwardCache, "language"));
  populatePairedSelect("bi-filter-from", "bi-th-filter-from", distinctValues(inwardCache, "purchased_from"));
  applyInwardFilters();
}

const OUTWARD_COLUMNS_KEY = "nrg-book-outward-column-order";
const DEFAULT_OUTWARD_COLUMNS = ["S.No", "Time", "Name", "Language", "Sold Price", "Quantity", "Total", "Sold Area", "Event", "Sold By", "Realised", ""];
const OUTWARD_SELECT_FILTERS = [["bo-filter-language", "language"], ["bo-filter-area", "sold_area"], ["bo-filter-event", "event"], ["bo-filter-by", "sold_by"]];
const OUTWARD_NUMBER_FILTERS = [["bo-th-filter-price", "sold_price"], ["bo-th-filter-qty", "quantity"]];
let outwardCache = [];
let outwardFiltersWired = false;

function renderOutwardRows(rows, emptyMessage) {
  const tbody = document.getElementById("book-outward-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, idx) => `
    <tr data-id="${r.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Time">${new Date(r.created_at).toLocaleString()}</td>
      <td data-label="Name"><input class="inline-edit" data-field="name" value="${escapeHtml(r.name)}" /></td>
      <td data-label="Language">${editSelectHtml("language", distinctValues(outwardCache, "language"), r.language || "")}</td>
      <td data-label="Sold Price"><input class="inline-edit outward-price-input" type="number" min="0" step="0.01" data-field="sold_price" value="${r.sold_price ?? ""}" /></td>
      <td data-label="Quantity"><input class="inline-edit outward-qty-input" type="number" min="0" step="1" data-field="quantity" value="${r.quantity ?? ""}" /></td>
      <td data-label="Total" class="outward-total-cell">${fmtMoney((r.sold_price || 0) * (r.quantity || 0))}</td>
      <td data-label="Sold Area">${editSelectHtml("sold_area", distinctValues(outwardCache, "sold_area"), r.sold_area || "")}</td>
      <td data-label="Event">${editSelectHtml("event", distinctValues(outwardCache, "event"), r.event || "")}</td>
      <td data-label="Sold By">${editSelectHtml("sold_by", distinctValues(outwardCache, "sold_by"), r.sold_by || "")}</td>
      <td data-label="Realised"><input type="checkbox" class="realised-checkbox outward-realised-input" ${r.realised ? "checked" : ""} /></td>
      <td data-label="">
        <button type="button" class="cell-chip danger outward-delete-btn" title="Delete">🗑 Delete</button>
      </td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".outward-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteOutwardRow(btn.closest("tr").dataset.id));
  });
  tbody.querySelectorAll(".outward-realised-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      await toggleOutwardRealised(e.target, outwardCache);
      if ((document.getElementById("bo-filter-realised")?.value ?? "__ALL__") !== "__ALL__") applyOutwardFilters();
    });
  });
  tbody.querySelectorAll("tr[data-id]").forEach((row) => {
    const priceInput = row.querySelector(".outward-price-input");
    const qtyInput = row.querySelector(".outward-qty-input");
    const totalCell = row.querySelector(".outward-total-cell");
    const updateRowTotal = () => {
      totalCell.textContent = fmtMoney((Number(priceInput.value) || 0) * (Number(qtyInput.value) || 0));
    };
    priceInput.addEventListener("input", updateRowTotal);
    qtyInput.addEventListener("input", updateRowTotal);
  });
  wireInlineEditCells(tbody, "book_outward_stock", outwardCache, { numberFields: ["sold_price", "quantity"], requiredFields: ["name"] }, renderDashboard);
  reapplyColumnOrder("book-outward-table");
}

// Shared by the admin Outward Stock table and the Commander page — both edit
// the same realised flag on the same underlying rows, just against different
// caches (the admin table sees its own page's worth, Commander sees everyone's).
async function toggleOutwardRealised(checkboxEl, cache) {
  const id = checkboxEl.closest("tr").dataset.id;
  const record = cache.find((x) => x.id === id);
  const checked = checkboxEl.checked;
  const { error } = await supabase.from("book_outward_stock").update({ realised: checked }).eq("id", id);
  if (error) {
    showToast("Update failed: " + error.message, "error");
    checkboxEl.checked = !checked;
    return;
  }
  if (record) record.realised = checked;
  showToast(checked ? "Marked as realised" : "Marked as not realised", "success");
}

function applyOutwardFilters() {
  const from = document.getElementById("bo-filter-from")?.value || "";
  const to = document.getElementById("bo-filter-to")?.value || "";
  const realisedFilter = document.getElementById("bo-filter-realised")?.value ?? "__ALL__";
  let rows = outwardCache.filter((r) =>
    matchesSelectFilters(r, OUTWARD_SELECT_FILTERS) &&
    matchesNumberFilters(r, OUTWARD_NUMBER_FILTERS) &&
    matchesDateRange(r, from, to) &&
    (realisedFilter === "__ALL__" || (realisedFilter === "yes" ? r.realised : !r.realised))
  );
  rows = sortRows(rows, document.getElementById("bo-sort")?.value, "created_at-desc");
  renderOutwardRows(rows, outwardCache.length ? "No records match your filters." : "No records yet.");
}

function wireOutwardFilters() {
  if (outwardFiltersWired) return;
  outwardFiltersWired = true;
  document.getElementById("bo-sort").addEventListener("change", applyOutwardFilters);
  document.getElementById("bo-filter-from").addEventListener("change", applyOutwardFilters);
  document.getElementById("bo-filter-to").addEventListener("change", applyOutwardFilters);
  pairFilterControls("bo-filter-language", "bo-th-filter-language", applyOutwardFilters);
  pairFilterControls("bo-filter-area", "bo-th-filter-area", applyOutwardFilters);
  pairFilterControls("bo-filter-event", "bo-th-filter-event", applyOutwardFilters);
  pairFilterControls("bo-filter-by", "bo-th-filter-by", applyOutwardFilters);
  pairFilterControls("bo-filter-realised", "bo-th-filter-realised", applyOutwardFilters);
  document.getElementById("bo-th-filter-price")?.addEventListener("input", debounce(applyOutwardFilters, 200));
  document.getElementById("bo-th-filter-qty")?.addEventListener("input", debounce(applyOutwardFilters, 200));
  wireExportBtn("bo-export-btn", "book-outward-table", "Outward_Stock");
  initColumnDragReorder("book-outward-table", { storageKey: OUTWARD_COLUMNS_KEY, columns: DEFAULT_OUTWARD_COLUMNS, resetBtnId: "bo-reset-columns-btn" });
  initHorizontalScroll("book-outward-table-wrap");
}

async function deleteOutwardRow(id) {
  const r = outwardCache.find((x) => x.id === id);
  if (!confirm(`Delete outward entry "${r?.name || ""}"?`)) return;
  const { error } = await supabase.from("book_outward_stock").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  showToast("Outward stock entry deleted", "success");
  await initOutwardTable();
  await renderDashboard();
}

export async function initOutwardTable() {
  wireOutwardFilters();
  const tbody = document.getElementById("book-outward-body");
  tbody.innerHTML = `<tr><td colspan="12" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("book_outward_stock")
    .select("id,name,language,sold_price,quantity,sold_area,event,sold_by,created_at,realised")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("book_outward_stock load failed:", error);
    tbody.innerHTML = `<tr><td colspan="12" class="loading-row">Could not load outward stock: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  outwardCache = data || [];
  populatePairedSelect("bo-filter-language", "bo-th-filter-language", distinctValues(outwardCache, "language"));
  populatePairedSelect("bo-filter-area", "bo-th-filter-area", distinctValues(outwardCache, "sold_area"));
  populatePairedSelect("bo-filter-event", "bo-th-filter-event", distinctValues(outwardCache, "event"));
  populatePairedSelect("bo-filter-by", "bo-th-filter-by", distinctValues(outwardCache, "sold_by"));
  applyOutwardFilters();
}

// "Your ... Stock Entries" only needs to show what's still awaiting the
// user's memory — the last 72 hours — since they submit a fresh batch every
// few hours; older entries stay in the database but drop off this list.
function past72HoursISO() {
  return new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
}

function startOfLocalDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
function endOfLocalDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}
function toLocalDateInputValue(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function renderMyInward(userName) {
  const tbody = document.getElementById("my-inward-body");
  const { data, error } = await supabase
    .from("book_inward_stock")
    .select("name,language,purchase_price,quantity,purchased_from,created_at")
    .eq("added_by", userName)
    .gte("created_at", past72HoursISO())
    .order("created_at", { ascending: false });

  if (error || !data.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-text">No records in the last 72 hours.</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map((r, idx) => `
    <tr>
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Time">${new Date(r.created_at).toLocaleString()}</td>
      <td data-label="Name">${escapeHtml(r.name)}</td>
      <td data-label="Language">${escapeHtml(r.language || "—")}</td>
      <td data-label="Purchase Price">${r.purchase_price ?? "—"}</td>
      <td data-label="Quantity">${r.quantity ?? "—"}</td>
      <td data-label="Purchased From">${escapeHtml(r.purchased_from || "—")}</td>
    </tr>
  `).join("");
}

async function renderMyOutward(userName) {
  const tbody = document.getElementById("my-outward-body");
  const { data, error } = await supabase
    .from("book_outward_stock")
    .select("name,language,sold_price,quantity,sold_area,created_at,realised")
    .eq("sold_by", userName)
    .gte("created_at", past72HoursISO())
    .order("created_at", { ascending: false });

  if (error || !data.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted-text">No records in the last 72 hours.</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map((r, idx) => `
    <tr>
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Name">${escapeHtml(r.name)}</td>
      <td data-label="Count">${r.quantity ?? "—"}</td>
      <td data-label="Price">${r.sold_price ?? "—"}</td>
      <td data-label="Total">${fmtMoney((r.sold_price || 0) * (r.quantity || 0))}</td>
      <td data-label="Realised"><span class="history-badge history-badge-${r.realised ? "positive" : "neutral"}">${r.realised ? "✓ Realised" : "Pending"}</span></td>
    </tr>
  `).join("");
}

async function renderLatestEntryLocation(userName) {
  const indicator = document.getElementById("book-latest-location-indicator");
  const { data, error } = await supabase
    .from("book_outward_stock")
    .select("sold_area,event,created_at")
    .eq("sold_by", userName)
    .order("created_at", { ascending: false })
    .limit(1);

  const row = !error && data && data[0];
  const isToday = row && new Date(row.created_at) >= startOfLocalDay();
  latestTodayArea = isToday ? row.sold_area : null;
  latestTodayEvent = isToday ? row.event : null;

  if (isToday) {
    const eventPart = row.event ? ` — ${row.event}` : "";
    indicator.textContent = `📍 Latest entry today: ${row.sold_area}${eventPart} (${new Date(row.created_at).toLocaleTimeString()})`;
    indicator.classList.remove("hidden");
  } else {
    indicator.classList.add("hidden");
  }
}

async function fetchBookCatalog() {
  const { data, error } = await supabase.from("book_inward_stock").select("name,language");
  if (error || !data) return [];
  const map = new Map();
  data.forEach((r) => {
    const key = bookKey(r.name, r.language);
    if (!map.has(key)) map.set(key, { name: r.name, language: r.language });
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchCurrentStockByKey() {
  const [{ data: inward }, { data: outward }] = await Promise.all([
    supabase.from("book_inward_stock").select("name,language,quantity"),
    supabase.from("book_outward_stock").select("name,language,quantity"),
  ]);
  const map = new Map();
  (inward || []).forEach((r) => {
    const key = bookKey(r.name, r.language);
    map.set(key, (map.get(key) || 0) + (r.quantity || 0));
  });
  (outward || []).forEach((r) => {
    const key = bookKey(r.name, r.language);
    map.set(key, (map.get(key) || 0) - (r.quantity || 0));
  });
  return map;
}

async function fetchPlaceNames() {
  const { data, error } = await supabase.from("book_places").select("name").order("name", { ascending: true });
  if (error || !data) return [];
  return data.map((p) => p.name);
}

async function fetchEventNames() {
  const { data, error } = await supabase.from("book_events").select("name").order("name", { ascending: true });
  if (error || !data) return [];
  return data.map((e) => e.name);
}

// "Purchased From" has no dedicated table — like books, new values are simply
// whatever gets typed on an inward entry, and become suggestions for next time.
async function fetchPurchasedFromValues() {
  const { data, error } = await supabase
    .from("book_inward_stock")
    .select("purchased_from")
    .not("purchased_from", "is", null);
  if (error || !data) return [];
  return Array.from(new Set(data.map((r) => r.purchased_from).filter(Boolean))).sort();
}

function populateDatalist(datalist, values) {
  datalist.innerHTML = values.map((v) => `<option value="${escapeHtml(v)}"></option>`).join("");
}

function bookLabel(b) {
  return `${b.name}${b.language ? ` (${b.language})` : ""}`;
}

// Lightweight combobox: a text input the user can type into to filter, plus a
// custom dropdown list — used instead of <input list="..."> datalists, which
// render as a bulky OS popup on mobile Chrome instead of an inline dropdown.
// The dropdown is appended to <body> with position:fixed (not nested/absolute)
// so it isn't clipped by the modal's own overflow-y:auto scroll box. Returns
// { destroy } — callers must invoke it when the input is removed (e.g. a
// stock row is deleted), since the dropdown lives outside the row's subtree
// and won't be garbage-collected by removing the row alone.
function wireSearchableCombo(input, getOptions) {
  const dropdown = document.createElement("div");
  dropdown.className = "combo-dropdown";
  document.body.appendChild(dropdown);

  // Double-tap-to-select-word is unreliable across mobile browsers once a
  // long title overflows the input, so give a guaranteed, always-tappable
  // way to clear the field instead of depending on that gesture. Wrapping
  // just the input (not its label's <span>) keeps the button's absolute
  // positioning aligned to the input's own box regardless of the caller's
  // surrounding markup.
  const wrapper = document.createElement("div");
  wrapper.className = "combo-input-wrap";
  input.parentElement.insertBefore(wrapper, input);
  wrapper.appendChild(input);
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "combo-clear-btn";
  clearBtn.textContent = "✕";
  clearBtn.setAttribute("aria-label", "Clear");
  clearBtn.style.display = "none";
  wrapper.appendChild(clearBtn);

  let currentOptions = [];
  let activeIndex = -1;
  let suppressReopen = false;

  function updateClearBtn() {
    clearBtn.style.display = input.value ? "flex" : "none";
  }

  function position() {
    const r = input.getBoundingClientRect();
    dropdown.style.left = `${r.left}px`;
    dropdown.style.top = `${r.bottom + 4}px`;
    dropdown.style.width = `${r.width}px`;
  }

  function highlight() {
    dropdown.querySelectorAll(".combo-option").forEach((el, i) => el.classList.toggle("active", i === activeIndex));
    dropdown.querySelector(".combo-option.active")?.scrollIntoView({ block: "nearest" });
  }

  // Matches "bg" against a title either as a plain substring (existing
  // behavior) or against the initials of its words (so "bg" also surfaces
  // "Bhagavad Gita ...") — punctuation is stripped before taking each word's
  // first letter so "(Yatharupa" still contributes "y", not "(".
  function matchesQuery(title, q) {
    const lower = title.toLowerCase();
    if (lower.includes(q)) return true;
    const initials = title
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Z0-9]/g, "").charAt(0))
      .join("")
      .toLowerCase();
    return initials.includes(q);
  }

  function render(query) {
    const all = getOptions();
    const q = (query || "").trim().toLowerCase();
    currentOptions = q ? all.filter((o) => matchesQuery(o, q)) : all;
    activeIndex = -1;
    dropdown.innerHTML = currentOptions.length
      ? currentOptions.slice(0, 100).map((o, i) => `<div class="combo-option" data-idx="${i}">${escapeHtml(o)}</div>`).join("")
      : `<div class="combo-empty">No matches</div>`;
    position();
    dropdown.classList.add("open");
    updateClearBtn();
  }

  function close() { dropdown.classList.remove("open"); }

  function selectOption(value) {
    input.value = value;
    close();
    updateClearBtn();
    // The input listeners that consumers of this combo attach (e.g. to
    // recompute stock/price hints) need this event, but our own onInput
    // below must not react to it — otherwise it re-renders and reopens the
    // dropdown right after the user just picked something.
    suppressReopen = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    suppressReopen = false;
  }

  const onFocus = () => render(input.value);
  const onInput = () => { if (!suppressReopen) render(input.value); };
  const onKeydown = (e) => {
    if (!dropdown.classList.contains("open")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, currentOptions.length - 1); highlight(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); highlight(); }
    else if (e.key === "Enter") { if (activeIndex >= 0) { e.preventDefault(); selectOption(currentOptions[activeIndex]); } }
    else if (e.key === "Escape") { close(); }
  };
  // mousedown (not click) fires before the input's blur closes the dropdown
  const onDropdownMousedown = (e) => {
    const opt = e.target.closest(".combo-option");
    if (!opt) return;
    e.preventDefault();
    selectOption(currentOptions[Number(opt.dataset.idx)]);
  };
  const onDocClick = (e) => { if (e.target !== input && e.target !== clearBtn && !dropdown.contains(e.target)) close(); };
  const onReposition = () => { if (dropdown.classList.contains("open")) position(); };
  const onDblClick = () => input.select();
  // mousedown (not click) so the input's blur/close-dropdown handlers don't
  // fire first and hide the button before its click is processed.
  const onClearMousedown = (e) => e.preventDefault();
  const onClear = () => {
    input.value = "";
    updateClearBtn();
    input.focus();
    render("");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  input.addEventListener("focus", onFocus);
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeydown);
  input.addEventListener("dblclick", onDblClick);
  dropdown.addEventListener("mousedown", onDropdownMousedown);
  clearBtn.addEventListener("mousedown", onClearMousedown);
  clearBtn.addEventListener("click", onClear);
  document.addEventListener("click", onDocClick);
  document.addEventListener("scroll", onReposition, true);
  window.addEventListener("resize", onReposition);

  updateClearBtn();

  return {
    destroy() {
      dropdown.remove();
      clearBtn.remove();
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("input", onInput);
      input.removeEventListener("dblclick", onDblClick);
      input.removeEventListener("keydown", onKeydown);
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    },
  };
}

function buildOutwardRow(catalog, removable, standardPriceByKey, stockByKey, onChange) {
  const row = document.createElement("div");
  row.className = "stock-row";
  row.innerHTML = `
    <label class="field stock-cell-title"><span>Title</span><input type="text" class="stock-row-title" placeholder="Search a book title…" autocomplete="off" /></label>
    <label class="field"><span>Price</span><input type="number" class="stock-row-price" min="0" step="0.01" /></label>
    <label class="field"><span>Qty</span><input type="number" class="stock-row-qty" min="1" step="1" /></label>
    ${removable ? `<button type="button" class="stock-row-remove cell-chip danger" title="Remove">✕</button>` : ""}
    <div class="stock-row-reference-row">
      <span class="stock-row-stock-hint"></span>
      <span class="stock-row-price-hint"></span>
      <span class="stock-row-total-hint"></span>
    </div>
  `;
  const titleInput = row.querySelector(".stock-row-title");
  const priceInput = row.querySelector(".stock-row-price");
  const qtyInput = row.querySelector(".stock-row-qty");
  const stockHintEl = row.querySelector(".stock-row-stock-hint");
  const priceHintEl = row.querySelector(".stock-row-price-hint");
  const totalHintEl = row.querySelector(".stock-row-total-hint");
  const updateRowTotal = () => {
    const price = Number(priceInput.value) || 0;
    const qty = Number(qtyInput.value) || 0;
    totalHintEl.textContent = price && qty ? `🧾 Total: ${fmtMoney(price * qty)}` : "";
  };
  const titleCombo = wireSearchableCombo(titleInput, () => catalog.map(bookLabel));
  row._destroyCombo = titleCombo.destroy;

  titleInput.addEventListener("input", () => {
    const matched = catalog.find((b) => bookLabel(b).toLowerCase() === titleInput.value.trim().toLowerCase());
    const standardPrice = matched ? standardPriceByKey.get(bookKey(matched.name, matched.language)) : null;
    const currentStock = matched ? stockByKey.get(bookKey(matched.name, matched.language)) : null;

    stockHintEl.textContent = matched ? `📦 In Stock: ${currentStock ?? 0}` : "";
    if (standardPrice != null) {
      priceHintEl.textContent = `💰 Selling Price: ${fmtMoney(standardPrice)}`;
      if (!priceInput.value) priceInput.value = standardPrice;
    } else {
      priceHintEl.textContent = matched ? "💰 Selling Price: —" : "";
    }
    updateRowTotal();
    onChange();
  });
  priceInput.addEventListener("input", () => { updateRowTotal(); onChange(); });
  qtyInput.addEventListener("input", () => { updateRowTotal(); onChange(); });
  if (removable) {
    row.querySelector(".stock-row-remove").addEventListener("click", () => { titleCombo.destroy(); row.remove(); onChange(); });
  }
  return row;
}

function wireInwardUserModal(currentUser) {
  const modal = document.getElementById("book-inward-user-modal");
  const errorEl = document.getElementById("book-inward-user-error");
  const nameInput = document.getElementById("book-inward-user-name");
  const languageInput = document.getElementById("book-inward-user-language");
  const qtyInput = document.getElementById("book-inward-user-quantity");
  const fromInput = document.getElementById("book-inward-user-from");
  const fromList = document.getElementById("book-purchased-from-list");
  const addedListEl = document.getElementById("book-inward-user-added-list");
  let addedCount = 0;

  const renderAddedCount = () => {
    addedListEl.textContent = addedCount ? `${addedCount} book${addedCount > 1 ? "s" : ""} added this session.` : "";
  };

  const closeAndRefresh = async () => {
    modal.classList.remove("active");
    if (addedCount) await renderMyInward(currentUser.user_name);
  };

  document.getElementById("add-book-inward-btn").onclick = async () => {
    populateDatalist(fromList, await fetchPurchasedFromValues());
    nameInput.value = "";
    languageInput.value = "";
    qtyInput.value = "";
    fromInput.value = "";
    addedCount = 0;
    renderAddedCount();
    errorEl.classList.add("hidden");
    modal.classList.add("active");
    nameInput.focus();
  };
  document.getElementById("book-inward-user-cancel-btn").onclick = closeAndRefresh;
  modal.addEventListener("click", (e) => { if (e.target === modal) closeAndRefresh(); });

  document.getElementById("book-inward-user-save-btn").onclick = async () => {
    const name = nameInput.value.trim();
    const language = languageInput.value.trim();
    const quantity = qtyInput.value;
    const purchasedFrom = fromInput.value.trim();

    if (!name) {
      errorEl.textContent = "Please enter a book name.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (!quantity || Number(quantity) <= 0) {
      errorEl.textContent = "Please enter a quantity.";
      errorEl.classList.remove("hidden");
      return;
    }

    const { error } = await supabase.from("book_inward_stock").insert({
      name,
      language: language || null,
      quantity: Number(quantity),
      purchased_from: purchasedFrom || null,
      added_by: currentUser.user_name,
    });

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }

    if (purchasedFrom && !Array.from(fromList.options).some((o) => o.value === purchasedFrom)) {
      fromList.appendChild(new Option(purchasedFrom, purchasedFrom));
    }
    addedCount++;
    renderAddedCount();
    showToast("Book added — keep going or click Done", "success");

    // Reset for the next book, but leave Purchased From filled in — most
    // sessions add several books from the same one source in a row.
    nameInput.value = "";
    languageInput.value = "";
    qtyInput.value = "";
    errorEl.classList.add("hidden");
    nameInput.focus();
  };
}

// Rows aren't submitted one at a time (unlike the Inward modal) — a user
// typically builds up this list over several hours in the field, closing and
// reopening the app in between, then submits everything in one Save. So the
// in-progress rows/area are drafted to localStorage on every edit and only
// cleared once the batch is actually saved — closing/cancelling keeps them.
function outwardDraftKey(currentUser) {
  return `nrg-book-outward-draft:${currentUser.user_name}`;
}

function wireOutwardModal(currentUser) {
  const modal = document.getElementById("book-outward-modal");
  const errorEl = document.getElementById("book-outward-error");
  const areaInput = document.getElementById("book-outward-area-select");
  const eventInput = document.getElementById("book-outward-event-select");
  const rowsContainer = document.getElementById("book-outward-rows");
  const totalQtyEl = document.getElementById("book-outward-total-qty");
  const totalCostEl = document.getElementById("book-outward-total-cost");
  const draftKey = outwardDraftKey(currentUser);
  let catalog = [];
  let places = [];
  let events = [];
  let standardPriceByKey = new Map();
  let stockByKey = new Map();
  wireSearchableCombo(areaInput, () => places);
  wireSearchableCombo(eventInput, () => events);

  const saveDraft = () => {
    const rows = Array.from(rowsContainer.querySelectorAll(".stock-row")).map((row) => ({
      title: row.querySelector(".stock-row-title").value,
      price: row.querySelector(".stock-row-price").value,
      qty: row.querySelector(".stock-row-qty").value,
    }));
    localStorage.setItem(draftKey, JSON.stringify({ area: areaInput.value, event: eventInput.value, rows }));
  };

  const updateTotals = () => {
    let totalQty = 0;
    let totalCost = 0;
    rowsContainer.querySelectorAll(".stock-row").forEach((row) => {
      const qty = Number(row.querySelector(".stock-row-qty").value) || 0;
      const price = Number(row.querySelector(".stock-row-price").value) || 0;
      totalQty += qty;
      totalCost += qty * price;
    });
    totalQtyEl.textContent = totalQty;
    totalCostEl.textContent = fmtMoney(totalCost);
  };

  const onRowChange = () => { saveDraft(); updateTotals(); };

  const addRow = (removable, data) => {
    const row = buildOutwardRow(catalog, removable, standardPriceByKey, stockByKey, onRowChange);
    if (data) {
      row.querySelector(".stock-row-title").value = data.title || "";
      row.querySelector(".stock-row-price").value = data.price || "";
      row.querySelector(".stock-row-qty").value = data.qty || "";
      row.querySelector(".stock-row-title").dispatchEvent(new Event("input"));
    }
    rowsContainer.appendChild(row);
    updateTotals();
  };

  document.getElementById("add-book-outward-btn").onclick = async () => {
    outwardSaveInFlight = false;
    saveBtn.disabled = false;
    saveBtn.textContent = saveBtnLabel;
    const { bookCatalog, placeNames, eventNames, standardPrices, currentStock } = await getOutwardModalData();
    catalog = bookCatalog;
    places = placeNames;
    events = eventNames;
    standardPriceByKey = new Map(standardPrices.map((r) => [r.book_key, r.standard_selling_price]));
    stockByKey = currentStock;

    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(draftKey) || "null"); } catch { draft = null; }
    rowsContainer.querySelectorAll(".stock-row").forEach((row) => row._destroyCombo?.());
    rowsContainer.innerHTML = "";
    if (draft && draft.rows && draft.rows.length) {
      areaInput.value = draft.area || "";
      eventInput.value = draft.event || "";
      draft.rows.forEach((data, idx) => addRow(idx > 0, data));
    } else {
      areaInput.value = latestTodayArea || "";
      eventInput.value = latestTodayEvent || "";
      addRow(false);
    }
    errorEl.classList.add("hidden");
    modal.classList.add("active");
  };
  document.getElementById("book-outward-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
  areaInput.addEventListener("input", saveDraft);
  eventInput.addEventListener("input", saveDraft);

  document.getElementById("book-outward-add-row-btn").onclick = () => {
    addRow(true);
  };

  const saveBtn = document.getElementById("book-outward-save-btn");
  const saveBtnLabel = saveBtn.textContent;
  let outwardSaveInFlight = false;

  saveBtn.onclick = async () => {
    if (outwardSaveInFlight) return;
    const areaTyped = areaInput.value.trim();
    if (!areaTyped) {
      errorEl.textContent = "Please select an area.";
      errorEl.classList.remove("hidden");
      return;
    }
    const area = places.find((p) => p.toLowerCase() === areaTyped.toLowerCase());
    if (!area) {
      errorEl.textContent = "Please choose a valid area from the suggestions.";
      errorEl.classList.remove("hidden");
      return;
    }

    const eventTyped = eventInput.value.trim();
    if (!eventTyped) {
      errorEl.textContent = "Please select an event.";
      errorEl.classList.remove("hidden");
      return;
    }
    const event = events.find((ev) => ev.toLowerCase() === eventTyped.toLowerCase());
    if (!event) {
      errorEl.textContent = "Please choose a valid event from the suggestions.";
      errorEl.classList.remove("hidden");
      return;
    }

    const payload = [];
    for (const row of rowsContainer.querySelectorAll(".stock-row")) {
      const value = row.querySelector(".stock-row-title").value.trim();
      const price = row.querySelector(".stock-row-price").value;
      const qty = row.querySelector(".stock-row-qty").value;
      if (!value && !price && !qty) continue;
      if (!value || !qty || Number(qty) <= 0) {
        errorEl.textContent = "Each book row needs a title and a quantity.";
        errorEl.classList.remove("hidden");
        return;
      }
      const matched = catalog.find((b) => bookLabel(b).toLowerCase() === value.toLowerCase());
      if (!matched) {
        errorEl.textContent = `"${value}" isn't a known book — please pick one from the suggestions.`;
        errorEl.classList.remove("hidden");
        return;
      }
      payload.push({
        name: matched.name,
        language: matched.language || null,
        sold_price: price === "" ? null : Number(price),
        quantity: Number(qty),
        sold_area: area,
        event,
        sold_by: currentUser.user_name,
      });
    }

    if (!payload.length) {
      errorEl.textContent = "Please add at least one book.";
      errorEl.classList.remove("hidden");
      return;
    }

    // Give instant feedback and lock the button the moment Save is clicked —
    // the insert can take a few seconds on a slow connection, and without
    // this a user tapping Save again (or twice quickly) submitted the same
    // batch multiple times.
    outwardSaveInFlight = true;
    saveBtn.disabled = true;
    saveBtn.textContent = "Submitted…";

    const { error } = await supabase.from("book_outward_stock").insert(payload);
    if (error) {
      outwardSaveInFlight = false;
      saveBtn.disabled = false;
      saveBtn.textContent = saveBtnLabel;
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    outwardModalDataCache = null;
    localStorage.removeItem(draftKey);
    modal.classList.remove("active");
    showToast("Sales added", "success");
    setTimeout(() => {
      outwardSaveInFlight = false;
      saveBtn.disabled = false;
      saveBtn.textContent = saveBtnLabel;
    }, 4000);
    await renderMyOutward(currentUser.user_name);
    await renderLatestEntryLocation(currentUser.user_name);
  };
}

/* ======================= BOOK REQUESTS ======================= */
// Anyone (regular user or admin) can request a book — either picking one
// from the existing catalog or typing a brand-new title — for a place, with
// a priority. Requests all land in one table; the admin Book Requests tab
// reviews/fulfills them, and each requester's own submissions show on their
// Book Distribution page.

function priorityRank(p) {
  return p === "Immediately" ? 0 : p === "Important" ? 1 : 2;
}

async function fetchBookNames() {
  const catalog = await fetchBookCatalog();
  return Array.from(new Set(catalog.map((b) => b.name))).sort();
}

let requestModalWired = false;

// Shared by the admin "Book Requests" tab and the user's Book Distribution
// page — same modal, same table, just opened from different buttons (see
// wireInwardAdminModal above for the same pattern). Only one of the two
// contexts is ever active in a given session, so the onSaved callback
// captured on first wire is always the right one for that session.
function wireRequestModal(currentUser, onSaved) {
  if (requestModalWired) return;
  requestModalWired = true;

  const modal = document.getElementById("book-request-modal");
  const errorEl = document.getElementById("book-request-error");
  const nameInput = document.getElementById("book-request-name");
  const placeInput = document.getElementById("book-request-place");
  const eventInput = document.getElementById("book-request-event");
  const qtyInput = document.getElementById("book-request-quantity");
  const prioritySelect = document.getElementById("book-request-priority");
  let nameCombo = null;
  let placeCombo = null;
  let eventCombo = null;

  const close = () => {
    nameCombo?.destroy();
    placeCombo?.destroy();
    eventCombo?.destroy();
    nameCombo = null;
    placeCombo = null;
    eventCombo = null;
    modal.classList.remove("active");
  };

  const open = async () => {
    nameInput.value = "";
    placeInput.value = "";
    eventInput.value = "";
    qtyInput.value = "";
    prioritySelect.value = "Can Wait";
    errorEl.classList.add("hidden");

    const [bookNames, placeNames, eventNames] = await Promise.all([fetchBookNames(), fetchPlaceNames(), fetchEventNames()]);
    nameCombo = wireSearchableCombo(nameInput, () => bookNames);
    placeCombo = wireSearchableCombo(placeInput, () => placeNames);
    eventCombo = wireSearchableCombo(eventInput, () => eventNames);
    modal.classList.add("active");
  };

  document.querySelectorAll(".open-book-request-btn").forEach((btn) => btn.addEventListener("click", open));
  document.getElementById("book-request-cancel-btn").onclick = close;
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  document.getElementById("book-request-save-btn").onclick = async () => {
    const name = nameInput.value.trim();
    const place = placeInput.value.trim();
    const event = eventInput.value.trim();
    const quantity = qtyInput.value;
    const priority = prioritySelect.value;

    if (!name) {
      errorEl.textContent = "Please enter a book title.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (!quantity || Number(quantity) <= 0) {
      errorEl.textContent = "Please enter a quantity.";
      errorEl.classList.remove("hidden");
      return;
    }

    const { error } = await supabase.from("book_requests").insert({
      name,
      quantity: Number(quantity),
      place: place || null,
      event: event || null,
      priority,
      requested_by: currentUser.user_name,
    });

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    close();
    showToast("Book request submitted", "success");
    if (onSaved) await onSaved();
  };
}

const REQUESTS_COLUMNS_KEY = "nrg-book-requests-column-order";
const DEFAULT_REQUESTS_COLUMNS = ["S.No", "Time", "Name", "Quantity", "Place", "Event", "Priority", "Requested By", "Fulfilled", ""];
const REQUESTS_SELECT_FILTERS = [["br-filter-priority", "priority"], ["br-filter-place", "place"], ["br-filter-event", "event"], ["br-filter-by", "requested_by"]];
const REQUESTS_NUMBER_FILTERS = [["br-th-filter-qty", "quantity"]];
let requestsCache = [];
let requestsFiltersWired = false;

function renderRequestsRows(rows, emptyMessage) {
  const tbody = document.getElementById("book-requests-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, idx) => `
    <tr data-id="${r.id}" class="${r.priority === "Immediately" && !r.fulfilled ? "row-low-stock" : ""}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Time">${new Date(r.created_at).toLocaleString()}</td>
      <td data-label="Name"><input class="inline-edit" data-field="name" value="${escapeHtml(r.name)}" /></td>
      <td data-label="Quantity"><input class="inline-edit" type="number" min="1" step="1" data-field="quantity" value="${r.quantity ?? ""}" /></td>
      <td data-label="Place">${editSelectHtml("place", distinctValues(requestsCache, "place"), r.place || "")}</td>
      <td data-label="Event">${editSelectHtml("event", distinctValues(requestsCache, "event"), r.event || "")}</td>
      <td data-label="Priority">
        <select class="inline-edit" data-field="priority">
          ${["Immediately", "Important", "Can Wait"].map((p) => `<option value="${p}" ${r.priority === p ? "selected" : ""}>${p}</option>`).join("")}
        </select>
      </td>
      <td data-label="Requested By">${escapeHtml(r.requested_by || "—")}</td>
      <td data-label="Fulfilled"><input type="checkbox" class="inline-edit request-fulfilled-input" data-field="fulfilled" ${r.fulfilled ? "checked" : ""} /></td>
      <td data-label="">
        <button type="button" class="cell-chip danger request-delete-btn" title="Delete">🗑 Delete</button>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".request-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteRequest(btn.closest("tr").dataset.id));
  });
  tbody.querySelectorAll(".request-fulfilled-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const record = requestsCache.find((x) => x.id === id);
      const checked = e.target.checked;
      const { error } = await supabase.from("book_requests").update({ fulfilled: checked }).eq("id", id);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        e.target.checked = !checked;
        return;
      }
      if (record) record.fulfilled = checked;
      e.target.closest("tr").classList.toggle("row-low-stock", record.priority === "Immediately" && !checked);
      showToast(checked ? "Marked as fulfilled" : "Marked as not fulfilled", "success");
    });
  });
  wireInlineEditCells(tbody, "book_requests", requestsCache, { numberFields: ["quantity"], requiredFields: ["name"] }, applyRequestsFilters);
  reapplyColumnOrder("book-requests-table");
}

function applyRequestsFilters() {
  const search = document.getElementById("br-search")?.value.trim().toLowerCase() || "";
  const fulfilledFilter = document.getElementById("br-filter-fulfilled")?.value ?? "__ALL__";
  let rows = requestsCache.filter((r) =>
    matchesSearch(r, search, ["name", "place", "event", "requested_by"]) &&
    matchesSelectFilters(r, REQUESTS_SELECT_FILTERS) &&
    matchesNumberFilters(r, REQUESTS_NUMBER_FILTERS) &&
    (fulfilledFilter === "__ALL__" || (fulfilledFilter === "yes" ? r.fulfilled : !r.fulfilled))
  );
  rows = sortRows(rows, document.getElementById("br-sort")?.value, "created_at-desc");
  renderRequestsRows(rows, requestsCache.length ? "No requests match your filters." : "No book requests yet.");
}

function wireRequestsFilters() {
  if (requestsFiltersWired) return;
  requestsFiltersWired = true;
  document.getElementById("br-search").addEventListener("input", debounce(applyRequestsFilters, 200));
  document.getElementById("br-sort").addEventListener("change", applyRequestsFilters);
  pairFilterControls("br-filter-priority", "br-th-filter-priority", applyRequestsFilters);
  pairFilterControls("br-filter-place", "br-th-filter-place", applyRequestsFilters);
  pairFilterControls("br-filter-event", "br-th-filter-event", applyRequestsFilters);
  pairFilterControls("br-filter-by", "br-th-filter-by", applyRequestsFilters);
  pairFilterControls("br-filter-fulfilled", "br-th-filter-fulfilled", applyRequestsFilters);
  document.getElementById("br-th-filter-qty")?.addEventListener("input", debounce(applyRequestsFilters, 200));
  wireExportBtn("br-export-btn", "book-requests-table", "Book_Requests");
  initColumnDragReorder("book-requests-table", { storageKey: REQUESTS_COLUMNS_KEY, columns: DEFAULT_REQUESTS_COLUMNS, resetBtnId: "br-reset-columns-btn" });
  initHorizontalScroll("book-requests-table-wrap");
}

async function deleteRequest(id) {
  const r = requestsCache.find((x) => x.id === id);
  if (!confirm(`Delete request for "${r?.name || ""}"?`)) return;
  const { error } = await supabase.from("book_requests").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  showToast("Request deleted", "success");
  await initBookRequests();
}

export async function initBookRequests(currentUser) {
  wireRequestsFilters();
  wireRequestModal(currentUser, () => initBookRequests(currentUser));
  const tbody = document.getElementById("book-requests-body");
  tbody.innerHTML = `<tr><td colspan="10" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("book_requests")
    .select("id,name,quantity,place,event,priority,requested_by,fulfilled,created_at")
    .order("created_at", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="10" class="loading-row">Could not load book requests.</td></tr>`;
    return;
  }
  requestsCache = (data || []).map((r) => ({ ...r, priorityRank: priorityRank(r.priority) }));
  populatePairedSelect("br-filter-priority", "br-th-filter-priority", distinctValues(requestsCache, "priority"));
  populatePairedSelect("br-filter-place", "br-th-filter-place", distinctValues(requestsCache, "place"));
  populatePairedSelect("br-filter-event", "br-th-filter-event", distinctValues(requestsCache, "event"));
  populatePairedSelect("br-filter-by", "br-th-filter-by", distinctValues(requestsCache, "requested_by"));
  applyRequestsFilters();
}

async function renderMyRequests(userName) {
  const tbody = document.getElementById("my-requests-body");
  const { data, error } = await supabase
    .from("book_requests")
    .select("name,quantity,place,event,priority,fulfilled,created_at")
    .eq("requested_by", userName)
    .order("created_at", { ascending: false });

  if (error || !data.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-text">No requests yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map((r, idx) => `
    <tr>
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Name">${escapeHtml(r.name)}</td>
      <td data-label="Quantity">${r.quantity ?? "—"}</td>
      <td data-label="Place">${escapeHtml(r.place || "—")}</td>
      <td data-label="Event">${escapeHtml(r.event || "—")}</td>
      <td data-label="Priority">${escapeHtml(r.priority)}</td>
      <td data-label="Status">${r.fulfilled ? "✅ Fulfilled" : "⏳ Pending"}</td>
    </tr>
  `).join("");
}

export async function initRequestPanel(currentUser) {
  wireRequestModal(currentUser, () => renderMyRequests(currentUser.user_name));
  await renderMyRequests(currentUser.user_name);
}

async function renderMyOutwardScore(userName) {
  const fromInput = document.getElementById("my-outward-score-date-from");
  const toInput = document.getElementById("my-outward-score-date-to");
  const from = fromInput.value;
  const to = toInput.value;
  const qtyEl = document.getElementById("my-outward-score-qty");
  const valueEl = document.getElementById("my-outward-score-value");
  if (!from || !to) { qtyEl.textContent = "0"; valueEl.textContent = fmtMoney(0); return; }

  const rangeStart = new Date(`${from}T00:00:00`);
  const rangeEnd = new Date(`${to}T23:59:59.999`);
  const { data, error } = await supabase
    .from("book_outward_stock")
    .select("quantity,sold_price")
    .eq("sold_by", userName)
    .gte("created_at", rangeStart.toISOString())
    .lte("created_at", rangeEnd.toISOString());

  if (error || !data) { qtyEl.textContent = "0"; valueEl.textContent = fmtMoney(0); return; }
  qtyEl.textContent = data.reduce((s, r) => s + (r.quantity || 0), 0);
  valueEl.textContent = fmtMoney(data.reduce((s, r) => s + (r.sold_price || 0) * (r.quantity || 0), 0));
}

let outwardScoreWired = false;

function wireMyOutwardScore(currentUser) {
  if (outwardScoreWired) return;
  outwardScoreWired = true;
  const fromInput = document.getElementById("my-outward-score-date-from");
  const toInput = document.getElementById("my-outward-score-date-to");
  const today = new Date().toISOString().slice(0, 10);
  fromInput.value = today;
  toInput.value = today;
  fromInput.addEventListener("change", () => renderMyOutwardScore(currentUser.user_name));
  toInput.addEventListener("change", () => renderMyOutwardScore(currentUser.user_name));
}

export async function initStockEntry(currentUser) {
  // Add Inward Stock button + Your Inward Stock Entries panel are commented
  // out in index.html — renderMyInward/wireInwardUserModal are unused for now.
  await renderMyOutward(currentUser.user_name);
  await renderLatestEntryLocation(currentUser.user_name);
  wireMyOutwardScore(currentUser);
  await renderMyOutwardScore(currentUser.user_name);
  if (stockWired) return;
  stockWired = true;

  wireOutwardModal(currentUser);
}

/* ======================= COMMANDER ======================= */
// Read-only, all-users view of every outward stock entry, for users flagged
// users.commander = true (see Users & Assignment) to review book/payment
// realisation across the whole team. Everything but the Realised checkbox
// is display-only here — editing an entry itself stays on the admin
// Outward Stock page (BookDistribution.initOutwardTable).

const COMMANDER_SELECT_FILTERS = [["cmd-filter-by", "sold_by"], ["cmd-filter-language", "language"], ["cmd-filter-area", "sold_area"], ["cmd-filter-event", "event"]];
const COMMANDER_NUMBER_FILTERS = [["cmd-filter-price", "sold_price"], ["cmd-filter-qty", "quantity"]];
let commanderCache = [];
let commanderFiltersWired = false;

function matchesDateRange(row, fromVal, toVal) {
  if (!fromVal && !toVal) return true;
  const created = new Date(row.created_at);
  if (fromVal && created < new Date(`${fromVal}T00:00:00`)) return false;
  if (toVal && created > new Date(`${toVal}T23:59:59.999`)) return false;
  return true;
}

function updateCommanderSummary(rows) {
  const total = rows.length;
  const unrealisedRows = rows.filter((r) => !r.realised);
  const unrealisedTotal = unrealisedRows.reduce((sum, r) => sum + (r.sold_price || 0) * (r.quantity || 0), 0);
  document.getElementById("cmd-summary").textContent = total
    ? `${total} entr${total === 1 ? "y" : "ies"} shown, ${unrealisedRows.length} not realised`
    : "";
  document.getElementById("cmd-total-unrealised").textContent = total
    ? `Total Not Realised (shown above): ${fmtMoney(unrealisedTotal)}`
    : "";
}

function renderCommanderRows(rows, emptyMessage) {
  const tbody = document.getElementById("commander-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, idx) => `
    <tr data-id="${r.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Time">${new Date(r.created_at).toLocaleString()}</td>
      <td data-label="Name">${escapeHtml(r.name)}</td>
      <td data-label="Language">${escapeHtml(r.language || "—")}</td>
      <td data-label="Sold Price">${r.sold_price ?? "—"}</td>
      <td data-label="Quantity">${r.quantity ?? "—"}</td>
      <td data-label="Total">${fmtMoney((r.sold_price || 0) * (r.quantity || 0))}</td>
      <td data-label="Sold Area">${escapeHtml(r.sold_area || "—")}</td>
      <td data-label="Event">${escapeHtml(r.event || "—")}</td>
      <td data-label="Sold By">${escapeHtml(r.sold_by || "—")}</td>
      <td data-label="Realised"><input type="checkbox" class="realised-checkbox commander-realised-input" ${r.realised ? "checked" : ""} /></td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".commander-realised-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      await toggleOutwardRealised(e.target, commanderCache);
      if (document.getElementById("cmd-filter-unrealised").checked) applyCommanderFilters();
      else updateCommanderSummary(commanderCache.filter((r) => matchesCommanderFilters(r)));
    });
  });
}

function matchesCommanderFilters(r) {
  const search = document.getElementById("cmd-search")?.value.trim().toLowerCase() || "";
  const from = document.getElementById("cmd-filter-from")?.value || "";
  const to = document.getElementById("cmd-filter-to")?.value || "";
  const unrealisedOnly = document.getElementById("cmd-filter-unrealised")?.checked;
  return matchesSearch(r, search, ["name", "sold_area", "event", "sold_by"]) &&
    matchesSelectFilters(r, COMMANDER_SELECT_FILTERS) &&
    matchesNumberFilters(r, COMMANDER_NUMBER_FILTERS) &&
    matchesDateRange(r, from, to) &&
    (!unrealisedOnly || !r.realised);
}

function applyCommanderFilters() {
  let rows = commanderCache.filter(matchesCommanderFilters);
  rows = sortRows(rows, document.getElementById("cmd-sort")?.value, "created_at-desc");
  updateCommanderSummary(rows);
  renderCommanderRows(rows, commanderCache.length ? "No records match your filters." : "No outward stock entries yet.");
}

function wireCommanderFilters() {
  if (commanderFiltersWired) return;
  commanderFiltersWired = true;
  document.getElementById("cmd-search").addEventListener("input", debounce(applyCommanderFilters, 200));
  document.getElementById("cmd-sort").addEventListener("change", applyCommanderFilters);
  pairFilterControls("cmd-filter-by", "cmd-th-filter-by", applyCommanderFilters);
  pairFilterControls("cmd-filter-language", "cmd-th-filter-language", applyCommanderFilters);
  pairFilterControls("cmd-filter-area", "cmd-th-filter-area", applyCommanderFilters);
  pairFilterControls("cmd-filter-event", "cmd-th-filter-event", applyCommanderFilters);
  pairFilterControls("cmd-filter-price", "cmd-th-filter-price", applyCommanderFilters);
  pairFilterControls("cmd-filter-qty", "cmd-th-filter-qty", applyCommanderFilters);
  document.getElementById("cmd-filter-from").addEventListener("change", applyCommanderFilters);
  document.getElementById("cmd-filter-to").addEventListener("change", applyCommanderFilters);
  document.getElementById("cmd-filter-unrealised").addEventListener("change", applyCommanderFilters);
  initHorizontalScroll("commander-table-wrap");

  // Mobile: tapping a row (not its Realised checkbox) expands it in place to
  // reveal the rest of the entry's details. Delegated on the tbody so it
  // keeps working across re-renders.
  document.getElementById("commander-body").addEventListener("click", (e) => {
    if (window.innerWidth > 640) return;
    if (e.target.closest("input, button, select, a")) return;
    const row = e.target.closest("tr[data-id]");
    if (row) row.classList.toggle("expanded");
  });
}

export async function initCommander() {
  wireCommanderFilters();
  const tbody = document.getElementById("commander-body");
  tbody.innerHTML = `<tr><td colspan="11" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("book_outward_stock")
    .select("id,name,language,sold_price,quantity,sold_area,event,sold_by,created_at,realised")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Commander book_outward_stock load failed:", error);
    tbody.innerHTML = `<tr><td colspan="11" class="loading-row">Could not load outward stock: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  commanderCache = data || [];
  populatePairedSelect("cmd-filter-by", "cmd-th-filter-by", distinctValues(commanderCache, "sold_by"));
  populatePairedSelect("cmd-filter-language", "cmd-th-filter-language", distinctValues(commanderCache, "language"));
  populatePairedSelect("cmd-filter-area", "cmd-th-filter-area", distinctValues(commanderCache, "sold_area"));
  populatePairedSelect("cmd-filter-event", "cmd-th-filter-event", distinctValues(commanderCache, "event"));
  applyCommanderFilters();
}

/* ======================= DASHBOARD ======================= */

const DASHBOARD_COLUMNS_KEY = "nrg-book-dashboard-column-order";
const DEFAULT_DASHBOARD_COLUMNS = [
  "S.No", "Name", "Selling Price", "Language", "Total Inward", "Avg Purchase Price", "Current Stock",
  "Min Stock", "Current Stock Value", "Total Sold", "Avg Selling Price", "Total Sales Value", "Profit",
];
const DASHBOARD_SELECT_FILTERS = [["bd-filter-language", "language"]];
const DASHBOARD_NUMBER_FILTERS = [
  ["bd-th-filter-current-stock", "currentStock"],
  ["bd-th-filter-selling-price", "standardSellingPrice"],
  ["bd-th-filter-min-stock", "minStock"],
];
let dashboardStatsCache = [];
let dashboardLowStockOnly = false;
let dashboardFiltersWired = false;

let dashboardExportWired = false;

function wireDashboardExport() {
  if (dashboardExportWired) return;
  dashboardExportWired = true;
  document.getElementById("bd-export-btn").addEventListener("click", () => {
    const table = document.getElementById("book-dashboard-table");
    exportTableToExcel(table, `Book_Dashboard_${new Date().toISOString().slice(0, 10)}.xlsx`);
  });
}

export async function initDashboard(currentUser) {
  wireDashboardDetailModal();
  wireDashboardFilters();
  wireDashboardExport();
  wireInwardAdminModal(currentUser);
  wireBookBulkImportModal(currentUser);
  await renderDashboard();
}

function parseBookImportRows(objRows) {
  let skipped = 0;
  const rows = [];
  objRows.forEach((obj) => {
    const norm = {};
    Object.keys(obj).forEach((k) => { norm[k.trim().toLowerCase()] = obj[k]; });
    const name = String(norm.name ?? norm["book name"] ?? norm.title ?? "").trim();
    if (!name) { skipped++; return; }
    const language = String(norm.language ?? "").trim();
    const price = norm["purchase price"] ?? norm.price ?? norm.purchase_price ?? "";
    const quantity = norm.quantity ?? norm.qty ?? "";
    const purchasedFrom = String(norm["purchased from"] ?? norm.from ?? norm.source ?? "").trim();
    rows.push({
      name,
      language: language || null,
      purchase_price: price === "" ? null : Number(price),
      quantity: quantity === "" ? null : Number(quantity),
      purchased_from: purchasedFrom || null,
    });
  });
  return { rows, skipped };
}

function wireBookBulkImportModal(currentUser) {
  if (bulkImportWired) return;
  bulkImportWired = true;

  const modal = document.getElementById("book-bulk-import-modal");
  const fileInput = document.getElementById("book-bulk-import-file");
  const previewEl = document.getElementById("book-bulk-import-preview");
  const errorEl = document.getElementById("book-bulk-import-error");
  const importBtn = document.getElementById("book-bulk-import-save-btn");
  let parsedRows = [];

  document.getElementById("add-book-bulk-btn").onclick = () => {
    fileInput.value = "";
    previewEl.textContent = "";
    errorEl.classList.add("hidden");
    parsedRows = [];
    importBtn.disabled = true;
    modal.classList.add("active");
  };
  document.getElementById("book-bulk-import-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("book-bulk-import-template-btn").onclick = () => {
    downloadExcel("Book_Inward_Import_Template.xlsx", [
      ["Name", "Language", "Purchase Price", "Quantity", "Purchased From"],
      ["Bhagavad-gita As It Is", "English", 120, 50, "BBT Mumbai"],
    ]);
  };

  fileInput.onchange = async () => {
    errorEl.classList.add("hidden");
    previewEl.textContent = "";
    parsedRows = [];
    importBtn.disabled = true;
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const objRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      const { rows, skipped } = parseBookImportRows(objRows);
      parsedRows = rows;
      if (!rows.length) {
        errorEl.textContent = "No valid rows found — make sure the sheet has a Name column.";
        errorEl.classList.remove("hidden");
        return;
      }
      previewEl.textContent = `${rows.length} row(s) ready to import` + (skipped ? `, ${skipped} skipped (missing name)` : "") + ".";
      importBtn.disabled = false;
    } catch (err) {
      errorEl.textContent = "Could not read that file. Please upload a valid .xlsx/.csv file.";
      errorEl.classList.remove("hidden");
    }
  };

  importBtn.onclick = async () => {
    if (!parsedRows.length) return;
    importBtn.disabled = true;
    const { error } = await supabase.from("book_inward_stock").insert(parsedRows);
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      importBtn.disabled = false;
      return;
    }
    modal.classList.remove("active");
    showToast(`${parsedRows.length} book row(s) imported`, "success");
    await initInwardTable(currentUser);
    await renderDashboard();
  };
}

function wireDashboardFilters() {
  if (dashboardFiltersWired) return;
  dashboardFiltersWired = true;
  document.getElementById("bd-search").addEventListener("input", debounce(applyDashboardFilters, 200));
  document.getElementById("bd-sort").addEventListener("change", applyDashboardFilters);
  pairFilterControls("bd-filter-language", "bd-th-filter-language", applyDashboardFilters);
  document.getElementById("bd-th-filter-current-stock")?.addEventListener("input", debounce(applyDashboardFilters, 200));
  document.getElementById("bd-th-filter-selling-price")?.addEventListener("input", debounce(applyDashboardFilters, 200));
  document.getElementById("bd-th-filter-min-stock")?.addEventListener("input", debounce(applyDashboardFilters, 200));
  document.getElementById("bd-filter-low-stock-btn").addEventListener("click", (e) => {
    dashboardLowStockOnly = !dashboardLowStockOnly;
    e.currentTarget.classList.toggle("btn-danger", dashboardLowStockOnly);
    e.currentTarget.classList.toggle("btn-secondary", !dashboardLowStockOnly);
    applyDashboardFilters();
  });
  initColumnDragReorder("book-dashboard-table", { storageKey: DASHBOARD_COLUMNS_KEY, columns: DEFAULT_DASHBOARD_COLUMNS, resetBtnId: "bd-reset-columns-btn" });
  initHorizontalScroll("book-dashboard-table-wrap");

  // Mobile: tapping a row (not one of its inputs/buttons) expands it in
  // place to reveal the rest of the book's stats — see Commander's identical
  // pattern above.
  document.getElementById("book-dashboard-body").addEventListener("click", (e) => {
    if (window.innerWidth > 640) return;
    if (e.target.closest("input, button, select, a")) return;
    const row = e.target.closest("tr[data-key]");
    if (row) row.classList.toggle("expanded");
  });
}

function computeBookStats(book) {
  const totalInwardQty = book.inward.reduce((s, r) => s + (r.quantity || 0), 0);
  const totalPurchaseValue = book.inward.reduce((s, r) => s + (r.purchase_price || 0) * (r.quantity || 0), 0);
  const avgPurchasePrice = totalInwardQty ? totalPurchaseValue / totalInwardQty : 0;

  const totalSoldQty = book.outward.reduce((s, r) => s + (r.quantity || 0), 0);
  const totalSalesValue = book.outward.reduce((s, r) => s + (r.sold_price || 0) * (r.quantity || 0), 0);
  const avgSellingPrice = totalSoldQty ? totalSalesValue / totalSoldQty : 0;

  const currentStock = totalInwardQty - totalSoldQty;
  const currentStockValue = avgPurchasePrice * currentStock;
  // realized profit only counts the cost of units actually sold, priced at
  // this book's own average purchase price (a single blended cost basis,
  // since inward entries aren't tracked against specific outward entries)
  const profit = totalSalesValue - avgPurchasePrice * totalSoldQty;

  return {
    key: book.key, name: book.name, language: book.language,
    standardSellingPrice: book.standardSellingPrice ?? null,
    minStock: book.minStock ?? null,
    totalInwardQty, avgPurchasePrice, totalPurchaseValue,
    totalSoldQty, avgSellingPrice, totalSalesValue,
    currentStock, currentStockValue, profit,
  };
}

async function renderDashboard() {
  const tbody = document.getElementById("book-dashboard-body");
  tbody.innerHTML = `<tr><td colspan="13" class="loading-row">Loading…</td></tr>`;

  const [{ data: inward, error: inErr }, { data: outward, error: outErr }, { data: standardPrices, error: spErr }] = await Promise.all([
    supabase.from("book_inward_stock").select("name,language,purchase_price,quantity,purchased_from,created_at"),
    supabase.from("book_outward_stock").select("name,language,sold_price,quantity,sold_area,sold_by,created_at"),
    supabase.from("book_standard_prices").select("book_key,standard_selling_price,min_stock"),
  ]);

  if (inErr || outErr || spErr) {
    tbody.innerHTML = `<tr><td colspan="13" class="loading-row">Could not load dashboard data.</td></tr>`;
    return;
  }

  const standardPriceByKey = new Map((standardPrices || []).map((r) => [r.book_key, r.standard_selling_price]));
  const minStockByKey = new Map((standardPrices || []).map((r) => [r.book_key, r.min_stock]));

  dashboardBooks = new Map();
  (inward || []).forEach((r) => {
    const key = bookKey(r.name, r.language);
    if (!dashboardBooks.has(key)) dashboardBooks.set(key, { key, name: r.name, language: r.language, inward: [], outward: [] });
    dashboardBooks.get(key).inward.push(r);
  });
  (outward || []).forEach((r) => {
    const key = bookKey(r.name, r.language);
    if (!dashboardBooks.has(key)) dashboardBooks.set(key, { key, name: r.name, language: r.language, inward: [], outward: [] });
    dashboardBooks.get(key).outward.push(r);
  });
  dashboardBooks.forEach((book, key) => {
    book.standardSellingPrice = standardPriceByKey.get(key) ?? null;
    book.minStock = minStockByKey.get(key) ?? null;
  });

  dashboardStatsCache = Array.from(dashboardBooks.values()).map(computeBookStats);
  populatePairedSelect("bd-filter-language", "bd-th-filter-language", distinctValues(dashboardStatsCache, "language"));
  applyDashboardFilters();
}

function isLowStock(s) {
  return s.minStock != null && s.currentStock < s.minStock;
}

function renderDashboardRows(rows, emptyMessage) {
  const tbody = document.getElementById("book-dashboard-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="13" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((s, idx) => `
    <tr data-key="${escapeHtml(s.key)}" class="${isLowStock(s) ? "row-low-stock" : ""}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Name"><input class="inline-edit bd-name-edit" data-field="name" value="${escapeHtml(s.name)}" /></td>
      <td data-label="Selling Price"><input class="inline-edit bd-standard-price" type="number" min="0" step="0.01" value="${s.standardSellingPrice ?? ""}" /></td>
      <td data-label="Language"><input class="inline-edit bd-language-edit" data-field="language" value="${escapeHtml(s.language || "")}" /></td>
      <td data-label="Total Inward">${s.totalInwardQty ? `<button type="button" class="cell-chip bd-detail-btn" data-kind="inward">${s.totalInwardQty}</button>` : "0"}</td>
      <td data-label="Avg Purchase Price">${s.totalInwardQty ? `<button type="button" class="cell-chip bd-detail-btn" data-kind="purchase-prices">${fmtMoney(s.avgPurchasePrice)}</button>` : "—"}</td>
      <td data-label="Current Stock"><span class="cell-chip">${s.currentStock}</span></td>
      <td data-label="Min Stock"><input class="inline-edit bd-min-stock" type="number" min="0" step="1" value="${s.minStock ?? ""}" /></td>
      <td data-label="Current Stock Value">${fmtMoney(s.currentStockValue)}</td>
      <td data-label="Total Sold">${s.totalSoldQty ? `<button type="button" class="cell-chip bd-detail-btn" data-kind="outward">${s.totalSoldQty}</button>` : "0"}</td>
      <td data-label="Avg Selling Price">${s.totalSoldQty ? `<button type="button" class="cell-chip bd-detail-btn" data-kind="selling-prices">${fmtMoney(s.avgSellingPrice)}</button>` : "—"}</td>
      <td data-label="Total Sales Value">${fmtMoney(s.totalSalesValue)}</td>
      <td data-label="Profit"><span class="bd-profit ${s.profit < 0 ? "bd-profit-negative" : "bd-profit-positive"}">${fmtMoney(s.profit)}</span></td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".bd-detail-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.closest("tr").dataset.key;
      openDashboardDetail(dashboardBooks.get(key), btn.dataset.kind);
    });
  });

  tbody.querySelectorAll(".bd-standard-price").forEach((el) => {
    el.addEventListener("change", async (e) => {
      const tr = e.target.closest("tr");
      const key = tr.dataset.key;
      const book = dashboardBooks.get(key);
      const raw = e.target.value.trim();
      const value = raw === "" ? null : Number(raw);

      const { error } = await supabase.from("book_standard_prices")
        .upsert({ book_key: key, name: book.name, language: book.language || null, standard_selling_price: value }, { onConflict: "book_key" });
      if (error) {
        showToast("Update failed: " + error.message, "error");
        e.target.value = book.standardSellingPrice ?? "";
        return;
      }
      book.standardSellingPrice = value;
      const cached = dashboardStatsCache.find((r) => r.key === key);
      if (cached) cached.standardSellingPrice = value;
    });
  });

  tbody.querySelectorAll(".bd-min-stock").forEach((el) => {
    el.addEventListener("change", async (e) => {
      const tr = e.target.closest("tr");
      const key = tr.dataset.key;
      const book = dashboardBooks.get(key);
      const raw = e.target.value.trim();
      const value = raw === "" ? null : Number(raw);

      const { error } = await supabase.from("book_standard_prices")
        .upsert({ book_key: key, name: book.name, language: book.language || null, min_stock: value }, { onConflict: "book_key" });
      if (error) {
        showToast("Update failed: " + error.message, "error");
        e.target.value = book.minStock ?? "";
        return;
      }
      book.minStock = value;
      const cached = dashboardStatsCache.find((r) => r.key === key);
      if (cached) {
        cached.minStock = value;
        tr.classList.toggle("row-low-stock", isLowStock(cached));
      }
    });
  });

  tbody.querySelectorAll(".bd-name-edit, .bd-language-edit").forEach((el) => {
    el.addEventListener("change", async (e) => {
      const tr = e.target.closest("tr");
      const key = tr.dataset.key;
      const book = dashboardBooks.get(key);
      const nameInput = tr.querySelector(".bd-name-edit");
      const langInput = tr.querySelector(".bd-language-edit");
      const newName = nameInput.value.trim();
      const newLanguage = langInput.value.trim();

      if (!newName) {
        showToast("Name is required", "error");
        nameInput.value = book.name;
        return;
      }
      if (newName === book.name && newLanguage === (book.language || "")) return;

      e.target.disabled = true;
      const ok = await renameBookEverywhere(book, newName, newLanguage);
      e.target.disabled = false;
      if (!ok) {
        nameInput.value = book.name;
        langInput.value = book.language || "";
        return;
      }
      showToast("Book updated", "success");
      await renderDashboard();
    });
  });

  reapplyColumnOrder("book-dashboard-table");
}

// Dashboard rows are grouped by name+language across book_inward_stock and
// book_outward_stock — there's no single row that "is" the book — so editing
// Name/Language here has to rename every matching entry in both tables (plus
// the book_standard_prices row, keyed on the same name+language pair) rather
// than updating one record like the other inline-edit fields do.
async function renameBookEverywhere(book, newName, newLanguage) {
  const oldName = book.name;
  const oldLanguage = book.language || null;
  const newLang = newLanguage || null;
  const oldKey = book.key;
  const newKey = bookKey(newName, newLang);

  const withOldMatch = (query) => {
    query = query.eq("name", oldName);
    return oldLanguage === null ? query.is("language", null) : query.eq("language", oldLanguage);
  };

  const [inRes, outRes] = await Promise.all([
    withOldMatch(supabase.from("book_inward_stock").update({ name: newName, language: newLang })),
    withOldMatch(supabase.from("book_outward_stock").update({ name: newName, language: newLang })),
  ]);
  if (inRes.error || outRes.error) {
    showToast("Rename failed: " + (inRes.error || outRes.error).message, "error");
    return false;
  }

  if (newKey !== oldKey) {
    const { error: spErr } = await supabase.from("book_standard_prices")
      .update({ book_key: newKey, name: newName, language: newLang })
      .eq("book_key", oldKey);
    if (spErr) {
      showToast("Renamed stock entries, but couldn't carry over the Selling Price/Min Stock row: " + spErr.message, "error");
    }
  }

  return true;
}

function applyDashboardFilters() {
  const search = document.getElementById("bd-search")?.value.trim().toLowerCase() || "";
  let rows = dashboardStatsCache.filter((s) =>
    matchesSearch(s, search, ["name"]) &&
    matchesSelectFilters(s, DASHBOARD_SELECT_FILTERS) &&
    matchesNumberFilters(s, DASHBOARD_NUMBER_FILTERS) &&
    (!dashboardLowStockOnly || isLowStock(s))
  );
  rows = sortRows(rows, document.getElementById("bd-sort")?.value, "name-asc");
  renderDashboardRows(rows, dashboardStatsCache.length ? "No books match your filters." : "No stock entries yet.");
}

function groupByPrice(entries, priceField, placeField) {
  const groups = new Map();
  entries.forEach((e) => {
    const price = e[priceField] ?? 0;
    if (!groups.has(price)) groups.set(price, { price, qty: 0, places: new Set() });
    const g = groups.get(price);
    g.qty += e.quantity || 0;
    if (e[placeField]) g.places.add(e[placeField]);
  });
  return Array.from(groups.values()).sort((a, b) => a.price - b.price);
}

function openDashboardDetail(book, kind) {
  const title = document.getElementById("book-dashboard-detail-title");
  const theadRow = document.querySelector("#book-dashboard-detail-table thead tr");
  const tbody = document.getElementById("book-dashboard-detail-body");
  const label = `${book.name}${book.language ? ` (${book.language})` : ""}`;

  if (kind === "inward") {
    title.textContent = `Inward Stock Entries — ${label}`;
    theadRow.innerHTML = "<th>S.No</th><th>Time</th><th>Purchase Price</th><th>Quantity</th><th>Purchased From</th>";
    const rows = [...book.inward].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    tbody.innerHTML = rows.length ? rows.map((r, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>${new Date(r.created_at).toLocaleString()}</td>
        <td>${r.purchase_price ?? "—"}</td>
        <td>${r.quantity ?? "—"}</td>
        <td>${escapeHtml(r.purchased_from || "—")}</td>
      </tr>
    `).join("") : `<tr><td colspan="5" class="muted-text">No entries.</td></tr>`;
  } else if (kind === "purchase-prices") {
    title.textContent = `Purchase Prices — ${label}`;
    theadRow.innerHTML = "<th>S.No</th><th>Price</th><th>Quantity Bought</th><th>Purchased From</th>";
    const rows = groupByPrice(book.inward, "purchase_price", "purchased_from");
    tbody.innerHTML = rows.length ? rows.map((g, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>${fmtMoney(g.price)}</td>
        <td>${g.qty}</td>
        <td>${escapeHtml(Array.from(g.places).join(", ") || "—")}</td>
      </tr>
    `).join("") : `<tr><td colspan="4" class="muted-text">No entries.</td></tr>`;
  } else if (kind === "outward") {
    title.textContent = `Outward Stock Entries — ${label}`;
    theadRow.innerHTML = "<th>S.No</th><th>Time</th><th>Sold Price</th><th>Quantity</th><th>Sold Area</th><th>Sold By</th>";
    const rows = [...book.outward].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    tbody.innerHTML = rows.length ? rows.map((r, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>${new Date(r.created_at).toLocaleString()}</td>
        <td>${r.sold_price ?? "—"}</td>
        <td>${r.quantity ?? "—"}</td>
        <td>${escapeHtml(r.sold_area || "—")}</td>
        <td>${escapeHtml(r.sold_by || "—")}</td>
      </tr>
    `).join("") : `<tr><td colspan="6" class="muted-text">No entries.</td></tr>`;
  } else if (kind === "selling-prices") {
    title.textContent = `Selling Prices — ${label}`;
    theadRow.innerHTML = "<th>S.No</th><th>Price</th><th>Quantity Sold</th><th>Sold Area</th>";
    const rows = groupByPrice(book.outward, "sold_price", "sold_area");
    tbody.innerHTML = rows.length ? rows.map((g, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>${fmtMoney(g.price)}</td>
        <td>${g.qty}</td>
        <td>${escapeHtml(Array.from(g.places).join(", ") || "—")}</td>
      </tr>
    `).join("") : `<tr><td colspan="4" class="muted-text">No entries.</td></tr>`;
  }

  document.getElementById("book-dashboard-detail-modal").classList.add("active");
}

function wireDashboardDetailModal() {
  if (dashboardWired) return;
  dashboardWired = true;
  const modal = document.getElementById("book-dashboard-detail-modal");
  document.getElementById("book-dashboard-detail-close").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
}

// Shares the Dashboard tab's drill-down modal (#book-dashboard-detail-modal)
// instead of duplicating markup — both features write into the same DOM
// nodes but are never open at the same time.
function openSegmentDetail(rows) {
  const title = document.getElementById("book-dashboard-detail-title");
  const theadRow = document.querySelector("#book-dashboard-detail-table thead tr");
  const tbody = document.getElementById("book-dashboard-detail-body");
  title.textContent = "Segment Entries";
  theadRow.innerHTML = "<th>S.No</th><th>Time</th><th>Name</th><th>Language</th><th>Sold Price</th><th>Quantity</th><th>Event</th>";
  const sorted = [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  tbody.innerHTML = sorted.map((r, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${new Date(r.created_at).toLocaleString()}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.language || "—")}</td>
      <td>${r.sold_price ?? "—"}</td>
      <td>${r.quantity ?? "—"}</td>
      <td>${escapeHtml(r.event || "—")}</td>
    </tr>
  `).join("");
  document.getElementById("book-dashboard-detail-modal").classList.add("active");
}

/* ======================= ANALYTICS ======================= */

function analyticsDateInput(d) {
  return d.toISOString().slice(0, 10);
}

// Same book-by-book bucketing as the Dashboard (see renderDashboard above),
// but over whatever inward/outward rows the caller already fetched for a
// given date range — lets every breakdown here reuse computeBookStats
// instead of re-deriving avg price / profit logic per view.
function buildBookBuckets(inward, outward) {
  const map = new Map();
  const bucket = (r) => {
    const key = bookKey(r.name, r.language);
    if (!map.has(key)) map.set(key, { key, name: r.name, language: r.language, inward: [], outward: [] });
    return map.get(key);
  };
  inward.forEach((r) => bucket(r).inward.push(r));
  outward.forEach((r) => bucket(r).outward.push(r));
  return Array.from(map.values());
}

// dayRows = one user's book_outward_stock rows, all within one local day.
// Returns { segments, areaTotals }:
//   segments   = timeline entries [{ area, startTime, endTime, rows }] for display
//   areaTotals = Map(lowercased-area -> { area, qty, value, rows }) — the actual
//                score per area for that day (revisits to the same area merge
//                their score even if a different area was visited in between)
function computeDaySegments(dayRows) {
  if (!dayRows.length) return { segments: [], areaTotals: new Map() };

  const sorted = [...dayRows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const normArea = (r) => (r.sold_area || "").trim().toLowerCase();
  const first = new Date(sorted[0].created_at);
  const dayStart = startOfLocalDay(first);
  const dayEnd = endOfLocalDay(first);

  // Group consecutive rows sharing the same area (case-insensitive).
  const groups = [];
  for (const row of sorted) {
    const last = groups[groups.length - 1];
    if (last && normArea(row) === normArea(last.rows[0])) last.rows.push(row);
    else groups.push({ area: row.sold_area || "—", rows: [row] });
  }

  const singleSegmentDay = groups.length === 1;
  const segments = groups.map((g, i) => ({
    area: g.area,
    event: g.rows[0].event || "—",
    startTime: singleSegmentDay ? dayStart : new Date(g.rows[0].created_at),
    endTime: singleSegmentDay ? dayEnd
      : (i < groups.length - 1 ? new Date(groups[i + 1].rows[0].created_at) : dayEnd),
    rows: g.rows,
  }));

  const areaTotals = new Map();
  for (const row of sorted) {
    const key = normArea(row);
    if (!areaTotals.has(key)) areaTotals.set(key, { area: row.sold_area || "—", qty: 0, value: 0, rows: [] });
    const t = areaTotals.get(key);
    t.qty += row.quantity || 0;
    t.value += (row.sold_price || 0) * (row.quantity || 0);
    t.rows.push(row);
  }

  return { segments, areaTotals };
}

function renderAnalyticsStats(bookStats, totalExpenses, stockStats) {
  const totalSoldQty = bookStats.reduce((s, r) => s + r.totalSoldQty, 0);
  const totalSalesValue = bookStats.reduce((s, r) => s + r.totalSalesValue, 0);
  const totalProfit = bookStats.reduce((s, r) => s + r.profit, 0);
  const netProfit = totalProfit - totalExpenses;

  document.getElementById("ba-stat-inward-qty").textContent = stockStats.totalStockQty;
  document.getElementById("ba-stat-sold-qty").textContent = totalSoldQty;
  document.getElementById("ba-stat-sales-value").textContent = fmtMoney(totalSalesValue);
  document.getElementById("ba-stat-purchase-value").textContent = fmtMoney(stockStats.totalStockValue);
  document.getElementById("ba-stat-profit").textContent = fmtMoney(totalProfit);
  const card = document.getElementById("ba-stat-profit-card");
  card.classList.toggle("stat-negative", totalProfit < 0);
  card.classList.toggle("stat-positive", totalProfit >= 0);

  document.getElementById("ba-stat-net-profit").textContent = fmtMoney(netProfit);
  const netCard = document.getElementById("ba-stat-net-profit-card");
  netCard.classList.toggle("stat-negative", netProfit < 0);
  netCard.classList.toggle("stat-positive", netProfit >= 0);
}

// Groups outward rows into per-user-per-day location segments — a revisit to
// the same area merges its qty/value even if a different area was visited
// in between (see computeDaySegments) — across the whole selected date range.
let segmentRowsByKey = new Map();

function renderAnalyticsSegments(outward, showUserCol) {
  const tbody = document.getElementById("ba-segments-body");
  document.getElementById("ba-seg-user-col-header").classList.toggle("hidden", !showUserCol);

  segmentRowsByKey = new Map();
  const displayRows = [];
  const byDay = new Map();
  outward.forEach((r) => {
    const key = toLocalDateInputValue(new Date(r.created_at));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r);
  });

  Array.from(byDay.keys()).sort().forEach((dayKey) => {
    const byUser = groupBy(byDay.get(dayKey), "sold_by");
    Array.from(byUser.keys()).sort().forEach((user) => {
      const { segments, areaTotals } = computeDaySegments(byUser.get(user));
      segments.forEach((seg, idx) => {
        const key = `${dayKey}||${user}||${idx}`;
        const totals = areaTotals.get(seg.area.trim().toLowerCase());
        segmentRowsByKey.set(key, totals.rows);
        displayRows.push({ key, dayKey, user, area: seg.area, event: seg.event, startTime: seg.startTime, endTime: seg.endTime, qty: totals.qty, value: totals.value });
      });
    });
  });

  if (!displayRows.length) { tbody.innerHTML = `<tr><td colspan="9" class="muted-text">No sales in this range.</td></tr>`; return; }
  tbody.innerHTML = displayRows.map((r, idx) => `
    <tr>
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="User" class="ba-seg-user-cell ${showUserCol ? "" : "hidden"}">${escapeHtml(r.user)}</td>
      <td data-label="Date">${r.dayKey}</td>
      <td data-label="Area">${escapeHtml(r.area)}</td>
      <td data-label="Event">${escapeHtml(r.event)}</td>
      <td data-label="Start Time">${r.startTime.toLocaleTimeString()}</td>
      <td data-label="End Time">${r.endTime.toLocaleTimeString()}</td>
      <td data-label="Qty"><button type="button" class="cell-chip ba-segment-detail-btn" data-key="${escapeHtml(r.key)}">${r.qty}</button></td>
      <td data-label="Value"><button type="button" class="cell-chip ba-segment-detail-btn" data-key="${escapeHtml(r.key)}">${fmtMoney(r.value)}</button></td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".ba-segment-detail-btn").forEach((btn) => {
    btn.addEventListener("click", () => openSegmentDetail(segmentRowsByKey.get(btn.dataset.key)));
  });
}

// Current Stock / Stock Value are a live snapshot, not a per-period total —
// unlike Sold/Sales Value/Profit below they ignore the date range (and the
// user/place filters, since stock isn't tied to who or where it was sold)
// so they always reflect what's actually left, same as the Dashboard's
// per-book "Current Stock" column. A book filter still narrows them, since
// picking one title should show that title's own stock.
async function fetchStockStats(bookSel) {
  let inwardQuery = supabase.from("book_inward_stock").select("name,language,purchase_price,quantity");
  let outwardQuery = supabase.from("book_outward_stock").select("name,language,quantity");
  if (bookSel && bookSel !== "__ALL__") {
    inwardQuery = inwardQuery.eq("name", bookSel);
    outwardQuery = outwardQuery.eq("name", bookSel);
  }
  const [{ data: inward }, { data: outward }] = await Promise.all([inwardQuery, outwardQuery]);
  const bookStats = buildBookBuckets(inward || [], outward || []).map(computeBookStats);
  return {
    totalStockQty: bookStats.reduce((s, r) => s + Math.max(0, r.currentStock), 0),
    totalStockValue: bookStats.reduce((s, r) => s + Math.max(0, r.currentStockValue), 0),
  };
}

async function runAnalytics() {
  const from = document.getElementById("ba-from").value;
  const to = document.getElementById("ba-to").value;
  const userSel = document.getElementById("ba-filter-user-select").value;
  const placeSel = document.getElementById("ba-filter-place-select").value;
  const eventSel = document.getElementById("ba-filter-event-select").value;
  const bookSel = document.getElementById("ba-filter-book-select").value;
  const fromISO = from ? new Date(`${from}T00:00:00`).toISOString() : null;
  const toISO = to ? new Date(`${to}T23:59:59.999`).toISOString() : null;

  let inwardQuery = supabase.from("book_inward_stock").select("name,language,purchase_price,quantity,purchased_from,created_at");
  let outwardQuery = supabase.from("book_outward_stock").select("name,language,sold_price,quantity,sold_area,event,sold_by,created_at");
  let expensesQuery = supabase.from("book_expenses").select("cost,expense_date,to_users");
  if (fromISO) { inwardQuery = inwardQuery.gte("created_at", fromISO); outwardQuery = outwardQuery.gte("created_at", fromISO); }
  if (toISO) { inwardQuery = inwardQuery.lte("created_at", toISO); outwardQuery = outwardQuery.lte("created_at", toISO); }
  if (from) expensesQuery = expensesQuery.gte("expense_date", from);
  if (to) expensesQuery = expensesQuery.lte("expense_date", to);
  if (userSel && userSel !== "__ALL__") outwardQuery = outwardQuery.eq("sold_by", userSel);
  if (placeSel && placeSel !== "__ALL__") outwardQuery = outwardQuery.eq("sold_area", placeSel);
  if (eventSel && eventSel !== "__ALL__") outwardQuery = outwardQuery.eq("event", eventSel);
  if (bookSel && bookSel !== "__ALL__") { inwardQuery = inwardQuery.eq("name", bookSel); outwardQuery = outwardQuery.eq("name", bookSel); }

  const [{ data: inward, error: inErr }, { data: outward, error: outErr }, { data: expenses, error: expErr }, stockStats] = await Promise.all([
    inwardQuery, outwardQuery, expensesQuery, fetchStockStats(bookSel),
  ]);
  if (inErr || outErr || expErr) {
    showToast("Could not load analytics data.", "error");
    return;
  }

  // With a specific user selected, only that user's share of each expense
  // (split across its to_users) counts against their net profit — an expense
  // billed to other users shouldn't reduce this user's number.
  const specificUser = userSel && userSel !== "__ALL__" ? userSel : null;
  const totalExpenses = (expenses || []).reduce((s, r) => {
    if (!specificUser) return s + (r.cost || 0);
    const toUsers = r.to_users || [];
    if (!toUsers.includes(specificUser)) return s;
    return s + (r.cost || 0) / (toUsers.length || 1);
  }, 0);
  const bookStats = buildBookBuckets(inward || [], outward || []).map(computeBookStats);
  renderAnalyticsStats(bookStats, totalExpenses, stockStats);
  renderAnalyticsSegments(outward || [], !userSel || userSel === "__ALL__");
}

let analyticsWired = false;

async function wireAnalyticsFilters() {
  if (analyticsWired) return;
  analyticsWired = true;

  const fromInput = document.getElementById("ba-from");
  const toInput = document.getElementById("ba-to");
  const d = new Date();
  d.setDate(d.getDate() - 30);
  fromInput.value = analyticsDateInput(d);
  toInput.value = analyticsDateInput(new Date());

  const [{ data: users }, placeNames, eventNames, bookNames] = await Promise.all([
    supabase.from("users").select("user_name").eq("role", "Coordinator").order("user_name"),
    fetchPlaceNames(),
    fetchEventNames(),
    fetchBookNames(),
  ]);
  const userNames = (users || []).map((u) => u.user_name);
  populateFilterSelect(document.getElementById("ba-filter-user-select"), userNames);
  populateFilterSelect(document.getElementById("ba-filter-place-select"), placeNames);
  populateFilterSelect(document.getElementById("ba-filter-event-select"), eventNames);
  populateFilterSelect(document.getElementById("ba-filter-book-select"), bookNames);

  document.getElementById("ba-run-btn").addEventListener("click", runAnalytics);
  wireExportBtn("ba-export-btn", "ba-segments-table", "Book_Analytics");

  // Mobile: tapping a row (not one of its detail buttons) expands it in
  // place to reveal Area/Start Time/End Time/Qty — same pattern as
  // Commander/Book Dashboard above. Rows have no stable id, but the toggle
  // only needs to flip a CSS class, not look anything up.
  document.getElementById("ba-segments-body").addEventListener("click", (e) => {
    if (window.innerWidth > 640) return;
    if (e.target.closest("button")) return;
    const row = e.target.closest("tbody tr");
    if (row) row.classList.toggle("expanded");
  });
}

export async function initAnalytics() {
  wireDashboardDetailModal();
  await wireAnalyticsFilters();
  await runAnalytics();
}

/* ======================= EXPENSES (admin only) =======================
   Simple ledger: date/name/cost/place/recipients/result — recipients is the
   only multi-value field, so it's edited via a small dedicated modal instead
   of squeezing a checkbox dropdown into a table cell (the table-wrap's
   overflow:auto would clip a popover positioned inside a <td>). Every other
   field is inline-edit, same as the rest of Book Distribution's tables. */

const EXPENSES_COLUMNS_KEY = "nrg-book-expenses-column-order";
const DEFAULT_EXPENSES_COLUMNS = ["S.No", "Date", "Name", "Cost", "Place", "Event", "To", ""];
const EXPENSES_SELECT_FILTERS = [["be-filter-place", "place"], ["be-filter-event", "event"]];
const EXPENSES_NUMBER_FILTERS = [["be-th-filter-cost", "cost"]];
let expensesCache = [];
let expensesFiltersWired = false;
let expenseModalWired = false;
let expenseToModalWired = false;
async function fetchAllUserNames() {
  const { data } = await supabase.from("users").select("user_name").order("user_name");
  return (data || []).map((u) => u.user_name);
}

function renderToCheckGroup(container, userNames, selected) {
  const selectedSet = new Set(selected || []);
  container.innerHTML = userNames.map((name) => `
    <label class="tag-check">
      <input type="checkbox" value="${escapeHtml(name)}" ${selectedSet.has(name) ? "checked" : ""} /> ${escapeHtml(name)}
    </label>
  `).join("") || `<span class="muted-text">No users found.</span>`;
}

function readCheckedValues(container) {
  return Array.from(container.querySelectorAll("input[type=checkbox]:checked")).map((el) => el.value);
}

function matchesToFilter(row, selectId) {
  const val = document.getElementById(selectId)?.value ?? "__ALL__";
  if (val === "__ALL__") return true;
  return (row.to_users || []).includes(val);
}

function renderExpensesRows(rows, emptyMessage) {
  const tbody = document.getElementById("book-expenses-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, idx) => `
    <tr data-id="${r.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Date"><input class="inline-edit" type="date" data-field="expense_date" value="${r.expense_date || ""}" /></td>
      <td data-label="Name"><input class="inline-edit" data-field="name" value="${escapeHtml(r.name)}" /></td>
      <td data-label="Cost"><input class="inline-edit" type="number" min="0" step="0.01" data-field="cost" value="${r.cost ?? ""}" /></td>
      <td data-label="Place">${editSelectHtml("place", distinctValues(expensesCache, "place"), r.place || "")}</td>
      <td data-label="Event">${editSelectHtml("event", distinctValues(expensesCache, "event"), r.event || "")}</td>
      <td data-label="To">
        <button type="button" class="cell-chip expense-edit-to-btn" title="${escapeHtml((r.to_users || []).join(", ")) || "Edit recipients"}">${(r.to_users || []).length ? escapeHtml(r.to_users.join(", ")) : "— Select —"}</button>
      </td>
      <td data-label="">
        <button type="button" class="cell-chip danger expense-delete-btn" title="Delete">🗑 Delete</button>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".expense-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteExpense(btn.closest("tr").dataset.id));
  });
  tbody.querySelectorAll(".expense-edit-to-btn").forEach((btn) => {
    btn.addEventListener("click", () => openExpenseToModal(btn.closest("tr").dataset.id));
  });
  wireInlineEditCells(tbody, "book_expenses", expensesCache, { numberFields: ["cost"], requiredFields: ["name", "expense_date"] }, async () => { applyExpensesFilters(); await updateExpensesSummaryStats(); });
  reapplyColumnOrder("book-expenses-table");
}

function applyExpensesFilters() {
  const search = document.getElementById("be-search")?.value.trim().toLowerCase() || "";
  let rows = expensesCache.filter((r) =>
    matchesSearch(r, search, ["name", "place", "event"]) &&
    matchesSelectFilters(r, EXPENSES_SELECT_FILTERS) &&
    matchesNumberFilters(r, EXPENSES_NUMBER_FILTERS) &&
    matchesToFilter(r, "be-filter-to")
  );
  rows = sortRows(rows, document.getElementById("be-sort")?.value, "expense_date-desc");
  renderExpensesRows(rows, expensesCache.length ? "No expenses match your filters." : "No expenses yet — add one to get started.");
}

function wireExpensesFilters() {
  if (expensesFiltersWired) return;
  expensesFiltersWired = true;
  document.getElementById("be-search").addEventListener("input", debounce(applyExpensesFilters, 200));
  document.getElementById("be-sort").addEventListener("change", applyExpensesFilters);
  pairFilterControls("be-filter-place", "be-th-filter-place", applyExpensesFilters);
  pairFilterControls("be-filter-event", "be-th-filter-event", applyExpensesFilters);
  pairFilterControls("be-filter-to", "be-th-filter-to", applyExpensesFilters);
  document.getElementById("be-th-filter-cost")?.addEventListener("input", debounce(applyExpensesFilters, 200));
  wireExportBtn("be-export-btn", "book-expenses-table", "Book_Expenses");
  initColumnDragReorder("book-expenses-table", { storageKey: EXPENSES_COLUMNS_KEY, columns: DEFAULT_EXPENSES_COLUMNS, resetBtnId: "be-reset-columns-btn" });
  initHorizontalScroll("book-expenses-table-wrap");
}

async function deleteExpense(id) {
  const r = expensesCache.find((x) => x.id === id);
  if (!confirm(`Delete expense "${r?.name || ""}"?`)) return;
  const { error } = await supabase.from("book_expenses").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  showToast("Expense deleted", "success");
  await loadExpenses();
}

async function openExpenseModal() {
  document.getElementById("book-expense-date").value = new Date().toISOString().slice(0, 10);
  document.getElementById("book-expense-name").value = "";
  document.getElementById("book-expense-cost").value = "";

  const [placeNames, eventNames] = await Promise.all([fetchPlaceNames(), fetchEventNames()]);
  const placesFromCache = distinctValues(expensesCache, "place");
  const allPlaces = Array.from(new Set([...placeNames, ...placesFromCache])).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const placeSelect = document.getElementById("book-expense-place");
  placeSelect.innerHTML = `<option value="">— Select Place —</option>` +
    allPlaces.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  placeSelect.value = "";

  const eventsFromCache = distinctValues(expensesCache, "event");
  const allEvents = Array.from(new Set([...eventNames, ...eventsFromCache])).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const eventSelect = document.getElementById("book-expense-event");
  eventSelect.innerHTML = `<option value="">— Select Event —</option>` +
    allEvents.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join("");
  eventSelect.value = "";

  document.getElementById("book-expense-result").value = "";
  document.getElementById("book-expense-error").classList.add("hidden");
  renderToCheckGroup(document.getElementById("book-expense-to-group"), await fetchAllUserNames(), []);
  document.getElementById("book-expense-modal").classList.add("active");
}

function wireExpenseModal(currentUser) {
  if (expenseModalWired) return;
  expenseModalWired = true;
  const modal = document.getElementById("book-expense-modal");
  const errorEl = document.getElementById("book-expense-error");

  document.getElementById("add-book-expense-btn").onclick = () => openExpenseModal();
  document.getElementById("book-expense-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("book-expense-save-btn").onclick = async () => {
    const date = document.getElementById("book-expense-date").value;
    const name = document.getElementById("book-expense-name").value.trim();
    const cost = document.getElementById("book-expense-cost").value;
    const place = document.getElementById("book-expense-place").value.trim();
    const event = document.getElementById("book-expense-event").value.trim();
    const result = document.getElementById("book-expense-result").value;
    const toUsers = readCheckedValues(document.getElementById("book-expense-to-group"));

    if (!date) {
      errorEl.textContent = "Please choose a date.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (!name) {
      errorEl.textContent = "Please enter a name for this expense.";
      errorEl.classList.remove("hidden");
      return;
    }

    const payload = {
      expense_date: date,
      name,
      cost: cost === "" ? null : Number(cost),
      place: place || null,
      event: event || null,
      to_users: toUsers.length ? toUsers : null,
      result_profit: result === "" ? null : Number(result),
      added_by: currentUser?.user_name || null,
    };
    const { error } = await supabase.from("book_expenses").insert(payload);

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast("Expense added", "success");
    await loadExpenses();
  };
}

let editingExpenseToId = null;

async function openExpenseToModal(id) {
  const r = expensesCache.find((x) => x.id === id);
  if (!r) return;
  editingExpenseToId = id;
  document.getElementById("book-expense-to-edit-error").classList.add("hidden");
  renderToCheckGroup(document.getElementById("book-expense-to-edit-group"), await fetchAllUserNames(), r.to_users);
  document.getElementById("book-expense-to-modal").classList.add("active");
}

function wireExpenseToModal() {
  if (expenseToModalWired) return;
  expenseToModalWired = true;
  const modal = document.getElementById("book-expense-to-modal");
  const errorEl = document.getElementById("book-expense-to-edit-error");

  document.getElementById("book-expense-to-edit-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("book-expense-to-edit-save-btn").onclick = async () => {
    const toUsers = readCheckedValues(document.getElementById("book-expense-to-edit-group"));
    const { error } = await supabase.from("book_expenses").update({ to_users: toUsers.length ? toUsers : null }).eq("id", editingExpenseToId);
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast("Recipients updated", "success");
    await loadExpenses();
  };
}

async function loadExpenses() {
  const tbody = document.getElementById("book-expenses-body");
  tbody.innerHTML = `<tr><td colspan="8" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("book_expenses")
    .select("id,expense_date,name,cost,place,event,to_users,result_profit")
    .order("expense_date", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="8" class="loading-row">Could not load expenses.</td></tr>`;
    return;
  }
  expensesCache = data || [];
  populatePairedSelect("be-filter-place", "be-th-filter-place", distinctValues(expensesCache, "place"));
  populatePairedSelect("be-filter-event", "be-th-filter-event", distinctValues(expensesCache, "event"));
  const userNames = await fetchAllUserNames();
  ["be-filter-to", "be-th-filter-to"].forEach((id) => {
    const toSelect = document.getElementById(id);
    const currentTo = toSelect.value;
    toSelect.innerHTML = `<option value="__ALL__">All</option>` + userNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
    toSelect.value = [...toSelect.options].some((o) => o.value === currentTo) ? currentTo : "__ALL__";
  });
  applyExpensesFilters();
  await updateExpensesSummaryStats();
}

// Gross Amount/Profit come from the same buildBookBuckets+computeBookStats
// pipeline as Dashboard/Analytics (org-wide, all-time) so this figure never
// drifts from what those tabs show for the same underlying sales.
async function updateExpensesSummaryStats() {
  const [{ data: inward }, { data: outward }] = await Promise.all([
    supabase.from("book_inward_stock").select("name,language,purchase_price,quantity"),
    supabase.from("book_outward_stock").select("name,language,sold_price,quantity"),
  ]);

  const bookStats = buildBookBuckets(inward || [], outward || []).map(computeBookStats);
  const grossAmount = bookStats.reduce((s, r) => s + r.totalSalesValue, 0);
  const grossProfit = bookStats.reduce((s, r) => s + r.profit, 0);
  const totalExpenses = expensesCache.reduce((s, r) => s + (r.cost || 0), 0);
  const netProfit = grossProfit - totalExpenses;

  document.getElementById("be-stat-gross-amount").textContent = fmtMoney(grossAmount);
  document.getElementById("be-stat-gross-profit").textContent = fmtMoney(grossProfit);
  document.getElementById("be-stat-expenses").textContent = fmtMoney(totalExpenses);

  const netEl = document.getElementById("be-stat-net-profit");
  netEl.textContent = fmtMoney(netProfit);
  const netCard = document.getElementById("be-stat-net-profit-card");
  netCard.classList.toggle("stat-negative", netProfit < 0);
  netCard.classList.toggle("stat-positive", netProfit >= 0);
}

export async function initExpenses(currentUser) {
  wireExpenseModal(currentUser);
  wireExpenseToModal();
  wireExpensesFilters();
  await loadExpenses();
}

/* ======================= SAVINGS (user & admin) ======================= */
let currentSavingsUser = null;

async function renderSavingsPanel() {
  const targetUser = currentSavingsUser?.user_name || "";
  if (!targetUser) return;

  // Admin isn't a book distributor, so "their" personal sales/contributions
  // are always empty. Admin gets a "Show contribution for" picker: "All
  // Users" aggregates org-wide (same figures as the Expenses tab), or a
  // specific coordinator's name shows that person's own numbers.
  const isAdmin = currentSavingsUser?.role === "Admin";
  const scopeSel = isAdmin ? (document.getElementById("bs-stats-user-select")?.value || "__ALL__") : targetUser;
  const isOrgWide = scopeSel === "__ALL__";
  const scopeUser = isOrgWide ? null : scopeSel;

  let outwardQuery = supabase.from("book_outward_stock").select("name, language, sold_price, quantity, sold_by");
  let contributionsQuery = supabase.from("book_contributions").select("amount");
  if (!isOrgWide) {
    outwardQuery = outwardQuery.eq("sold_by", scopeUser);
    contributionsQuery = contributionsQuery.eq("submitted_by", scopeUser);
  }

  const [
    { data: outwardData, error: outError },
    { data: inwardData },
    { data: contributionsData }
  ] = await Promise.all([
    outwardQuery,
    supabase.from("book_inward_stock").select("name, language, purchase_price, quantity"),
    contributionsQuery
  ]);

  if (outError) {
    console.error("Failed to load savings data:", outError);
    return;
  }

  const bookCostMap = new Map();
  (inwardData || []).forEach((row) => {
    const key = bookKey(row.name, row.language);
    if (!bookCostMap.has(key)) bookCostMap.set(key, { qty: 0, val: 0 });
    const b = bookCostMap.get(key);
    b.qty += (row.quantity || 0);
    b.val += (row.purchase_price || 0) * (row.quantity || 0);
  });

  const getUnitCost = (name, lang) => {
    const key = bookKey(name, lang);
    const b = bookCostMap.get(key);
    return (b && b.qty > 0) ? b.val / b.qty : 0;
  };

  let salesRevenue = 0;
  let bookCost = 0;
  (outwardData || []).forEach((r) => {
    const qty = r.quantity || 0;
    salesRevenue += (r.sold_price || 0) * qty;
    bookCost += getUnitCost(r.name, r.language) * qty;
  });

  // Tirtha Nidhi intentionally shows a different number than Dashboard/
  // Analytics/Expenses: a fixed 70% of realised (gross) profit, ignoring
  // expenses entirely, floored at 0. Expenses are billed later and would
  // otherwise claw back a figure the user already saw, which reads as
  // demotivating even though nothing was actually wrong. This display is
  // for user motivation only — admins still see the real expense-netted
  // profit everywhere else.
  const grossProfit = salesRevenue - bookCost;
  const netProfit = grossProfit > 0 ? Math.round(grossProfit * 0.7) : 0;
  const totalMyContribution = (contributionsData || []).reduce((sum, r) => sum + (r.amount || 0), 0);

  const netEl = document.getElementById("bs-total-net");
  if (netEl) {
    netEl.textContent = fmtMoney(netProfit);
    netEl.style.color = netProfit < 0 ? "#dc2626" : netProfit > 0 ? "#16a34a" : "var(--text-main, #111)";
  }

  const myContributionEl = document.getElementById("bs-total-mycontribution");
  if (myContributionEl) myContributionEl.textContent = fmtMoney(totalMyContribution);
  const myContributionLabel = document.querySelector("#bs-my-contribution-card .stat-label");
  if (myContributionLabel) {
    myContributionLabel.textContent = isOrgWide ? "All Contributions" : (scopeUser === targetUser ? "My Contribution" : `${scopeUser}'s Contribution`);
  }
  const myContributionCard = document.getElementById("bs-my-contribution-card");
  if (myContributionCard) myContributionCard.title = isOrgWide ? "Tap to view all submissions" : "Tap to view submissions";

  const grandTotalEl = document.getElementById("bs-total-grand");
  if (grandTotalEl) grandTotalEl.textContent = fmtMoney(totalMyContribution + netProfit);
}

/* ---- Tirtha Nidhi: book-wise breakdown behind the "Srila Prabhupada's
   Contribution" stat card ----
   Same scope as the stats bar (a specific distributor, or all combined for
   admin). Unlike that stat's headline number, this lists every book sale
   so the real profit/loss and Prabhupada's 70% share is visible per book,
   plus a real "Net Profit" figure that (unlike the headline stat) actually
   deducts each distributor's share of expenses billed to them. */
let bsUserContributionModalWired = false;
function wireBsUserContributionModal() {
  if (bsUserContributionModalWired) return;
  bsUserContributionModalWired = true;
  const modal = document.getElementById("bs-user-contribution-modal");
  document.getElementById("bs-user-contribution-close").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
}

async function openBsUserContributionModal(isAdmin, currentUser) {
  const scopeSel = isAdmin ? (document.getElementById("bs-stats-user-select")?.value || "__ALL__") : currentUser.user_name;
  const isOrgWide = scopeSel === "__ALL__";
  const scopeUser = isOrgWide ? null : scopeSel;

  const modal = document.getElementById("bs-user-contribution-modal");
  modal.classList.add("active");
  document.getElementById("bs-ucm-title").textContent = isOrgWide ? "All Distributors — Book-wise Details" : `${scopeUser} — Book-wise Details`;
  const tbody = document.getElementById("bs-user-contribution-body");
  tbody.innerHTML = `<tr><td colspan="5" class="loading-row">Loading…</td></tr>`;

  let outwardQuery = supabase.from("book_outward_stock").select("name, language, sold_price, quantity, sold_area, created_at");
  if (!isOrgWide) outwardQuery = outwardQuery.eq("sold_by", scopeUser);

  const [{ data: outwardData, error }, { data: inwardData }, { data: expensesData }] = await Promise.all([
    outwardQuery.order("created_at", { ascending: true }),
    supabase.from("book_inward_stock").select("name, language, purchase_price, quantity"),
    supabase.from("book_expenses").select("cost, to_users"),
  ]);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading-row">Could not load data.</td></tr>`;
    return;
  }

  const bookCostMap = new Map();
  (inwardData || []).forEach((row) => {
    const key = bookKey(row.name, row.language);
    if (!bookCostMap.has(key)) bookCostMap.set(key, { qty: 0, val: 0 });
    const b = bookCostMap.get(key);
    b.qty += (row.quantity || 0);
    b.val += (row.purchase_price || 0) * (row.quantity || 0);
  });
  const getUnitCost = (name, lang) => {
    const b = bookCostMap.get(bookKey(name, lang));
    return (b && b.qty > 0) ? b.val / b.qty : 0;
  };

  const rows = (outwardData || []).map((r) => {
    const qty = r.quantity || 0;
    const revenue = (r.sold_price || 0) * qty;
    const cost = getUnitCost(r.name, r.language) * qty;
    const actualProfit = revenue - cost;
    return { name: r.name, language: r.language, soldAt: r.sold_area, actualProfit, shown: Math.round(actualProfit * 0.7) };
  });

  const grossProfit = rows.reduce((s, r) => s + r.actualProfit, 0);
  const totalShown = grossProfit > 0 ? Math.round(grossProfit * 0.7) : 0;

  // Same per-user expense split as Analytics: an expense only counts against
  // a specific distributor if they're one of its to_users, split evenly.
  const totalExpenses = (expensesData || []).reduce((s, r) => {
    if (isOrgWide) return s + (r.cost || 0);
    const toUsers = r.to_users || [];
    if (!toUsers.includes(scopeUser)) return s;
    return s + (r.cost || 0) / (toUsers.length || 1);
  }, 0);
  const netProfit = grossProfit - totalExpenses;

  document.getElementById("bs-ucm-net-profit").textContent = fmtMoney(netProfit);
  document.getElementById("bs-ucm-contribution").textContent = fmtMoney(totalShown);

  tbody.innerHTML = rows.length
    ? rows.map((r, idx) => `
        <tr>
          <td data-label="S.No">${idx + 1}</td>
          <td data-label="Book Name">${escapeHtml(r.name)}${r.language ? ` (${escapeHtml(r.language)})` : ""}</td>
          <td data-label="Sold At">${escapeHtml(r.soldAt || "—")}</td>
          <td data-label="Net Profit">${fmtMoney(r.actualProfit)}</td>
          <td data-label="Prabhupada's Contribution">${fmtMoney(r.shown)}</td>
        </tr>`).join("") +
      `<tr class="total-row">
        <td colspan="3">Total</td>
        <td data-label="Net Profit">${fmtMoney(grossProfit)}</td>
        <td data-label="Prabhupada's Contribution">${fmtMoney(rows.reduce((s, r) => s + r.shown, 0))}</td>
      </tr>`
    : `<tr><td colspan="5" class="loading-row">No book sales found.</td></tr>`;
}

/* ---- Tirtha Nidhi: General Data (admin) ----
   A projector-friendly summary — just Name and Srila Prabhupada's share of
   each distributor's book sales (same 70%-of-gross-profit figure as the
   stats bar), deliberately leaving out anyone's personal contribution
   submissions. */
let bsGeneralDataModalWired = false;
function wireBsGeneralDataModal() {
  if (bsGeneralDataModalWired) return;
  bsGeneralDataModalWired = true;
  const modal = document.getElementById("bs-general-data-modal");
  document.getElementById("bs-general-data-close").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  let bsGeneralDataZoom = 100;
  const zoomBox = document.getElementById("bs-general-data-modal-box");
  const zoomLevel = document.getElementById("bs-general-data-zoom-level");
  const applyBsGeneralDataZoom = () => {
    zoomBox.style.transform = `scale(${bsGeneralDataZoom / 100})`;
    zoomLevel.textContent = bsGeneralDataZoom + "%";
  };
  document.getElementById("bs-general-data-zoom-in").onclick = () => {
    bsGeneralDataZoom = Math.min(200, bsGeneralDataZoom + 10);
    applyBsGeneralDataZoom();
  };
  document.getElementById("bs-general-data-zoom-out").onclick = () => {
    bsGeneralDataZoom = Math.max(40, bsGeneralDataZoom - 10);
    applyBsGeneralDataZoom();
  };

  initColumnDragReorder("bs-general-data-table");

  document.getElementById("bs-general-data-btn").onclick = async () => {
    modal.classList.add("active");
    const tbody = document.getElementById("bs-general-data-body");
    tbody.innerHTML = `<tr><td colspan="3" class="loading-row">Loading…</td></tr>`;

    const [{ data: coordinators }, { data: inwardData }, { data: outwardData }] = await Promise.all([
      supabase.from("users").select("user_name").eq("role", "Coordinator").order("user_name"),
      supabase.from("book_inward_stock").select("name, language, purchase_price, quantity"),
      supabase.from("book_outward_stock").select("name, language, sold_price, quantity, sold_by"),
    ]);

    const bookCostMap = new Map();
    (inwardData || []).forEach((row) => {
      const key = bookKey(row.name, row.language);
      if (!bookCostMap.has(key)) bookCostMap.set(key, { qty: 0, val: 0 });
      const b = bookCostMap.get(key);
      b.qty += (row.quantity || 0);
      b.val += (row.purchase_price || 0) * (row.quantity || 0);
    });
    const getUnitCost = (name, lang) => {
      const b = bookCostMap.get(bookKey(name, lang));
      return (b && b.qty > 0) ? b.val / b.qty : 0;
    };

    const profitBySeller = new Map();
    (outwardData || []).forEach((r) => {
      const qty = r.quantity || 0;
      const revenue = (r.sold_price || 0) * qty;
      const cost = getUnitCost(r.name, r.language) * qty;
      const prev = profitBySeller.get(r.sold_by) || 0;
      profitBySeller.set(r.sold_by, prev + (revenue - cost));
    });

    const rows = (coordinators || [])
      .map((u) => {
        const grossProfit = profitBySeller.get(u.user_name) || 0;
        const netProfit = grossProfit > 0 ? Math.round(grossProfit * 0.7) : 0;
        return { name: u.user_name, netProfit };
      })
      .filter((r) => r.netProfit > 0)
      .sort((a, b) => b.netProfit - a.netProfit);

    tbody.innerHTML = rows.length
      ? rows.map((r, idx) => `
          <tr>
            <td data-label="S.No">${idx + 1}</td>
            <td data-label="Name">${escapeHtml(r.name)}</td>
            <td data-label="Prabhupada Contribution">${fmtMoney(r.netProfit)}</td>
          </tr>`).join("")
      : `<tr><td colspan="3" class="loading-row">No distributors found.</td></tr>`;
    reapplyColumnOrder("bs-general-data-table");
  };
}

/* ---- Tirtha Nidhi: manual contributions (add / my submissions / realise) ---- */
let contributionModalWired = false;

async function openContributionModal(currentUser) {
  document.getElementById("book-contribution-date").value = new Date().toISOString().slice(0, 10);
  document.getElementById("book-contribution-amount").value = "";

  const userNames = (await fetchAllUserNames()).filter((n) => n !== currentUser.user_name);
  const paidToSelect = document.getElementById("book-contribution-paid-to");
  paidToSelect.innerHTML = `<option value="">— Select User —</option>` +
    userNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");

  document.getElementById("book-contribution-error").classList.add("hidden");
  document.getElementById("book-contribution-modal").classList.add("active");
}

function wireContributionModal(currentUser, onSaved) {
  if (contributionModalWired) return;
  contributionModalWired = true;

  const modal = document.getElementById("book-contribution-modal");
  const errorEl = document.getElementById("book-contribution-error");

  document.getElementById("add-book-contribution-btn").onclick = () => openContributionModal(currentUser);
  document.getElementById("book-contribution-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("book-contribution-save-btn").onclick = async () => {
    const contribution_date = document.getElementById("book-contribution-date").value;
    const amount = document.getElementById("book-contribution-amount").value;
    const paid_to = document.getElementById("book-contribution-paid-to").value;

    if (!contribution_date) {
      errorEl.textContent = "Please select a date.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (!amount || Number(amount) <= 0) {
      errorEl.textContent = "Please enter an amount.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (!paid_to) {
      errorEl.textContent = "Please select who this was paid to.";
      errorEl.classList.remove("hidden");
      return;
    }

    const { error } = await supabase.from("book_contributions").insert({
      contribution_date,
      amount: Number(amount),
      submitted_by: currentUser.user_name,
      paid_to,
    });

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast("Contribution added", "success");
    if (onSaved) await onSaved();
  };
}

async function openMyContributionsPopup(userName, showAll = false) {
  let query = supabase
    .from("book_contributions")
    .select("contribution_date, amount, submitted_by, paid_to, realised")
    .order("contribution_date", { ascending: false });
  if (!showAll) query = query.eq("submitted_by", userName);
  const { data, error } = await query;

  const title = document.getElementById("book-dashboard-detail-title");
  const theadRow = document.querySelector("#book-dashboard-detail-table thead tr");
  const tbody = document.getElementById("book-dashboard-detail-body");

  title.textContent = showAll ? "All Contributions" : "My Contributions";
  theadRow.innerHTML = showAll
    ? "<th>S.No</th><th>Date</th><th>Amount</th><th>Submitted By</th><th>Paid To</th><th>Realised</th>"
    : "<th>S.No</th><th>Date</th><th>Amount</th><th>Paid To</th><th>Realised</th>";

  if (error || !data?.length) {
    tbody.innerHTML = `<tr><td colspan="${showAll ? 6 : 5}" class="muted-text">No contributions submitted yet.</td></tr>`;
  } else {
    tbody.innerHTML = data.map((r, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>${escapeHtml(r.contribution_date || "")}</td>
        <td>${fmtMoney(r.amount)}</td>
        ${showAll ? `<td>${escapeHtml(r.submitted_by || "—")}</td>` : ""}
        <td>${escapeHtml(r.paid_to || "—")}</td>
        <td>${r.realised ? "✓ Realised" : "Pending"}</td>
      </tr>
    `).join("");
  }

  document.getElementById("book-dashboard-detail-modal").classList.add("active");
}

async function renderRealiseSection(userName) {
  const tbody = document.getElementById("bs-realise-body");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="5" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("book_contributions")
    .select("id, contribution_date, amount, submitted_by, realised")
    .eq("paid_to", userName)
    .order("contribution_date", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading-row">Could not load contributions.</td></tr>`;
    return;
  }
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted-text">No contributions paid to you yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.map((r, idx) => `
    <tr data-id="${r.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Date">${escapeHtml(r.contribution_date || "")}</td>
      <td data-label="Amount">${fmtMoney(r.amount)}</td>
      <td data-label="Paid By">${escapeHtml(r.submitted_by || "—")}</td>
      <td data-label="Realised"><input type="checkbox" class="realised-checkbox bs-realise-input" ${r.realised ? "checked" : ""} /></td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".bs-realise-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const checked = e.target.checked;
      const { error: updError } = await supabase.from("book_contributions").update({ realised: checked }).eq("id", id);
      if (updError) {
        showToast("Update failed: " + updError.message, "error");
        e.target.checked = !checked;
        return;
      }
      showToast(checked ? "Marked as realised" : "Marked as not realised", "success");
    });
  });
}

/* ---- Tirtha Nidhi: admin view of every contribution submission ---- */
let contributionsAdminCache = [];
let contributionsAdminFiltersWired = false;
const CONTRIBUTIONS_ADMIN_COLUMNS_KEY = "nrg-book-contributions-column-order";
const DEFAULT_CONTRIBUTIONS_ADMIN_COLUMNS = ["S.No", "Date", "Amount", "Submitted By", "Paid To", "Realised", ""];
const CONTRIBUTIONS_ADMIN_SELECT_FILTERS = [["bsc-filter-submitted-by", "submitted_by"], ["bsc-filter-paid-to", "paid_to"]];
const CONTRIBUTIONS_ADMIN_NUMBER_FILTERS = [["bsc-th-filter-amount", "amount"]];

function renderContributionsAdminRows(rows, emptyMessage) {
  const tbody = document.getElementById("bsc-all-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, idx) => `
    <tr data-id="${r.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Date">${escapeHtml(r.contribution_date || "")}</td>
      <td data-label="Amount">${fmtMoney(r.amount)}</td>
      <td data-label="Submitted By">${escapeHtml(r.submitted_by || "—")}</td>
      <td data-label="Paid To">${escapeHtml(r.paid_to || "—")}</td>
      <td data-label="Realised"><input type="checkbox" class="realised-checkbox bsc-admin-realised-input" ${r.realised ? "checked" : ""} /></td>
      <td data-label="">
        <button type="button" class="cell-chip danger bsc-admin-delete-btn" title="Delete">🗑 Delete</button>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".bsc-admin-realised-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const record = contributionsAdminCache.find((x) => x.id === id);
      const checked = e.target.checked;
      const { error } = await supabase.from("book_contributions").update({ realised: checked }).eq("id", id);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        e.target.checked = !checked;
        return;
      }
      if (record) record.realised = checked;
      showToast(checked ? "Marked as realised" : "Marked as not realised", "success");
    });
  });
  tbody.querySelectorAll(".bsc-admin-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteContribution(btn.closest("tr").dataset.id));
  });
  reapplyColumnOrder("bsc-all-table");
}

function applyContributionsAdminFilters() {
  const realisedFilter = document.getElementById("bsc-filter-realised")?.value ?? "__ALL__";
  let rows = contributionsAdminCache.filter((r) =>
    matchesSelectFilters(r, CONTRIBUTIONS_ADMIN_SELECT_FILTERS) &&
    matchesNumberFilters(r, CONTRIBUTIONS_ADMIN_NUMBER_FILTERS) &&
    (realisedFilter === "__ALL__" || (realisedFilter === "yes" ? r.realised : !r.realised))
  );
  rows = sortRows(rows, document.getElementById("bsc-sort")?.value, "contribution_date-desc");
  renderContributionsAdminRows(rows, contributionsAdminCache.length ? "No contributions match your filters." : "No contributions submitted yet.");
}

function wireContributionsAdminFilters() {
  if (contributionsAdminFiltersWired) return;
  contributionsAdminFiltersWired = true;
  // Filters only take effect on "View" — sidebar/header inputs just stage
  // the values so admins can set several before running the query once.
  document.getElementById("bsc-view-btn").addEventListener("click", applyContributionsAdminFilters);
  pairFilterControls("bsc-filter-submitted-by", "bsc-th-filter-submitted-by", () => {});
  pairFilterControls("bsc-filter-paid-to", "bsc-th-filter-paid-to", () => {});
  pairFilterControls("bsc-filter-realised", "bsc-th-filter-realised", () => {});
  wireExportBtn("bsc-export-btn", "bsc-all-table", "Tirtha_Nidhi");
  initColumnDragReorder("bsc-all-table", { storageKey: CONTRIBUTIONS_ADMIN_COLUMNS_KEY, columns: DEFAULT_CONTRIBUTIONS_ADMIN_COLUMNS, resetBtnId: "bsc-reset-columns-btn" });
  initHorizontalScroll("bsc-all-table-wrap");
}

async function deleteContribution(id) {
  const r = contributionsAdminCache.find((x) => x.id === id);
  if (!confirm(`Delete this contribution of ${fmtMoney(r?.amount || 0)} from "${r?.submitted_by || ""}"?`)) return;
  const { error } = await supabase.from("book_contributions").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  showToast("Contribution deleted", "success");
  await initContributionsAdminTable();
}

async function initContributionsAdminTable() {
  wireContributionsAdminFilters();
  const tbody = document.getElementById("bsc-all-body");
  tbody.innerHTML = `<tr><td colspan="7" class="loading-row">Loading…</td></tr>`;

  const [{ data, error }, userNames] = await Promise.all([
    supabase.from("book_contributions").select("id, contribution_date, amount, submitted_by, paid_to, realised").order("contribution_date", { ascending: false }),
    fetchAllUserNames(),
  ]);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading-row">Could not load contributions.</td></tr>`;
    return;
  }
  contributionsAdminCache = data || [];
  populatePairedSelect("bsc-filter-submitted-by", "bsc-th-filter-submitted-by", userNames);
  populatePairedSelect("bsc-filter-paid-to", "bsc-th-filter-paid-to", userNames);
  applyContributionsAdminFilters();
}

export async function initSavingsPanel(currentUser) {
  currentSavingsUser = currentUser;
  const isAdmin = currentUser?.role === "Admin";

  // Nobody ever pays a contribution to Admin, so Admin's "Confirm Receipt"
  // table would always be empty — swap it out for the wide, filterable
  // view of every contribution anyone has submitted instead.
  document.getElementById("bsc-admin-sidebar")?.classList.toggle("hidden", !isAdmin);
  document.getElementById("bsc-all-table-panel")?.classList.toggle("hidden", !isAdmin);
  document.getElementById("bs-realise-section")?.classList.toggle("hidden", isAdmin);

  const statsToolbar = document.getElementById("bs-stats-user-toolbar");
  statsToolbar?.classList.toggle("hidden", !isAdmin);
  if (isAdmin) {
    const select = document.getElementById("bs-stats-user-select");
    if (select && !select.dataset.wired) {
      select.dataset.wired = "1";
      const { data: coordinators } = await supabase.from("users").select("user_name").eq("role", "Coordinator").order("user_name");
      select.innerHTML = `<option value="__ALL__">All Users (combined)</option>` +
        (coordinators || []).map((u) => `<option value="${escapeHtml(u.user_name)}">${escapeHtml(u.user_name)}</option>`).join("");
      select.addEventListener("change", renderSavingsPanel);
    }
  }

  wireDashboardDetailModal();
  if (isAdmin) wireBsGeneralDataModal();
  wireBsUserContributionModal();
  wireContributionModal(currentUser, async () => {
    await renderSavingsPanel();
    if (isAdmin) await initContributionsAdminTable();
  });
  document.getElementById("bs-my-contribution-card").onclick = () => {
    const scopeSel = isAdmin ? (document.getElementById("bs-stats-user-select")?.value || "__ALL__") : currentUser.user_name;
    openMyContributionsPopup(scopeSel === "__ALL__" ? null : scopeSel, scopeSel === "__ALL__");
  };
  const netProfitCard = document.getElementById("bs-net-profit-card");
  netProfitCard.classList.toggle("cursor-pointer", isAdmin);
  netProfitCard.title = isAdmin ? "Tap to view book-wise details" : "";
  netProfitCard.onclick = isAdmin ? () => openBsUserContributionModal(isAdmin, currentUser) : null;

  const tasks = [renderSavingsPanel()];
  if (isAdmin) tasks.push(initContributionsAdminTable());
  else tasks.push(renderRealiseSection(currentUser.user_name));
  await Promise.all(tasks);
}
