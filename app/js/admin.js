import { supabase } from "./supabaseClient.js";
import { STORAGE_BUCKET } from "./config.js";
import { showToast, formatPhone, escapeHtml, downloadExcel, exportTableToExcel, parseCSV, compressImageFile, normalizePhoneInput, ADMIN_TAG_TO_USERS_OPTIONS, syncCoordinatorUser, GYC_STATUS_OPTIONS } from "./utils.js";

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

// accepts legacy full words too, so old CSV exports / Sheet rows still import cleanly
function normalizeGender(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "m" || v === "male") return "M";
  if (v === "f" || v === "female") return "F";
  return null;
}

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

function fillEventSelect(select, selectedCode, includeAllOption = false) {
  select.innerHTML = (includeAllOption ? `<option value="__ALL__">All Events</option>` : "") + eventsCache
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

// "" (both/neither checked) = no GFY filter, "attended" = only gyc_status ===
// 'Attended GFY', "not_attended" = anything else (including blank) counts as
// not attended.
function getGfyFilter(gfyGroup) {
  const attended = gfyGroup.querySelector("#gfy-filter-attended").checked;
  const notAttended = gfyGroup.querySelector("#gfy-filter-not-attended").checked;
  if (attended && !notAttended) return "attended";
  if (notAttended && !attended) return "not_attended";
  return "";
}

// Both boxes are allowed to be checked (no filter) but not both unchecked —
// unchecking the last one just re-checks it so there's always a valid state.
function wireGfyFilterGroup(gfyGroup) {
  const attendedCb = gfyGroup.querySelector("#gfy-filter-attended");
  const notAttendedCb = gfyGroup.querySelector("#gfy-filter-not-attended");
  [attendedCb, notAttendedCb].forEach((cb) => {
    cb.addEventListener("change", () => {
      if (!attendedCb.checked && !notAttendedCb.checked) {
        cb.checked = true;
        showToast("At least one GFY filter must stay enabled.", "error");
      }
    });
  });
}

export async function initUsers() {
  const eventSelect = document.getElementById("event-select");
  const tagFilterGroup = document.getElementById("tag-filter-group");
  const gfyGroup = document.getElementById("gfy-filter-group");

  // these round-trips are all independent — run them together instead of
  // one after another, since that was adding ~2s to this page's load.
  const [, tagFilterValue, gfyFilterValue] = await Promise.all([
    loadEvents(),
    getSetting("tag_filter"),
    getSetting("gfy_filter"),
    renderUsersTable(),
  ]);
  // Always default to "All Events" here regardless of whichever single
  // event is set as current elsewhere (Reception/Analytics/etc.) — this tab
  // is for assigning across everything unless the admin narrows it down.
  fillEventSelect(eventSelect, "__ALL__", true);
  const savedTags = (tagFilterValue || "").split(",").map((t) => t.trim()).filter(Boolean);
  tagFilterGroup.querySelectorAll("input").forEach((cb) => { cb.checked = savedTags.includes(cb.value); });
  gfyGroup.querySelector("#gfy-filter-attended").checked = gfyFilterValue !== "not_attended";
  gfyGroup.querySelector("#gfy-filter-not-attended").checked = gfyFilterValue !== "attended";

  wireAssignButton(eventSelect, tagFilterGroup, gfyGroup);
  wireRebalanceButton(eventSelect, tagFilterGroup, gfyGroup);
  wireGfyFilterGroup(gfyGroup);
  wireDisassignButton();
  wireAutoAssignSelectAll();
  wireAddUserModal();
  wireManageEventsModal();
  wireUsersImportExport();
}

async function refreshEventsEverywhere(selectedCode) {
  eventsLoaded = false;
  await loadEvents();
  const eventSelect = document.getElementById("event-select");
  if (eventSelect) fillEventSelect(eventSelect, selectedCode, true);
}

async function renderManageEventsList() {
  const tbody = document.getElementById("manage-events-body");
  tbody.innerHTML = `<tr><td colspan="4" class="loading-row">Loading events…</td></tr>`;

  const [, { data: contacts }] = await Promise.all([
    loadEvents(),
    supabase.from("contacts").select("calling_purpose"),
  ]);
  const counts = {};
  (contacts || []).forEach((c) => {
    if (c.calling_purpose) counts[c.calling_purpose] = (counts[c.calling_purpose] || 0) + 1;
  });

  if (!eventsCache.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-row">No events yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = eventsCache.map((e) => `
    <tr data-code="${e.code}">
      <td data-label="Code"><strong>${escapeHtml(e.code)}</strong></td>
      <td data-label="Display Name"><input class="inline-edit event-name-input" value="${escapeHtml(e.name)}" /></td>
      <td data-label="Contacts">${counts[e.code] || 0}</td>
      <td data-label=""><button class="cell-chip danger delete-event-btn">Delete</button></td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".event-name-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const code = e.target.closest("tr").dataset.code;
      const name = e.target.value.trim();
      if (!name) {
        showToast("Display name cannot be empty.", "error");
        const ev = eventsCache.find((ev) => ev.code === code);
        e.target.value = ev ? ev.name : "";
        return;
      }
      const { error } = await supabase.from("events").update({ name }).eq("code", code);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        return;
      }
      await refreshEventsEverywhere();
      showToast("Event updated", "success");
    });
  });

  tbody.querySelectorAll(".delete-event-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const code = e.target.closest("tr").dataset.code;
      const count = counts[code] || 0;
      const msg = count
        ? `Delete event "${code}"? ${count} contact(s) are tagged with this event as their Calling Purpose — they'll keep that tag, but it will no longer appear as a selectable event.`
        : `Delete event "${code}"?`;
      if (!confirm(msg)) return;
      const { error } = await supabase.from("events").delete().eq("code", code);
      if (error) {
        showToast("Delete failed: " + error.message, "error");
        return;
      }
      await refreshEventsEverywhere();
      await renderManageEventsList();
      showToast("Event deleted", "success");
    });
  });
}

let manageEventsModalWired = false;
function wireManageEventsModal() {
  if (manageEventsModalWired) return;
  manageEventsModalWired = true;
  const modal = document.getElementById("manage-events-modal");

  document.getElementById("manage-events-btn").onclick = () => {
    document.getElementById("add-event-code").value = "";
    document.getElementById("add-event-name").value = "";
    document.getElementById("add-event-error").classList.add("hidden");
    modal.classList.add("active");
    renderManageEventsList();
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
    document.getElementById("add-event-code").value = "";
    document.getElementById("add-event-name").value = "";
    errorEl.classList.add("hidden");
    await refreshEventsEverywhere(code);
    await renderManageEventsList();
    showToast("Event added", "success");
  };
}

