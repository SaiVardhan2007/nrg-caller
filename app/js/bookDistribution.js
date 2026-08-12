import { supabase } from "./supabaseClient.js";
import { showToast, escapeHtml, debounce, initColumnDragReorder, reapplyColumnOrder, initHorizontalScroll, populateFilterSelect } from "./utils.js";

let placesCache = [];
let editingPlaceId = null;
let wired = false;
let dashboardWired = false;
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
const DEFAULT_PLACES_COLUMNS = ["Name", "Description", "Map Link", ""];
const PLACES_BLANK_FILTERS = [["bp-filter-description", "description"], ["bp-filter-map-link", "map_link"]];
let placesFiltersWired = false;

export async function initPlaces() {
  wirePlaceModal();
  wirePlacesFilters();
  await loadPlaces();
}

async function loadPlaces() {
  const tbody = document.getElementById("book-places-body");
  tbody.innerHTML = `<tr><td colspan="4" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("book_places")
    .select("id,name,description,map_link")
    .order("name", { ascending: true });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-row">Could not load places.</td></tr>`;
    return;
  }
  placesCache = data || [];
  applyPlacesFilters();
}

function renderPlacesRows(rows, emptyMessage) {
  const tbody = document.getElementById("book-places-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((p) => `
    <tr data-id="${p.id}">
      <td data-label="Name"><strong>${escapeHtml(p.name)}</strong></td>
      <td data-label="Description">${escapeHtml(p.description || "—")}</td>
      <td data-label="Map Link">${p.map_link ? `<a href="${escapeHtml(p.map_link)}" target="_blank" rel="noopener noreferrer" class="cell-chip">📍 Open Map</a>` : "—"}</td>
      <td data-label="">
        <button type="button" class="cell-chip place-edit-btn" title="Edit">✎ Edit</button>
        <button type="button" class="cell-chip danger place-delete-btn" title="Delete">🗑 Delete</button>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".place-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => openPlaceModal(btn.closest("tr").dataset.id));
  });
  tbody.querySelectorAll(".place-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deletePlace(btn.closest("tr").dataset.id));
  });
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

function openPlaceModal(id) {
  editingPlaceId = id || null;
  const p = id ? placesCache.find((x) => x.id === id) : null;
  document.getElementById("book-place-modal-title").textContent = p ? "Edit Place" : "Add Place";
  document.getElementById("book-place-name").value = p ? p.name : "";
  document.getElementById("book-place-description").value = p ? p.description || "" : "";
  document.getElementById("book-place-map-link").value = p ? p.map_link || "" : "";
  document.getElementById("book-place-error").classList.add("hidden");
  document.getElementById("book-place-modal").classList.add("active");
}

function wirePlaceModal() {
  if (wired) return;
  wired = true;
  const modal = document.getElementById("book-place-modal");
  const errorEl = document.getElementById("book-place-error");

  document.getElementById("add-book-place-btn").onclick = () => openPlaceModal(null);
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

    const payload = { name, description: description || null, map_link: mapLink || null };
    const { error } = editingPlaceId
      ? await supabase.from("book_places").update(payload).eq("id", editingPlaceId)
      : await supabase.from("book_places").insert(payload);

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast(editingPlaceId ? "Place updated" : "Place added", "success");
    await loadPlaces();
  };
}

let inwardAdminWired = false;

function wireInwardAdminModal(currentUser) {
  if (inwardAdminWired) return;
  inwardAdminWired = true;

  const modal = document.getElementById("book-inward-modal");
  const errorEl = document.getElementById("book-inward-error");

  document.getElementById("add-book-inward-admin-btn").onclick = () => {
    document.getElementById("book-inward-name").value = "";
    document.getElementById("book-inward-language").value = "";
    document.getElementById("book-inward-price").value = "";
    document.getElementById("book-inward-quantity").value = "";
    document.getElementById("book-inward-from").value = "";
    errorEl.classList.add("hidden");
    modal.classList.add("active");
  };
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

    const { error } = await supabase.from("book_inward_stock").insert({
      name,
      language: language || null,
      purchase_price: price === "" ? null : Number(price),
      quantity: quantity === "" ? null : Number(quantity),
      purchased_from: purchasedFrom || null,
      added_by: currentUser.user_name,
    });

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast("Inward stock added", "success");
    await initInwardTable(currentUser);
  };
}

