import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { showToast, formatPhone, escapeHtml, downloadExcel, exportTableToExcel, parseCSV, normalizePhoneInput, ADMIN_TAG_TO_USERS_OPTIONS, syncCoordinatorUser, GYC_STATUS_OPTIONS, initColumnDragReorder, reapplyColumnOrder, initHorizontalScroll, populateFilterSelect, daysAgo, CORE_CULTIVATION_STALE_DAYS } from "./utils.js";

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

// Scoped to checkboxes that carry a tag value — excludes plain toggle
// checkboxes (e.g. "enable time range") that share a group with tag checks.
function getCheckedTags(tagFilterGroup) {
  return Array.from(tagFilterGroup.querySelectorAll('input[type="checkbox"][value]:checked')).map((cb) => cb.value);
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
      updateGfyFilterBadge(gfyGroup);
    });
  });
}

// Small counters on the toolbar filter buttons, so an admin can see a filter
// is narrowed down without opening its dropdown.
function updateTagFilterBadge(tagFilterGroup) {
  const badge = document.getElementById("tag-filter-badge");
  if (!badge) return;
  const count = getCheckedTags(tagFilterGroup).length;
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count === 0);
}

function updateGfyFilterBadge(gfyGroup) {
  const badge = document.getElementById("gfy-filter-badge");
  if (!badge) return;
  badge.classList.toggle("hidden", getGfyFilter(gfyGroup) === "");
}

function updateTimestampFilterBadge(tsGroup) {
  const badge = document.getElementById("ts-filter-badge");
  if (!badge) return;
  badge.classList.toggle("hidden", !tsGroup.querySelector("#ts-filter-enabled").checked);
}

function updateCallStatusFilterBadge(callStatusGroup) {
  const badge = document.getElementById("call-status-filter-badge");
  if (!badge) return;
  const count = getCheckedTags(callStatusGroup).length;
  const timeOn = callStatusGroup.querySelector("#call-status-ts-enabled")?.checked;
  badge.textContent = count ? String(count) : "•";
  badge.classList.toggle("hidden", count === 0 && !timeOn);
}

// Returns null for "no filter", else ISO bounds for submitted_at/ts.
function getCallTimeRange(callStatusGroup) {
  const enabled = callStatusGroup.querySelector("#call-status-ts-enabled");
  if (!enabled || !enabled.checked) return null;
  const from = callStatusGroup.querySelector("#call-status-ts-from").value;
  const to = callStatusGroup.querySelector("#call-status-ts-to").value;
  if (!from && !to) return null;
  return {
    from: from ? new Date(from).toISOString() : null,
    to: to ? new Date(to).toISOString() : null,
    label: `${from ? new Date(from).toLocaleString() : "any time"} → ${to ? new Date(to).toLocaleString() : "now"}`,
  };
}

function wireCallTimeFilter(callStatusGroup) {
  const enabled = callStatusGroup.querySelector("#call-status-ts-enabled");
  const from = callStatusGroup.querySelector("#call-status-ts-from");
  const to = callStatusGroup.querySelector("#call-status-ts-to");
  if (!enabled) return;
  const update = () => {
    updateCallStatusFilterBadge(callStatusGroup);
    updateLiveFilterSummary();
  };
  enabled.addEventListener("change", () => {
    from.disabled = to.disabled = !enabled.checked;
    if (enabled.checked) from.focus();
    update();
  });
  if (from) {
    from.addEventListener("input", update);
    from.addEventListener("change", update);
  }
  if (to) {
    to.addEventListener("input", update);
    to.addEventListener("change", update);
  }
}

// Returns attendance filter object or null if inactive.
function getAttendanceFilter(attendanceGroup) {
  if (!attendanceGroup) return null;
  const attended = attendanceGroup.querySelector("#attendance-filter-attended")?.checked;
  const notAttended = attendanceGroup.querySelector("#attendance-filter-not-attended")?.checked;
  const rangeEnabled = attendanceGroup.querySelector("#attendance-ts-enabled")?.checked;
  let range = null;
  if (rangeEnabled) {
    const from = attendanceGroup.querySelector("#attendance-ts-from")?.value;
    const to = attendanceGroup.querySelector("#attendance-ts-to")?.value;
    if (from || to) {
      range = {
        from: from ? new Date(from).toISOString() : null,
        to: to ? new Date(to).toISOString() : null,
        label: `${from ? new Date(from).toLocaleString() : "any time"} → ${to ? new Date(to).toLocaleString() : "now"}`,
      };
    }
  }
  const mode = attended && !notAttended ? "attended" : notAttended && !attended ? "not_attended" : "all";
  if (mode === "all" && !range) return null;
  return { mode, range };
}

function wireAttendanceFilterGroup(attendanceGroup) {
  const attendedCb = attendanceGroup.querySelector("#attendance-filter-attended");
  const notAttendedCb = attendanceGroup.querySelector("#attendance-filter-not-attended");
  const update = () => {
    updateAttendanceFilterBadge(attendanceGroup);
    updateLiveFilterSummary();
  };
  [attendedCb, notAttendedCb].forEach((cb) => {
    if (!cb) return;
    cb.addEventListener("change", () => {
      if (!attendedCb.checked && !notAttendedCb.checked) {
        cb.checked = true;
        showToast("At least one Attendance filter must stay enabled.", "error");
      }
      update();
    });
  });
  const rangeEnabled = attendanceGroup.querySelector("#attendance-ts-enabled");
  const from = attendanceGroup.querySelector("#attendance-ts-from");
  const to = attendanceGroup.querySelector("#attendance-ts-to");
  if (rangeEnabled) {
    rangeEnabled.addEventListener("change", () => {
      if (from && to) from.disabled = to.disabled = !rangeEnabled.checked;
      if (rangeEnabled.checked && from) from.focus();
      update();
    });
  }
  if (from) {
    from.addEventListener("input", update);
    from.addEventListener("change", update);
  }
  if (to) {
    to.addEventListener("input", update);
    to.addEventListener("change", update);
  }
}

function updateAttendanceFilterBadge(attendanceGroup) {
  const badge = document.getElementById("attendance-filter-badge");
  if (!badge) return;
  const filter = getAttendanceFilter(attendanceGroup);
  if (!filter) {
    badge.classList.add("hidden");
  } else {
    badge.classList.remove("hidden");
    if (filter.mode === "attended") badge.textContent = "Attended";
    else if (filter.mode === "not_attended") badge.textContent = "Not Attended";
    else if (filter.range) badge.textContent = "Range";
    else badge.textContent = "On";
  }
}

// True when `ts` falls inside `range` ({from, to}, either end optional).
function withinRange(ts, range) {
  if (!range) return true;
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (range.from && t < new Date(range.from).getTime()) return false;
  if (range.to && t > new Date(range.to).getTime()) return false;
  return true;
}

// Narrows a contact pool down to who did/didn't attend a session matching criteria.
async function applyAttendanceFilter(pool, eventCode, attendanceFilter) {
  if (!attendanceFilter || !pool.length) return pool;
  let query = supabase.from("session_attendance").select("mob_no,ts");
  if (eventCode !== "__ALL__") query = query.eq("event_code", eventCode);
  if (attendanceFilter.range) {
    if (attendanceFilter.range.from) query = query.gte("ts", attendanceFilter.range.from);
    if (attendanceFilter.range.to) query = query.lte("ts", attendanceFilter.range.to);
  }
  const { data, error } = await query;
  if (error) throw error;

  const attendedMobNos = new Set((data || []).map((r) => normalizePhoneInput(r.mob_no)).filter(Boolean));
  const mode = attendanceFilter.mode;
  if (mode === "attended" || (mode === "all" && attendanceFilter.range)) {
    return pool.filter((c) => attendedMobNos.has(normalizePhoneInput(c.mob_no)));
  } else if (mode === "not_attended") {
    return pool.filter((c) => !attendedMobNos.has(normalizePhoneInput(c.mob_no)));
  }
  return pool;
}

// Fetches latest call responses and active assignment statuses for contacts in an event.
async function fetchCallStatusMap(eventCode) {
  let crQuery = supabase.from("call_responses").select("mob_no,remarks,ts").order("ts", { ascending: true });
  if (eventCode !== "__ALL__") crQuery = crQuery.eq("event_code", eventCode);
  const { data: crData } = await crQuery;

  const mapByMob = new Map();
  (crData || []).forEach((r) => {
    if (r.mob_no) {
      mapByMob.set(normalizePhoneInput(r.mob_no), {
        status: r.remarks || "Not Done",
        submitted_at: r.ts,
      });
    }
  });

  let asQuery = supabase.from("assignments").select("contact_id,status,submitted_at");
  if (eventCode !== "__ALL__") asQuery = asQuery.eq("event_code", eventCode);
  const { data: asData } = await asQuery;

  const mapByContactId = new Map();
  (asData || []).forEach((a) => {
    if (a.status) {
      mapByContactId.set(a.contact_id, {
        status: a.status || "Not Done",
        submitted_at: a.submitted_at,
      });
    }
  });

  return { mapByMob, mapByContactId };
}

function getContactCallInfo(c, statusMaps) {
  if (statusMaps && statusMaps.mapByContactId.has(c.id)) {
    return statusMaps.mapByContactId.get(c.id);
  }
  const normMob = normalizePhoneInput(c.mob_no);
  if (statusMaps && statusMaps.mapByMob && statusMaps.mapByMob.has(normMob)) {
    return statusMaps.mapByMob.get(normMob);
  }
  return { status: "Not Done", submitted_at: null };
}

let filterSummaryTimeout = null;
// Bumped on every call so a slow, superseded request can tell it's stale and
// drop its result instead of overwriting the screen with an outdated count
// (two toggles in quick succession used to race, and whichever network
// response landed last won — even if it was answering the older question).
let filterSummaryGeneration = 0;
export async function updateLiveFilterSummary() {
  if (filterSummaryTimeout) clearTimeout(filterSummaryTimeout);
  const myGeneration = ++filterSummaryGeneration;
  const summaryEl = document.getElementById("assign-summary");
  if (summaryEl) summaryEl.textContent = "🎯 Calculating matching pool…";
  filterSummaryTimeout = setTimeout(async () => {
    const eventSelect = document.getElementById("event-select");
    const tagFilterGroup = document.getElementById("tag-filter-group");
    const gfyGroup = document.getElementById("gfy-filter-group");
    const tsGroup = document.getElementById("timestamp-filter-group");
    const callStatusGroup = document.getElementById("call-status-filter-group");
    const attendanceGroup = document.getElementById("attendance-filter-group");
    if (!summaryEl || !eventSelect) return;

    try {
      const eventCode = eventSelect.value;
      const tagFilters = getCheckedTags(tagFilterGroup);
      const gfyFilter = getGfyFilter(gfyGroup);
      const timeRange = getTimeRange(tsGroup);
      const statusFilters = getCheckedTags(callStatusGroup);
      const callTimeRange = getCallTimeRange(callStatusGroup);
      const attendanceFilter = getAttendanceFilter(attendanceGroup);

      let pool = await fetchEventContactPool(eventCode, tagFilters, gfyFilter, timeRange);
      if (statusFilters.length || callTimeRange) {
        const statusMaps = await fetchCallStatusMap(eventCode);
        pool = pool.filter((c) => {
          const info = getContactCallInfo(c, statusMaps);
          if (statusFilters.length && !statusFilters.includes(info.status)) return false;
          if (callTimeRange && !withinRange(info.submitted_at, callTimeRange)) return false;
          return true;
        });
      }
      pool = await applyAttendanceFilter(pool, eventCode, attendanceFilter);
      if (myGeneration !== filterSummaryGeneration) return;
      summaryEl.textContent = `🎯 Matching Pool: ${pool.length} contact(s) ready to be assigned/rebalanced.`;
    } catch (err) {
      if (myGeneration !== filterSummaryGeneration) return;
      console.warn("Could not calculate live filter summary:", err);
    }
  }, 250);
}


// Turns the filter groups into click-to-open dropdown panels, closing
// whichever else is open and dismissing on an outside click/Escape. Wired
// with .onclick (not addEventListener) since initUsers() re-runs every time
// this tab is opened, and re-assignment is idempotent.
const FILTER_DROPDOWN_IDS = [
  ["tag-filter-dropdown", "tag-filter-toggle"],
  ["gfy-filter-dropdown", "gfy-filter-toggle"],
  ["timestamp-filter-dropdown", "timestamp-filter-toggle"],
  ["call-status-filter-dropdown", "call-status-filter-toggle"],
  ["attendance-filter-dropdown", "attendance-filter-toggle"],
];
let filterDropdownsWired = false;
function wireFilterDropdowns() {
  FILTER_DROPDOWN_IDS.forEach(([dropdownId, toggleId]) => {
    const dropdown = document.getElementById(dropdownId);
    const toggle = document.getElementById(toggleId);
    if (!dropdown || !toggle) return;
    toggle.onclick = (e) => {
      e.stopPropagation();
      const opening = !dropdown.classList.contains("open");
      FILTER_DROPDOWN_IDS.forEach(([otherId]) => {
        if (otherId !== dropdownId) document.getElementById(otherId)?.classList.remove("open");
      });
      dropdown.classList.toggle("open", opening);
      toggle.setAttribute("aria-expanded", String(opening));
    };
    const panel = dropdown.querySelector(".filter-dropdown-panel");
    if (panel) panel.onclick = (e) => e.stopPropagation();
  });

  if (filterDropdownsWired) return;
  filterDropdownsWired = true;
  const closeAll = () => FILTER_DROPDOWN_IDS.forEach(([dropdownId]) => document.getElementById(dropdownId)?.classList.remove("open"));
  document.addEventListener("click", closeAll);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
}

// Optional "collected between" window on top of the event/tag/GFY filters, so
// a round can be built from just the contacts gathered during one drive. Off
// by default — when off (or when both boxes are empty) every timestamp counts.
// Returns null for "no time filter", else ISO bounds for contacts.created_at.
function getTimeRange(tsGroup) {
  if (!tsGroup || !tsGroup.querySelector("#ts-filter-enabled").checked) return null;
  const from = tsGroup.querySelector("#ts-filter-from").value;
  const to = tsGroup.querySelector("#ts-filter-to").value;
  if (!from && !to) return null;
  // datetime-local values are local wall-clock; new Date() reads them as local
  // and toISOString converts to the UTC that created_at is stored in.
  return {
    from: from ? new Date(from).toISOString() : null,
    to: to ? new Date(to).toISOString() : null,
    label: `${from ? new Date(from).toLocaleString() : "any time"} → ${to ? new Date(to).toLocaleString() : "now"}`,
  };
}

function wireTimestampFilter(tsGroup) {
  if (!tsGroup) return;
  const enabled = tsGroup.querySelector("#ts-filter-enabled");
  const from = tsGroup.querySelector("#ts-filter-from");
  const to = tsGroup.querySelector("#ts-filter-to");
  enabled.addEventListener("change", () => {
    from.disabled = to.disabled = !enabled.checked;
    if (enabled.checked) from.focus();
    updateTimestampFilterBadge(tsGroup);
  });
}

