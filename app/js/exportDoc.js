import { showToast, escapeHtml } from "./utils.js";

/* ======================= SHARED DOWNLOAD (preview → Excel / PDF) =======================
   Every page's download goes through downloadSpec({ title, subtitle?, filename,
   headers, rows, footer?, pdfColumns?, autoCenter? }): a paper-style preview opens
   with "Download in Excel" and "Download in PDF". tableExport() builds that spec
   from any rendered table, so a page's current search/filter/sort/column order is
   exactly what ends up in the file. */

/* ---------------- Download: preview, then Excel or PDF ---------------- */

export const CENTERED_COLS = ["S.No", "Quantity", "Tokens", "Unit", "Type", "Time", "Plates", "Status", "Date", "No. of Rooms", "Cost per Room", "Extra Charges", "Date of Booking", "Adv Paid", "Balance Amt", "Day & Date", "Start Time", "End Time", "Duration (min)", "For How Many", "Delivery Time", "Cost per Plate", "Total Cost", "Advance Payment", "Balance"];
let previewSpec = null;
const PREVIEW_MAX = 200;

// header-name list, plus (for table exports) any column whose cells are all numbers/dates/amounts
const NUMERIC_CELL = /^[\d\s.,:/₹%+-]+$/;
function isCentered(spec, i) {
  if (CENTERED_COLS.includes(spec.headers[i])) return true;
  if (!spec.autoCenter) return false;
  const cells = spec.rows.map((r) => String(r[i] ?? "").trim()).filter(Boolean);
  return cells.length > 0 && cells.every((c) => NUMERIC_CELL.test(c));
}

const $ = (id) => document.getElementById(id);

const generatedStamp = () => new Date().toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/* ---------------- PDF / Excel column widths (separate from the on-screen table) ----------------
   Each column has a Width (% of the page width, scaled so the row always fits) and a
   Margin (pt of space inside the cell, left and right). They are edited from the
   preview's "⇔ PDF columns" button and remembered per table / tab on this device, so
   the downloaded file can be laid out differently from the table on screen. */

const PDF_STORE = "nrg-pdf-layout:";
const PDF_W_STEP = 1, PDF_M_STEP = 1, PDF_M_DEFAULT = 8, PDF_M_MAX = 30;

