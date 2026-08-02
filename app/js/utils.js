import { supabase } from "./supabaseClient.js";

export function formatPhone(mob) {
  const d = String(mob || "").replace(/\D/g, "");
  if (d.length !== 10) return d;
  return d.slice(0, 5) + " " + d.slice(5);
}

// Strips everything but digits, then keeps the last 10 — so pasting with a
// "+91"/"091" country code or spaces/dashes still lands on the real 10-digit
// number instead of getting cut off at whatever came first.
export function normalizePhoneInput(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
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

// Always goes straight to the contact's chat via the wa.me deep link — the
// native share sheet (real photo attach) was tried and dropped: it has no way
// to carry a contact's phone number, so WhatsApp always makes the caller
// manually pick the recipient from a chat list, which is worse than a link
// preview for callers messaging many different contacts per session.
export function sendWhatsAppMessage(mob, name, template, imageUrl) {
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

// What a nameless contact shows instead of a blank span — without it there is
// nothing on the card to double-click, so the name could never be filled in.
export const EMPTY_NAME_LABEL = "+ Add name";

// Renders the `.name-display` span for a card, handling the no-name case.
export function cardNameDisplayHtml(name) {
  return name
    ? `<span class="call-card-name name-display">${escapeHtml(name)}</span>`
    : `<span class="call-card-name name-display is-empty">${EMPTY_NAME_LABEL}</span>`;
}

// Wires the double-click-to-edit-name markup shared by the "My Calls" and
// Core Cultivation call cards (a `.call-card-name-wrap` containing a
// `.name-display` span and a `.name-edit-wrap` with `.name-edit-input` /
// `.name-save-btn` / `.name-cancel-btn`). `contact` is mutated in place on a
// successful save so the caller's already-rendered card badges (data-name
// attributes etc.) can be kept in sync by the caller if needed.
// A contact with no name shows a "+ Add name" prompt that opens the editor on
// a single click — double-clicking a blank space isn't discoverable.
export function wireCardNameEdit(card, contactId, contact) {
  const wrap = card.querySelector(".call-card-name-wrap");
  if (!wrap) return;
  const display = wrap.querySelector(".name-display");
  const editWrap = wrap.querySelector(".name-edit-wrap");
  const input = wrap.querySelector(".name-edit-input");
  const saveBtn = wrap.querySelector(".name-save-btn");
  const cancelBtn = wrap.querySelector(".name-cancel-btn");

  const startEdit = () => {
    input.value = contact.name || "";
    display.classList.add("hidden");
    editWrap.classList.remove("hidden");
    input.focus();
    input.select();
  };
  const stopEdit = () => {
    editWrap.classList.add("hidden");
    display.classList.remove("hidden");
  };

  display.addEventListener("dblclick", startEdit);
  display.addEventListener("click", () => { if (!contact.name) startEdit(); });
  cancelBtn.addEventListener("click", stopEdit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveBtn.click();
    if (e.key === "Escape") stopEdit();
  });

  saveBtn.addEventListener("click", async () => {
    const newName = input.value.trim();
    if (!newName || newName === contact.name) {
      stopEdit();
      return;
    }
    saveBtn.disabled = true;
    const { error } = await supabase.from("contacts").update({ name: newName }).eq("id", contactId);
    saveBtn.disabled = false;
    if (error) {
      showToast("Could not update name. Try again.", "error");
      return;
    }
    contact.name = newName;
    display.textContent = newName;
    display.classList.remove("is-empty");
    card.querySelectorAll("[data-name]").forEach((el) => { el.dataset.name = newName; });
    stopEdit();
    showToast("Name updated", "success");
  });
}

export const GYC_STATUS_OPTIONS = ["", "Intrested GFY", "Not Intrested GFY", "Attended GFY", "Intrested AOMC", "Not Intrested AOMC", "Attended AOMC"];

// Call-history badges in My Calls / Core Cultivation look back four weeks
// (28 days), not just the current Mon–Sun week — callers need the longer
// arc to see whether a contact has gone quiet.
export function startOfLast4Weeks() {
  const d = new Date();
  d.setDate(d.getDate() - 28);
  d.setHours(0, 0, 0, 0);
  return d;
}

// The GFY/AOMC picker on a call card. "GFY/AOMC" is the field's name, shown as
// a chip beside the control — not an option inside it, which made it read like
// a selectable value. Any value already on the contact is rendered even if it
// isn't in GYC_STATUS_OPTIONS (older records still hold retired values), so a
// caller can see what's set and only fill in the genuinely empty ones.
export function gycSelectHtml(currentValue) {
  const current = currentValue || "";
  const options = GYC_STATUS_OPTIONS.includes(current) ? GYC_STATUS_OPTIONS : [...GYC_STATUS_OPTIONS, current];
  return `
    <span class="gyc-field${current ? " is-set" : ""}">
      <span class="gyc-field-label">GFY/AOMC</span>
      <select class="gyc-select" aria-label="GFY/AOMC">
        ${options.map((o) => `<option value="${escapeHtml(o)}" ${o === current ? "selected" : ""}>${o ? escapeHtml(o) : "— not set —"}</option>`).join("")}
      </select>
    </span>`;
}

// The call-status picker, wearing the same labelled-chip shape as the other
// two card fields: "Call Status" names it while it is empty, and once a status
// is picked the name drops away so the answer alone occupies the space.
export function statusSelectHtml(options, current, category) {
  const value = current || "";
  return `
    <span class="status-field${value ? " is-set" : ""}">
      <span class="status-field-label">Call Status</span>
      <select class="status-select status-${category}" aria-label="Call status">
        ${options.map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === value ? "selected" : ""}>${o.label ? escapeHtml(o.label) : "— not set —"}</option>`).join("")}
      </select>
    </span>`;
}

// Free-text "where they work or study" for a call card. Editable by callers
// because they are the ones who find it out on the call; blank until then.
export function orgFieldHtml(currentValue) {
  const v = currentValue || "";
  return `
    <span class="org-field${v ? " is-set" : ""}">
      <span class="org-field-label">Org</span>
      <input type="text" class="org-input" value="${escapeHtml(v)}" placeholder="Company / College" aria-label="Org (company or college)" />
    </span>`;
}

// Saves an org edit and keeps `contact` and the chip styling in sync. Returns
// true when it actually wrote, so callers can decide whether to toast.
export async function saveContactOrg(input, contactId, contact) {
  const value = input.value.trim();
  if (value === (contact.company_name || "")) return false;
  const { error } = await supabase.from("contacts").update({ company_name: value || null }).eq("id", contactId);
  if (error) {
    showToast("Could not save Org: " + error.message, "error");
    input.value = contact.company_name || "";
    return false;
  }
  contact.company_name = value || null;
  input.closest(".org-field").classList.toggle("is-set", !!value);
  return true;
}

export const ADMIN_TAG_TO_USERS_OPTIONS = ["", "Don't Call", "Coordinator", "Janata", "Call", "Core", "Assigned"];

// Contacts tagged "Coordinator" (admin_tag_to_users) are meant to appear as
// login accounts on the Users & Assignment page — this keeps that in sync
// both ways: tagging in adds them there, un-tagging removes the account this
// created. Matched by phone (login_pw doubles as the contact's phone for
// these accounts, same link initUserOneToOne relies on). Shared by Master
// Contacts (admin.js) and Reception's Today's Attendance (reception.js).
export async function syncCoordinatorUser(contact, tagValue) {
  const { data: existing } = await supabase.from("users").select("id,role").eq("login_pw", contact.mob_no).maybeSingle();
  if (tagValue === "Coordinator") {
    if (existing) {
      if (existing.role !== "Coordinator") {
        await supabase.from("users").update({ role: "Coordinator", user_name: contact.name }).eq("id", existing.id);
      }
    } else {
      const { error } = await supabase.from("users").insert({
        user_name: contact.name, login_pw: contact.mob_no, role: "Coordinator", auto_assign: true,
      });
      if (error) showToast("Tagged as Coordinator, but couldn't add to Users: " + error.message, "warning");
    }
  } else if (existing && existing.role === "Coordinator") {
    await supabase.from("users").delete().eq("id", existing.id);
  }
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ============ Excel import / export ============ */

// `rows` is an array-of-arrays (first row = headers). Downloads a single-sheet .xlsx workbook.
export function downloadExcel(filename, rows, sheetName = "Sheet1") {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

// exports a rendered <table class="data-table"> as-is (header labels + current cell text) —
// used for read-only/computed views where there's no separate underlying data array to export from.
export function exportTableToExcel(table, filename) {
  const rows = [];
  rows.push(Array.from(table.querySelectorAll("thead th:not(.no-export)")).map((th) => th.textContent.trim()));
  table.querySelectorAll("tbody tr").forEach((tr) => {
    rows.push(Array.from(tr.children).filter((td) => !td.classList.contains("no-export")).map((td) => {
      const field = td.querySelector("input, select");
      if (field) return field.value;
      return td.textContent.trim();
    }));
  });
  downloadExcel(filename, rows);
}

// minimal RFC4180-ish CSV parser: handles quoted fields with embedded commas/newlines/escaped quotes.
// still used for importing bulk contacts from pasted/uploaded CSV — see parseCSV callers.
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
