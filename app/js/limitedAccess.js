import { supabase } from "./supabaseClient.js";
import { showToast, escapeHtml } from "./utils.js";

// Every admin-side page a "Limited Admin" login can be restricted to. Regular
// user-facing sections (My Calls, Reception, etc.) are deliberately left out —
// this feature is for handing out narrow *admin panel* access, not for
// creating regular Coordinator/Reception logins (the existing Add User modal
// already covers those). "admin-limited-access-section" itself is excluded on
// purpose: a limited login should never be able to grant itself (or anyone
// else) more access.
export const RESTRICTABLE_PAGES = [
  { module: "Users & Assignment", id: "admin-users-section", label: "Users & Assignment" },
  { module: "Users & Assignment", id: "admin-contacts-section", label: "Master Contact" },
  { module: "Users & Assignment", id: "admin-new-contacts-section", label: "New Contacts" },
  { module: "Users & Assignment", id: "admin-message-section", label: "Message" },
  { module: "Users & Assignment", id: "admin-analytics-section", label: "Analytics" },
  { module: "Users & Assignment", id: "admin-reception-analytics-section", label: "Reception Analytics" },
  { module: "Users & Assignment", id: "admin-one-to-one-section", label: "One to One" },
  { module: "Book Distribution", id: "book-dashboard-section", label: "Dashboard" },
  { module: "Book Distribution", id: "book-inward-section", label: "Inward Stock" },
  { module: "Book Distribution", id: "book-outward-section", label: "Outward Stock" },
  { module: "Book Distribution", id: "book-places-section", label: "Distribution Places" },
  { module: "Book Distribution", id: "book-events-section", label: "Events" },
  { module: "Book Distribution", id: "book-requests-section", label: "Book Requests" },
  { module: "Book Distribution", id: "book-savings-user-section", label: "Tīrtha Nidhi" },
  { module: "Book Distribution", id: "book-analytics-section", label: "Analytics" },
  { module: "Book Distribution", id: "book-expenses-section", label: "Expenses" },
  { module: "FNRG Sadhana", id: "admin-sadhana-section", label: "FNRG Sadhana" },
  { module: "FNRG Sadhana", id: "sadhana-users-section", label: "Users" },
  { module: "FNRG Sadhana", id: "sadhana-analytics-section", label: "Analytics" },
  { module: "Donations", id: "donations-dashboard-section", label: "Dashboard" },
  { module: "Donations", id: "donations-transactions-section", label: "Transactions" },
  { module: "Donations", id: "donations-events-section", label: "Events" },
  { module: "Donations", id: "donations-analytics-section", label: "Analytics" },
  { module: "Expenses", id: "expenses-trip-section", label: "Trip Expenses" },
  { module: "Expenses", id: "expenses-preaching-section", label: "Preaching" },
  { module: "Expenses", id: "expenses-residency-section", label: "Residency Expenses" },
];

const PAGE_BY_ID = new Map(RESTRICTABLE_PAGES.map((p) => [p.id, p]));

export function shortLabelFor(id) {
  return PAGE_BY_ID.get(id)?.label || id;
}

export function tabLabelFor(id) {
  const p = PAGE_BY_ID.get(id);
  return p ? `${p.module} · ${p.label}` : id;
}

// Trip Expenses' page checkbox gets a nested sub-list so a Limited Admin can
// be scoped to specific trip_events instead of every trip (see
// allowed_trip_events on the users row). "All trip events" checked (the
// default, incl. for existing logins from before this existed) means no
// restriction — allowed_trip_events is stored as null.
function tripEventsSubHtml(tripEvents, allowedTripEvents) {
  const allSelected = !Array.isArray(allowedTripEvents);
  const checked = new Set(allowedTripEvents || []);
  return `
    <div class="limited-access-trip-events-group">
      <label class="tag-check">
        <input type="checkbox" id="limited-access-trip-events-all" class="trip-event-all-cb" ${allSelected ? "checked" : ""} /> All trip events
      </label>
      <div id="limited-access-trip-events-list" class="limited-access-trip-events-list ${allSelected ? "hidden" : ""}">
        ${tripEvents.length ? tripEvents.map((e) => `
          <label class="tag-check">
            <input type="checkbox" class="trip-event-item-cb" value="${e.id}" ${checked.has(e.id) ? "checked" : ""} /> ${escapeHtml(e.name)}
          </label>
        `).join("") : `<span class="muted-text">No trip events yet.</span>`}
      </div>
    </div>
  `;
}

function pagesCheckboxHtml(checkedIds, tripEvents, allowedTripEvents) {
  const checked = new Set(checkedIds || []);
  const byModule = new Map();
  RESTRICTABLE_PAGES.forEach((p) => {
    if (!byModule.has(p.module)) byModule.set(p.module, []);
    byModule.get(p.module).push(p);
  });
  return [...byModule.entries()].map(([module, pages]) => `
    <div class="limited-access-module-group">
      <div class="limited-access-module-title">${escapeHtml(module)}</div>
      ${pages.map((p) => `
        <label class="tag-check">
          <input type="checkbox" class="page-permission-cb" value="${p.id}" ${checked.has(p.id) ? "checked" : ""} /> ${escapeHtml(p.label)}
        </label>
        ${p.id === "expenses-trip-section" ? tripEventsSubHtml(tripEvents || [], allowedTripEvents) : ""}
      `).join("")}
    </div>
  `).join("");
}

