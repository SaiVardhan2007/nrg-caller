import { supabase } from "./supabaseClient.js";
import { showToast, escapeHtml, debounce, initColumnDragReorder, reapplyColumnOrder, initHorizontalScroll, downloadExcel, populateFilterSelect, exportTableToExcel } from "./utils.js";

const SADHANA_COLUMNS_KEY = "nrg-sadhana-column-order";
const DEFAULT_SADHANA_COLUMNS = ["S.No", "Name", "Date", "Rounds", "Book Reading", "Screen Time", "Detox Time", "Service", "Swadhyaya", ""];
const NUMBER_FIELDS = ["rounds", "book_reading", "screen_time", "detox_time"];
const SERVICE_OPTIONS = ["Yes", "No", "Na"];
const SWADHYAYA_OPTIONS = ["Yes", "No"];
const SADHANA_NUMBER_FILTERS = [
  ["sadhana-th-filter-rounds", "rounds"],
  ["sadhana-th-filter-book-reading", "book_reading"],
  ["sadhana-th-filter-screen-time", "screen_time"],
  ["sadhana-th-filter-detox-time", "detox_time"],
];
const SADHANA_SELECT_FILTERS = [
  ["sadhana-th-filter-service", "service"],
  ["sadhana-th-filter-swadhyaya", "swadhyaya"],
];

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

function matchesDateFilter(row) {
  const val = document.getElementById("sadhana-th-filter-date")?.value || "";
  if (!val) return true;
  return row.sadhana_date === val;
}

function selectOptionsHtml(options, selected) {
  return `<option value="">—</option>` + options.map((o) => `<option value="${o}" ${o === selected ? "selected" : ""}>${o}</option>`).join("");
}

let sadhanaCache = [];
let filtersWired = false;
let modalWired = false;
let bulkImportWired = false;
let trackedNamesCache = [];

// Names come from the tracked-user roster (same set as the "Enter Sadhana"
// page) so admin entries can't drift into typo'd variants of a real name.
// A row's own current name is always kept as an option even if it's since
// fallen out of the tracked roster, so editing never silently blanks it.
async function loadTrackedNames() {
  const { data } = await supabase.from("users").select("user_name").eq("sadhana_track", true).order("user_name");
  trackedNamesCache = (data || []).map((u) => u.user_name);
}

function nameOptionsHtml(current) {
  const opts = new Set(trackedNamesCache);
  if (current) opts.add(current);
  const sorted = Array.from(opts).sort((a, b) => a.localeCompare(b));
  return `<option value="">— Select —</option>` +
    sorted.map((v) => `<option value="${escapeHtml(v)}" ${v === current ? "selected" : ""}>${escapeHtml(v)}</option>`).join("");
}

function duplicateKey(name, date) {
  return `${String(name || "").trim().toLowerCase()}||${date || ""}`;
}

