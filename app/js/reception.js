import { supabase } from "./supabaseClient.js";
import { formatPhone, debounce, showToast, timeHM, escapeHtml } from "./utils.js";

let currentUser = null;
let foundContact = null;
let searchedDigits = null;
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

  if (wired) return;
  wired = true;

  const searchInput = document.getElementById("reception-search");
  const loader = document.getElementById("reception-loader");
  const resultEl = document.getElementById("reception-result");
  const notFoundEl = document.getElementById("reception-not-found");

  const doSearch = debounce(async (digits) => {
    loader.classList.remove("hidden");
    resultEl.classList.add("hidden");
    notFoundEl.classList.add("hidden");

    const { data, error } = await supabase
      .from("contacts")
      .select("id,name,mob_no,sessions_count")
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

    const alreadyMarked = recentAtt && recentAtt.length > 0;

    loader.classList.add("hidden");
    foundContact = data;
    document.getElementById("reception-name").textContent = data.name;
    document.getElementById("reception-phone").textContent = formatPhone(data.mob_no);
    document.getElementById("reception-sessions").textContent = `Sessions attended: ${data.sessions_count}`;

    const btn = document.getElementById("mark-attendance-btn");
    if (alreadyMarked) {
      btn.disabled = true;
      btn.textContent = "✓ Already Marked";
      btn.style.opacity = "0.6";
      btn.style.cursor = "not-allowed";
    } else {
      btn.disabled = false;
      btn.textContent = "🙏 Mark Attendance";
      btn.style.opacity = "";
      btn.style.cursor = "";
    }

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
    foundContact = null;
    searchedDigits = null;
    if (digits.length === 10) doSearch(digits);
  });

  let marking = false;
  document.getElementById("mark-attendance-btn").addEventListener("click", async () => {
    if (marking || !foundContact) return;
    marking = true;
    const btn = document.getElementById("mark-attendance-btn");
    btn.disabled = true;
    btn.textContent = "Marking…";

    const eventCode = document.getElementById("reception-session-name").value.trim();
    const sessionName = eventCode || "General Session";
    const { error } = await supabase.from("session_attendance").insert({
      mob_no: foundContact.mob_no,
      name: foundContact.name,
      took_by: currentUser.user_name,
      event_code: eventCode || null,
    });

    marking = false;
    btn.disabled = false;
    btn.textContent = "🙏 Mark Attendance";

    if (error) {
      showToast("Could not mark attendance. Try again.", "error");
      return;
    }
    showToast(`Attendance marked for ${foundContact.name} 🙏`, "success");
    addToTodayList({ name: foundContact.name, mob_no: foundContact.mob_no, ts: new Date().toISOString(), session: sessionName });

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
    const sessionName = eventCode || "General Session";
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
      addToTodayList({ name: newContact.name, mob_no: newContact.mob_no, ts: new Date().toISOString(), session: sessionName });
    }

    notFoundEl.classList.add("hidden");
    newContactForm.classList.add("hidden");
    newContactForm.reset();
    searchInput.value = "";
    foundContact = null;
    searchedDigits = null;
  });
}

function todayKey() {
  const d = new Date();
  return `reception_marked_${d.toISOString().slice(0, 10)}`;
}

function getTodayList() {
  try {
    return JSON.parse(localStorage.getItem(todayKey()) || "[]");
  } catch {
    return [];
  }
}

function addToTodayList(entry) {
  const list = getTodayList();
  list.unshift(entry);
  localStorage.setItem(todayKey(), JSON.stringify(list));
  renderTodayList();
}

function renderTodayList() {
  const tbody = document.getElementById("reception-attendance-body");
  const list = getTodayList();
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-row">No attendance marked today.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((r) => `
    <tr>
      <td data-label="Name">${escapeHtml(r.name)}</td>
      <td data-label="Phone" class="phone-cell">${formatPhone(r.mob_no)}</td>
      <td data-label="Time">${timeHM(r.ts)}</td>
      <td data-label="Session">${escapeHtml(r.session)}</td>
    </tr>
  `).join("");
}