function pdfKey(spec) {
  const t = spec.layoutTableId ? document.getElementById(spec.layoutTableId) : null;
  return PDF_STORE + (spec.layoutTableId ? spec.layoutTableId + (t?.dataset.tab ? ":" + t.dataset.tab : "") : "page:" + spec.title);
}
function loadPdfLayout(spec) {
  try { const v = JSON.parse(localStorage.getItem(pdfKey(spec))); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function savePdfLayout(spec, cfg) {
  try {
    if (Object.keys(cfg).length) localStorage.setItem(pdfKey(spec), JSON.stringify(cfg));
    else localStorage.removeItem(pdfKey(spec));
  } catch { /* storage blocked: applies until the page is reloaded */ }
}

// Starting widths (% of the page): a spec's fixed pdfColumns when it has them, otherwise
// sized to the longest line in each column.
function defaultWidths(spec) {
  if (spec.pdfColumns) {
    const avail = 515;
    const fixed = Object.values(spec.pdfColumns).filter((w) => typeof w === "number").reduce((a, b) => a + b, 0);
    const pt = spec.headers.map((h) => { const w = spec.pdfColumns[h]; return w === "fill" ? Math.max(60, avail * 1.4 - fixed) : (w || 70); });
    const tot = pt.reduce((a, b) => a + b, 0);
    return pt.map((w) => (w / tot) * 100);
  }
  const len = spec.headers.map((h, i) => {
    const longestWord = Math.max(...String(h).split(/\s+/).map((w) => w.length), 3);
    const cellMax = Math.max(0, ...spec.rows.map((r) => Math.max(0, ...String(r[i] ?? "").split("\n").map((l) => l.length))));
    return Math.max(longestWord + 2, Math.min(cellMax, 45) + 2);
  });
  const tot = len.reduce((a, b) => a + b, 0);
  return len.map((w) => (w / tot) * 100);
}

// width % (normalised to sum 100) and margin pt for each header, saved settings over defaults
function pdfLayout(spec) {
  const saved = loadPdfLayout(spec);
  const def = defaultWidths(spec);
  const raw = spec.headers.map((h, i) => saved[h]?.w ?? def[i]);
  const tot = raw.reduce((a, b) => a + b, 0) || 1;
  return {
    raw,
    w: raw.map((v) => (v / tot) * 100),
    m: spec.headers.map((h) => saved[h]?.m ?? PDF_M_DEFAULT),
  };
}

// "Vrindavan - 16 Rounder … 2026 — Participants" → ["Vrindavan - 16 Rounder … 2026", "Participants"]
const splitTitle = (title) => {
  const i = String(title).indexOf(" — ");
  return i < 0 ? [String(title)] : [title.slice(0, i), title.slice(i + 3)];
};

function renderPreview() {
  const spec = previewSpec;
  const lay = pdfLayout(spec);
  const colgroup = `<colgroup>${lay.w.map((w) => `<col style="width:${w.toFixed(2)}%">`).join("")}</colgroup>`;
  const pad = (i) => ` style="padding-left:${(lay.m[i] * 1.3).toFixed(1)}px;padding-right:${(lay.m[i] * 1.3).toFixed(1)}px"`;
  const head = spec.headers.map((h, i) => `<th class="${isCentered(spec, i) ? "c" : ""}"${pad(i)}>${escapeHtml(h)}</th>`).join("");
  const shown = spec.rows.slice(0, PREVIEW_MAX);
  const body = shown.map((r) => `<tr>${r.map((v, i) => `<td class="${isCentered(spec, i) ? "c" : ""}"${pad(i)}>${escapeHtml(String(v ?? ""))}</td>`).join("")}</tr>`).join("");
  $("yatra-preview-sheet").innerHTML = `
    <h4 class="yatra-paper-title">${(() => { const [a, b] = splitTitle(spec.title); return escapeHtml(a) + (b ? `<span class="yatra-paper-title-section">${escapeHtml(b)}</span>` : ""); })()}</h4>
    ${spec.subtitle ? `<p class="yatra-paper-sub">${escapeHtml(spec.subtitle)}</p>` : ""}
    <p class="yatra-paper-meta">Generated ${escapeHtml(generatedStamp())} &nbsp;·&nbsp; ${spec.rows.length} row${spec.rows.length === 1 ? "" : "s"}</p>
    <table class="yatra-paper-table" style="table-layout:fixed">${colgroup}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${spec.rows.length > PREVIEW_MAX ? `<p class="yatra-paper-meta">Preview shows the first ${PREVIEW_MAX} of ${spec.rows.length} rows — the downloaded file has all of them.</p>` : ""}`;
}

let pdfPanel = null;
function closePdfPanel() { if (pdfPanel) { pdfPanel.remove(); pdfPanel = null; } }

function fillPdfPanel() {
  const spec = previewSpec;
  const lay = pdfLayout(spec);
  pdfPanel.querySelector(".col-layout-list").innerHTML = spec.headers.map((h, i) => {
    const name = escapeHtml(h);
    return `<div class="col-layout-row" data-i="${i}">
      <span class="col-layout-name" title="${name}">${name}</span>
      <span class="col-layout-group"><span>Width %</span>
        <button type="button" data-act="w-">−</button><input type="number" data-f="w" step="0.5" value="${lay.w[i].toFixed(1)}" min="2" max="90"><button type="button" data-act="w+">+</button></span>
      <span class="col-layout-group"><span>Margin</span>
        <button type="button" data-act="m-">−</button><input type="number" data-f="m" value="${lay.m[i]}" min="0" max="${PDF_M_MAX}"><button type="button" data-act="m+">+</button></span>
    </div>`;
  }).join("");
}

function openPdfPanel(btn) {
  closePdfPanel();
  const spec = previewSpec;
  pdfPanel = document.createElement("div");
  pdfPanel.className = "col-layout-panel";
  pdfPanel.innerHTML = `<div class="col-layout-head"><strong>PDF / Excel column widths</strong>
      <button type="button" class="btn btn-secondary btn-sm" data-act="reset">Reset</button>
      <button type="button" class="col-layout-close" data-act="close" title="Close">✕</button></div>
    <div class="col-layout-list"></div>
    <p class="col-layout-note">These only change the downloaded file and this preview, not the table on screen. Width is a share of the page (the row is scaled to fit); Margin is the space inside the column, left and right.</p>`;
  fillPdfPanel();
  const commit = (i, field, value) => {
    const cfg = loadPdfLayout(spec);
    const h = spec.headers[i];
    const lay = pdfLayout(spec);
    // keep the other columns exactly where they are while one changes
    spec.headers.forEach((hh, j) => { cfg[hh] = { w: cfg[hh]?.w ?? lay.w[j], m: cfg[hh]?.m ?? lay.m[j] }; });
    const v = field === "w" ? Math.min(90, Math.max(2, Number(value) || 2)) : Math.min(PDF_M_MAX, Math.max(0, Math.round(Number(value)) || 0));
    cfg[h] = { ...cfg[h], [field]: v };
    savePdfLayout(spec, cfg);
    renderPreview();
    fillPdfPanel();
  };
  pdfPanel.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "close") return closePdfPanel();
    if (act === "reset") { savePdfLayout(spec, {}); renderPreview(); fillPdfPanel(); return; }
    const row = b.closest(".col-layout-row");
    const field = act[0];
    const input = row.querySelector(`input[data-f="${field}"]`);
    commit(Number(row.dataset.i), field, Number(input.value) + (act[1] === "+" ? 1 : -1) * (field === "w" ? PDF_W_STEP : PDF_M_STEP));
  });
  pdfPanel.addEventListener("change", (e) => {
    const input = e.target.closest("input[data-f]");
    if (input) commit(Number(input.closest(".col-layout-row").dataset.i), input.dataset.f, input.value);
  });
  document.body.appendChild(pdfPanel);
  pdfPanel.style.zIndex = "2200";
  const r = btn.getBoundingClientRect();
  pdfPanel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pdfPanel.offsetWidth - 8)) + "px";
  pdfPanel.style.top = Math.max(8, r.top - pdfPanel.offsetHeight - 8) + "px";
}