export async function initUsers() {
  const eventSelect = document.getElementById("event-select");
  const tagFilterGroup = document.getElementById("tag-filter-group");
  const gfyGroup = document.getElementById("gfy-filter-group");
  const tsGroup = document.getElementById("timestamp-filter-group");
  const callStatusGroup = document.getElementById("call-status-filter-group");
  const attendanceGroup = document.getElementById("attendance-filter-group");

  // these round-trips are all independent — run them together instead of
  // one after another, since that was adding ~2s to this page's load.
  const [, tagFilterValue, gfyFilterValue, callStatusFilterValue] = await Promise.all([
    loadEvents(),
    getSetting("tag_filter"),
    getSetting("gfy_filter"),
    getSetting("call_status_filter"),
    renderUsersTable(),
  ]);
  // Always default to "All Events" here regardless of whichever single
  // event is set as current elsewhere (Reception/Analytics/etc.) — this tab
  // is for assigning across everything unless the admin narrows it down.
  fillEventSelect(eventSelect, "__ALL__", true);
  if (eventSelect) eventSelect.addEventListener("change", updateLiveFilterSummary);
  const savedTags = (tagFilterValue || "").split(",").map((t) => t.trim()).filter(Boolean);
  tagFilterGroup.querySelectorAll("input").forEach((cb) => {
    cb.checked = savedTags.includes(cb.value);
    cb.onchange = () => {
      updateTagFilterBadge(tagFilterGroup);
      updateLiveFilterSummary();
    };
  });
  gfyGroup.querySelector("#gfy-filter-attended").checked = gfyFilterValue !== "not_attended";
  gfyGroup.querySelector("#gfy-filter-not-attended").checked = gfyFilterValue !== "attended";
  const savedCallStatuses = (callStatusFilterValue || "").split(",").map((t) => t.trim()).filter(Boolean);
  callStatusGroup.querySelectorAll('input[type="checkbox"][value]').forEach((cb) => {
    cb.checked = savedCallStatuses.includes(cb.value);
    cb.onchange = () => {
      updateCallStatusFilterBadge(callStatusGroup);
      updateLiveFilterSummary();
    };
  });
  updateTagFilterBadge(tagFilterGroup);
  updateGfyFilterBadge(gfyGroup);
  updateTimestampFilterBadge(tsGroup);
  updateCallStatusFilterBadge(callStatusGroup);
  updateAttendanceFilterBadge(attendanceGroup);
  updateLiveFilterSummary();

  wireAssignButton(eventSelect, tagFilterGroup, gfyGroup, tsGroup, callStatusGroup, attendanceGroup);
  wireRebalanceButton(eventSelect, tagFilterGroup, gfyGroup, tsGroup, callStatusGroup, attendanceGroup);
  wireGfyFilterGroup(gfyGroup);
  wireTimestampFilter(tsGroup);
  wireCallTimeFilter(callStatusGroup);
  wireAttendanceFilterGroup(attendanceGroup);
  wireFilterDropdowns();
  wireDisassignButton();
  wireAutoAssignSelectAll();
  wireAddUserModal();
  wireManageEventsModal();
  wireUsersImportExport();
  initColumnDragReorder("users-table");
  initHorizontalScroll("users-table-wrap", { leftBtnId: "users-scroll-left", rightBtnId: "users-scroll-right" });
}

async function refreshEventsEverywhere(selectedCode) {
  eventsLoaded = false;
  await loadEvents();
  const eventSelect = document.getElementById("event-select");
  if (eventSelect) fillEventSelect(eventSelect, selectedCode, true);
}

