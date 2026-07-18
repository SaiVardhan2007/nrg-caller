import { supabase } from "./supabaseClient.js";
import { showToast, formatPhone, escapeHtml } from "./utils.js";
import { STORAGE_BUCKET } from "./config.js";

let eventsCache = [];
let usersCache = [];
let eventsLoaded = false;

async function loadEvents() {
  if (eventsLoaded) return eventsCache;
  const { data, error } = await supabase.from("events").select("code,name").order("code");
  if (!error) eventsCache = data || [];
  eventsLoaded = true;
  return eventsCache;
}

function fillEventSelect(select, selectedCode) {
  select.innerHTML = eventsCache
    .map((e) => `<option value="${e.code}">${e.name} (${e.code})</option>`)
    .join("");
  if (selectedCode) select.value = selectedCode;
}

async function getSetting(key) {
  const { data } = await supabase.from("settings").select("value").eq("key", key).single();
  return data ? data.value : "";
}

async function setSetting(key, value) {
  await supabase.from("settings").upsert({ key, value });
}

/* ======================= USERS & ASSIGNMENT ======================= */

function getCheckedTags(tagFilterGroup) {
  return Array.from(tagFilterGroup.querySelectorAll("input:checked")).map((cb) => cb.value);
}

export async function initUsers() {
  const eventSelect = document.getElementById("event-select");
  const tagFilterGroup = document.getElementById("tag-filter-group");

  // these five round-trips are all independent — run them together instead
  // of one after another, since that was adding ~2s to this page's load.
  const [, currentEvent, tagFilterValue] = await Promise.all([
    loadEvents(),
    getSetting("current_event"),
    getSetting("tag_filter"),
    renderUsersTable(),
  ]);
  fillEventSelect(eventSelect, currentEvent);
  const savedTags = (tagFilterValue || "").split(",").map((t) => t.trim()).filter(Boolean);
  tagFilterGroup.querySelectorAll("input").forEach((cb) => { cb.checked = savedTags.includes(cb.value); });

  wireAssignButton(eventSelect, tagFilterGroup);
  wireAddUserModal();
  wireAddEventModal();
}

let addEventModalWired = false;
function wireAddEventModal() {
  if (addEventModalWired) return;
  addEventModalWired = true;
  const modal = document.getElementById("add-event-modal");

  document.getElementById("add-event-btn").onclick = () => {
    document.getElementById("add-event-code").value = "";
    document.getElementById("add-event-name").value = "";
    document.getElementById("add-event-error").classList.add("hidden");
    modal.classList.add("active");
  };
  document.getElementById("add-event-cancel").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("add-event-submit").onclick = async () => {
    const code = document.getElementById("add-event-code").value.trim().toUpperCase();
    const name = document.getElementById("add-event-name").value.trim();
    const errorEl = document.getElementById("add-event-error");
    if (!code || !name) {
      errorEl.textContent = "Please enter both a code and a display name.";
      errorEl.classList.remove("hidden");
      return;
    }
    const { error } = await supabase.from("events").insert({ code, name });
    if (error) {
      errorEl.textContent = error.message.includes("duplicate") ? "An event with this code already exists." : error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    eventsLoaded = false;
    await loadEvents();
    fillEventSelect(document.getElementById("event-select"), code);
    modal.classList.remove("active");
    showToast("Event added", "success");
  };
}

async function renderUsersTable() {
  const tbody = document.getElementById("users-table-body");
  tbody.innerHTML = `<tr><td colspan="6" class="loading-row">Loading users…</td></tr>`;

  const { data: users, error } = await supabase
    .from("users")
    .select("id,user_name,role,call_limit,auto_assign")
    .order("user_name");
  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="loading-row">Could not load users.</td></tr>`;
    return;
  }
  usersCache = users || [];

  const { data: assignments } = await supabase.from("assignments").select("user_name");
  const counts = {};
  (assignments || []).forEach((a) => { counts[a.user_name] = (counts[a.user_name] || 0) + 1; });

  if (!usersCache.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="loading-row">No users yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = usersCache.map((u) => `
    <tr data-id="${u.id}" data-label-row>
      <td data-label="User Name"><strong>${u.user_name}</strong></td>
      <td data-label="Role">${u.role}</td>
      <td data-label="Call Limit">
        <input type="number" min="0" class="limit-input" value="${u.call_limit ?? ""}" placeholder="No limit" ${u.role !== "User" ? "disabled" : ""} />
      </td>
      <td data-label="Assigned Count" class="assigned-count">${counts[u.user_name] || 0}</td>
      <td data-label="Auto Assign">
        <input type="checkbox" class="auto-assign-input" ${u.auto_assign ? "checked" : ""} ${u.role !== "User" ? "disabled" : ""} />
      </td>
      <td data-label="">
        <button class="btn btn-link delete-user-btn">Delete</button>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".limit-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const val = e.target.value === "" ? null : parseInt(e.target.value, 10);
      await supabase.from("users").update({ call_limit: val }).eq("id", id);
      showToast("Call limit updated", "success");
    });
  });

  tbody.querySelectorAll(".auto-assign-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      await supabase.from("users").update({ auto_assign: e.target.checked }).eq("id", id);
      showToast("Auto assign updated", "success");
    });
  });

  tbody.querySelectorAll(".delete-user-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const row = e.target.closest("tr");
      const id = row.dataset.id;
      if (!confirm("Remove this user?")) return;
      await supabase.from("users").delete().eq("id", id);
      renderUsersTable();
    });
  });
}