async function renderUsersTable() {
  const tbody = document.getElementById("users-table-body");
  tbody.innerHTML = `<tr><td colspan="10" class="loading-row">Loading users…</td></tr>`;

  const { data: users, error } = await supabase
    .from("users")
    .select("id,user_name,login_pw,role,call_limit,auto_assign")
    .order("user_name");
  if (error) {
    tbody.innerHTML = `<tr><td colspan="10" class="loading-row">Could not load users.</td></tr>`;
    return;
  }
  usersCache = users || [];

  // "completed" mirrors the same rule used everywhere else a call counts as
  // made (archiveAndClearAssignments, Reception Analytics): any status other
  // than the untouched default.
  const { data: assignments } = await supabase.from("assignments").select("user_name,status");
  const counts = {};
  const completedCounts = {};
  (assignments || []).forEach((a) => {
    counts[a.user_name] = (counts[a.user_name] || 0) + 1;
    if ((a.status || "Not Done") !== "Not Done") {
      completedCounts[a.user_name] = (completedCounts[a.user_name] || 0) + 1;
    }
  });

  if (!usersCache.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="loading-row">No users yet.</td></tr>`;
    return;
  }

  const coordinators = usersCache.filter((u) => u.role === "Coordinator");
  const selectAllInput = document.getElementById("auto-assign-select-all");
  if (selectAllInput) selectAllInput.checked = coordinators.length > 0 && coordinators.every((u) => u.auto_assign);

  tbody.innerHTML = usersCache.map((u, i) => {
    const assigned = counts[u.user_name] || 0;
    const completed = completedCounts[u.user_name] || 0;
    const pct = assigned > 0 ? Math.round((completed / assigned) * 100) + "%" : "—";
    return `
    <tr data-id="${u.id}" data-label-row>
      <td data-label="S.No">${i + 1}</td>
      <td data-label="User ID"><strong>${u.role === "Admin" ? "—" : escapeHtml(u.user_name || "")}</strong></td>
      <td data-label="Password">${u.role === "Admin" ? "—" : escapeHtml(u.login_pw || "")}</td>
      <td data-label="Role">${u.role}</td>
      <td data-label="Call Limit">
        <input type="number" min="0" class="limit-input" value="${u.call_limit ?? ""}" placeholder="No limit" ${u.role !== "Coordinator" ? "disabled" : ""} />
      </td>
      <td data-label="Assigned Count" class="assigned-count">${assigned}</td>
      <td data-label="Completed Calls" class="assigned-count">${completed}</td>
      <td data-label="Completed %" class="assigned-count">${pct}</td>
      <td data-label="Auto Assign">
        <input type="checkbox" class="auto-assign-input" ${u.auto_assign ? "checked" : ""} ${u.role !== "Coordinator" ? "disabled" : ""} />
      </td>
      <td data-label="">
        <button class="btn btn-link delete-user-btn">Delete</button>
      </td>
    </tr>
  `;
  }).join("");

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

// two-phase core: users with an explicit call_limit fill first (each one up
// to its own cap, in table order) — that priority matters since table order
// is alphabetical by user_name, and an unlimited user could otherwise sort
// ahead of a limited one and swallow the whole pool before the limit ever
// kicked in. Only once every limited user is at their cap does the rest of
// the pool reach the unlimited users, and among those it's fair-share (goes
// to whichever unlimited user currently has fewest), so an unset limit still
// means "split evenly" instead of "whoever's first gets it all". E.g. 10
// contacts, one user limited to 7 and one unlimited -> 7/3; 5 contacts -> 5/0
// (the unlimited user untouched since the limit isn't reached); 20 contacts,
// one limited to 5 and two unlimited -> 5/8/7 (or 5/7/8) split. Mutates
// assignedCount as it goes. Core-cultivated contacts never reach this pool
// (see fetchEventContactPool) — that link is admin-only, made by setting
// Core Cultivation in Master Contact, never automatic.
function distributePool(pool, eligible, assignedCount, eventCode) {
  const capOf = (u) => (u.call_limit == null ? Infinity : u.call_limit);
  const limited = eligible.filter((u) => capOf(u) !== Infinity);
  const unlimited = eligible.filter((u) => capOf(u) === Infinity);
  const rows = [];
  let unassignedCount = 0;
  let idx = 0;
  for (const c of pool) {
    while (idx < limited.length && assignedCount[limited[idx].user_name] >= capOf(limited[idx])) idx++;
    let pick = null;
    if (idx < limited.length) {
      pick = limited[idx];
    } else if (unlimited.length) {
      pick = unlimited.reduce((a, b) => (assignedCount[a.user_name] <= assignedCount[b.user_name] ? a : b));
    }
    if (!pick) { unassignedCount++; continue; }
    // "All Events" mode passes eventCode="__ALL__" — each contact keeps its
    // own calling_purpose as the assignment's real event_code instead.
    rows.push({ contact_id: c.id, user_name: pick.user_name, event_code: c.calling_purpose || eventCode });
    assignedCount[pick.user_name]++;
  }
  return { rows, unassignedCount };
}

// contacts matching this event + optional tag filter, minus Don't Call,
// Coordinator (coordinators are tracked in Master Contact for attendance, but
// never callable), and anything with a Core Cultivation set (that link is
// admin-only, never auto-assigned) — the same pool rule used by Assign,
// Rebalance, and (in SQL) the continuous trigger.
// eventCode === "__ALL__" pools contacts across every event at once (each one
// still keeps its own calling_purpose as its assignment's event_code).
// gfyFilter: "" (no filter), "attended" (gyc_status === 'Attended GFY' only), or
// "not_attended" (anything else, including blank, counts as not attended).
async function fetchEventContactPool(eventCode, tagFilters, gfyFilter = "") {
  const allEvents = eventCode === "__ALL__";
  let query = supabase
    .from("contacts")
    .select("id,core_cultivation,admin_tag_to_users,calling_purpose,gyc_status");
  query = allEvents ? query.not("calling_purpose", "is", null) : query.eq("calling_purpose", eventCode);
  if (tagFilters.length) {
    // When specific tags are selected, only include contacts with those tags
    query = query.in("admin_tag_to_users", tagFilters);
  } else {
    // No tag filter: include all except Don't Call (nulls are included)
    query = query.or("admin_tag_to_users.is.null,admin_tag_to_users.neq.Don't Call");
  }
  if (gfyFilter === "attended") {
    query = query.eq("gyc_status", "Attended GFY");
  } else if (gfyFilter === "not_attended") {
    query = query.or("gyc_status.is.null,gyc_status.neq.Attended GFY");
  }
  const { data, error } = await query;
  if (error) throw error;
  const seenIds = new Set();
  return (data || []).filter((c) => {
    if (c.admin_tag_to_users === "Coordinator") return false;
    if (seenIds.has(c.id)) return false;
    seenIds.add(c.id);
    return true;
  });
}

// assignments has no Sheets webhook of its own, so mirror each user's total
// (across every event, not just one) onto their `users` row — that table
// already syncs to the Sheet on update.
async function mirrorAssignedCounts(usersCache) {
  const { data: allAssignments } = await supabase.from("assignments").select("user_name");
  const globalCounts = {};
  (allAssignments || []).forEach((a) => { globalCounts[a.user_name] = (globalCounts[a.user_name] || 0) + 1; });
  await Promise.all(
    usersCache
      .filter((u) => u.role === "Coordinator")
      .map((u) => supabase.from("users").update({ assigned_count: globalCounts[u.user_name] || 0 }).eq("id", u.id))
  );
}

// Snapshots every current assignment into assignment_rounds (so past-round
// stats stay answerable) then wipes the live assignments table. Shared by
// Assign (which repopulates it right after) and Disassign (which doesn't).
async function archiveAndClearAssignments() {
  const { data: outgoing } = await supabase
    .from("assignments")
    .select("user_name,event_code,status");

  if (!outgoing || !outgoing.length) return;

  const statsMap = {};
  outgoing.forEach((a) => {
    const key = a.user_name + "|" + a.event_code;
    if (!statsMap[key]) {
      statsMap[key] = { assigned: 0, called: 0, left: 0, positive: 0 };
    }
    const s = statsMap[key];
    s.assigned++;
    if ((a.status || "Not Done") !== "Not Done") {
      s.called++;
    } else {
      s.left++;
    }
    if (callOutcomeCategory(a.status) === "positive") {
      s.positive++;
    }
  });

  const roundRows = Object.entries(statsMap).map(([key, s]) => {
    const [user_name, event_code] = key.split("|");
    return {
      user_name,
      event_code,
      assigned_count: s.assigned,
      called_count: s.called,
      left_count: s.left,
      positive_count: s.positive
    };
  });

  await supabase.from("assignment_rounds").insert(roundRows);
  await supabase.from("assignments").delete().neq("user_name", "");
}

function wireDisassignButton() {
  const btn = document.getElementById("disassign-btn");
  const summary = document.getElementById("assign-summary");
  btn.onclick = async () => {
    if (!confirm("Disassign all current contacts from every caller? Each caller's Assigned Count will drop to zero. Past stats are preserved.")) return;
    btn.disabled = true;
    btn.textContent = "Disassigning…";
    try {
      await archiveAndClearAssignments();
      const { data: freshUsers } = await supabase
        .from("users")
        .select("id,user_name,role,call_limit,auto_assign");
      if (freshUsers) {
        usersCache = freshUsers;
        await mirrorAssignedCounts(usersCache);
      }
      summary.textContent = "All callers disassigned — everyone's Assigned Count is now zero.";
      showToast("All contacts disassigned", "success");
      await renderUsersTable();
    } catch (err) {
      showToast("Disassign failed: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "✕ Disassign All";
    }
  };
}

function wireAutoAssignSelectAll() {
  const selectAll = document.getElementById("auto-assign-select-all");
  if (!selectAll) return;
  selectAll.onchange = async (e) => {
    const checked = e.target.checked;
    const coordinators = usersCache.filter((u) => u.role === "Coordinator");
    if (!coordinators.length) return;
    await Promise.all(coordinators.map((u) => supabase.from("users").update({ auto_assign: checked }).eq("id", u.id)));
    showToast(checked ? "Auto Assign enabled for all users" : "Auto Assign disabled for all users", "success");
    await renderUsersTable();
  };
}

function wireAssignButton(eventSelect, tagFilterGroup, gfyGroup) {
  const btn = document.getElementById("assign-btn");
  const summary = document.getElementById("assign-summary");
  btn.onclick = async () => {
    // Assigning rewrites every caller's list, so make it a deliberate action
    // rather than something a stray click can trigger.
    if (!confirm("Assign contacts to all eligible callers now? This rebuilds their call lists based on the current event, filters and call limits.")) return;
    btn.disabled = true;
    btn.textContent = "Assigning…";
    try {
      // 1. Force blur active inputs to ensure changes are triggered
      if (document.activeElement && (document.activeElement.classList.contains("limit-input") || document.activeElement.classList.contains("auto-assign-input"))) {
        document.activeElement.blur();
        // Wait 150ms for DB updates to complete
        await new Promise((r) => setTimeout(r, 150));
      }

      const eventCode = eventSelect.value;
      const tagFilters = getCheckedTags(tagFilterGroup);
      const gfyFilter = getGfyFilter(gfyGroup);

      // 2. Archive and remove all existing assignments across all events first.
      // This ensures no user is assigned to more than one event simultaneously
      // and resets the current assignment state to zero before fresh distribution.
      await archiveAndClearAssignments();

      // "All Events" is a pooling choice for this one Assign click, not a
      // real event — leave whatever single event was last set as "current"
      // alone, since Reception/Analytics rely on that setting elsewhere.
      if (eventCode !== "__ALL__") await setSetting("current_event", eventCode);
      await setSetting("tag_filter", tagFilters.join(", "));
      await setSetting("gfy_filter", gfyFilter);

      // existingForEvent will now be empty since we cleared it above
      const alreadyAssignedIds = new Set();

      const pool = (await fetchEventContactPool(eventCode, tagFilters, gfyFilter)).filter((c) => !alreadyAssignedIds.has(c.id));

      // 3. Read the settings directly from the DOM to avoid race conditions with unsaved inputs
      const eligible = [];
      document.querySelectorAll("#users-table-body tr").forEach((row) => {
        // User ID cell shows only the first word of the name — look the full
        // user_name up by row id instead of reading the (truncated) display text.
        const user = usersCache.find((u) => u.id === row.dataset.id);
        if (!user) return;
        const role = row.querySelector("td[data-label='Role']")?.textContent.trim();
        const limitVal = row.querySelector(".limit-input")?.value;
        const autoChecked = row.querySelector(".auto-assign-input")?.checked;
        if (role === "Coordinator" && autoChecked) {
          eligible.push({
            user_name: user.user_name,
            role,
            call_limit: limitVal === "" || limitVal === undefined ? null : parseInt(limitVal, 10)
          });
        }
      });

      // seed each user's count from their existing load for *this event* (not zero),
      // so call_limit is a running cap across clicks, matching the SQL trigger's rule.
      const assignedCount = {};
      eligible.forEach((u) => { assignedCount[u.user_name] = 0; });

      // Separate contacts into cultivated and general pools
      const generalPool = [];
      const rows = [];
      let unassignedCount = 0;
      
      const eligibleMap = {};
      eligible.forEach((u) => { eligibleMap[u.user_name] = u; });

      pool.forEach((c) => {
        if (c.core_cultivation) {
          // Assigned specifically to their permanent cultivator if they have auto_assign checked
          if (c.core_cultivation in assignedCount) {
            const cap = eligibleMap[c.core_cultivation].call_limit;
            const currentLoad = assignedCount[c.core_cultivation];
            if (currentLoad < (cap == null ? Infinity : cap)) {
              rows.push({ contact_id: c.id, user_name: c.core_cultivation, event_code: c.calling_purpose || eventCode });
              assignedCount[c.core_cultivation]++;
            } else {
              unassignedCount++;
            }
          } else {
            unassignedCount++;
          }
        } else {
          generalPool.push(c);
        }
      });

      // Distribute remaining uncultivated contacts fairly
      const { rows: generalRows, unassignedCount: generalUnassigned } = distributePool(generalPool, eligible, assignedCount, eventCode);
      rows.push(...generalRows);
      unassignedCount += generalUnassigned;

      if (rows.length) {
        const { error: insErr } = await supabase.from("assignments").insert(rows);
        if (insErr) throw insErr;
      }

      // Re-fetch users for cache count updates in database
      const { data: freshUsers } = await supabase
        .from("users")
        .select("id,user_name,role,call_limit,auto_assign");
      if (freshUsers) {
        usersCache = freshUsers;
        await mirrorAssignedCounts(usersCache);
      }

      summary.textContent = `Assigned ${rows.length} new contact(s) across ${eligible.length} caller(s).` +
        (unassignedCount ? ` ${unassignedCount} left unassigned (no eligible user under their limit).` : "");
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

function wireRebalanceButton(eventSelect, tagFilterGroup, gfyGroup) {
  const btn = document.getElementById("rebalance-btn");
  const summary = document.getElementById("assign-summary");
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Rebalancing…";
    try {
      const eventCode = eventSelect.value;
      const tagFilters = getCheckedTags(tagFilterGroup);
      const gfyFilter = getGfyFilter(gfyGroup);

      const eligiblePool = await fetchEventContactPool(eventCode, tagFilters, gfyFilter);

      let existingQuery = supabase.from("assignments").select("id,contact_id,user_name,status");
      if (eventCode !== "__ALL__") existingQuery = existingQuery.eq("event_code", eventCode);
      const { data: existing, error: existingErr } = await existingQuery;
      if (existingErr) throw existingErr;

      // only ever touch contacts nobody has acted on yet — a caller's status
      // (anything but the untouched default) means they've started or
      // finished, so that contact stays exactly where it is.
      const untouched = (existing || []).filter((a) => (a.status || "Not Done") === "Not Done");
      const inProgress = (existing || []).filter((a) => (a.status || "Not Done") !== "Not Done");

      if (untouched.length) {
        const { error: delErr } = await supabase.from("assignments").delete().in("id", untouched.map((a) => a.id));
        if (delErr) throw delErr;
      }

      // redistribute: every eligible contact except the ones left alone above
      // (already-untouched assignments plus any not-yet-assigned contacts).
      const inProgressIds = new Set(inProgress.map((a) => a.contact_id));
      const reshufflePool = eligiblePool.filter((c) => !inProgressIds.has(c.id));

      const { data: freshUsers, error: usersErr } = await supabase
        .from("users")
        .select("id,user_name,role,call_limit,auto_assign");
      if (usersErr) throw usersErr;
      usersCache = freshUsers || [];
      const eligible = usersCache.filter((u) => u.role === "Coordinator" && u.auto_assign);
      // seed from in-progress/completed load only — those still count toward
      // the cap, but the freed-up untouched slots don't (they're up for grabs).
      const assignedCount = {};
      eligible.forEach((u) => { assignedCount[u.user_name] = 0; });
      inProgress.forEach((a) => { if (a.user_name in assignedCount) assignedCount[a.user_name]++; });
      const { rows, unassignedCount } = distributePool(reshufflePool, eligible, assignedCount, eventCode);
      if (rows.length) {
        const { error: insErr } = await supabase.from("assignments").insert(rows);
        if (insErr) throw insErr;
      }

      await mirrorAssignedCounts(usersCache);

      summary.textContent = `Rebalanced ${rows.length} not-yet-called contact(s) across ${eligible.length} caller(s). ` +
        `${inProgress.length} already in-progress/completed left untouched.` +
        (unassignedCount ? ` ${unassignedCount} left unassigned (no eligible user under their limit).` : "");
      showToast("Rebalanced successfully! ⚖", "success");
      await renderUsersTable();
    } catch (err) {
      showToast("Rebalance failed: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "⚖ Rebalance Unfinished";
    }
  };
}

function wireAddUserModal() {
  const modal = document.getElementById("add-user-modal");
  const openBtn = document.getElementById("add-user-btn");
  const cancelBtn = document.getElementById("add-user-cancel");
  const submitBtn = document.getElementById("add-user-submit");
  const errorEl = document.getElementById("add-user-error");
  const phoneInput = document.getElementById("add-user-phone");

  phoneInput.addEventListener("input", (e) => { e.target.value = normalizePhoneInput(e.target.value); });

  openBtn.onclick = () => {
    document.getElementById("add-user-name").value = "";
    phoneInput.value = "";
    document.getElementById("add-user-role").value = "Coordinator";
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
    const phone = normalizePhoneInput(phoneInput.value);
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

function pickField(row, ...names) {
  for (const n of names) {
    const key = Object.keys(row).find((k) => k.toLowerCase().trim() === n.toLowerCase());
    if (key && row[key] !== "") return row[key];
  }
  return "";
}

let usersImportExportWired = false;
function wireUsersImportExport() {
  if (usersImportExportWired) return;
  usersImportExportWired = true;

  document.getElementById("users-export-btn").addEventListener("click", async () => {
    const { data: users } = await supabase.from("users").select("user_name,login_pw,role,call_limit,auto_assign").order("user_name");
    const { data: assignments } = await supabase.from("assignments").select("user_name");
    const counts = {};
    (assignments || []).forEach((a) => { counts[a.user_name] = (counts[a.user_name] || 0) + 1; });
    const rows = [["User Name", "Login PW", "Role", "Call Limit", "Assigned Count", "Auto Assign"]];
    (users || []).forEach((u) => {
      rows.push([u.user_name, u.login_pw, u.role, u.call_limit ?? "", counts[u.user_name] || 0, u.auto_assign ? "Yes" : "No"]);
    });
    downloadExcel(`nrg-users-${todayStamp()}.xlsx`, rows);
  });

  const fileInput = document.getElementById("users-import-file");
  const summaryEl = document.getElementById("users-import-summary");
  document.getElementById("users-import-btn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const records = parseCSV(await file.text());
    fileInput.value = "";
    if (!records.length) {
      showToast("No rows found in that file.", "error");
      return;
    }

    let skipped = 0;
    const byName = new Map(); // de-dupe within the file itself — last row for a name wins
    records.forEach((row) => {
      const user_name = pickField(row, "User Name", "Name");
      const login_pw = pickField(row, "Login PW", "Phone", "Password");
      if (!user_name || !login_pw) { skipped++; return; }
      const roleRaw = pickField(row, "Role", "User Status");
      const role = ["Admin", "Reception"].includes(roleRaw) ? roleRaw : "Coordinator";
      const limitRaw = pickField(row, "Call Limit", "Call Limit By Admin");
      const limitParsed = limitRaw === "" ? null : parseInt(limitRaw, 10);
      const autoRaw = pickField(row, "Auto Assign", "Auto Assign Status");
      byName.set(user_name, {
        user_name,
        login_pw,
        role,
        call_limit: (limitParsed === null || Number.isNaN(limitParsed)) ? null : limitParsed,
        auto_assign: /^(yes|true|1)$/i.test(autoRaw || "true"),
      });
    });

    const payload = Array.from(byName.values());
    if (!payload.length) {
      showToast("No valid rows to import (need at least User Name + Login PW).", "error");
      return;
    }
    const { error } = await supabase.from("users").upsert(payload, { onConflict: "user_name" });
    if (error) {
      showToast("Import failed: " + error.message, "error");
      return;
    }
    summaryEl.textContent = `Imported ${payload.length} user(s).` + (skipped ? ` Skipped ${skipped} row(s) missing a name or phone.` : "");
    summaryEl.classList.remove("hidden");
    showToast("Users imported", "success");
    renderUsersTable();
  });
}

/* ======================= MASTER CONTACT ======================= */

let contactsSearchWired = false;
let lastContactsData = [];
let lastCallCounts = {};

export async function initContacts() {
  await loadEvents();
  const searchInput = document.getElementById("contacts-search");
  if (searchInput) searchInput.value = "";
  await renderContactsTable();
  wireContactsSearch();
  wireAddContactModal();
  wireContactInfoModal();
  wireAdminReviewModal();
  wireDeleteContactModal();
  wireContactsImportExport();
  wireContactsColumnReorder();
}

// Master Contact's column order is user-draggable (like Excel) and persisted
// locally per browser; the "" key is the trailing, non-draggable Delete
// column, always kept last so dragging can never push it out of place.
const CONTACTS_COLUMN_ORDER_KEY = "nrg-contacts-column-order";
const DEFAULT_CONTACTS_COLUMNS = [
  "S.No", "Time Stamp", "Name", "Phone", "PG Name", "Profession", "Gender", "Sessions", "Calls",
  "Admin Tag to Users", "Admin Tag", "Core Cultivation", "Calling Purpose", "GFY/AOMC", "Admin Review", "",
];

function getContactsColumnOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONTACTS_COLUMN_ORDER_KEY));
    if (Array.isArray(saved) && saved.length === DEFAULT_CONTACTS_COLUMNS.length && DEFAULT_CONTACTS_COLUMNS.every((k) => saved.includes(k))) {
      return saved;
    }
  } catch { /* fall through to default */ }
  return DEFAULT_CONTACTS_COLUMNS;
}

function applyContactsColumnOrder(order) {
  const table = document.getElementById("contacts-table");
  if (!table) return;
  const rows = [table.querySelector("thead tr"), ...table.querySelectorAll("tbody tr")];
  rows.forEach((row) => {
    if (!row) return;
    const byKey = new Map(Array.from(row.children).map((cell) => [cell.dataset.label ?? "", cell]));
    order.forEach((key) => {
      const cell = byKey.get(key);
      if (cell) row.appendChild(cell);
    });
  });
}

let contactsColumnReorderWired = false;
function wireContactsColumnReorder() {
  if (contactsColumnReorderWired) return;
  contactsColumnReorderWired = true;

  const headRow = document.querySelector("#contacts-table thead tr");
  let dragKey = null;

  headRow.querySelectorAll("th[draggable='true']").forEach((th) => {
    th.addEventListener("dragstart", () => {
      dragKey = th.dataset.label ?? "";
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
      const dropKey = th.dataset.label ?? "";
      if (!dragKey || dragKey === dropKey) return;

      const order = getContactsColumnOrder().slice();
      const from = order.indexOf(dragKey);
      const to = order.indexOf(dropKey);
      if (from === -1 || to === -1) return;
      order.splice(from, 1);
      order.splice(to, 0, dragKey);
      localStorage.setItem(CONTACTS_COLUMN_ORDER_KEY, JSON.stringify(order));
      applyContactsColumnOrder(order);
    });
  });

  document.getElementById("contacts-reset-columns-btn").addEventListener("click", () => {
    localStorage.removeItem(CONTACTS_COLUMN_ORDER_KEY);
    applyContactsColumnOrder(DEFAULT_CONTACTS_COLUMNS);
    showToast("Column order reset", "success");
  });

  wireHorizontalScroll();
}

// Master Contact is far wider than any screen, so panning it is a first-class
// action here: click-and-drag anywhere on the table, shift+wheel (or a plain
// wheel when there is nothing left to scroll vertically), the ◀ ▶ buttons, or
// the arrow keys once the table has focus.
function wireHorizontalScroll() {
  const wrap = document.getElementById("contacts-table-wrap");
  if (!wrap || wrap.dataset.hscrollWired) return;
  wrap.dataset.hscrollWired = "1";

  const PAGE = () => Math.max(240, wrap.clientWidth * 0.8);
  document.getElementById("contacts-scroll-left").addEventListener("click", () => {
    wrap.scrollBy({ left: -PAGE(), behavior: "smooth" });
  });
  document.getElementById("contacts-scroll-right").addEventListener("click", () => {
    wrap.scrollBy({ left: PAGE(), behavior: "smooth" });
  });

  wrap.addEventListener("wheel", (e) => {
    if (!e.shiftKey && Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // real trackpad h-scroll: leave it alone
    if (!e.shiftKey) return;
    e.preventDefault();
    wrap.scrollLeft += e.deltaY;
  }, { passive: false });

  // Drag-to-pan. Ignored when the press starts on something interactive so
  // inline edits, dropdowns and the draggable column headers still work.
  let dragging = false, startX = 0, startScroll = 0, moved = false;
  const INTERACTIVE = "input, select, textarea, button, a, th[draggable='true']";

  wrap.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(INTERACTIVE)) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startScroll = wrap.scrollLeft;
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) < 4) return; // let real clicks through untouched
    if (!moved) {
      moved = true;
      wrap.classList.add("is-dragging");
      wrap.setPointerCapture(e.pointerId);
    }
    e.preventDefault();
    wrap.scrollLeft = startScroll - dx;
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove("is-dragging");
    if (moved && wrap.hasPointerCapture?.(e.pointerId)) wrap.releasePointerCapture(e.pointerId);
  };
  wrap.addEventListener("pointerup", endDrag);
  wrap.addEventListener("pointercancel", endDrag);

  wrap.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); wrap.scrollBy({ left: PAGE(), behavior: "smooth" }); }
    if (e.key === "ArrowLeft") { e.preventDefault(); wrap.scrollBy({ left: -PAGE(), behavior: "smooth" }); }
  });
}

const WS_ADMIN_OPTIONS = ["NA", "W", "S"];
const GENDER_ADMIN_OPTIONS = ["", "M", "F"];
const ADMIN_TAG_OPTIONS = ["", "LIT", "Folk HYD", "Focus"];

// every column-header filter dropdown in Master Contact, paired with the
// contacts column it filters on.
const COLUMN_FILTER_FIELDS = [
  ["contacts-filter-ws", "ws"],
  ["contacts-filter-gender", "gender"],
  ["contacts-filter-tag-to-users", "admin_tag_to_users"],
  ["contacts-filter-tag", "admin_tag"],
  ["contacts-filter-cultivation", "core_cultivation"],
  ["contacts-filter-purpose", "calling_purpose"],
  ["contacts-filter-gyc-status", "gyc_status"],
];

// free-text columns (Name, PG Name) only ever offer an All / Blank Only
// filter — there's no fixed value set to pick from like the columns above.
const BLANK_ONLY_FILTER_FIELDS = [
  ["contacts-filter-name", "name"],
  ["contacts-filter-pg-name", "pg_name"],
];

// numeric columns (Sessions, Calls) filter to an exact count typed in.
const NUMBER_FILTER_FIELDS = [
  ["contacts-filter-sessions", "sessions_count"],
  ["contacts-filter-calls", "calls_count"],
];

// rebuilds a header filter's option list from live data while keeping
// whatever the admin currently has selected (falls back to "All" if that
// value no longer exists, e.g. an event got deleted).
function populateFilterSelect(select, values, blankLabel = "—") {
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="__ALL__">All</option><option value="">${blankLabel}</option>` +
    values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  select.value = [...select.options].some((o) => o.value === current) ? current : "__ALL__";
}

async function renderContactsTable(searchTerm = "") {
  const tbody = document.getElementById("contacts-table-body");
  tbody.innerHTML = `<tr><td colspan="16" class="loading-row">Loading contacts…</td></tr>`;

  const sortSelect = document.getElementById("contacts-sort");
  const sortVal = sortSelect ? sortSelect.value : "s_no-asc";
  const [field, direction] = sortVal.split("-");
  const ascending = direction === "asc";

  let query = supabase.from("contacts").select("*");
  if (field === "s_no") {
    query = query.order("s_no", { ascending, nullsFirst: false });
  } else {
    query = query.order(field, { ascending, nullsFirst: false });
  }

  if (searchTerm) {
    // A pasted phone number may carry a "+91"/country-code prefix or spaces —
    // also try the normalized last-10-digits so it still matches mob_no.
    const normalizedPhone = normalizePhoneInput(searchTerm);
    query = normalizedPhone.length === 10 && normalizedPhone !== searchTerm
      ? query.or(`name.ilike.%${searchTerm}%,mob_no.ilike.%${searchTerm}%,mob_no.ilike.%${normalizedPhone}%`)
      : query.or(`name.ilike.%${searchTerm}%,mob_no.ilike.%${searchTerm}%`);
  }

  // "All" (default) applies no filter; picking a real value shows only rows
  // with that value; picking the blank option shows only untagged rows.
  let anyFilterActive = !!searchTerm;
  for (const [selectId, filterField] of COLUMN_FILTER_FIELDS) {
    const val = document.getElementById(selectId)?.value ?? "__ALL__";
    if (val === "__ALL__") continue;
    anyFilterActive = true;
    query = val === "" ? query.is(filterField, null) : query.eq(filterField, val);
  }

  // Name/PG Name have no fixed value set — only "All" vs "Blank Only" (name
  // can never actually be null due to its not-null constraint, so blank there
  // means empty string; pg_name can be either).
  for (const [selectId, filterField] of BLANK_ONLY_FILTER_FIELDS) {
    const val = document.getElementById(selectId)?.value ?? "__ALL__";
    if (val !== "__BLANK__") continue;
    anyFilterActive = true;
    query = query.or(`${filterField}.is.null,${filterField}.eq.`);
  }

  for (const [inputId, filterField] of NUMBER_FILTER_FIELDS) {
    const raw = document.getElementById(inputId)?.value ?? "";
    if (raw === "") continue;
    const num = parseInt(raw, 10);
    if (Number.isNaN(num)) continue;
    anyFilterActive = true;
    query = query.eq(filterField, num);
  }

  const { data, error } = await query.limit(2000);
  if (error) {
    tbody.innerHTML = `<tr><td colspan="16" class="loading-row">Could not load contacts.</td></tr>`;
    return;
  }
  if (!data || !data.length) {
    tbody.innerHTML = `<tr><td colspan="16" class="loading-row">No contacts found.</td></tr>`;
    return;
  }

  const mobNos = data.map((c) => c.mob_no);
  const [{ data: userRows }] = await Promise.all([
    supabase.from("users").select("user_name").eq("role", "Coordinator").order("user_name"),
    loadEvents(),
  ]);

  populateFilterSelect(document.getElementById("contacts-filter-cultivation"), (userRows || []).map((u) => u.user_name));
  populateFilterSelect(document.getElementById("contacts-filter-purpose"), eventsCache.map((e) => e.code));

  // Contacts sharing the same phone number are duplicate entries — flag the
  // oldest one green and every later duplicate red.
  const phoneGroups = new Map();
  data.forEach((c) => {
    const key = (c.mob_no || "").trim();
    if (!key) return;
    if (!phoneGroups.has(key)) phoneGroups.set(key, []);
    phoneGroups.get(key).push(c);
  });
  const oldestIdByPhone = new Map();
  phoneGroups.forEach((rows, key) => {
    if (rows.length < 2) return;
    const oldest = [...rows].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : Infinity;
      const tb = b.created_at ? new Date(b.created_at).getTime() : Infinity;
      return ta - tb;
    })[0];
    oldestIdByPhone.set(key, oldest.id);
  });

  tbody.innerHTML = data.map((c, i) => {
    const phoneKey = (c.mob_no || "").trim();
    const dupGroup = phoneGroups.get(phoneKey);
    let rowClass = "";
    if (dupGroup && dupGroup.length > 1) {
      rowClass = oldestIdByPhone.get(phoneKey) === c.id ? "contact-original" : "contact-duplicate";
    }
    return `
    <tr data-id="${c.id}"${rowClass ? ` class="${rowClass}"` : ""}>
      <td data-label="S.No">${anyFilterActive ? i + 1 : (c.s_no ?? i + 1)}</td>
      <td data-label="Time Stamp">${c.created_at ? new Date(c.created_at).toLocaleString() : ""}</td>
      <td data-label="Name"><input class="inline-edit" data-field="name" value="${escapeHtml(c.name)}" /></td>
      <td data-label="Phone"><input class="inline-edit" data-field="mob_no" value="${c.mob_no}" /></td>
      <td data-label="PG Name"><input class="inline-edit" data-field="pg_name" value="${escapeHtml(c.pg_name || "")}" /></td>
      <td data-label="Profession">
        <select class="inline-edit" data-field="ws">
          ${WS_ADMIN_OPTIONS.map((o) => `<option value="${o}" ${o === (c.ws || "NA") ? "selected" : ""}>${o}</option>`).join("")}
        </select>
      </td>
      <td data-label="Gender">
        <select class="inline-edit" data-field="gender">
          ${GENDER_ADMIN_OPTIONS.map((o) => `<option value="${o}" ${o === (c.gender || "") ? "selected" : ""}>${o || "—"}</option>`).join("")}
        </select>
      </td>
      <td data-label="Sessions"><button class="cell-chip info-link" data-kind="sessions" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">${c.sessions_count}</button></td>
      <td data-label="Calls"><button class="cell-chip info-link" data-kind="calls" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">${c.calls_count}</button></td>
      <td data-label="Admin Tag to Users">
        <select class="inline-edit" data-field="admin_tag_to_users">
          ${ADMIN_TAG_TO_USERS_OPTIONS.map((t) => `<option value="${t}" ${t === (c.admin_tag_to_users || "") ? "selected" : ""}>${t || "—"}</option>`).join("")}
        </select>
      </td>
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
      <td data-label="GFY/AOMC">
        <select class="inline-edit" data-field="gyc_status">
          ${GYC_STATUS_OPTIONS.map((t) => `<option value="${t}" ${t === (c.gyc_status || "") ? "selected" : ""}>${t || "—"}</option>`).join("")}
        </select>
      </td>
      <td data-label="Admin Review"><button class="cell-chip admin-review-link" data-id="${c.id}" data-name="${escapeHtml(c.name)}" data-review="${escapeHtml(c.admin_remarks || "")}">${c.admin_remarks ? "✎ Edit" : "+ Add"}</button></td>
      <td data-label=""><button class="cell-chip danger delete-contact-btn" data-id="${c.id}" data-name="${escapeHtml(c.name)}">Delete</button></td>
    </tr>
  `;
  }).join("");

  applyContactsColumnOrder(getContactsColumnOrder());

  tbody.querySelectorAll(".inline-edit").forEach((el) => {
    el.addEventListener("change", async (e) => {
      const row = e.target.closest("tr");
      const id = row.dataset.id;
      const field = e.target.dataset.field;
      const contact = data.find((c) => c.id === id);
      let value = e.target.value.trim();

      if (field === "mob_no") {
        value = normalizePhoneInput(value);
        if (value.length !== 10) {
          showToast("Phone number must be exactly 10 digits.", "error");
          e.target.value = contact.mob_no;
          return;
        }
        e.target.value = value;
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

      if (field === "admin_tag_to_users") {
        await syncCoordinatorUser(contact, value || null);
      }

      // Core Cultivation is never auto-assigned — setting it here *is* the
      // manual assign action. Picking a user creates/moves the assignment to
      // them; clearing it removes the assignment (their call disappears from
      // that user's list, matching the cleared relationship).
      if (field === "core_cultivation") {
        if (value && contact.calling_purpose) {
          const { error: assignErr } = await supabase
            .from("assignments")
            .upsert({ contact_id: id, user_name: value, event_code: contact.calling_purpose }, { onConflict: "contact_id,event_code" });
          if (assignErr) showToast("Cultivation saved, but assigning failed: " + assignErr.message, "warning");
        } else if (!value && contact.calling_purpose) {
          await supabase.from("assignments").delete().eq("contact_id", id).eq("event_code", contact.calling_purpose);
        } else if (value && !contact.calling_purpose) {
          showToast("Cultivation saved, but this contact has no Calling Purpose to assign them for.", "warning");
        }
      }

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

  tbody.querySelectorAll(".delete-contact-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      openDeleteContactModal(e.target.dataset.id, e.target.dataset.name);
    });
  });

  // Mobile Click Details modal listener
  tbody.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (window.innerWidth <= 640) {
        const target = e.target;
        if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.closest("button") || target.closest(".info-link") || target.closest(".admin-review-link") || target.closest("td[data-label='Phone']")) {
          return;
        }
        const inputMob = row.querySelector("input[data-field='mob_no']") || row.querySelector("td[data-label='Phone'] input");
        const inputName = row.querySelector("input[data-field='name']") || row.querySelector("td[data-label='Name'] input");
        const mob = inputMob ? inputMob.value : "";
        const name = inputName ? inputName.value : "";
        if (mob) {
          openContactInfoModal("details", mob, name, false);
        }
      }
    });
  });

  lastContactsData = data;
}

