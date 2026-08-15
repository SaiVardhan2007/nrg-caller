import { supabase } from "./supabaseClient.js";
import { showToast, escapeHtml, debounce, initColumnDragReorder, reapplyColumnOrder, initHorizontalScroll, populateFilterSelect, downloadExcel, exportTableToExcel } from "./utils.js";

let placesCache = [];
let wired = false;
let stockWired = false;
let dashboardWired = false;
let bulkImportWired = false;
let dashboardBooks = new Map();

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
  document.getElementById("bp-filter-description").addEventListener("change", applyPlacesFilters);
  document.getElementById("bp-filter-map-link").addEventListener("change", applyPlacesFilters);
  initColumnDragReorder("book-places-table", { storageKey: PLACES_COLUMNS_KEY, columns: DEFAULT_PLACES_COLUMNS, resetBtnId: "bp-reset-columns-btn" });
  initHorizontalScroll("book-places-table-wrap", { leftBtnId: "bp-scroll-left", rightBtnId: "bp-scroll-right" });
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
  };
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
const INWARD_NUMBER_FILTERS = [["bi-filter-price", "purchase_price"], ["bi-filter-qty", "quantity"]];
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
      <td data-label="Language"><input class="inline-edit" data-field="language" value="${escapeHtml(r.language || "")}" /></td>
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
  ["bi-filter-language", "bi-filter-from"].forEach((id) =>
    document.getElementById(id).addEventListener("change", applyInwardFilters));
  ["bi-filter-price", "bi-filter-qty"].forEach((id) =>
    document.getElementById(id).addEventListener("input", debounce(applyInwardFilters, 200)));
  initColumnDragReorder("book-inward-table", { storageKey: INWARD_COLUMNS_KEY, columns: DEFAULT_INWARD_COLUMNS, resetBtnId: "bi-reset-columns-btn" });
  initHorizontalScroll("book-inward-table-wrap", { leftBtnId: "bi-scroll-left", rightBtnId: "bi-scroll-right" });
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
  populateFilterSelect(document.getElementById("bi-filter-language"), distinctValues(inwardCache, "language"));
  populateFilterSelect(document.getElementById("bi-filter-from"), distinctValues(inwardCache, "purchased_from"));
  applyInwardFilters();
}

const OUTWARD_COLUMNS_KEY = "nrg-book-outward-column-order";
const DEFAULT_OUTWARD_COLUMNS = ["S.No", "Time", "Name", "Language", "Sold Price", "Quantity", "Sold Area", "Sold By", ""];
const OUTWARD_SELECT_FILTERS = [["bo-filter-language", "language"], ["bo-filter-area", "sold_area"], ["bo-filter-by", "sold_by"]];
const OUTWARD_NUMBER_FILTERS = [["bo-filter-price", "sold_price"], ["bo-filter-qty", "quantity"]];
let outwardCache = [];
let outwardFiltersWired = false;

function renderOutwardRows(rows, emptyMessage) {
  const tbody = document.getElementById("book-outward-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, idx) => `
    <tr data-id="${r.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Time">${new Date(r.created_at).toLocaleString()}</td>
      <td data-label="Name"><input class="inline-edit" data-field="name" value="${escapeHtml(r.name)}" /></td>
      <td data-label="Language"><input class="inline-edit" data-field="language" value="${escapeHtml(r.language || "")}" /></td>
      <td data-label="Sold Price"><input class="inline-edit" type="number" min="0" step="0.01" data-field="sold_price" value="${r.sold_price ?? ""}" /></td>
      <td data-label="Quantity"><input class="inline-edit" type="number" min="0" step="1" data-field="quantity" value="${r.quantity ?? ""}" /></td>
      <td data-label="Sold Area"><input class="inline-edit" data-field="sold_area" list="book-places-list" value="${escapeHtml(r.sold_area || "")}" /></td>
      <td data-label="Sold By"><input class="inline-edit" data-field="sold_by" value="${escapeHtml(r.sold_by || "")}" /></td>
      <td data-label="">
        <button type="button" class="cell-chip danger outward-delete-btn" title="Delete">🗑 Delete</button>
      </td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".outward-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteOutwardRow(btn.closest("tr").dataset.id));
  });
  wireInlineEditCells(tbody, "book_outward_stock", outwardCache, { numberFields: ["sold_price", "quantity"], requiredFields: ["name"] }, renderDashboard);
  reapplyColumnOrder("book-outward-table");
}

