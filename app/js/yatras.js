import { supabase } from "./supabaseClient.js";
import { showToast, escapeHtml, normalizePhoneInput, formatPhone, copyToClipboard, initColumnDragReorder, reapplyColumnOrder, initHorizontalScroll } from "./utils.js";

/* ======================= FOLK YATRAS (admin only) =======================
   A card per yatra (name) showing Total Participants / Prasadam Served / Not Served.
   Opening one shows a tab strip:
     Dashboard  — the participant roster (S.No, Name, Phone, Folk Guide,
                  Tokens), filled by hand or by uploading an Excel file whose
                  columns are mapped in a modal.
     Attendance — meal coupons: look a person up by phone, then mark their
                  one coupon or any number of extra plates for a date + meal.
     Disposables / Cooking / Serving Items — name, quantity, (unit,) status.
     Feedback / Ideas — content, by.
   Everything lives in its own yatra_* tables, separate from Preaching data.
   The four table tabs share one renderer/add-modal driven by TABS below. */

const ITEM_STATUSES = ["Received", "Not Received", "Not Available"];
// "M" is the stored code for breakfast (rows already use it); screens show B.
const MEALS = [["M", "Breakfast"], ["L", "Lunch"], ["S", "Snacks"], ["D", "Dinner"]];
const mealShort = (m) => (m === "M" ? "B" : m);

const ITEM_UNITS = ["Number", "Pieces", "Packets", "Bags", "Liter", "Kg", "Gm"];

// `grid` is the column's track in the Add modal: Name takes the leftover
// space, the short fields get just enough room for their values.
const ITEM_COLS = [
  { field: "name", label: "Name", type: "text", required: true, grid: "minmax(0, 1fr)" },
  { field: "quantity", label: "Quantity", type: "number", grid: "64px" },
  { field: "status", label: "Status", type: "select", options: ITEM_STATUSES, default: "Not Received", grid: "140px" },
];
// Disposables and Cooking / Serving items share the same columns incl. Unit
const ITEM_COLS_WITH_UNIT = [
  ...ITEM_COLS.slice(0, 2),
  { field: "unit", label: "Unit", type: "select", options: ITEM_UNITS, default: "Number", grid: "100px" },
  ITEM_COLS[2],
];

const FEEDBACK_CATEGORIES = ["Food / Prasadam", "Accommodation", "Transport", "Program / Schedule", "Management", "Facilities", "Other"];

// Prasadam Details: one row per meal order. Total Cost and Balance are worked
// out from the other columns (type "calc"), never stored.
const PRASADAM_COLS = [
  { field: "meal_date", label: "Date", type: "date", required: true },
  { field: "meal_type", label: "Type", type: "select", options: MEALS.map((m) => m[1]), required: true, placeholder: "Select type" },
  { field: "for_how_many", label: "For How Many", type: "number" },
  { field: "menu", label: "Menu", type: "points" },
  { field: "vendor", label: "Vendor", type: "text" },
  { field: "delivery_location", label: "Delivery Location", type: "text" },
  { field: "delivery_time", label: "Delivery Time", type: "time" },
  { field: "packing_method", label: "Packing Method", type: "text" },
  { field: "serving_location", label: "Serving Location", type: "text" },
  { field: "cost_per_plate", label: "Cost per Plate", type: "number" },
  { field: "total_cost", label: "Total Cost", type: "calc", noAdd: true },
  { field: "advance_payment", label: "Advance Payment", type: "number" },
  { field: "balance", label: "Balance", type: "calc", noAdd: true },
  { field: "remarks", label: "Remarks", type: "text" },
];

// Menu cells are a numbered list: one point per line ("1) Rice", "2) Dal"…).
// A long point just wraps; Enter starts the next point.
const POINT_RE = /^\s*\d+\s*[).]\s*/;
function numberPoints(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.replace(POINT_RE, "").trim()).filter(Boolean);
  return lines.map((l, i) => `${i + 1}) ${l}`).join("\n");
}

// Enter adds the next numbered point; Backspace on an empty point removes it.
function wirePoints(el) {
  const renumber = (lineIdx, offsetInLine = null) => {
    const lines = el.value.split("\n").map((l) => l.replace(POINT_RE, ""));
    el.value = lines.map((l, i) => `${i + 1}) ${l}`).join("\n");
    if (lineIdx != null) {
      const before = el.value.split("\n").slice(0, lineIdx).reduce((n, l) => n + l.length + 1, 0);
      const prefix = `${lineIdx + 1}) `.length;
      const pos = before + prefix + (offsetInLine ?? lines[lineIdx].length);
      el.setSelectionRange(pos, pos);
    }
    el.dispatchEvent(new Event("input"));
  };
  el.addEventListener("focus", () => { if (!el.value.trim()) { el.value = "1) "; el.setSelectionRange(3, 3); } });
  el.addEventListener("blur", () => { if (!numberPoints(el.value)) el.value = ""; });
  el.addEventListener("keydown", (e) => {
    const lineStart = el.value.lastIndexOf("\n", el.selectionStart - 1) + 1;
    const lineIdx = el.value.slice(0, el.selectionStart).split("\n").length - 1;
    if (e.key === "Enter") {
      e.preventDefault();
      // split the current point at the caret; the tail becomes the next point
      const lines = el.value.split("\n");
      const cur = lines[lineIdx].replace(POINT_RE, "");
      const prefixLen = lines[lineIdx].length - cur.length;
      const at = Math.max(0, el.selectionStart - lineStart - prefixLen);
      if (!cur.trim()) return; // an empty point: don't add another
      lines.splice(lineIdx, 1, cur.slice(0, at).trimEnd(), cur.slice(at).trimStart());
      el.value = lines.join("\n");
      renumber(lineIdx + 1, 0);
    } else if (e.key === "Backspace" && el.selectionStart === el.selectionEnd) {
      const line = el.value.split("\n")[lineIdx];
      const prefixLen = line.length - line.replace(POINT_RE, "").length;
      if (prefixLen && el.selectionStart - lineStart <= prefixLen) {
        e.preventDefault();
        const lines = el.value.split("\n");
        const rest = lines[lineIdx].replace(POINT_RE, "");
        if (lineIdx === 0) { if (!rest) el.value = ""; return; }
        // join this point onto the end of the previous one
        const prev = lines[lineIdx - 1].replace(POINT_RE, "");
        lines.splice(lineIdx - 1, 2, prev + rest);
        el.value = lines.join("\n");
        renumber(lineIdx - 1, prev.length);
      }
    }
  });
}