const INFO_MODAL_TITLES = { sessions: "Session Attendance", calls: "Calling History", reviews: "User Reviews" };

async function openContactInfoModal(kind, mob, name, isNewContact = false) {
  const modal = document.getElementById("contact-info-modal");
  document.getElementById("contact-info-title").textContent = INFO_MODAL_TITLES[kind] || "Contact Details";
  document.getElementById("contact-info-sub").textContent = `${name} · ${formatPhone(mob)}`;
  const thead = document.getElementById("contact-info-thead");
  const tbody = document.getElementById("contact-info-body");
  const modalActions = modal.querySelector(".modal-actions");
  document.getElementById("contact-info-search").classList.add("hidden");
  thead.innerHTML = "";
  tbody.innerHTML = `<tr><td class="loading-row">Loading…</td></tr>`;
  modal.classList.add("active");

  if (kind === "sessions") {
    thead.innerHTML = `<tr><th>Time</th><th>Marked By</th><th>Event</th></tr>`;
    const { data } = await supabase.from("session_attendance").select("ts,took_by,event_code").eq("mob_no", mob).order("ts", { ascending: false });
    tbody.innerHTML = (data && data.length)
      ? data.map((r) => `<tr><td data-label="Time">${new Date(r.ts).toLocaleString()}</td><td data-label="Marked By">${escapeHtml(r.took_by)}</td><td data-label="Event">${escapeHtml(r.event_code || "—")}</td></tr>`).join("")
      : `<tr><td colspan="3" class="loading-row">No sessions attended yet.</td></tr>`;
  } else if (kind === "calls") {
    thead.innerHTML = `<tr><th>Time</th><th>Caller</th><th>Event</th><th>Status</th><th>Comment</th></tr>`;
    const { data } = await supabase.from("call_responses").select("ts,caller_name,event_code,remarks,addl_remarks").eq("mob_no", mob).order("ts", { ascending: false });
    tbody.innerHTML = (data && data.length)
      ? data.map((r) => `
          <tr>
            <td data-label="Time">${new Date(r.ts).toLocaleString()}</td>
            <td data-label="Caller">${escapeHtml(r.caller_name)}</td>
            <td data-label="Event">${escapeHtml(r.event_code || "")}</td>
            <td data-label="Status">${escapeHtml(r.remarks)}</td>
            <td data-label="Comment">${escapeHtml(r.addl_remarks || "—")}</td>
          </tr>`).join("")
      : `<tr><td colspan="5" class="loading-row">No calls made yet.</td></tr>`;
  } else if (kind === "reviews") {
    thead.innerHTML = `<tr><th>Caller</th><th>What they said</th></tr>`;
    const { data } = await supabase.from("call_responses").select("ts,caller_name,remarks,addl_remarks").eq("mob_no", mob).order("ts", { ascending: false });
    const withNotes = (data || []).filter((r) => r.addl_remarks && r.addl_remarks.trim());
    tbody.innerHTML = withNotes.length
      ? withNotes.map((r) => `
          <tr>
            <td data-label="Caller">${escapeHtml(r.caller_name)} <span class="muted-text">(${new Date(r.ts).toLocaleDateString()})</span></td>
            <td data-label="Said">${escapeHtml(r.addl_remarks)}</td>
          </tr>`).join("")
      : `<tr><td colspan="2" class="loading-row">No reviews from users yet.</td></tr>`;
  } else if (kind === "details") {
    thead.innerHTML = `<tr><th>Field</th><th>Value</th></tr>`;
    if (isNewContact) {
      const contact = newContactsCache.find((c) => c.mob_no === mob);
      if (!contact) {
        tbody.innerHTML = `<tr><td colspan="2" class="loading-row">Contact details not found in cache.</td></tr>`;
        return;
      }
      const fields = [
        { name: "Name", value: escapeHtml(contact.name) },
        { name: "Phone", value: formatPhone(contact.mob_no) },
        { name: "PG Name", value: escapeHtml(contact.pg_name || "—") },
        { name: "Profession (W/S)", value: escapeHtml(contact.ws || "—") },
        { name: "Gender", value: escapeHtml(contact.gender || "—") },
        { name: "Admin Tag to Users", value: escapeHtml(contact.admin_tag_to_users || "—") },
        { name: "Admin Tag", value: escapeHtml(contact.admin_tag || "—") },
        { name: "Core Cultivation", value: escapeHtml(contact.core_cultivation || "—") },
        { name: "Calling Purpose", value: escapeHtml(contact.calling_purpose || "—") },
        { name: "Admin Remarks", value: escapeHtml(contact.admin_remarks || "—") }
      ];
      tbody.innerHTML = fields.map(f => `
        <tr>
          <td data-label="Field" style="font-weight:700;color:var(--text-muted);text-transform:uppercase;font-size:11px;">${f.name}</td>
          <td data-label="Value">${f.value}</td>
        </tr>
      `).join("");
    } else {
      const { data: contact } = await supabase.from("contacts").select("*").eq("mob_no", mob).maybeSingle();
      if (!contact) {
        tbody.innerHTML = `<tr><td colspan="2" class="loading-row">Contact details not found.</td></tr>`;
        return;
      }
      const fields = [
        { name: "Time Stamp", value: contact.created_at ? new Date(contact.created_at).toLocaleString() : "—" },
        { name: "Name", value: escapeHtml(contact.name) },
        { name: "Phone", value: formatPhone(contact.mob_no) },
        { name: "PG Name", value: escapeHtml(contact.pg_name || "—") },
        { name: "Profession (W/S)", value: escapeHtml(contact.ws || "—") },
        { name: "Gender", value: escapeHtml(contact.gender || "—") },
        { name: "Sessions", value: contact.sessions_count || 0 },
        { name: "Calls", value: contact.calls_count || 0 },
        { name: "Admin Tag to Users", value: escapeHtml(contact.admin_tag_to_users || "—") },
        { name: "Admin Tag", value: escapeHtml(contact.admin_tag || "—") },
        { name: "Core Cultivation", value: escapeHtml(contact.core_cultivation || "—") },
        { name: "Calling Purpose", value: escapeHtml(contact.calling_purpose || "—") },
        { name: "GFY/AOMC", value: escapeHtml(contact.gyc_status || "—") },
        { name: "Admin Remarks", value: escapeHtml(contact.admin_remarks || "—") }
      ];
      tbody.innerHTML = fields.map(f => `
        <tr>
          <td data-label="Field" style="font-weight:700;color:var(--text-muted);text-transform:uppercase;font-size:11px;">${f.name}</td>
          <td data-label="Value">${f.value}</td>
        </tr>
      `).join("");
    }
  }

  // Dynamic actions rendering to support mobile click operations
  if (isNewContact && kind === "details") {
    modalActions.innerHTML = `
      <button id="contact-info-close" class="btn btn-secondary">Close</button>
      <button class="btn btn-primary" id="modal-add-contact-btn">Add to Master</button>
      <button class="btn btn-secondary" id="modal-del-contact-btn" style="color:var(--danger);border-color:var(--danger);">Delete</button>
    `;
    modalActions.querySelector("#modal-add-contact-btn").onclick = async () => {
      modal.classList.remove("active");
      const contact = newContactsCache.find(c => c.mob_no === mob);
      if (contact) {
        await promoteSingleContact(contact);
      }
    };
    modalActions.querySelector("#modal-del-contact-btn").onclick = async () => {
      if (!confirm(`Delete ${name}?`)) return;
      modal.classList.remove("active");
      const contact = newContactsCache.find(c => c.mob_no === mob);
      if (contact) {
        const ok = await deleteContactsFromSheetsCall([contact.mob_no]);
        if (ok) {
          showToast("Deleted from Sheets", "success");
          await loadNewContacts(true);
        } else {
          showToast("Failed to delete from Sheets", "error");
        }
      }
    };
  } else {
    modalActions.innerHTML = `<button id="contact-info-close" class="btn btn-secondary">Close</button>`;
  }
  modalActions.querySelector("#contact-info-close").onclick = () => modal.classList.remove("active");
}