function applyOutwardFilters() {
  const search = document.getElementById("bo-search")?.value.trim().toLowerCase() || "";
  let rows = outwardCache.filter((r) =>
    matchesSearch(r, search, ["name", "sold_area", "sold_by"]) &&
    matchesSelectFilters(r, OUTWARD_SELECT_FILTERS) &&
    matchesNumberFilters(r, OUTWARD_NUMBER_FILTERS)
  );
  rows = sortRows(rows, document.getElementById("bo-sort")?.value, "created_at-desc");
  renderOutwardRows(rows, outwardCache.length ? "No records match your filters." : "No records yet.");
}

function wireOutwardFilters() {
  if (outwardFiltersWired) return;
  outwardFiltersWired = true;
  document.getElementById("bo-search").addEventListener("input", debounce(applyOutwardFilters, 200));
  document.getElementById("bo-sort").addEventListener("change", applyOutwardFilters);
  ["bo-filter-language", "bo-filter-area", "bo-filter-by"].forEach((id) =>
    document.getElementById(id).addEventListener("change", applyOutwardFilters));
  ["bo-filter-price", "bo-filter-qty"].forEach((id) =>
    document.getElementById(id).addEventListener("input", debounce(applyOutwardFilters, 200)));
  initColumnDragReorder("book-outward-table", { storageKey: OUTWARD_COLUMNS_KEY, columns: DEFAULT_OUTWARD_COLUMNS, resetBtnId: "bo-reset-columns-btn" });
  initHorizontalScroll("book-outward-table-wrap", { leftBtnId: "bo-scroll-left", rightBtnId: "bo-scroll-right" });
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
  tbody.innerHTML = `<tr><td colspan="9" class="loading-row">Loading…</td></tr>`;

  const [{ data, error }, placeNames] = await Promise.all([
    supabase
      .from("book_outward_stock")
      .select("id,name,language,sold_price,quantity,sold_area,sold_by,created_at")
      .order("created_at", { ascending: false }),
    fetchPlaceNames(),
  ]);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="9" class="loading-row">Could not load outward stock.</td></tr>`;
    return;
  }
  outwardCache = data || [];
  populateDatalist(document.getElementById("book-places-list"), placeNames);
  populateFilterSelect(document.getElementById("bo-filter-language"), distinctValues(outwardCache, "language"));
  populateFilterSelect(document.getElementById("bo-filter-area"), distinctValues(outwardCache, "sold_area"));
  populateFilterSelect(document.getElementById("bo-filter-by"), distinctValues(outwardCache, "sold_by"));
  applyOutwardFilters();
}

// "Your ... Stock Entries" only needs to show what's still awaiting the
// user's memory — yesterday + today — since they submit a fresh batch every
// few hours; older entries stay in the database but drop off this list.
function startOfYesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function past72HoursISO() {
  return new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
}

async function renderMyInward(userName) {
  const tbody = document.getElementById("my-inward-body");
  const { data, error } = await supabase
    .from("book_inward_stock")
    .select("name,language,purchase_price,quantity,purchased_from,created_at")
    .eq("added_by", userName)
    .gte("created_at", startOfYesterdayISO())
    .order("created_at", { ascending: false });

  if (error || !data.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-text">No records in the last 2 days.</td></tr>`;
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
    .select("name,language,sold_price,quantity,sold_area,created_at")
    .eq("sold_by", userName)
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
      <td data-label="Sold Price">${r.sold_price ?? "—"}</td>
      <td data-label="Quantity">${r.quantity ?? "—"}</td>
      <td data-label="Sold Area">${escapeHtml(r.sold_area || "—")}</td>
    </tr>
  `).join("");
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

async function fetchPlaceNames() {
  const { data, error } = await supabase.from("book_places").select("name").order("name", { ascending: true });
  if (error || !data) return [];
  return data.map((p) => p.name);
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

  let currentOptions = [];
  let activeIndex = -1;

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

  function render(query) {
    const all = getOptions();
    const q = (query || "").trim().toLowerCase();
    currentOptions = q ? all.filter((o) => o.toLowerCase().includes(q)) : all;
    activeIndex = -1;
    dropdown.innerHTML = currentOptions.length
      ? currentOptions.slice(0, 100).map((o, i) => `<div class="combo-option" data-idx="${i}">${escapeHtml(o)}</div>`).join("")
      : `<div class="combo-empty">No matches</div>`;
    position();
    dropdown.classList.add("open");
  }

  function close() { dropdown.classList.remove("open"); }

  function selectOption(value) {
    input.value = value;
    close();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const onFocus = () => render(input.value);
  const onInput = () => render(input.value);
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
  const onDocClick = (e) => { if (e.target !== input && !dropdown.contains(e.target)) close(); };
  const onReposition = () => { if (dropdown.classList.contains("open")) position(); };

  input.addEventListener("focus", onFocus);
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeydown);
  dropdown.addEventListener("mousedown", onDropdownMousedown);
  document.addEventListener("click", onDocClick);
  document.addEventListener("scroll", onReposition, true);
  window.addEventListener("resize", onReposition);

  return {
    destroy() {
      dropdown.remove();
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKeydown);
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    },
  };
}

function buildOutwardRow(catalog, removable, standardPriceByKey, onChange) {
  const row = document.createElement("div");
  row.className = "stock-row";
  row.innerHTML = `
    <label class="field stock-cell-title"><span>Title</span><input type="text" class="stock-row-title" placeholder="Search a book title…" autocomplete="off" /></label>
    <label class="field"><span>Price</span><input type="number" class="stock-row-price" min="0" step="0.01" /></label>
    <label class="field"><span>Qty</span><input type="number" class="stock-row-qty" min="1" step="1" /></label>
    ${removable ? `<button type="button" class="stock-row-remove cell-chip danger" title="Remove">✕</button>` : ""}
    <div class="field-hint stock-row-standard-price"></div>
  `;
  const titleInput = row.querySelector(".stock-row-title");
  const priceInput = row.querySelector(".stock-row-price");
  const hintEl = row.querySelector(".stock-row-standard-price");
  const titleCombo = wireSearchableCombo(titleInput, () => catalog.map(bookLabel));
  row._destroyCombo = titleCombo.destroy;

  titleInput.addEventListener("input", () => {
    const matched = catalog.find((b) => bookLabel(b).toLowerCase() === titleInput.value.trim().toLowerCase());
    const standardPrice = matched ? standardPriceByKey.get(bookKey(matched.name, matched.language)) : null;
    if (standardPrice != null) {
      hintEl.textContent = `Selling Price: ${fmtMoney(standardPrice)}`;
      if (!priceInput.value) priceInput.value = standardPrice;
    } else {
      hintEl.textContent = "";
    }
    onChange();
  });
  priceInput.addEventListener("input", onChange);
  row.querySelector(".stock-row-qty").addEventListener("input", onChange);
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
  const rowsContainer = document.getElementById("book-outward-rows");
  const draftKey = outwardDraftKey(currentUser);
  let catalog = [];
  let places = [];
  let standardPriceByKey = new Map();
  wireSearchableCombo(areaInput, () => places);

  const saveDraft = () => {
    const rows = Array.from(rowsContainer.querySelectorAll(".stock-row")).map((row) => ({
      title: row.querySelector(".stock-row-title").value,
      price: row.querySelector(".stock-row-price").value,
      qty: row.querySelector(".stock-row-qty").value,
    }));
    localStorage.setItem(draftKey, JSON.stringify({ area: areaInput.value, rows }));
  };

  const addRow = (removable, data) => {
    const row = buildOutwardRow(catalog, removable, standardPriceByKey, saveDraft);
    if (data) {
      row.querySelector(".stock-row-title").value = data.title || "";
      row.querySelector(".stock-row-price").value = data.price || "";
      row.querySelector(".stock-row-qty").value = data.qty || "";
      row.querySelector(".stock-row-title").dispatchEvent(new Event("input"));
    }
    rowsContainer.appendChild(row);
  };

  document.getElementById("add-book-outward-btn").onclick = async () => {
    const [bookCatalog, placeNames, { data: standardPrices }] = await Promise.all([
      fetchBookCatalog(), fetchPlaceNames(),
      supabase.from("book_standard_prices").select("book_key,standard_selling_price"),
    ]);
    catalog = bookCatalog;
    places = placeNames;
    standardPriceByKey = new Map((standardPrices || []).map((r) => [r.book_key, r.standard_selling_price]));

    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(draftKey) || "null"); } catch { draft = null; }
    rowsContainer.querySelectorAll(".stock-row").forEach((row) => row._destroyCombo?.());
    rowsContainer.innerHTML = "";
    if (draft && draft.rows && draft.rows.length) {
      areaInput.value = draft.area || "";
      draft.rows.forEach((data, idx) => addRow(idx > 0, data));
    } else {
      areaInput.value = "";
      addRow(false);
    }
    errorEl.classList.add("hidden");
    modal.classList.add("active");
  };
  document.getElementById("book-outward-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
  areaInput.addEventListener("input", saveDraft);

  document.getElementById("book-outward-add-row-btn").onclick = () => {
    addRow(true);
  };

  document.getElementById("book-outward-save-btn").onclick = async () => {
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
        sold_by: currentUser.user_name,
      });
    }

    if (!payload.length) {
      errorEl.textContent = "Please add at least one book.";
      errorEl.classList.remove("hidden");
      return;
    }

    const { error } = await supabase.from("book_outward_stock").insert(payload);
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    localStorage.removeItem(draftKey);
    modal.classList.remove("active");
    showToast("Outward stock added", "success");
    await renderMyOutward(currentUser.user_name);
  };
}

async function renderMyOutwardScore(userName) {
  const dateInput = document.getElementById("my-outward-score-date");
  const date = dateInput.value;
  const qtyEl = document.getElementById("my-outward-score-qty");
  const valueEl = document.getElementById("my-outward-score-value");
  if (!date) { qtyEl.textContent = "0"; valueEl.textContent = fmtMoney(0); return; }

  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd = new Date(`${date}T23:59:59.999`);
  const { data, error } = await supabase
    .from("book_outward_stock")
    .select("quantity,sold_price")
    .eq("sold_by", userName)
    .gte("created_at", dayStart.toISOString())
    .lte("created_at", dayEnd.toISOString());

  if (error || !data) { qtyEl.textContent = "0"; valueEl.textContent = fmtMoney(0); return; }
  qtyEl.textContent = data.reduce((s, r) => s + (r.quantity || 0), 0);
  valueEl.textContent = fmtMoney(data.reduce((s, r) => s + (r.sold_price || 0) * (r.quantity || 0), 0));
}

let outwardScoreWired = false;

function wireMyOutwardScore(currentUser) {
  if (outwardScoreWired) return;
  outwardScoreWired = true;
  const dateInput = document.getElementById("my-outward-score-date");
  dateInput.value = new Date().toISOString().slice(0, 10);
  dateInput.addEventListener("change", () => renderMyOutwardScore(currentUser.user_name));
}

export async function initStockEntry(currentUser) {
  await Promise.all([renderMyInward(currentUser.user_name), renderMyOutward(currentUser.user_name)]);
  wireMyOutwardScore(currentUser);
  await renderMyOutwardScore(currentUser.user_name);
  if (stockWired) return;
  stockWired = true;

  wireInwardUserModal(currentUser);
  wireOutwardModal(currentUser);
}

/* ======================= DASHBOARD ======================= */

const DASHBOARD_COLUMNS_KEY = "nrg-book-dashboard-column-order";
const DEFAULT_DASHBOARD_COLUMNS = [
  "S.No", "Name", "Selling Price", "Language", "Total Inward", "Avg Purchase Price", "Current Stock",
  "Min Stock", "Current Stock Value", "Total Sold", "Avg Selling Price", "Total Sales Value", "Profit",
];
const DASHBOARD_SELECT_FILTERS = [["bd-filter-language", "language"]];
const DASHBOARD_NUMBER_FILTERS = [["bd-filter-current-stock", "currentStock"]];
let dashboardStatsCache = [];
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
  document.getElementById("bd-filter-language").addEventListener("change", applyDashboardFilters);
  document.getElementById("bd-filter-current-stock").addEventListener("input", debounce(applyDashboardFilters, 200));
  initColumnDragReorder("book-dashboard-table", { storageKey: DASHBOARD_COLUMNS_KEY, columns: DEFAULT_DASHBOARD_COLUMNS, resetBtnId: "bd-reset-columns-btn" });
  initHorizontalScroll("book-dashboard-table-wrap", { leftBtnId: "bd-scroll-left", rightBtnId: "bd-scroll-right" });
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
  populateFilterSelect(document.getElementById("bd-filter-language"), distinctValues(dashboardStatsCache, "language"));
  applyDashboardFilters();
}

function isLowStock(s) {
  return s.minStock != null && s.currentStock < s.minStock;
}

function renderDashboardRows(rows, emptyMessage) {
  const tbody = document.getElementById("book-dashboard-body");
  updateTotalProfitStat(rows);
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
      <td data-label="Current Stock">${s.currentStock}</td>
      <td data-label="Min Stock"><input class="inline-edit bd-min-stock" type="number" min="0" step="1" value="${s.minStock ?? ""}" /></td>
      <td data-label="Current Stock Value">${fmtMoney(s.currentStockValue)}</td>
      <td data-label="Total Sold">${s.totalSoldQty ? `<button type="button" class="cell-chip bd-detail-btn" data-kind="outward">${s.totalSoldQty}</button>` : "0"}</td>
      <td data-label="Avg Selling Price">${s.totalSoldQty ? `<button type="button" class="cell-chip bd-detail-btn" data-kind="selling-prices">${fmtMoney(s.avgSellingPrice)}</button>` : "—"}</td>
      <td data-label="Total Sales Value">${fmtMoney(s.totalSalesValue)}</td>
      <td data-label="Profit"><span style="color:${s.profit < 0 ? "var(--danger)" : "var(--tulsi)"}; font-weight:600;">${fmtMoney(s.profit)}</span></td>
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

// Sums realized profit across whatever rows are currently shown (i.e. respects
// active search/filters, same as the per-book figures below it) rather than
// always totaling the whole catalog.
function updateTotalProfitStat(rows) {
  const el = document.getElementById("bd-stat-total-profit");
  const card = document.getElementById("bd-stat-profit-card");
  if (!el) return;
  const total = rows.reduce((s, r) => s + (r.profit || 0), 0);
  el.textContent = fmtMoney(total);
  card.classList.toggle("stat-negative", total < 0);
  card.classList.toggle("stat-positive", total >= 0);
}

function applyDashboardFilters() {
  const search = document.getElementById("bd-search")?.value.trim().toLowerCase() || "";
  let rows = dashboardStatsCache.filter((s) =>
    matchesSearch(s, search, ["name"]) &&
    matchesSelectFilters(s, DASHBOARD_SELECT_FILTERS) &&
    matchesNumberFilters(s, DASHBOARD_NUMBER_FILTERS)
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

function renderAnalyticsStats(bookStats) {
  const totalInwardQty = bookStats.reduce((s, r) => s + r.totalInwardQty, 0);
  const totalSoldQty = bookStats.reduce((s, r) => s + r.totalSoldQty, 0);
  const totalSalesValue = bookStats.reduce((s, r) => s + r.totalSalesValue, 0);
  const totalPurchaseValue = bookStats.reduce((s, r) => s + r.totalPurchaseValue, 0);
  const totalProfit = bookStats.reduce((s, r) => s + r.profit, 0);

  document.getElementById("ba-stat-inward-qty").textContent = totalInwardQty;
  document.getElementById("ba-stat-sold-qty").textContent = totalSoldQty;
  document.getElementById("ba-stat-sales-value").textContent = fmtMoney(totalSalesValue);
  document.getElementById("ba-stat-purchase-value").textContent = fmtMoney(totalPurchaseValue);
  document.getElementById("ba-stat-profit").textContent = fmtMoney(totalProfit);
  const card = document.getElementById("ba-stat-profit-card");
  card.classList.toggle("stat-negative", totalProfit < 0);
  card.classList.toggle("stat-positive", totalProfit >= 0);
}

function renderAnalyticsTopBooks(bookStats) {
  const tbody = document.getElementById("ba-books-body");
  const rows = bookStats.filter((s) => s.totalSoldQty > 0).sort((a, b) => b.totalSoldQty - a.totalSoldQty);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted-text">No sales in this range.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((s, idx) => `
    <tr>
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Name">${escapeHtml(s.name)}</td>
      <td data-label="Language">${escapeHtml(s.language || "—")}</td>
      <td data-label="Qty Sold">${s.totalSoldQty}</td>
      <td data-label="Sales Value">${fmtMoney(s.totalSalesValue)}</td>
      <td data-label="Avg Price">${fmtMoney(s.avgSellingPrice)}</td>
    </tr>
  `).join("");
}

function renderAnalyticsByArea(outward) {
  const groups = new Map();
  outward.forEach((r) => {
    const area = r.sold_area || "—";
    if (!groups.has(area)) groups.set(area, { area, qty: 0, value: 0, books: new Set() });
    const g = groups.get(area);
    g.qty += r.quantity || 0;
    g.value += (r.sold_price || 0) * (r.quantity || 0);
    g.books.add(bookKey(r.name, r.language));
  });
  const tbody = document.getElementById("ba-area-body");
  const rows = Array.from(groups.values()).sort((a, b) => b.qty - a.qty);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted-text">No sales in this range.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((g, idx) => `
    <tr>
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Area">${escapeHtml(g.area)}</td>
      <td data-label="Qty Sold">${g.qty}</td>
      <td data-label="Sales Value">${fmtMoney(g.value)}</td>
      <td data-label="Books">${g.books.size}</td>
    </tr>
  `).join("");
}

function renderAnalyticsBySeller(outward) {
  const groups = new Map();
  outward.forEach((r) => {
    const seller = r.sold_by || "—";
    if (!groups.has(seller)) groups.set(seller, { seller, qty: 0, value: 0 });
    const g = groups.get(seller);
    g.qty += r.quantity || 0;
    g.value += (r.sold_price || 0) * (r.quantity || 0);
  });
  const tbody = document.getElementById("ba-seller-body");
  const rows = Array.from(groups.values()).sort((a, b) => b.qty - a.qty);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted-text">No sales in this range.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((g, idx) => `
    <tr>
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Sold By">${escapeHtml(g.seller)}</td>
      <td data-label="Qty Sold">${g.qty}</td>
      <td data-label="Sales Value">${fmtMoney(g.value)}</td>
    </tr>
  `).join("");
}

function renderAnalyticsByLanguage(inward, outward) {
  const groups = new Map();
  const ensure = (lang) => {
    const key = lang || "—";
    if (!groups.has(key)) groups.set(key, { language: key, inwardQty: 0, soldQty: 0 });
    return groups.get(key);
  };
  inward.forEach((r) => { ensure(r.language).inwardQty += r.quantity || 0; });
  outward.forEach((r) => { ensure(r.language).soldQty += r.quantity || 0; });
  const tbody = document.getElementById("ba-language-body");
  const rows = Array.from(groups.values()).sort((a, b) => b.soldQty - a.soldQty);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted-text">No data in this range.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((g, idx) => `
    <tr>
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Language">${escapeHtml(g.language)}</td>
      <td data-label="Inward Qty">${g.inwardQty}</td>
      <td data-label="Sold Qty">${g.soldQty}</td>
    </tr>
  `).join("");
}

function renderAnalyticsBySource(inward) {
  const groups = new Map();
  inward.forEach((r) => {
    const source = r.purchased_from || "—";
    if (!groups.has(source)) groups.set(source, { source, qty: 0, value: 0 });
    const g = groups.get(source);
    g.qty += r.quantity || 0;
    g.value += (r.purchase_price || 0) * (r.quantity || 0);
  });
  const tbody = document.getElementById("ba-source-body");
  const rows = Array.from(groups.values()).sort((a, b) => b.qty - a.qty);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted-text">No purchases in this range.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((g, idx) => `
    <tr>
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Purchased From">${escapeHtml(g.source)}</td>
      <td data-label="Qty Bought">${g.qty}</td>
      <td data-label="Purchase Value">${fmtMoney(g.value)}</td>
    </tr>
  `).join("");
}

async function runAnalytics() {
  const from = document.getElementById("ba-from").value;
  const to = document.getElementById("ba-to").value;
  const fromISO = from ? new Date(`${from}T00:00:00`).toISOString() : null;
  const toISO = to ? new Date(`${to}T23:59:59.999`).toISOString() : null;

  let inwardQuery = supabase.from("book_inward_stock").select("name,language,purchase_price,quantity,purchased_from,created_at");
  let outwardQuery = supabase.from("book_outward_stock").select("name,language,sold_price,quantity,sold_area,sold_by,created_at");
  if (fromISO) { inwardQuery = inwardQuery.gte("created_at", fromISO); outwardQuery = outwardQuery.gte("created_at", fromISO); }
  if (toISO) { inwardQuery = inwardQuery.lte("created_at", toISO); outwardQuery = outwardQuery.lte("created_at", toISO); }

  const [{ data: inward, error: inErr }, { data: outward, error: outErr }] = await Promise.all([inwardQuery, outwardQuery]);
  if (inErr || outErr) {
    showToast("Could not load analytics data.", "error");
    return;
  }

  const bookStats = buildBookBuckets(inward || [], outward || []).map(computeBookStats);
  renderAnalyticsStats(bookStats);
  renderAnalyticsTopBooks(bookStats);
  renderAnalyticsByArea(outward || []);
  renderAnalyticsBySeller(outward || []);
  renderAnalyticsByLanguage(inward || [], outward || []);
  renderAnalyticsBySource(inward || []);
}

let analyticsWired = false;

function wireAnalyticsFilters() {
  if (analyticsWired) return;
  analyticsWired = true;

  const fromInput = document.getElementById("ba-from");
  const toInput = document.getElementById("ba-to");
  const d = new Date();
  d.setDate(d.getDate() - 30);
  fromInput.value = analyticsDateInput(d);
  toInput.value = analyticsDateInput(new Date());

  document.getElementById("ba-run-btn").addEventListener("click", runAnalytics);
  [
    ["ba-export-books-btn", "ba-books-table", "Top_Books"],
    ["ba-export-area-btn", "ba-area-table", "By_Area"],
    ["ba-export-seller-btn", "ba-seller-table", "By_Seller"],
    ["ba-export-language-btn", "ba-language-table", "By_Language"],
    ["ba-export-source-btn", "ba-source-table", "By_Purchased_From"],
  ].forEach(([btnId, tableId, label]) => {
    document.getElementById(btnId).addEventListener("click", () => {
      exportTableToExcel(document.getElementById(tableId), `Book_Analytics_${label}_${analyticsDateInput(new Date())}.xlsx`);
    });
  });
}

export async function initAnalytics() {
  wireAnalyticsFilters();
  await runAnalytics();
}