// Shows the sheet the way it will print; its buttons do the real download.
export function downloadSpec(spec) {
  wirePreviewModal();
  if (!spec.rows.length) {
    showToast("Nothing to download yet.", "error");
    return;
  }
  previewSpec = spec;
  closePdfPanel();
  renderPreview();
  $("yatra-preview-modal").classList.add("active");
}

function downloadXlsx(spec) {
  const last = spec.headers.length - 1;
  const top = [...splitTitle(spec.title).map((t) => [t]), ...(spec.subtitle ? [[spec.subtitle]] : []), [`Generated ${generatedStamp()}`]];
  // a plain Excel cell can't show the two-line day, so join it with a comma there
  const dayCol = spec.headers.indexOf("Day & Date");
  const rows = dayCol < 0 ? spec.rows : spec.rows.map((r) => r.map((v, i) => (i === dayCol ? String(v ?? "").replace("\n", ", ") : v)));
  const ws = XLSX.utils.aoa_to_sheet([...top, [], spec.headers, ...rows]);
  ws["!merges"] = top.map((_, r) => ({ s: { r, c: 0 }, e: { r, c: last } }));
  const lay = pdfLayout(spec);
  ws["!cols"] = spec.headers.map((h, c) => ({
    wch: Math.max(5, Math.round(lay.w[c] * 1.6)),
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

  // title: the name on the first line, the section on the second, both centred;
  // a name too wide for the page shrinks (down to a point) before it wraps
  const [t1, t2] = splitTitle(spec.title);
  const cx = W / 2;
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...ink);
  let size = 17;
  doc.setFontSize(size);
  while (doc.getTextWidth(plain(t1)) > W - 2 * M && size > 10) { size -= 0.5; doc.setFontSize(size); }
  const nameLines = doc.splitTextToSize(plain(t1), W - 2 * M);
  doc.text(nameLines, cx, 46, { align: "center" });
  let y = 46 + (nameLines.length - 1) * (size + 3);
  if (t2) {
    y += 21;
    doc.setFontSize(14);
    doc.text(plain(t2), cx, y, { align: "center", maxWidth: W - 2 * M });
  }
  if (spec.subtitle) {
    y += 19;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(...accent);
    doc.text(plain(spec.subtitle), cx, y, { align: "center", maxWidth: W - 2 * M });
  }
  y += 17;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(120, 110, 100);
  doc.text(`Generated ${generatedStamp()}   |   ${spec.rows.length} row${spec.rows.length === 1 ? "" : "s"}`, cx, y, { align: "center" });
  y += 8;
  doc.setDrawColor(...accent);
  doc.setLineWidth(1.5);
  doc.line(M, y, W - M, y);

  const columnStyles = {};
  // widths / margins from the preview's "⇔ PDF columns" settings (or the defaults)
  const lay = pdfLayout(spec);
  const padV = spec.headers.length > 10 ? 3 : 6;
  spec.headers.forEach((h, i) => {
    columnStyles[i] = {
      ...(isCentered(spec, i) ? { halign: "center" } : {}),
      cellWidth: (lay.w[i] / 100) * (W - 2 * M),
      cellPadding: { top: padV, bottom: padV, left: lay.m[i], right: lay.m[i] },
    };
  });
  doc.autoTable({
    head: [spec.headers],
    body: spec.rows.map((r) => r.map((v) => plain(v ?? ""))),
    startY: y + 13,
    margin: { left: M, right: M, top: 40, bottom: 44 },
    theme: "grid",
    styles: { font: "helvetica", fontSize: spec.headers.length > 10 ? 6.5 : 10, cellPadding: spec.headers.length > 10 ? { top: 3, bottom: 3, left: 3, right: 3 } : { top: 6, bottom: 6, left: 8, right: 8 }, lineColor: [205, 195, 180], lineWidth: 0.6, textColor: [40, 35, 30], valign: "middle", overflow: "linebreak" },
    headStyles: { fillColor: accent, textColor: 255, fontStyle: "bold", halign: "center", lineColor: accent },
    alternateRowStyles: { fillColor: [253, 249, 242] },
    columnStyles,
    didParseCell: (d) => { if (d.section === "head") d.cell.styles.halign = "center"; },
  });

  const pages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8.5);
    doc.setTextColor(140, 130, 120);
    doc.setDrawColor(205, 195, 180);
    doc.setLineWidth(0.6);
    doc.line(M, H - 34, W - M, H - 34);
    doc.text(spec.footer || "FNRG Preaching", M, H - 20);
    doc.text(`Page ${p} of ${pages}`, W - M, H - 20, { align: "right" });
  }
  doc.save(spec.filename.replace(/\.xlsx$/, ".pdf"));
}