let contactInfoModalWired = false;
function wireContactInfoModal() {
  if (contactInfoModalWired) return;
  contactInfoModalWired = true;
  const modal = document.getElementById("contact-info-modal");
  document.getElementById("contact-info-close").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
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

let deleteContactId = null;

function openDeleteContactModal(contactId, name) {
  deleteContactId = contactId;
  document.getElementById("delete-contact-message").textContent =
    `Are you sure you want to permanently delete ${name}? This cannot be undone.`;
  document.getElementById("delete-contact-modal").classList.add("active");
}

let deleteContactModalWired = false;
function wireDeleteContactModal() {
  if (deleteContactModalWired) return;
  deleteContactModalWired = true;
  const modal = document.getElementById("delete-contact-modal");
  document.getElementById("delete-contact-cancel").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("delete-contact-confirm").onclick = async () => {
    const btn = document.getElementById("delete-contact-confirm");
    btn.disabled = true;
    btn.textContent = "Deleting…";
    const { error } = await supabase.from("contacts").delete().eq("id", deleteContactId);
    btn.disabled = false;
    btn.textContent = "Permanently Delete";
    if (error) {
      showToast("Delete failed: " + error.message, "error");
      return;
    }
    modal.classList.remove("active");
    showToast("Contact deleted", "success");
    renderContactsTable(document.getElementById("contacts-search").value.trim());
  };
}

function wireContactsSearch() {
  if (contactsSearchWired) return;
  contactsSearchWired = true;
  const input = document.getElementById("contacts-search");
  let t;
  const handleSearch = () => {
    clearTimeout(t);
    t = setTimeout(() => renderContactsTable(input.value.trim()), 300);
  };
  input.addEventListener("input", handleSearch);
  input.addEventListener("search", handleSearch);

  const sortSelect = document.getElementById("contacts-sort");
  if (sortSelect) {
    sortSelect.addEventListener("change", handleSearch);
  }

  for (const [selectId] of COLUMN_FILTER_FIELDS) {
    const filterSelect = document.getElementById(selectId);
    if (filterSelect) filterSelect.addEventListener("change", handleSearch);
  }
  for (const [selectId] of BLANK_ONLY_FILTER_FIELDS) {
    const filterSelect = document.getElementById(selectId);
    if (filterSelect) filterSelect.addEventListener("change", handleSearch);
  }
  for (const [inputId] of NUMBER_FILTER_FIELDS) {
    const filterInput = document.getElementById(inputId);
    if (filterInput) filterInput.addEventListener("input", handleSearch);
  }
}

const CONTACT_CSV_HEADERS = [
  "S No", "Time Stamp", "Name", "Phone", "PG Name", "Profession", "Gender", "Sessions", "Calls", "Admin Tag to Users",
  "Admin Tag", "Core Cultivation", "Calling Purpose", "GFY/AOMC", "Company Name", "Admin Remarks",
];

let contactsImportExportWired = false;
function wireContactsImportExport() {
  if (contactsImportExportWired) return;
  contactsImportExportWired = true;

  document.getElementById("contacts-export-btn").addEventListener("click", () => {
    const rows = [CONTACT_CSV_HEADERS];
    lastContactsData.forEach((c, i) => {
      rows.push([
        c.s_no ?? i + 1, c.created_at ? new Date(c.created_at).toLocaleString() : "", c.name, c.mob_no,
        c.pg_name || "", c.ws || "NA", c.gender || "", c.sessions_count, c.calls_count,
        c.admin_tag_to_users || "", c.admin_tag || "", c.core_cultivation || "", c.calling_purpose || "",
        c.gyc_status || "", c.company_name || "", c.admin_remarks || "",
      ]);
    });
    downloadExcel(`nrg-master-contact-${todayStamp()}.xlsx`, rows);
  });
}

async function populateContactModalDropdowns() {
  const cultivatorSelect = document.getElementById("add-contact-cultivator");
  const { data: users } = await supabase.from("users").select("user_name").eq("role", "Coordinator").order("user_name");
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
  document.getElementById("add-contact-company").value = "";
  document.getElementById("add-contact-error").classList.add("hidden");

  populateContactModalDropdowns().then(() => {
    document.getElementById("add-contact-ws").value = "NA";
    document.getElementById("add-contact-gender").value = "";
    document.getElementById("add-contact-tag-users").value = "";
    document.getElementById("add-contact-tag").value = "";
    document.getElementById("add-contact-cultivator").value = "";
    document.getElementById("add-contact-event").value = eventsCache[0]?.code || "";
  });

  document.getElementById("add-contact-modal").classList.add("active");
}

function wireAddContactModal() {
  const modal = document.getElementById("add-contact-modal");
  const phoneInput = document.getElementById("add-contact-phone");
  document.getElementById("add-contact-btn").onclick = openAddContactModal;
  document.getElementById("add-contact-cancel").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
  phoneInput.addEventListener("input", (e) => { e.target.value = normalizePhoneInput(e.target.value); });

  let saving = false;
  document.getElementById("add-contact-submit").onclick = async () => {
    if (saving) return;
    const phone = normalizePhoneInput(phoneInput.value);
    const name = document.getElementById("add-contact-name").value.trim();
    const errorEl = document.getElementById("add-contact-error");
    if (!name || !/^[0-9]{10}$/.test(phone)) {
      errorEl.textContent = "Please enter a valid Name and 10-digit Phone Number.";
      errorEl.classList.remove("hidden");
      return;
    }
    // Every new contact goes through the New Contacts review queue now — even
    // one typed in here — so there is a single place where contacts enter
    // Master Contact and nothing lands in it unreviewed.
    const payload = {
      mob_no: phone,
      name,
      staying: document.getElementById("add-contact-pg").value.trim() || null,
      company_name: document.getElementById("add-contact-company").value.trim() || null,
      ws: document.getElementById("add-contact-ws").value,
      gender: document.getElementById("add-contact-gender").value || null,
      admin_tag_to_users: document.getElementById("add-contact-tag-users").value || null,
      admin_tag: document.getElementById("add-contact-tag").value || null,
      core_cultivation: document.getElementById("add-contact-cultivator").value || null,
      calling_purpose: document.getElementById("add-contact-event").value || null,
      collected_by: "Admin",
      source: "Master Contact",
    };

    saving = true;
    document.getElementById("add-contact-submit").textContent = "Saving…";
    const [{ data: dupContact }, { data: dupQueued }] = await Promise.all([
      supabase.from("contacts").select("id").eq("mob_no", phone).maybeSingle(),
      supabase.from("contact_collection").select("id").eq("mob_no", phone).maybeSingle(),
    ]);
    if (dupContact || dupQueued) {
      saving = false;
      document.getElementById("add-contact-submit").textContent = "Save";
      errorEl.textContent = dupContact
        ? "This phone number already exists in Master Contact."
        : "This number is already waiting in the New Contacts queue.";
      errorEl.classList.remove("hidden");
      return;
    }

    const { error } = await supabase.from("contact_collection").insert(payload);
    saving = false;
    document.getElementById("add-contact-submit").textContent = "Save";

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }

    modal.classList.remove("active");
    showToast("Sent to New Contacts for review", "success");
  };
}

/* ======================= MESSAGE (Body Text) ======================= */

function renderMessageImagePreview(url) {
  const wrap = document.getElementById("message-image-preview-wrap");
  const img = document.getElementById("message-image-preview");
  if (url) {
    img.src = url;
    wrap.classList.remove("hidden");
  } else {
    img.src = "";
    wrap.classList.add("hidden");
  }
}

