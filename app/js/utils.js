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
export function buildMessage(name, template) {
  const body = (template || "").replace(/\{name\}/g, name);
  return `Hare Krishna ${name}\n\n${body}`;
}

// Always goes straight to the contact's chat via the wa.me deep link, which
// carries text only. Attaching a poster was tried two ways and both are gone:
// the native share sheet can't carry a phone number (WhatsApp makes the caller
// pick the recipient by hand), and the link-preview card cluttered the message.
export function sendWhatsAppMessage(mob, name, template) {
  window.open(waHref(mob, buildMessage(name, template)), "_blank");
  return true;
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

/* ============ Autocorrect ============ */

// Deliberately small and conservative: only known, unambiguous typos get fixed
// as-you-type. Names and anything else not in this list are left alone for the
// browser's native spellcheck (red underline) to flag instead.
const AUTOCORRECT_MAP = {
  thers: "there", teh: "the", hte: "the", adn: "and", nad: "and", taht: "that",
  wnat: "want", cant: "can't", dont: "don't", wont: "won't", didnt: "didn't",
  doesnt: "doesn't", isnt: "isn't", wasnt: "wasn't", arent: "aren't",
  im: "I'm", ive: "I've", youre: "you're", theyre: "they're", weve: "we've",
  becuase: "because", becasue: "because", becouse: "because",
  recieve: "receive", recieved: "received", recieving: "receiving",
  seperate: "separate", definately: "definitely", definetely: "definitely",
  occured: "occurred", untill: "until", wich: "which",
  cud: "could", shud: "should", wud: "would",
  tommorow: "tomorrow", alot: "a lot",
  thankyou: "thank you", plz: "please", pls: "please",
};

// Wires "typo → correction" replacement on a text input/textarea: as soon as a
// word boundary (space or punctuation) is typed, the word right before it is
// looked up in AUTOCORRECT_MAP and swapped in-place, case-matched to what was
// typed. Only fires on real typing (inputType "insertText") so IME composition,
// paste, and programmatic value changes are left untouched.
export function enableWordAutocorrect(el) {
  el.addEventListener("input", (e) => {
    if (e.inputType !== "insertText" || !e.data || !/[\s.,!?;:)]/.test(e.data)) return;
    const cursor = el.selectionStart;
    const boundaryIndex = cursor - 1;
    if (boundaryIndex < 0) return;
    const value = el.value;
    const match = value.slice(0, boundaryIndex).match(/[A-Za-z']+$/);
    if (!match) return;
    const word = match[0];
    const fix = AUTOCORRECT_MAP[word.toLowerCase()];
    if (!fix) return;
    const corrected = word[0] === word[0].toUpperCase() ? fix[0].toUpperCase() + fix.slice(1) : fix;
    const wordStart = boundaryIndex - word.length;
    el.value = value.slice(0, wordStart) + corrected + value.slice(boundaryIndex);
    const newCursor = wordStart + corrected.length + 1;
    el.setSelectionRange(newCursor, newCursor);
  });
}

/* ============ Column drag-reorder ============ */

// Lets a user drag any <th> to reorder its column, spreadsheet-style, on any
// table. Order is persisted per table in localStorage and survives tbody
// re-renders — call reapplyColumnOrder(tableId) after replacing tbody.innerHTML
// so freshly rendered rows pick up whatever order was saved. Columns are
// matched between <th> and <td> by data-label (falling back to trimmed text
// content), so most tables need no markup changes beyond a stable table id.
const columnReorderState = new Map(); // tableId -> { getOrder, applyOrder }

function columnKeyOf(cell) {
  if (cell.dataset.label) return cell.dataset.label;
  // Filterable <th> cells hold a ".th-label" div beside the actual filter
  // control (a <select>/<input>) — textContent alone would pull in the
  // filter's option text too, so it's checked ahead of the plain fallback.
  const label = cell.querySelector(".th-label");
  if (label) return label.textContent.trim();
  return cell.textContent.trim();
}

// opts.columns lets a caller pin an explicit default order (and storage
// shape) instead of deriving one from the DOM — used where a column was
// already excluded from an existing saved order and must stay excluded.
// opts.force re-wires even if this table id was already wired — needed for
// a table whose <thead> is swapped for a different column set at runtime
// (e.g. one modal table reused across several "kinds" of data).
export function initColumnDragReorder(tableId, opts = {}) {
  const table = document.getElementById(tableId);
  if (!table || (table.dataset.colDragWired && !opts.force)) return;
  table.dataset.colDragWired = "1";
  const headRow = table.querySelector("thead tr");
  if (!headRow) return;

  const storageKey = opts.storageKey || `nrg-col-order:${tableId}`;
  const defaultOrder = opts.columns || Array.from(headRow.children).map(columnKeyOf);

  const getOrder = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (Array.isArray(saved) && saved.length === defaultOrder.length && defaultOrder.every((k) => saved.includes(k))) {
        return saved;
      }
    } catch { /* fall through to default */ }
    return defaultOrder;
  };

  const applyOrder = (order) => {
    const rows = [headRow, ...table.querySelectorAll("tbody tr")];
    rows.forEach((row) => {
      const byKey = new Map(Array.from(row.children).map((cell) => [columnKeyOf(cell), cell]));
      order.forEach((key) => {
        const cell = byKey.get(key);
        if (cell) row.appendChild(cell);
      });
    });
  };

  columnReorderState.set(tableId, { getOrder, applyOrder });

  let dragKey = null;
  headRow.querySelectorAll("th").forEach((th) => {
    const label = columnKeyOf(th);
    if (!label || th.classList.contains("no-export") || th.classList.contains("select-col")) return;
    th.draggable = true;
    th.classList.add("col-draggable");
    th.addEventListener("dragstart", () => {
      dragKey = label;
      th.classList.add("dragging-col");
    });
    th.addEventListener("dragend", () => {
      th.classList.remove("dragging-col");
      headRow.querySelectorAll("th").forEach((t) => t.classList.remove("drag-over-col"));
    });
    th.addEventListener("dragover", (e) => e.preventDefault());
    th.addEventListener("dragenter", () => th.classList.add("drag-over-col"));
    th.addEventListener("dragleave", () => th.classList.remove("drag-over-col"));
    th.addEventListener("drop", (e) => {
      e.preventDefault();
      th.classList.remove("drag-over-col");
      const dropKey = label;
      if (!dragKey || dragKey === dropKey) return;

      const order = getOrder().slice();
      const from = order.indexOf(dragKey);
      const to = order.indexOf(dropKey);
      if (from === -1 || to === -1) return;
      order.splice(from, 1);
      order.splice(to, 0, dragKey);
      localStorage.setItem(storageKey, JSON.stringify(order));
      applyOrder(order);
    });
  });

  applyOrder(getOrder());

  if (opts.resetBtnId) {
    const btn = document.getElementById(opts.resetBtnId);
    if (btn) {
      btn.addEventListener("click", () => {
        localStorage.removeItem(storageKey);
        applyOrder(defaultOrder);
        showToast("Column order reset", "success");
      });
    }
  }
}

// Re-applies a table's saved column order after its tbody has been
// re-rendered. No-op if the table hasn't been wired via initColumnDragReorder.
export function reapplyColumnOrder(tableId) {
  const state = columnReorderState.get(tableId);
  if (state) state.applyOrder(state.getOrder());
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
