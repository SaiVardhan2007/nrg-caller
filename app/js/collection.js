import { supabase } from "./supabaseClient.js";
import { formatPhone, debounce, showToast, timeHM, escapeHtml } from "./utils.js";

let currentUser = null;
let wired = false;
let duplicateContact = null;

export async function init(user) {
  currentUser = user;
  await renderTodayList();
  if (wired) return;
  wired = true;

  const phoneInput = document.getElementById("collection-phone");
  const dupEl = document.getElementById("collection-duplicate");

  const checkDuplicate = debounce(async (digits) => {
    const { data } = await supabase.from("contacts").select("name,sessions_count").eq("mob_no", digits).maybeSingle();
    if (data) {
      duplicateContact = data;
      dupEl.textContent = `Already exists: ${data.name} (${data.sessions_count} sessions attended). You can still save collection notes below.`;
      dupEl.classList.remove("hidden");
    } else {
      duplicateContact = null;
      dupEl.classList.add("hidden");
    }
  }, 500);

  phoneInput.addEventListener("input", (e) => {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
    e.target.value = digits;
    dupEl.classList.add("hidden");
    if (digits.length === 10) checkDuplicate(digits);
  });

  const form = document.getElementById("collection-form");
  let saving = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (saving) return;

    const phone = phoneInput.value.trim();
    const name = document.getElementById("collection-name").value.trim();
    if (!/^[0-9]{10}$/.test(phone) || !name) {
      showToast("Please enter a valid Name and 10-digit Phone Number.", "error");
      return;
    }

    saving = true;
    const submitBtn = document.getElementById("collection-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";

    const { error } = await supabase.from("contact_collection").insert({
      mob_no: phone,
      name,
      pg_name: document.getElementById("collection-pg").value.trim() || null,
      profession: document.getElementById("collection-profession").value.trim() || null,
      company_name: document.getElementById("collection-company").value.trim() || null,
      remarks: document.getElementById("collection-remarks").value.trim() || null,
      collected_by: currentUser.user_name,
    });

    saving = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "Save Contact";

    if (error) {
      showToast("Could not save. Try again.", "error");
      return;
    }
    showToast("Contact collected 🙏", "success");
    form.reset();
    dupEl.classList.add("hidden");
    renderTodayList();
  });
}

async function renderTodayList() {
  const listEl = document.getElementById("collection-list");
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("contact_collection")
    .select("name,mob_no,ts,remarks")
    .eq("collected_by", currentUser.user_name)
    .gte("ts", startOfDay.toISOString())
    .order("ts", { ascending: false });

  if (error || !data || !data.length) {
    listEl.innerHTML = `<p class="loading-row">No contacts collected today.</p>`;
    return;
  }

  listEl.innerHTML = data.map((r) => `
    <div class="collection-card">
      <div class="collection-card-name">${escapeHtml(r.name)}</div>
      <div class="collection-card-phone">${formatPhone(r.mob_no)} · ${timeHM(r.ts)}</div>
      ${r.remarks ? `<div class="collection-card-remarks">${escapeHtml(r.remarks)}</div>` : ""}
    </div>
  `).join("");
}