const calcValue = (field, r) => {
  const total = (Number(r.for_how_many) || 0) * (Number(r.cost_per_plate) || 0);
  const v = field === "total_cost" ? total : total - (Number(r.advance_payment) || 0);
  return Math.round(v * 100) / 100;
};

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
      // read-only: flags people added on the spot from Attendance (not in the uploaded list)
      { field: "is_new", label: "Added", type: "newtag", noAdd: true },
    ],
    searchFields: ["name", "phone", "folk_guide"],
    empty: "No participants yet — add some or upload an Excel file.",
  },
  prasadam: {
    table: "yatra_prasadam",
    title: "Prasadam Detail",
    order: "meal_date",
    form: true,
    cols: PRASADAM_COLS,
    searchFields: ["meal_type", "menu", "vendor", "delivery_location", "packing_method", "serving_location", "remarks"],
    empty: "No prasadam details yet.",
  },
  disposables: { table: "yatra_items", kind: "disposable", title: "Disposable", order: "created_at", cols: ITEM_COLS_WITH_UNIT, searchFields: ["name"], empty: "No disposables listed yet." },
  cooking: { table: "yatra_items", kind: "cooking", title: "Cooking / Serving Item", order: "created_at", cols: ITEM_COLS_WITH_UNIT, searchFields: ["name"], empty: "No cooking / serving items listed yet." },
  feedback: {
    table: "yatra_feedback",
    title: "Feedback",
    order: "created_at",
    cols: [
      { field: "content", label: "Feedback / Ideas", type: "longtext", required: true },
      { field: "author", label: "Name", type: "text", required: true, grid: "minmax(0, 1fr)" },
      { field: "category", label: "Category", type: "select", options: FEEDBACK_CATEGORIES, required: true, placeholder: "Select category", grid: "190px" },
    ],
    searchFields: ["content", "author", "category"],
    empty: "No feedback or ideas yet.",
  },
};

