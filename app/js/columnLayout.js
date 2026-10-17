// Adjustable column widths and margins for every table, built once and used
// everywhere. Each `table.data-table` that has an id gets a "⇔ Columns" button
// (just above it, on the right) opening a panel where every column's width and
// left/right margin can be stepped up or down. Settings are remembered per
// table (and per tab, via data-tab), shared by every user (see layoutStore.js), and re-applied whenever the
// table is redrawn. (PDF / Excel column widths are separate: see exportDoc.js.)
import { columnKeyOf } from "./utils.js";
import { getLayout, setLayout, loadLayouts, layoutsStale } from "./layoutStore.js";

const STORE = "nrg-col-layout:";
const WIDTH_STEP = 10, MARGIN_STEP = 2;
const MIN_W = 30, MAX_W = 1200, MAX_M = 60;
// On a phone the tables turn into stacked cards, so custom widths are left off there.
const wide = window.matchMedia("(min-width: 641px)");

const keyOf = (table) => STORE + table.id + (table.dataset.tab ? ":" + table.dataset.tab : "");

function load(table) {
  const v = getLayout(keyOf(table));
  return v && typeof v === "object" ? v : {};
}

function save(table, cfg) {
  setLayout(keyOf(table), Object.keys(cfg).length ? cfg : null);
}

function clear(table) {
  table.querySelectorAll(".col-custom").forEach((c) => {
    c.classList.remove("col-custom");
    c.style.width = c.style.minWidth = c.style.maxWidth = c.style.paddingLeft = c.style.paddingRight = "";
  });
}

function apply(table) {
  const headRow = table.querySelector("thead tr");
  if (!headRow) return;
  const cfg = load(table);
  clear(table);
  if (!wide.matches || !Object.keys(cfg).length) return;
  const ths = Array.from(headRow.children);
  const rows = [headRow, ...table.querySelectorAll("tbody tr")];
  ths.forEach((th, i) => {
    const e = cfg[columnKeyOf(th)];
    if (!e) return;
    rows.forEach((row) => {
      // skip "loading…" / "no rows" rows, whose single cell spans the table
      if (row.children.length !== ths.length) return;
      const c = row.children[i];
      c.classList.add("col-custom");
      if (e.w) c.style.width = c.style.minWidth = c.style.maxWidth = e.w + "px";
      if (e.m != null) c.style.paddingLeft = c.style.paddingRight = e.m + "px";
    });
  });
}

/* ---------------- Panel ---------------- */

let openPanelEl = null;
function closePanel() {
  if (openPanelEl) { openPanelEl.remove(); openPanelEl = null; }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function fillPanel(panel, table) {
  const cfg = load(table);
  const ths = Array.from(table.querySelectorAll("thead tr:first-child th")).filter((th) => columnKeyOf(th));
  panel.querySelector(".col-layout-list").innerHTML = ths.map((th) => {
    const key = columnKeyOf(th);
    const w = cfg[key]?.w ?? Math.round(th.getBoundingClientRect().width);
    const m = cfg[key]?.m ?? Math.round(parseFloat(getComputedStyle(th).paddingLeft) || 0);
    const name = String(key).replace(/</g, "&lt;");
    return `<div class="col-layout-row" data-key="${name.replace(/"/g, "&quot;")}">
      <span class="col-layout-name" title="${name.replace(/"/g, "&quot;")}">${name}</span>
      <span class="col-layout-group"><span>Width</span>
        <button type="button" data-act="w-">−</button><input type="number" data-f="w" value="${w}" min="${MIN_W}" max="${MAX_W}"><button type="button" data-act="w+">+</button></span>
      <span class="col-layout-group"><span>Margin</span>
        <button type="button" data-act="m-">−</button><input type="number" data-f="m" value="${m}" min="0" max="${MAX_M}"><button type="button" data-act="m+">+</button></span>
    </div>`;
  }).join("");
}

function openPanel(table, btn) {
  closePanel();
  const panel = document.createElement("div");
  panel.className = "col-layout-panel";
  panel.innerHTML = `<div class="col-layout-head"><strong>Column widths &amp; margins</strong>
      <button type="button" class="btn btn-secondary btn-sm" data-act="reset">Reset all</button>
      <button type="button" class="col-layout-close" data-act="close" title="Close">✕</button></div>
    <div class="col-layout-list"></div>
    <p class="col-layout-note">Width widens or narrows a column; Margin is the space inside it, left and right. Saved for all users.</p>`;
  fillPanel(panel, table);

  const commit = (row, field, value) => {
    const cfg = load(table);
    const key = row.dataset.key;
    const v = field === "w" ? clamp(Math.round(value) || MIN_W, MIN_W, MAX_W) : clamp(Math.round(value) || 0, 0, MAX_M);
    cfg[key] = { ...cfg[key], [field]: v };
    save(table, cfg);
    row.querySelector(`input[data-f="${field}"]`).value = v;
    apply(table);
  };

  panel.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "close") return closePanel();
    if (act === "reset") {
      save(table, {});
      apply(table);
      fillPanel(panel, table);
      return;
    }
    const row = b.closest(".col-layout-row");
    const field = act[0];
    const input = row.querySelector(`input[data-f="${field}"]`);
    commit(row, field, Number(input.value) + (act[1] === "+" ? 1 : -1) * (field === "w" ? WIDTH_STEP : MARGIN_STEP));
  });
  panel.addEventListener("change", (e) => {
    const input = e.target.closest("input[data-f]");
    if (input) commit(input.closest(".col-layout-row"), input.dataset.f, Number(input.value));
  });

  document.body.appendChild(panel);
  const r = btn.getBoundingClientRect();
  const left = clamp(r.right - panel.offsetWidth, 8, window.innerWidth - panel.offsetWidth - 8);
  panel.style.left = left + "px";
  panel.style.top = Math.min(r.bottom + 6, window.innerHeight - 120) + "px";
  openPanelEl = panel;
}