export async function initMessage() {
  const textEl = document.getElementById("message-text");
  const errorEl = document.getElementById("message-error");
  const pickBtn = document.getElementById("pick-message-image-btn");
  const fileInput = document.getElementById("message-image-input");
  const removeBtn = document.getElementById("remove-message-image-btn");
  errorEl.classList.add("hidden");

  textEl.value = (await getSetting("message_text")) || "";
  renderMessageImagePreview(await getSetting("poster_url"));

  pickBtn.onclick = () => fileInput.click();

  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;

    pickBtn.disabled = true;
    pickBtn.textContent = "Uploading…";
    try {
      const blob = await compressImageFile(file);
      const path = `message/poster-${Date.now()}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(path, blob, { contentType: "image/jpeg" });
      if (uploadError) throw uploadError;
      const { data: pub } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);

      await setSetting("poster_url", pub.publicUrl);
      renderMessageImagePreview(pub.publicUrl);
      showToast("Image attached", "success");
    } catch (err) {
      showToast(err.message || "Image upload failed", "error");
    }
    pickBtn.disabled = false;
    pickBtn.textContent = "Attach Image";
  };

  removeBtn.onclick = async () => {
    await setSetting("poster_url", "");
    renderMessageImagePreview("");
    showToast("Image removed", "success");
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
  wireAssignedContactsFilters();
  wireGeneralDataModal();
  const userSelect = document.getElementById("analytics-user-select");
  const eventSelect = document.getElementById("analytics-event-select");
  const fromInput = document.getElementById("analytics-from");
  const toInput = document.getElementById("analytics-to");

  const { data: users } = await supabase.from("users").select("user_name").eq("role", "Coordinator").order("user_name");
  userSelect.innerHTML = `<option value="__ALL__">All Users (Combined)</option>` +
    (users || []).map((u) => `<option value="${u.user_name}">${u.user_name}</option>`).join("");

  eventSelect.innerHTML = `<option value="">All events</option>` +
    eventsCache.map((e) => `<option value="${e.code}">${e.name} (${e.code})</option>`).join("");

  if (!fromInput.value) {
    const todayStr = new Date().toISOString().slice(0, 10);
    fromInput.value = todayStr;
    toInput.value = todayStr;
  }

  const run = () => runAnalytics(userSelect.value, fromInput.value, toInput.value, eventSelect.value);
  if (!analyticsWired) {
    analyticsWired = true;
    document.getElementById("analytics-run-btn").addEventListener("click", run);
    document.getElementById("card-assigned").addEventListener("click", () => openAnalyticsStatModal("assigned"));
    document.getElementById("card-calls-made").addEventListener("click", () => openAnalyticsStatModal("calls"));
    document.getElementById("card-positive").addEventListener("click", () => openAnalyticsStatModal("positive"));
    document.getElementById("card-pending").addEventListener("click", () => openAnalyticsStatModal("pending"));
    document.getElementById("analytics-export-btn").addEventListener("click", () => {
      const readTable = (tableEl) => {
        const rows = [Array.from(tableEl.querySelectorAll("thead th")).map((th) => (th.querySelector(".th-label")?.textContent || th.textContent).trim())];
        tableEl.querySelectorAll("tbody tr").forEach((tr) => {
          rows.push(Array.from(tr.children).map((td) => td.textContent.trim()));
        });
        return rows;
      };
      const rows = [
        [`Calls Made: ${document.getElementById("analytics-total-calls").textContent}`],
        [],
        ["Currently Assigned Contacts"], ...readTable(document.getElementById("analytics-assigned-body").closest("table")),
        [],
        ["Core Cultivation Health"], ...readTable(document.getElementById("analytics-cultivation-body").closest("table")),
      ];
      downloadExcel(`nrg-analytics-${todayStamp()}.xlsx`, rows);
    });
  }
  if (userSelect.value) run();
}

// same categorization used on the caller's own stats bar, so the numbers agree across the app
const ANALYTICS_POSITIVE = ["joining the session", "next week will join", "will try to attend"];
// "yet to call again" kept for older rows already saved under the previous label
const ANALYTICS_NEGATIVE = ["out of station", "wrong number", "shifted to home town", "yet to call again", "need to call again", "available on weekend", "others"];
const ANALYTICS_PENDING = ["not done", "yet to call", ""];
function callOutcomeCategory(remarks) {
  const s = (remarks || "").toLowerCase();
  if (ANALYTICS_NEGATIVE.includes(s)) return "negative";
  if (ANALYTICS_POSITIVE.includes(s)) return "positive";
  if (ANALYTICS_PENDING.includes(s)) return "pending";
  return "negative"; // any other/unrecognized status is a real outcome, not an uncalled contact
}

let currentAnalyticsParams = null;
let lastAssignedContacts = [];

// re-applies the Caller/Status/Called? header filters over the already-fetched
// assignment list — no re-query needed, this table's data is small and local.
function renderAssignedContactsTable() {
  const assignedBody = document.getElementById("analytics-assigned-body");
  if (!assignedBody) return;
  const callerFilter = document.getElementById("analytics-assigned-filter-caller")?.value ?? "__ALL__";
  const statusFilter = document.getElementById("analytics-assigned-filter-status")?.value ?? "__ALL__";
  const calledFilter = document.getElementById("analytics-assigned-filter-called")?.value ?? "__ALL__";

  let rows = lastAssignedContacts;
  if (callerFilter !== "__ALL__") rows = rows.filter((a) => a.user_name === callerFilter);
  if (statusFilter !== "__ALL__") {
    rows = statusFilter === "" ? rows.filter((a) => !a.status || a.status === "Not Done") : rows.filter((a) => a.status === statusFilter);
  }
  if (calledFilter !== "__ALL__") {
    const wantCalled = calledFilter === "yes";
    rows = rows.filter((a) => (((a.status || "Not Done") !== "Not Done")) === wantCalled);
  }

  assignedBody.innerHTML = rows.length
    ? rows.map((a, idx) => `
        <tr>
          <td data-label="S.No">${idx + 1}</td>
          <td data-label="Caller">${escapeHtml(a.user_name)}</td>
          <td data-label="Name">${escapeHtml(a.contacts?.name || "—")}</td>
          <td data-label="Phone">${formatPhone(a.contacts?.mob_no || "")}</td>
          <td data-label="Status">${escapeHtml(a.status || "")}</td>
          <td data-label="Called?">${(a.status || "Not Done") !== "Not Done" ? "✅" : "—"}</td>
        </tr>`).join("")
    : `<tr><td colspan="6" class="loading-row">No contacts currently assigned.</td></tr>`;
}

let assignedContactsFiltersWired = false;
function wireAssignedContactsFilters() {
  if (assignedContactsFiltersWired) return;
  assignedContactsFiltersWired = true;
  ["analytics-assigned-filter-caller", "analytics-assigned-filter-status", "analytics-assigned-filter-called"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", renderAssignedContactsTable);
  });
}

// one-glance snapshot across every Coordinator's current live assignment load
// — assigned/positive/pending straight from the live assignments table, same
// categorization as everywhere else (callOutcomeCategory).
let generalDataModalWired = false;
function wireGeneralDataModal() {
  if (generalDataModalWired) return;
  generalDataModalWired = true;
  const modal = document.getElementById("general-data-modal");
  document.getElementById("general-data-close").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  let generalDataZoom = 100;
  const zoomBox = document.getElementById("general-data-modal-box");
  const zoomLevel = document.getElementById("general-data-zoom-level");
  const applyGeneralDataZoom = () => {
    // `zoom` (not transform: scale) re-lays out the whole modal box at the
    // target size — text and borders stay crisp for screenshots instead of
    // being rastered/blurred the way a CSS transform scale would be.
    zoomBox.style.zoom = generalDataZoom + "%";
    zoomLevel.textContent = generalDataZoom + "%";
  };
  document.getElementById("general-data-zoom-in").onclick = () => {
    generalDataZoom = Math.min(200, generalDataZoom + 10);
    applyGeneralDataZoom();
  };
  document.getElementById("general-data-zoom-out").onclick = () => {
    generalDataZoom = Math.max(40, generalDataZoom - 10);
    applyGeneralDataZoom();
  };

  document.getElementById("general-data-btn").onclick = async () => {
    modal.classList.add("active");
    const tbody = document.getElementById("general-data-body");
    tbody.innerHTML = `<tr><td colspan="6" class="loading-row">Loading…</td></tr>`;

    const { data: assignments } = await supabase.from("assignments").select("user_name,status");

    const stats = {};
    (assignments || []).forEach((a) => {
      if (!stats[a.user_name]) stats[a.user_name] = { assigned: 0, positive: 0, pending: 0 };
      const s = stats[a.user_name];
      s.assigned++;
      const category = callOutcomeCategory(a.status);
      if (category === "positive") s.positive++;
      else if (category === "pending") s.pending++;
    });

    const rows = Object.entries(stats).filter(([, s]) => s.assigned > 0).sort((a, b) => a[0].localeCompare(b[0]));
    tbody.innerHTML = rows.length
      ? rows.map(([name, s], idx) => {
          const completedPct = s.assigned > 0 ? Math.round(((s.assigned - s.pending) / s.assigned) * 100) + "%" : "—";
          return `
          <tr>
            <td data-label="S.No">${idx + 1}</td>
            <td data-label="User">${escapeHtml(name)}</td>
            <td data-label="Assigned">${s.assigned}</td>
            <td data-label="Positive">${s.positive}</td>
            <td data-label="Pending">${s.pending}</td>
            <td data-label="Completed %">${completedPct}</td>
          </tr>`;
        }).join("")
      : `<tr><td colspan="6" class="loading-row">No contacts currently assigned to anyone.</td></tr>`;
  };
}

async function openAnalyticsStatModal(statType) {
  if (!currentAnalyticsParams) return;
  const { userName, isAll, fromTs, toTs, eventFilter, currentEventCode } = currentAnalyticsParams;
  const activeEvent = eventFilter || currentEventCode;

  const modal = document.getElementById("contact-info-modal");
  const thead = document.getElementById("contact-info-thead");
  const tbody = document.getElementById("contact-info-body");

  tbody.innerHTML = `<tr><td class="loading-row">Loading…</td></tr>`;
  modal.classList.add("active");

  const searchInput = document.getElementById("contact-info-search");
  searchInput.value = "";
  searchInput.classList.remove("hidden");
  searchInput.oninput = () => {
    const q = searchInput.value.trim().toLowerCase();
    tbody.querySelectorAll("tr").forEach((tr) => {
      tr.classList.toggle("hidden", !!q && !tr.textContent.toLowerCase().includes(q));
    });
  };

  const exportBtn = document.getElementById("contact-info-export-btn");
  exportBtn.classList.toggle("hidden", statType !== "pending");
  exportBtn.onclick = () => {
    const rows = [Array.from(thead.querySelectorAll("th")).map((th) => th.textContent.trim())];
    tbody.querySelectorAll("tr").forEach((tr) => {
      rows.push(Array.from(tr.children).map((td) => td.textContent.trim()));
    });
    downloadExcel(`nrg-pending-contacts-${todayStamp()}.xlsx`, rows);
  };

  if (statType === "assigned") {
    document.getElementById("contact-info-title").textContent = "Assigned Contacts Details";
    document.getElementById("contact-info-sub").textContent = isAll ? "All Users (Combined)" : userName;
    thead.innerHTML = `<tr><th>S.No</th>${isAll ? "<th>Caller</th>" : ""}<th>Name</th><th>Phone</th><th>Campaign</th></tr>`;

    let query = supabase
      .from("assignments")
      .select("user_name, event_code, contacts(name, mob_no)");
    // Only filter by event if the user explicitly selected a specific event
    if (eventFilter) query = query.eq("event_code", eventFilter);
    else if (activeEvent) query = query.eq("event_code", activeEvent);
    if (!isAll) query = query.eq("user_name", userName);
    query = query.order("event_code");

    const { data, error } = await query;
    if (error) {
      tbody.innerHTML = `<tr><td colspan="${isAll ? 5 : 4}" class="loading-row">Error loading assignments: ${error.message}</td></tr>`;
      return;
    }
    if (!data || !data.length) {
      tbody.innerHTML = `<tr><td colspan="${isAll ? 5 : 4}" class="loading-row">No assigned contacts found.</td></tr>`;
      return;
    }

    // group rows by caller so one person's contacts sit together, not interleaved with others'
    data.sort((a, b) => a.user_name.localeCompare(b.user_name));

    tbody.innerHTML = data.map((a, idx) => `
      <tr>
        <td data-label="S.No">${idx + 1}</td>
        ${isAll ? `<td data-label="Caller">${escapeHtml(a.user_name)}</td>` : ""}
        <td data-label="Name">${escapeHtml(a.contacts?.name || "—")}</td>
        <td data-label="Phone" class="phone-clickable" title="Click to copy phone number">${formatPhone(a.contacts?.mob_no || "")}</td>
        <td data-label="Campaign">${escapeHtml(a.event_code)}</td>
      </tr>
    `).join("");
  } else if (statType === "pending") {
    document.getElementById("contact-info-title").textContent = "Pending Contacts Details";
    document.getElementById("contact-info-sub").textContent = isAll ? "All Users (Combined)" : userName;
    thead.innerHTML = `<tr><th>S.No</th>${isAll ? "<th>Caller</th>" : ""}<th>Name</th><th>Phone</th><th>Campaign</th></tr>`;

    let query = supabase
      .from("assignments")
      .select("user_name, event_code, status, contacts(name, mob_no)")
      .in("status", ["Not Done", "yet to call", ""]);
    if (eventFilter) query = query.eq("event_code", eventFilter);
    else if (activeEvent && !eventFilter) {
      // In case we want to show all events if eventFilter is empty
      // query = query.eq("event_code", activeEvent);
      // Wait, if eventFilter is empty, we do NOT filter by event_code to show all events
    } else if (activeEvent) {
      query = query.eq("event_code", activeEvent);
    }
    if (!isAll) query = query.eq("user_name", userName);
    query = query.order("event_code");

    const { data, error } = await query;
    if (error) {
      tbody.innerHTML = `<tr><td colspan="${isAll ? 5 : 4}" class="loading-row">Error loading pending assignments: ${error.message}</td></tr>`;
      return;
    }
    if (!data || !data.length) {
      tbody.innerHTML = `<tr><td colspan="${isAll ? 5 : 4}" class="loading-row">No pending contacts found.</td></tr>`;
      return;
    }

    // group rows by caller so one person's contacts sit together, not interleaved with others'
    data.sort((a, b) => a.user_name.localeCompare(b.user_name));

    tbody.innerHTML = data.map((a, idx) => `
      <tr>
        <td data-label="S.No">${idx + 1}</td>
        ${isAll ? `<td data-label="Caller">${escapeHtml(a.user_name)}</td>` : ""}
        <td data-label="Name">${escapeHtml(a.contacts?.name || "—")}</td>
        <td data-label="Phone" class="phone-clickable" title="Click to copy phone number">${formatPhone(a.contacts?.mob_no || "")}</td>
        <td data-label="Campaign">${escapeHtml(a.event_code)}</td>
      </tr>
    `).join("");
  } else {
    // call response stats (calls or positive)
    let title = statType === "positive" ? "Positive Responses" : "Calls Made";
    document.getElementById("contact-info-title").textContent = title;
    document.getElementById("contact-info-sub").textContent = isAll ? "All Users (Combined)" : userName;
    thead.innerHTML = `<tr><th>S.No</th><th>Time</th>${isAll ? "<th>Caller</th>" : ""}<th>Name</th><th>Phone</th><th>Status</th></tr>`;

    let query = supabase
      .from("call_responses")
      .select("ts, caller_name, contact_name, mob_no, remarks, addl_remarks")
      .order("ts", { ascending: false });

    if (eventFilter) query = query.eq("event_code", eventFilter);
    if (!isAll) query = query.eq("caller_name", userName);
    if (fromTs) query = query.gte("ts", fromTs);
    if (toTs) query = query.lte("ts", toTs);

    const { data, error } = await query;
    if (error) {
      tbody.innerHTML = `<tr><td colspan="${isAll ? 6 : 5}" class="loading-row">Error loading call responses.</td></tr>`;
      return;
    }

    let filtered = data || [];
    if (statType === "positive") {
      filtered = filtered.filter((r) => callOutcomeCategory(r.remarks) === "positive");
    }

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="${isAll ? 6 : 5}" class="loading-row">No responses found.</td></tr>`;
      return;
    }

    // group rows by caller so one person's calls sit together, not interleaved with others'
    filtered.sort((a, b) => a.caller_name.localeCompare(b.caller_name));

    tbody.innerHTML = filtered.map((r, idx) => `
      <tr>
        <td data-label="S.No">${idx + 1}</td>
        <td data-label="Time">${new Date(r.ts).toLocaleString()}</td>
        ${isAll ? `<td data-label="Caller">${escapeHtml(r.caller_name)}</td>` : ""}
        <td data-label="Name">${escapeHtml(r.contact_name || "")}</td>
        <td data-label="Phone" class="phone-clickable" title="Click to copy phone number">${formatPhone(r.mob_no)}</td>
        <td data-label="Status">${escapeHtml(r.remarks)}${r.addl_remarks ? " — " + escapeHtml(r.addl_remarks) : ""}</td>
      </tr>
    `).join("");
  }
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

  currentAnalyticsParams = { userName, isAll, fromTs, toTs, eventFilter, currentEventCode };

  // total calls made in the selected range, broken down by outcome
  let callsQuery = supabase.from("call_responses").select("remarks");
  if (!isAll) callsQuery = callsQuery.eq("caller_name", userName);
  if (fromTs) callsQuery = callsQuery.gte("ts", fromTs);
  if (toTs) callsQuery = callsQuery.lte("ts", toTs);
  if (eventFilter) callsQuery = callsQuery.eq("event_code", eventFilter);
  const { data: callsInRange } = await callsQuery;
  if (isStale()) return;
  const outcomeCounts = { positive: 0, negative: 0, pending: 0 };
  (callsInRange || []).forEach((r) => {
    outcomeCounts[callOutcomeCategory(r.remarks)]++;
  });
  document.getElementById("analytics-total-calls").textContent = (callsInRange || []).length;
  document.getElementById("analytics-positive-calls").textContent = outcomeCounts.positive;

  let liveAssignmentsQuery = supabase.from("assignments").select("event_code");
  if (!isAll) liveAssignmentsQuery = liveAssignmentsQuery.eq("user_name", userName);

  let pendingQuery = supabase.from("assignments").select("id", { count: "exact", head: true }).in("status", ["Not Done", "yet to call", ""]);
  if (eventFilter) pendingQuery = pendingQuery.eq("event_code", eventFilter);
  if (!isAll) pendingQuery = pendingQuery.eq("user_name", userName);

  const [{ count: pendingCount }, { data: liveAssignments }] = await Promise.all([
    pendingQuery,
    liveAssignmentsQuery,
  ]);
  if (isStale()) return;

  document.getElementById("analytics-pending-calls").textContent = pendingCount || 0;

  // Total Assigned reflects only who is actually assigned right now (the live
  // round) — matching the "Assigned Contacts Details" drill-down, which can
  // only ever show live rows since past rounds' individual assignment rows
  // are gone once archived into assignment_rounds. Summing in historical
  // round totals here made the tile disagree with its own drill-down.
  const totalAssigned = (liveAssignments || []).filter((a) => !eventFilter || a.event_code === eventFilter).length;
  document.getElementById("analytics-total-assigned").textContent = totalAssigned;

  // currently assigned contacts (always reflects the live/current round)
  // If no current event is set, show all live assignments across every event
  let assignedQuery = supabase.from("assignments").select("user_name,status,event_code,contacts(name,mob_no)");
  if (currentEventCode) assignedQuery = assignedQuery.eq("event_code", currentEventCode);
  if (!isAll) assignedQuery = assignedQuery.eq("user_name", userName);
  const { data: assignedContacts } = await assignedQuery;
  if (isStale()) return;
  // group rows by caller so one person's contacts sit together, not interleaved with others'
  if (assignedContacts) assignedContacts.sort((a, b) => a.user_name.localeCompare(b.user_name));
  lastAssignedContacts = assignedContacts || [];
  populateFilterSelect(
    document.getElementById("analytics-assigned-filter-caller"),
    [...new Set(lastAssignedContacts.map((a) => a.user_name))].filter(Boolean).sort()
  );
  populateFilterSelect(
    document.getElementById("analytics-assigned-filter-status"),
    [...new Set(lastAssignedContacts.map((a) => a.status))].filter(Boolean).sort(),
    ""
  );
  renderAssignedContactsTable();

  // core cultivation health: is the cultivator actually calling the people cultivated to them?
  let cultivatedQuery = supabase.from("contacts").select("name,mob_no,core_cultivation");
  cultivatedQuery = isAll ? cultivatedQuery.not("core_cultivation", "is", null) : cultivatedQuery.eq("core_cultivation", userName);
  const { data: cultivated } = await cultivatedQuery;
  if (isStale()) return;
  // group rows by cultivator so one person's contacts sit together, not interleaved with others'
  if (cultivated) cultivated.sort((a, b) => (a.core_cultivation || "").localeCompare(b.core_cultivation || ""));
  const cultivationBody = document.getElementById("analytics-cultivation-body");
  if (!cultivated || !cultivated.length) {
    cultivationBody.innerHTML = `<tr><td colspan="6" class="loading-row">No contacts cultivated${isAll ? "" : " to this user"}.</td></tr>`;
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
    cultivationBody.innerHTML = cultivated.map((c, idx) => {
      const key = keyOf(c.mob_no, c.core_cultivation);
      return `
      <tr>
        <td data-label="S.No">${idx + 1}</td>
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
    d.setDate(d.getDate() - 5);
    fromInput.value = d.toISOString().slice(0, 10);
    toInput.value = new Date().toISOString().slice(0, 10);
  }

  const run = () => runReceptionAnalytics(eventSelect.value, fromInput.value, toInput.value);
  if (!receptionAnalyticsWired) {
    receptionAnalyticsWired = true;
    document.getElementById("reception-analytics-run-btn").addEventListener("click", run);
    document.getElementById("reception-analytics-export-btn").addEventListener("click", () => {
      const table = document.getElementById("reception-analytics-attendance-body").closest("table");
      exportTableToExcel(table, `nrg-reception-analytics-${todayStamp()}.xlsx`);
    });
  }
  run();
}

let receptionAnalyticsRequestId = 0;

async function runReceptionAnalytics(eventCode, fromDate, toDate) {
  const requestId = ++receptionAnalyticsRequestId;
  const isStale = () => requestId !== receptionAnalyticsRequestId;

  const fromTs = fromDate ? new Date(fromDate + "T00:00:00").toISOString() : null;
  const toTs = toDate ? new Date(toDate + "T23:59:59").toISOString() : null;

  // overall contacts across every event — the full master contact pool, unfiltered
  const { count: overallContacts } = await supabase.from("contacts").select("id", { count: "exact", head: true });
  if (isStale()) return;
  document.getElementById("reception-analytics-overall-contacts").textContent = overallContacts ?? 0;

  // total contacts registered under the selected event — a pool size, not date-bounded
  let contactsQuery = supabase.from("contacts").select("id", { count: "exact", head: true });
  if (eventCode) contactsQuery = contactsQuery.eq("calling_purpose", eventCode);
  const { count: totalContacts } = await contactsQuery;
  if (isStale()) return;
  document.getElementById("reception-analytics-total-contacts").textContent = totalContacts ?? 0;
  const eventLabel = eventCode ? (eventsCache.find((e) => e.code === eventCode)?.name || eventCode) : "All Events";
  document.getElementById("reception-analytics-event-label").textContent = eventLabel;

  // calls made / positive responses — from the permanent call log, scoped to
  // the same date range + event as everything else on this tab (assignments
  // reflects only the live/current round, so it can't be date-bounded).
  let callsQuery = supabase.from("call_responses").select("remarks");
  if (fromTs) callsQuery = callsQuery.gte("ts", fromTs);
  if (toTs) callsQuery = callsQuery.lte("ts", toTs);
  if (eventCode) callsQuery = callsQuery.eq("event_code", eventCode);
  const { data: callsInRange } = await callsQuery;
  if (isStale()) return;
  let callsMade = 0;
  let positive = 0;
  (callsInRange || []).forEach((r) => {
    callsMade++;
    if (callOutcomeCategory(r.remarks) === "positive") positive++;
  });
  document.getElementById("reception-analytics-calls-made").textContent = callsMade;
  document.getElementById("reception-analytics-positive").textContent = positive;

  // attendance in the selected range
  let attendanceQuery = supabase.from("session_attendance").select("id,ts,name,mob_no,took_by,event_code").order("ts", { ascending: false });
  if (fromTs) attendanceQuery = attendanceQuery.gte("ts", fromTs);
  if (toTs) attendanceQuery = attendanceQuery.lte("ts", toTs);
  if (eventCode) attendanceQuery = attendanceQuery.eq("event_code", eventCode);
  const { data: attendance } = await attendanceQuery;
  if (isStale()) return;

  const rows = attendance || [];
  document.getElementById("reception-analytics-attendance-count").textContent = rows.length;
  const tbody = document.getElementById("reception-analytics-attendance-body");

  // Group repeat markings for the same phone number together (most-recent
  // group first, newest record within a group first) instead of leaving
  // duplicates scattered across the plain time-desc order.
  const groups = new Map();
  rows.forEach((r) => {
    if (!groups.has(r.mob_no)) groups.set(r.mob_no, []);
    groups.get(r.mob_no).push(r);
  });
  const groupArr = [...groups.values()];
  groupArr.sort((a, b) => new Date(b[0].ts) - new Date(a[0].ts));
  const sorted = groupArr.flat();

  tbody.innerHTML = sorted.length
    ? sorted.map((r, idx) => {
        const dupGroup = groups.get(r.mob_no);
        const isDuplicate = dupGroup.length > 1;
        const isOldest = isDuplicate && dupGroup[dupGroup.length - 1].id === r.id;
        const rowClass = isDuplicate ? (isOldest ? "contact-original" : "contact-duplicate") : "";
        return `
        <tr data-id="${r.id}"${rowClass ? ` class="${rowClass}"` : ""}>
          <td data-label="S.No">${idx + 1}</td>
          <td data-label="Time">${new Date(r.ts).toLocaleString()}</td>
          <td data-label="Name">${escapeHtml(r.name || "")}</td>
          <td data-label="Phone">${formatPhone(r.mob_no)}</td>
          <td data-label="Event">
            <select class="inline-edit attendance-event-select" data-att-id="${r.id}">
              <option value="">—</option>
              ${eventsCache.map((e) => `<option value="${e.code}" ${e.code === (r.event_code || "") ? "selected" : ""}>${e.code}</option>`).join("")}
            </select>
          </td>
          <td data-label="Marked By">${escapeHtml(r.took_by)}</td>
          <td class="no-export"><button class="cell-chip danger attendance-delete-btn" data-id="${r.id}" data-name="${escapeHtml(r.name || "")}">✕ Delete</button></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="7" class="loading-row">No attendance marked in this range.</td></tr>`;

  // Wire event change dropdowns
  tbody.querySelectorAll(".attendance-event-select").forEach((sel) => {
    sel.addEventListener("change", async (e) => {
      const attId = sel.dataset.attId;
      const newCode = sel.value || null;
      const { error } = await supabase.from("session_attendance").update({ event_code: newCode }).eq("id", attId);
      if (error) {
        showToast("Could not update event: " + error.message, "error");
      } else {
        showToast("Event updated", "success");
      }
    });
  });

  tbody.querySelectorAll(".attendance-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(`Delete this attendance record for ${btn.dataset.name || "this contact"}? This also reduces their session count by one.`)) return;
      btn.disabled = true;
      btn.textContent = "…";
      const { error } = await supabase.from("session_attendance").delete().eq("id", btn.dataset.id);
      if (error) {
        showToast("Could not delete: " + error.message, "error");
        btn.disabled = false;
        btn.textContent = "✕ Delete";
        return;
      }
      showToast("Attendance record deleted", "success");
      runReceptionAnalytics(eventCode, fromDate, toDate);
    });
  });
}

/* ======================= NEW CONTACTS & DUPLICATE RESOLUTION ======================= */

let newContactsPollInterval = null;
let sheetsWebhookUrl = "";
let newContactsCache = [];
let duplicateQueue = [];
let currentDuplicateIndex = 0;
let isResolvingDuplicates = false;
let isFetchingNewContacts = false;
let newContactsWired = false;

// The review queue every new contact now passes through — Contact Collection,
// Reception's "not found" form, and Master Contact's "+ Add Contact" all land
// here rather than writing to `contacts` directly. Separate, much simpler
// pipeline than the Sheets-based New Contacts table above: Add promotes into
// Master Contact (skipped if the phone's already there; admin resolves that
// manually), Delete just dismisses the lead.
async function renderCollectionSubmissions() {
  const tbody = document.getElementById("collection-submissions-admin-body");
  tbody.innerHTML = `<tr><td colspan="11" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from("contact_collection")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="11" class="loading-row">Could not load submissions.</td></tr>`;
    return;
  }
  if (!data || !data.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="loading-row">No submissions yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.map((r, i) => `
    <tr data-id="${r.id}">
      <td data-label="S.No">${i + 1}</td>
      <td data-label="Time">${new Date(r.created_at).toLocaleString()}</td>
      <td data-label="Name">${escapeHtml(r.name)}</td>
      <td data-label="Phone" class="phone-cell">${formatPhone(r.mob_no)}</td>
      <td data-label="Profession">${escapeHtml(r.ws || r.profession || "—")}</td>
      <td data-label="Gender">${escapeHtml(r.gender || "—")}</td>
      <td data-label="Staying">${escapeHtml(r.staying || "—")}</td>
      <td data-label="Comment">${escapeHtml(r.comment || "—")}</td>
      <td data-label="Collected By">${escapeHtml(r.collected_by || "—")}</td>
      <td data-label="Source">${escapeHtml(r.source || "Contact Collection")}</td>
      <td data-label="">
        <button class="cell-chip collection-add-btn" data-id="${r.id}">+ Add</button>
        <button class="cell-chip danger collection-delete-btn" data-id="${r.id}">Delete</button>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".collection-add-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = data.find((r) => r.id === btn.dataset.id);
      if (!row) return;
      btn.disabled = true;
      const { data: existing } = await supabase.from("contacts").select("id").eq("mob_no", row.mob_no).maybeSingle();
      if (existing) {
        showToast(`${row.name}'s phone number is already in Master Contact — resolve manually there.`, "warning");
        btn.disabled = false;
        return;
      }
      const { error: insErr } = await supabase.from("contacts").insert({
        mob_no: row.mob_no,
        name: row.name,
        gender: row.gender || null,
        pg_name: row.staying || null,
        // Contact Collection asks for a free-text "profession"; Reception and
        // Master Contact send a real W/S value, so prefer that when present.
        ws: row.ws || row.profession || "NA",
        company_name: row.company_name || null,
        calling_purpose: row.calling_purpose || null,
        gyc_status: row.gyc_status || null,
        admin_tag: row.admin_tag || null,
        admin_tag_to_users: row.admin_tag_to_users || null,
        core_cultivation: row.core_cultivation || null,
        admin_remarks: row.comment || null,
      });
      if (insErr) {
        showToast("Add failed: " + insErr.message, "error");
        btn.disabled = false;
        return;
      }
      if (row.admin_tag_to_users === "Coordinator") {
        await syncCoordinatorUser({ name: row.name, mob_no: row.mob_no }, "Coordinator");
      }
      await supabase.from("contact_collection").delete().eq("id", row.id);
      showToast(`${row.name} added to Master Contact`, "success");
      renderCollectionSubmissions();
    });
  });

  tbody.querySelectorAll(".collection-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this submission?")) return;
      await supabase.from("contact_collection").delete().eq("id", btn.dataset.id);
      renderCollectionSubmissions();
    });
  });
}

