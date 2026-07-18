import { supabase } from "./supabaseClient.js";
import { showToast, formatPhone } from "./utils.js";
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

export async function initUsers() {
  await loadEvents();
  const eventSelect = document.getElementById("event-select");
  const tagFilterSelect = document.getElementById("tag-filter-select");
  const currentEvent = await getSetting("current_event");
  fillEventSelect(eventSelect, currentEvent);
  tagFilterSelect.value = (await getSetting("tag_filter")) || "";

  await renderUsersTable();
  wireAssignButton(eventSelect, tagFilterSelect);
  wireAddUserModal();
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

function wireAssignButton(eventSelect, tagFilterSelect) {
  const btn = document.getElementById("assign-btn");
  const summary = document.getElementById("assign-summary");
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Assigning…";
    try {
      const eventCode = eventSelect.value;
      const tagFilter = tagFilterSelect.value;
      await setSetting("current_event", eventCode);
      await setSetting("tag_filter", tagFilter);

      // 1. wipe previous temporary assignments (event switch clears the board)
      await supabase.from("assignments").delete().neq("id", "00000000-0000-0000-0000-000000000000");

      // 2. fetch the pool for this event (minus Don't Call, optional tag filter)
      // admin_tag is nullable: a plain .neq() would silently drop untagged rows
      // (SQL NULL != 'x' is NULL, not true), so untagged contacts must be let through explicitly.
      let query = supabase
        .from("contacts")
        .select("id,core_cultivation,admin_tag")
        .eq("calling_purpose", eventCode)
        .or("admin_tag.is.null,admin_tag.neq.Don't Call");
      if (tagFilter) query = query.eq("admin_tag", tagFilter);
      const { data: pool, error: poolErr } = await query;
      if (poolErr) throw poolErr;

      // 3. eligible users — re-fetch fresh, since usersCache can be stale if a
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

      // 3a. core-cultivated contacts go to their cultivator first (counts toward their limit)
      for (const c of pool || []) {
        if (c.core_cultivation && byName[c.core_cultivation]) {
          rows.push({ contact_id: c.id, user_name: c.core_cultivation, event_code: eventCode });
          assignedCount[c.core_cultivation]++;
        } else {
          remaining.push(c);
        }
      }

      // 3b. limited users fill their remaining capacity first
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

      // 3c. leftover split equally among unlimited users
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
let editingContactId = null;

export async function initContacts() {
  await loadEvents();
  await renderContactsTable();
  wireContactsSearch();
  wireAddContactModal();
}

async function renderContactsTable(searchTerm = "") {
  const tbody = document.getElementById("contacts-table-body");
  tbody.innerHTML = `<tr><td colspan="9" class="loading-row">Loading contacts…</td></tr>`;

  let query = supabase.from("contacts").select("*").order("s_no", { ascending: true, nullsFirst: false });
  if (searchTerm) {
    query = query.or(`name.ilike.%${searchTerm}%,mob_no.ilike.%${searchTerm}%`);
  }
  const { data, error } = await query.limit(500);
  if (error) {
    tbody.innerHTML = `<tr><td colspan="9" class="loading-row">Could not load contacts.</td></tr>`;
    return;
  }
  if (!data || !data.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="loading-row">No contacts found.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.map((c, i) => `
    <tr data-id="${c.id}">
      <td data-label="S.No">${c.s_no ?? i + 1}</td>
      <td data-label="Name">${c.name}</td>
      <td data-label="Phone">${formatPhone(c.mob_no)}</td>
      <td data-label="W/S">${c.ws || "NA"}</td>
      <td data-label="Sessions">${c.sessions_count}</td>
      <td data-label="Admin Tag">${c.admin_tag || ""}</td>
      <td data-label="Core Cultivation">${c.core_cultivation || ""}</td>
      <td data-label="Calling Purpose">${c.calling_purpose || ""}</td>
      <td data-label=""><button class="btn btn-link edit-contact-btn">Edit</button></td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".edit-contact-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = e.target.closest("tr").dataset.id;
      const contact = data.find((c) => c.id === id);
      openContactModal(contact);
    });
  });
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

function openContactModal(contact) {
  editingContactId = contact ? contact.id : null;
  document.getElementById("add-contact-title").textContent = contact ? "Edit Contact" : "Add Contact";
  document.getElementById("add-contact-phone").value = contact ? contact.mob_no : "";
  document.getElementById("add-contact-phone").disabled = !!contact;
  document.getElementById("add-contact-name").value = contact ? contact.name : "";
  document.getElementById("add-contact-pg").value = contact ? (contact.pg_name || "") : "";
  document.getElementById("add-contact-profession").value = contact ? (contact.profession || "") : "";
  document.getElementById("add-contact-company").value = contact ? (contact.company_name || "") : "";
  document.getElementById("add-contact-error").classList.add("hidden");

  populateContactModalDropdowns().then(() => {
    document.getElementById("add-contact-ws").value = contact ? (contact.ws || "NA") : "NA";
    document.getElementById("add-contact-tag").value = contact ? (contact.admin_tag || "") : "";
    document.getElementById("add-contact-cultivator").value = contact ? (contact.core_cultivation || "") : "";
    document.getElementById("add-contact-event").value = contact ? (contact.calling_purpose || "") : (eventsCache[0]?.code || "");
  });

  document.getElementById("add-contact-modal").classList.add("active");
}

function wireAddContactModal() {
  const modal = document.getElementById("add-contact-modal");
  document.getElementById("add-contact-btn").onclick = () => openContactModal(null);
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
    let error;
    if (editingContactId) {
      ({ error } = await supabase.from("contacts").update(payload).eq("id", editingContactId));
    } else {
      ({ error } = await supabase.from("contacts").insert(payload));
    }
    saving = false;
    document.getElementById("add-contact-submit").textContent = "Save";

    if (error) {
      errorEl.textContent = error.message.includes("duplicate") ? "This phone number already exists." : error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast("Contact saved", "success");
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