function wireAssignButton(eventSelect, tagFilterGroup) {
  const btn = document.getElementById("assign-btn");
  const summary = document.getElementById("assign-summary");
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Assigning…";
    try {
      const eventCode = eventSelect.value;
      const tagFilters = getCheckedTags(tagFilterGroup);
      await setSetting("current_event", eventCode);
      await setSetting("tag_filter", tagFilters.join(", "));

      // 1. snapshot the outgoing round's per-user counts before wiping, so
      // admin analytics can still answer "how many did X get assigned last
      // time" for an event after it's no longer the active one.
      const { data: outgoing } = await supabase.from("assignments").select("user_name,event_code");
      if (outgoing && outgoing.length) {
        const outgoingCounts = {};
        outgoing.forEach((a) => {
          const key = a.user_name + "|" + a.event_code;
          outgoingCounts[key] = (outgoingCounts[key] || 0) + 1;
        });
        const roundRows = Object.entries(outgoingCounts).map(([key, count]) => {
          const [user_name, event_code] = key.split("|");
          return { user_name, event_code, assigned_count: count };
        });
        await supabase.from("assignment_rounds").insert(roundRows);
      }

      // 2. wipe previous temporary assignments (event switch clears the board)
      await supabase.from("assignments").delete().neq("id", "00000000-0000-0000-0000-000000000000");

      // 3. fetch the pool for this event (minus Don't Call, optional tag filter)
      // admin_tag is nullable: a plain .neq() would silently drop untagged rows
      // (SQL NULL != 'x' is NULL, not true), so untagged contacts must be let through explicitly.
      let query = supabase
        .from("contacts")
        .select("id,core_cultivation,admin_tag")
        .eq("calling_purpose", eventCode)
        .or("admin_tag.is.null,admin_tag.neq.Don't Call");
      if (tagFilters.length) query = query.in("admin_tag", tagFilters);
      const { data: pool, error: poolErr } = await query;
      if (poolErr) throw poolErr;

      // 4. eligible users — re-fetch fresh, since usersCache can be stale if a
      // limit/auto-assign checkbox was toggled without a page reload since then.
      const { data: freshUsers, error: usersErr } = await supabase
        .from("users")
        .select("id,user_name,role,call_limit,auto_assign");
      if (usersErr) throw usersErr;
      usersCache = freshUsers || [];
      const eligible = usersCache.filter((u) => u.role === "User" && u.auto_assign);
      const assignedCount = {};
      eligible.forEach((u) => { assignedCount[u.user_name] = 0; });
      const byName = Object.fromEntries(eligible.map((u) => [u.user_name, u]));

      const rows = [];
      const remaining = [];

      // 4a. core-cultivated contacts go to their cultivator first (counts toward their limit)
      for (const c of pool || []) {
        if (c.core_cultivation && byName[c.core_cultivation]) {
          rows.push({ contact_id: c.id, user_name: c.core_cultivation, event_code: eventCode });
          assignedCount[c.core_cultivation]++;
        } else {
          remaining.push(c);
        }
      }

      // 4b. limited users fill their remaining capacity first
      const limited = eligible.filter((u) => u.call_limit != null);
      const unlimited = eligible.filter((u) => u.call_limit == null);
      let idx = 0;
      for (const u of limited) {
        const capacity = u.call_limit - assignedCount[u.user_name];
        for (let i = 0; i < capacity && idx < remaining.length; i++) {
          rows.push({ contact_id: remaining[idx].id, user_name: u.user_name, event_code: eventCode });
          assignedCount[u.user_name]++;
          idx++;
        }
      }

      // 4c. leftover split equally among unlimited users
      const leftover = remaining.slice(idx);
      let unassignedCount = 0;
      if (unlimited.length) {
        leftover.forEach((c, i) => {
          const u = unlimited[i % unlimited.length];
          rows.push({ contact_id: c.id, user_name: u.user_name, event_code: eventCode });
          assignedCount[u.user_name]++;
        });
      } else {
        unassignedCount = leftover.length;
      }

      if (rows.length) {
        const { error: insErr } = await supabase.from("assignments").insert(rows);
        if (insErr) throw insErr;
      }

      // assignments has no Sheets webhook of its own, so mirror each user's count
      // onto their `users` row — that table already syncs to Admin Page on update.
      await Promise.all(
        usersCache
          .filter((u) => u.role === "User")
          .map((u) =>
            supabase.from("users").update({ assigned_count: assignedCount[u.user_name] || 0 }).eq("id", u.id)
          )
      );

      summary.textContent = `Assigned ${rows.length} contact(s) across ${eligible.length} caller(s).` +
        (unassignedCount ? ` ${unassignedCount} left unassigned (no eligible unlimited user).` : "");
      showToast("Contacts assigned successfully! 🎉", "success");
      await renderUsersTable();
    } catch (err) {
      showToast("Assignment failed: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Assign Contacts";
    }
  };
}