let modalWired = false;
function wirePreviewModal() {
  if (modalWired) return;
  modalWired = true;
  const modal = $("yatra-preview-modal");
  $("yatra-preview-xlsx-btn").onclick = () => previewSpec && downloadXlsx(previewSpec);
  $("yatra-preview-pdf-btn").onclick = () => previewSpec && downloadPdf(previewSpec);
  $("yatra-preview-close-btn").onclick = () => { closePdfPanel(); modal.classList.remove("active"); };
  $("yatra-preview-cols-btn").onclick = (e) => (pdfPanel ? closePdfPanel() : openPdfPanel(e.currentTarget));
  modal.addEventListener("click", (e) => { if (e.target === modal) { closePdfPanel(); modal.classList.remove("active"); } });
}

// "nrg-reception-analytics-2026-10-17.xlsx" / "Book_Events_2026-10-17.xlsx" → "Nrg Reception Analytics" / "Book Events"
export function titleFromFilename(filename) {
  return String(filename).replace(/\.\w+$/, "").replace(/[-_]?\d{4}-\d{2}-\d{2}$/, "").replace(/[-_]+/g, " ").trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const stamp = () => new Date().toISOString().slice(0, 10);

// rows = array of arrays, first row = headers (the shape downloadExcel takes)
export function downloadRows(filename, rows, title) {
  const [headers = [], ...body] = rows;
  downloadSpec({ title: title || titleFromFilename(filename), filename: filename.replace(/\.\w+$/, "") + ".xlsx", headers: headers.map(String), rows: body, autoCenter: true });
}

// a rendered <table>: header labels + current cell text (inputs/selects give their value).
// Columns/cells marked .no-export, hidden rows and hidden columns are left out.
export function downloadTable(table, filename, title, subtitle) {
  if (!table) return;
  const ths = Array.from(table.querySelectorAll("thead th"));
  // an empty header is an action/checkbox column — never part of the data
  const keep = ths.map((th) => th.textContent.trim() !== "" && !th.classList.contains("no-export") && !th.classList.contains("followup-select-col") && th.style.display !== "none" && !th.classList.contains("hidden"));
  const headers = ths.filter((_, i) => keep[i]).map((th) => (th.querySelector(".th-label") || th).textContent.trim());
  const rows = [];
  table.querySelectorAll("tbody tr").forEach((tr) => {
    if (tr.classList.contains("hidden") || tr.style.display === "none") return;
    const tds = Array.from(tr.children);
    if (tds.length === 1 && tds[0].colSpan > 1) return; // loading / empty-state row
    rows.push(tds.filter((_, i) => keep[i] ?? !tds[i].classList.contains("no-export")).map((td) => {
      const field = td.querySelector("input:not([type=checkbox]), select");
      return field ? (field.tagName === "SELECT" ? field.selectedOptions[0]?.textContent.trim() ?? "" : field.value) : td.innerText.replace(/\s*\n\s*/g, " ").trim();
    }));
  });
  downloadSpec({ layoutTableId: table.id, title: title || titleFromFilename(filename), subtitle, filename: filename.replace(/\.\w+$/, "") + ".xlsx", headers, rows, autoCenter: true });
}

// Adds a "⬇ Download" button above each listed table that has no export button of its own.
// items: [{ table: "table-id" | body: "tbody-id", title: "Page title" }]
export function addDownloadButtons(items) {
  items.forEach(({ table: id, body, title }) => {
    const table = id ? $(id) : $(body)?.closest("table");
    if (!table || table.dataset.dlWired) return;
    table.dataset.dlWired = "1";
    const wrap = table.closest(".table-wrap") || table;
    const bar = document.createElement("div");
    bar.className = "dl-bar";
    bar.innerHTML = `<button type="button" class="btn btn-secondary toolbar-btn">⬇ Download</button>`;
    bar.firstChild.addEventListener("click", () => downloadTable(table, `${title.replace(/\s+/g, "_")}_${stamp()}.xlsx`, title));
    wrap.parentNode.insertBefore(bar, wrap);
  });
}