export async function initNewContacts() {
  stopNewContactsPolling(); // safety clean-up

  const refreshBtn = document.getElementById("new-contacts-refresh-btn");
  const addAllBtn = document.getElementById("new-contacts-add-all-btn");

  if (!newContactsWired) {
    newContactsWired = true;
    refreshBtn.addEventListener("click", () => {
      loadNewContacts(true);
    });
    addAllBtn.addEventListener("click", () => {
      addAllNewContacts();
    });

    const modal = document.getElementById("duplicate-modal");
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeDuplicateModal();
        isResolvingDuplicates = false;
        initNewContacts(); // resume
      }
    });
  }

  // Independent of the Sheets bridge below — always load regardless of
  // whether apps_script_webhook_url is configured.
  await renderCollectionSubmissions();

  const summaryEl = document.getElementById("new-contacts-summary");
  summaryEl.textContent = "Connecting to Sheets...";

  sheetsWebhookUrl = await getSetting("apps_script_webhook_url");
  if (!sheetsWebhookUrl) {
    summaryEl.textContent = "Error: Apps Script Webhook URL is not configured in Settings.";
    document.getElementById("new-contacts-table-body").innerHTML =
      `<tr><td colspan="7" class="loading-row">Please configure apps_script_webhook_url in DB settings first.</td></tr>`;
    return;
  }

  await loadEvents();

  // Load immediately
  await loadNewContacts();

  // Poll every 3 seconds
  newContactsPollInterval = setInterval(() => {
    loadNewContacts();
  }, 3000);
}

export function stopNewContactsPolling() {
  if (newContactsPollInterval) {
    clearInterval(newContactsPollInterval);
    newContactsPollInterval = null;
  }
}

let newContactsCoordinators = [];

async function loadNewContacts(forceShowLoading = false) {
  if (isResolvingDuplicates) return;
  if (isFetchingNewContacts) return;

  const tbody = document.getElementById("new-contacts-table-body");
  const summaryEl = document.getElementById("new-contacts-summary");

  if (forceShowLoading || tbody.innerHTML.includes("Connecting")) {
    tbody.innerHTML = `<tr><td colspan="15" class="loading-row">Loading new contacts from Sheets…</td></tr>`;
  }

  isFetchingNewContacts = true;
  try {
    const url = sheetsWebhookUrl + "?action=get_new_contacts";
    const [response, { data: coordinators }] = await Promise.all([
      fetch(url),
      supabase.from("users").select("user_name").eq("role", "Coordinator").order("user_name")
    ]);

    if (!response.ok) throw new Error("HTTP error " + response.status);
    const result = await response.json();

    if (isResolvingDuplicates) return; // guard against overlaps

    if (!result.ok) {
      throw new Error(result.error || "Unknown Apps Script error");
    }

    newContactsCoordinators = coordinators || [];
    newContactsCache = result.data || [];
    renderNewContactsTable();
  } catch (err) {
    console.error("Failed to load new contacts:", err);
    summaryEl.textContent = "Failed to sync: " + err.message;
  } finally {
    isFetchingNewContacts = false;
  }
}

