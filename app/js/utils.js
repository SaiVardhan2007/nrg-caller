export function formatPhone(mob) {
  const d = String(mob || "").replace(/\D/g, "");
  if (d.length !== 10) return d;
  return d.slice(0, 5) + " " + d.slice(5);
}

export function telHref(mob) {
  return "tel:+91" + String(mob || "").replace(/\D/g, "");
}

export function waHref(mob, text) {
  const d = String(mob || "").replace(/\D/g, "");
  return "https://wa.me/91" + d + (text ? "?text=" + encodeURIComponent(text) : "");
}

export function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function timeHM(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

let toastTimer = null;
export function showToast(message, kind = "success", duration = 3200) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = "toast";
  }, duration);
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ============ CSV import / export ============ */

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function downloadCSV(filename, rows) {
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// exports a rendered <table class="data-table"> as-is (header labels + current cell text) —
// used for read-only/computed views where there's no separate underlying data array to export from.
export function exportTableToCSV(table, filename) {
  const rows = [];
  rows.push(Array.from(table.querySelectorAll("thead th:not(.no-export)")).map((th) => th.textContent.trim()));
  table.querySelectorAll("tbody tr").forEach((tr) => {
    rows.push(Array.from(tr.children).filter((td) => !td.classList.contains("no-export")).map((td) => {
      const field = td.querySelector("input, select");
      if (field) return field.value;
      return td.textContent.trim();
    }));
  });
  downloadCSV(filename, rows);
}

// minimal RFC4180-ish CSV parser: handles quoted fields with embedded commas/newlines/escaped quotes.
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushField(); pushRow();
    } else if (c === "\r") {
      // skip, \n handles the row break
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { pushField(); pushRow(); }

  const filtered = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (!filtered.length) return [];
  const headers = filtered[0].map((h) => h.trim());
  return filtered.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] ?? "").trim(); });
    return obj;
  });
  });
}

export function copyToClipboard(text, element) {
  navigator.clipboard.writeText(text).then(() => {
    // Show a floating "Copied!" badge near the element
    const rect = element.getBoundingClientRect();
    const badge = document.createElement("div");
    badge.className = "copied-badge";
    badge.textContent = "Copied!";
    badge.style.position = "fixed"; // Fixed positioning avoids page scroll alignment offsets
    badge.style.top = `${rect.top - 28}px`;
    badge.style.left = `${rect.left + rect.width / 2}px`;
    badge.style.transform = "translateX(-50%)";
    badge.style.background = "#10b981";
    badge.style.color = "#ffffff";
    badge.style.padding = "3px 8px";
    badge.style.borderRadius = "4px";
    badge.style.fontSize = "11px";
    badge.style.fontWeight = "bold";
    badge.style.zIndex = "99999";
    badge.style.pointerEvents = "none";
    badge.style.opacity = "0";
    badge.style.transition = "opacity 0.2s ease, transform 0.2s ease";
    document.body.appendChild(badge);

    // trigger transition
    setTimeout(() => {
      badge.style.opacity = "1";
      badge.style.transform = "translateX(-50%) translateY(-3px)";
    }, 10);

    // remove after 1.2s
    setTimeout(() => {
      badge.style.opacity = "0";
      badge.style.transform = "translateX(-50%) translateY(-8px)";
      setTimeout(() => badge.remove(), 200);
    }, 1000);
  }).catch(err => {
    console.error("Clipboard copy failed: ", err);
  });
}