// A person submitting sadhana twice for the same date is the "red row" case —
// flag every row that shares its name+date with another row in the full
// dataset (not just the filtered/sorted view being rendered).
function findDuplicateKeys() {
  const counts = new Map();
  sadhanaCache.forEach((r) => {
    const key = duplicateKey(r.name, r.sadhana_date);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

export function localDateInput(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayLocalDate() {
  return localDateInput(new Date());
}

// Click-to-edit for table cells, same pattern as Book Distribution's
// wireInlineEditCells — saves straight to Supabase on change/blur.
function wireInlineEditCells(tbody) {
  tbody.querySelectorAll(".inline-edit").forEach((el) => {
    el.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const field = e.target.dataset.field;
      const record = sadhanaCache.find((x) => x.id === id);
      const raw = e.target.value.trim();

      if (field === "name" && !raw) {
        showToast("Name cannot be empty.", "error");
        e.target.value = record[field] ?? "";
        return;
      }

      const value = NUMBER_FIELDS.includes(field) ? (raw === "" ? null : Number(raw)) : (raw || null);
      const { error } = await supabase.from("fnrg_sadhana").update({ [field]: value }).eq("id", id);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        e.target.value = record[field] ?? "";
        return;
      }
      record[field] = value;
    });
  });
}

function matchesSearch(row, term) {
  if (!term) return true;
  return String(row.name || "").toLowerCase().includes(term);
}

function sortRows(rows, sortVal) {
  const [field, dir] = (sortVal || "sadhana_date-desc").split("-");
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

function renderSadhanaRows(rows, emptyMessage) {
  const tbody = document.getElementById("sadhana-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }
  const dupCounts = findDuplicateKeys();
  tbody.innerHTML = rows.map((r, idx) => `
    <tr data-id="${r.id}" class="${dupCounts.get(duplicateKey(r.name, r.sadhana_date)) > 1 ? "contact-duplicate" : ""}" title="${dupCounts.get(duplicateKey(r.name, r.sadhana_date)) > 1 ? "Another entry already exists for this name + date" : ""}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Name"><select class="inline-edit" data-field="name">${nameOptionsHtml(r.name)}</select></td>
      <td data-label="Date"><input class="inline-edit" type="date" data-field="sadhana_date" value="${r.sadhana_date || ""}" /></td>
      <td data-label="Rounds"><input class="inline-edit" type="number" min="0" step="any" data-field="rounds" value="${r.rounds ?? ""}" /></td>
      <td data-label="Book Reading"><input class="inline-edit" type="number" min="0" step="any" data-field="book_reading" value="${r.book_reading ?? ""}" /></td>
      <td data-label="Screen Time"><input class="inline-edit" type="number" min="0" step="any" data-field="screen_time" value="${r.screen_time ?? ""}" /></td>
      <td data-label="Detox Time"><input class="inline-edit" type="number" min="0" step="any" data-field="detox_time" value="${r.detox_time ?? ""}" /></td>
      <td data-label="Service"><select class="inline-edit" data-field="service">${selectOptionsHtml(SERVICE_OPTIONS, r.service)}</select></td>
      <td data-label="Swadhyaya"><select class="inline-edit" data-field="swadhyaya">${selectOptionsHtml(SWADHYAYA_OPTIONS, r.swadhyaya)}</select></td>
      <td data-label="">
        <button type="button" class="cell-chip danger sadhana-delete-btn" title="Delete">🗑 Delete</button>
      </td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".sadhana-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteSadhanaRow(btn.closest("tr").dataset.id));
  });
  wireInlineEditCells(tbody);
  reapplyColumnOrder("sadhana-table");
}

function applySadhanaFilters() {
  const search = document.getElementById("sadhana-search")?.value.trim().toLowerCase() || "";
  const rows = sadhanaCache.filter((r) =>
    matchesSearch(r, search) &&
    matchesDateFilter(r) &&
    matchesNumberFilters(r, SADHANA_NUMBER_FILTERS) &&
    matchesSelectFilters(r, SADHANA_SELECT_FILTERS)
  );
  const sorted = sortRows(rows, document.getElementById("sadhana-sort")?.value);
  renderSadhanaRows(sorted, sadhanaCache.length ? "No records match your filters." : "No records yet — add one to get started.");
}

function wireSadhanaFilters() {
  if (filtersWired) return;
  filtersWired = true;
  document.getElementById("sadhana-search").addEventListener("input", debounce(applySadhanaFilters, 200));
  document.getElementById("sadhana-sort").addEventListener("change", applySadhanaFilters);
  document.getElementById("sadhana-th-filter-date").addEventListener("change", applySadhanaFilters);
  SADHANA_NUMBER_FILTERS.forEach(([inputId]) => {
    document.getElementById(inputId)?.addEventListener("input", debounce(applySadhanaFilters, 200));
  });
  SADHANA_SELECT_FILTERS.forEach(([selectId]) => {
    document.getElementById(selectId)?.addEventListener("change", applySadhanaFilters);
  });
  initColumnDragReorder("sadhana-table", { storageKey: SADHANA_COLUMNS_KEY, columns: DEFAULT_SADHANA_COLUMNS, resetBtnId: "sadhana-reset-columns-btn" });
  initHorizontalScroll("sadhana-table-wrap");
}

async function deleteSadhanaRow(id) {
  const r = sadhanaCache.find((x) => x.id === id);
  if (!confirm(`Delete sadhana entry for "${r?.name || ""}"?`)) return;
  const { error } = await supabase.from("fnrg_sadhana").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  showToast("Sadhana entry deleted", "success");
  await loadSadhana();
}

async function openSadhanaModal() {
  await loadTrackedNames();
  document.getElementById("sadhana-name").innerHTML = nameOptionsHtml("");
  document.getElementById("sadhana-date").value = todayLocalDate();
  document.getElementById("sadhana-rounds").value = "";
  document.getElementById("sadhana-book-reading").value = "";
  document.getElementById("sadhana-screen-time").value = "";
  document.getElementById("sadhana-detox-time").value = "";
  document.getElementById("sadhana-service").value = "";
  document.getElementById("sadhana-swadhyaya").value = "";
  document.getElementById("sadhana-error").classList.add("hidden");
  document.getElementById("sadhana-modal").classList.add("active");
}

function wireSadhanaModal(currentUser) {
  if (modalWired) return;
  modalWired = true;

  const modal = document.getElementById("sadhana-modal");
  const errorEl = document.getElementById("sadhana-error");

  document.getElementById("add-sadhana-btn").onclick = () => openSadhanaModal();
  document.getElementById("sadhana-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("sadhana-save-btn").onclick = async () => {
    const name = document.getElementById("sadhana-name").value.trim();
    const date = document.getElementById("sadhana-date").value;
    const rounds = document.getElementById("sadhana-rounds").value;
    const bookReading = document.getElementById("sadhana-book-reading").value;
    const screenTime = document.getElementById("sadhana-screen-time").value;
    const detoxTime = document.getElementById("sadhana-detox-time").value;
    const service = document.getElementById("sadhana-service").value;
    const swadhyaya = document.getElementById("sadhana-swadhyaya").value;

    if (!name) {
      errorEl.textContent = "Please enter a name.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (!date) {
      errorEl.textContent = "Please choose a date.";
      errorEl.classList.remove("hidden");
      return;
    }
    const isDup = sadhanaCache.some((r) => duplicateKey(r.name, r.sadhana_date) === duplicateKey(name, date));
    if (isDup && !confirm(`An entry for "${name}" on ${date} already exists. Add another anyway?`)) {
      return;
    }

    const payload = {
      name,
      sadhana_date: date,
      rounds: rounds === "" ? null : Number(rounds),
      book_reading: bookReading === "" ? null : Number(bookReading),
      screen_time: screenTime === "" ? null : Number(screenTime),
      detox_time: detoxTime === "" ? null : Number(detoxTime),
      service: service || null,
      swadhyaya: swadhyaya || null,
      added_by: currentUser?.user_name || null,
    };
    const { error } = await supabase.from("fnrg_sadhana").insert(payload);

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast("Sadhana entry added", "success");
    await loadSadhana();
  };
}

// Accepts JS Date objects (when the sheet reads dates as real dates), Excel
// serial numbers (pasted as plain numbers), dd/mm/yyyy, or yyyy-mm-dd text.
function parseImportDate(val) {
  if (val instanceof Date && !isNaN(val)) {
    const y = val.getFullYear(), m = String(val.getMonth() + 1).padStart(2, "0"), d = String(val.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(val ?? "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  if (/^\d+(\.\d+)?$/.test(s) && window.XLSX?.SSF) {
    const parsed = XLSX.SSF.parse_date_code(Number(s));
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  return "";
}

function parseSadhanaImportRows(objRows) {
  let skipped = 0;
  const rows = [];
  objRows.forEach((obj) => {
    const norm = {};
    Object.keys(obj).forEach((k) => { norm[k.trim().toLowerCase()] = obj[k]; });
    const name = String(norm.name ?? "").trim();
    if (!name) { skipped++; return; }
    const num = (v) => (v === "" || v === undefined || v === null ? null : Number(v));
    rows.push({
      name,
      sadhana_date: parseImportDate(norm.date ?? norm.sadhana_date) || todayLocalDate(),
      rounds: num(norm.rounds),
      book_reading: num(norm["book reading"] ?? norm.book_reading),
      screen_time: num(norm["screen time"] ?? norm.screen_time),
      detox_time: num(norm["detox time"] ?? norm.detox_time),
    });
  });
  return { rows, skipped };
}

function wireSadhanaBulkImportModal(currentUser) {
  if (bulkImportWired) return;
  bulkImportWired = true;

  const modal = document.getElementById("sadhana-bulk-import-modal");
  const fileInput = document.getElementById("sadhana-bulk-import-file");
  const previewEl = document.getElementById("sadhana-bulk-import-preview");
  const errorEl = document.getElementById("sadhana-bulk-import-error");
  const importBtn = document.getElementById("sadhana-bulk-import-save-btn");
  let parsedRows = [];

  document.getElementById("add-sadhana-bulk-btn").onclick = () => {
    fileInput.value = "";
    previewEl.textContent = "";
    errorEl.classList.add("hidden");
    parsedRows = [];
    importBtn.disabled = true;
    modal.classList.add("active");
  };
  document.getElementById("sadhana-bulk-import-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("sadhana-bulk-import-template-btn").onclick = () => {
    downloadExcel("FNRG_Sadhana_Import_Template.xlsx", [
      ["Name", "Date", "Rounds", "Book Reading", "Screen Time", "Detox Time"],
      ["Jane Doe", todayLocalDate(), 16, 30, 45, 60],
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
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const objRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      const { rows, skipped } = parseSadhanaImportRows(objRows);
      parsedRows = rows;
      if (!rows.length) {
        errorEl.textContent = "No valid rows found — make sure the sheet has a Name column.";
        errorEl.classList.remove("hidden");
        return;
      }
      const dupCount = rows.filter((r) => sadhanaCache.some((c) => duplicateKey(c.name, c.sadhana_date) === duplicateKey(r.name, r.sadhana_date))).length;
      previewEl.textContent = `${rows.length} row(s) ready to import` + (skipped ? `, ${skipped} skipped (missing name)` : "") + (dupCount ? `. ${dupCount} match an existing entry and will show as duplicates (red).` : "") + ".";
      importBtn.disabled = false;
    } catch (err) {
      errorEl.textContent = "Could not read that file. Please upload a valid .xlsx/.csv file.";
      errorEl.classList.remove("hidden");
    }
  };

  importBtn.onclick = async () => {
    if (!parsedRows.length) return;
    importBtn.disabled = true;
    const payload = parsedRows.map((r) => ({ ...r, added_by: currentUser?.user_name || null }));
    const { error } = await supabase.from("fnrg_sadhana").insert(payload);
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      importBtn.disabled = false;
      return;
    }
    modal.classList.remove("active");
    showToast(`${parsedRows.length} sadhana row(s) imported`, "success");
    await loadSadhana();
  };
}

async function loadSadhana() {
  const tbody = document.getElementById("sadhana-body");
  tbody.innerHTML = `<tr><td colspan="10" class="loading-row">Loading…</td></tr>`;

  const [{ data, error }] = await Promise.all([
    supabase
      .from("fnrg_sadhana")
      .select("id,name,sadhana_date,rounds,book_reading,screen_time,detox_time,service,swadhyaya")
      .order("sadhana_date", { ascending: false }),
    loadTrackedNames(),
  ]);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="10" class="loading-row">Could not load sadhana records.</td></tr>`;
    return;
  }
  sadhanaCache = data || [];
  applySadhanaFilters();
}

export async function initSadhana(currentUser) {
  wireSadhanaModal(currentUser);
  wireSadhanaBulkImportModal(currentUser);
  wireSadhanaFilters();
  await loadSadhana();
}

/* ======================= USERS (track roster) =======================
   Lets admin pick which people from the users table show up in the
   regular-user "Enter Sadhana" roster — toggling Track on/off updates
   users.sadhana_track directly. */

let sadhanaUsersWired = false;

function renderSadhanaUsersTable(users) {
  const tbody = document.getElementById("sadhana-users-body");
  const summary = document.getElementById("sadhana-users-summary");
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-row">No users yet.</td></tr>`;
    summary.textContent = "";
    return;
  }

  tbody.innerHTML = users.map((u, i) => `
    <tr data-id="${u.id}" data-name="${escapeHtml(u.user_name || "")}">
      <td data-label="S.No">${i + 1}</td>
      <td data-label="Name">${escapeHtml(u.user_name || "")}</td>
      <td data-label="Role">${u.role}</td>
      <td data-label="Track"><input type="checkbox" class="sadhana-track-input" ${u.sadhana_track ? "checked" : ""} /></td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".sadhana-track-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const { error } = await supabase.from("users").update({ sadhana_track: e.target.checked }).eq("id", id);
      if (error) { showToast("Could not update Track: " + error.message, "error"); e.target.checked = !e.target.checked; return; }
      const rec = sadhanaUsersCache.find((x) => x.id === id);
      if (rec) rec.sadhana_track = e.target.checked;
      updateSadhanaUsersSummary();
      showToast("Track updated", "success");
    });
  });

  updateSadhanaUsersSummary();
}

function updateSadhanaUsersSummary() {
  const summary = document.getElementById("sadhana-users-summary");
  const tracked = sadhanaUsersCache.filter((u) => u.sadhana_track).length;
  summary.textContent = `${tracked} of ${sadhanaUsersCache.length} tracked (visible in Enter Sadhana).`;
}

function applySadhanaUsersSearch() {
  const term = document.getElementById("sadhana-users-search").value.trim().toLowerCase();
  document.querySelectorAll("#sadhana-users-body tr[data-id]").forEach((row) => {
    row.classList.toggle("hidden", !!term && !row.dataset.name.toLowerCase().includes(term));
  });
}

let sadhanaUsersCache = [];

async function loadSadhanaUsers() {
  const tbody = document.getElementById("sadhana-users-body");
  tbody.innerHTML = `<tr><td colspan="4" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase.from("users").select("id,user_name,role,sadhana_track").order("user_name");
  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-row">Could not load users.</td></tr>`;
    return;
  }
  sadhanaUsersCache = data || [];
  renderSadhanaUsersTable(sadhanaUsersCache);
  applySadhanaUsersSearch();
}

export async function initSadhanaUsers() {
  if (!sadhanaUsersWired) {
    sadhanaUsersWired = true;
    document.getElementById("sadhana-users-search").addEventListener("input", debounce(applySadhanaUsersSearch, 150));
  }
  await loadSadhanaUsers();
}

/* ======================= ANALYTICS =======================
   Aggregates fnrg_sadhana rows (over a date range / name filter) into a
   per-person leaderboard — entries logged, consistency against the range's
   day count, and per-metric averages/totals. Raw rows for the current run
   are kept in analyticsRows so the per-row "View" drill-down and the
   min-entries/sort controls can re-slice client-side without re-querying. */

let analyticsRows = [];
let analyticsLeaderboard = [];
let analyticsDaysInRange = null;
let analyticsFiltersWired = false;

function avg(sum, count) {
  return count ? sum / count : 0;
}

function fmt1(n) {
  return (Math.round((n || 0) * 10) / 10).toString();
}

function daysBetweenInclusive(from, to) {
  if (!from || !to) return null;
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  return Math.round((b - a) / 86400000) + 1;
}

function buildLeaderboard(rows) {
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.name)) {
      map.set(r.name, { name: r.name, entries: 0, roundsSum: 0, roundsCount: 0, bookSum: 0, bookCount: 0, screenSum: 0, screenCount: 0, detoxSum: 0, detoxCount: 0, lastDate: null });
    }
    const e = map.get(r.name);
    e.entries++;
    if (r.rounds != null) { e.roundsSum += r.rounds; e.roundsCount++; }
    if (r.book_reading != null) { e.bookSum += r.book_reading; e.bookCount++; }
    if (r.screen_time != null) { e.screenSum += r.screen_time; e.screenCount++; }
    if (r.detox_time != null) { e.detoxSum += r.detox_time; e.detoxCount++; }
    if (!e.lastDate || r.sadhana_date > e.lastDate) e.lastDate = r.sadhana_date;
  });
  return Array.from(map.values()).map((e) => ({
    name: e.name,
    entries: e.entries,
    totalRounds: e.roundsSum,
    avgRounds: avg(e.roundsSum, e.roundsCount),
    avgBook: avg(e.bookSum, e.bookCount),
    avgScreen: avg(e.screenSum, e.screenCount),
    avgDetox: avg(e.detoxSum, e.detoxCount),
    lastDate: e.lastDate,
  }));
}

