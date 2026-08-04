import { supabase } from "./supabaseClient.js";
import { formatPhone, debounce, showToast, timeHM, escapeHtml, normalizePhoneInput, ADMIN_TAG_TO_USERS_OPTIONS, syncCoordinatorUser } from "./utils.js";

// Profile fields used to compute each contact's "% completion" for the
// Today's Attendance default sort — deliberately excludes name/phone
// (always present) and computed/admin-only fields (sessions, calls, remarks).
const PROFILE_COMPLETION_FIELDS = ["pg_name", "ws", "gender", "company_name", "calling_purpose", "core_cultivation", "admin_tag_to_users", "admin_tag", "gyc_status"];

function completionPercent(contact) {
  if (!contact) return 0;
  const filled = PROFILE_COMPLETION_FIELDS.filter((f) => contact[f] !== null && contact[f] !== undefined && contact[f] !== "").length;
  return Math.round((filled / PROFILE_COMPLETION_FIELDS.length) * 100);
}

let currentUser = null;
let foundContact = null;
let searchedDigits = null;
let contactAlreadyMarked = false;
let wired = false;

export async function init(user) {
  currentUser = user;
  renderTodayList();

  const [{ data: events }, { data: eventSetting }] = await Promise.all([
    supabase.from("events").select("code,name").order("code"),
    supabase.from("settings").select("value").eq("key", "current_event").single(),
  ]);
  const sessionSelect = document.getElementById("reception-session-name");
  sessionSelect.innerHTML = (events || []).map((e) => `<option value="${e.code}">${e.code}</option>`).join("");
  if (eventSetting?.value) sessionSelect.value = eventSetting.value;

  const newEventSelect = document.getElementById("reception-new-event");
  newEventSelect.innerHTML = (events || []).map((e) => `<option value="${e.code}">${e.code}</option>`).join("");
  if (eventSetting?.value) newEventSelect.value = eventSetting.value;

  const sortSelect = document.getElementById("reception-attendance-sort");
  sortSelect.addEventListener("change", renderTodayList);

  if (wired) return;
  wired = true;

  const searchInput = document.getElementById("reception-search");
  const loader = document.getElementById("reception-loader");
  const resultEl = document.getElementById("reception-result");
  const notFoundEl = document.getElementById("reception-not-found");
  const nameInput = document.getElementById("reception-edit-name");
  const pgInput = document.getElementById("reception-edit-pg");
  const wsSelect = document.getElementById("reception-edit-ws");
  const companyInput = document.getElementById("reception-edit-company");
  const gycStatusSelect = document.getElementById("reception-edit-gyc-status");

  // required fields shown while marking attendance — until every one of these
  // is filled in, we can't be sure who this actually is, so gate the button
  // rather than let attendance get marked against a half-blank record.
  function missingFieldMessage() {
    if (!nameInput.value.trim()) return "Please add a name before marking attendance.";
    if (!wsSelect.value) return "Please select a profession before marking attendance.";
    if (!pgInput.value.trim()) return "Please add a PG / flat name before marking attendance.";
    return null;
  }

  function updateMarkButtonGating() {
    const btn = document.getElementById("mark-attendance-btn");
    const errorEl = document.getElementById("reception-missing-error");
    if (contactAlreadyMarked) {
      btn.disabled = true;
      btn.textContent = "✓ Already Marked";
      btn.style.opacity = "0.6";
      btn.style.cursor = "not-allowed";
      errorEl.classList.add("hidden");
      return;
    }
    const missing = missingFieldMessage();
    btn.style.opacity = "";
    btn.style.cursor = "";
    if (missing) {
      btn.disabled = true;
      btn.textContent = "🙏 Mark Attendance";
      errorEl.textContent = missing;
      errorEl.classList.remove("hidden");
    } else {
      btn.disabled = false;
      btn.textContent = "🙏 Mark Attendance";
      errorEl.classList.add("hidden");
    }
  }

  async function saveField(field, value) {
    if (!foundContact) return;
    foundContact[field] = value;
    await supabase.from("contacts").update({ [field]: value || null }).eq("id", foundContact.id);
    updateMarkButtonGating();
  }
  nameInput.addEventListener("change", (e) => saveField("name", e.target.value.trim()));
  pgInput.addEventListener("change", (e) => saveField("pg_name", e.target.value.trim()));
  companyInput.addEventListener("change", (e) => saveField("company_name", e.target.value.trim()));
  wsSelect.addEventListener("change", (e) => saveField("ws", e.target.value));
  gycStatusSelect.addEventListener("change", (e) => saveField("gyc_status", e.target.value));

  const doSearch = debounce(async (digits) => {
    loader.classList.remove("hidden");
    resultEl.classList.add("hidden");
    notFoundEl.classList.add("hidden");

    const { data, error } = await supabase
      .from("contacts")
      .select("id,name,mob_no,pg_name,company_name,ws,gyc_status,sessions_count")
      .eq("mob_no", digits)
      .maybeSingle();

    if (error || !data) {
      loader.classList.add("hidden");
      foundContact = null;
      searchedDigits = digits;
      notFoundEl.classList.remove("hidden");
      return;
    }

    // Check if attendance was marked in the last 8 hours
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    const { data: recentAtt, error: attError } = await supabase
      .from("session_attendance")
      .select("id")
      .eq("mob_no", data.mob_no)
      .gte("ts", eightHoursAgo)
      .limit(1);

    contactAlreadyMarked = recentAtt && recentAtt.length > 0;

    loader.classList.add("hidden");
    foundContact = data;
    document.getElementById("reception-phone").textContent = formatPhone(data.mob_no);
    document.getElementById("reception-sessions").textContent = `Sessions attended: ${data.sessions_count}`;
    nameInput.value = data.name || "";
    pgInput.value = data.pg_name || "";
    companyInput.value = data.company_name || "";
    wsSelect.value = data.ws || "";
    gycStatusSelect.value = data.gyc_status || "";

    updateMarkButtonGating();
    resultEl.classList.remove("hidden");
  }, 1500);

  const newContactForm = document.getElementById("reception-new-contact-form");
  const newContactError = document.getElementById("reception-new-error");
  const newSubmitBtn = document.getElementById("reception-new-submit");

  // mirrors missingFieldMessage() above for the found-contact flow — the
  // submit button stays disabled (and CSS-dimmed via .btn:disabled) until
  // these are filled, instead of always looking clickable while typing.
  function newContactMissingFieldMessage() {
    if (!document.getElementById("reception-new-name").value.trim()) return "name";
    if (!document.getElementById("reception-new-ws").value) return "profession";
    if (!document.getElementById("reception-new-pg").value.trim()) return "pg";
    return null;
  }
  function updateNewSubmitGating() {
    newSubmitBtn.disabled = !!newContactMissingFieldMessage();
  }
  ["reception-new-name", "reception-new-pg"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateNewSubmitGating);
  });
  document.getElementById("reception-new-ws").addEventListener("change", updateNewSubmitGating);
  updateNewSubmitGating();

  searchInput.addEventListener("input", (e) => {
    const digits = normalizePhoneInput(e.target.value);
    e.target.value = digits;
    resultEl.classList.add("hidden");
    notFoundEl.classList.add("hidden");
    newContactForm.classList.add("hidden");
    newContactForm.reset();
    updateNewSubmitGating();
    newContactError.classList.add("hidden");
    document.getElementById("reception-missing-error").classList.add("hidden");
    foundContact = null;
    searchedDigits = null;
    contactAlreadyMarked = false;
    if (digits.length === 10) doSearch(digits);
  });

  let marking = false;
  document.getElementById("mark-attendance-btn").addEventListener("click", async () => {
    if (marking || !foundContact) return;
    const missing = missingFieldMessage();
    if (missing) {
      showToast(missing, "error");
      return;
    }
    marking = true;
    const btn = document.getElementById("mark-attendance-btn");
    btn.disabled = true;
    btn.textContent = "Marking…";

    // Double check 8-hour window right before insert to prevent duplicate marking
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    const { data: recentAtt } = await supabase
      .from("session_attendance")
      .select("id")
      .eq("mob_no", foundContact.mob_no)
      .gte("ts", eightHoursAgo)
      .limit(1);

    if (recentAtt && recentAtt.length > 0) {
      showToast("Attendance already marked in the last 8 hours.", "warning");
      contactAlreadyMarked = true;
      btn.disabled = true;
      btn.textContent = "✓ Already Marked";
      btn.style.opacity = "0.6";
      btn.style.cursor = "not-allowed";
      marking = false;
      return;
    }

    const eventCode = document.getElementById("reception-session-name").value.trim();
    const { error } = await supabase.from("session_attendance").insert({
      mob_no: foundContact.mob_no,
      name: foundContact.name,
      took_by: currentUser.user_name,
      event_code: eventCode || null,
    });

    marking = false;

    if (error) {
      showToast("Could not mark attendance. Try again.", "error");
      btn.disabled = false;
      btn.textContent = "🙏 Mark Attendance";
      return;
    }

    showToast(`Attendance marked for ${foundContact.name} 🙏`, "success");
    contactAlreadyMarked = true;
    btn.textContent = "✓ Already Marked";
    btn.style.opacity = "0.6";
    btn.style.cursor = "not-allowed";

    renderTodayList();

    foundContact.sessions_count++;
    document.getElementById("reception-sessions").textContent = `Sessions attended: ${foundContact.sessions_count}`;
  });

  document.getElementById("reception-add-person-btn").addEventListener("click", () => {
    newContactForm.classList.remove("hidden");
    updateNewSubmitGating();
    document.getElementById("reception-new-name").focus();
  });

  let saving = false;
  newContactForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (saving || !searchedDigits) return;

    const name = document.getElementById("reception-new-name").value.trim();
    if (!name) {
      newContactError.textContent = "Please enter a name.";
      newContactError.classList.remove("hidden");
      return;
    }
    newContactError.classList.add("hidden");

    saving = true;
    const submitBtn = document.getElementById("reception-new-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";

    // New contacts are never written straight to Master Contact any more: they
    // queue on the admin's New Contacts page for manual promotion. Attendance
    // is still marked right away, since session_attendance keys off the phone
    // number and does not need a contacts row to exist yet.
    const { data: dupContact } = await supabase.from("contacts").select("id").eq("mob_no", searchedDigits).maybeSingle();
    const { data: dupQueued } = await supabase.from("contact_collection").select("id").eq("mob_no", searchedDigits).maybeSingle();
    if (dupContact || dupQueued) {
      saving = false;
      updateNewSubmitGating();
      submitBtn.textContent = "Save & Mark Attendance";
      newContactError.textContent = dupContact
        ? "This phone number is already registered."
        : "This number is already waiting for admin approval on the New Contacts page.";
      newContactError.classList.remove("hidden");
      return;
    }

    const eventCode = document.getElementById("reception-new-event").value.trim();
    const { error: insertErr } = await supabase
      .from("contact_collection")
      .insert({
        mob_no: searchedDigits,
        name,
        staying: document.getElementById("reception-new-pg").value.trim() || null,
        company_name: document.getElementById("reception-new-company").value.trim() || null,
        ws: document.getElementById("reception-new-ws").value,
        gender: document.getElementById("reception-new-gender").value || null,
        calling_purpose: eventCode || null,
        gyc_status: document.getElementById("reception-new-gyc-status").value || null,
        collected_by: currentUser.user_name,
        source: "Reception",
      });

    if (insertErr) {
      saving = false;
      updateNewSubmitGating();
      submitBtn.textContent = "Save & Mark Attendance";
      newContactError.textContent = "Could not save. Try again.";
      newContactError.classList.remove("hidden");
      return;
    }

    const { error: attendErr } = await supabase.from("session_attendance").insert({
      mob_no: searchedDigits,
      name,
      took_by: currentUser.user_name,
      event_code: eventCode || null,
    });

    saving = false;
    submitBtn.textContent = "Save & Mark Attendance";

    if (attendErr) {
      showToast("Sent to admin for approval, but attendance could not be marked. Try marking it again.", "warning");
    } else {
      showToast(`${name}: attendance marked, sent to admin for approval 🙏`, "success");
      renderTodayList();
    }

    notFoundEl.classList.add("hidden");
    newContactForm.classList.add("hidden");
    newContactForm.reset();
    updateNewSubmitGating();
    searchInput.value = "";
    foundContact = null;
    searchedDigits = null;
  });
}

