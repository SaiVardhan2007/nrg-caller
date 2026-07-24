import { supabase } from "./supabaseClient.js";
import { formatPhone, debounce, showToast, timeHM, escapeHtml } from "./utils.js";

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
  wsSelect.addEventListener("change", (e) => saveField("ws", e.target.value));

  const doSearch = debounce(async (digits) => {
    loader.classList.remove("hidden");
    resultEl.classList.add("hidden");
    notFoundEl.classList.add("hidden");

    const { data, error } = await supabase
      .from("contacts")
      .select("id,name,mob_no,pg_name,ws,sessions_count")
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
    wsSelect.value = data.ws || "";

    updateMarkButtonGating();
    resultEl.classList.remove("hidden");
  }, 1500);

  const newContactForm = document.getElementById("reception-new-contact-form");
  const newContactError = document.getElementById("reception-new-error");

  searchInput.addEventListener("input", (e) => {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
    e.target.value = digits;
    resultEl.classList.add("hidden");
    notFoundEl.classList.add("hidden");
    newContactForm.classList.add("hidden");
    newContactForm.reset();
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

    const { data: newContact, error: insertErr } = await supabase
      .from("contacts")
      .insert({
        mob_no: searchedDigits,
        name,
        pg_name: document.getElementById("reception-new-pg").value.trim() || null,
        company_name: document.getElementById("reception-new-company").value.trim() || null,
        ws: document.getElementById("reception-new-ws").value,
        gender: document.getElementById("reception-new-gender").value || null,
        calling_purpose: document.getElementById("reception-new-event").value || null,
      })
      .select("id,name,mob_no,sessions_count")
      .single();

    if (insertErr) {
      saving = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Save & Mark Attendance";
      newContactError.textContent = insertErr.message.includes("duplicate")
        ? "This phone number is already registered."
        : "Could not save. Try again.";
      newContactError.classList.remove("hidden");
      return;
    }

    const eventCode = document.getElementById("reception-new-event").value.trim();
    const { error: attendErr } = await supabase.from("session_attendance").insert({
      mob_no: newContact.mob_no,
      name: newContact.name,
      took_by: currentUser.user_name,
      event_code: eventCode || null,
    });

    saving = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "Save & Mark Attendance";

    if (attendErr) {
      showToast("Contact registered, but attendance could not be marked. Try marking it again.", "warning");
    } else {
      showToast(`${newContact.name} registered and attendance marked 🙏`, "success");
      renderTodayList();
    }

    notFoundEl.classList.add("hidden");
    newContactForm.classList.add("hidden");
    newContactForm.reset();
    searchInput.value = "";
    foundContact = null;
    searchedDigits = null;
  });
}

async function loadTodayAttendance() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("session_attendance")
    .select("mob_no,name,ts,event_code")
    .gte("ts", startOfDay.toISOString())
    .order("ts", { ascending: false });
  return error ? [] : (data || []);
}

async function renderTodayList() {
  const tbody = document.getElementById("reception-attendance-body");
  const list = await loadTodayAttendance();
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-row">No attendance marked today.</td></tr>`;
    return;
  }
  // "Name" groups repeat markings for the same person (by mob_no, the actual
  // identity key — not the name text, which can vary between markings)
  // together; "Time" keeps the natural latest-first order.
  const sortMode = document.getElementById("reception-attendance-sort")?.value || "name";
  let sorted;
  if (sortMode === "name") {
    const groups = new Map();
    for (const r of list) {
      if (!groups.has(r.mob_no)) groups.set(r.mob_no, []);
      groups.get(r.mob_no).push(r);
    }
    sorted = [...groups.values()]
      .sort((a, b) => (a[0].name || "").localeCompare(b[0].name || ""))
      .flat();
  } else {
    sorted = list;
  }
  tbody.innerHTML = sorted.map((r) => `
    <tr>
      <td data-label="Name">${escapeHtml(r.name || "")}</td>
      <td data-label="Phone" class="phone-cell">${formatPhone(r.mob_no)}</td>
      <td data-label="Time">${timeHM(r.ts)}</td>
      <td data-label="Session">${escapeHtml(r.event_code || "")}</td>
    </tr>
  `).join("");
}