async function renderManageEventsList() {
  const tbody = document.getElementById("manage-events-body");
  tbody.innerHTML = `<tr><td colspan="5" class="loading-row">Loading events…</td></tr>`;

  const [, { data: contacts }] = await Promise.all([
    loadEvents(),
    supabase.from("contacts").select("calling_purpose"),
  ]);
  const counts = {};
  (contacts || []).forEach((c) => {
    if (c.calling_purpose) counts[c.calling_purpose] = (counts[c.calling_purpose] || 0) + 1;
  });

  if (!eventsCache.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading-row">No events yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = eventsCache.map((e, idx) => `
    <tr data-code="${e.code}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Code"><strong>${escapeHtml(e.code)}</strong></td>
      <td data-label="Display Name"><input class="inline-edit event-name-input" value="${escapeHtml(e.name)}" /></td>
      <td data-label="Contacts">${counts[e.code] || 0}</td>
      <td data-label=""><button class="cell-chip danger delete-event-btn">Delete</button></td>
    </tr>
  `).join("");

  reapplyColumnOrder("manage-events-table");

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
    initColumnDragReorder("manage-events-table");
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
  tbody.innerHTML = `<tr><td colspan="11" class="loading-row">Loading users…</td></tr>`;

  const { data: users, error } = await supabase
    .from("users")
    .select("id,user_name,login_pw,role,call_limit,auto_assign,commander")
    .order("user_name");
  if (error) {
    tbody.innerHTML = `<tr><td colspan="11" class="loading-row">Could not load users.</td></tr>`;
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
    tbody.innerHTML = `<tr><td colspan="11" class="loading-row">No users yet.</td></tr>`;
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
      <td data-label="Commander">
        <input type="checkbox" class="commander-input" ${u.commander ? "checked" : ""} />
      </td>
      <td data-label="Call Limit">
        <input type="number" min="0" class="limit-input" value="${u.call_limit ?? ""}" placeholder="No limit" ${u.role !== "Coordinator" ? "disabled" : ""} />
      </td>
      <td data-label="Count"><span class="count-badge">${assigned}</span></td>
      <td data-label="Completed Calls"><span class="count-badge">${completed}</span></td>
      <td data-label="Completed %"><span class="pct-badge">${pct}</span></td>
      <td data-label="Auto Assign">
        <input type="checkbox" class="auto-assign-input" ${u.auto_assign ? "checked" : ""} ${u.role !== "Coordinator" ? "disabled" : ""} />
      </td>
      <td data-label="">
        <button class="btn btn-link delete-user-btn">Delete</button>
      </td>
    </tr>
  `;
  }).join("");

  reapplyColumnOrder("users-table");

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

  tbody.querySelectorAll(".commander-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      await supabase.from("users").update({ commander: e.target.checked }).eq("id", id);
      showToast("Commander updated", "success");
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
// timeRange: null for every timestamp, else {from, to} ISO bounds on created_at
// (either end may be null for an open-ended window).
async function fetchEventContactPool(eventCode, tagFilters, gfyFilter = "", timeRange = null) {
  const allEvents = eventCode === "__ALL__";
  let query = supabase
    .from("contacts")
    .select("id,mob_no,core_cultivation,admin_tag_to_users,calling_purpose,gyc_status");
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
  if (timeRange) {
    if (timeRange.from) query = query.gte("created_at", timeRange.from);
    if (timeRange.to) query = query.lte("created_at", timeRange.to);
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

function wireAssignButton(eventSelect, tagFilterGroup, gfyGroup, tsGroup, callStatusGroup, attendanceGroup) {
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
      const timeRange = getTimeRange(tsGroup);
      const statusFilters = getCheckedTags(callStatusGroup);
      const callTimeRange = getCallTimeRange(callStatusGroup);
      const attendanceFilter = getAttendanceFilter(attendanceGroup);

      let pool = await fetchEventContactPool(eventCode, tagFilters, gfyFilter, timeRange);
      if (statusFilters.length || callTimeRange) {
        const statusMaps = await fetchCallStatusMap(eventCode);
        pool = pool.filter((c) => {
          const info = getContactCallInfo(c, statusMaps);
          if (statusFilters.length && !statusFilters.includes(info.status)) return false;
          if (callTimeRange && !withinRange(info.submitted_at, callTimeRange)) return false;
          return true;
        });
      }
      pool = await applyAttendanceFilter(pool, eventCode, attendanceFilter);

      // Nothing matches these filters — bail out before wiping anyone's
      // current list. Assigning used to archive+clear unconditionally and
      // only discover an empty pool afterward, leaving every coordinator
      // with an empty list for no reason.
      if (!pool.length) {
        showToast("No contacts match these filters — nothing was changed.", "error");
        return;
      }

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
      await setSetting("call_status_filter", statusFilters.join(", "));

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
        (timeRange ? ` Limited to contacts collected ${timeRange.label}.` : "") +
        (statusFilters.length ? ` Limited to call status: ${statusFilters.join(", ")}.` : "") +
        (callTimeRange ? ` Limited to contacts called ${callTimeRange.label}.` : "") +
        (attendanceFilter ? ` Limited to contacts who ${attendanceFilter.mode === "attended" ? "attended" : "did not attend"}${attendanceFilter.range ? ` ${attendanceFilter.range.label}` : ""}.` : "") +
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

function wireRebalanceButton(eventSelect, tagFilterGroup, gfyGroup, tsGroup, callStatusGroup, attendanceGroup) {
  const btn = document.getElementById("rebalance-btn");
  const summary = document.getElementById("assign-summary");
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Rebalancing…";
    try {
      const eventCode = eventSelect.value;
      const tagFilters = getCheckedTags(tagFilterGroup);
      const gfyFilter = getGfyFilter(gfyGroup);
      const timeRange = getTimeRange(tsGroup);
      const statusFilters = getCheckedTags(callStatusGroup);
      const callTimeRange = getCallTimeRange(callStatusGroup);
      const attendanceFilter = getAttendanceFilter(attendanceGroup);
      await setSetting("call_status_filter", statusFilters.join(", "));

      let eligiblePool = await fetchEventContactPool(eventCode, tagFilters, gfyFilter, timeRange);
      if (statusFilters.length || callTimeRange) {
        const statusMaps = await fetchCallStatusMap(eventCode);
        eligiblePool = eligiblePool.filter((c) => {
          const info = getContactCallInfo(c, statusMaps);
          if (statusFilters.length && !statusFilters.includes(info.status)) return false;
          if (callTimeRange && !withinRange(info.submitted_at, callTimeRange)) return false;
          return true;
        });
      }
      eligiblePool = await applyAttendanceFilter(eligiblePool, eventCode, attendanceFilter);

      let existingQuery = supabase.from("assignments").select("id,contact_id,user_name,status,submitted_at");
      if (eventCode !== "__ALL__") existingQuery = existingQuery.eq("event_code", eventCode);
      const { data: existing, error: existingErr } = await existingQuery;
      if (existingErr) throw existingErr;

      // Default sweep: contacts nobody has acted on yet, plus ones tagged
      // "Need to Call Again" — everything else (a real outcome logged) stays
      // exactly where it is. An explicit Call Status filter overrides that
      // default so the admin can pull back e.g. only "Available on Weekend"
      // contacts instead, and redistribute just those. An explicit call time
      // range narrows either case down to only that submitted_at window.
      const isRebalanceable = (a) => {
        const statusOk = statusFilters.length
          ? statusFilters.includes(a.status || "Not Done")
          : (a.status || "Not Done") === "Not Done" || (a.status || "Not Done") === "Need to Call Again";
        if (!statusOk) return false;
        return withinRange(a.submitted_at, callTimeRange);
      };
      const untouched = (existing || []).filter(isRebalanceable);
      const inProgress = (existing || []).filter((a) => !isRebalanceable(a));

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

      const eligibleMap = {};
      eligible.forEach((u) => { eligibleMap[u.user_name] = u; });

      // Same split as Assign: cultivated contacts must stay with their
      // cultivator, never get reshuffled into the general pool.
      const generalPool = [];
      const rows = [];
      let unassignedCount = 0;
      reshufflePool.forEach((c) => {
        if (c.core_cultivation) {
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
      const { rows: generalRows, unassignedCount: generalUnassigned } = distributePool(generalPool, eligible, assignedCount, eventCode);
      rows.push(...generalRows);
      unassignedCount += generalUnassigned;

      if (rows.length) {
        const { error: insErr } = await supabase.from("assignments").insert(rows);
        if (insErr) throw insErr;
      }

      await mirrorAssignedCounts(usersCache);

      summary.textContent = `Rebalanced ${rows.length} ${statusFilters.length ? statusFilters.join("/") : "not-yet-called/need-to-call-again"} contact(s) across ${eligible.length} caller(s). ` +
        `${inProgress.length} left untouched.` +
        (timeRange ? ` Limited to contacts collected ${timeRange.label}.` : "") +
        (callTimeRange ? ` Limited to contacts called ${callTimeRange.label}.` : "") +
        (attendanceFilter ? ` Limited to contacts who ${attendanceFilter.mode === "attended" ? "attended" : "did not attend"}${attendanceFilter.range ? ` ${attendanceFilter.range.label}` : ""}.` : "") +
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
    document.getElementById("add-user-commander").checked = false;
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
    const commander = document.getElementById("add-user-commander").checked;

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
      commander,
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
  wireContactsSelectAndAssign();
}

// Master Contact's column order is user-draggable (like Excel) and persisted
// locally per browser via the generic initColumnDragReorder() helper (see
// utils.js); the "" key is the trailing, non-draggable Delete column, always
// kept last so dragging can never push it out of place. The explicit column
// list (rather than deriving it from the DOM) preserves everyone's
// already-saved localStorage order from before this was generalized.
const CONTACTS_COLUMN_ORDER_KEY = "nrg-contacts-column-order";
const DEFAULT_CONTACTS_COLUMNS = [
  "S.No", "Time Stamp", "Name", "Phone", "PG Name", "Org", "Profession", "Gender", "Sessions", "Calls",
  "Admin Tag to Users", "Admin Tag", "Core Cultivation", "Calling Purpose", "GFY/AOMC", "Admin Review", "",
];

function wireContactsColumnReorder() {
  initColumnDragReorder("contacts-table", {
    storageKey: CONTACTS_COLUMN_ORDER_KEY,
    columns: DEFAULT_CONTACTS_COLUMNS,
    resetBtnId: "contacts-reset-columns-btn",
  });
  initHorizontalScroll("contacts-table-wrap", { leftBtnId: "contacts-scroll-left", rightBtnId: "contacts-scroll-right" });
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
  ["contacts-filter-org", "company_name"],
];

// numeric columns (Sessions, Calls) filter to an exact count typed in.
const NUMBER_FILTER_FIELDS = [
  ["contacts-filter-sessions", "sessions_count"],
  ["contacts-filter-calls", "calls_count"],
];


async function renderContactsTable(searchTerm = "") {
  // Any change of search/sort/filter rebuilds the visible set, so a selection
  // made against the old view would be invisible but still counted — drop it.
  clearContactSelection();
  const tbody = document.getElementById("contacts-table-body");
  tbody.innerHTML = `<tr><td colspan="18" class="loading-row">Loading contacts…</td></tr>`;

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
    tbody.innerHTML = `<tr><td colspan="18" class="loading-row">Could not load contacts.</td></tr>`;
    return;
  }
  if (!data || !data.length) {
    tbody.innerHTML = `<tr><td colspan="18" class="loading-row">No contacts found.</td></tr>`;
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
      <td class="select-col no-export" data-label="Select"><input type="checkbox" class="contact-select" /></td>
      <td data-label="S.No">${anyFilterActive ? i + 1 : (c.s_no ?? i + 1)}</td>
      <td data-label="Time Stamp">${c.created_at ? new Date(c.created_at).toLocaleString() : ""}</td>
      <td data-label="Name"><input class="inline-edit" data-field="name" value="${escapeHtml(c.name)}" /></td>
      <td data-label="Phone"><input class="inline-edit" data-field="mob_no" value="${c.mob_no}" /></td>
      <td data-label="PG Name"><input class="inline-edit" data-field="pg_name" value="${escapeHtml(c.pg_name || "")}" /></td>
      <td data-label="Org"><input class="inline-edit" data-field="company_name" value="${escapeHtml(c.company_name || "")}" /></td>
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
          ${(GYC_STATUS_OPTIONS.includes(c.gyc_status || "") ? GYC_STATUS_OPTIONS : [...GYC_STATUS_OPTIONS, c.gyc_status]).map((t) => `<option value="${escapeHtml(t)}" ${t === (c.gyc_status || "") ? "selected" : ""}>${escapeHtml(t) || "—"}</option>`).join("")}
        </select>
      </td>
      <td data-label="Admin Review"><button class="cell-chip admin-review-link" data-id="${c.id}" data-name="${escapeHtml(c.name)}" data-review="${escapeHtml(c.admin_remarks || "")}">${c.admin_remarks ? "✎ Edit" : "+ Add"}</button></td>
      <td data-label=""><button class="cell-chip danger delete-contact-btn" data-id="${c.id}" data-name="${escapeHtml(c.name)}">Delete</button></td>
    </tr>
  `;
  }).join("");

  reapplyColumnOrder("contacts-table");
  applyContactsSelectMode();

  tbody.querySelectorAll(".contact-select").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = e.target.closest("tr").dataset.id;
      if (e.target.checked) selectedContactIds.add(id);
      else selectedContactIds.delete(id);
      syncContactsSelectAll();
      updateContactsAssignButton();
    });
  });

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
        // On a phone the rows stack as cards and the tick box is easy to miss,
        // so while selecting, tapping the card is the tick.
        if (contactsSelectMode) {
          const cb = row.querySelector(".contact-select");
          if (cb) {
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event("change"));
          }
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

/* ============ MASTER CONTACT: SELECT & ASSIGN ============
   The Users & Assignment tab builds a round from event + tag + GFY + time
   filters. This does the same job from the other end: sort/filter Master
   Contact however you like, tick the contacts you want (or all of the ones
   currently shown), and hand exactly those to the coordinators you pick. The
   result lands in the same `assignments` table, so Assigned Count / Completed
   Calls / Completed % on Users & Assignment report it identically. */

let contactsSelectMode = false;
const selectedContactIds = new Set();

function updateContactsAssignButton() {
  const btn = document.getElementById("contacts-assign-btn");
  if (!btn) return;
  btn.textContent = `Assign Selected (${selectedContactIds.size})`;
  btn.disabled = selectedContactIds.size === 0;
}

function clearContactSelection() {
  selectedContactIds.clear();
  const all = document.getElementById("contacts-select-all");
  if (all) { all.checked = false; all.indeterminate = false; }
  updateContactsAssignButton();
}

// header checkbox reflects the rows actually on screen: all / none / partial.
// The thead is hidden on phones, so the toolbar button mirrors it there.
function syncContactsSelectAll() {
  const boxes = [...document.querySelectorAll("#contacts-table-body .contact-select")];
  const checked = boxes.filter((b) => b.checked).length;
  const allChecked = boxes.length > 0 && checked === boxes.length;
  const all = document.getElementById("contacts-select-all");
  if (all) {
    all.checked = allChecked;
    all.indeterminate = checked > 0 && !allChecked;
  }
  const btn = document.getElementById("contacts-select-all-btn");
  if (btn) btn.textContent = allChecked ? "Clear Selection" : "Select All Shown";
}

// ticks (or unticks) every row currently rendered — i.e. everything left after
// the admin's search, header filters and sort, which is the whole point.
function setAllShownSelected(checked) {
  document.querySelectorAll("#contacts-table-body .contact-select").forEach((cb) => {
    cb.checked = checked;
    const id = cb.closest("tr").dataset.id;
    if (checked) selectedContactIds.add(id);
    else selectedContactIds.delete(id);
  });
  syncContactsSelectAll();
  updateContactsAssignButton();
}

function applyContactsSelectMode() {
  const table = document.getElementById("contacts-table");
  if (table) table.classList.toggle("select-mode", contactsSelectMode);
  ["contacts-assign-btn", "contacts-select-all-btn"].forEach((id) => {
    document.getElementById(id)?.classList.toggle("hidden", !contactsSelectMode);
  });
  const modeBtn = document.getElementById("contacts-select-mode-btn");
  if (modeBtn) modeBtn.textContent = contactsSelectMode ? "✕ Cancel Select" : "☑ Select";
  // leaving select mode empties the set without touching the boxes, so bring
  // the rendered ticks back in line with it either way.
  document.querySelectorAll("#contacts-table-body .contact-select").forEach((cb) => {
    cb.checked = selectedContactIds.has(cb.closest("tr").dataset.id);
  });
  syncContactsSelectAll();
  updateContactsAssignButton();
}

let contactsSelectWired = false;
function wireContactsSelectAndAssign() {
  if (contactsSelectWired) return;
  contactsSelectWired = true;

  document.getElementById("contacts-select-mode-btn").addEventListener("click", () => {
    contactsSelectMode = !contactsSelectMode;
    if (!contactsSelectMode) clearContactSelection();
    applyContactsSelectMode();
  });

  document.getElementById("contacts-select-all").addEventListener("change", (e) => {
    setAllShownSelected(e.target.checked);
  });

  document.getElementById("contacts-select-all-btn").addEventListener("click", () => {
    const boxes = [...document.querySelectorAll("#contacts-table-body .contact-select")];
    setAllShownSelected(!(boxes.length > 0 && boxes.every((b) => b.checked)));
  });

  document.getElementById("contacts-assign-btn").addEventListener("click", openContactsAssignModal);

  const modal = document.getElementById("contacts-assign-modal");
  document.getElementById("contacts-assign-cancel").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
  document.getElementById("contacts-assign-users-all").addEventListener("change", (e) => {
    document.querySelectorAll("#contacts-assign-users-body .assign-user-check").forEach((cb) => { cb.checked = e.target.checked; });
  });
  document.getElementById("contacts-assign-submit").onclick = runContactsAssign;
  initColumnDragReorder("contacts-assign-users-table");
}

async function openContactsAssignModal() {
  if (!selectedContactIds.size) {
    showToast("Tick at least one contact first.", "error");
    return;
  }
  const modal = document.getElementById("contacts-assign-modal");
  const body = document.getElementById("contacts-assign-users-body");
  document.getElementById("contacts-assign-error").classList.add("hidden");
  document.getElementById("contacts-assign-count").textContent =
    `${selectedContactIds.size} contact(s) selected in Master Contact.`;
  document.getElementById("contacts-assign-replace").checked = true;
  document.getElementById("contacts-assign-users-all").checked = false;
  body.innerHTML = `<tr><td colspan="5" class="loading-row">Loading coordinators…</td></tr>`;
  modal.classList.add("active");

  const [{ data: users }, { data: assigned }, currentEvent] = await Promise.all([
    supabase.from("users").select("id,user_name,call_limit,auto_assign").eq("role", "Coordinator").order("user_name"),
    supabase.from("assignments").select("user_name"),
    getSetting("current_event"),
    loadEvents(),
  ]);

  // Every assignment row needs an event_code, and a hand-picked contact may
  // have no Calling Purpose of its own — this is the fallback for those.
  fillEventSelect(document.getElementById("contacts-assign-event"), currentEvent || "", false);

  const load = {};
  (assigned || []).forEach((a) => { load[a.user_name] = (load[a.user_name] || 0) + 1; });

  body.innerHTML = (users || []).length
    ? users.map((u, idx) => `
        <tr data-id="${u.id}" data-user="${escapeHtml(u.user_name)}">
          <td data-label="S.No">${idx + 1}</td>
          <td data-label=""><input type="checkbox" class="assign-user-check" ${u.auto_assign ? "checked" : ""} /></td>
          <td data-label="Coordinator">${escapeHtml(u.user_name)}</td>
          <td data-label="Current Load" class="assigned-count">${load[u.user_name] || 0}</td>
          <td data-label="Call Limit (blank = no limit)"><input type="number" min="0" class="assign-user-limit inline-edit" value="${u.call_limit ?? ""}" placeholder="No limit" /></td>
        </tr>`).join("")
    : `<tr><td colspan="5" class="loading-row">No coordinators found.</td></tr>`;

  reapplyColumnOrder("contacts-assign-users-table");
}

async function runContactsAssign() {
  const modal = document.getElementById("contacts-assign-modal");
  const submitBtn = document.getElementById("contacts-assign-submit");
  const errEl = document.getElementById("contacts-assign-error");
  const summary = document.getElementById("contacts-assign-summary");
  errEl.classList.add("hidden");

  // Table order is alphabetical, which distributePool relies on to fill
  // limited callers before the unlimited ones — keep it.
  const eligible = [];
  document.querySelectorAll("#contacts-assign-users-body tr[data-user]").forEach((row) => {
    if (!row.querySelector(".assign-user-check")?.checked) return;
    const limitVal = row.querySelector(".assign-user-limit").value.trim();
    const parsed = parseInt(limitVal, 10);
    eligible.push({
      id: row.dataset.id,
      user_name: row.dataset.user,
      call_limit: limitVal === "" || Number.isNaN(parsed) ? null : parsed,
    });
  });
  if (!eligible.length) {
    errEl.textContent = "Select at least one coordinator to assign to.";
    errEl.classList.remove("hidden");
    return;
  }

  const replace = document.getElementById("contacts-assign-replace").checked;
  const fallbackEvent = document.getElementById("contacts-assign-event").value || "";
  const confirmMsg = `Assign ${selectedContactIds.size} selected contact(s) to ${eligible.length} coordinator(s)?` +
    (replace
      ? " Every caller's current list is archived and replaced first."
      : " Existing assignments are kept, and any selected contact already assigned is skipped.");
  if (!confirm(confirmMsg)) return;

  submitBtn.disabled = true;
  submitBtn.textContent = "Assigning…";
  try {
    // Limits typed here are the same field Users & Assignment edits — persist
    // them so both screens agree on each caller's cap.
    await Promise.all(eligible.map((u) => supabase.from("users").update({ call_limit: u.call_limit }).eq("id", u.id)));

    const picked = lastContactsData.filter((c) => selectedContactIds.has(c.id));
    // "Don't Call" and coordinators-as-contacts are never callable anywhere
    // else in the app, so an explicit tick doesn't override that either.
    const blockedTag = picked.filter((c) => c.admin_tag_to_users === "Don't Call" || c.admin_tag_to_users === "Coordinator");
    let pool = picked.filter((c) => !blockedTag.includes(c));
    const noEvent = pool.filter((c) => !(c.calling_purpose || fallbackEvent));
    pool = pool.filter((c) => c.calling_purpose || fallbackEvent);

    const assignedCount = {};
    eligible.forEach((u) => { assignedCount[u.user_name] = 0; });

    let alreadyAssigned = 0;
    if (replace) {
      await archiveAndClearAssignments();
    } else {
      // keep limits honest across clicks: existing load counts toward the cap,
      // and a contact somebody already holds isn't handed out twice.
      const { data: existing, error: exErr } = await supabase.from("assignments").select("contact_id,user_name");
      if (exErr) throw exErr;
      const taken = new Set((existing || []).map((a) => a.contact_id));
      (existing || []).forEach((a) => { if (a.user_name in assignedCount) assignedCount[a.user_name]++; });
      const before = pool.length;
      pool = pool.filter((c) => !taken.has(c.id));
      alreadyAssigned = before - pool.length;
    }

    // Core Cultivation still wins where it can — a cultivated contact goes to
    // their cultivator if that person is one of the selected callers and has
    // room; otherwise they fall into the shared pool rather than being dropped.
    const rows = [];
    const generalPool = [];
    const eligibleMap = {};
    eligible.forEach((u) => { eligibleMap[u.user_name] = u; });
    pool.forEach((c) => {
      const cultivator = c.core_cultivation;
      if (cultivator && cultivator in assignedCount) {
        const cap = eligibleMap[cultivator].call_limit == null ? Infinity : eligibleMap[cultivator].call_limit;
        if (assignedCount[cultivator] < cap) {
          rows.push({ contact_id: c.id, user_name: cultivator, event_code: c.calling_purpose || fallbackEvent });
          assignedCount[cultivator]++;
          return;
        }
      }
      generalPool.push(c);
    });

    const { rows: generalRows, unassignedCount } = distributePool(generalPool, eligible, assignedCount, fallbackEvent);
    rows.push(...generalRows);

    if (rows.length) {
      const { error: insErr } = await supabase.from("assignments").insert(rows);
      if (insErr) throw insErr;
    }

    const { data: freshUsers } = await supabase.from("users").select("id,user_name,role,call_limit,auto_assign");
    if (freshUsers) {
      usersCache = freshUsers;
      await mirrorAssignedCounts(usersCache);
    }

    const notes = [
      unassignedCount ? `${unassignedCount} left unassigned (no selected caller under their limit)` : "",
      alreadyAssigned ? `${alreadyAssigned} skipped (already assigned)` : "",
      blockedTag.length ? `${blockedTag.length} skipped (Don't Call / Coordinator)` : "",
      noEvent.length ? `${noEvent.length} skipped (no Calling Purpose and no fallback event)` : "",
    ].filter(Boolean);
    summary.textContent = `Assigned ${rows.length} contact(s) to ${eligible.length} caller(s).` +
      (notes.length ? ` ${notes.join("; ")}.` : "");

    modal.classList.remove("active");
    showToast(`Assigned ${rows.length} contact(s) 🎉`, "success");
    contactsSelectMode = false;
    clearContactSelection();
    await renderContactsTable(document.getElementById("contacts-search").value.trim());
  } catch (err) {
    errEl.textContent = "Assignment failed: " + err.message;
    errEl.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Assign Contacts";
  }
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
    thead.innerHTML = `<tr><th>S.No</th><th>Time</th><th>Marked By</th><th>Event</th></tr>`;
    initColumnDragReorder("contact-info-table", { storageKey: "nrg-col-order:contact-info-sessions", force: true });
    const { data } = await supabase.from("session_attendance").select("ts,took_by,event_code").eq("mob_no", mob).order("ts", { ascending: false });
    tbody.innerHTML = (data && data.length)
      ? data.map((r, idx) => `<tr><td data-label="S.No">${idx + 1}</td><td data-label="Time">${new Date(r.ts).toLocaleString()}</td><td data-label="Marked By">${escapeHtml(r.took_by)}</td><td data-label="Event">${escapeHtml(r.event_code || "—")}</td></tr>`).join("")
      : `<tr><td colspan="4" class="loading-row">No sessions attended yet.</td></tr>`;
    reapplyColumnOrder("contact-info-table");
  } else if (kind === "calls") {
    thead.innerHTML = `<tr><th>S.No</th><th>Time</th><th>Caller</th><th>Event</th><th>Status</th><th>Comment</th></tr>`;
    initColumnDragReorder("contact-info-table", { storageKey: "nrg-col-order:contact-info-calls", force: true });
    const { data } = await supabase.from("call_responses").select("ts,caller_name,event_code,remarks,addl_remarks").eq("mob_no", mob).order("ts", { ascending: false });
    tbody.innerHTML = (data && data.length)
      ? data.map((r, idx) => `
          <tr>
            <td data-label="S.No">${idx + 1}</td>
            <td data-label="Time">${new Date(r.ts).toLocaleString()}</td>
            <td data-label="Caller">${escapeHtml(r.caller_name)}</td>
            <td data-label="Event">${escapeHtml(r.event_code || "")}</td>
            <td data-label="Status">${escapeHtml(r.remarks)}</td>
            <td data-label="Comment">${escapeHtml(r.addl_remarks || "—")}</td>
          </tr>`).join("")
      : `<tr><td colspan="6" class="loading-row">No calls made yet.</td></tr>`;
    reapplyColumnOrder("contact-info-table");
  } else if (kind === "reviews") {
    thead.innerHTML = `<tr><th>S.No</th><th>Caller</th><th>What they said</th></tr>`;
    const { data } = await supabase.from("call_responses").select("ts,caller_name,remarks,addl_remarks").eq("mob_no", mob).order("ts", { ascending: false });
    const withNotes = (data || []).filter((r) => r.addl_remarks && r.addl_remarks.trim());
    tbody.innerHTML = withNotes.length
      ? withNotes.map((r, idx) => `
          <tr>
            <td data-label="S.No">${idx + 1}</td>
            <td data-label="Caller">${escapeHtml(r.caller_name)} <span class="muted-text">(${new Date(r.ts).toLocaleDateString()})</span></td>
            <td data-label="Said">${escapeHtml(r.addl_remarks)}</td>
          </tr>`).join("")
      : `<tr><td colspan="3" class="loading-row">No reviews from users yet.</td></tr>`;
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
        { name: "Org", value: escapeHtml(contact.company_name || "—") },
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
        { name: "Org", value: escapeHtml(contact.company_name || "—") },
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
  "S No", "Time Stamp", "Name", "Phone", "PG Name", "Org", "Profession", "Gender", "Sessions", "Calls",
  "Admin Tag to Users", "Admin Tag", "Core Cultivation", "Calling Purpose", "GFY/AOMC", "Admin Remarks",
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
        c.pg_name || "", c.company_name || "", c.ws || "NA", c.gender || "", c.sessions_count, c.calls_count,
        c.admin_tag_to_users || "", c.admin_tag || "", c.core_cultivation || "", c.calling_purpose || "",
        c.gyc_status || "", c.admin_remarks || "",
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

let addContactModalWired = false;
function wireAddContactModal() {
  // Lives on the New Contacts page now, but initContacts() (Master Contact)
  // used to be the only caller — re-wiring the button itself is idempotent
  // (plain assignment) so it's safe from both, while the modal's own
  // listeners below only need attaching once, guarded so revisiting either
  // page doesn't stack duplicate "click outside to close" handlers.
  document.getElementById("add-contact-btn").onclick = openAddContactModal;
  if (addContactModalWired) return;
  addContactModalWired = true;

  const modal = document.getElementById("add-contact-modal");
  const phoneInput = document.getElementById("add-contact-phone");
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

/* ======================= MESSAGE TEMPLATES (sticky notes) ======================= */
/* Exactly one template is "active" at a time — its text is what's written to
   the message_text setting that callers/core-cultivation actually send. */

export async function initMessage() {
  await loadAndRenderTemplates();
  wireTemplateModal();
}

let messageTemplates = [];
let editingTemplateId = null;

async function loadAndRenderTemplates() {
  const raw = await getSetting("message_templates");
  try {
    messageTemplates = raw ? JSON.parse(raw) : [];
  } catch {
    messageTemplates = [];
  }

  if (!messageTemplates.some((t) => t.active)) {
    if (messageTemplates.length) {
      messageTemplates[0].active = true;
      await persistTemplates();
    } else {
      const legacyText = (await getSetting("message_text")) || "";
      if (legacyText.trim()) {
        messageTemplates.push({ id: newTemplateId(), heading: "Current Message", text: legacyText, active: true });
        await persistTemplates();
      }
    }
  }

  renderMessageTemplates();
}

function newTemplateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function persistTemplates() {
  await setSetting("message_templates", JSON.stringify(messageTemplates));
  const active = messageTemplates.find((t) => t.active);
  await setSetting("message_text", active ? active.text : "");
}

function renderMessageTemplates() {
  const grid = document.getElementById("message-templates-grid");
  if (!messageTemplates.length) {
    grid.innerHTML = `<p class="sticky-note-empty">No templates yet — add one to get started.</p>`;
    return;
  }
  grid.innerHTML = messageTemplates.map((t) => `
    <div class="sticky-note ${t.active ? "sticky-note--active" : ""}" data-id="${t.id}">
      <div class="sticky-note-actions">
        ${t.active
          ? `<span class="sticky-note-pill sticky-note-pill--active">● Active</span>`
          : `<button type="button" class="sticky-note-pill template-activate-btn">Activate</button>`}
        <span class="sticky-note-icons">
          <button type="button" class="sticky-note-action-btn template-edit-btn" title="Edit">✎</button>
          <button type="button" class="sticky-note-action-btn template-delete-btn" title="Delete">🗑</button>
        </span>
      </div>
      <div class="sticky-note-heading">${escapeHtml(t.heading)}</div>
      <pre class="sticky-note-text">${escapeHtml(t.text)}</pre>
    </div>
  `).join("");

  grid.querySelectorAll(".template-activate-btn").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.closest(".sticky-note").dataset.id;
      messageTemplates.forEach((t) => { t.active = t.id === id; });
      await persistTemplates();
      renderMessageTemplates();
      showToast("Template activated", "success");
    };
  });
  grid.querySelectorAll(".template-edit-btn").forEach((btn) => {
    btn.onclick = () => openTemplateModal(btn.closest(".sticky-note").dataset.id);
  });
  grid.querySelectorAll(".template-delete-btn").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.closest(".sticky-note").dataset.id;
      const t = messageTemplates.find((x) => x.id === id);
      if (!confirm(`Delete template "${t?.heading || ""}"?`)) return;
      const wasActive = t?.active;
      messageTemplates = messageTemplates.filter((x) => x.id !== id);
      if (wasActive && messageTemplates.length) messageTemplates[0].active = true;
      await persistTemplates();
      renderMessageTemplates();
    };
  });
}

function openTemplateModal(id) {
  editingTemplateId = id || null;
  const t = id ? messageTemplates.find((x) => x.id === id) : null;
  document.getElementById("template-modal-title").textContent = t ? "Edit Template" : "Add Template";
  document.getElementById("template-heading").value = t ? t.heading : "";
  document.getElementById("template-text").value = t ? t.text : "";
  document.getElementById("template-error").classList.add("hidden");
  document.getElementById("template-modal").classList.add("active");
}

function wireTemplateModal() {
  const modal = document.getElementById("template-modal");
  const errorEl = document.getElementById("template-error");

  document.getElementById("add-template-btn").onclick = () => openTemplateModal(null);
  document.getElementById("template-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("template-save-btn").onclick = async () => {
    const heading = document.getElementById("template-heading").value.trim();
    const text = document.getElementById("template-text").value;
    if (!heading || !text.trim()) {
      errorEl.textContent = "Please enter both a heading and a message.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (editingTemplateId) {
      const t = messageTemplates.find((x) => x.id === editingTemplateId);
      if (t) { t.heading = heading; t.text = text; }
    } else {
      messageTemplates.push({ id: newTemplateId(), heading, text, active: messageTemplates.length === 0 });
    }
    await persistTemplates();
    modal.classList.remove("active");
    renderMessageTemplates();
    showToast("Template saved", "success");
  };
}

/* ======================= ANALYTICS ======================= */

let analyticsWired = false;

export async function initAnalytics() {
  await loadEvents();
  wireContactInfoModal();
  wireAssignedContactsFilters();
  wireFollowUpAssign();
  wireCultivationFilters();
  wireGeneralDataModal();
  wireFollowUpDataModal();
  wireCcGeneralDataModal();
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
        const headCells = Array.from(tableEl.querySelectorAll("thead th"));
        const skip = headCells.map((th) => th.classList.contains("followup-select-col"));
        const rows = [headCells.filter((_, i) => !skip[i]).map((th) => (th.querySelector(".th-label")?.textContent || th.textContent).trim())];
        tableEl.querySelectorAll("tbody tr").forEach((tr) => {
          rows.push(Array.from(tr.children).filter((_, i) => !skip[i]).map((td) => {
            const field = td.querySelector("input, select");
            return field ? field.value : td.textContent.trim();
          }));
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
    initHorizontalScroll("analytics-assigned-table-wrap");
    initHorizontalScroll("analytics-cultivation-table-wrap");
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

function formatOrdinalDate(ts) {
  const d = new Date(ts);
  const day = d.getDate();
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  const month = d.toLocaleString("en-US", { month: "short" });
  return `${day}${suffix} ${month} ${d.getFullYear()}`;
}

let currentAnalyticsParams = null;
let lastAssignedContacts = [];
let lastFollowUpMap = new Map(); // `${contact_id}|${event_code}` -> user_name currently handling the follow-up
const selectedFollowUpKeys = new Set(); // `${contact_id}|${event_code}` rows ticked for the next follow-up hand-off
const FOLLOWUP_ELIGIBLE_STATUSES = ["need to call again", "available on weekend"];

// re-applies the Caller/Status/Called? header filters over the already-fetched
// assignment list — no re-query needed, this table's data is small and local.
function renderAssignedContactsTable() {
  const assignedBody = document.getElementById("analytics-assigned-body");
  if (!assignedBody) return;
  const callerFilter = document.getElementById("analytics-assigned-filter-caller")?.value ?? "__ALL__";
  const statusFilter = document.getElementById("analytics-assigned-filter-status")?.value ?? "__ALL__";
  const calledFilter = document.getElementById("analytics-assigned-filter-called")?.value ?? "__ALL__";
  const adminTagFilter = document.getElementById("analytics-assigned-filter-admin-tag")?.value ?? "__ALL__";
  const sessionsFilter = document.getElementById("analytics-assigned-filter-sessions")?.value ?? "";
  const callsFilter = document.getElementById("analytics-assigned-filter-calls")?.value ?? "";
  const followupFilter = document.getElementById("analytics-assigned-filter-followup")?.value ?? "__ALL__";

  let rows = lastAssignedContacts;
  if (callerFilter !== "__ALL__") rows = rows.filter((a) => a.user_name === callerFilter);
  if (statusFilter !== "__ALL__") {
    rows = statusFilter === "" ? rows.filter((a) => !a.status || a.status === "Not Done") : rows.filter((a) => a.status === statusFilter);
  }
  if (calledFilter !== "__ALL__") {
    const wantCalled = calledFilter === "yes";
    rows = rows.filter((a) => (((a.status || "Not Done") !== "Not Done")) === wantCalled);
  }
  if (adminTagFilter !== "__ALL__") rows = rows.filter((a) => (a.contacts?.admin_tag_to_users || "") === adminTagFilter);
  if (sessionsFilter !== "") rows = rows.filter((a) => (a.contacts?.sessions_count ?? 0) === parseInt(sessionsFilter, 10));
  if (callsFilter !== "") rows = rows.filter((a) => (a.contacts?.calls_count ?? 0) === parseInt(callsFilter, 10));
  if (followupFilter !== "__ALL__") {
    rows = followupFilter === ""
      ? rows.filter((a) => !lastFollowUpMap.get(`${a.contact_id}|${a.event_code}`))
      : rows.filter((a) => lastFollowUpMap.get(`${a.contact_id}|${a.event_code}`) === followupFilter);
  }

  assignedBody.innerHTML = rows.length
    ? rows.map((a, idx) => {
        const key = `${a.contact_id}|${a.event_code}`;
        const eligible = FOLLOWUP_ELIGIBLE_STATUSES.includes((a.status || "").toLowerCase());
        const followUpUser = lastFollowUpMap.get(key);
        return `
        <tr>
          <td class="followup-select-col" data-label=""><input type="checkbox" class="followup-select" data-key="${key}" ${eligible ? "" : "disabled"} ${selectedFollowUpKeys.has(key) ? "checked" : ""} title="${eligible ? "Select for follow-up hand-off" : "Only Need to Call Again / Available on Weekend rows can be handed off"}" /></td>
          <td data-label="S.No">${idx + 1}</td>
          <td data-label="Caller">${escapeHtml(a.user_name)}</td>
          <td data-label="Name">${escapeHtml(a.contacts?.name || "—")}</td>
          <td data-label="Phone">${formatPhone(a.contacts?.mob_no || "")}</td>
          <td data-label="Status">${escapeHtml(a.status || "")}</td>
          <td data-label="Called?">${(a.status || "Not Done") !== "Not Done" ? "✅" : "—"}</td>
          <td data-label="Admin Tag to Users">
            <select class="inline-edit assigned-admin-tag" data-mob="${a.contacts?.mob_no || ""}" data-name="${escapeHtml(a.contacts?.name || "")}">
              ${ADMIN_TAG_TO_USERS_OPTIONS.map((t) => `<option value="${t}" ${t === (a.contacts?.admin_tag_to_users || "") ? "selected" : ""}>${t || "—"}</option>`).join("")}
            </select>
          </td>
          <td data-label="Sessions"><button class="cell-chip info-link" data-kind="sessions" data-mob="${a.contacts?.mob_no || ""}" data-name="${escapeHtml(a.contacts?.name || "")}">${a.contacts?.sessions_count ?? 0}</button></td>
          <td data-label="Calls"><button class="cell-chip info-link" data-kind="calls" data-mob="${a.contacts?.mob_no || ""}" data-name="${escapeHtml(a.contacts?.name || "")}">${a.contacts?.calls_count ?? 0}</button></td>
          <td data-label="Follow-up">${followUpUser ? `↪ ${escapeHtml(followUpUser)}` : "—"}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="11" class="loading-row">No contacts currently assigned.</td></tr>`;

  reapplyColumnOrder("analytics-assigned-table");

  assignedBody.querySelectorAll(".info-link").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      openContactInfoModal(e.target.dataset.kind, e.target.dataset.mob, e.target.dataset.name);
    });
  });

  assignedBody.querySelectorAll(".followup-select").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const key = e.target.dataset.key;
      if (e.target.checked) selectedFollowUpKeys.add(key);
      else selectedFollowUpKeys.delete(key);
    });
  });

  assignedBody.querySelectorAll(".assigned-admin-tag").forEach((select) => {
    select.addEventListener("change", async (e) => {
      const mob = e.target.dataset.mob;
      const name = e.target.dataset.name;
      const value = e.target.value || null;
      const { error } = await supabase.from("contacts").update({ admin_tag_to_users: value }).eq("mob_no", mob);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        return;
      }
      await syncCoordinatorUser({ name, mob_no: mob }, value);
      const row = lastAssignedContacts.find((a) => a.contacts?.mob_no === mob);
      if (row?.contacts) row.contacts.admin_tag_to_users = value;
      showToast("Admin tag updated", "success");
    });
  });
}