function wireAddUserModal() {
  const modal = document.getElementById("add-user-modal");
  const openBtn = document.getElementById("add-user-btn");
  const cancelBtn = document.getElementById("add-user-cancel");
  const submitBtn = document.getElementById("add-user-submit");
  const errorEl = document.getElementById("add-user-error");

  openBtn.onclick = () => {
    document.getElementById("add-user-name").value = "";
    document.getElementById("add-user-phone").value = "";
    document.getElementById("add-user-role").value = "User";
    document.getElementById("add-user-limit").value = "";
    document.getElementById("add-user-auto").checked = true;
    errorEl.classList.add("hidden");
    modal.classList.add("active");
  };
  cancelBtn.onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  let saving = false;
  submitBtn.onclick = async () => {
    if (saving) return;
    const name = document.getElementById("add-user-name").value.trim();
    const phone = document.getElementById("add-user-phone").value.trim();
    const role = document.getElementById("add-user-role").value;
    const limitVal = document.getElementById("add-user-limit").value;
    const auto = document.getElementById("add-user-auto").checked;

    if (!name || !/^[0-9]{10}$/.test(phone)) {
      errorEl.textContent = "Please enter a valid Name and 10-digit Phone Number.";
      errorEl.classList.remove("hidden");
      return;
    }
    saving = true;
    submitBtn.textContent = "Saving…";
    const { error } = await supabase.from("users").insert({
      user_name: name, login_pw: phone, role,
      call_limit: limitVal === "" ? null : parseInt(limitVal, 10),
      auto_assign: auto,
    });
    saving = false;
    submitBtn.textContent = "Save";
    if (error) {
      errorEl.textContent = error.message.includes("duplicate") ? "This user name already exists." : error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast("User added", "success");
    renderUsersTable();
  };
}

/* ======================= MASTER CONTACT ======================= */

let contactsSearchWired = false;

export async function initContacts() {
  await loadEvents();
  await renderContactsTable();
  wireContactsSearch();
  wireAddContactModal();
  wireContactInfoModal();
  wireAdminReviewModal();
}

const WS_ADMIN_OPTIONS = ["NA", "W", "S"];
const ADMIN_TAG_OPTIONS = ["", "Don't Call", "Janata", "Call", "Core", "Assigned"];

async function renderContactsTable(searchTerm = "") {
  const tbody = document.getElementById("contacts-table-body");
  tbody.innerHTML = `<tr><td colspan="11" class="loading-row">Loading contacts…</td></tr>`;

  let query = supabase.from("contacts").select("*").order("s_no", { ascending: true, nullsFirst: false });
  if (searchTerm) {
    query = query.or(`name.ilike.%${searchTerm}%,mob_no.ilike.%${searchTerm}%`);
  }
  const { data, error } = await query.limit(500);
  if (error) {
    tbody.innerHTML = `<tr><td colspan="11" class="loading-row">Could not load contacts.</td></tr>`;
    return;
  }
  if (!data || !data.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="loading-row">No contacts found.</td></tr>`;
    return;
  }

  const mobNos = data.map((c) => c.mob_no);
  const [{ data: calls }, { data: userRows }] = await Promise.all([
    supabase.from("call_responses").select("mob_no").in("mob_no", mobNos).limit(20000),
    supabase.from("users").select("user_name").eq("role", "User").order("user_name"),
    loadEvents(),
  ]);
  const callCounts = {};
  (calls || []).forEach((r) => { callCounts[r.mob_no] = (callCounts[r.mob_no] || 0) + 1; });

  tbody.innerHTML = data.map((c, i) => `
    <tr data-id="${c.id}">
      <td data-label="S.No">${c.s_no ?? i + 1}</td>
      <td data-label="Name"><input class="inline-edit" data-field="name" value="${escapeHtml(c.name)}" /></td>
      <td data-label="Phone"><input class="inline-edit" data-field="mob_no" maxlength="10" value="${c.mob_no}" /></td>
      <td data-label="W/S">
        <select class="inline-edit" data-field="ws">
          ${WS_ADMIN_OPTIONS.map((o) => `<option value="${o}" ${o === (c.ws || "NA") ? "selected" : ""}>${o}</option>`).join("")}
        </select>
      </td>
      <td data-label="Sessions"><button class="cell-chip info-link" data-kind="sessions" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">${c.sessions_count}</button></td>
      <td data-label="Calls"><button class="cell-chip info-link" data-kind="calls" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">${callCounts[c.mob_no] || 0}</button></td>
      <td data-label="Admin Tag">
        <select class="inline-edit" data-field="admin_tag">
          ${ADMIN_TAG_OPTIONS.map((t) => `<option value="${t}" ${t === (c.admin_tag || "") ? "selected" : ""}>${t || "—"}</option>`).join("")}
        </select>
      </td>
      <td data-label="Core Cultivation">
        <select class="inline-edit" data-field="core_cultivation">
          <option value="">—</option>
          ${(userRows || []).map((u) => `<option value="${u.user_name}" ${u.user_name === (c.core_cultivation || "") ? "selected" : ""}>${u.user_name}</option>`).join("")}
        </select>
      </td>
      <td data-label="Calling Purpose">
        <select class="inline-edit" data-field="calling_purpose">
          <option value="">—</option>
          ${eventsCache.map((e) => `<option value="${e.code}" ${e.code === (c.calling_purpose || "") ? "selected" : ""}>${e.code}</option>`).join("")}
        </select>
      </td>
      <td data-label="User Reviews"><button class="cell-chip info-link" data-kind="reviews" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">View</button></td>
      <td data-label="Admin Review"><button class="cell-chip admin-review-link" data-id="${c.id}" data-name="${escapeHtml(c.name)}" data-review="${escapeHtml(c.admin_remarks || "")}">${c.admin_remarks ? "✎ Edit" : "+ Add"}</button></td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".inline-edit").forEach((el) => {
    el.addEventListener("change", async (e) => {
      const row = e.target.closest("tr");
      const id = row.dataset.id;
      const field = e.target.dataset.field;
      const contact = data.find((c) => c.id === id);
      let value = e.target.value.trim();

      if (field === "mob_no" && !/^[0-9]{10}$/.test(value)) {
        showToast("Phone number must be exactly 10 digits.", "error");
        e.target.value = contact.mob_no;
        return;
      }
      if (field === "name" && !value) {
        showToast("Name cannot be empty.", "error");
        e.target.value = contact.name;
        return;
      }

      const { error: updErr } = await supabase.from("contacts").update({ [field]: value || null }).eq("id", id);
      if (updErr) {
        showToast("Update failed: " + updErr.message, "error");
        e.target.value = contact[field] ?? "";
        return;
      }
      contact[field] = value || null;
      showToast("Saved", "success");
    });
  });

  tbody.querySelectorAll(".info-link").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      openContactInfoModal(e.target.dataset.kind, e.target.dataset.mob, e.target.dataset.name);
    });
  });

  tbody.querySelectorAll(".admin-review-link").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      openAdminReviewModal(e.target.dataset.id, e.target.dataset.name, e.target.dataset.review);
    });
  });
}