function sortLeaderboard(rows, sortVal, daysInRange) {
  const [field, dir] = (sortVal || "rounds_total-desc").split("-");
  const ascending = dir !== "desc";
  const valueOf = (r) => {
    if (field === "rounds_total") return r.totalRounds;
    if (field === "rounds_avg") return r.avgRounds;
    if (field === "entries") return r.entries;
    if (field === "consistency") return daysInRange ? r.entries / daysInRange : 0;
    return r.name.toLowerCase();
  };
  return [...rows].sort((a, b) => {
    const av = valueOf(a), bv = valueOf(b);
    if (typeof av === "string" || typeof bv === "string") return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
    return ascending ? av - bv : bv - av;
  });
}

function renderAnalyticsStats(rows, leaderboard) {
  const roundsRows = rows.filter((r) => r.rounds != null);
  const totalRounds = roundsRows.reduce((s, r) => s + r.rounds, 0);
  const bookRows = rows.filter((r) => r.book_reading != null);
  const avgBook = avg(bookRows.reduce((s, r) => s + r.book_reading, 0), bookRows.length);
  const detoxRows = rows.filter((r) => r.detox_time != null);
  const avgDetox = avg(detoxRows.reduce((s, r) => s + r.detox_time, 0), detoxRows.length);

  document.getElementById("sa-stat-entries").textContent = rows.length;
  document.getElementById("sa-stat-participants").textContent = leaderboard.length;
  document.getElementById("sa-stat-rounds-total").textContent = totalRounds;
  document.getElementById("sa-stat-rounds-avg").textContent = fmt1(avg(totalRounds, roundsRows.length));
  document.getElementById("sa-stat-book-avg").textContent = fmt1(avgBook);
  document.getElementById("sa-stat-detox-avg").textContent = fmt1(avgDetox);
}