function renderNewContactsTable() {
  const tbody = document.getElementById("new-contacts-table-body");
  const summaryEl = document.getElementById("new-contacts-summary");

  if (!newContactsCache.length) {
    tbody.innerHTML = `<tr><td colspan="16" class="loading-row">No new contacts found in Google Sheets.</td></tr>`;
    summaryEl.textContent = "Checked just now. All clear!";
    return;
  }

  summaryEl.textContent = `Found ${newContactsCache.length} new contact(s) in Sheets.`;

  const activeEvent = document.getElementById("event-select")?.value || "";

  tbody.innerHTML = newContactsCache.map((c, idx) => {
    const selectedEvent = c.calling_purpose || activeEvent;
    return `
      <tr data-index="${idx}">
        <td data-label="S.No">${idx + 1}</td>
        <td data-label="Time Stamp">${c.time_stamp ? new Date(c.time_stamp).toLocaleString() : "—"}</td>
        <td data-label="Name"><input class="inline-edit new-contact-inline-edit" data-field="name" data-index="${idx}" value="${escapeHtml(c.name)}" /></td>
        <td data-label="Phone"><input class="inline-edit new-contact-inline-edit" data-field="mob_no" data-index="${idx}" value="${c.mob_no}" /></td>
        <td data-label="PG Name"><input class="inline-edit new-contact-inline-edit" data-field="pg_name" data-index="${idx}" value="${escapeHtml(c.pg_name || "")}" /></td>
        <td data-label="Profession">
          <select class="inline-edit new-contact-ws-select" data-index="${idx}">
            ${WS_ADMIN_OPTIONS.map((o) => `<option value="${o}" ${o === (c.ws || "NA") ? "selected" : ""}>${o}</option>`).join("")}
          </select>
        </td>
        <td data-label="Gender">
          <select class="inline-edit new-contact-gender-select" data-index="${idx}">
            ${GENDER_ADMIN_OPTIONS.map((o) => `<option value="${o}" ${o === (c.gender || "") ? "selected" : ""}>${o || "—"}</option>`).join("")}
          </select>
        </td>
        <td data-label="Sessions"><button class="cell-chip new-contact-sessions-btn" data-index="${idx}">${c.sessions ? c.sessions.split(",").filter(s => s.trim()).length : 0}</button></td>
        <td data-label="Calls">0</td>
        <td data-label="Admin Tag to Users">
          <select class="inline-edit new-contact-tag-users-select" data-index="${idx}">
            ${ADMIN_TAG_TO_USERS_OPTIONS.map((t) => `<option value="${t}" ${t === (c.admin_tag_to_users || "") ? "selected" : ""}>${t || "—"}</option>`).join("")}
          </select>
        </td>
        <td data-label="Admin Tag">
          <select class="inline-edit new-contact-tag-select" data-index="${idx}">
            ${ADMIN_TAG_OPTIONS.map((t) => `<option value="${t}" ${t === (c.admin_tag || "") ? "selected" : ""}>${t || "—"}</option>`).join("")}
          </select>
        </td>
        <td data-label="Core Cultivation">
          <select class="inline-edit new-contact-cult-select" data-index="${idx}">
            <option value="">—</option>
            ${newContactsCoordinators.map((u) => `<option value="${u.user_name}" ${u.user_name === (c.core_cultivation || "") ? "selected" : ""}>${u.user_name}</option>`).join("")}
          </select>
        </td>
        <td data-label="Calling Purpose">
          <select class="inline-edit new-contact-event-select" data-index="${idx}">
            <option value="">— select —</option>
            ${eventsCache.map((e) => `<option value="${e.code}" ${e.code === selectedEvent ? "selected" : ""}>${e.code}</option>`).join("")}
          </select>
        </td>
        <td data-label="User Reviews"><button class="cell-chip" disabled>—</button></td>
        <td data-label="Admin Review"><button class="cell-chip new-contact-review-btn" data-index="${idx}">${c.admin_remarks ? "✎ Edit" : "+ Add"}</button></td>
        <td data-label="Actions" class="no-export">
          <div class="row-actions" style="display:flex;gap:6px;justify-content:flex-end;">
            <button class="btn btn-primary new-contact-add-btn" data-index="${idx}" style="padding:4px 10px;font-size:12px;">Add</button>
            <button class="btn btn-secondary new-contact-del-btn" data-index="${idx}" style="padding:4px 10px;font-size:12px;color:var(--danger);border-color:var(--danger);">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".new-contact-ws-select").forEach((select) => {
    select.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      newContactsCache[idx].ws = e.target.value;
    });
  });

  tbody.querySelectorAll(".new-contact-gender-select").forEach((select) => {
    select.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      newContactsCache[idx].gender = e.target.value || null;
    });
  });

  tbody.querySelectorAll(".new-contact-tag-users-select").forEach((select) => {
    select.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      newContactsCache[idx].admin_tag_to_users = e.target.value || null;
    });
  });

  tbody.querySelectorAll(".new-contact-tag-select").forEach((select) => {
    select.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      newContactsCache[idx].admin_tag = e.target.value || null;
    });
  });

  tbody.querySelectorAll(".new-contact-cult-select").forEach((select) => {
    select.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      newContactsCache[idx].core_cultivation = e.target.value || null;
    });
  });

  tbody.querySelectorAll(".new-contact-inline-edit").forEach((input) => {
    input.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      const field = e.target.dataset.field;
      let value = e.target.value.trim();
      if (field === "mob_no") {
        value = normalizePhoneInput(value);
        e.target.value = value;
      }
      newContactsCache[idx][field] = value || null;
    });
  });

  tbody.querySelectorAll(".new-contact-event-select").forEach((select) => {
    select.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      newContactsCache[idx].calling_purpose = e.target.value;
    });
  });

  tbody.querySelectorAll(".new-contact-sessions-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      const contact = newContactsCache[idx];
      const sessions = contact.sessions ? contact.sessions.split(",").map(s => s.trim()).filter(Boolean) : [];
      const modal = document.getElementById("contact-info-modal");
      document.getElementById("contact-info-title").textContent = "Session Attendance (from Sheets)";
      document.getElementById("contact-info-sub").textContent = `${contact.name} · ${formatPhone(contact.mob_no)}`;
      document.getElementById("contact-info-thead").innerHTML = `<tr><th>#</th><th>Session Date</th></tr>`;
      const tbody2 = document.getElementById("contact-info-body");
      tbody2.innerHTML = sessions.length
        ? sessions.map((d, i) => `<tr><td data-label="#">${i + 1}</td><td data-label="Session Date">${d}</td></tr>`).join("")
        : `<tr><td colspan="2" class="loading-row">No sessions recorded.</td></tr>`;
      document.getElementById("contact-info-search").classList.add("hidden");
      const modalActions = modal.querySelector(".modal-actions");
      modalActions.innerHTML = `<button id="contact-info-close" class="btn btn-secondary">Close</button>`;
      modalActions.querySelector("#contact-info-close").onclick = () => modal.classList.remove("active");
      modal.classList.add("active");
    });
  });

  tbody.querySelectorAll(".new-contact-review-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      const contact = newContactsCache[idx];
      const val = prompt(`Admin Remarks for ${contact.name}:`, contact.admin_remarks || "");
      if (val !== null) {
        newContactsCache[idx].admin_remarks = val.trim() || null;
        btn.textContent = val.trim() ? "✎ Edit" : "+ Add";
      }
    });
  });

  tbody.querySelectorAll(".new-contact-add-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      const contact = newContactsCache[idx];

      btn.disabled = true;
      btn.textContent = "…";
      await promoteSingleContact(contact);
      btn.disabled = false;
      btn.textContent = "Add";
    });
  });

  tbody.querySelectorAll(".new-contact-del-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      const contact = newContactsCache[idx];
      if (!confirm(`Delete ${contact.name} (${formatPhone(contact.mob_no)}) from New Contacts list?`)) return;

      btn.disabled = true;
      btn.textContent = "…";
      const success = await deleteContactsFromSheetsCall([contact.mob_no]);
      if (success) {
        showToast("Contact deleted from Sheets", "success");
        await loadNewContacts(true);
      } else {
        showToast("Failed to delete from Sheets", "error");
        btn.disabled = false;
        btn.textContent = "Delete";
      }
    });
  });

  // Mobile Click Details modal listener for New Contacts
  tbody.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (window.innerWidth <= 640) {
        const target = e.target;
        if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.closest("button") || target.closest(".new-contact-review-btn") || target.closest("td[data-label='Phone']")) {
          return;
        }
        const idx = parseInt(row.dataset.index, 10);
        const contact = newContactsCache[idx];
        if (contact) {
          openContactInfoModal("details", contact.mob_no, contact.name, true);
        }
      }
    });
  });
}

async function deleteContactsFromSheetsCall(mobNos) {
  if (!sheetsWebhookUrl) return false;
  try {
    const response = await fetch(sheetsWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain"
      },
      body: JSON.stringify({
        action: "delete_new_contacts",
        mob_nos: mobNos
      })
    });
    return response.ok;
  } catch (err) {
    console.error("Failed to delete from sheets:", err);
    return false;
  }
}

async function promoteSingleContact(newContact) {
  try {
    const { data: existing, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("mob_no", newContact.mob_no)
      .maybeSingle();

    if (error) throw error;

    if (existing) {
      isResolvingDuplicates = true;
      stopNewContactsPolling();

      openDuplicateModal(existing, newContact, false, async (decision) => {
        closeDuplicateModal();
        isResolvingDuplicates = false;

        if (decision === "keep_existing") {
          await deleteContactsFromSheetsCall([newContact.mob_no]);
          showToast("Kept existing contact, deleted from Sheets", "success");
          initNewContacts();
        } else if (decision === "overwrite") {
          const { error: updateErr } = await supabase
            .from("contacts")
            .update({
              name: newContact.name,
              pg_name: newContact.pg_name || null,
              profession: newContact.profession || null,
              company_name: newContact.company_name || null,
              ws: newContact.ws || "NA",
              gender: newContact.gender || null,
              admin_tag_to_users: newContact.admin_tag_to_users || null,
              admin_tag: newContact.admin_tag || null,
              core_cultivation: newContact.core_cultivation || null,
              calling_purpose: newContact.calling_purpose || null,
              admin_remarks: newContact.admin_remarks || null
            })
            .eq("mob_no", newContact.mob_no);

          if (updateErr) throw updateErr;

          await deleteContactsFromSheetsCall([newContact.mob_no]);
          showToast("Updated existing contact with new details", "success");
          initNewContacts();
        } else {
          initNewContacts();
        }
      });
    } else {
      const { error: insErr } = await supabase
        .from("contacts")
        .insert({
          mob_no: newContact.mob_no,
          name: newContact.name,
          pg_name: newContact.pg_name || null,
          profession: newContact.profession || null,
          company_name: newContact.company_name || null,
          ws: newContact.ws || "NA",
          gender: newContact.gender || null,
          admin_tag_to_users: newContact.admin_tag_to_users || null,
          admin_tag: newContact.admin_tag || null,
          core_cultivation: newContact.core_cultivation || null,
          calling_purpose: newContact.calling_purpose || null,
          admin_remarks: newContact.admin_remarks || null
        });

      if (insErr) throw insErr;

      // Import session history from Sheets Sessions column
      await importSessionsForContact(newContact);

      await deleteContactsFromSheetsCall([newContact.mob_no]);
      showToast(`${newContact.name} added to Master Contacts!`, "success");
      await loadNewContacts(true);
    }
  } catch (err) {
    showToast("Failed to add contact: " + err.message, "error");
  }
}

// Insert session_attendance rows for each date in the Sessions column from Sheets
async function importSessionsForContact(contact) {
  if (!contact.sessions) return;
  const dates = contact.sessions.split(",").map(s => s.trim()).filter(Boolean);
  if (!dates.length) return;
  const rows = dates.map(d => ({
    mob_no: contact.mob_no,
    name: contact.name,
    ts: new Date(d + "T19:00:00").toISOString(),
    took_by: "Imported",
    event_code: contact.calling_purpose || null
  }));
  // upsert-style: ignore conflicts on (mob_no, ts) if there's a unique constraint,
  // otherwise just insert and ignore duplicates
  const { error } = await supabase.from("session_attendance").upsert(rows, { onConflict: "mob_no,ts", ignoreDuplicates: true });
  if (error) console.warn("Session import warning:", error.message);
}

function openDuplicateModal(existingContact, newContact, isBulk, resolveCallback) {
  const modal = document.getElementById("duplicate-modal");

  document.getElementById("dup-exist-name").textContent = existingContact.name || "—";
  document.getElementById("dup-exist-phone").textContent = formatPhone(existingContact.mob_no) || "—";
  document.getElementById("dup-exist-pg").textContent = existingContact.pg_name || "—";
  document.getElementById("dup-exist-profession").textContent = (existingContact.profession || "") + (existingContact.ws ? ` (${existingContact.ws})` : "") || "—";
  document.getElementById("dup-exist-gender").textContent = existingContact.gender || "—";
  document.getElementById("dup-exist-event").textContent = existingContact.calling_purpose || "—";
  document.getElementById("dup-exist-remarks").textContent = existingContact.admin_remarks || "—";

  document.getElementById("dup-new-name").textContent = newContact.name || "—";
  document.getElementById("dup-new-phone").textContent = formatPhone(newContact.mob_no) || "—";
  document.getElementById("dup-new-pg").textContent = newContact.pg_name || "—";
  document.getElementById("dup-new-profession").textContent = (newContact.profession || "") + (newContact.ws ? ` (${newContact.ws})` : "") || "—";
  document.getElementById("dup-new-gender").textContent = newContact.gender || "—";
  document.getElementById("dup-new-event").textContent = newContact.calling_purpose || "—";
  document.getElementById("dup-new-remarks").textContent = newContact.remarks || "—";

  if (isBulk) {
    document.getElementById("duplicate-modal-subtitle").textContent =
      `Resolving duplicate ${currentDuplicateIndex + 1} of ${duplicateQueue.length}. Match phone: ${formatPhone(newContact.mob_no)}`;
  } else {
    document.getElementById("duplicate-modal-subtitle").textContent =
      `Conflict for phone number: ${formatPhone(newContact.mob_no)}`;
  }

  const keepBtn = document.getElementById("dup-keep-existing-btn");
  const overwriteBtn = document.getElementById("dup-overwrite-new-btn");
  const cancelBtn = document.getElementById("dup-cancel-btn");

  keepBtn.disabled = false;
  keepBtn.textContent = "Keep Existing";
  overwriteBtn.disabled = false;
  overwriteBtn.textContent = "Overwrite with New";
  cancelBtn.disabled = false;
  cancelBtn.textContent = isBulk ? "Skip" : "Cancel";

  keepBtn.onclick = async () => {
    keepBtn.disabled = true;
    keepBtn.textContent = "Processing…";
    await resolveCallback("keep_existing");
  };

  overwriteBtn.onclick = async () => {
    overwriteBtn.disabled = true;
    overwriteBtn.textContent = "Processing…";
    await resolveCallback("overwrite");
  };

  cancelBtn.onclick = () => {
    resolveCallback("cancel");
  };

  modal.classList.add("active");
}

function closeDuplicateModal() {
  document.getElementById("duplicate-modal").classList.remove("active");
}

async function addAllNewContacts() {
  const addAllBtn = document.getElementById("new-contacts-add-all-btn");
  if (!newContactsCache.length) {
    showToast("No new contacts to add.", "warning");
    return;
  }

  addAllBtn.disabled = true;
  addAllBtn.textContent = "Processing…";

  try {
    const mobNos = newContactsCache.map(c => c.mob_no);

    const { data: existingList, error } = await supabase
      .from("contacts")
      .select("*")
      .in("mob_no", mobNos);

    if (error) throw error;

    const existingMap = new Map();
    (existingList || []).forEach(c => {
      existingMap.set(c.mob_no, c);
    });

    const toInsert = [];
    const duplicates = [];

    newContactsCache.forEach(c => {
      if (existingMap.has(c.mob_no)) {
        duplicates.push({
          newContact: c,
          existingContact: existingMap.get(c.mob_no)
        });
      } else {
        toInsert.push(c);
      }
    });

    let insertedCount = 0;
    if (toInsert.length) {
      const payload = toInsert.map(c => ({
        mob_no: c.mob_no,
        name: c.name,
        pg_name: c.pg_name || null,
        company_name: c.company_name || null,
        ws: c.ws || "NA",
        gender: c.gender || null,
        admin_tag_to_users: c.admin_tag_to_users || null,
        admin_tag: c.admin_tag || null,
        core_cultivation: c.core_cultivation || null,
        calling_purpose: c.calling_purpose || null,
        admin_remarks: c.admin_remarks || null
      }));

      const { error: insErr } = await supabase.from("contacts").insert(payload);
      if (insErr) throw insErr;

      // Import session history for each contact being added
      await Promise.all(toInsert.map(c => importSessionsForContact(c)));

      const toDeleteMobs = toInsert.map(c => c.mob_no);
      await deleteContactsFromSheetsCall(toDeleteMobs);
      insertedCount = toInsert.length;
    }

    if (duplicates.length) {
      showToast(`Imported ${insertedCount} contacts. ${duplicates.length} duplicate conflicts found.`, "warning");

      isResolvingDuplicates = true;
      stopNewContactsPolling();

      duplicateQueue = duplicates;
      currentDuplicateIndex = 0;

      runBulkDuplicateResolution();
    } else {
      showToast(`All ${insertedCount} contacts imported successfully! 🎉`, "success");
      await loadNewContacts(true);
    }
  } catch (err) {
    showToast("Failed during bulk import: " + err.message, "error");
  } finally {
    addAllBtn.disabled = false;
    addAllBtn.textContent = "Add All to Master";
  }
}

function runBulkDuplicateResolution() {
  if (currentDuplicateIndex >= duplicateQueue.length) {
    closeDuplicateModal();
    isResolvingDuplicates = false;
    showToast("Finished duplicate resolution!", "success");
    initNewContacts();
    return;
  }

  const dupItem = duplicateQueue[currentDuplicateIndex];
  openDuplicateModal(dupItem.existingContact, dupItem.newContact, true, async (decision) => {
    try {
      if (decision === "keep_existing") {
        await deleteContactsFromSheetsCall([dupItem.newContact.mob_no]);
        currentDuplicateIndex++;
        runBulkDuplicateResolution();
      } else if (decision === "overwrite") {
        const { error } = await supabase
          .from("contacts")
          .update({
            name: dupItem.newContact.name,
            pg_name: dupItem.newContact.pg_name || null,
            profession: dupItem.newContact.profession || null,
            company_name: dupItem.newContact.company_name || null,
            ws: dupItem.newContact.ws || "NA",
            gender: dupItem.newContact.gender || null,
            admin_tag_to_users: dupItem.newContact.admin_tag_to_users || null,
            admin_tag: dupItem.newContact.admin_tag || null,
            core_cultivation: dupItem.newContact.core_cultivation || null,
            calling_purpose: dupItem.newContact.calling_purpose || null,
            admin_remarks: dupItem.newContact.admin_remarks || null
          })
          .eq("mob_no", dupItem.newContact.mob_no);

        if (error) throw error;

        await deleteContactsFromSheetsCall([dupItem.newContact.mob_no]);
        currentDuplicateIndex++;
        runBulkDuplicateResolution();
      } else {
        currentDuplicateIndex++;
        runBulkDuplicateResolution();
      }
    } catch (err) {
      showToast("Error resolving duplicate: " + err.message, "error");
      const keepBtn = document.getElementById("dup-keep-existing-btn");
      const overwriteBtn = document.getElementById("dup-overwrite-new-btn");
      keepBtn.disabled = false;
      keepBtn.textContent = "Keep Existing";
      overwriteBtn.disabled = false;
      overwriteBtn.textContent = "Overwrite with New";
    }
  });
}

/* ======================= FULL DB DOWNLOAD (ZIP of CSVs) ======================= */

export async function downloadAllDbData() {
  const btn = document.getElementById("download-all-db-btn");
  btn.disabled = true;
  btn.textContent = "…";
  showToast("Preparing full database export…", "info");

  const DB_TABLES = [
    "users",
    "contacts",
    "assignments",
    "assignment_rounds",
    "call_responses",
    "session_attendance",
    "events",
    "settings",
  ];

  try {
    const allData = {};
    for (const table of DB_TABLES) {
      const { data, error } = await supabase.from(table).select("*");
      if (error) {
        console.warn(`Could not fetch ${table}:`, error.message);
        allData[table] = [];
      } else {
        allData[table] = data || [];
      }
    }

    const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");

    const wb = XLSX.utils.book_new();
    for (const table of DB_TABLES) {
      const rows = allData[table];
      const aoa = rows.length
        ? [Object.keys(rows[0]), ...rows.map((row) => Object.keys(rows[0]).map((h) => {
            const v = row[h];
            return v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v;
          }))]
        : [["(empty)"]];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws, table.slice(0, 31)); // Excel sheet names cap at 31 chars
    }
    XLSX.writeFile(wb, `FNRG_Preaching_Full_DB_${timestamp}.xlsx`);

    showToast(`Exported ${DB_TABLES.length} tables successfully! 📁`, "success");
  } catch (err) {
    console.error("DB export error:", err);
    showToast("Export failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇";
  }
}

/* ======================= BULK DELETE DATA ======================= */

const BULK_DELETE_ALL_UUID = "00000000-0000-0000-0000-000000000000";

let bulkDeleteWired = false;
let bulkDeleteUser = null;
let pendingBulkDelete = null; // { cfg, count }

export async function openBulkDeleteModal(currentUser) {
  bulkDeleteUser = currentUser;
  wireBulkDeleteModal();
  document.getElementById("bulk-delete-error").classList.add("hidden");
  document.getElementById("bulk-delete-type").value = "contacts";
  document.getElementById("bulk-delete-contacts-scope").value = "all";
  showBulkDeleteFilter("contacts");
  showBulkDeleteSub(document.getElementById("bulk-delete-filter-contacts"), "all");
  document.getElementById("bulk-delete-modal").classList.add("active");
  document.getElementById("bulk-delete-preview").textContent = "Checking…";
  await populateBulkDeleteDropdowns();
  refreshBulkDeletePreview();
}

async function populateBulkDeleteDropdowns() {
  eventsLoaded = false;
  await loadEvents();
  const eventOptionsHtml = `<option value="">— select —</option>` +
    eventsCache.map((e) => `<option value="${e.code}">${e.name} (${e.code})</option>`).join("");

  ["bulk-delete-contacts-purpose", "bulk-delete-attendance-event", "bulk-delete-calls-event", "bulk-delete-assignments-event"]
    .forEach((id) => { document.getElementById(id).innerHTML = eventOptionsHtml; });

  document.getElementById("bulk-delete-contacts-admin-tag").innerHTML =
    `<option value="">— select —</option>` + ADMIN_TAG_OPTIONS.filter(Boolean).map((t) => `<option value="${t}">${t}</option>`).join("");
  document.getElementById("bulk-delete-contacts-tag-to-users").innerHTML =
    `<option value="">— select —</option>` + ADMIN_TAG_TO_USERS_OPTIONS.filter(Boolean).map((t) => `<option value="${t}">${t}</option>`).join("");

  const { data: callerRows } = await supabase.from("users").select("user_name").order("user_name");
  document.getElementById("bulk-delete-calls-caller").innerHTML =
    `<option value="">— select —</option>` + (callerRows || []).map((u) => `<option value="${u.user_name}">${u.user_name}</option>`).join("");

  document.getElementById("bulk-delete-events-checklist").innerHTML = eventsCache.map((e) => `
    <label class="tag-check"><input type="checkbox" class="bulk-delete-event-check" value="${e.code}" /> ${escapeHtml(e.name)} (${e.code})</label>
  `).join("") || `<p class="muted-text">No events found.</p>`;
}

function showBulkDeleteFilter(type) {
  document.querySelectorAll(".bulk-delete-filter").forEach((el) => el.classList.add("hidden"));
  document.getElementById(`bulk-delete-filter-${type}`).classList.remove("hidden");
}

function showBulkDeleteSub(container, scope) {
  container.querySelectorAll(".bulk-delete-sub").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.scope !== scope);
  });
}