const INWARD_COLUMNS_KEY = "nrg-book-inward-column-order";
const DEFAULT_INWARD_COLUMNS = ["Time", "Name", "Language", "Purchase Price", "Quantity", "Purchased From", "Added By"];
const INWARD_SELECT_FILTERS = [["bi-filter-language", "language"], ["bi-filter-from", "purchased_from"], ["bi-filter-by", "added_by"]];
const INWARD_NUMBER_FILTERS = [["bi-filter-price", "purchase_price"], ["bi-filter-qty", "quantity"]];
let inwardCache = [];
let inwardFiltersWired = false;

function renderInwardRows(rows, emptyMessage) {
  const tbody = document.getElementById("book-inward-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td data-label="Time">${new Date(r.created_at).toLocaleString()}</td>
      <td data-label="Name">${escapeHtml(r.name)}</td>
      <td data-label="Language">${escapeHtml(r.language || "—")}</td>
      <td data-label="Purchase Price">${r.purchase_price ?? "—"}</td>
      <td data-label="Quantity">${r.quantity ?? "—"}</td>
      <td data-label="Purchased From">${escapeHtml(r.purchased_from || "—")}</td>
      <td data-label="Added By">${escapeHtml(r.added_by || "—")}</td>
    </tr>
  `).join("");
  reapplyColumnOrder("book-inward-table");
}

function applyInwardFilters() {
  const search = document.getElementById("bi-search")?.value.trim().toLowerCase() || "";
  let rows = inwardCache.filter((r) =>
    matchesSearch(r, search, ["name", "purchased_from", "added_by"]) &&
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
  ["bi-filter-language", "bi-filter-from", "bi-filter-by"].forEach((id) =>
    document.getElementById(id).addEventListener("change", applyInwardFilters));
  ["bi-filter-price", "bi-filter-qty"].forEach((id) =>
    document.getElementById(id).addEventListener("input", debounce(applyInwardFilters, 200)));
  initColumnDragReorder("book-inward-table", { storageKey: INWARD_COLUMNS_KEY, columns: DEFAULT_INWARD_COLUMNS, resetBtnId: "bi-reset-columns-btn" });
  initHorizontalScroll("book-inward-table-wrap", { leftBtnId: "bi-scroll-left", rightBtnId: "bi-scroll-right" });
}

export async function initInwardTable(currentUser) {
  wireInwardAdminModal(currentUser);
  wireInwardFilters();
  const tbody = document.getElementById("book-inward-body");
  tbody.innerHTML = `<tr><td colspan="7" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("book_inward_stock")
    .select("name,language,purchase_price,quantity,purchased_from,added_by,created_at")
    .order("created_at", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading-row">Could not load inward stock.</td></tr>`;
    return;
  }
  inwardCache = data || [];
  populateFilterSelect(document.getElementById("bi-filter-language"), distinctValues(inwardCache, "language"));
  populateFilterSelect(document.getElementById("bi-filter-from"), distinctValues(inwardCache, "purchased_from"));
  populateFilterSelect(document.getElementById("bi-filter-by"), distinctValues(inwardCache, "added_by"));
  applyInwardFilters();
}

const OUTWARD_COLUMNS_KEY = "nrg-book-outward-column-order";
const DEFAULT_OUTWARD_COLUMNS = ["Time", "Name", "Language", "Sold Price", "Quantity", "Sold Area", "Sold By"];
const OUTWARD_SELECT_FILTERS = [["bo-filter-language", "language"], ["bo-filter-area", "sold_area"], ["bo-filter-by", "sold_by"]];
const OUTWARD_NUMBER_FILTERS = [["bo-filter-price", "sold_price"], ["bo-filter-qty", "quantity"]];
let outwardCache = [];
let outwardFiltersWired = false;

function renderOutwardRows(rows, emptyMessage) {
  const tbody = document.getElementById("book-outward-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td data-label="Time">${new Date(r.created_at).toLocaleString()}</td>
      <td data-label="Name">${escapeHtml(r.name)}</td>
      <td data-label="Language">${escapeHtml(r.language || "—")}</td>
      <td data-label="Sold Price">${r.sold_price ?? "—"}</td>
      <td data-label="Quantity">${r.quantity ?? "—"}</td>
      <td data-label="Sold Area">${escapeHtml(r.sold_area || "—")}</td>
      <td data-label="Sold By">${escapeHtml(r.sold_by || "—")}</td>
    </tr>
  `).join("");
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

export async function initOutwardTable() {
  wireOutwardFilters();
  const tbody = document.getElementById("book-outward-body");
  tbody.innerHTML = `<tr><td colspan="7" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("book_outward_stock")
    .select("name,language,sold_price,quantity,sold_area,sold_by,created_at")
    .order("created_at", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading-row">Could not load outward stock.</td></tr>`;
    return;
  }
  outwardCache = data || [];
  populateFilterSelect(document.getElementById("bo-filter-language"), distinctValues(outwardCache, "language"));
  populateFilterSelect(document.getElementById("bo-filter-area"), distinctValues(outwardCache, "sold_area"));
  populateFilterSelect(document.getElementById("bo-filter-by"), distinctValues(outwardCache, "sold_by"));
  applyOutwardFilters();
}

/* ======================= DASHBOARD ======================= */

const DASHBOARD_COLUMNS_KEY = "nrg-book-dashboard-column-order";
const DEFAULT_DASHBOARD_COLUMNS = [
  "Name", "Language", "Total Inward", "Avg Purchase Price", "Current Stock",
  "Current Stock Value", "Total Sold", "Avg Selling Price", "Total Sales Value",
];
const DASHBOARD_SELECT_FILTERS = [["bd-filter-language", "language"]];
const DASHBOARD_NUMBER_FILTERS = [["bd-filter-current-stock", "currentStock"]];
let dashboardStatsCache = [];
let dashboardFiltersWired = false;

export async function initDashboard() {
  wireDashboardDetailModal();
  wireDashboardFilters();
  await renderDashboard();
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
    totalInwardQty, avgPurchasePrice, totalPurchaseValue,
    totalSoldQty, avgSellingPrice, totalSalesValue,
    currentStock, currentStockValue, profit,
  };
}

async function renderDashboard() {
  const tbody = document.getElementById("book-dashboard-body");
  tbody.innerHTML = `<tr><td colspan="9" class="loading-row">Loading…</td></tr>`;

  const [{ data: inward, error: inErr }, { data: outward, error: outErr }] = await Promise.all([
    supabase.from("book_inward_stock").select("name,language,purchase_price,quantity,purchased_from,added_by,created_at"),
    supabase.from("book_outward_stock").select("name,language,sold_price,quantity,sold_area,sold_by,created_at"),
  ]);

  if (inErr || outErr) {
    tbody.innerHTML = `<tr><td colspan="9" class="loading-row">Could not load dashboard data.</td></tr>`;
    return;
  }

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

  dashboardStatsCache = Array.from(dashboardBooks.values()).map(computeBookStats);
  populateFilterSelect(document.getElementById("bd-filter-language"), distinctValues(dashboardStatsCache, "language"));
  applyDashboardFilters();
}

function renderDashboardRows(rows, emptyMessage) {
  const tbody = document.getElementById("book-dashboard-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((s) => `
    <tr data-key="${escapeHtml(s.key)}">
      <td data-label="Name"><strong>${escapeHtml(s.name)}</strong></td>
      <td data-label="Language">${escapeHtml(s.language || "—")}</td>
      <td data-label="Total Inward">${s.totalInwardQty ? `<button type="button" class="cell-chip bd-detail-btn" data-kind="inward">${s.totalInwardQty}</button>` : "0"}</td>
      <td data-label="Avg Purchase Price">${s.totalInwardQty ? `<button type="button" class="cell-chip bd-detail-btn" data-kind="purchase-prices">${fmtMoney(s.avgPurchasePrice)}</button>` : "—"}</td>
      <td data-label="Current Stock">${s.currentStock}</td>
      <td data-label="Current Stock Value">${fmtMoney(s.currentStockValue)}</td>
      <td data-label="Total Sold">${s.totalSoldQty ? `<button type="button" class="cell-chip bd-detail-btn" data-kind="outward">${s.totalSoldQty}</button>` : "0"}</td>
      <td data-label="Avg Selling Price">${s.totalSoldQty ? `<button type="button" class="cell-chip bd-detail-btn" data-kind="selling-prices">${fmtMoney(s.avgSellingPrice)}</button>` : "—"}</td>
      <td data-label="Total Sales Value">${fmtMoney(s.totalSalesValue)}</td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".bd-detail-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.closest("tr").dataset.key;
      openDashboardDetail(dashboardBooks.get(key), btn.dataset.kind);
    });
  });
  reapplyColumnOrder("book-dashboard-table");
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
    theadRow.innerHTML = "<th>Time</th><th>Purchase Price</th><th>Quantity</th><th>Purchased From</th><th>Added By</th>";
    const rows = [...book.inward].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    tbody.innerHTML = rows.length ? rows.map((r) => `
      <tr>
        <td>${new Date(r.created_at).toLocaleString()}</td>
        <td>${r.purchase_price ?? "—"}</td>
        <td>${r.quantity ?? "—"}</td>
        <td>${escapeHtml(r.purchased_from || "—")}</td>
        <td>${escapeHtml(r.added_by || "—")}</td>
      </tr>
    `).join("") : `<tr><td colspan="5" class="muted-text">No entries.</td></tr>`;
  } else if (kind === "purchase-prices") {
    title.textContent = `Purchase Prices — ${label}`;
    theadRow.innerHTML = "<th>Price</th><th>Quantity Bought</th><th>Purchased From</th>";
    const rows = groupByPrice(book.inward, "purchase_price", "purchased_from");
    tbody.innerHTML = rows.length ? rows.map((g) => `
      <tr>
        <td>${fmtMoney(g.price)}</td>
        <td>${g.qty}</td>
        <td>${escapeHtml(Array.from(g.places).join(", ") || "—")}</td>
      </tr>
    `).join("") : `<tr><td colspan="3" class="muted-text">No entries.</td></tr>`;
  } else if (kind === "outward") {
    title.textContent = `Outward Stock Entries — ${label}`;
    theadRow.innerHTML = "<th>Time</th><th>Sold Price</th><th>Quantity</th><th>Sold Area</th><th>Sold By</th>";
    const rows = [...book.outward].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    tbody.innerHTML = rows.length ? rows.map((r) => `
      <tr>
        <td>${new Date(r.created_at).toLocaleString()}</td>
        <td>${r.sold_price ?? "—"}</td>
        <td>${r.quantity ?? "—"}</td>
        <td>${escapeHtml(r.sold_area || "—")}</td>
        <td>${escapeHtml(r.sold_by || "—")}</td>
      </tr>
    `).join("") : `<tr><td colspan="5" class="muted-text">No entries.</td></tr>`;
  } else if (kind === "selling-prices") {
    title.textContent = `Selling Prices — ${label}`;
    theadRow.innerHTML = "<th>Price</th><th>Quantity Sold</th><th>Sold Area</th>";
    const rows = groupByPrice(book.outward, "sold_price", "sold_area");
    tbody.innerHTML = rows.length ? rows.map((g) => `
      <tr>
        <td>${fmtMoney(g.price)}</td>
        <td>${g.qty}</td>
        <td>${escapeHtml(Array.from(g.places).join(", ") || "—")}</td>
      </tr>
    `).join("") : `<tr><td colspan="3" class="muted-text">No entries.</td></tr>`;
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