function renderAnalyticsLeaderboard(rows, daysInRange) {
  const tbody = document.getElementById("sa-leaderboard-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="muted-text">No sadhana entries match these filters.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, idx) => {
    const consistency = daysInRange ? `${Math.round((r.entries / daysInRange) * 100)}%` : "—";
    return `
    <tr>
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Name">${escapeHtml(r.name)}</td>
      <td data-label="Entries">${r.entries}</td>
      <td data-label="Consistency">${consistency}</td>
      <td data-label="Total Rounds">${r.totalRounds}</td>
      <td data-label="Avg Rounds">${fmt1(r.avgRounds)}</td>
      <td data-label="Avg Book Reading">${fmt1(r.avgBook)}</td>
      <td data-label="Avg Screen Time">${fmt1(r.avgScreen)}</td>
      <td data-label="Avg Detox Time">${fmt1(r.avgDetox)}</td>
      <td data-label="Last Entry">${r.lastDate || "—"}</td>
      <td data-label="" class="no-export"><button type="button" class="cell-chip sa-view-btn" data-name="${escapeHtml(r.name)}">👁 View</button></td>
    </tr>`;
  }).join("");
  tbody.querySelectorAll(".sa-view-btn").forEach((btn) => {
    btn.addEventListener("click", () => openAnalyticsDetail(btn.dataset.name));
  });
}