const INFO_MODAL_TITLES = { sessions: "Session Attendance", calls: "Calling History", reviews: "User Reviews" };

async function openContactInfoModal(kind, mob, name) {
  const modal = document.getElementById("contact-info-modal");
  document.getElementById("contact-info-title").textContent = INFO_MODAL_TITLES[kind];
  document.getElementById("contact-info-sub").textContent = `${name} · ${formatPhone(mob)}`;
  const thead = document.getElementById("contact-info-thead");
  const tbody = document.getElementById("contact-info-body");
  thead.innerHTML = "";
  tbody.innerHTML = `<tr><td class="loading-row">Loading…</td></tr>`;
  modal.classList.add("active");

  if (kind === "sessions") {
    thead.innerHTML = `<tr><th>Time</th><th>Marked By</th></tr>`;
    const { data } = await supabase.from("session_attendance").select("ts,took_by").eq("mob_no", mob).order("ts", { ascending: false });
    tbody.innerHTML = (data && data.length)
      ? data.map((r) => `<tr><td data-label="Time">${new Date(r.ts).toLocaleString()}</td><td data-label="Marked By">${escapeHtml(r.took_by)}</td></tr>`).join("")
      : `<tr><td colspan="2" class="loading-row">No sessions attended yet.</td></tr>`;
  } else if (kind === "calls") {
    thead.innerHTML = `<tr><th>Time</th><th>Caller</th><th>Event</th><th>Status</th></tr>`;
    const { data } = await supabase.from("call_responses").select("ts,caller_name,event_code,remarks,addl_remarks").eq("mob_no", mob).order("ts", { ascending: false });
    tbody.innerHTML = (data && data.length)
      ? data.map((r) => `
          <tr>
            <td data-label="Time">${new Date(r.ts).toLocaleString()}</td>
            <td data-label="Caller">${escapeHtml(r.caller_name)}</td>
            <td data-label="Event">${escapeHtml(r.event_code || "")}</td>
            <td data-label="Status">${escapeHtml(r.remarks)}${r.addl_remarks ? " — " + escapeHtml(r.addl_remarks) : ""}</td>
          </tr>`).join("")
      : `<tr><td colspan="4" class="loading-row">No calls made yet.</td></tr>`;
  } else if (kind === "reviews") {
    thead.innerHTML = `<tr><th>Caller</th><th>What they said</th></tr>`;
    const { data } = await supabase.from("call_responses").select("ts,caller_name,remarks,addl_remarks").eq("mob_no", mob).order("ts", { ascending: false });
    const withNotes = (data || []).filter((r) => r.remarks || r.addl_remarks);
    tbody.innerHTML = withNotes.length
      ? withNotes.map((r) => `
          <tr>
            <td data-label="Caller">${escapeHtml(r.caller_name)} <span class="muted-text">(${new Date(r.ts).toLocaleDateString()})</span></td>
            <td data-label="Said">${escapeHtml(r.addl_remarks || r.remarks)}</td>
          </tr>`).join("")
      : `<tr><td colspan="2" class="loading-row">No reviews from users yet.</td></tr>`;
  }
}