let assignedContactsFiltersWired = false;
function wireAssignedContactsFilters() {
  if (assignedContactsFiltersWired) return;
  assignedContactsFiltersWired = true;
  ["analytics-assigned-filter-caller", "analytics-assigned-filter-status", "analytics-assigned-filter-called", "analytics-assigned-filter-admin-tag", "analytics-assigned-filter-followup"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", renderAssignedContactsTable);
  });
  ["analytics-assigned-filter-sessions", "analytics-assigned-filter-calls"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", renderAssignedContactsTable);
  });
  initColumnDragReorder("analytics-assigned-table");
}

// Hands selected "Need to Call Again" / "Available on Weekend" rows off to a
// different caller via follow_up_assignments — a table completely separate
// from `assignments`, so Users & Assignment (counts, archiving) never sees
// this and is never touched by it.
let followUpAssignWired = false;
function wireFollowUpAssign() {
  if (followUpAssignWired) return;
  followUpAssignWired = true;

  document.getElementById("analytics-followup-assign-btn").addEventListener("click", openFollowUpAssignModal);

  const modal = document.getElementById("followup-assign-modal");
  document.getElementById("followup-assign-cancel").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
  document.getElementById("followup-assign-submit").onclick = runFollowUpAssign;
  document.getElementById("followup-assign-users-all").addEventListener("change", (e) => {
    document.querySelectorAll("#followup-assign-users-body .followup-assign-user-check").forEach((cb) => { cb.checked = e.target.checked; });
  });

  document.getElementById("analytics-followup-select-all").addEventListener("change", (e) => {
    document.querySelectorAll("#analytics-assigned-body .followup-select:not(:disabled)").forEach((cb) => {
      cb.checked = e.target.checked;
      if (e.target.checked) selectedFollowUpKeys.add(cb.dataset.key);
      else selectedFollowUpKeys.delete(cb.dataset.key);
    });
  });
}