let yatrasCache = [];
let currentYatra = null;
let currentTab = "dashboard";
let rowsCache = [];
let yatraOrderEnabled = true; // false until the yatras `position` column exists
let rowOrderEnabled = true; // false until the `position` column exists
let shellWired = false;
// Set when a Limited Admin opens one specific yatra page (e.g. "attendance"):
// the top nav already switches pages, so the in-page tab strip stays hidden.
let limitedTab = null;
let sessionUser = null;
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
  return h < 11 ? "M" : h < 16 ? "L" : h < 18 ? "S" : "D";
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

  // served / not served follow the date + meal last picked on a yatra's dashboard
  // Cards can be dragged into a custom order (the `position` column); never-moved
  // yatras sort last, newest first. Without the column (yatra-order.sql not run)
  // fall back to plain newest-first.
  const loadYatras = async () => {
    const r = await supabase.from("yatras").select("id,name,created_at,position")
      .order("position", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false });
    yatraOrderEnabled = !r.error;
    return r.error ? supabase.from("yatras").select("id,name,created_at").order("created_at", { ascending: false }) : r;
  };
  const [{ data: yatras, error }, people, coupons] = await Promise.all([
    loadYatras(),
    fetchAll(() => supabase.from("yatra_participants").select("id,yatra_id")),
    fetchAll(() => supabase.from("yatra_coupons").select("id,yatra_id").eq("coupon_date", attDate).eq("meal", attMeal)),
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
  const served_n = tally(coupons.data);

  if (!yatrasCache.length) {
    grid.innerHTML = `<p class="muted-text">No yatras yet — add one to get started.</p>`;
    return;
  }

  grid.innerHTML = yatrasCache.map((y) => `
    <div class="trip-event-card" data-id="${y.id}">
      <div class="trip-event-card-header">
        <div>
          <p class="trip-event-card-name">${escapeHtml(y.name)}</p>
          <p class="muted-text">${slotLabel(attDate, attMeal)}</p>
        </div>
        <span class="yatra-card-actions">
          ${yatraOrderEnabled && yatrasCache.length > 1 ? `<span class="yatra-card-handle" title="Drag to reorder">⠿</span>` : ""}
          <button type="button" class="cell-chip danger yatra-delete-btn" title="Delete yatra">🗑</button>
        </span>
      </div>
      <div class="trip-event-card-stats">
        <div class="stat"><span class="stat-num">${people_n[y.id] || 0}</span><span class="stat-label">Total Participants</span></div>
        <div class="stat"><span class="stat-num">${served_n[y.id] || 0}</span><span class="stat-label">Prasadam Served</span></div>
        <div class="stat"><span class="stat-num">${Math.max(0, (people_n[y.id] || 0) - (served_n[y.id] || 0))}</span><span class="stat-label">Prasadam Not Served</span></div>
      </div>
    </div>
  `).join("");

  grid.querySelectorAll(".yatra-card-handle").forEach((h) => {
    h.addEventListener("click", (e) => e.stopPropagation());
    h.addEventListener("pointerdown", startCardDrag);
  });
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

// Pointer-based drag (mouse and touch): the card follows the pointer through the
// grid; on release every card's `position` is saved in the new order.
function startCardDrag(e) {
  e.preventDefault();
  e.stopPropagation();
  const grid = $("yatras-grid");
  const card = e.currentTarget.closest(".trip-event-card");
  card.classList.add("yatra-card-dragging");
  const onMove = (ev) => {
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("#yatras-grid .trip-event-card");
    if (!over || over === card) return;
    const r = over.getBoundingClientRect();
    // cards sit in rows and columns: left/top half of the target puts the card before it
    const before = Math.abs(ev.clientY - (r.top + r.height / 2)) > r.height / 4 ? ev.clientY < r.top + r.height / 2 : ev.clientX < r.left + r.width / 2;
    grid.insertBefore(card, before ? over : over.nextSibling);
  };
  const onUp = async () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    card.classList.remove("yatra-card-dragging");
    const ids = Array.from(grid.querySelectorAll(".trip-event-card")).map((c) => c.dataset.id);
    if (ids.join() === yatrasCache.map((y) => y.id).join()) return;
    const results = await Promise.all(ids.map((id, i) => supabase.from("yatras").update({ position: i + 1 }).eq("id", id)));
    if (results.some((r) => r.error)) {
      showToast("Could not save the order: " + results.find((r) => r.error).error.message, "error");
      await loadYatraCards();
      return;
    }
    const byId = new Map(yatrasCache.map((y) => [y.id, y]));
    yatrasCache = ids.map((id, i) => Object.assign(byId.get(id), { position: i + 1 }));
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
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
  // the delete is authorised by a one-time code emailed to the owner, not a password
  const call = async (payload) => {
    const res = await fetch("/api/yatra-delete-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yatra_id: id, user_name: sessionUser?.user_name, login_pw: sessionUser?.login_pw, ...payload }),
    });
    let out = {};
    try { out = await res.json(); } catch { /* non-JSON: no API behind this host */ }
    if (!res.ok || !out.ok) throw new Error(out.error || "Deleting needs the deployed app (no mail server here).");
    return out;
  };
  let token;
  try {
    showToast("Sending OTP…", "info");
    ({ token } = await call({ action: "send" }));
  } catch (e) {
    showToast("Could not send OTP: " + (e.message || e), "error");
    return;
  }
  const otp = prompt("An OTP was emailed to snkdasa@gmail.com. Enter it to delete this yatra (valid for 5 minutes):");
  if (otp === null) return;
  try {
    await call({ action: "confirm", otp: otp.trim(), token });
  } catch (e) {
    showToast(e.message || String(e), "error");
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
  $("yatra-detail-title").textContent = y.name;
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
  $("yatra-served-filter").classList.toggle("hidden", tab !== "dashboard");
  $("yatra-served-filter").value = "all";
  if (isAtt) renderAttendance();
  else {
    $("yatra-search").value = "";
    await loadTable();
  }
}

// Three clickable boxes (same look/behavior as Trip Expenses' budget box).
// They describe ONE meal — the date + meal picked in Attendance (the button
// above them changes it): total participants, plates served in that meal, and
// the participants who have no coupon for it. Each opens the list behind it.
let couponsCache = []; // every coupon of this yatra: { participant_id, coupon_date, meal }

// "20 Oct 2026 - Lunch"
function slotLabel(date, meal) {
  return `${fmtDate(date)} - ${Object.fromEntries(MEALS)[meal]}`;
}

function applySlotCounts() {
  const n = {};
  couponsCache.forEach((c) => { if (c.coupon_date === attDate && c.meal === attMeal) n[c.participant_id] = (n[c.participant_id] || 0) + 1; });
  rowsCache.forEach((r) => { r._slot = n[r.id] || 0; });
}

function renderStats() {
  applySlotCounts();
  const served = rowsCache.reduce((sum, r) => sum + r._slot, 0);
  // plates, not people: total participants minus plates served (extras can push it below 0)
  const notServed = Math.max(0, rowsCache.length - served);
  const mealName = Object.fromEntries(MEALS)[attMeal];
  $("yatra-stats").innerHTML = `
    <div class="yatra-stats-slot"><button type="button" id="dash-slot-btn" class="btn btn-secondary btn-sm" title="Change date / meal">📅 ${fmtDate(attDate)} · ${mealShort(attMeal)} (${mealName})</button></div>
    <div class="stat cursor-pointer" data-stat="participants" title="Tap to view participants"><span class="stat-num">${rowsCache.length}</span><span class="stat-label">Total Participants</span></div>
    <div class="stat cursor-pointer" data-stat="tokens" title="Tap to view who was served prasadam"><span class="stat-num">${served}</span><span class="stat-label">Prasadam Served</span></div>
    <div class="stat cursor-pointer" data-stat="notserved" title="Tap to view who has not been served"><span class="stat-num">${notServed}</span><span class="stat-label">Prasadam Not Served</span></div>`;
  $("dash-slot-btn").onclick = openSlotModal;
}

let statPopup = null; // { filename, title, headers, rows } for the open popup's Download button

// One popup renderer for every list (stat boxes and per-person entries). A
// "Phone Number" column is click-to-copy. `key` names the popup so each kind
// remembers its own dragged column order.
function showListPopup(title, headers, rows, filenameBase, key) {
  // the three stat lists describe the selected date + meal; a person's own entries don't
  statPopup = { filename: `${safeName(filenameBase)}_${todayISO()}.xlsx`, title: `${currentYatra.name} — ${title}`, subtitle: key === "person" ? "" : slotLabel(attDate, attMeal), headers, rows };
  $("yatra-stat-title").textContent = title;
  $("yatra-stat-thead").innerHTML = `<tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  $("yatra-stat-tbody").innerHTML = rows.length
    ? rows.map((r) => `<tr>${r.map((v, i) => headers[i] === "Phone Number"
        ? `<td data-label="${headers[i]}"><button type="button" class="cell-chip yatra-copy-phone" data-phone="${escapeHtml(String(v ?? ""))}" title="Tap to copy">${escapeHtml(formatPhone(v))}</button></td>`
        : `<td data-label="${headers[i]}">${escapeHtml(String(v ?? ""))}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${headers.length}" class="muted-text">Nothing here yet.</td></tr>`;
  initColumnDragReorder("yatra-stat-table", { force: true, storageKey: `nrg-col-order:yatra-stat:${key}` });
  $("yatra-stat-modal").classList.add("active");
}

function openStatPopup(kind) {
  const base = currentYatra.name || "Yatra";
  // ordered by Folk Guide (A→Z), then name; people without a guide go last
  const byGuide = (list) => [...list].sort((x, y) => {
    const gx = (x.folk_guide || "").trim(), gy = (y.folk_guide || "").trim();
    if (!gx !== !gy) return gx ? -1 : 1;
    return gx.localeCompare(gy, undefined, { sensitivity: "base" }) || (x.name || "").localeCompare(y.name || "", undefined, { sensitivity: "base" });
  });
  if (kind === "participants") {
    showListPopup("Total Participants", ["S.No", "Name", "Phone Number", "Folk Guide", "Status"],
      byGuide(rowsCache).map((r, i) => [i + 1, r.name, r.phone, r.folk_guide || "", r._slot ? "Served" : "Not Served"]), `${base}_Total_Participants`, kind);
  } else if (kind === "tokens") {
    showListPopup("Prasadam Served", ["S.No", "Name", "Phone Number", "Folk Guide", "Tokens"],
      byGuide(rowsCache.filter((r) => r._slot > 0)).map((r, i) => [i + 1, r.name, r.phone, r.folk_guide || "", r._slot]), `${base}_Prasadam_Served`, kind);
  } else {
    showListPopup("Prasadam Not Served", ["S.No", "Name", "Phone Number", "Folk Guide"],
      byGuide(rowsCache.filter((r) => !r._slot)).map((r, i) => [i + 1, r.name, r.phone, r.folk_guide || ""]), `${base}_Prasadam_Not_Served`, kind);
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
  showListPopup(`${person?.name || ""} — Prasadam Count`, ["S.No", "Date", "Meal", "Type", "Time"], rows, `${person?.name || "Person"}_Tokens`, "person");
}

/* ---------------- Table tabs ---------------- */

function cellHtml(col, row) {
  const v = row[col.field];
  if (col.type === "tokenbtn") return `<button type="button" class="cell-chip info-link yatra-token-btn">${row._tokens || 0}</button>`;
  if (col.type === "newtag") return v ? `<span class="cell-chip yatra-new-tag">🆕 New</span>` : "";
  if (col.type === "select") {
    const blank = col.required && !v ? `<option value="" selected>${col.placeholder || "—"}</option>` : "";
    return `<select class="inline-edit" data-field="${col.field}">${blank}${col.options.map((o) => `<option${o === v ? " selected" : ""}>${o}</option>`).join("")}</select>`;
  }
  if (col.type === "calc") return `<span class="yatra-calc" data-calc="${col.field}">${calcValue(col.field, row)}</span>`;
  const t = col.type === "number" ? `type="number" min="0" step="any"` : col.type === "date" ? `type="date"` : col.type === "time" ? `type="time"` : "";
  // long names wrap onto a second line instead of being cut off (item / feedback tabs)
  if (col.type === "points") {
    return `<textarea class="inline-edit yatra-wrap-edit yatra-points-edit" rows="1" data-field="${col.field}">${escapeHtml(numberPoints(v))}</textarea>`;
  }
  if ((col.type === "text" || col.type === "longtext") && currentTab !== "dashboard") {
    return `<textarea class="inline-edit yatra-wrap-edit" rows="1" data-field="${col.field}">${escapeHtml(v == null ? "" : String(v))}</textarea>`;
  }
  return `<input class="inline-edit" ${t} data-field="${col.field}" value="${escapeHtml(v == null ? "" : String(v))}" />`;
}

async function loadTable() {
  const cfg = TABS[currentTab];
  const tbody = $("yatra-tbody");
  $("yatra-add-btn").textContent = `+ Add ${cfg.title}`;
  $("yatra-table").dataset.tab = currentTab;
  // Prasadam Details is wide: ◀ ▶ buttons (top right of the table) pan it sideways
  if (currentTab === "prasadam") initHorizontalScroll("yatra-table-wrap");
  const hs = $("yatra-table-wrap").previousElementSibling;
  if (hs?.classList.contains("hscroll-controls")) hs.classList.toggle("hidden", currentTab !== "prasadam");
  $("yatra-thead").innerHTML = `<tr><th data-label="S.No">S.No</th>${cfg.cols.map((c) => `<th data-label="${c.label}">${c.label}</th>`).join("")}<th data-label=""></th></tr>`;
  tbody.innerHTML = `<tr><td colspan="${cfg.cols.length + 2}" class="loading-row">Loading…</td></tr>`;
  // headers are rebuilt per tab, so the drag handlers are re-wired each time
  initColumnDragReorder("yatra-table", { force: true, storageKey: `nrg-col-order:yatra:${currentTab}` });

  // Rows can be dragged into a custom order (the `position` column); rows never
  // moved have no position and sort last, oldest first. If the column hasn't
  // been added yet (yatra-row-order.sql), fall back to plain creation order.
  const load = (withPosition) => fetchAll(() => {
    let q = supabase.from(cfg.table).select("*").eq("yatra_id", currentYatra.id);
    if (cfg.kind) q = q.eq("kind", cfg.kind);
    if (withPosition) q = q.order("position", { ascending: true, nullsFirst: false });
    return q.order(cfg.order, { ascending: true });
  });
  let { data, error } = await load(true);
  rowOrderEnabled = !error;
  if (error) ({ data, error } = await load(false));
  if (error) {
    tbody.innerHTML = `<tr><td colspan="${cfg.cols.length + 2}" class="muted-text">Could not load: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  rowsCache = data;
  if (currentTab === "feedback") await loadFeedbackCategories();
  if (currentTab === "dashboard") {
    const coupons = await fetchAll(() => supabase.from("yatra_coupons").select("id,participant_id,coupon_date,meal").eq("yatra_id", currentYatra.id));
    couponsCache = coupons.data || [];
    const n = {};
    couponsCache.forEach((c) => { n[c.participant_id] = (n[c.participant_id] || 0) + 1; });
    rowsCache.forEach((r) => { r._tokens = n[r.id] || 0; });
  }
  renderRows();
  if (currentTab === "dashboard") renderStats();
}

// Disposables / Cooking rows are green once Received, red otherwise
const statusClass = (r) => (currentTab === "disposables" || currentTab === "cooking" ? (r.status === "Received" ? " yatra-row-ok" : " yatra-row-bad") : "");

function renderRows() {
  const cfg = TABS[currentTab];
  const tbody = $("yatra-tbody");
  const rows = visibleRows();
  const filtered = $("yatra-search").value.trim() || (currentTab === "dashboard" && $("yatra-served-filter").value !== "all");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${cfg.cols.length + 2}" class="muted-text">${filtered ? "No matches." : cfg.empty}</td></tr>`;
    return;
  }
  // reordering only makes sense on the full, unfiltered list
  const canReorder = rowOrderEnabled && !filtered;
  tbody.innerHTML = rows.map((r, i) => `
    <tr data-id="${r.id}" class="${statusClass(r).trim()}">
      <td data-label="S.No">${canReorder ? `<span class="yatra-drag-handle" title="Drag to reorder">⠿</span>` : ""}${i + 1}</td>
      ${cfg.cols.map((c) => `<td data-label="${c.label}">${cellHtml(c, r)}</td>`).join("")}
      <td data-label=""><button type="button" class="cell-chip danger yatra-row-delete">🗑 Delete</button></td>
    </tr>`).join("");
  reapplyColumnOrder("yatra-table");

  tbody.querySelectorAll("[data-field]").forEach((el) => el.addEventListener("change", () => saveCell(el)));
  const fit = (el) => { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; };
  tbody.querySelectorAll(".yatra-wrap-edit").forEach((el) => {
    el.addEventListener("input", () => fit(el));
    if (el.classList.contains("yatra-points-edit")) wirePoints(el);
    else el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
    fit(el);
  });
  tbody.querySelectorAll(".yatra-token-btn").forEach((btn) => {
    btn.addEventListener("click", () => openTokenEntries(btn.closest("tr").dataset.id));
  });
  tbody.querySelectorAll(".yatra-row-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteRow(btn.closest("tr").dataset.id));
  });
  tbody.querySelectorAll(".yatra-drag-handle").forEach((h) => h.addEventListener("pointerdown", startRowDrag));
}

// Pointer-based drag (works for mouse and touch): the row follows the pointer
// and the DOM order is the new order; on release only the moved row's
// `position` is saved — a value between its new neighbours.
function startRowDrag(e) {
  e.preventDefault();
  const tbody = $("yatra-tbody");
  const row = e.currentTarget.closest("tr");
  row.classList.add("yatra-row-dragging");
  const onMove = (ev) => {
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("#yatra-tbody tr[data-id]");
    if (!over || over === row) return;
    const r = over.getBoundingClientRect();
    tbody.insertBefore(row, ev.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  };
  const onUp = async () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    row.classList.remove("yatra-row-dragging");
    await persistRowOrder(row.dataset.id);
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

async function persistRowOrder(movedId) {
  const cfg = TABS[currentTab];
  const ids = Array.from($("yatra-tbody").querySelectorAll("tr[data-id]")).map((tr) => tr.dataset.id);
  const byId = new Map(rowsCache.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  if (ordered.map((r) => r.id).join() === rowsCache.map((r) => r.id).join()) { renderRows(); return; }

  // rows never moved before have no position yet: number the whole list once,
  // after that a moved row only needs a value between its neighbours
  let updates;
  if (ordered.some((r) => r.position == null)) {
    ordered.forEach((r, i) => { r._newPos = (i + 1) * 1000; });
    updates = ordered;
  } else {
    const i = ordered.findIndex((r) => r.id === movedId);
    const prev = ordered[i - 1]?.position;
    const next = ordered[i + 1]?.position;
    const moved = ordered[i];
    moved._newPos = prev == null ? next - 1000 : next == null ? prev + 1000 : (prev + next) / 2;
    updates = [moved];
  }
  const results = await Promise.all(updates.map((r) => supabase.from(cfg.table).update({ position: r._newPos }).eq("id", r.id)));
  const failed = results.find((x) => x.error);
  if (failed) {
    showToast("Reorder failed: " + failed.error.message, "error");
    renderRows();
    return;
  }
  updates.forEach((r) => { r.position = r._newPos; delete r._newPos; });
  rowsCache = ordered;
  renderRows();
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
  if (col.type === "points") raw = numberPoints(raw);
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
  if (currentTab === "prasadam") {
    el.closest("tr").querySelectorAll("[data-calc]").forEach((c) => { c.textContent = calcValue(c.dataset.calc, record); });
  }
  if (field === "status") el.closest("tr").className = statusClass(record).trim();
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

// Every page's Download and "Email Excel" share one spec shape:
// { title, filename, headers, rows } — what's on screen is what's exported,
// including any columns the user has dragged into a new order.
const safeName = (str) => String(str || "Yatra").replace(/[^\w-]+/g, "_");

function inScreenOrder(spec, theadId) {
  const labels = Array.from(document.querySelectorAll(`#${theadId} th`)).map((th) => th.textContent.trim()).filter(Boolean);
  const idx = labels.map((l) => spec.headers.indexOf(l));
  if (idx.length !== spec.headers.length || idx.includes(-1)) return spec;
  return { ...spec, headers: idx.map((i) => spec.headers[i]), rows: spec.rows.map((r) => idx.map((i) => r[i])) };
}

// the rows currently shown (search + took/didn't-take filter), so the table,
// its count and the downloaded file always match
function visibleRows() {
  const cfg = TABS[currentTab];
  const term = $("yatra-search").value.trim().toLowerCase();
  const served = currentTab === "dashboard" ? $("yatra-served-filter").value : "all";
  return rowsCache.filter((r) =>
    (!term || cfg.searchFields.some((f) => String(r[f] || "").toLowerCase().includes(term)))
    && (served === "all" || (served === "took" ? r._tokens > 0 : !r._tokens)));
}

function tableExport() {
  const cfg = TABS[currentTab];
  const label = { dashboard: "Participants", prasadam: "Prasadam_Details", disposables: "Disposables", cooking: "Cooking_Serving", feedback: "Feedback" }[currentTab];
  return inScreenOrder({
    title: `${currentYatra.name} — ${label.replace("_", " / ")}`,
    filename: `${safeName(currentYatra.name)}_${label}_${todayISO()}.xlsx`,
    headers: ["S.No", ...cfg.cols.map((c) => c.label)],
    rows: visibleRows().map((r, i) => [i + 1, ...cfg.cols.map((c) => (c.type === "tokenbtn" ? r._tokens || 0 : c.type === "newtag" ? (r.is_new ? "New" : "") : c.type === "calc" ? calcValue(c.field, r) : c.type === "points" ? numberPoints(r[c.field]) : c.type === "date" ? fmtDate(r[c.field]) : r[c.field] ?? ""))]),
  }, "yatra-thead");
}

// Dashboard download: asks for a date + meal first, then lists every
// participant with how many plates they took in that slot.
let dlDraft = null;
function paintDlModal() {
  $("dl-date").value = dlDraft.date;
  $("dl-meal").querySelectorAll("[data-meal]").forEach((b) => {
    b.classList.toggle("btn-primary", b.dataset.meal === dlDraft.meal);
    b.classList.toggle("btn-secondary", b.dataset.meal !== dlDraft.meal);
  });
}
function openDownloadSlot() {
  if (!rowsCache.length) {
    showToast("Nothing to download yet.", "error");
    return;
  }
  dlDraft = { date: attDate, meal: attMeal };
  paintDlModal();
  $("yatra-dl-modal").classList.add("active");
}
async function dashboardSlotDownload() {
  const { date, meal } = dlDraft;
  const { data, error } = await fetchAll(() =>
    supabase.from("yatra_coupons").select("id,participant_id").eq("yatra_id", currentYatra.id).eq("coupon_date", date).eq("meal", meal));
  if (error) {
    showToast("Could not load: " + error.message, "error");
    return;
  }
  const n = {};
  data.forEach((c) => { n[c.participant_id] = (n[c.participant_id] || 0) + 1; });
  $("yatra-dl-modal").classList.remove("active");
  downloadSpec({
    title: `${currentYatra.name} — Participants`,
    subtitle: slotLabel(date, meal),
    filename: `${safeName(currentYatra.name)}_Participants_${date}_${mealShort(meal)}.xlsx`,
    headers: ["S.No", "Name", "Phone Number", "Folk Guide", "Plates", "Status"],
    rows: rowsCache.map((r, i) => [i + 1, r.name, r.phone, r.folk_guide ?? "", n[r.id] || 0, n[r.id] ? "Served" : "Not Served"]),
  });
}

function attendanceExport() {
  return inScreenOrder({
    title: `${currentYatra.name} — Attendance`,
    subtitle: slotLabel(attDate, attMeal),
    filename: `${safeName(currentYatra.name)}_Attendance_${attDate}_${mealShort(attMeal)}.xlsx`,
    headers: ["S.No", "Name", "Phone Number", "Type", "Time"],
    rows: attSlotRows.map((r, i) => [
      attSlotRows.length - i, r.participant?.name || "", r.participant?.phone || "", r.kind === "regular" ? "Coupon" : "Extra",
      new Date(r.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
    ]),
  }, "att-thead");
}

/* ---------------- Download: preview, then Excel or PDF ---------------- */

const CENTERED_COLS = ["S.No", "Quantity", "Tokens", "Unit", "Type", "Time", "Plates", "Status", "Date", "For How Many", "Delivery Time", "Cost per Plate", "Total Cost", "Advance Payment", "Balance"];
let previewSpec = null;

const generatedStamp = () => new Date().toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

// Shows the sheet the way it will print; its two buttons do the real download.
function downloadSpec(spec) {
  if (!spec.rows.length) {
    showToast("Nothing to download yet.", "error");
    return;
  }
  previewSpec = spec;
  const head = spec.headers.map((h) => `<th class="${CENTERED_COLS.includes(h) ? "c" : ""}">${escapeHtml(h)}</th>`).join("");
  const body = spec.rows.map((r) => `<tr>${r.map((v, i) => `<td class="${CENTERED_COLS.includes(spec.headers[i]) ? "c" : ""}">${escapeHtml(String(v ?? ""))}</td>`).join("")}</tr>`).join("");
  $("yatra-preview-sheet").innerHTML = `
    <h4 class="yatra-paper-title">${escapeHtml(spec.title)}</h4>
    ${spec.subtitle ? `<p class="yatra-paper-sub">${escapeHtml(spec.subtitle)}</p>` : ""}
    <p class="yatra-paper-meta">Generated ${escapeHtml(generatedStamp())} &nbsp;·&nbsp; ${spec.rows.length} row${spec.rows.length === 1 ? "" : "s"}</p>
    <table class="yatra-paper-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  $("yatra-preview-modal").classList.add("active");
}

function downloadXlsx(spec) {
  const last = spec.headers.length - 1;
  const top = spec.subtitle ? [[spec.title], [spec.subtitle], [`Generated ${generatedStamp()}`]] : [[spec.title], [`Generated ${generatedStamp()}`]];
  const ws = XLSX.utils.aoa_to_sheet([...top, [], spec.headers, ...spec.rows]);
  ws["!merges"] = top.map((_, r) => ({ s: { r, c: 0 }, e: { r, c: last } }));
  ws["!cols"] = spec.headers.map((h, c) => ({
    wch: Math.min(50, Math.max(8, String(h).length + 2, ...spec.rows.map((r) => String(r[c] ?? "").length + 2))),
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, spec.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
  XLSX.writeFile(wb, spec.filename);
}

function downloadPdf(spec) {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) {
    showToast("PDF tools did not load — check your connection and retry.", "error");
    return;
  }
  const ink = [60, 35, 15];
  const accent = [194, 98, 22];
  const doc = new jsPDF({ orientation: spec.headers.length > 5 ? "landscape" : "portrait", unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  // the built-in PDF fonts only cover Latin-1, so swap the typographic dash/dot
  const plain = (t) => String(t).replace(/[—–]/g, "-").replace(/·/g, "|");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.setTextColor(...ink);
  // a long title wraps onto several lines, so everything below is positioned from where it ends
  const titleLines = doc.splitTextToSize(plain(spec.title), W - 2 * M);
  doc.text(titleLines, M, 46);
  let y = 46 + (titleLines.length - 1) * 21;
  if (spec.subtitle) {
    y += 20;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(...accent);
    doc.text(plain(spec.subtitle), M, y);
  }
  y += 17;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(120, 110, 100);
  doc.text(`Generated ${generatedStamp()}   |   ${spec.rows.length} row${spec.rows.length === 1 ? "" : "s"}`, M, y);
  y += 8;
  doc.setDrawColor(...accent);
  doc.setLineWidth(1.5);
  doc.line(M, y, W - M, y);

  const columnStyles = {};
  spec.headers.forEach((h, i) => {
    if (CENTERED_COLS.includes(h)) columnStyles[i] = { halign: "center" };
    if (h === "S.No") columnStyles[i].cellWidth = 44;
  });
  doc.autoTable({
    head: [spec.headers],
    body: spec.rows.map((r) => r.map((v) => plain(v ?? ""))),
    startY: y + 13,
    margin: { left: M, right: M, top: 40, bottom: 44 },
    theme: "grid",
    styles: { font: "helvetica", fontSize: spec.headers.length > 10 ? 6.5 : 10, cellPadding: spec.headers.length > 10 ? { top: 3, bottom: 3, left: 3, right: 3 } : { top: 6, bottom: 6, left: 8, right: 8 }, lineColor: [205, 195, 180], lineWidth: 0.6, textColor: [40, 35, 30], valign: "middle", overflow: "linebreak" },
    headStyles: { fillColor: accent, textColor: 255, fontStyle: "bold", halign: "left", lineColor: accent },
    alternateRowStyles: { fillColor: [253, 249, 242] },
    columnStyles,
    didParseCell: (d) => { if (d.section === "head" && CENTERED_COLS.includes(spec.headers[d.column.index])) d.cell.styles.halign = "center"; },
  });

  const pages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8.5);
    doc.setTextColor(140, 130, 120);
    doc.setDrawColor(205, 195, 180);
    doc.setLineWidth(0.6);
    doc.line(M, H - 34, W - M, H - 34);
    doc.text("FOLK Yatras", M, H - 20);
    doc.text(`Page ${p} of ${pages}`, W - M, H - 20, { align: "right" });
  }
  doc.save(spec.filename.replace(/\.xlsx$/, ".pdf"));
}

/* ---------------- Email Excel ---------------- */

let emailSpecGetter = null;
const EMAIL_KEY = "yatras_email_to";

function openEmailModal(getSpec) {
  const spec = getSpec();
  if (!spec.rows.length) {
    showToast("Nothing to email yet.", "error");
    return;
  }
  emailSpecGetter = getSpec;
  let saved = "";
  try { saved = localStorage.getItem(EMAIL_KEY) || ""; } catch { /* storage blocked — just start empty */ }
  $("yatra-email-to").value = saved;
  $("yatra-email-info").textContent = `${spec.title} — ${spec.rows.length} row${spec.rows.length === 1 ? "" : "s"} will be attached as an Excel file.`;
  $("yatra-email-error").classList.add("hidden");
  $("yatra-email-modal").classList.add("active");
  $("yatra-email-to").focus();
}

async function sendEmail() {
  const errorEl = $("yatra-email-error");
  const to = $("yatra-email-to").value.trim();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) {
    errorEl.textContent = "Enter one valid email address.";
    errorEl.classList.remove("hidden");
    return;
  }
  const spec = emailSpecGetter();
  const btn = $("yatra-email-send-btn");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const res = await fetch("/api/yatras-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, title: spec.title, filename: spec.filename, headers: spec.headers, rows: spec.rows, user_name: sessionUser?.user_name, login_pw: sessionUser?.login_pw }),
    });
    let out = {};
    try { out = await res.json(); } catch { /* non-JSON: no API behind this host */ }
    if (!res.ok || !out.ok) throw new Error(out.error || "Email is only available on the deployed app (no mail server here).");
    try { localStorage.setItem(EMAIL_KEY, to); } catch { /* storage blocked */ }
    $("yatra-email-modal").classList.remove("active");
    showToast(`Emailed to ${to}`, "success");
  } catch (e) {
    errorEl.textContent = e.message || String(e);
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Send";
  }
}

/* ---------------- Add (several rows at once) ---------------- */

function entryRowHtml(cfg) {
  const addCols = cfg.cols.filter((c) => !c.noAdd);
  if (cfg.form) {
    // many fields: a labelled, wrapping grid instead of one line per row
    const fields = addCols.map((c) => {
      let ctl;
      if (c.type === "select") {
        ctl = `<select data-ef="${c.field}"><option value="" selected disabled>${c.placeholder || "Select"}</option>${c.options.map((o) => `<option>${o}</option>`).join("")}</select>`;
      } else if (c.type === "points") {
        ctl = `<textarea class="yatra-entry-long yatra-points-edit" data-ef="${c.field}" rows="3"></textarea>`;
      } else {
        const type = c.type === "number" ? `type="number" min="0" step="any"` : c.type === "date" ? `type="date"` : c.type === "time" ? `type="time"` : `type="text"`;
        ctl = `<input data-ef="${c.field}" ${type} />`;
      }
      return `<label class="field${c.type === "points" ? " yatra-field-wide" : ""}"><span>${c.label}${c.required ? " *" : ""}</span>${ctl}</label>`;
    }).join("");
    return `<div class="yatra-entry-row yatra-entry-form">${fields}<button type="button" class="stock-row-remove cell-chip danger" title="Remove">✕ Remove</button></div>`;
  }
  const cells = addCols.map((c) => {
    if (c.type === "select") {
      const blank = c.required ? `<option value="" selected disabled>${c.placeholder || "Select"}</option>` : "";
      return `<select data-ef="${c.field}">${blank}${c.options.map((o) => `<option${o === c.default ? " selected" : ""}>${o}</option>`).join("")}</select>`;
    }
    if (c.type === "longtext") {
      return `<textarea class="yatra-entry-long" data-ef="${c.field}" rows="3" placeholder="${c.label}"></textarea>`;
    }
    const type = c.type === "number" ? `type="number" min="0" step="any"` : c.type === "phone" ? `type="tel" inputmode="numeric"` : `type="text"`;
    return `<input data-ef="${c.field}" ${type} placeholder="${c.label}" />`;
  }).join("");
  // a long-text field sits on its own full-width line above the other fields
  const hasLong = addCols.some((c) => c.type === "longtext");
  const tracks = addCols.filter((c) => c.type !== "longtext").map((c) => c.grid || "minmax(0, 1fr)").join(" ");
  return `<div class="yatra-entry-row${hasLong ? " has-long" : ""}" style="grid-template-columns: ${tracks} 32px">${cells}<button type="button" class="stock-row-remove cell-chip danger" title="Remove">✕</button></div>`;
}

function addEntryRow() {
  const wrap = $("yatra-entry-rows");
  wrap.insertAdjacentHTML("beforeend", entryRowHtml(TABS[currentTab]));
  const row = wrap.lastElementChild;
  const long = row.querySelector(".yatra-entry-long");
  if (long?.classList.contains("yatra-points-edit")) wirePoints(long);
  if (long) long.addEventListener("input", () => { long.style.height = "auto"; long.style.height = long.scrollHeight + "px"; });
  row.querySelector(".stock-row-remove").addEventListener("click", () => {
    if (wrap.children.length > 1) row.remove();
  });
  row.querySelector("input, select")?.focus();
}

// Categories added by the user live in yatra_feedback_categories and are
// merged into the built-in list; if that table doesn't exist yet only the
// built-ins are offered.
async function loadFeedbackCategories() {
  const { data } = await supabase.from("yatra_feedback_categories").select("name").order("created_at");
  (data || []).forEach((r) => { if (!FEEDBACK_CATEGORIES.includes(r.name)) FEEDBACK_CATEGORIES.push(r.name); });
}

async function addFeedbackCategory() {
  const name = (prompt("New feedback category:") || "").trim();
  if (!name) return;
  const existing = FEEDBACK_CATEGORIES.find((c) => c.toLowerCase() === name.toLowerCase());
  if (!existing) {
    const { error } = await supabase.from("yatra_feedback_categories").insert({ name });
    if (error) {
      showToast("Could not add category: " + error.message, "error");
      return;
    }
    FEEDBACK_CATEGORIES.push(name);
  }
  // add it to every open category dropdown and select it in the last one
  const val = existing || name;
  document.querySelectorAll('#yatra-entry-rows select[data-ef="category"]').forEach((sel) => {
    if (![...sel.options].some((o) => o.value === val)) sel.add(new Option(val, val));
  });
  const sels = document.querySelectorAll('#yatra-entry-rows select[data-ef="category"]');
  if (sels.length) sels[sels.length - 1].value = val;
  showToast(existing ? "Category already exists" : "Category added", existing ? "info" : "success");
}

async function openEntryModal() {
  const cfg = TABS[currentTab];
  const isFeedback = currentTab === "feedback";
  $("yatra-entry-add-cat-btn").classList.toggle("hidden", !isFeedback);
  if (isFeedback) await loadFeedbackCategories();
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
let attMeal = defaultMeal();
let attSlotRows = [];
let attPerson = null;

function renderAttendance() {
  const pane = $("yatra-attendance-pane");
  pane.innerHTML = `
    <div class="yatra-slot-bar">
      <input id="att-search" type="search" placeholder="Search…" class="search-input yatra-slot-search" />
      <button type="button" id="att-download-btn" class="btn btn-secondary btn-sm">⬇ Download</button>
      <span class="yatra-mind-note" role="note">🙏 Please mind me</span>
      <button type="button" id="att-slot-btn" class="btn btn-primary btn-sm" title="Change date / meal"></button>
    </div>
    <div class="panel">
      <label class="field"><span>Phone number</span>
        <input id="att-phone" type="tel" inputmode="numeric" autocomplete="off" placeholder="Type the 10-digit phone number" class="yatra-att-phone" />
      </label>
      <div id="att-result"></div>
    </div>
    <div class="stats-bar yatra-stats" id="att-stats"></div>
    <div class="table-wrap">
      <table class="data-table" id="att-table">
        <thead id="att-thead"><tr><th>S.No</th><th>Name</th><th>Phone Number</th><th>Type</th><th>Time</th><th></th></tr></thead>
        <tbody id="att-tbody"><tr><td colspan="6" class="loading-row">Loading…</td></tr></tbody>
      </table>
    </div>`;

  syncAttControls();
  initColumnDragReorder("att-table", { storageKey: "nrg-col-order:yatra:attendance" });
  $("att-slot-btn").onclick = openSlotModal;
  $("att-download-btn").onclick = () => downloadSpec(attendanceExport());
  $("att-phone").addEventListener("input", onPhoneInput);
  $("att-search").addEventListener("input", renderSlot);
  loadSlot();
  $("att-phone").focus();
}

function syncAttControls() {
  const mealName = Object.fromEntries(MEALS)[attMeal];
  const btn = $("att-slot-btn");
  if (btn) btn.textContent = `📅 ${fmtDate(attDate)} · ${mealShort(attMeal)} (${mealName})`;
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
  if (currentTab === "dashboard") {
    renderStats();
    return;
  }
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
  const term = ($("att-search")?.value || "").trim().toLowerCase();
  const shown = term
    ? attSlotRows.filter((r) => `${r.participant?.name || ""} ${r.participant?.phone || ""}`.toLowerCase().includes(term))
    : attSlotRows;
  if (!shown.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted-text">${term ? "No matches." : "Nothing marked for this meal yet."}</td></tr>`;
    return;
  }
  tbody.innerHTML = shown.map((r, i) => `
    <tr data-id="${r.id}">
      <td data-label="S.No">${attSlotRows.length - i}</td>
      <td data-label="Name">${escapeHtml(r.participant?.name || "")}</td>
      <td data-label="Phone Number">${escapeHtml(formatPhone(r.participant?.phone))}</td>
      <td data-label="Type">${r.kind === "regular" ? "Coupon" : "Extra"}</td>
      <td data-label="Time">${new Date(r.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</td>
      <td data-label=""><button type="button" class="cell-chip danger att-delete">🗑 Undo</button></td>
    </tr>`).join("");
  reapplyColumnOrder("att-table");
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
    .select("id,name,phone,folk_guide,is_new").eq("yatra_id", currentYatra.id).eq("phone", phone).maybeSingle();
  // the field may have changed while the request was in flight
  if (normalizePhoneInput($("att-phone").value) !== phone) return;
  if (error) {
    result.innerHTML = `<p class="field-error">${escapeHtml(error.message)}</p>`;
    return;
  }
  if (!data) {
    showNewPersonForm(phone);
    return;
  }
  attPerson = data;
  attPerson.usedTotal = await countRows("yatra_coupons", currentYatra.id, (q) => q.eq("participant_id", data.id));
  showPerson();
}

// Phone isn't in this yatra's list: offer to add the person right here. They
// are saved with is_new = true so the Dashboard can tell them apart.
function showNewPersonForm(phone) {
  $("att-result").innerHTML = `
    <div class="yatra-person-card yatra-new-card">
      <div class="yatra-person-info">
        <p class="yatra-person-name">Not in the list</p>
        <p class="muted-text">📞 ${escapeHtml(formatPhone(phone))} isn't registered in this yatra. Add them as a new participant:</p>
        <label class="field"><span>Name *</span><input id="att-new-name" type="text" autocomplete="off" placeholder="Full name" /></label>
        <label class="field"><span>Folk Guide</span><input id="att-new-guide" type="text" autocomplete="off" placeholder="Optional" /></label>
        <div id="att-new-error" class="field-error hidden"></div>
      </div>
      <div class="yatra-person-actions">
        <button id="att-new-save-btn" class="btn btn-primary">+ Add &amp; Mark Coupon</button>
        <button id="att-new-add-only-btn" class="btn btn-secondary">Add Only</button>
      </div>
    </div>`;
  const save = async (markCoupon) => {
    const name = $("att-new-name").value.trim();
    const errorEl = $("att-new-error");
    if (!name) {
      errorEl.textContent = "Enter the person's name.";
      errorEl.classList.remove("hidden");
      return;
    }
    const btns = [$("att-new-save-btn"), $("att-new-add-only-btn")];
    btns.forEach((b) => { b.disabled = true; });
    const { data, error } = await supabase.from("yatra_participants")
      .insert({ yatra_id: currentYatra.id, name, phone, folk_guide: $("att-new-guide").value.trim() || null, is_new: true })
      .select("id,name,phone,folk_guide,is_new").single();
    if (error) {
      btns.forEach((b) => { b.disabled = false; });
      errorEl.textContent = /duplicate|unique/i.test(error.message) ? "This number was just added — type it again." : "Could not add: " + friendlyDbError(error);
      errorEl.classList.remove("hidden");
      return;
    }
    showToast(`${name} added as a new participant`, "success");
    attPerson = { ...data, usedTotal: 0 };
    if (markCoupon) await markCoupons("regular", 1);
    else showPerson();
  };
  $("att-new-save-btn").onclick = () => save(true);
  $("att-new-add-only-btn").onclick = () => save(false);
  $("att-new-name").focus();
}

function showPerson() {
  const p = attPerson;
  const mine = attSlotRows.filter((r) => r.participant_id === p.id);
  const hasRegular = mine.some((r) => r.kind === "regular");
  const extras = mine.length - (hasRegular ? 1 : 0);
  $("att-result").innerHTML = `
    <div class="yatra-person-card">
      <div class="yatra-person-info">
        <p class="yatra-person-name">${escapeHtml(p.name)}${p.is_new ? ` <span class="cell-chip yatra-new-tag">🆕 New</span>` : ""}</p>
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
  const errorEl = $("yatra-error");

  let editingYatraId = null; // set while the modal edits the open yatra's title/date
  const openYatraModal = (yatra) => {
    editingYatraId = yatra ? yatra.id : null;
    $("yatra-modal-title").textContent = yatra ? "Edit Yatra" : "Add Yatra";
    nameInput.value = yatra ? yatra.name : "";
    errorEl.classList.add("hidden");
    addModal.classList.add("active");
  };
  $("add-yatra-btn").onclick = () => openYatraModal(null);
  $("yatra-edit-btn").onclick = () => currentYatra && openYatraModal(currentYatra);
  $("yatra-cancel-btn").onclick = () => addModal.classList.remove("active");
  addModal.addEventListener("click", (e) => { if (e.target === addModal) addModal.classList.remove("active"); });
  $("yatra-save-btn").onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      errorEl.textContent = "Please enter a name for this yatra.";
      errorEl.classList.remove("hidden");
      return;
    }
    const fields = { name };
    const { error } = editingYatraId
      ? await supabase.from("yatras").update(fields).eq("id", editingYatraId)
      : await supabase.from("yatras").insert(fields);
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    addModal.classList.remove("active");
    showToast(editingYatraId ? "Yatra updated" : "Yatra added", "success");
    if (editingYatraId && currentYatra?.id === editingYatraId) {
      Object.assign(currentYatra, fields);
      $("yatra-detail-title").textContent = name;
    }
    await loadYatraCards();
  };

  const entryModal = $("yatra-entry-modal");
  $("yatra-add-btn").onclick = openEntryModal;
  $("yatra-download-btn").onclick = () => downloadSpec(tableExport());
  const dlModal = $("yatra-dl-modal");
  $("dl-date").addEventListener("change", (e) => { if (e.target.value) dlDraft.date = e.target.value; });
  $("dl-meal").querySelectorAll("[data-meal]").forEach((b) => b.addEventListener("click", () => {
    dlDraft.meal = b.dataset.meal;
    paintDlModal();
  }));
  $("yatra-dl-next-btn").onclick = dashboardSlotDownload;
  $("yatra-dl-cancel-btn").onclick = () => dlModal.classList.remove("active");
  dlModal.addEventListener("click", (e) => { if (e.target === dlModal) dlModal.classList.remove("active"); });
  const emailModal = $("yatra-email-modal");
  $("yatra-email-cancel-btn").onclick = () => emailModal.classList.remove("active");
  emailModal.addEventListener("click", (e) => { if (e.target === emailModal) emailModal.classList.remove("active"); });
  $("yatra-email-send-btn").onclick = sendEmail;
  $("yatra-email-to").addEventListener("keydown", (e) => { if (e.key === "Enter") sendEmail(); });
  $("yatra-entry-add-row-btn").onclick = addEntryRow;
  $("yatra-entry-add-cat-btn").onclick = addFeedbackCategory;
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
  $("yatra-served-filter").addEventListener("change", renderRows);
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
  $("yatra-stat-download-btn").onclick = () => downloadSpec(inScreenOrder(statPopup || { headers: [], rows: [] }, "yatra-stat-thead"));
  const previewModal = $("yatra-preview-modal");
  $("yatra-preview-xlsx-btn").onclick = () => previewSpec && downloadXlsx(previewSpec);
  $("yatra-preview-pdf-btn").onclick = () => previewSpec && downloadPdf(previewSpec);
  $("yatra-preview-close-btn").onclick = () => previewModal.classList.remove("active");
  previewModal.addEventListener("click", (e) => { if (e.target === previewModal) previewModal.classList.remove("active"); });
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
  sessionUser = user;
  if (!shellWired) {
    shellWired = true;
    wireShell();
  }
  limitedTab = opts.tab || null;
  $("yatra-tabs").classList.toggle("hidden", !!limitedTab);
  $("yatra-edit-btn").classList.toggle("hidden", !!limitedTab);
  if (limitedTab && currentYatra && !$("yatras-detail-view").classList.contains("hidden")) {
    await switchTab(limitedTab);
    return;
  }
  pendingTab = limitedTab;
  showYatrasView();
  await loadYatraCards();
};