function openAnalyticsDetail(name) {
  const rows = analyticsRows.filter((r) => r.name === name).sort((a, b) => (b.sadhana_date || "").localeCompare(a.sadhana_date || ""));
  document.getElementById("sadhana-analytics-detail-title").textContent = `${name} — Daily Entries`;
  document.getElementById("sadhana-analytics-detail-body").innerHTML = rows.length ? rows.map((r) => `
    <tr>
      <td data-label="Date">${r.sadhana_date || "—"}</td>
      <td data-label="Rounds">${r.rounds ?? "—"}</td>
      <td data-label="Book Reading">${r.book_reading ?? "—"}</td>
      <td data-label="Screen Time">${r.screen_time ?? "—"}</td>
      <td data-label="Detox Time">${r.detox_time ?? "—"}</td>
      <td data-label="Service">${r.service || "—"}</td>
      <td data-label="Swadhyaya">${r.swadhyaya || "—"}</td>
    </tr>
  `).join("") : `<tr><td colspan="7" class="muted-text">No entries.</td></tr>`;
  document.getElementById("sadhana-analytics-detail-modal").classList.add("active");
}

// Re-slices the already-fetched analyticsRows by Min Entries + Sort By without
// re-querying Supabase — only the date-range/name filters (in the sidebar's
// View button) trigger a fresh fetch.
function refreshLeaderboardView() {
  const fullLeaderboard = buildLeaderboard(analyticsRows);
  const minEntries = document.getElementById("sa-filter-min-entries").value;
  let leaderboard = minEntries !== "" ? fullLeaderboard.filter((r) => r.entries >= Number(minEntries)) : fullLeaderboard;
  leaderboard = sortLeaderboard(leaderboard, document.getElementById("sa-sort").value, analyticsDaysInRange);
  analyticsLeaderboard = leaderboard;
  renderAnalyticsLeaderboard(leaderboard, analyticsDaysInRange);
}