let contactInfoModalWired = false;
function wireContactInfoModal() {
  if (contactInfoModalWired) return;
  contactInfoModalWired = true;
  const modal = document.getElementById("contact-info-modal");
  document.getElementById("contact-info-close").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
}

async function openEventCallsModal(userName, isAll, eventCode, eventName, fromTs, toTs) {
  const modal = document.getElementById("contact-info-modal");
  document.getElementById("contact-info-title").textContent = `${eventName} — Calls Made`;
  document.getElementById("contact-info-sub").textContent = isAll ? "All Users (Combined)" : userName;
  const thead = document.getElementById("contact-info-thead");
  const tbody = document.getElementById("contact-info-body");
  const callerHeader = isAll ? "<th>Caller</th>" : "";
  thead.innerHTML = `<tr><th>Time</th>${callerHeader}<th>Contact</th><th>Phone</th><th>Status</th></tr>`;
  tbody.innerHTML = `<tr><td class="loading-row">Loading…</td></tr>`;
  modal.classList.add("active");

  let query = supabase
    .from("call_responses")
    .select("ts,caller_name,contact_name,mob_no,remarks,addl_remarks")
    .eq("event_code", eventCode)
    .order("ts", { ascending: false });
  if (!isAll) query = query.eq("caller_name", userName);
  if (fromTs) query = query.gte("ts", fromTs);
  if (toTs) query = query.lte("ts", toTs);
  const { data } = await query;

  const colspan = isAll ? 5 : 4;
  tbody.innerHTML = (data && data.length)
    ? data.map((r) => `
        <tr>
          <td data-label="Time">${new Date(r.ts).toLocaleString()}</td>
          ${isAll ? `<td data-label="Caller">${escapeHtml(r.caller_name)}</td>` : ""}
          <td data-label="Contact">${escapeHtml(r.contact_name || "")}</td>
          <td data-label="Phone">${formatPhone(r.mob_no)}</td>
          <td data-label="Status">${escapeHtml(r.remarks)}${r.addl_remarks ? " — " + escapeHtml(r.addl_remarks) : ""}</td>
        </tr>`).join("")
    : `<tr><td colspan="${colspan}" class="loading-row">No calls made for this event in the selected range.</td></tr>`;
}

let adminReviewContactId = null;

function openAdminReviewModal(contactId, name, existingReview) {
  adminReviewContactId = contactId;
  document.getElementById("admin-review-sub").textContent = name;
  document.getElementById("admin-review-text").value = existingReview || "";
  document.getElementById("admin-review-error").classList.add("hidden");
  document.getElementById("admin-review-modal").classList.add("active");
}

function wireAdminReviewModal() {
  const modal = document.getElementById("admin-review-modal");
  document.getElementById("admin-review-cancel").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("admin-review-save").onclick = async () => {
    const text = document.getElementById("admin-review-text").value.trim();
    const btn = document.getElementById("admin-review-save");
    btn.disabled = true;
    btn.textContent = "Saving…";
    const { error } = await supabase.from("contacts").update({ admin_remarks: text || null }).eq("id", adminReviewContactId);
    btn.disabled = false;
    btn.textContent = "Save";
    if (error) {
      document.getElementById("admin-review-error").textContent = error.message;
      document.getElementById("admin-review-error").classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast("Review saved", "success");
    renderContactsTable(document.getElementById("contacts-search").value.trim());
  };
}

function wireContactsSearch() {
  if (contactsSearchWired) return;
  contactsSearchWired = true;
  const input = document.getElementById("contacts-search");
  let t;
  input.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => renderContactsTable(input.value.trim()), 300);
  });
}

async function populateContactModalDropdowns() {
  const cultivatorSelect = document.getElementById("add-contact-cultivator");
  const { data: users } = await supabase.from("users").select("user_name").eq("role", "User").order("user_name");
  cultivatorSelect.innerHTML = `<option value="">— none —</option>` +
    (users || []).map((u) => `<option value="${u.user_name}">${u.user_name}</option>`).join("");

  const eventSelect = document.getElementById("add-contact-event");
  fillEventSelect(eventSelect);
}

function openAddContactModal() {
  document.getElementById("add-contact-phone").value = "";
  document.getElementById("add-contact-phone").disabled = false;
  document.getElementById("add-contact-name").value = "";
  document.getElementById("add-contact-pg").value = "";
  document.getElementById("add-contact-profession").value = "";
  document.getElementById("add-contact-company").value = "";
  document.getElementById("add-contact-error").classList.add("hidden");

  populateContactModalDropdowns().then(() => {
    document.getElementById("add-contact-ws").value = "NA";
    document.getElementById("add-contact-tag").value = "";
    document.getElementById("add-contact-cultivator").value = "";
    document.getElementById("add-contact-event").value = eventsCache[0]?.code || "";
  });

  document.getElementById("add-contact-modal").classList.add("active");
}

