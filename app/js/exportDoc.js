import { showToast, escapeHtml } from "./utils.js";
import { exportColumnLayout } from "./columnLayout.js";

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

// Shows the sheet the way it will print; its two buttons do the real download.
export function downloadSpec(spec) {
  wirePreviewModal();
  if (!spec.rows.length) {
    showToast("Nothing to download yet.", "error");
    return;
  }
  // saved column widths / margins (⇔ Columns) carry into the preview, Excel and PDF
  spec.layout = spec.layoutTableId ? exportColumnLayout(spec.layoutTableId) : null;
  previewSpec = spec;
  const colgroup = spec.layout
    ? `<colgroup>${(() => {
        const ws = spec.headers.map((h) => spec.layout[h]?.w || 100);
        const tot = ws.reduce((a, b) => a + b, 0);
        return ws.map((w) => `<col style="width:${((w / tot) * 100).toFixed(2)}%">`).join("");
      })()}</colgroup>`
    : "";
  const head = spec.headers.map((h, i) => `<th class="${isCentered(spec, i) ? "c" : ""}">${escapeHtml(h)}</th>`).join("");
  const shown = spec.rows.slice(0, PREVIEW_MAX);
  const body = shown.map((r) => `<tr>${r.map((v, i) => `<td class="${isCentered(spec, i) ? "c" : ""}">${escapeHtml(String(v ?? ""))}</td>`).join("")}</tr>`).join("");
  $("yatra-preview-sheet").innerHTML = `
    <h4 class="yatra-paper-title">${escapeHtml(spec.title)}</h4>
    ${spec.subtitle ? `<p class="yatra-paper-sub">${escapeHtml(spec.subtitle)}</p>` : ""}
    <p class="yatra-paper-meta">Generated ${escapeHtml(generatedStamp())} &nbsp;·&nbsp; ${spec.rows.length} row${spec.rows.length === 1 ? "" : "s"}</p>
    <table class="yatra-paper-table"${spec.layout ? ' style="table-layout:fixed"' : ""}>${colgroup}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${spec.rows.length > PREVIEW_MAX ? `<p class="yatra-paper-meta">Preview shows the first ${PREVIEW_MAX} of ${spec.rows.length} rows — the downloaded file has all of them.</p>` : ""}`;
  $("yatra-preview-modal").classList.add("active");
}

function downloadXlsx(spec) {
  const last = spec.headers.length - 1;
  const top = spec.subtitle ? [[spec.title], [spec.subtitle], [`Generated ${generatedStamp()}`]] : [[spec.title], [`Generated ${generatedStamp()}`]];
  // a plain Excel cell can't show the two-line day, so join it with a comma there
  const dayCol = spec.headers.indexOf("Day & Date");
  const rows = dayCol < 0 ? spec.rows : spec.rows.map((r) => r.map((v, i) => (i === dayCol ? String(v ?? "").replace("\n", ", ") : v)));
  const ws = XLSX.utils.aoa_to_sheet([...top, [], spec.headers, ...rows]);
  ws["!merges"] = top.map((_, r) => ({ s: { r, c: 0 }, e: { r, c: last } }));
  ws["!cols"] = spec.headers.map((h, c) => ({
    wch: spec.layout?.[h] ? Math.max(4, Math.round(spec.layout[h].w / 7)) : Math.min(50, Math.max(8, String(h).length + 2, ...spec.rows.map((r) => String(r[c] ?? "").length + 2))),
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
  // optional fixed widths per header (pt); one "fill" column takes whatever is left
  const fixed = Object.values(spec.pdfColumns || {}).filter((w) => typeof w === "number").reduce((a, b) => a + b, 0);
  const dense = spec.headers.length > 10;
  // saved on-screen widths / margins, scaled to fit the page width
  const lw = spec.layout ? spec.headers.map((h) => spec.layout[h]?.w || 100) : null;
  const k = lw ? (W - 2 * M) / lw.reduce((a, b) => a + b, 0) : 1;
  spec.headers.forEach((h, i) => {
    columnStyles[i] = isCentered(spec, i) ? { halign: "center" } : {};
    if (h === "S.No") columnStyles[i].cellWidth = 44;
    const w = spec.pdfColumns?.[h];
    if (w) columnStyles[i].cellWidth = w === "fill" ? W - 2 * M - fixed : w;
    if (lw) {
      const padV = dense ? 3 : 6;
      const padH = Math.max(1.5, (spec.layout[h]?.m ?? 8) * k);
      columnStyles[i].cellWidth = lw[i] * k;
      columnStyles[i].cellPadding = { top: padV, bottom: padV, left: padH, right: padH };
    }
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
    didParseCell: (d) => { if (d.section === "head" && isCentered(spec, d.column.index)) d.cell.styles.halign = "center"; },
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
  $("yatra-preview-close-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
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