async function openFollowUpAssignModal() {
  if (!selectedFollowUpKeys.size) {
    showToast("Tick at least one eligible row first (Need to Call Again / Available on Weekend).", "error");
    return;
  }
  const modal = document.getElementById("followup-assign-modal");
  const body = document.getElementById("followup-assign-users-body");
  document.getElementById("followup-assign-error").classList.add("hidden");
  document.getElementById("followup-assign-count").textContent = `${selectedFollowUpKeys.size} contact(s) selected.`;
  document.getElementById("followup-assign-users-all").checked = false;
  body.innerHTML = `<tr><td colspan="4" class="loading-row">Loading coordinators…</td></tr>`;
  modal.classList.add("active");

  const { data: coordinators } = await supabase.from("users").select("id,user_name").eq("role", "Coordinator").order("user_name");
  const currentLoad = {};
  lastFollowUpMap.forEach((userName) => { currentLoad[userName] = (currentLoad[userName] || 0) + 1; });

  body.innerHTML = (coordinators || []).length
    ? coordinators.map((u) => `
        <tr data-user="${escapeHtml(u.user_name)}">
          <td data-label=""><input type="checkbox" class="followup-assign-user-check" /></td>
          <td data-label="Coordinator">${escapeHtml(u.user_name)}</td>
          <td data-label="Current Follow-ups">${currentLoad[u.user_name] || 0}</td>
          <td data-label="Call Limit (blank = no limit)"><input type="number" min="0" class="followup-assign-user-limit inline-edit" placeholder="No limit" /></td>
        </tr>`).join("")
    : `<tr><td colspan="4" class="loading-row">No coordinators found.</td></tr>`;
}