function wireAddContactModal() {
  const modal = document.getElementById("add-contact-modal");
  document.getElementById("add-contact-btn").onclick = openAddContactModal;
  document.getElementById("add-contact-cancel").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  let saving = false;
  document.getElementById("add-contact-submit").onclick = async () => {
    if (saving) return;
    const phone = document.getElementById("add-contact-phone").value.trim();
    const name = document.getElementById("add-contact-name").value.trim();
    const errorEl = document.getElementById("add-contact-error");
    if (!name || !/^[0-9]{10}$/.test(phone)) {
      errorEl.textContent = "Please enter a valid Name and 10-digit Phone Number.";
      errorEl.classList.remove("hidden");
      return;
    }
    const payload = {
      mob_no: phone,
      name,
      pg_name: document.getElementById("add-contact-pg").value.trim() || null,
      profession: document.getElementById("add-contact-profession").value.trim() || null,
      company_name: document.getElementById("add-contact-company").value.trim() || null,
      ws: document.getElementById("add-contact-ws").value,
      admin_tag: document.getElementById("add-contact-tag").value || null,
      core_cultivation: document.getElementById("add-contact-cultivator").value || null,
      calling_purpose: document.getElementById("add-contact-event").value || null,
    };

    saving = true;
    document.getElementById("add-contact-submit").textContent = "Saving…";
    const { error } = await supabase.from("contacts").insert(payload);
    saving = false;
    document.getElementById("add-contact-submit").textContent = "Save";

    if (error) {
      errorEl.textContent = error.message.includes("duplicate") ? "This phone number already exists." : error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast("Contact added", "success");
    renderContactsTable(document.getElementById("contacts-search").value.trim());
  };
}

/* ======================= MESSAGE (Body Text) ======================= */

export async function initMessage() {
  const textEl = document.getElementById("message-text");
  const previewWrap = document.getElementById("poster-preview-wrap");
  const previewImg = document.getElementById("poster-preview");
  const errorEl = document.getElementById("message-error");
  errorEl.classList.add("hidden");

  textEl.value = (await getSetting("message_text")) || "";
  const posterUrl = await getSetting("poster_url");
  if (posterUrl) {
    previewImg.src = posterUrl;
    previewWrap.classList.remove("hidden");
  } else {
    previewWrap.classList.add("hidden");
  }

  document.getElementById("poster-upload").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const path = `posters/${Date.now()}_${file.name}`;
    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file, { upsert: true });
    if (error) {
      errorEl.textContent = "Poster upload failed: " + error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
    await setSetting("poster_url", data.publicUrl);
    previewImg.src = data.publicUrl;
    previewWrap.classList.remove("hidden");
    showToast("Poster uploaded", "success");
  };

  document.getElementById("poster-remove-btn").onclick = async () => {
    await setSetting("poster_url", "");
    previewWrap.classList.add("hidden");
    previewImg.src = "";
  };

  document.getElementById("save-message-btn").onclick = async () => {
    await setSetting("message_text", textEl.value);
    showToast("Message saved", "success");
  };
}

/* ======================= ANALYTICS ======================= */

let analyticsWired = false;

export async function initAnalytics() {
  await loadEvents();
  wireContactInfoModal();
  const userSelect = document.getElementById("analytics-user-select");
  const eventSelect = document.getElementById("analytics-event-select");
  const fromInput = document.getElementById("analytics-from");
  const toInput = document.getElementById("analytics-to");

  const { data: users } = await supabase.from("users").select("user_name").eq("role", "User").order("user_name");
  userSelect.innerHTML = `<option value="__ALL__">All Users (Combined)</option>` +
    (users || []).map((u) => `<option value="${u.user_name}">${u.user_name}</option>`).join("");

  eventSelect.innerHTML = `<option value="">All events</option>` +
    eventsCache.map((e) => `<option value="${e.code}">${e.name} (${e.code})</option>`).join("");

  if (!fromInput.value) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    fromInput.value = d.toISOString().slice(0, 10);
    toInput.value = new Date().toISOString().slice(0, 10);
  }

  const run = () => runAnalytics(userSelect.value, fromInput.value, toInput.value, eventSelect.value);
  if (!analyticsWired) {
    analyticsWired = true;
    document.getElementById("analytics-run-btn").addEventListener("click", run);
  }
  if (userSelect.value) run();
}

let analyticsRequestId = 0;