async function runSadhanaAnalytics() {
  const from = document.getElementById("sa-from").value;
  const to = document.getElementById("sa-to").value;
  const nameSel = document.getElementById("sa-filter-name-select").value;

  let query = supabase.from("fnrg_sadhana").select("name,sadhana_date,rounds,book_reading,screen_time,detox_time,service,swadhyaya");
  if (from) query = query.gte("sadhana_date", from);
  if (to) query = query.lte("sadhana_date", to);
  if (nameSel && nameSel !== "__ALL__") query = query.eq("name", nameSel);

  const { data, error } = await query;
  if (error) {
    showToast("Could not load sadhana analytics.", "error");
    return;
  }
  analyticsRows = data || [];
  analyticsDaysInRange = daysBetweenInclusive(from, to);

  renderAnalyticsStats(analyticsRows, buildLeaderboard(analyticsRows));
  refreshLeaderboardView();
}

async function wireSadhanaAnalyticsFilters() {
  if (analyticsFiltersWired) return;
  analyticsFiltersWired = true;

  const d = new Date();
  d.setDate(d.getDate() - 30);
  document.getElementById("sa-from").value = localDateInput(d);
  document.getElementById("sa-to").value = todayLocalDate();

  const { data: names } = await supabase.from("fnrg_sadhana").select("name");
  const uniqueNames = Array.from(new Set((names || []).map((r) => r.name))).sort((a, b) => a.localeCompare(b));
  populateFilterSelect(document.getElementById("sa-filter-name-select"), uniqueNames);

  document.getElementById("sa-run-btn").addEventListener("click", runSadhanaAnalytics);
  document.getElementById("sa-sort").addEventListener("change", refreshLeaderboardView);
  document.getElementById("sa-filter-min-entries").addEventListener("input", debounce(refreshLeaderboardView, 200));
  document.getElementById("sa-export-btn").addEventListener("click", () => {
    exportTableToExcel(document.getElementById("sa-leaderboard-table"), "FNRG_Sadhana_Analytics.xlsx");
  });

  const detailModal = document.getElementById("sadhana-analytics-detail-modal");
  document.getElementById("sadhana-analytics-detail-close").onclick = () => detailModal.classList.remove("active");
  detailModal.addEventListener("click", (e) => { if (e.target === detailModal) detailModal.classList.remove("active"); });
}

export async function initSadhanaAnalytics() {
  await wireSadhanaAnalyticsFilters();
  await runSadhanaAnalytics();
}

/* ======================= USER: FNRG Sadhana (self-service) =======================
   The regular-user version of the module: a full-roster "Enter Sadhana" (same
   idea as the old admin roster — everyone from the users table, one row each,
   prefilled from any existing entry for the picked date) plus a personal
   Analytics view scoped to the logged-in user's own name only, with no way to
   select or see anyone else's data. Both live as two panels toggled in place
   inside fnrg-sadhana-user-section rather than separate routed pages.

   Enter Sadhana intentionally blocks submission (rather than silently
   skipping blank rows, like the old admin roster did) unless every single
   row has at least one field filled in — the point is a full daily roster
   sweep where nobody gets missed by accident. */

let fsuCurrentUser = null;
let fsuWired = false;
let fsuDateAlreadySubmitted = false;

function fsuSwitchPanel(target) {
  document.querySelectorAll("#fnrg-sadhana-user-tabs .admin-tab").forEach((t) => t.classList.toggle("active", t.dataset.target === target));
  document.querySelectorAll(".fsu-panel").forEach((p) => p.classList.toggle("hidden", p.id !== target));
}

function fsuNormName(n) {
  return String(n || "").trim().toLowerCase();
}

function fsuRowIsEmpty(row) {
  return Array.from(row.querySelectorAll(".sadhana-roster-input")).every((input) => input.value.trim() === "");
}

function updateFsuIncompleteCount() {
  const rows = document.querySelectorAll("#fsu-list .sadhana-roster-row");
  const incomplete = document.querySelectorAll("#fsu-list .sadhana-roster-row.sr-incomplete").length;
  const el = document.getElementById("fsu-incomplete-count");
  el.innerHTML = incomplete
    ? `<span class="stat-negative-text">${incomplete} of ${rows.length} people still need an entry</span>`
    : rows.length ? `All ${rows.length} people have an entry` : "";
}

