import { supabase } from "./supabaseClient.js";
import { showToast, escapeHtml, normalizePhoneInput, formatPhone, downloadExcel, copyToClipboard } from "./utils.js";
import { verifyAdminPassword } from "./expenses.js";

/* ======================= FOLK YATRAS (admin only) =======================
   A card per yatra (name + date) showing Participants / Coupons / Items Ready.
   Opening one shows a tab strip:
     Dashboard  — the participant roster (S.No, Name, Phone, Folk Guide,
                  Tokens), filled by hand or by uploading an Excel file whose
                  columns are mapped in a modal.
     Attendance — meal coupons: look a person up by phone, then mark their
                  one coupon or any number of extra plates for a date + meal.
     Disposables / Cooking / Serving Items — name, quantity, status.
     Feedback / Ideas — content, by.
   Everything lives in its own yatra_* tables, separate from Preaching data.
   The four table tabs share one renderer/add-modal driven by TABS below. */

const ITEM_STATUSES = ["Received", "Not Received", "Not Available"];
const MEALS = [["M", "Morning"], ["L", "Lunch"], ["D", "Dinner"]];

const ITEM_COLS = [
  { field: "name", label: "Name", type: "text", required: true },
  { field: "quantity", label: "Quantity", type: "number" },
  { field: "status", label: "Status", type: "select", options: ITEM_STATUSES, default: "Not Received" },
];

const TABS = {
  dashboard: {
    table: "yatra_participants",
    title: "Participant",
    order: "created_at",
    cols: [
      { field: "name", label: "Name", type: "text", required: true },
      { field: "phone", label: "Phone Number", type: "phone", required: true },
      { field: "folk_guide", label: "Folk Guide", type: "text" },
      // read-only: how many coupon entries this person has; the button opens them
      { field: "tokens", label: "Tokens", type: "tokenbtn", noAdd: true },
    ],
    searchFields: ["name", "phone", "folk_guide"],
    empty: "No participants yet — add some or upload an Excel file.",
  },
  disposables: { table: "yatra_items", kind: "disposable", title: "Disposable", order: "created_at", cols: ITEM_COLS, searchFields: ["name"], empty: "No disposables listed yet." },
  cooking: { table: "yatra_items", kind: "cooking", title: "Cooking / Serving Item", order: "created_at", cols: ITEM_COLS, searchFields: ["name"], empty: "No cooking / serving items listed yet." },
  feedback: {
    table: "yatra_feedback",
    title: "Feedback",
    order: "created_at",
    cols: [
      { field: "content", label: "Content", type: "text", required: true },
      { field: "author", label: "By", type: "text" },
    ],
    searchFields: ["content", "author"],
    empty: "No feedback or ideas yet.",
  },
};

let yatrasCache = [];
let currentYatra = null;
let currentTab = "dashboard";
let rowsCache = [];
let shellWired = false;
// Set when a Limited Admin opens one specific yatra page (e.g. "attendance"):
// the top nav already switches pages, so the in-page tab strip stays hidden.
let limitedTab = null;
let pendingTab = null;

const $ = (id) => document.getElementById(id);

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : dt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function defaultMeal() {
  const h = new Date().getHours();
  return h < 11 ? "M" : h < 17 ? "L" : "D";
}

// PostgREST caps a response at 1000 rows, and rosters can be bigger than that,
// so page through with .range() until a short page comes back. `build` must
// return a fresh query each call.
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().order("id").range(from, from + 999);
    if (error) return { data: null, error };
    out.push(...data);
    if (data.length < 1000) break;
  }
  return { data: out, error: null };
}

async function countRows(table, id, extra) {
  let q = supabase.from(table).select("id", { count: "exact", head: true }).eq("yatra_id", id);
  if (extra) q = extra(q);
  const { count } = await q;
  return count || 0;
}

/* ---------------- Yatra cards ---------------- */