async function runAnalytics(userName, fromDate, toDate, eventFilter) {
  if (!userName) return;
  const isAll = userName === "__ALL__";
  // guards against a slower, superseded call (e.g. the initial auto-run for
  // the default user) overwriting a faster, more recent one's results.
  const requestId = ++analyticsRequestId;
  const isStale = () => requestId !== analyticsRequestId;

  const fromTs = fromDate ? new Date(fromDate + "T00:00:00").toISOString() : null;
  const toTs = toDate ? new Date(toDate + "T23:59:59").toISOString() : null;
  const currentEventCode = await getSetting("current_event");
  if (isStale()) return;

  // total calls made in the selected range
  let callsQuery = supabase.from("call_responses").select("id", { count: "exact", head: true });
  if (!isAll) callsQuery = callsQuery.eq("caller_name", userName);
  if (fromTs) callsQuery = callsQuery.gte("ts", fromTs);
  if (toTs) callsQuery = callsQuery.lte("ts", toTs);
  if (eventFilter) callsQuery = callsQuery.eq("event_code", eventFilter);
  const { count: totalCalls } = await callsQuery;
  if (isStale()) return;
  document.getElementById("analytics-total-calls").textContent = totalCalls ?? 0;

  // by-event: assigned (live for current event, historical rounds otherwise) / called / left
  // "called" is scoped to the same from/to range as the Calls Made card above,
  // so the count here always matches what the click-through popup shows.
  const eventsToShow = eventFilter ? eventsCache.filter((e) => e.code === eventFilter) : eventsCache;
  let rangedCallsQuery = supabase.from("call_responses").select("event_code");
  if (!isAll) rangedCallsQuery = rangedCallsQuery.eq("caller_name", userName);
  if (fromTs) rangedCallsQuery = rangedCallsQuery.gte("ts", fromTs);
  if (toTs) rangedCallsQuery = rangedCallsQuery.lte("ts", toTs);
  let liveAssignmentsQuery = supabase.from("assignments").select("event_code");
  if (!isAll) liveAssignmentsQuery = liveAssignmentsQuery.eq("user_name", userName);
  let roundsQuery = supabase.from("assignment_rounds").select("event_code,assigned_count");
  if (!isAll) roundsQuery = roundsQuery.eq("user_name", userName);
  const [{ data: liveAssignments }, { data: rounds }, { data: rangedCalls }] = await Promise.all([
    liveAssignmentsQuery,
    roundsQuery,
    rangedCallsQuery,
  ]);
  if (isStale()) return;
  const liveCounts = {};
  (liveAssignments || []).forEach((a) => { liveCounts[a.event_code] = (liveCounts[a.event_code] || 0) + 1; });
  const roundTotals = {};
  (rounds || []).forEach((r) => { roundTotals[r.event_code] = (roundTotals[r.event_code] || 0) + r.assigned_count; });
  const callTotals = {};
  (rangedCalls || []).forEach((c) => { if (c.event_code) callTotals[c.event_code] = (callTotals[c.event_code] || 0) + 1; });

  const byEventBody = document.getElementById("analytics-by-event-body");
  const eventRows = eventsToShow.map((e) => {
    const assigned = e.code === currentEventCode ? (liveCounts[e.code] || 0) : (roundTotals[e.code] || 0);
    const called = callTotals[e.code] || 0;
    const left = Math.max(assigned - called, 0);
    return `
      <tr class="clickable-row" data-event-code="${e.code}" data-event-name="${escapeHtml(e.name)}">
        <td data-label="Event">${escapeHtml(e.name)}</td>
        <td data-label="Assigned">${assigned}</td>
        <td data-label="Called">${called}</td>
        <td data-label="Left">${left}</td>
      </tr>`;
  }).join("");
  byEventBody.innerHTML = eventRows || `<tr><td colspan="4" class="loading-row">No data yet.</td></tr>`;
  byEventBody.querySelectorAll("tr[data-event-code]").forEach((row) => {
    row.addEventListener("click", () => {
      openEventCallsModal(userName, isAll, row.dataset.eventCode, row.dataset.eventName, fromTs, toTs);
    });
  });

  // currently assigned contacts (always reflects the live/current round)
  let assignedQuery = supabase.from("assignments").select("user_name,status,contacts(name,mob_no)").eq("event_code", currentEventCode);
  if (!isAll) assignedQuery = assignedQuery.eq("user_name", userName);
  const { data: assignedContacts } = await assignedQuery;
  if (isStale()) return;
  const assignedBody = document.getElementById("analytics-assigned-body");
  assignedBody.innerHTML = (assignedContacts && assignedContacts.length)
    ? assignedContacts.map((a) => `
        <tr>
          <td data-label="Caller">${escapeHtml(a.user_name)}</td>
          <td data-label="Name">${escapeHtml(a.contacts.name)}</td>
          <td data-label="Phone">${formatPhone(a.contacts.mob_no)}</td>
          <td data-label="Status">${escapeHtml(a.status)}</td>
          <td data-label="Called?">${a.status !== "Not Done" ? "✅" : "—"}</td>
        </tr>`).join("")
    : `<tr><td colspan="5" class="loading-row">No contacts currently assigned.</td></tr>`;

  // core cultivation health: is the cultivator actually calling the people cultivated to them?
  let cultivatedQuery = supabase.from("contacts").select("name,mob_no,core_cultivation");
  cultivatedQuery = isAll ? cultivatedQuery.not("core_cultivation", "is", null) : cultivatedQuery.eq("core_cultivation", userName);
  const { data: cultivated } = await cultivatedQuery;
  if (isStale()) return;
  const cultivationBody = document.getElementById("analytics-cultivation-body");
  if (!cultivated || !cultivated.length) {
    cultivationBody.innerHTML = `<tr><td colspan="5" class="loading-row">No contacts cultivated${isAll ? "" : " to this user"}.</td></tr>`;
  } else {
    const mobNos = cultivated.map((c) => c.mob_no);
    let callHistoryQuery = supabase.from("call_responses").select("mob_no,caller_name,ts").in("mob_no", mobNos).order("ts", { ascending: false });
    if (!isAll) callHistoryQuery = callHistoryQuery.eq("caller_name", userName);
    const { data: callHistory } = await callHistoryQuery;
    if (isStale()) return;
    // in All mode, each contact has its own designated cultivator, so tally
    // calls per (contact, caller) pair rather than one flat per-contact count.
    const keyOf = (mob, caller) => (isAll ? mob + "|" + caller : mob);
    const lastCalled = {};
    const totalCallsByMob = {};
    (callHistory || []).forEach((r) => {
      const key = keyOf(r.mob_no, r.caller_name);
      totalCallsByMob[key] = (totalCallsByMob[key] || 0) + 1;
      if (!lastCalled[key]) lastCalled[key] = r.ts;
    });
    cultivationBody.innerHTML = cultivated.map((c) => {
      const key = keyOf(c.mob_no, c.core_cultivation);
      return `
      <tr>
        <td data-label="Cultivator">${escapeHtml(c.core_cultivation || "")}</td>
        <td data-label="Name">${escapeHtml(c.name)}</td>
        <td data-label="Phone">${formatPhone(c.mob_no)}</td>
        <td data-label="Total Calls">${totalCallsByMob[key] || 0}</td>
        <td data-label="Last Called">${lastCalled[key] ? new Date(lastCalled[key]).toLocaleDateString() : "Never called"}</td>
      </tr>`;
    }).join("");
  }
}