async function runFollowUpAssign() {
  const errEl = document.getElementById("followup-assign-error");
  errEl.classList.add("hidden");

  const eligible = [];
  document.querySelectorAll("#followup-assign-users-body tr[data-user]").forEach((row) => {
    if (!row.querySelector(".followup-assign-user-check")?.checked) return;
    const limitVal = row.querySelector(".followup-assign-user-limit").value.trim();
    const parsed = parseInt(limitVal, 10);
    eligible.push({ user_name: row.dataset.user, call_limit: limitVal === "" || Number.isNaN(parsed) ? null : parsed });
  });
  if (!eligible.length) {
    errEl.textContent = "Select at least one coordinator to hand these off to.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!selectedFollowUpKeys.size) {
    errEl.textContent = "Select at least one contact first.";
    errEl.classList.remove("hidden");
    return;
  }

  const submitBtn = document.getElementById("followup-assign-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Assigning…";
  try {
    const pool = [...selectedFollowUpKeys].map((key) => {
      const [contact_id, event_code] = key.split("|");
      return { id: contact_id, calling_purpose: event_code };
    });
    const assignedCount = {};
    eligible.forEach((u) => { assignedCount[u.user_name] = 0; });
    const { rows: distRows, unassignedCount } = distributePool(pool, eligible, assignedCount, "");

    // Status starts blank on hand-off — carrying over the prior "Need to Call
    // Again" made the new follow-up look pre-answered (dropdown pre-filled,
    // and analytics counted it as already resolved/completed) even though
    // the new caller hadn't called yet.
    const rows = distRows.map((r) => ({ contact_id: r.contact_id, event_code: r.event_code, user_name: r.user_name, status: "", submitted_at: null }));
    const { error } = await supabase.from("follow_up_assignments").upsert(rows, { onConflict: "contact_id,event_code" });
    if (error) throw error;

    rows.forEach((r) => lastFollowUpMap.set(`${r.contact_id}|${r.event_code}`, r.user_name));
    selectedFollowUpKeys.clear();
    document.getElementById("followup-assign-modal").classList.remove("active");
    renderAssignedContactsTable();
    const byUser = {};
    rows.forEach((r) => { byUser[r.user_name] = (byUser[r.user_name] || 0) + 1; });
    const summary = Object.entries(byUser).map(([u, n]) => `${n} to ${u}`).join(", ");
    showToast(unassignedCount
      ? `Handed off: ${summary}. ${unassignedCount} contact(s) left unassigned (limits full).`
      : `Handed off: ${summary}`, "success");
  } catch (err) {
    errEl.textContent = "Assign failed: " + err.message;
    errEl.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Assign";
  }
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
    // `transform: scale` resizes the whole modal box (title, table, borders,
    // padding) together, anchored to its top-center (see theme.css) — the
    // modal backdrop scrolls if the scaled box grows taller than the screen.
    zoomBox.style.transform = `scale(${generalDataZoom / 100})`;
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

  initColumnDragReorder("general-data-table");

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

    const pctOf = (s) => (s.assigned > 0 ? ((s.assigned - s.pending) / s.assigned) * 100 : -1);
    const rows = Object.entries(stats)
      .filter(([, s]) => s.assigned > 0)
      .sort((a, b) => pctOf(b[1]) - pctOf(a[1]) || a[0].localeCompare(b[0]));
    tbody.innerHTML = rows.length
      ? rows.map(([name, s], idx) => {
          const completedPct = s.assigned > 0 ? Math.round(pctOf(s)) + "%" : "—";
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
    reapplyColumnOrder("general-data-table");
  };
}

// same per-caller assigned/positive/pending/completed% snapshot as General
// Data, but over follow_up_assignments instead of the live assignments table
// — how each caller's handed-off follow-up load is actually going.
let followUpDataModalWired = false;
function wireFollowUpDataModal() {
  if (followUpDataModalWired) return;
  followUpDataModalWired = true;
  const modal = document.getElementById("followup-data-modal");
  document.getElementById("followup-data-close").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  let followUpDataZoom = 100;
  const zoomBox = document.getElementById("followup-data-modal-box");
  const zoomLevel = document.getElementById("followup-data-zoom-level");
  const applyFollowUpDataZoom = () => {
    zoomBox.style.transform = `scale(${followUpDataZoom / 100})`;
    zoomLevel.textContent = followUpDataZoom + "%";
  };
  document.getElementById("followup-data-zoom-in").onclick = () => {
    followUpDataZoom = Math.min(200, followUpDataZoom + 10);
    applyFollowUpDataZoom();
  };
  document.getElementById("followup-data-zoom-out").onclick = () => {
    followUpDataZoom = Math.max(40, followUpDataZoom - 10);
    applyFollowUpDataZoom();
  };

  initColumnDragReorder("followup-data-table");

  document.getElementById("followup-data-btn").onclick = async () => {
    modal.classList.add("active");
    const tbody = document.getElementById("followup-data-body");
    tbody.innerHTML = `<tr><td colspan="6" class="loading-row">Loading…</td></tr>`;

    const { data: followUps } = await supabase.from("follow_up_assignments").select("user_name,status");

    const stats = {};
    (followUps || []).forEach((f) => {
      if (!stats[f.user_name]) stats[f.user_name] = { assigned: 0, positive: 0, pending: 0 };
      const s = stats[f.user_name];
      s.assigned++;
      const category = callOutcomeCategory(f.status);
      if (category === "positive") s.positive++;
      else if (category === "pending") s.pending++;
    });

    const pctOf = (s) => (s.assigned > 0 ? ((s.assigned - s.pending) / s.assigned) * 100 : -1);
    const rows = Object.entries(stats)
      .filter(([, s]) => s.assigned > 0)
      .sort((a, b) => pctOf(b[1]) - pctOf(a[1]) || a[0].localeCompare(b[0]));
    tbody.innerHTML = rows.length
      ? rows.map(([name, s], idx) => {
          const completedPct = s.assigned > 0 ? Math.round(pctOf(s)) + "%" : "—";
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
      : `<tr><td colspan="6" class="loading-row">No follow-up contacts currently handed off to anyone.</td></tr>`;
    reapplyColumnOrder("followup-data-table");
  };
}

// Per-cultivator rollup: of everyone assigned to them for core cultivation,
// how many got at least 2 calls (from that same cultivator) in the last 10
// days. Unlike General/Follow-up Data, "completed" here is a call-frequency
// threshold, not a status outcome — a cultivated contact needs sustained
// attention, not just one call ever.
const CC_GENERAL_DATA_MIN_CALLS = 2;

let ccGeneralDataModalWired = false;
function wireCcGeneralDataModal() {
  if (ccGeneralDataModalWired) return;
  ccGeneralDataModalWired = true;
  const modal = document.getElementById("cc-general-data-modal");
  document.getElementById("cc-general-data-close").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  let ccGeneralDataZoom = 100;
  const zoomBox = document.getElementById("cc-general-data-modal-box");
  const zoomLevel = document.getElementById("cc-general-data-zoom-level");
  const applyCcGeneralDataZoom = () => {
    zoomBox.style.transform = `scale(${ccGeneralDataZoom / 100})`;
    zoomLevel.textContent = ccGeneralDataZoom + "%";
  };
  document.getElementById("cc-general-data-zoom-in").onclick = () => {
    ccGeneralDataZoom = Math.min(200, ccGeneralDataZoom + 10);
    applyCcGeneralDataZoom();
  };
  document.getElementById("cc-general-data-zoom-out").onclick = () => {
    ccGeneralDataZoom = Math.max(40, ccGeneralDataZoom - 10);
    applyCcGeneralDataZoom();
  };

  initColumnDragReorder("cc-general-data-table");

  document.getElementById("cc-general-data-btn").onclick = async () => {
    modal.classList.add("active");
    const tbody = document.getElementById("cc-general-data-body");
    tbody.innerHTML = `<tr><td colspan="6" class="loading-row">Loading…</td></tr>`;

    const { data: cultivated } = await supabase.from("contacts").select("mob_no,core_cultivation").not("core_cultivation", "is", null);
    if (!cultivated || !cultivated.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="loading-row">No contacts under core cultivation.</td></tr>`;
      return;
    }

    const mobNos = [...new Set(cultivated.map((c) => c.mob_no))];
    const { data: calls } = await supabase
      .from("call_responses").select("mob_no,caller_name")
      .in("mob_no", mobNos).gte("ts", daysAgo(CORE_CULTIVATION_STALE_DAYS).toISOString());

    // tally recent calls per (contact, caller) pair — a call only counts
    // toward a contact's threshold if it was made by their own cultivator
    const recentCallCount = {};
    (calls || []).forEach((r) => {
      const key = r.mob_no + "|" + r.caller_name;
      recentCallCount[key] = (recentCallCount[key] || 0) + 1;
    });

    const stats = {};
    cultivated.forEach((c) => {
      if (!stats[c.core_cultivation]) stats[c.core_cultivation] = { total: 0, completed: 0 };
      const s = stats[c.core_cultivation];
      s.total++;
      const key = c.mob_no + "|" + c.core_cultivation;
      if ((recentCallCount[key] || 0) >= CC_GENERAL_DATA_MIN_CALLS) s.completed++;
    });

    const rows = Object.entries(stats).sort((a, b) => a[0].localeCompare(b[0]));
    tbody.innerHTML = rows.length
      ? rows.map(([name, s], idx) => {
          const pending = s.total - s.completed;
          const pct = s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0;
          return `
          <tr>
            <td data-label="S.No">${idx + 1}</td>
            <td data-label="Cultivator">${escapeHtml(name)}</td>
            <td data-label="Total">${s.total}</td>
            <td data-label="Completed">${s.completed}</td>
            <td data-label="Pending">${pending}</td>
            <td data-label="Completed %">${pct}%</td>
          </tr>`;
        }).join("")
      : `<tr><td colspan="6" class="loading-row">No contacts under core cultivation.</td></tr>`;
    reapplyColumnOrder("cc-general-data-table");
  };
}

// Shared row wiring for the contact-info-modal's Admin Tag/Sessions/Calls
// columns (same controls as the assigned/cultivation/attendance tables).
function wireContactInfoModalRowControls(tbody) {
  tbody.querySelectorAll(".info-link").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      openContactInfoModal(e.target.dataset.kind, e.target.dataset.mob, e.target.dataset.name);
    });
  });
  tbody.querySelectorAll(".contact-info-admin-tag").forEach((select) => {
    select.addEventListener("change", async (e) => {
      const mob = e.target.dataset.mob;
      const name = e.target.dataset.name;
      const value = e.target.value || null;
      const { error } = await supabase.from("contacts").update({ admin_tag_to_users: value }).eq("mob_no", mob);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        return;
      }
      await syncCoordinatorUser({ name, mob_no: mob }, value);
      showToast("Admin tag updated", "success");
    });
  });
}

async function openAnalyticsStatModal(statType) {
  if (!currentAnalyticsParams) return;
  const { userName, isAll, fromTs, toTs, eventFilter } = currentAnalyticsParams;

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
    thead.innerHTML = `<tr><th>S.No</th>${isAll ? "<th>Caller</th>" : ""}<th>Name</th><th>Phone</th><th>Campaign</th><th>Admin Tag to Users</th><th>Sessions</th><th>Calls</th></tr>`;
    initColumnDragReorder("contact-info-table", { storageKey: "nrg-col-order:contact-info-assigned", force: true });

    let query = supabase
      .from("assignments")
      .select("user_name, event_code, contacts(name, mob_no, admin_tag_to_users, sessions_count, calls_count)");
    // Only filter by event if the user explicitly selected a specific event —
    // matches the Total Assigned tile, so "All events" shows every live row.
    if (eventFilter) query = query.eq("event_code", eventFilter);
    if (!isAll) query = query.eq("user_name", userName);
    query = query.order("event_code");

    const { data, error } = await query;
    if (error) {
      tbody.innerHTML = `<tr><td colspan="${isAll ? 8 : 7}" class="loading-row">Error loading assignments: ${error.message}</td></tr>`;
      return;
    }
    if (!data || !data.length) {
      tbody.innerHTML = `<tr><td colspan="${isAll ? 8 : 7}" class="loading-row">No assigned contacts found.</td></tr>`;
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
        <td data-label="Admin Tag to Users">
          <select class="inline-edit contact-info-admin-tag" data-mob="${a.contacts?.mob_no || ""}" data-name="${escapeHtml(a.contacts?.name || "")}">
            ${ADMIN_TAG_TO_USERS_OPTIONS.map((t) => `<option value="${t}" ${t === (a.contacts?.admin_tag_to_users || "") ? "selected" : ""}>${t || "—"}</option>`).join("")}
          </select>
        </td>
        <td data-label="Sessions"><button class="cell-chip info-link" data-kind="sessions" data-mob="${a.contacts?.mob_no || ""}" data-name="${escapeHtml(a.contacts?.name || "")}">${a.contacts?.sessions_count ?? 0}</button></td>
        <td data-label="Calls"><button class="cell-chip info-link" data-kind="calls" data-mob="${a.contacts?.mob_no || ""}" data-name="${escapeHtml(a.contacts?.name || "")}">${a.contacts?.calls_count ?? 0}</button></td>
      </tr>
    `).join("");
    reapplyColumnOrder("contact-info-table");
    wireContactInfoModalRowControls(tbody);
  } else if (statType === "pending") {
    document.getElementById("contact-info-title").textContent = "Pending Contacts Details";
    document.getElementById("contact-info-sub").textContent = isAll ? "All Users (Combined)" : userName;
    thead.innerHTML = `<tr><th>S.No</th>${isAll ? "<th>Caller</th>" : ""}<th>Name</th><th>Phone</th><th>Campaign</th><th>Admin Tag to Users</th><th>Sessions</th><th>Calls</th></tr>`;
    initColumnDragReorder("contact-info-table", { storageKey: "nrg-col-order:contact-info-pending", force: true });

    let query = supabase
      .from("assignments")
      .select("user_name, event_code, status, contacts(name, mob_no, admin_tag_to_users, sessions_count, calls_count)")
      .in("status", ["Not Done", "yet to call", ""]);
    if (eventFilter) query = query.eq("event_code", eventFilter);
    if (!isAll) query = query.eq("user_name", userName);
    query = query.order("event_code");

    const { data, error } = await query;
    if (error) {
      tbody.innerHTML = `<tr><td colspan="${isAll ? 8 : 7}" class="loading-row">Error loading pending assignments: ${error.message}</td></tr>`;
      return;
    }
    if (!data || !data.length) {
      tbody.innerHTML = `<tr><td colspan="${isAll ? 8 : 7}" class="loading-row">No pending contacts found.</td></tr>`;
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
        <td data-label="Admin Tag to Users">
          <select class="inline-edit contact-info-admin-tag" data-mob="${a.contacts?.mob_no || ""}" data-name="${escapeHtml(a.contacts?.name || "")}">
            ${ADMIN_TAG_TO_USERS_OPTIONS.map((t) => `<option value="${t}" ${t === (a.contacts?.admin_tag_to_users || "") ? "selected" : ""}>${t || "—"}</option>`).join("")}
          </select>
        </td>
        <td data-label="Sessions"><button class="cell-chip info-link" data-kind="sessions" data-mob="${a.contacts?.mob_no || ""}" data-name="${escapeHtml(a.contacts?.name || "")}">${a.contacts?.sessions_count ?? 0}</button></td>
        <td data-label="Calls"><button class="cell-chip info-link" data-kind="calls" data-mob="${a.contacts?.mob_no || ""}" data-name="${escapeHtml(a.contacts?.name || "")}">${a.contacts?.calls_count ?? 0}</button></td>
      </tr>
    `).join("");
    reapplyColumnOrder("contact-info-table");
    wireContactInfoModalRowControls(tbody);
  } else {
    // call response stats (calls or positive)
    let title = statType === "positive" ? "Positive Responses" : "Calls Made";
    document.getElementById("contact-info-title").textContent = title;
    document.getElementById("contact-info-sub").textContent = isAll ? "All Users (Combined)" : userName;
    thead.innerHTML = `<tr><th>S.No</th><th>Time</th>${isAll ? "<th>Caller</th>" : ""}<th>Name</th><th>Phone</th><th>Status</th><th>Admin Tag to Users</th><th>Sessions</th><th>Calls</th></tr>`;
    initColumnDragReorder("contact-info-table", { storageKey: "nrg-col-order:contact-info-callstats", force: true });

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
      tbody.innerHTML = `<tr><td colspan="${isAll ? 9 : 8}" class="loading-row">Error loading call responses.</td></tr>`;
      return;
    }

    let filtered = data || [];
    if (statType === "positive") {
      filtered = filtered.filter((r) => callOutcomeCategory(r.remarks) === "positive");
    }

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="${isAll ? 9 : 8}" class="loading-row">No responses found.</td></tr>`;
      return;
    }

    // group rows by caller so one person's calls sit together, not interleaved with others'
    filtered.sort((a, b) => a.caller_name.localeCompare(b.caller_name));

    // call_responses has no FK to contacts, so fetch the Admin Tag/Sessions/
    // Calls trio separately by mob_no (same pattern as the attendance table).
    const mobNos = [...new Set(filtered.map((r) => r.mob_no))];
    const contactsByMob = new Map();
    if (mobNos.length) {
      const { data: contacts } = await supabase.from("contacts").select("mob_no,admin_tag_to_users,sessions_count,calls_count").in("mob_no", mobNos);
      (contacts || []).forEach((c) => contactsByMob.set(c.mob_no, c));
    }

    tbody.innerHTML = filtered.map((r, idx) => {
      const c = contactsByMob.get(r.mob_no);
      return `
      <tr>
        <td data-label="S.No">${idx + 1}</td>
        <td data-label="Time">${new Date(r.ts).toLocaleString()}</td>
        ${isAll ? `<td data-label="Caller">${escapeHtml(r.caller_name)}</td>` : ""}
        <td data-label="Name">${escapeHtml(r.contact_name || "")}</td>
        <td data-label="Phone" class="phone-clickable" title="Click to copy phone number">${formatPhone(r.mob_no)}</td>
        <td data-label="Status">${escapeHtml(r.remarks)}${r.addl_remarks ? " — " + escapeHtml(r.addl_remarks) : ""}</td>
        <td data-label="Admin Tag to Users">
          <select class="inline-edit contact-info-admin-tag" data-mob="${r.mob_no}" data-name="${escapeHtml(r.contact_name || "")}">
            ${ADMIN_TAG_TO_USERS_OPTIONS.map((t) => `<option value="${t}" ${t === (c?.admin_tag_to_users || "") ? "selected" : ""}>${t || "—"}</option>`).join("")}
          </select>
        </td>
        <td data-label="Sessions"><button class="cell-chip info-link" data-kind="sessions" data-mob="${r.mob_no}" data-name="${escapeHtml(r.contact_name || "")}">${c?.sessions_count ?? 0}</button></td>
        <td data-label="Calls"><button class="cell-chip info-link" data-kind="calls" data-mob="${r.mob_no}" data-name="${escapeHtml(r.contact_name || "")}">${c?.calls_count ?? 0}</button></td>
      </tr>
    `;
    }).join("");
    reapplyColumnOrder("contact-info-table");
    wireContactInfoModalRowControls(tbody);
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

  currentAnalyticsParams = { userName, isAll, fromTs, toTs, eventFilter };

  // total calls made in the selected range, broken down by outcome — counted
  // server-side (call_outcome_counts RPC) instead of fetching every matching
  // row's remarks, so this stays cheap as call_responses grows over time.
  const { data: outcomeRow, error: outcomeError } = await supabase
    .rpc("call_outcome_counts", {
      p_caller_name: isAll ? null : userName,
      p_event_code: eventFilter || null,
      p_from_ts: fromTs,
      p_to_ts: toTs,
    })
    .single();
  if (isStale()) return;

  let totalCalls = outcomeRow?.total ?? 0;
  let positiveCalls = outcomeRow?.positive ?? 0;
  if (outcomeError) {
    // The RPC (supabase/analytics-rpc.sql) hasn't been run against this
    // Supabase project yet, so it 404s — fall back to counting client-side
    // so the stat still works until that migration is deployed.
    let fallbackQuery = supabase.from("call_responses").select("remarks");
    if (!isAll) fallbackQuery = fallbackQuery.eq("caller_name", userName);
    if (eventFilter) fallbackQuery = fallbackQuery.eq("event_code", eventFilter);
    if (fromTs) fallbackQuery = fallbackQuery.gte("ts", fromTs);
    if (toTs) fallbackQuery = fallbackQuery.lte("ts", toTs);
    const { data: fallbackRows } = await fallbackQuery;
    if (isStale()) return;
    totalCalls = fallbackRows?.length ?? 0;
    positiveCalls = (fallbackRows || []).filter((r) => callOutcomeCategory(r.remarks) === "positive").length;
  }
  document.getElementById("analytics-total-calls").textContent = totalCalls;
  document.getElementById("analytics-positive-calls").textContent = positiveCalls;

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
  // Filter by the same criterion as the Total Assigned tile above (the Event
  // dropdown), not the global current-event setting, so the drill-down count
  // always matches the tile — e.g. "All events" must show every live row.
  let assignedQuery = supabase.from("assignments").select("user_name,status,event_code,contact_id,contacts(name,mob_no,admin_tag_to_users,sessions_count,calls_count)");
  if (eventFilter) assignedQuery = assignedQuery.eq("event_code", eventFilter);
  if (!isAll) assignedQuery = assignedQuery.eq("user_name", userName);
  const [{ data: assignedContacts }, { data: followUpRows }] = await Promise.all([
    assignedQuery,
    supabase.from("follow_up_assignments").select("contact_id,event_code,user_name"),
  ]);
  if (isStale()) return;
  // group rows by caller so one person's contacts sit together, not interleaved with others'
  if (assignedContacts) assignedContacts.sort((a, b) => a.user_name.localeCompare(b.user_name));
  lastAssignedContacts = assignedContacts || [];
  lastFollowUpMap = new Map((followUpRows || []).map((f) => [`${f.contact_id}|${f.event_code}`, f.user_name]));
  selectedFollowUpKeys.clear();
  populateFilterSelect(
    document.getElementById("analytics-assigned-filter-caller"),
    [...new Set(lastAssignedContacts.map((a) => a.user_name))].filter(Boolean).sort()
  );
  populateFilterSelect(
    document.getElementById("analytics-assigned-filter-status"),
    [...new Set(lastAssignedContacts.map((a) => a.status))].filter(Boolean).sort(),
    ""
  );
  populateFilterSelect(
    document.getElementById("analytics-assigned-filter-followup"),
    [...new Set(lastFollowUpMap.values())].filter(Boolean).sort(),
    "Not handed off"
  );
  renderAssignedContactsTable();

  // core cultivation health: is the cultivator actually calling the people cultivated to them?
  let cultivatedQuery = supabase.from("contacts").select("name,mob_no,core_cultivation,admin_tag_to_users,sessions_count,calls_count");
  cultivatedQuery = isAll ? cultivatedQuery.not("core_cultivation", "is", null) : cultivatedQuery.eq("core_cultivation", userName);
  const { data: cultivated } = await cultivatedQuery;
  if (isStale()) return;
  // group rows by cultivator so one person's contacts sit together, not interleaved with others'
  if (cultivated) cultivated.sort((a, b) => (a.core_cultivation || "").localeCompare(b.core_cultivation || ""));
  lastCultivationEmptyMessage = `No contacts cultivated${isAll ? "" : " to this user"}.`;
  if (!cultivated || !cultivated.length) {
    lastCultivationRows = [];
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
    lastCultivationRows = cultivated.map((c) => {
      const key = keyOf(c.mob_no, c.core_cultivation);
      return {
        cultivator: c.core_cultivation || "",
        name: c.name,
        mob_no: c.mob_no,
        admin_tag_to_users: c.admin_tag_to_users,
        sessions_count: c.sessions_count,
        calls_count: c.calls_count,
        totalCalls: totalCallsByMob[key] || 0,
        lastCalledTs: lastCalled[key] || null,
      };
    });
  }
  renderCultivationTable();
}

let lastCultivationRows = [];
let lastCultivationEmptyMessage = "No contacts cultivated.";

// re-applies the Admin Tag/Sessions/Calls header filters over the
// already-fetched cultivation list — no re-query needed, this table's data
// is small and local (same pattern as renderAssignedContactsTable).
function renderCultivationTable() {
  const cultivationBody = document.getElementById("analytics-cultivation-body");
  if (!cultivationBody) return;
  const adminTagFilter = document.getElementById("analytics-cultivation-filter-admin-tag")?.value ?? "__ALL__";
  const sessionsFilter = document.getElementById("analytics-cultivation-filter-sessions")?.value ?? "";
  const callsFilter = document.getElementById("analytics-cultivation-filter-calls")?.value ?? "";

  let rows = lastCultivationRows;
  if (adminTagFilter !== "__ALL__") rows = rows.filter((c) => (c.admin_tag_to_users || "") === adminTagFilter);
  if (sessionsFilter !== "") rows = rows.filter((c) => (c.sessions_count ?? 0) === parseInt(sessionsFilter, 10));
  if (callsFilter !== "") rows = rows.filter((c) => (c.calls_count ?? 0) === parseInt(callsFilter, 10));

  if (!rows.length) {
    const msg = lastCultivationRows.length ? "No contacts match these filters." : lastCultivationEmptyMessage;
    cultivationBody.innerHTML = `<tr><td colspan="9" class="loading-row">${msg}</td></tr>`;
    return;
  }

  cultivationBody.innerHTML = rows.map((c, idx) => {
    // Cold contact: this cultivator hasn't logged a call to them within the
    // stale window, so flag the whole row for admin attention.
    const isStale = !c.lastCalledTs || new Date(c.lastCalledTs) < daysAgo(CORE_CULTIVATION_STALE_DAYS);
    return `
      <tr class="${isStale ? "row-cc-stale" : ""}">
        <td data-label="S.No">${idx + 1}</td>
        <td data-label="Cultivator">${escapeHtml(c.cultivator)}</td>
        <td data-label="Name">${escapeHtml(c.name)}</td>
        <td data-label="Phone">${formatPhone(c.mob_no)}</td>
        <td data-label="Total Calls">${c.totalCalls}</td>
        <td data-label="Last Called">${c.lastCalledTs ? formatOrdinalDate(c.lastCalledTs) : "Never called"}</td>
        <td data-label="Admin Tag to Users">
          <select class="inline-edit cultivation-admin-tag" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">
            ${ADMIN_TAG_TO_USERS_OPTIONS.map((t) => `<option value="${t}" ${t === (c.admin_tag_to_users || "") ? "selected" : ""}>${t || "—"}</option>`).join("")}
          </select>
        </td>
        <td data-label="Sessions"><button class="cell-chip info-link" data-kind="sessions" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">${c.sessions_count ?? 0}</button></td>
        <td data-label="Calls"><button class="cell-chip info-link" data-kind="calls" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">${c.calls_count ?? 0}</button></td>
      </tr>`;
  }).join("");

  reapplyColumnOrder("analytics-cultivation-table");

  cultivationBody.querySelectorAll(".info-link").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      openContactInfoModal(e.target.dataset.kind, e.target.dataset.mob, e.target.dataset.name);
    });
  });

  cultivationBody.querySelectorAll(".cultivation-admin-tag").forEach((select) => {
    select.addEventListener("change", async (e) => {
      const mob = e.target.dataset.mob;
      const name = e.target.dataset.name;
      const value = e.target.value || null;
      const { error } = await supabase.from("contacts").update({ admin_tag_to_users: value }).eq("mob_no", mob);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        return;
      }
      await syncCoordinatorUser({ name, mob_no: mob }, value);
      const row = lastCultivationRows.find((c) => c.mob_no === mob);
      if (row) row.admin_tag_to_users = value;
      showToast("Admin tag updated", "success");
    });
  });
}