async function loadYatraCards() {
  const grid = $("yatras-grid");
  grid.innerHTML = `<p class="loading-row">Loading…</p>`;

  const [{ data: yatras, error }, people, coupons, items] = await Promise.all([
    supabase.from("yatras").select("id,name,yatra_date,created_at").order("created_at", { ascending: false }),
    fetchAll(() => supabase.from("yatra_participants").select("id,yatra_id")),
    fetchAll(() => supabase.from("yatra_coupons").select("id,yatra_id")),
    fetchAll(() => supabase.from("yatra_items").select("id,yatra_id,status")),
  ]);
  if (error) {
    grid.innerHTML = `<p class="loading-row">Could not load yatras. Has the FOLK Yatras SQL been run?</p>`;
    return;
  }
  yatrasCache = yatras || [];

  const tally = (rows, pred = () => true) => {
    const m = {};
    (rows || []).forEach((r) => { if (pred(r)) m[r.yatra_id] = (m[r.yatra_id] || 0) + 1; });
    return m;
  };
  const people_n = tally(people.data);
  const coupons_n = tally(coupons.data);
  const items_n = tally(items.data);
  const items_ok = tally(items.data, (r) => r.status === "Received");

  if (!yatrasCache.length) {
    grid.innerHTML = `<p class="muted-text">No yatras yet — add one to get started.</p>`;
    return;
  }

  grid.innerHTML = yatrasCache.map((y) => `
    <div class="trip-event-card" data-id="${y.id}">
      <div class="trip-event-card-header">
        <div>
          <p class="trip-event-card-name">${escapeHtml(y.name)}</p>
          ${y.yatra_date ? `<p class="muted-text">${fmtDate(y.yatra_date)}</p>` : ""}
        </div>
        <button type="button" class="cell-chip danger yatra-delete-btn" title="Delete yatra">🗑</button>
      </div>
      <div class="trip-event-card-stats">
        <div class="stat"><span class="stat-num">${people_n[y.id] || 0}</span><span class="stat-label">Participants</span></div>
        <div class="stat"><span class="stat-num">${coupons_n[y.id] || 0}</span><span class="stat-label">Coupons</span></div>
        <div class="stat"><span class="stat-num">${items_ok[y.id] || 0}/${items_n[y.id] || 0}</span><span class="stat-label">Items Ready</span></div>
      </div>
    </div>
  `).join("");

  grid.querySelectorAll(".trip-event-card").forEach((card) => {
    card.addEventListener("click", () => openYatra(card.dataset.id));
  });
  grid.querySelectorAll(".yatra-delete-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteYatra(btn.closest(".trip-event-card").dataset.id);
    });
  });
}

async function deleteYatra(id) {
  const y = yatrasCache.find((x) => x.id === id);
  const [p, c, i, f] = await Promise.all([
    countRows("yatra_participants", id), countRows("yatra_coupons", id),
    countRows("yatra_items", id), countRows("yatra_feedback", id),
  ]);
  const warn = (p || c || i || f)
    ? ` This permanently deletes ${p} participant(s), ${c} coupon(s), ${i} item(s) and ${f} feedback entr${f === 1 ? "y" : "ies"} for this yatra.`
    : "";
  if (!confirm(`Delete yatra "${y?.name || ""}"?${warn} This cannot be undone.`)) return;
  if (!(await verifyAdminPassword())) return;

  const { error } = await supabase.from("yatras").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  showToast("Yatra deleted", "success");
  await loadYatraCards();
}

function showYatrasView() {
  $("yatras-list-view").classList.remove("hidden");
  $("yatras-detail-view").classList.add("hidden");
}

async function openYatra(id) {
  const y = yatrasCache.find((x) => x.id === id);
  if (!y) return;
  currentYatra = y;
  attDate = todayISO();
  attMeal = defaultMeal();
  $("yatras-list-view").classList.add("hidden");
  $("yatras-detail-view").classList.remove("hidden");
  $("yatra-detail-title").textContent = y.yatra_date ? `${y.name} · ${fmtDate(y.yatra_date)}` : y.name;
  const tab = pendingTab || "dashboard";
  pendingTab = null;
  await switchTab(tab);
}

/* ---------------- Tabs ---------------- */

async function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll("#yatra-tabs .admin-tab").forEach((t) => t.classList.toggle("active", t.dataset.ytab === tab));
  const isAtt = tab === "attendance";
  $("yatra-attendance-pane").classList.toggle("hidden", !isAtt);
  $("yatra-table-pane").classList.toggle("hidden", isAtt);
  $("yatra-sidebar").classList.toggle("hidden", isAtt);
  $("yatra-table-controls").classList.toggle("hidden", isAtt);
  $("yatra-stats").classList.toggle("hidden", tab !== "dashboard");
  $("yatra-upload-btn").classList.toggle("hidden", tab !== "dashboard");
  if (isAtt) renderAttendance();
  else {
    $("yatra-search").value = "";
    await loadTable();
  }
}

// Three clickable boxes (same look/behavior as Trip Expenses' budget box):
// each opens a popup listing the people behind that number. "Tokens" counts
// coupon entries (the same number as the button in each row).
function renderStats() {
  const tokens = rowsCache.reduce((sum, r) => sum + (r._tokens || 0), 0);
  const present = rowsCache.filter((r) => r._tokens > 0).length;
  $("yatra-stats").innerHTML = `
    <div class="stat cursor-pointer" data-stat="participants" title="Tap to view participants"><span class="stat-num">${rowsCache.length}</span><span class="stat-label">Participants</span></div>
    <div class="stat cursor-pointer" data-stat="tokens" title="Tap to view tokens"><span class="stat-num">${tokens}</span><span class="stat-label">Tokens</span></div>
    <div class="stat cursor-pointer" data-stat="present" title="Tap to view who has taken a token"><span class="stat-num">${present}</span><span class="stat-label">Taken Token</span></div>`;
}