let editingId = null;

async function openModal(existing) {
  editingId = existing?.id || null;
  document.getElementById("limited-access-title").textContent = existing ? "Edit Limited Access Login" : "Add Limited Access Login";
  document.getElementById("limited-access-name").value = existing?.user_name || "";
  document.getElementById("limited-access-password").value = existing?.login_pw || "";

  const { data: tripEvents } = await supabase.from("trip_events").select("id,name").order("created_at", { ascending: false });
  document.getElementById("limited-access-pages").innerHTML = pagesCheckboxHtml(existing?.allowed_pages, tripEvents || [], existing?.allowed_trip_events);

  const allCb = document.getElementById("limited-access-trip-events-all");
  const listEl = document.getElementById("limited-access-trip-events-list");
  allCb?.addEventListener("change", () => listEl.classList.toggle("hidden", allCb.checked));

  document.getElementById("limited-access-error").classList.add("hidden");
  document.getElementById("limited-access-modal").classList.add("active");
}

function closeModal() {
  document.getElementById("limited-access-modal").classList.remove("active");
}

async function renderLimitedAccessTable() {
  const tbody = document.getElementById("limited-access-table-body");
  tbody.innerHTML = `<tr><td colspan="5" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("users")
    .select("id,user_name,login_pw,allowed_pages,allowed_trip_events")
    .eq("role", "Limited Admin")
    .order("user_name");

  if (error) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading-row">Could not load logins.</td></tr>`;
    return;
  }
  if (!data || !data.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading-row">No limited-access logins yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.map((u, i) => `
    <tr data-id="${u.id}">
      <td data-label="S.No">${i + 1}</td>
      <td data-label="User ID"><strong>${escapeHtml(u.user_name || "")}</strong></td>
      <td data-label="Password">${escapeHtml(u.login_pw || "")}</td>
      <td data-label="Pages">${(u.allowed_pages || []).map((id) => {
        const label = escapeHtml(shortLabelFor(id));
        if (id === "expenses-trip-section" && Array.isArray(u.allowed_trip_events)) {
          return `${label} (${u.allowed_trip_events.length} event${u.allowed_trip_events.length === 1 ? "" : "s"})`;
        }
        return label;
      }).join(", ") || "—"}</td>
      <td data-label="">
        <button class="btn btn-link edit-limited-access-btn">Edit</button>
        <button class="btn btn-link delete-limited-access-btn">Delete</button>
      </td>
    </tr>
  `).join("");

  const rowsById = new Map(data.map((u) => [String(u.id), u]));

  tbody.querySelectorAll(".edit-limited-access-btn").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.closest("tr").dataset.id;
      openModal(rowsById.get(id));
    };
  });

  tbody.querySelectorAll(".delete-limited-access-btn").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.closest("tr").dataset.id;
      const u = rowsById.get(id);
      if (!confirm(`Remove login "${u?.user_name || ""}"?`)) return;
      await supabase.from("users").delete().eq("id", id);
      renderLimitedAccessTable();
    };
  });
}

function wireLimitedAccessModal() {
  document.getElementById("limited-access-add-btn").onclick = () => openModal(null);
  document.getElementById("limited-access-cancel").onclick = closeModal;
  document.getElementById("limited-access-modal").onclick = (e) => {
    if (e.target.id === "limited-access-modal") closeModal();
  };

  let saving = false;
  document.getElementById("limited-access-submit").onclick = async () => {
    if (saving) return;
    const errorEl = document.getElementById("limited-access-error");
    const name = document.getElementById("limited-access-name").value.trim();
    const password = document.getElementById("limited-access-password").value.trim();
    const allowedPages = [...document.querySelectorAll("#limited-access-pages input.page-permission-cb:checked")].map((cb) => cb.value);

    if (!name || !password) {
      errorEl.textContent = "Please enter a User ID and Password.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (!allowedPages.length) {
      errorEl.textContent = "Select at least one page.";
      errorEl.classList.remove("hidden");
      return;
    }

    // null = no restriction (every trip event); an array scopes Trip
    // Expenses down to just those event ids.
    let allowedTripEvents = null;
    if (allowedPages.includes("expenses-trip-section")) {
      const allCb = document.getElementById("limited-access-trip-events-all");
      if (allCb && !allCb.checked) {
        allowedTripEvents = [...document.querySelectorAll(".trip-event-item-cb:checked")].map((cb) => cb.value);
        if (!allowedTripEvents.length) {
          errorEl.textContent = "Select at least one trip event, or check \"All trip events\".";
          errorEl.classList.remove("hidden");
          return;
        }
      }
    }

    saving = true;
    const submitBtn = document.getElementById("limited-access-submit");
    submitBtn.textContent = "Saving…";
    const payload = { user_name: name, login_pw: password, role: "Limited Admin", allowed_pages: allowedPages, allowed_trip_events: allowedTripEvents };
    const { error } = editingId
      ? await supabase.from("users").update(payload).eq("id", editingId)
      : await supabase.from("users").insert(payload);
    saving = false;
    submitBtn.textContent = "Save";

    if (error) {
      errorEl.textContent = error.message.includes("duplicate") ? "This User ID already exists." : error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    closeModal();
    showToast(editingId ? "Login updated" : "Login created", "success");
    renderLimitedAccessTable();
  };
}

export async function initLimitedAccess() {
  await renderLimitedAccessTable();
  wireLimitedAccessModal();
}