function getBulkDeleteConfig() {
  const type = document.getElementById("bulk-delete-type").value;

  if (type === "contacts") {
    const scope = document.getElementById("bulk-delete-contacts-scope").value;
    if (scope === "purpose") {
      const val = document.getElementById("bulk-delete-contacts-purpose").value;
      if (!val) return { error: "Please select a calling purpose (event)." };
      return { table: "contacts", apply: (q) => q.eq("calling_purpose", val), label: `Master Contacts with Calling Purpose "${val}"` };
    }
    if (scope === "admin_tag") {
      const val = document.getElementById("bulk-delete-contacts-admin-tag").value;
      if (!val) return { error: "Please select an admin tag." };
      return { table: "contacts", apply: (q) => q.eq("admin_tag", val), label: `Master Contacts with Admin Tag "${val}"` };
    }
    if (scope === "admin_tag_to_users") {
      const val = document.getElementById("bulk-delete-contacts-tag-to-users").value;
      if (!val) return { error: "Please select an admin tag to users value." };
      return { table: "contacts", apply: (q) => q.eq("admin_tag_to_users", val), label: `Master Contacts with Admin Tag to Users "${val}"` };
    }
    return { table: "contacts", apply: (q) => q.neq("id", BULK_DELETE_ALL_UUID), label: "ALL Master Contacts" };
  }

  if (type === "session_attendance") {
    const scope = document.getElementById("bulk-delete-attendance-scope").value;
    if (scope === "event") {
      const val = document.getElementById("bulk-delete-attendance-event").value;
      if (!val) return { error: "Please select an event." };
      return { table: "session_attendance", apply: (q) => q.eq("event_code", val), label: `Session Attendance for event "${val}"` };
    }
    return { table: "session_attendance", apply: (q) => q.neq("id", BULK_DELETE_ALL_UUID), label: "ALL Session Attendance records" };
  }

  if (type === "call_responses") {
    const scope = document.getElementById("bulk-delete-calls-scope").value;
    if (scope === "event") {
      const val = document.getElementById("bulk-delete-calls-event").value;
      if (!val) return { error: "Please select an event." };
      return { table: "call_responses", apply: (q) => q.eq("event_code", val), label: `Call Responses for event "${val}"` };
    }
    if (scope === "caller") {
      const val = document.getElementById("bulk-delete-calls-caller").value;
      if (!val) return { error: "Please select a caller." };
      return { table: "call_responses", apply: (q) => q.eq("caller_name", val), label: `Call Responses by caller "${val}"` };
    }
    return { table: "call_responses", apply: (q) => q.neq("id", BULK_DELETE_ALL_UUID), label: "ALL Call Responses" };
  }

  if (type === "assignments") {
    const scope = document.getElementById("bulk-delete-assignments-scope").value;
    if (scope === "event") {
      const val = document.getElementById("bulk-delete-assignments-event").value;
      if (!val) return { error: "Please select an event." };
      return { table: "assignments", apply: (q) => q.eq("event_code", val), label: `Assignments for event "${val}"` };
    }
    return { table: "assignments", apply: (q) => q.neq("id", BULK_DELETE_ALL_UUID), label: "ALL Current Assignments" };
  }

  if (type === "one_to_one") {
    const scope = document.getElementById("bulk-delete-one-to-one-scope").value;
    if (scope === "remarks") {
      return { table: "one_to_one_remarks", apply: (q) => q.neq("id", BULK_DELETE_ALL_UUID), label: "ALL One to One Remarks (by SNKD)" };
    }
    return { table: "help_requests", apply: (q) => q.neq("id", BULK_DELETE_ALL_UUID), label: "ALL One to One Help Requests (Questions)" };
  }

  if (type === "events") {
    const codes = [...document.querySelectorAll(".bulk-delete-event-check:checked")].map((c) => c.value);
    if (!codes.length) return { error: "Please select at least one event to delete." };
    return { table: "events", apply: (q) => q.in("code", codes), label: `Event(s): ${codes.join(", ")}` };
  }

  return { error: "Unknown data type." };
}

async function refreshBulkDeletePreview() {
  const previewEl = document.getElementById("bulk-delete-preview");
  const errorEl = document.getElementById("bulk-delete-error");
  errorEl.classList.add("hidden");
  const cfg = getBulkDeleteConfig();
  if (cfg.error) {
    previewEl.textContent = "";
    return;
  }
  previewEl.textContent = "Checking…";
  let query = supabase.from(cfg.table).select(cfg.table === "events" ? "code" : "id", { count: "exact", head: true });
  query = cfg.apply(query);
  const { count, error } = await query;
  if (error) {
    previewEl.textContent = "";
    errorEl.textContent = "Could not check matching records: " + error.message;
    errorEl.classList.remove("hidden");
    return;
  }
  previewEl.textContent = `${count ?? 0} record${count === 1 ? "" : "s"} match — ${cfg.label}`;
}

function wireBulkDeleteModal() {
  if (bulkDeleteWired) return;
  bulkDeleteWired = true;

  const modal = document.getElementById("bulk-delete-modal");
  document.getElementById("bulk-delete-cancel").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  const typeSelect = document.getElementById("bulk-delete-type");
  typeSelect.addEventListener("change", () => {
    showBulkDeleteFilter(typeSelect.value);
    refreshBulkDeletePreview();
  });

  [
    ["bulk-delete-contacts-scope", "bulk-delete-filter-contacts"],
    ["bulk-delete-attendance-scope", "bulk-delete-filter-session_attendance"],
    ["bulk-delete-calls-scope", "bulk-delete-filter-call_responses"],
    ["bulk-delete-assignments-scope", "bulk-delete-filter-assignments"],
  ].forEach(([scopeId, containerId]) => {
    const scopeSelect = document.getElementById(scopeId);
    const container = document.getElementById(containerId);
    scopeSelect.addEventListener("change", () => {
      showBulkDeleteSub(container, scopeSelect.value);
      refreshBulkDeletePreview();
    });
  });

  [
    "bulk-delete-contacts-purpose", "bulk-delete-contacts-admin-tag", "bulk-delete-contacts-tag-to-users",
    "bulk-delete-attendance-event", "bulk-delete-calls-event", "bulk-delete-calls-caller", "bulk-delete-assignments-event",
  ].forEach((id) => {
    document.getElementById(id).addEventListener("change", refreshBulkDeletePreview);
  });

  document.getElementById("bulk-delete-events-checklist").addEventListener("change", (e) => {
    if (e.target.classList.contains("bulk-delete-event-check")) refreshBulkDeletePreview();
  });

  document.getElementById("bulk-delete-one-to-one-scope").addEventListener("change", refreshBulkDeletePreview);

  document.getElementById("bulk-delete-trigger").onclick = async () => {
    const errorEl = document.getElementById("bulk-delete-error");
    errorEl.classList.add("hidden");
    const cfg = getBulkDeleteConfig();
    if (cfg.error) {
      errorEl.textContent = cfg.error;
      errorEl.classList.remove("hidden");
      return;
    }
    let query = supabase.from(cfg.table).select(cfg.table === "events" ? "code" : "id", { count: "exact", head: true });
    query = cfg.apply(query);
    const { count, error } = await query;
    if (error) {
      errorEl.textContent = "Could not check matching records: " + error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    if (!count) {
      errorEl.textContent = "No records match this filter — nothing to delete.";
      errorEl.classList.remove("hidden");
      return;
    }
    openBulkDeleteGuard(cfg, count);
  };

  wireBulkDeleteGuard();
}

function openBulkDeleteGuard(cfg, count) {
  pendingBulkDelete = { cfg, count };
  document.getElementById("bulk-delete-guard-step1").classList.remove("hidden");
  document.getElementById("bulk-delete-guard-step2").classList.add("hidden");
  document.getElementById("bulk-delete-guard-message").textContent =
    `Are you sure you want to permanently delete ${count} record${count === 1 ? "" : "s"} — ${cfg.label}? This cannot be undone.`;
  document.getElementById("bulk-delete-guard-password").value = "";
  document.getElementById("bulk-delete-guard-error").classList.add("hidden");
  document.getElementById("bulk-delete-guard-modal").classList.add("active");
}

let bulkDeleteGuardWired = false;
function wireBulkDeleteGuard() {
  if (bulkDeleteGuardWired) return;
  bulkDeleteGuardWired = true;

  const guardModal = document.getElementById("bulk-delete-guard-modal");
  const closeGuard = () => {
    guardModal.classList.remove("active");
    pendingBulkDelete = null;
  };
  document.getElementById("bulk-delete-guard-cancel1").onclick = closeGuard;
  document.getElementById("bulk-delete-guard-cancel2").onclick = closeGuard;
  guardModal.addEventListener("click", (e) => { if (e.target === guardModal) closeGuard(); });

  document.getElementById("bulk-delete-guard-yes").onclick = () => {
    document.getElementById("bulk-delete-guard-step1").classList.add("hidden");
    document.getElementById("bulk-delete-guard-step2").classList.remove("hidden");
    setTimeout(() => document.getElementById("bulk-delete-guard-password").focus(), 50);
  };

  document.getElementById("bulk-delete-guard-confirm").onclick = async () => {
    const pwInput = document.getElementById("bulk-delete-guard-password");
    const errorEl = document.getElementById("bulk-delete-guard-error");
    const pw = pwInput.value.trim();
    if (!pw) {
      errorEl.textContent = "Please enter your password.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (!pendingBulkDelete) { closeGuard(); return; }

    const btn = document.getElementById("bulk-delete-guard-confirm");
    btn.disabled = true;
    btn.textContent = "Verifying…";

    const { data: userRow } = await supabase.from("users").select("login_pw").eq("id", bulkDeleteUser.id).maybeSingle();

    if (!userRow || userRow.login_pw !== pw) {
      btn.disabled = false;
      btn.textContent = "Permanently Delete";
      errorEl.textContent = "Incorrect password.";
      errorEl.classList.remove("hidden");
      return;
    }
    errorEl.classList.add("hidden");

    const { cfg, count } = pendingBulkDelete;
    const ok = await executeBulkDelete(cfg);

    btn.disabled = false;
    btn.textContent = "Permanently Delete";

    if (ok) {
      closeGuard();
      document.getElementById("bulk-delete-modal").classList.remove("active");
      showToast(`Deleted ${count} record${count === 1 ? "" : "s"} 🗑`, "success");
    }
  };
}

async function executeBulkDelete(cfg) {
  let query = supabase.from(cfg.table).delete();
  query = cfg.apply(query);
  const { error } = await query;
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return false;
  }

  eventsLoaded = false; // events/contacts data may have shifted — refresh caches on next use

  if (cfg.table === "contacts" && !document.getElementById("admin-contacts-section").classList.contains("hidden")) {
    renderContactsTable(document.getElementById("contacts-search").value.trim());
  }
  if (cfg.table === "events") {
    await loadEvents();
    if (!document.getElementById("admin-users-section").classList.contains("hidden")) initUsers();
  }
  return true;
}