function fsuRefreshRowState(row) {
  const empty = fsuRowIsEmpty(row);
  row.classList.toggle("sr-incomplete", empty);
  const dirty = Array.from(row.querySelectorAll(".sadhana-roster-input")).some((i) => i.value !== i.dataset.orig);
  row.classList.toggle("sr-dirty", dirty);
}

function fsuHasDirtyRows() {
  return document.querySelectorAll("#fsu-list .sadhana-roster-row.sr-dirty").length > 0;
}

function fsuApplySearch() {
  const term = document.getElementById("fsu-search").value.trim().toLowerCase();
  document.querySelectorAll("#fsu-list .sadhana-roster-row").forEach((row) => {
    row.classList.toggle("sr-hidden", !!term && !row.dataset.name.toLowerCase().includes(term));
  });
}

// Always rendered blank — the roster is a fresh sheet to fill in each time,
// never a display of what's already been submitted (for this user or
// anyone else). The matching existing record's id is still tracked on the
// row via data-id, purely so a save updates that row instead of creating a
// duplicate; its field values are never shown.
function fsuFieldCellHtml(field) {
  if (field === "service") return `<select class="sadhana-roster-input" data-field="service">${selectOptionsHtml(SERVICE_OPTIONS, null)}</select>`;
  if (field === "swadhyaya") return `<select class="sadhana-roster-input" data-field="swadhyaya">${selectOptionsHtml(SWADHYAYA_OPTIONS, null)}</select>`;
  return `<input class="sadhana-roster-input" type="number" min="0" step="any" inputmode="decimal" data-field="${field}" value="" />`;
}

function renderFsuRoster(users, existingByName) {
  const list = document.getElementById("fsu-list");
  if (!users.length) {
    list.innerHTML = `<p class="muted-text">No users found.</p>`;
    return;
  }
  const fields = ["rounds", "book_reading", "screen_time", "detox_time", "service", "swadhyaya"];
  list.innerHTML = users.map((u) => {
    const rec = existingByName.get(fsuNormName(u.user_name));
    return `
    <div class="sadhana-roster-row" data-name="${escapeHtml(u.user_name)}" data-id="${rec?.id || ""}">
      <span class="sadhana-roster-name" title="${escapeHtml(u.user_name)}">${escapeHtml(u.user_name)}</span>
      ${fields.map((f) => fsuFieldCellHtml(f)).join("")}
    </div>`;
  }).join("");

  list.querySelectorAll(".sadhana-roster-row").forEach((row) => {
    row.querySelectorAll(".sadhana-roster-input").forEach((input) => { input.dataset.orig = input.value; });
    fsuRefreshRowState(row);
    row.querySelectorAll(".sadhana-roster-input").forEach((input) => {
      input.addEventListener("input", () => { fsuRefreshRowState(row); updateFsuIncompleteCount(); });
      input.addEventListener("change", () => { fsuRefreshRowState(row); updateFsuIncompleteCount(); });
    });
  });
  fsuApplySearch();
  updateFsuIncompleteCount();
}

async function loadFsuRoster() {
  const list = document.getElementById("fsu-list");
  const summary = document.getElementById("fsu-summary");
  list.innerHTML = `<p class="loading-row">Loading…</p>`;
  summary.textContent = "Loading…";

  const date = document.getElementById("fsu-date").value || todayLocalDate();
  const [{ data: users, error: usersErr }, { data: existing, error: existingErr }] = await Promise.all([
    supabase.from("users").select("user_name").eq("sadhana_track", true).order("user_name"),
    supabase.from("fnrg_sadhana").select("id,name").eq("sadhana_date", date),
  ]);

  if (usersErr || existingErr) {
    list.innerHTML = `<p class="loading-row">Could not load the roster.</p>`;
    summary.textContent = "";
    return;
  }

  const roster = users || [];
  const existingByName = new Map();
  (existing || []).forEach((r) => {
    const key = fsuNormName(r.name);
    if (!existingByName.has(key)) existingByName.set(key, r);
  });

  renderFsuRoster(roster, existingByName);
  const filled = (existing || []).length;
  fsuDateAlreadySubmitted = filled > 0;
  summary.textContent = fsuDateAlreadySubmitted
    ? `Already submitted for this date (${filled} of ${roster.length} logged).`
    : `${roster.length} user(s) · nothing submitted yet for this date.`;
}