let statPopup = null; // { filename, title, headers, rows } for the open popup's Download button

// One popup renderer for every list (stat boxes and per-person entries). A
// "Phone Number" column is click-to-copy.
function showListPopup(title, headers, rows, filenameBase) {
  statPopup = { filename: `${filenameBase.replace(/[^\w-]+/g, "_")}_${todayISO()}.xlsx`, title, headers, rows };
  $("yatra-stat-title").textContent = title;
  $("yatra-stat-thead").innerHTML = `<tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  $("yatra-stat-tbody").innerHTML = rows.length
    ? rows.map((r) => `<tr>${r.map((v, i) => headers[i] === "Phone Number"
        ? `<td data-label="${headers[i]}"><button type="button" class="cell-chip yatra-copy-phone" data-phone="${escapeHtml(String(v ?? ""))}" title="Tap to copy">${escapeHtml(formatPhone(v))}</button></td>`
        : `<td data-label="${headers[i]}">${escapeHtml(String(v ?? ""))}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${headers.length}" class="muted-text">Nothing here yet.</td></tr>`;
  $("yatra-stat-modal").classList.add("active");
}

function openStatPopup(kind) {
  const base = currentYatra.name || "Yatra";
  if (kind === "participants") {
    showListPopup("Participants", ["S.No", "Name", "Phone Number"], rowsCache.map((r, i) => [i + 1, r.name, r.phone]), `${base}_Participants`);
  } else if (kind === "tokens") {
    showListPopup("Tokens", ["S.No", "Name", "Phone Number", "Tokens"],
      rowsCache.filter((r) => r._tokens > 0).map((r, i) => [i + 1, r.name, r.phone, r._tokens]), `${base}_Tokens`);
  } else {
    showListPopup("Taken Token", ["S.No", "Name", "Phone Number"],
      rowsCache.filter((r) => r._tokens > 0).map((r, i) => [i + 1, r.name, r.phone]), `${base}_Taken_Token`);
  }
}

// A person's coupon entries (the popup behind the Tokens button in a row).
async function openTokenEntries(participantId) {
  const person = rowsCache.find((r) => r.id === participantId);
  const { data, error } = await fetchAll(() =>
    supabase.from("yatra_coupons").select("id,coupon_date,meal,kind,created_at").eq("participant_id", participantId));
  if (error) {
    showToast("Could not load entries: " + error.message, "error");
    return;
  }
  const mealName = Object.fromEntries(MEALS);
  const sorted = data.sort((a, b) => a.coupon_date.localeCompare(b.coupon_date) || a.created_at.localeCompare(b.created_at));
  const rows = sorted.map((c, i) => [
    i + 1, fmtDate(c.coupon_date), mealName[c.meal] || c.meal, c.kind === "regular" ? "Coupon" : "Extra",
    new Date(c.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
  ]);
  showListPopup(`${person?.name || ""} — Tokens`, ["S.No", "Date", "Meal", "Type", "Time"], rows, `${person?.name || "Person"}_Tokens`);
}

/* ---------------- Table tabs ---------------- */

function cellHtml(col, row) {
  const v = row[col.field];
  if (col.type === "tokenbtn") return `<button type="button" class="cell-chip info-link yatra-token-btn">${row._tokens || 0}</button>`;
  if (col.type === "select") {
    return `<select class="inline-edit" data-field="${col.field}">${col.options.map((o) => `<option${o === v ? " selected" : ""}>${o}</option>`).join("")}</select>`;
  }
  const t = col.type === "number" ? `type="number" min="0" step="any"` : "";
  return `<input class="inline-edit" ${t} data-field="${col.field}" value="${escapeHtml(v == null ? "" : String(v))}" />`;
}

async function loadTable() {
  const cfg = TABS[currentTab];
  const tbody = $("yatra-tbody");
  $("yatra-add-btn").textContent = `+ Add ${cfg.title}`;
  $("yatra-thead").innerHTML = `<tr><th>S.No</th>${cfg.cols.map((c) => `<th>${c.label}</th>`).join("")}<th></th></tr>`;
  tbody.innerHTML = `<tr><td colspan="${cfg.cols.length + 2}" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await fetchAll(() => {
    let q = supabase.from(cfg.table).select("*").eq("yatra_id", currentYatra.id);
    if (cfg.kind) q = q.eq("kind", cfg.kind);
    return q.order(cfg.order, { ascending: true });
  });
  if (error) {
    tbody.innerHTML = `<tr><td colspan="${cfg.cols.length + 2}" class="muted-text">Could not load: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  rowsCache = data;
  if (currentTab === "dashboard") {
    const coupons = await fetchAll(() => supabase.from("yatra_coupons").select("id,participant_id").eq("yatra_id", currentYatra.id));
    const n = {};
    (coupons.data || []).forEach((c) => { n[c.participant_id] = (n[c.participant_id] || 0) + 1; });
    rowsCache.forEach((r) => { r._tokens = n[r.id] || 0; });
  }
  renderRows();
  if (currentTab === "dashboard") renderStats();
}

function renderRows() {
  const cfg = TABS[currentTab];
  const tbody = $("yatra-tbody");
  const term = $("yatra-search").value.trim().toLowerCase();
  const rows = term
    ? rowsCache.filter((r) => cfg.searchFields.some((f) => String(r[f] || "").toLowerCase().includes(term)))
    : rowsCache;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${cfg.cols.length + 2}" class="muted-text">${term ? "No matches." : cfg.empty}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, i) => `
    <tr data-id="${r.id}">
      <td data-label="S.No">${i + 1}</td>
      ${cfg.cols.map((c) => `<td data-label="${c.label}">${cellHtml(c, r)}</td>`).join("")}
      <td data-label=""><button type="button" class="cell-chip danger yatra-row-delete">🗑 Delete</button></td>
    </tr>`).join("");

  tbody.querySelectorAll("[data-field]").forEach((el) => el.addEventListener("change", () => saveCell(el)));
  tbody.querySelectorAll(".yatra-token-btn").forEach((btn) => {
    btn.addEventListener("click", () => openTokenEntries(btn.closest("tr").dataset.id));
  });
  tbody.querySelectorAll(".yatra-row-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteRow(btn.closest("tr").dataset.id));
  });
}

// Converts a typed value to what the column stores; returns { error } for
// invalid input so inline edits and the Add modal share one set of rules.
function parseValue(col, raw) {
  raw = String(raw ?? "").trim();
  if (col.type === "phone") {
    if (!raw) return col.required ? { error: `${col.label} is required.` } : { value: null };
    const p = normalizePhoneInput(raw);
    return p.length === 10 ? { value: p } : { error: `${col.label} must be a 10-digit number.` };
  }
  if (col.required && !raw) return { error: `${col.label} is required.` };
  if (col.type === "number") {
    if (raw === "") return { value: null };
    const n = Number(raw);
    return Number.isNaN(n) ? { error: `${col.label} must be a number.` } : { value: n };
  }
  if (col.type === "select") return { value: raw || col.default || col.options[0] };
  return { value: raw || null };
}

function friendlyDbError(error) {
  return /duplicate|unique/i.test(error.message) ? "A participant with this phone number already exists in this yatra." : error.message;
}

async function saveCell(el) {
  const cfg = TABS[currentTab];
  const field = el.dataset.field;
  const col = cfg.cols.find((c) => c.field === field);
  const record = rowsCache.find((r) => r.id === el.closest("tr").dataset.id);
  const parsed = parseValue(col, el.value);
  if (parsed.error) {
    showToast(parsed.error, "error");
    el.value = record[field] ?? "";
    return;
  }
  const { error } = await supabase.from(cfg.table).update({ [field]: parsed.value }).eq("id", record.id);
  if (error) {
    showToast("Update failed: " + friendlyDbError(error), "error");
    el.value = record[field] ?? "";
    return;
  }
  record[field] = parsed.value;
  el.value = parsed.value ?? "";
}

async function deleteRow(id) {
  const warn = currentTab === "dashboard" ? " Their coupons will be deleted too." : "";
  if (!confirm(`Delete this entry?${warn} This cannot be undone.`)) return;
  const { error } = await supabase.from(TABS[currentTab].table).delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  rowsCache = rowsCache.filter((r) => r.id !== id);
  renderRows();
  if (currentTab === "dashboard") renderStats();
}

function downloadTable() {
  const cfg = TABS[currentTab];
  if (!rowsCache.length) {
    showToast("Nothing to download yet.", "error");
    return;
  }
  const rows = [["S.No", ...cfg.cols.map((c) => c.label)]];
  rowsCache.forEach((r, i) => rows.push([i + 1, ...cfg.cols.map((c) => (c.type === "tokenbtn" ? r._tokens || 0 : r[c.field] ?? ""))]));
  const label = { dashboard: "Participants", disposables: "Disposables", cooking: "Cooking_Serving", feedback: "Feedback" }[currentTab];
  const safe = (currentYatra.name || "Yatra").replace(/[^\w-]+/g, "_");
  downloadExcel(`${safe}_${label}_${todayISO()}.xlsx`, rows, label);
}

/* ---------------- Add (several rows at once) ---------------- */

function entryRowHtml(cfg) {
  const addCols = cfg.cols.filter((c) => !c.noAdd);
  const cells = addCols.map((c) => {
    if (c.type === "select") {
      return `<select data-ef="${c.field}">${c.options.map((o) => `<option${o === c.default ? " selected" : ""}>${o}</option>`).join("")}</select>`;
    }
    const type = c.type === "number" ? `type="number" min="0" step="any"` : c.type === "phone" ? `type="tel" inputmode="numeric"` : `type="text"`;
    return `<input data-ef="${c.field}" ${type} placeholder="${c.label}" />`;
  }).join("");
  return `<div class="yatra-entry-row" style="grid-template-columns: repeat(${addCols.length}, minmax(0, 1fr)) 32px">${cells}<button type="button" class="stock-row-remove cell-chip danger" title="Remove">✕</button></div>`;
}

function addEntryRow() {
  const wrap = $("yatra-entry-rows");
  wrap.insertAdjacentHTML("beforeend", entryRowHtml(TABS[currentTab]));
  const row = wrap.lastElementChild;
  row.querySelector(".stock-row-remove").addEventListener("click", () => {
    if (wrap.children.length > 1) row.remove();
  });
  row.querySelector("input, select")?.focus();
}

function openEntryModal() {
  const cfg = TABS[currentTab];
  $("yatra-entry-title").textContent = `Add ${cfg.title}s`;
  $("yatra-entry-rows").innerHTML = "";
  addEntryRow();
  $("yatra-entry-error").classList.add("hidden");
  $("yatra-entry-modal").classList.add("active");
}

async function saveEntries() {
  const cfg = TABS[currentTab];
  const errorEl = $("yatra-entry-error");
  const payloads = [];
  for (const row of $("yatra-entry-rows").children) {
    const inputs = [...row.querySelectorAll("[data-ef]")];
    // a row left completely blank is ignored rather than rejected, so the
    // spare row from "+ Add Row" doesn't block saving
    const blank = inputs.every((el) => el.tagName === "SELECT" || !el.value.trim());
    if (blank) continue;
    const payload = { yatra_id: currentYatra.id };
    if (cfg.kind) payload.kind = cfg.kind;
    for (const col of cfg.cols.filter((c) => !c.noAdd)) {
      const parsed = parseValue(col, row.querySelector(`[data-ef="${col.field}"]`).value);
      if (parsed.error) {
        errorEl.textContent = parsed.error;
        errorEl.classList.remove("hidden");
        return;
      }
      payload[col.field] = parsed.value;
    }
    payloads.push(payload);
  }
  if (!payloads.length) {
    errorEl.textContent = "Fill in at least one row.";
    errorEl.classList.remove("hidden");
    return;
  }
  if (currentTab === "dashboard") {
    const phones = payloads.map((p) => p.phone);
    if (new Set(phones).size !== phones.length) {
      errorEl.textContent = "The same phone number appears twice in this list.";
      errorEl.classList.remove("hidden");
      return;
    }
  }
  const { error } = await supabase.from(cfg.table).insert(payloads);
  if (error) {
    errorEl.textContent = friendlyDbError(error);
    errorEl.classList.remove("hidden");
    return;
  }
  $("yatra-entry-modal").classList.remove("active");
  showToast(`${payloads.length} added`, "success");
  await loadTable();
}

/* ---------------- Excel upload (Dashboard) ---------------- */

const IMPORT_FIELDS = [
  { field: "name", label: "Name", required: true, guess: /name/i },
  { field: "phone", label: "Phone Number", required: true, guess: /phone|mobile|contact|whats|number/i },
  { field: "folk_guide", label: "Folk Guide", guess: /guide|mentor/i },
];
let importSheet = null; // { headers: string[], rows: any[][] }

async function onImportFile(file) {
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
    const headers = (aoa[0] || []).map((h) => String(h).trim());
    const rows = aoa.slice(1).filter((r) => r.some((c) => String(c).trim() !== ""));
    if (!headers.some(Boolean) || !rows.length) {
      showToast("That file has no data rows.", "error");
      return;
    }
    importSheet = { headers, rows };
  } catch (e) {
    showToast("Could not read that file: " + e.message, "error");
    return;
  }

  const used = new Set();
  $("yatra-import-map").innerHTML = IMPORT_FIELDS.map((f) => {
    // pre-select the first not-yet-claimed header whose text looks right
    let pick = importSheet.headers.findIndex((h, i) => h && !used.has(i) && f.guess.test(h));
    if (pick >= 0) used.add(pick);
    const opts = [`<option value="-1">— skip —</option>`]
      .concat(importSheet.headers.map((h, i) => h ? `<option value="${i}"${i === pick ? " selected" : ""}>${escapeHtml(h)}</option>` : ""));
    return `<label class="field"><span>${f.label}${f.required ? " *" : ""}</span><select data-import-field="${f.field}">${opts.join("")}</select></label>`;
  }).join("");
  $("yatra-import-info").textContent = `${importSheet.rows.length} data row(s) found. Choose which column of the file holds each field.`;
  $("yatra-import-error").classList.add("hidden");
  $("yatra-import-modal").classList.add("active");
}

async function runImport() {
  const errorEl = $("yatra-import-error");
  const map = {};
  document.querySelectorAll("[data-import-field]").forEach((s) => { map[s.dataset.importField] = Number(s.value); });
  if (map.name < 0 || map.phone < 0) {
    errorEl.textContent = "Name and Phone Number must each be mapped to a column.";
    errorEl.classList.remove("hidden");
    return;
  }

  const btn = $("yatra-import-save-btn");
  btn.disabled = true;
  btn.textContent = "Importing…";
  try {
    const existing = await fetchAll(() => supabase.from("yatra_participants").select("id,phone").eq("yatra_id", currentYatra.id));
    if (existing.error) throw existing.error;
    const seen = new Set(existing.data.map((r) => r.phone));

    let skippedInvalid = 0, skippedDup = 0;
    const toInsert = [];
    for (const r of importSheet.rows) {
      const name = String(r[map.name] ?? "").trim();
      const phone = normalizePhoneInput(r[map.phone]);
      if (!name || phone.length !== 10) { skippedInvalid++; continue; }
      if (seen.has(phone)) { skippedDup++; continue; }
      seen.add(phone);
      toInsert.push({
        yatra_id: currentYatra.id,
        name,
        phone,
        folk_guide: map.folk_guide >= 0 ? (String(r[map.folk_guide] ?? "").trim() || null) : null,
      });
    }

    for (let i = 0; i < toInsert.length; i += 500) {
      const { error } = await supabase.from("yatra_participants").insert(toInsert.slice(i, i + 500));
      if (error) throw error;
    }
    $("yatra-import-modal").classList.remove("active");
    const notes = [];
    if (skippedDup) notes.push(`${skippedDup} already in the list`);
    if (skippedInvalid) notes.push(`${skippedInvalid} skipped (missing name or invalid phone)`);
    showToast(`Imported ${toInsert.length} participant(s)${notes.length ? " — " + notes.join(", ") : ""}`, "success", 6000);
    await loadTable();
  } catch (e) {
    errorEl.textContent = "Import failed: " + (e.message || e);
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Import";
  }
}

/* ---------------- Attendance (meal coupons) ---------------- */

let attDate = todayISO();
let attMeal = "M";
let attSlotRows = [];
let attPerson = null;

function renderAttendance() {
  const pane = $("yatra-attendance-pane");
  pane.innerHTML = `
    <div class="yatra-slot-bar">
      <button type="button" id="att-slot-btn" class="btn btn-secondary btn-sm" title="Change date / meal"></button>
    </div>
    <div class="panel">
      <label class="field"><span>Phone number</span>
        <input id="att-phone" type="tel" inputmode="numeric" autocomplete="off" placeholder="Type the 10-digit phone number" class="yatra-att-phone" />
      </label>
      <div id="att-result"></div>
    </div>
    <div class="stats-bar yatra-stats" id="att-stats"></div>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>S.No</th><th>Name</th><th>Phone Number</th><th>Type</th><th>Time</th><th></th></tr></thead>
        <tbody id="att-tbody"><tr><td colspan="6" class="loading-row">Loading…</td></tr></tbody>
      </table>
    </div>`;

  syncAttControls();
  $("att-slot-btn").onclick = openSlotModal;
  $("att-phone").addEventListener("input", onPhoneInput);
  loadSlot();
  $("att-phone").focus();
}

function syncAttControls() {
  const mealName = Object.fromEntries(MEALS)[attMeal];
  const btn = $("att-slot-btn");
  if (btn) btn.textContent = `📅 ${fmtDate(attDate)} · ${attMeal} (${mealName})`;
}

// the slot popup edits a draft; Done applies it
let slotDraft = null;
function paintSlotModal() {
  $("att-date").value = slotDraft.date;
  $("att-meal").querySelectorAll("[data-meal]").forEach((b) => {
    b.classList.toggle("btn-primary", b.dataset.meal === slotDraft.meal);
    b.classList.toggle("btn-secondary", b.dataset.meal !== slotDraft.meal);
  });
}
function openSlotModal() {
  slotDraft = { date: attDate, meal: attMeal };
  paintSlotModal();
  $("yatra-slot-modal").classList.add("active");
}

async function onSlotChanged() {
  await loadSlot();
  if (attPerson) showPerson();
}

async function loadSlot() {
  const { data, error } = await fetchAll(() =>
    supabase.from("yatra_coupons")
      .select("id,participant_id,kind,created_at,participant:yatra_participants(name,phone)")
      .eq("yatra_id", currentYatra.id).eq("coupon_date", attDate).eq("meal", attMeal));
  if (error) {
    $("att-tbody").innerHTML = `<tr><td colspan="6" class="muted-text">Could not load: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  attSlotRows = data.sort((a, b) => b.created_at.localeCompare(a.created_at));
  renderSlot();
}

function renderSlot() {
  const regular = attSlotRows.filter((r) => r.kind === "regular").length;
  const extra = attSlotRows.length - regular;
  $("att-stats").innerHTML = `
    <div class="stat"><span class="stat-num">${regular}</span><span class="stat-label">Coupons</span></div>
    <div class="stat"><span class="stat-num">${extra}</span><span class="stat-label">Extra Plates</span></div>
    <div class="stat stat-positive"><span class="stat-num">${attSlotRows.length}</span><span class="stat-label">Total Plates</span></div>`;

  const tbody = $("att-tbody");
  if (!attSlotRows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted-text">Nothing marked for this meal yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = attSlotRows.map((r, i) => `
    <tr data-id="${r.id}">
      <td data-label="S.No">${attSlotRows.length - i}</td>
      <td data-label="Name">${escapeHtml(r.participant?.name || "")}</td>
      <td data-label="Phone Number">${escapeHtml(formatPhone(r.participant?.phone))}</td>
      <td data-label="Type">${r.kind === "regular" ? "Coupon" : "Extra"}</td>
      <td data-label="Time">${new Date(r.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</td>
      <td data-label=""><button type="button" class="cell-chip danger att-delete">🗑 Undo</button></td>
    </tr>`).join("");
  tbody.querySelectorAll(".att-delete").forEach((btn) => btn.addEventListener("click", async () => {
    if (!confirm("Remove this entry?")) return;
    const { error } = await supabase.from("yatra_coupons").delete().eq("id", btn.closest("tr").dataset.id);
    if (error) { showToast("Delete failed: " + error.message, "error"); return; }
    await onSlotChanged();
  }));
}

async function onPhoneInput(e) {
  const phone = normalizePhoneInput(e.target.value);
  const result = $("att-result");
  attPerson = null;
  if (phone.length < 10) {
    result.innerHTML = "";
    return;
  }
  result.innerHTML = `<p class="loading-row">Looking up…</p>`;
  const { data, error } = await supabase.from("yatra_participants")
    .select("id,name,phone,folk_guide").eq("yatra_id", currentYatra.id).eq("phone", phone).maybeSingle();
  // the field may have changed while the request was in flight
  if (normalizePhoneInput($("att-phone").value) !== phone) return;
  if (error) {
    result.innerHTML = `<p class="field-error">${escapeHtml(error.message)}</p>`;
    return;
  }
  if (!data) {
    result.innerHTML = `<p class="field-error">No participant with this number in this yatra.</p>`;
    return;
  }
  attPerson = data;
  attPerson.usedTotal = await countRows("yatra_coupons", currentYatra.id, (q) => q.eq("participant_id", data.id));
  showPerson();
}

function showPerson() {
  const p = attPerson;
  const mine = attSlotRows.filter((r) => r.participant_id === p.id);
  const hasRegular = mine.some((r) => r.kind === "regular");
  const extras = mine.length - (hasRegular ? 1 : 0);
  $("att-result").innerHTML = `
    <div class="yatra-person-card">
      <div class="yatra-person-info">
        <p class="yatra-person-name">${escapeHtml(p.name)}</p>
        <p class="muted-text">📞 ${escapeHtml(formatPhone(p.phone))}${p.folk_guide ? ` · Folk Guide: ${escapeHtml(p.folk_guide)}` : ""}</p>
        <p class="muted-text">Tokens taken so far (all meals): <strong>${p.usedTotal}</strong></p>
        <p class="muted-text">This meal: ${hasRegular ? "✅ coupon marked" : "coupon not marked yet"}${extras ? ` · ${extras} extra plate(s)` : ""}</p>
      </div>
      <div class="yatra-person-actions">
        <button id="att-mark-btn" class="btn btn-primary" ${hasRegular ? "disabled" : ""}>${hasRegular ? "Coupon Marked" : "Mark Coupon"}</button>
        <div class="yatra-extra-row">
          <input id="att-extra-count" type="number" min="1" max="50" value="1" title="Number of extra plates" />
          <button id="att-extra-btn" class="btn btn-secondary">Mark Extra Coupon</button>
        </div>
      </div>
    </div>`;
  $("att-mark-btn").onclick = () => markCoupons("regular", 1);
  $("att-extra-btn").onclick = () => {
    const n = Math.floor(Number($("att-extra-count").value));
    if (!(n >= 1 && n <= 50)) { showToast("Enter a number of plates between 1 and 50.", "error"); return; }
    markCoupons("extra", n);
  };
}

async function markCoupons(kind, count) {
  const p = attPerson;
  if (!p) return;
  const rows = Array.from({ length: count }, () => ({
    yatra_id: currentYatra.id, participant_id: p.id, coupon_date: attDate, meal: attMeal, kind,
  }));
  const { error } = await supabase.from("yatra_coupons").insert(rows);
  if (error) {
    // the partial unique index is what enforces "once per meal" — a second
    // device (or a stale screen) lands here rather than double-marking
    showToast(/duplicate|unique/i.test(error.message) ? "Coupon already marked for this meal." : "Failed: " + error.message, "error");
    await onSlotChanged();
    return;
  }
  showToast(kind === "regular" ? `Coupon marked for ${p.name}` : `${count} extra plate${count > 1 ? "s" : ""} marked for ${p.name}`, "success");
  attPerson = null;
  const phone = $("att-phone");
  phone.value = "";
  $("att-result").innerHTML = "";
  await loadSlot();
  phone.focus();
}

/* ---------------- Shell wiring ---------------- */

function wireShell() {
  const addModal = $("yatra-modal");
  const nameInput = $("yatra-name");
  const dateInput = $("yatra-date");
  const errorEl = $("yatra-error");

  $("add-yatra-btn").onclick = () => {
    nameInput.value = "";
    dateInput.value = "";
    errorEl.classList.add("hidden");
    addModal.classList.add("active");
  };
  $("yatra-cancel-btn").onclick = () => addModal.classList.remove("active");
  addModal.addEventListener("click", (e) => { if (e.target === addModal) addModal.classList.remove("active"); });
  $("yatra-save-btn").onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      errorEl.textContent = "Please enter a name for this yatra.";
      errorEl.classList.remove("hidden");
      return;
    }
    const { error } = await supabase.from("yatras").insert({ name, yatra_date: dateInput.value || null });
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    addModal.classList.remove("active");
    showToast("Yatra added", "success");
    await loadYatraCards();
  };

  const entryModal = $("yatra-entry-modal");
  $("yatra-add-btn").onclick = openEntryModal;
  $("yatra-download-btn").onclick = downloadTable;
  $("yatra-entry-add-row-btn").onclick = addEntryRow;
  $("yatra-entry-cancel-btn").onclick = () => entryModal.classList.remove("active");
  entryModal.addEventListener("click", (e) => { if (e.target === entryModal) entryModal.classList.remove("active"); });
  $("yatra-entry-save-btn").onclick = saveEntries;

  const fileInput = $("yatra-import-file");
  $("yatra-upload-btn").onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const f = fileInput.files[0];
    fileInput.value = "";
    if (f) onImportFile(f);
  };
  const importModal = $("yatra-import-modal");
  $("yatra-import-cancel-btn").onclick = () => importModal.classList.remove("active");
  importModal.addEventListener("click", (e) => { if (e.target === importModal) importModal.classList.remove("active"); });
  $("yatra-import-save-btn").onclick = runImport;

  $("yatra-search").addEventListener("input", renderRows);
  const slotModal = $("yatra-slot-modal");
  $("att-date").addEventListener("change", (e) => { if (e.target.value) slotDraft.date = e.target.value; });
  $("att-meal").querySelectorAll("[data-meal]").forEach((b) => b.addEventListener("click", () => {
    slotDraft.meal = b.dataset.meal;
    paintSlotModal();
  }));
  $("yatra-slot-done-btn").onclick = () => {
    attDate = slotDraft.date;
    attMeal = slotDraft.meal;
    slotModal.classList.remove("active");
    syncAttControls();
    onSlotChanged();
  };
  $("yatra-slot-cancel-btn").onclick = () => slotModal.classList.remove("active");
  slotModal.addEventListener("click", (e) => { if (e.target === slotModal) slotModal.classList.remove("active"); });

  const statModal = $("yatra-stat-modal");
  $("yatra-stats").addEventListener("click", (e) => {
    const box = e.target.closest("[data-stat]");
    if (box) openStatPopup(box.dataset.stat);
  });
  $("yatra-stat-tbody").addEventListener("click", (e) => {
    const btn = e.target.closest(".yatra-copy-phone");
    if (btn) copyToClipboard(btn.dataset.phone, btn);
  });
  $("yatra-stat-close-btn").onclick = () => statModal.classList.remove("active");
  statModal.addEventListener("click", (e) => { if (e.target === statModal) statModal.classList.remove("active"); });
  $("yatra-stat-download-btn").onclick = () => {
    if (!statPopup?.rows.length) { showToast("Nothing to download yet.", "error"); return; }
    downloadExcel(statPopup.filename, [statPopup.headers, ...statPopup.rows], statPopup.title.slice(0, 31));
  };
  $("yatra-back-btn").onclick = () => {
    showYatrasView();
    loadYatraCards();
  };
  document.querySelectorAll("#yatra-tabs .admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.ytab));
  });
}

// opts.tab is set only for a Limited Admin landing on one specific yatra page.
// Switching between their pages keeps the yatra they already opened.
export const initYatras = async (user, opts = {}) => {
  if (!shellWired) {
    shellWired = true;
    wireShell();
  }
  limitedTab = opts.tab || null;
  $("yatra-tabs").classList.toggle("hidden", !!limitedTab);
  if (limitedTab && currentYatra && !$("yatras-detail-view").classList.contains("hidden")) {
    await switchTab(limitedTab);
    return;
  }
  pendingTab = limitedTab;
  showYatrasView();
  await loadYatraCards();
};