/* ======================= RECEPTION ANALYTICS ======================= */

let receptionAnalyticsWired = false;

export async function initReceptionAnalytics() {
  await loadEvents();
  const eventSelect = document.getElementById("reception-analytics-event-select");
  eventSelect.innerHTML = `<option value="">All events</option>` +
    eventsCache.map((e) => `<option value="${e.code}">${e.name} (${e.code})</option>`).join("");

  const fromInput = document.getElementById("reception-analytics-from");
  const toInput = document.getElementById("reception-analytics-to");
  if (!fromInput.value) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    fromInput.value = d.toISOString().slice(0, 10);
    toInput.value = new Date().toISOString().slice(0, 10);
  }

  const run = () => runReceptionAnalytics(eventSelect.value, fromInput.value, toInput.value);
  if (!receptionAnalyticsWired) {
    receptionAnalyticsWired = true;
    document.getElementById("reception-analytics-run-btn").addEventListener("click", run);
  }
  run();
}

let receptionAnalyticsRequestId = 0;

async function runReceptionAnalytics(eventCode, fromDate, toDate) {
  const requestId = ++receptionAnalyticsRequestId;
  const isStale = () => requestId !== receptionAnalyticsRequestId;

  const fromTs = fromDate ? new Date(fromDate + "T00:00:00").toISOString() : null;
  const toTs = toDate ? new Date(toDate + "T23:59:59").toISOString() : null;

  // total contacts registered under this event — a pool size, not date-bounded
  let contactsQuery = supabase.from("contacts").select("id", { count: "exact", head: true });
  if (eventCode) contactsQuery = contactsQuery.eq("calling_purpose", eventCode);
  const { count: totalContacts } = await contactsQuery;
  if (isStale()) return;
  document.getElementById("reception-analytics-total-contacts").textContent = totalContacts ?? 0;

  // attendance in the selected range
  let attendanceQuery = supabase.from("session_attendance").select("ts,name,mob_no,took_by").order("ts", { ascending: false });
  if (fromTs) attendanceQuery = attendanceQuery.gte("ts", fromTs);
  if (toTs) attendanceQuery = attendanceQuery.lte("ts", toTs);
  const { data: attendance } = await attendanceQuery;
  if (isStale()) return;

  let rows = attendance || [];
  if (eventCode) {
    // session_attendance has no event_code of its own, so cross-reference
    // against contacts.calling_purpose to scope it to the chosen event.
    const mobNos = [...new Set(rows.map((r) => r.mob_no))];
    const { data: eventContacts } = mobNos.length
      ? await supabase.from("contacts").select("mob_no").eq("calling_purpose", eventCode).in("mob_no", mobNos)
      : { data: [] };
    if (isStale()) return;
    const eventMobSet = new Set((eventContacts || []).map((c) => c.mob_no));
    rows = rows.filter((r) => eventMobSet.has(r.mob_no));
  }

  document.getElementById("reception-analytics-attendance-count").textContent = rows.length;
  const tbody = document.getElementById("reception-analytics-attendance-body");
  tbody.innerHTML = rows.length
    ? rows.map((r) => `
        <tr>
          <td data-label="Time">${new Date(r.ts).toLocaleString()}</td>
          <td data-label="Name">${escapeHtml(r.name || "")}</td>
          <td data-label="Phone">${formatPhone(r.mob_no)}</td>
          <td data-label="Marked By">${escapeHtml(r.took_by)}</td>
        </tr>`).join("")
    : `<tr><td colspan="4" class="loading-row">No attendance marked in this range.</td></tr>`;
}