async function saveFsuRoster() {
  const date = document.getElementById("fsu-date").value;
  if (!date) {
    showToast("Please choose a date.", "error");
    return;
  }
  if (fsuDateAlreadySubmitted) {
    showToast("Already submitted for the selected date.", "error");
    return;
  }

  const rows = Array.from(document.querySelectorAll("#fsu-list .sadhana-roster-row"));
  const incomplete = rows.filter((row) => fsuRowIsEmpty(row));
  if (incomplete.length) {
    showToast(`Please fill in at least one field for every person before submitting — ${incomplete.length} still missing.`, "error");
    incomplete[0].scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const inserts = [];
  const updates = [];
  rows.forEach((row) => {
    // Only fields the user actually typed this time go in the payload — the
    // roster never shows what's already stored, so a field left blank must
    // NOT be sent as null and wipe out a value someone already submitted.
    const fields = {};
    row.querySelectorAll(".sadhana-roster-input").forEach((input) => {
      const raw = input.value.trim();
      if (raw === "") return;
      fields[input.dataset.field] = NUMBER_FIELDS.includes(input.dataset.field) ? Number(raw) : raw;
    });
    if (row.dataset.id) {
      updates.push({ id: row.dataset.id, fields });
    } else {
      inserts.push({ name: row.dataset.name, sadhana_date: date, added_by: fsuCurrentUser?.user_name || null, ...fields });
    }
  });

  const btn = document.getElementById("fsu-save-btn");
  btn.disabled = true;
  const results = await Promise.all([
    inserts.length ? supabase.from("fnrg_sadhana").insert(inserts) : Promise.resolve({ error: null }),
    ...updates.map((u) => supabase.from("fnrg_sadhana").update(u.fields).eq("id", u.id)),
  ]);
  btn.disabled = false;

  const failed = results.find((r) => r.error);
  if (failed) {
    showToast("Save failed: " + failed.error.message, "error");
    return;
  }
  showToast(`Submitted sadhana for ${rows.length} people`, "success");
  await loadFsuRoster();
}

function wireFsuEnterPanel() {
  const dateInput = document.getElementById("fsu-date");
  dateInput.value = todayLocalDate();
  dateInput.dataset.prevValue = dateInput.value;
  dateInput.addEventListener("change", (e) => {
    if (fsuHasDirtyRows() && !confirm("You have unsaved changes for the current date. Switch date anyway and discard them?")) {
      e.target.value = e.target.dataset.prevValue;
      return;
    }
    e.target.dataset.prevValue = e.target.value;
    loadFsuRoster();
  });

  document.getElementById("fsu-search").addEventListener("input", debounce(fsuApplySearch, 150));
  document.getElementById("fsu-refresh-btn").addEventListener("click", () => {
    if (fsuHasDirtyRows() && !confirm("Discard unsaved changes and refresh?")) return;
    loadFsuRoster();
  });
  document.getElementById("fsu-save-btn").addEventListener("click", saveFsuRoster);
}

function renderFsuAnalyticsStats(rows, daysInRange) {
  const roundsRows = rows.filter((r) => r.rounds != null);
  const totalRounds = roundsRows.reduce((s, r) => s + r.rounds, 0);
  const bookRows = rows.filter((r) => r.book_reading != null);
  const avgBook = avg(bookRows.reduce((s, r) => s + r.book_reading, 0), bookRows.length);
  const detoxRows = rows.filter((r) => r.detox_time != null);
  const avgDetox = avg(detoxRows.reduce((s, r) => s + r.detox_time, 0), detoxRows.length);

  document.getElementById("fsu-stat-entries").textContent = rows.length;
  document.getElementById("fsu-stat-consistency").textContent = daysInRange ? `${Math.round((rows.length / daysInRange) * 100)}%` : "—";
  document.getElementById("fsu-stat-rounds-total").textContent = totalRounds;
  document.getElementById("fsu-stat-rounds-avg").textContent = fmt1(avg(totalRounds, roundsRows.length));
  document.getElementById("fsu-stat-book-avg").textContent = fmt1(avgBook);
  document.getElementById("fsu-stat-detox-avg").textContent = fmt1(avgDetox);
}

// Stats only — deliberately no row-by-row entries table here. This is a
// summary view, not a history of what was previously submitted.
async function runFsuAnalytics() {
  const from = document.getElementById("fsu-from").value;
  const to = document.getElementById("fsu-to").value;
  const name = fsuCurrentUser?.user_name || "";

  let query = supabase.from("fnrg_sadhana").select("sadhana_date,rounds,book_reading,screen_time,detox_time").eq("name", name);
  if (from) query = query.gte("sadhana_date", from);
  if (to) query = query.lte("sadhana_date", to);

  const { data, error } = await query;
  if (error) {
    showToast("Could not load your sadhana analytics.", "error");
    return;
  }
  renderFsuAnalyticsStats(data || [], daysBetweenInclusive(from, to));
}

function wireFsuAnalyticsPanel() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  document.getElementById("fsu-from").value = localDateInput(d);
  document.getElementById("fsu-to").value = todayLocalDate();
  document.getElementById("fsu-analytics-run-btn").addEventListener("click", runFsuAnalytics);
}

export async function initFnrgSadhanaUser(currentUser) {
  fsuCurrentUser = currentUser;
  if (!fsuWired) {
    fsuWired = true;
    document.querySelectorAll("#fnrg-sadhana-user-tabs .admin-tab").forEach((tab) => {
      tab.addEventListener("click", () => fsuSwitchPanel(tab.dataset.target));
    });
    wireFsuEnterPanel();
    wireFsuAnalyticsPanel();
  }
  fsuSwitchPanel("fsu-enter-panel");
  await Promise.all([loadFsuRoster(), runFsuAnalytics()]);
}