let cultivationFiltersWired = false;
function wireCultivationFilters() {
  if (cultivationFiltersWired) return;
  cultivationFiltersWired = true;
  const el = document.getElementById("analytics-cultivation-filter-admin-tag");
  if (el) el.addEventListener("change", renderCultivationTable);
  ["analytics-cultivation-filter-sessions", "analytics-cultivation-filter-calls"].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.addEventListener("input", renderCultivationTable);
  });
  initColumnDragReorder("analytics-cultivation-table");
}

/* ======================= RECEPTION ANALYTICS ======================= */

let receptionAnalyticsWired = false;

export async function initReceptionAnalytics() {
  await loadEvents();
  wireContactInfoModal();
  wireReceptionAttendanceFilters();
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
    initHorizontalScroll("reception-analytics-attendance-table-wrap");
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
  // Counted server-side (call_outcome_counts RPC) so this stays cheap as the
  // log keeps growing, instead of fetching every matching row's remarks.
  const { data: outcomeRow, error: outcomeError } = await supabase
    .rpc("call_outcome_counts", {
      p_caller_name: null,
      p_event_code: eventCode || null,
      p_from_ts: fromTs,
      p_to_ts: toTs,
    })
    .single();
  if (isStale()) return;

  let totalCalls = outcomeRow?.total ?? 0;
  let positiveCalls = outcomeRow?.positive ?? 0;
  if (outcomeError) {
    // The RPC (supabase/analytics-rpc.sql) hasn't been run against this
    // Supabase project yet, so it 404s — fall back to counting client-side
    // so the stat still works until that migration is deployed.
    let fallbackQuery = supabase.from("call_responses").select("remarks");
    if (eventCode) fallbackQuery = fallbackQuery.eq("event_code", eventCode);
    if (fromTs) fallbackQuery = fallbackQuery.gte("ts", fromTs);
    if (toTs) fallbackQuery = fallbackQuery.lte("ts", toTs);
    const { data: fallbackRows } = await fallbackQuery;
    if (isStale()) return;
    totalCalls = fallbackRows?.length ?? 0;
    positiveCalls = (fallbackRows || []).filter((r) => callOutcomeCategory(r.remarks) === "positive").length;
  }
  document.getElementById("reception-analytics-calls-made").textContent = totalCalls;
  document.getElementById("reception-analytics-positive").textContent = positiveCalls;

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

  // per-contact Admin Tag/Sessions/Calls shown alongside each attendance row —
  // session_attendance has no FK to contacts, so fetch by mob_no like the
  // Reception page's own Today's Attendance list does.
  const mobNos = [...new Set(rows.map((r) => r.mob_no))];
  const contactsByMob = new Map();
  if (mobNos.length) {
    const { data: contacts } = await supabase.from("contacts").select("mob_no,admin_tag_to_users,sessions_count,calls_count").in("mob_no", mobNos);
    (contacts || []).forEach((c) => contactsByMob.set(c.mob_no, c));
  }
  if (isStale()) return;

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

  lastReceptionAttendanceRows = sorted.map((r) => {
    const dupGroup = groups.get(r.mob_no);
    const isDuplicate = dupGroup.length > 1;
    const isOldest = isDuplicate && dupGroup[dupGroup.length - 1].id === r.id;
    return { ...r, contact: contactsByMob.get(r.mob_no) || null, isDuplicate, isOldest };
  });
  currentReceptionAnalyticsParams = { eventCode, fromDate, toDate };
  renderReceptionAttendanceTable();
}

let lastReceptionAttendanceRows = [];
let currentReceptionAnalyticsParams = null;

