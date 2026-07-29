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

// Every outgoing WhatsApp message opens with "Hare Krishna <name>" — the admin's
// template (which may still use {name} elsewhere) is just the body below it.
// `previewUrl` (see buildPosterPreviewUrl) goes right under the greeting so
// WhatsApp's link-unfurler picks it first and renders the poster as a big
// photo card, on every device — no share sheet, no OS-level file API needed.
// (A bare image URL doesn't get this treatment from WhatsApp — only a page
// declaring real Open Graph tags does, which is what that endpoint serves.)
export function buildMessage(name, template, previewUrl) {
  const body = (template || "").replace(/\{name\}/g, name);
  const greeting = previewUrl ? `Hare Krishna ${name}\n${previewUrl}` : `Hare Krishna ${name}`;
  return `${greeting}\n\n${body}`;
}

// The /api/poster-preview endpoint reads the current poster live from Supabase
// on every request, so no re-upload is needed when it changes — only a
// version tag (derived from the poster's own storage path, already unique
// per upload) so WhatsApp's own link-preview cache treats a new poster as a
// new URL instead of serving a stale thumbnail.
export function buildPosterPreviewUrl(posterUrl) {
  if (!posterUrl) return "";
  const version = encodeURIComponent(posterUrl.split("/").pop());
  return `${window.location.origin}/api/poster-preview?v=${version}`;
}

// A real attached photo (image on top, full caption below, no link/card chrome)
// only happens via a genuine media share — that's the native share sheet on
// phones (where callers actually send from). The caption is the plain message
// with no extra link line, since the photo itself is already attached.
// Falls back to the /api/poster-preview link-card when file-sharing isn't
// supported (desktop) — same message text, just with the preview link inserted.
export async function sendWhatsAppMessage(mob, name, template, imageUrl) {
  if (imageUrl && navigator.canShare) {
    try {
      const resp = await fetch(imageUrl);
      const blob = await resp.blob();
      const file = new File([blob], "poster.jpg", { type: blob.type || "image/jpeg" });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: buildMessage(name, template) });
        return true;
      }
    } catch (err) {
      if (err?.name === "AbortError") return false; // user backed out of the share sheet
      console.error("Image share failed, falling back to WhatsApp link preview:", err);
    }
  }
  const text = buildMessage(name, template, imageUrl ? buildPosterPreviewUrl(imageUrl) : "");
  window.open(waHref(mob, text), "_blank");
  return true;
}

// Downscales + re-encodes as JPEG so the poster stays well under WhatsApp's
// practical share-sheet size before it ever reaches Supabase Storage.
export async function compressImageFile(file, { maxDim = 1600, quality = 0.82, maxBytes = 900 * 1024 } = {}) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  let q = quality;
  let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
  while (blob.size > maxBytes && q > 0.4) {
    q -= 0.1;
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
  }
  return blob;
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