document.addEventListener("mousedown", (e) => {
  if (openPanelEl && !openPanelEl.contains(e.target) && !e.target.closest(".col-layout-btn")) closePanel();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });

/* ---------------- Wiring ---------------- */

// The button lives in the table's right-aligned ◀ ▶ bar when it has one,
// otherwise in a small bar of its own just above the table.
function placeButton(table) {
  const wrap = table.closest(".table-wrap") || table;
  const prev = wrap.previousElementSibling;
  let btn = table._colLayoutBtn;
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-secondary hscroll-btn col-layout-btn";
    btn.textContent = "⇔ Columns";
    btn.title = "Adjust column widths and margins";
    btn.addEventListener("click", () => (openPanelEl ? closePanel() : openPanel(table, btn)));
    table._colLayoutBtn = btn;
  }
  if (prev?.classList.contains("hscroll-controls-floating")) {
    if (btn.parentElement !== prev) prev.prepend(btn);
    return;
  }
  if (prev?.classList.contains("col-layout-bar")) {
    if (btn.parentElement !== prev) prev.appendChild(btn);
    return;
  }
  const bar = document.createElement("div");
  bar.className = "col-layout-bar";
  bar.appendChild(btn);
  wrap.parentNode.insertBefore(bar, wrap);
}

// Column titles are centred over their columns on every table. Some tables carry their own
// left-aligned header rules (with !important), so the centring is set inline, which outranks them.
function centerHeads(table) {
  table.querySelectorAll("thead th").forEach((th) => {
    if (th.style.getPropertyValue("text-align") !== "center") th.style.setProperty("text-align", "center", "important");
  });
}

function wire(table) {
  if (table.dataset.colLayout) return;
  table.dataset.colLayout = "1";
  placeButton(table);
  centerHeads(table);
  apply(table);
}

function scan() {
  document.querySelectorAll("table.data-table[id]:not([data-col-layout])").forEach(wire);
}

export function initColumnLayout() {
  scan();
  // settings are shared by every user: fetch them, then redraw the tables already on screen
  const reapplyAll = () => document.querySelectorAll("table.data-table[data-col-layout]").forEach(apply);
  loadLayouts().then(reapplyAll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && layoutsStale()) loadLayouts().then(reapplyAll);
  });
  const pending = new Set();
  new MutationObserver((muts) => {
    let added = false;
    muts.forEach((m) => {
      if (m.addedNodes.length) added = true;
      const t = m.target.closest?.("table.data-table[id]");
      if (t && t.dataset.colLayout) pending.add(t);
    });
    if (added) scan();
    // redrawn rows / headers lose their inline sizes: put them back (a microtask, so before paint)
    pending.forEach((t) => { placeButton(t); centerHeads(t); apply(t); });
    pending.clear();
  }).observe(document.body, { childList: true, subtree: true });
  wide.addEventListener("change", () => document.querySelectorAll("table.data-table[data-col-layout]").forEach(apply));
}
