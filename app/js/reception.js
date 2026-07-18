import { supabase } from "./supabaseClient.js";
import { formatPhone, debounce, showToast, timeHM, escapeHtml } from "./utils.js";

let currentUser = null;
let foundContact = null;
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

    loader.classList.add("hidden");
    if (error || !data) {
      foundContact = null;
      notFoundEl.classList.remove("hidden");
      return;
    }
    foundContact = data;
    document.getElementById("reception-name").textContent = data.name;
    document.getElementById("reception-phone").textContent = formatPhone(data.mob_no);
    document.getElementById("reception-sessions").textContent = `Sessions attended: ${data.sessions_count}`;
    resultEl.classList.remove("hidden");
  }, 1500);

  searchInput.addEventListener("input", (e) => {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
    e.target.value = digits;
    resultEl.classList.add("hidden");
    notFoundEl.classList.add("hidden");
    foundContact = null;
    if (digits.length === 10) doSearch(digits);
  });

  let marking = false;
  document.getElementById("mark-attendance-btn").addEventListener("click", async () => {
    if (marking || !foundContact) return;
    marking = true;
    const btn = document.getElementById("mark-attendance-btn");
    btn.disabled = true;
    btn.textContent = "Marking…";

    const sessionName = document.getElementById("reception-session-name").value.trim() || "General Session";
    const { error } = await supabase.from("session_attendance").insert({
      mob_no: foundContact.mob_no,
      name: foundContact.name,
      took_by: currentUser.user_name,
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
    showToast("Use Contact Collection to register a brand-new person.", "warning");
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
