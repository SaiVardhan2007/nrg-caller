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

function pagesCheckboxHtml(checkedIds) {
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
          <input type="checkbox" value="${p.id}" ${checked.has(p.id) ? "checked" : ""} /> ${escapeHtml(p.label)}
        </label>
      `).join("")}
    </div>
  `).join("");
}

let editingId = null;

function openModal(existing) {
  editingId = existing?.id || null;
  document.getElementById("limited-access-title").textContent = existing ? "Edit Limited Access Login" : "Add Limited Access Login";
  document.getElementById("limited-access-name").value = existing?.user_name || "";
  document.getElementById("limited-access-password").value = existing?.login_pw || "";
  document.getElementById("limited-access-pages").innerHTML = pagesCheckboxHtml(existing?.allowed_pages);
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
    .select("id,user_name,login_pw,allowed_pages")
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
      <td data-label="Pages">${(u.allowed_pages || []).map((id) => escapeHtml(shortLabelFor(id))).join(", ") || "—"}</td>
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
    const allowedPages = [...document.querySelectorAll("#limited-access-pages input:checked")].map((cb) => cb.value);

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

    saving = true;
    const submitBtn = document.getElementById("limited-access-submit");
    submitBtn.textContent = "Saving…";
    const payload = { user_name: name, login_pw: password, role: "Limited Admin", allowed_pages: allowedPages };
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