// "Today" is always IST midnight, not the device's local midnight — reception
// tablets/PCs have shown up with the wrong system timezone (or even the wrong
// clock), which silently pulled in the previous evening's markings.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function startOfTodayIST() {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - IST_OFFSET_MS);
}

async function loadTodayAttendance() {
  const { data, error } = await supabase
    .from("session_attendance")
    .select("mob_no,name,ts,event_code")
    .gte("ts", startOfTodayIST().toISOString())
    .order("ts", { ascending: false });
  if (error) return [];
  const rows = data || [];

  const mobNos = [...new Set(rows.map((r) => r.mob_no))];
  const contactsByMob = new Map();
  if (mobNos.length) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("mob_no,pg_name,ws,gender,company_name,calling_purpose,core_cultivation,admin_tag_to_users,admin_tag,gyc_status,name,sessions_count,calls_count")
      .in("mob_no", mobNos);
    (contacts || []).forEach((c) => contactsByMob.set(c.mob_no, c));
  }
  rows.forEach((r) => { r.contact = contactsByMob.get(r.mob_no) || null; });
  return rows;
}

async function renderTodayList() {
  const tbody = document.getElementById("reception-attendance-body");
  const list = await loadTodayAttendance();
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading-row">No attendance marked today.</td></tr>`;
    return;
  }
  // "Name"/"Phone" both group repeat markings for the same person (by mob_no,
  // the actual identity key — not the name text, which can vary between
  // markings) together, just ordering the groups differently; "Time" keeps
  // the natural latest-first order; "Completion" is the default — most
  // incomplete profiles surface first so reception can flag them.
  const sortMode = document.getElementById("reception-attendance-sort")?.value || "completion";
  let sorted;
  if (sortMode === "name" || sortMode === "phone") {
    const groups = new Map();
    for (const r of list) {
      if (!groups.has(r.mob_no)) groups.set(r.mob_no, []);
      groups.get(r.mob_no).push(r);
    }
    const groupArr = [...groups.values()];
    if (sortMode === "name") {
      groupArr.sort((a, b) => (a[0].name || "").localeCompare(b[0].name || ""));
    } else {
      groupArr.sort((a, b) => (a[0].mob_no || "").localeCompare(b[0].mob_no || ""));
    }
    sorted = groupArr.flat();
  } else if (sortMode === "completion") {
    sorted = [...list].sort((a, b) => completionPercent(b.contact) - completionPercent(a.contact));
  } else {
    sorted = list;
  }
  tbody.innerHTML = sorted.map((r) => `
    <tr>
      <td data-label="Name">${escapeHtml(r.name || "")}</td>
      <td data-label="Phone" class="phone-cell">${formatPhone(r.mob_no)}</td>
      <td data-label="Time">${timeHM(r.ts)}</td>
      <td data-label="Session">${escapeHtml(r.event_code || "")}</td>
      <td data-label="Admin Tag to Users">
        <select class="inline-edit attendance-admin-tag" data-mob="${r.mob_no}" data-name="${escapeHtml(r.name || "")}">
          ${ADMIN_TAG_TO_USERS_OPTIONS.map((t) => `<option value="${t}" ${t === (r.contact?.admin_tag_to_users || "") ? "selected" : ""}>${t || "—"}</option>`).join("")}
        </select>
      </td>
      <td data-label="Sessions">${r.contact?.sessions_count ?? 0}</td>
      <td data-label="Calls">${r.contact?.calls_count ?? 0}</td>
    </tr>
  `).join("");

  tbody.querySelectorAll(".attendance-admin-tag").forEach((select) => {
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
      const row = list.find((r) => r.mob_no === mob);
      if (row?.contact) row.contact.admin_tag_to_users = value;
      showToast("Admin tag updated", "success");
    });
  });
}