// re-applies the Admin Tag/Sessions/Calls header filters over the
// already-fetched attendance list — no re-query needed (same pattern as
// renderAssignedContactsTable / renderCultivationTable).
function renderReceptionAttendanceTable() {
  const tbody = document.getElementById("reception-analytics-attendance-body");
  if (!tbody) return;
  const adminTagFilter = document.getElementById("reception-analytics-filter-admin-tag")?.value ?? "__ALL__";
  const sessionsFilter = document.getElementById("reception-analytics-filter-sessions")?.value ?? "";
  const callsFilter = document.getElementById("reception-analytics-filter-calls")?.value ?? "";

  let sorted = lastReceptionAttendanceRows;
  if (adminTagFilter !== "__ALL__") sorted = sorted.filter((r) => (r.contact?.admin_tag_to_users || "") === adminTagFilter);
  if (sessionsFilter !== "") sorted = sorted.filter((r) => (r.contact?.sessions_count ?? 0) === parseInt(sessionsFilter, 10));
  if (callsFilter !== "") sorted = sorted.filter((r) => (r.contact?.calls_count ?? 0) === parseInt(callsFilter, 10));

  tbody.innerHTML = sorted.length
    ? sorted.map((r, idx) => {
        const rowClass = r.isDuplicate ? (r.isOldest ? "contact-original" : "contact-duplicate") : "";
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
          <td data-label="Admin Tag to Users">
            <select class="inline-edit reception-analytics-admin-tag" data-mob="${r.mob_no}" data-name="${escapeHtml(r.name || "")}">
              ${ADMIN_TAG_TO_USERS_OPTIONS.map((t) => `<option value="${t}" ${t === (r.contact?.admin_tag_to_users || "") ? "selected" : ""}>${t || "—"}</option>`).join("")}
            </select>
          </td>
          <td data-label="Sessions"><button class="cell-chip info-link" data-kind="sessions" data-mob="${r.mob_no}" data-name="${escapeHtml(r.name || "")}">${r.contact?.sessions_count ?? 0}</button></td>
          <td data-label="Calls"><button class="cell-chip info-link" data-kind="calls" data-mob="${r.mob_no}" data-name="${escapeHtml(r.name || "")}">${r.contact?.calls_count ?? 0}</button></td>
          <td data-label="Marked By">${escapeHtml(r.took_by)}</td>
          <td data-label="Actions" class="no-export"><button class="cell-chip danger attendance-delete-btn" data-id="${r.id}" data-name="${escapeHtml(r.name || "")}">✕ Delete</button></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="10" class="loading-row">${lastReceptionAttendanceRows.length ? "No attendance rows match these filters." : "No attendance marked in this range."}</td></tr>`;

  reapplyColumnOrder("reception-analytics-attendance-table");

  tbody.querySelectorAll(".info-link").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      openContactInfoModal(e.target.dataset.kind, e.target.dataset.mob, e.target.dataset.name);
    });
  });

  tbody.querySelectorAll(".reception-analytics-admin-tag").forEach((select) => {
    select.addEventListener("change", async (e) => {
      const mob = e.target.dataset.mob;
      const name = e.target.dataset.name;
      const value = e.target.value || null;
      const { error } = await supabase.from("contacts").update({ admin_tag_to_users: value }).eq("mob_no", mob);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        return;
      }
      await syncCoordinatorUser({ name, mob_no: mob }, value);
      lastReceptionAttendanceRows.filter((r) => r.mob_no === mob).forEach((r) => { if (r.contact) r.contact.admin_tag_to_users = value; });
      showToast("Admin tag updated", "success");
    });
  });

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
      const { eventCode, fromDate, toDate } = currentReceptionAnalyticsParams;
      runReceptionAnalytics(eventCode, fromDate, toDate);
    });
  });
}

let receptionAttendanceFiltersWired = false;
function wireReceptionAttendanceFilters() {
  if (receptionAttendanceFiltersWired) return;
  receptionAttendanceFiltersWired = true;
  const el = document.getElementById("reception-analytics-filter-admin-tag");
  if (el) el.addEventListener("change", renderReceptionAttendanceTable);
  ["reception-analytics-filter-sessions", "reception-analytics-filter-calls"].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.addEventListener("input", renderReceptionAttendanceTable);
  });
  initColumnDragReorder("reception-analytics-attendance-table");
}

/* ======================= NEW CONTACTS & DUPLICATE RESOLUTION ======================= */

let newContactsPollInterval = null;
let sheetsWebhookUrl = "";
let newContactsCache = [];
let newContactsCoordinators = [];
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
  tbody.innerHTML = `<tr><td colspan="20" class="loading-row">Loading…</td></tr>`;

  const [{ data, error }, { data: coordinators }] = await Promise.all([
    supabase.from("contact_collection").select("*").order("created_at", { ascending: false }),
    supabase.from("users").select("user_name").eq("role", "Coordinator").order("user_name"),
  ]);
  if (coordinators) newContactsCoordinators = coordinators;

  if (error) {
    tbody.innerHTML = `<tr><td colspan="20" class="loading-row">Could not load submissions.</td></tr>`;
    return;
  }
  if (!data || !data.length) {
    tbody.innerHTML = `<tr><td colspan="20" class="loading-row">No submissions yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.map((r, i) => `
    <tr data-id="${r.id}">
      <td data-label="S.No">${i + 1}</td>
      <td data-label="Time">${new Date(r.created_at).toLocaleString()}</td>
      <td data-label="Name"><input class="inline-edit collection-field" data-id="${r.id}" data-field="name" value="${escapeHtml(r.name)}" /></td>
      <td data-label="Phone" class="phone-cell"><input class="inline-edit collection-field" data-id="${r.id}" data-field="mob_no" value="${escapeHtml(r.mob_no)}" /></td>
      <td data-label="PG Name"><input class="inline-edit collection-field" data-id="${r.id}" data-field="staying" value="${escapeHtml(r.staying || "")}" /></td>
      <td data-label="Profession">
        <select class="inline-edit collection-field" data-id="${r.id}" data-field="ws">
          ${WS_ADMIN_OPTIONS.map((o) => `<option value="${o}" ${o === (r.ws || r.profession || "NA") ? "selected" : ""}>${o}</option>`).join("")}
        </select>
      </td>
      <td data-label="Gender">
        <select class="inline-edit collection-field" data-id="${r.id}" data-field="gender">
          ${GENDER_ADMIN_OPTIONS.map((o) => `<option value="${o}" ${o === (r.gender || "") ? "selected" : ""}>${o || "—"}</option>`).join("")}
        </select>
      </td>
      <td data-label="Sessions">—</td>
      <td data-label="Calls">—</td>
      <td data-label="Admin Tag to Users">
        <select class="inline-edit collection-field" data-id="${r.id}" data-field="admin_tag_to_users">
          ${ADMIN_TAG_TO_USERS_OPTIONS.map((t) => `<option value="${t}" ${t === (r.admin_tag_to_users || "") ? "selected" : ""}>${t || "—"}</option>`).join("")}
        </select>
      </td>
      <td data-label="Admin Tag">
        <select class="inline-edit collection-field" data-id="${r.id}" data-field="admin_tag">
          ${ADMIN_TAG_OPTIONS.map((t) => `<option value="${t}" ${t === (r.admin_tag || "") ? "selected" : ""}>${t || "—"}</option>`).join("")}
        </select>
      </td>
      <td data-label="Core Cultivation">
        <select class="inline-edit collection-field" data-id="${r.id}" data-field="core_cultivation">
          <option value="">—</option>
          ${newContactsCoordinators.map((u) => `<option value="${escapeHtml(u.user_name)}" ${u.user_name === (r.core_cultivation || "") ? "selected" : ""}>${escapeHtml(u.user_name)}</option>`).join("")}
        </select>
      </td>
      <td data-label="Calling Purpose">
        <select class="inline-edit collection-field" data-id="${r.id}" data-field="calling_purpose">
          <option value="">— select —</option>
          ${eventsCache.map((e) => `<option value="${e.code}" ${e.code === (r.calling_purpose || "") ? "selected" : ""}>${e.code}</option>`).join("")}
        </select>
      </td>
      <td data-label="GFY/AOMC">
        <select class="inline-edit collection-field" data-id="${r.id}" data-field="gyc_status">
          ${GYC_STATUS_OPTIONS.map((t) => `<option value="${escapeHtml(t)}" ${t === (r.gyc_status || "") ? "selected" : ""}>${escapeHtml(t) || "—"}</option>`).join("")}
        </select>
      </td>
      <td data-label="Comment"><input class="inline-edit collection-field" data-id="${r.id}" data-field="comment" value="${escapeHtml(r.comment || "")}" /></td>
      <td data-label="Collected By"><input class="inline-edit collection-field" data-id="${r.id}" data-field="collected_by" value="${escapeHtml(r.collected_by || "")}" /></td>
      <td data-label="Source"><input class="inline-edit collection-field" data-id="${r.id}" data-field="source" value="${escapeHtml(r.source || "Contact Collection")}" /></td>
      <td data-label="User Reviews">—</td>
      <td data-label="Admin Review">—</td>
      <td data-label="" class="no-export">
        <button class="cell-chip collection-add-btn" data-id="${r.id}">+ Add</button>
        <button class="cell-chip danger collection-delete-btn" data-id="${r.id}">Delete</button>
      </td>
    </tr>
  `).join("");

  reapplyColumnOrder("collection-submissions-admin-table");

  // Filled in here rather than after promotion: the admin decides cultivation
  // and GFY/AOMC while reviewing, and "+ Add" then carries them into Master
  // Contact along with everything else the row already holds.
  tbody.querySelectorAll(".collection-field").forEach((field) => {
    field.addEventListener("change", async (e) => {
      const id = e.target.dataset.id;
      const fieldName = e.target.dataset.field;
      let value = e.target.value.trim ? e.target.value.trim() : e.target.value;
      if (fieldName === "mob_no") value = normalizePhoneInput(value);
      e.target.value = value;
      value = value || null;
      const row = data.find((r) => r.id === id);
      // "ws" and "profession" both hold the same NA/W/S domain depending on
      // which flow created the row — keep them in sync on edit.
      const patch = fieldName === "ws" ? { ws: value, profession: value } : { [fieldName]: value };
      const { error: updErr } = await supabase.from("contact_collection").update(patch).eq("id", id);
      if (updErr) {
        showToast("Update failed: " + updErr.message, "error");
        e.target.value = row?.[fieldName] ?? "";
        return;
      }
      if (row) Object.assign(row, patch);
    });
  });

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

  wireAddContactModal();

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

    initColumnDragReorder("collection-submissions-admin-table");
    initHorizontalScroll("new-contacts-table-wrap");
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
      `<tr><td colspan="20" class="loading-row">Please configure apps_script_webhook_url in DB settings first.</td></tr>`;
    return;
  }

  await loadEvents();

  // Load immediately
  await loadNewContacts();

  // Poll every 10 seconds
  newContactsPollInterval = setInterval(() => {
    loadNewContacts();
  }, 10000);
}

export function stopNewContactsPolling() {
  if (newContactsPollInterval) {
    clearInterval(newContactsPollInterval);
    newContactsPollInterval = null;
  }
}

async function loadNewContacts(forceShowLoading = false) {
  if (isResolvingDuplicates) return;
  if (isFetchingNewContacts) return;

  const tbody = document.getElementById("new-contacts-table-body");
  const summaryEl = document.getElementById("new-contacts-summary");

  if (forceShowLoading || tbody.innerHTML.includes("Connecting")) {
    tbody.innerHTML = `<tr><td colspan="20" class="loading-row">Loading new contacts from Sheets…</td></tr>`;
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
    tbody.innerHTML = `<tr><td colspan="20" class="loading-row">No new contacts found in Google Sheets.</td></tr>`;
    summaryEl.textContent = "";
    return;
  }

  summaryEl.textContent = `Found ${newContactsCache.length} new contact(s) in Sheets.`;

  const activeEvent = document.getElementById("event-select")?.value || "";

  tbody.innerHTML = newContactsCache.map((c, idx) => {
    const selectedEvent = c.calling_purpose || activeEvent;
    return `
      <tr data-index="${idx}">
        <td data-label="S.No">${idx + 1}</td>
        <td data-label="Time">${c.time_stamp ? new Date(c.time_stamp).toLocaleString() : "—"}</td>
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
        <td data-label="GFY/AOMC">
          <select class="inline-edit new-contact-gyc-select" data-index="${idx}">
            ${GYC_STATUS_OPTIONS.map((t) => `<option value="${escapeHtml(t)}" ${t === (c.gyc_status || "") ? "selected" : ""}>${escapeHtml(t) || "—"}</option>`).join("")}
          </select>
        </td>
        <td data-label="Comment">—</td>
        <td data-label="Collected By">—</td>
        <td data-label="Source">Sheets Sync</td>
        <td data-label="User Reviews"><button class="cell-chip" disabled>—</button></td>
        <td data-label="Admin Review"><button class="cell-chip new-contact-review-btn" data-index="${idx}">${c.admin_remarks ? "✎ Edit" : "+ Add"}</button></td>
        <td data-label="" class="no-export">
          <div class="row-actions" style="display:flex;gap:6px;justify-content:flex-end;">
            <button class="btn btn-primary new-contact-add-btn" data-index="${idx}" style="padding:4px 10px;font-size:12px;">Add</button>
            <button class="btn btn-secondary new-contact-del-btn" data-index="${idx}" style="padding:4px 10px;font-size:12px;color:var(--danger);border-color:var(--danger);">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  reapplyColumnOrder("collection-submissions-admin-table");

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

  tbody.querySelectorAll(".new-contact-gyc-select").forEach((select) => {
    select.addEventListener("change", (e) => {
      newContactsCache[Number(e.target.dataset.index)].gyc_status = e.target.value || null;
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
      document.getElementById("contact-info-thead").innerHTML = `<tr><th>S.No</th><th>Session Date</th></tr>`;
      const tbody2 = document.getElementById("contact-info-body");
      tbody2.innerHTML = sessions.length
        ? sessions.map((d, i) => `<tr><td data-label="S.No">${i + 1}</td><td data-label="Session Date">${d}</td></tr>`).join("")
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
              gyc_status: newContact.gyc_status || null,
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
          gyc_status: newContact.gyc_status || null,
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

// This table stacks two independent queues — Contact Collection submissions
// (Supabase `contact_collection`, per-row "+Add" only) and the Sheets-synced
// list (`newContactsCache`, the only thing this button used to touch). Pull
// in both so "Add All" actually clears everything visible in the table.
function normalizeCollectionRowForImport(r) {
  return {
    _source: "collection",
    _id: r.id,
    mob_no: r.mob_no,
    name: r.name,
    pg_name: r.staying || null,
    company_name: r.company_name || null,
    ws: r.ws || r.profession || "NA",
    gender: r.gender || null,
    admin_tag_to_users: r.admin_tag_to_users || null,
    admin_tag: r.admin_tag || null,
    core_cultivation: r.core_cultivation || null,
    calling_purpose: r.calling_purpose || null,
    gyc_status: r.gyc_status || null,
    admin_remarks: r.comment || null,
  };
}

async function removeResolvedSourceContact(item) {
  if (item._source === "collection") {
    await supabase.from("contact_collection").delete().eq("id", item._id);
  } else {
    await deleteContactsFromSheetsCall([item.mob_no]);
  }
}

async function addAllNewContacts() {
  const addAllBtn = document.getElementById("new-contacts-add-all-btn");

  addAllBtn.disabled = true;
  addAllBtn.textContent = "Processing…";

  try {
    const { data: collectionRows, error: collErr } = await supabase
      .from("contact_collection")
      .select("*");
    if (collErr) throw collErr;

    const normalizedSheet = newContactsCache.map((c) => ({ ...c, _source: "sheet" }));
    // Same phone landed in both queues — keep the sheet copy (it carries
    // session history) and drop the collection duplicate.
    const seenMobs = new Set(normalizedSheet.map((c) => c.mob_no));
    const candidates = [
      ...normalizedSheet,
      ...(collectionRows || [])
        .map(normalizeCollectionRowForImport)
        .filter((c) => !seenMobs.has(c.mob_no)),
    ];

    if (!candidates.length) {
      showToast("No new contacts to add.", "warning");
      return;
    }

    const mobNos = candidates.map(c => c.mob_no);

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

    candidates.forEach(c => {
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
        gyc_status: c.gyc_status || null,
        admin_remarks: c.admin_remarks || null
      }));

      const { error: insErr } = await supabase.from("contacts").insert(payload);
      if (insErr) throw insErr;

      const sheetInserts = toInsert.filter((c) => c._source === "sheet");
      const collectionInserts = toInsert.filter((c) => c._source === "collection");

      // Import session history for each Sheets-sourced contact being added
      await Promise.all(sheetInserts.map(c => importSessionsForContact(c)));
      if (sheetInserts.length) {
        await deleteContactsFromSheetsCall(sheetInserts.map(c => c.mob_no));
      }
      if (collectionInserts.length) {
        await supabase.from("contact_collection").delete().in("id", collectionInserts.map(c => c._id));
        await Promise.all(
          collectionInserts
            .filter((c) => c.admin_tag_to_users === "Coordinator")
            .map((c) => syncCoordinatorUser({ name: c.name, mob_no: c.mob_no }, "Coordinator"))
        );
      }

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
      await renderCollectionSubmissions();
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
        await removeResolvedSourceContact(dupItem.newContact);
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
            gyc_status: dupItem.newContact.gyc_status || null,
            admin_remarks: dupItem.newContact.admin_remarks || null
          })
          .eq("mob_no", dupItem.newContact.mob_no);

        if (error) throw error;

        await removeResolvedSourceContact(dupItem.newContact);
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

// Fallback only — used if the list_app_tables() RPC (see schema.sql) isn't
// deployed yet on this Supabase project. Keep in sync with schema.sql when
// adding a table so exports stay complete even before the RPC is run.
const DB_TABLES_FALLBACK = [
  "users",
  "contacts",
  "assignments",
  "assignment_rounds",
  "follow_up_assignments",
  "call_responses",
  "session_attendance",
  "events",
  "settings",
  "help_requests",
  "one_to_one_remarks",
  "contact_collection",
  "book_places",
  "book_inward_stock",
  "book_outward_stock",
  "book_standard_prices",
  "book_requests",
  "book_expenses",
  "fnrg_sadhana",
];

// Supabase caps a single select() response (1000 rows by default), so a
// large table would otherwise export truncated. Page through with .range()
// until a page comes back short.
async function fetchAllRows(table) {
  const pageSize = 1000;
  let from = 0;
  const rows = [];
  while (true) {
    const { data, error } = await supabase.from(table).select("*").range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

// Fire-and-forget ping to the weekly-db-export Edge Function, called once
// per admin page load. The function itself decides whether 7 days have
// actually passed since the last run (via the `settings` table) — this is
// just "did an admin open the app today", not a real cron.
export function maybeRunWeeklyDbExport() {
  fetch(`${SUPABASE_URL}/functions/v1/weekly-db-export`, {
    headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY },
  }).catch((err) => console.warn("weekly-db-export ping failed:", err.message));
}

export async function downloadAllDbData() {
  const btn = document.getElementById("download-all-db-btn");
  btn.disabled = true;
  btn.textContent = "…";
  showToast("Preparing full database export…", "info");

  // list_app_tables() (schema.sql) reads information_schema live, so any
  // table added later shows up here automatically with no code change.
  let DB_TABLES = DB_TABLES_FALLBACK;
  const { data: liveTables, error: liveTablesError } = await supabase.rpc("list_app_tables");
  if (!liveTablesError && Array.isArray(liveTables) && liveTables.length) {
    DB_TABLES = liveTables;
  } else {
    console.warn("list_app_tables() unavailable, using fallback table list:", liveTablesError?.message);
  }

  try {
    const allData = {};
    for (const table of DB_TABLES) {
      try {
        allData[table] = await fetchAllRows(table);
      } catch (error) {
        console.warn(`Could not fetch ${table}:`, error.message);
        allData[table] = [];
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

  const [{ data: inwardRows }, { data: outwardRows }] = await Promise.all([
    supabase.from("book_inward_stock").select("name"),
    supabase.from("book_outward_stock").select("name,sold_area,sold_by"),
  ]);
  document.getElementById("bulk-delete-book-inward-name").innerHTML = distinctSelectOptions(inwardRows, "name");
  document.getElementById("bulk-delete-book-outward-name").innerHTML = distinctSelectOptions(outwardRows, "name");
  document.getElementById("bulk-delete-book-outward-area").innerHTML = distinctSelectOptions(outwardRows, "sold_area");
  document.getElementById("bulk-delete-book-outward-sold-by").innerHTML = distinctSelectOptions(outwardRows, "sold_by");
}

// "— select —" + one option per distinct non-empty value of `field` across `rows`.
function distinctSelectOptions(rows, field) {
  const values = Array.from(new Set((rows || []).map((r) => r[field]).filter(Boolean))).sort();
  return `<option value="">— select —</option>` + values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
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

  if (type === "book_places") {
    return { table: "book_places", apply: (q) => q.neq("id", BULK_DELETE_ALL_UUID), label: "ALL Distribution Places" };
  }

  if (type === "book_inward") {
    const scope = document.getElementById("bulk-delete-book-inward-scope").value;
    if (scope === "name") {
      const val = document.getElementById("bulk-delete-book-inward-name").value;
      if (!val) return { error: "Please select a book name." };
      return { table: "book_inward_stock", apply: (q) => q.eq("name", val), label: `Inward Stock for "${val}"` };
    }
    return { table: "book_inward_stock", apply: (q) => q.neq("id", BULK_DELETE_ALL_UUID), label: "ALL Inward Stock records" };
  }

  if (type === "book_outward") {
    const scope = document.getElementById("bulk-delete-book-outward-scope").value;
    if (scope === "name") {
      const val = document.getElementById("bulk-delete-book-outward-name").value;
      if (!val) return { error: "Please select a book name." };
      return { table: "book_outward_stock", apply: (q) => q.eq("name", val), label: `Outward Stock for "${val}"` };
    }
    if (scope === "area") {
      const val = document.getElementById("bulk-delete-book-outward-area").value;
      if (!val) return { error: "Please select a sold area." };
      return { table: "book_outward_stock", apply: (q) => q.eq("sold_area", val), label: `Outward Stock sold at "${val}"` };
    }
    if (scope === "sold_by") {
      const val = document.getElementById("bulk-delete-book-outward-sold-by").value;
      if (!val) return { error: "Please select who sold it." };
      return { table: "book_outward_stock", apply: (q) => q.eq("sold_by", val), label: `Outward Stock sold by "${val}"` };
    }
    return { table: "book_outward_stock", apply: (q) => q.neq("id", BULK_DELETE_ALL_UUID), label: "ALL Outward Stock records" };
  }

  if (type === "fnrg_sadhana") {
    return { table: "fnrg_sadhana", apply: (q) => q.neq("id", BULK_DELETE_ALL_UUID), label: "ALL FNRG Sadhana records" };
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
    ["bulk-delete-book-inward-scope", "bulk-delete-filter-book_inward"],
    ["bulk-delete-book-outward-scope", "bulk-delete-filter-book_outward"],
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
    "bulk-delete-book-inward-name",
    "bulk-delete-book-outward-name", "bulk-delete-book-outward-area", "bulk-delete-book-outward-sold-by",
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

    // Looked up by user_name (like login), not the cached session id — an id
    // saved in an old session before the users table was ever reseeded would
    // find no row and always report "Incorrect password" for a genuinely
    // correct one, so a stale id is called out separately from a real mismatch.
    const { data: userRow } = await supabase.from("users").select("login_pw").ilike("user_name", bulkDeleteUser.user_name).maybeSingle();

    if (!userRow) {
      btn.disabled = false;
      btn.textContent = "Permanently Delete";
      errorEl.textContent = "Your session looks out of date — please log out and log back in, then try again.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (userRow.login_pw !== pw) {
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
  if (cfg.table === "book_places" || cfg.table === "book_inward_stock" || cfg.table === "book_outward_stock") {
    const BookDistribution = await import("./bookDistribution.js");
    if (cfg.table === "book_places" && !document.getElementById("book-places-section").classList.contains("hidden")) BookDistribution.initPlaces();
    if (cfg.table === "book_inward_stock" && !document.getElementById("book-inward-section").classList.contains("hidden")) BookDistribution.initInwardTable(bulkDeleteUser);
    if (cfg.table === "book_outward_stock" && !document.getElementById("book-outward-section").classList.contains("hidden")) BookDistribution.initOutwardTable();
    if (!document.getElementById("book-dashboard-section").classList.contains("hidden")) BookDistribution.initDashboard();
  }
  if (cfg.table === "fnrg_sadhana" && !document.getElementById("admin-sadhana-section").classList.contains("hidden")) {
    const Sadhana = await import("./sadhana.js");
    Sadhana.initSadhana(bulkDeleteUser);
  }
  return true;
}
