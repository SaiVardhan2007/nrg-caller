import { supabase } from "./supabaseClient.js";
import { showToast, formatPhone, escapeHtml, normalizePhoneInput, enableWordAutocorrect } from "./utils.js";

let wired = false;

export async function init(currentUser) {
  await renderSubmissions(currentUser.user_name);
  if (wired) return;
  wired = true;

  const nameInput = document.getElementById("collection-name");
  const phoneInput = document.getElementById("collection-phone");
  const professionSelect = document.getElementById("collection-profession");
  const genderSelect = document.getElementById("collection-gender");
  const stayingInput = document.getElementById("collection-staying");
  const commentInput = document.getElementById("collection-comment");
  enableWordAutocorrect(commentInput);
  const errorEl = document.getElementById("collection-error");
  const submitBtn = document.getElementById("collection-submit");

  phoneInput.addEventListener("input", (e) => {
    e.target.value = normalizePhoneInput(e.target.value);
  });

  submitBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const phone = normalizePhoneInput(phoneInput.value);
    const profession = professionSelect.value;
    const gender = genderSelect.value;
    const staying = stayingInput.value.trim();
    const comment = commentInput.value.trim();

    if (!name || !/^[0-9]{10}$/.test(phone) || !profession || !gender) {
      errorEl.textContent = "Please fill Name, a valid 10-digit Phone, Profession, and Gender.";
      errorEl.classList.remove("hidden");
      return;
    }
    errorEl.classList.add("hidden");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";

    const { error } = await supabase.from("contact_collection").insert({
      name,
      mob_no: phone,
      profession,
      gender,
      staying: staying || null,
      comment: comment || null,
      collected_by: currentUser.user_name,
    });

    submitBtn.disabled = false;
    submitBtn.textContent = "Submit";

    if (error) {
      errorEl.textContent = "Failed: " + error.message;
      errorEl.classList.remove("hidden");
      return;
    }

    nameInput.value = "";
    phoneInput.value = "";
    professionSelect.value = "";
    genderSelect.value = "";
    stayingInput.value = "";
    commentInput.value = "";
    showToast("Contact submitted 🙏", "success");
    renderSubmissions(currentUser.user_name);
  });
}

async function renderSubmissions(userName) {
  const tbody = document.getElementById("collection-submissions-body");
  tbody.innerHTML = `<tr><td colspan="7" class="loading-row">Loading…</td></tr>`;

  const { data } = await supabase
    .from("contact_collection")
    .select("name,mob_no,profession,gender,staying,comment,created_at")
    .eq("collected_by", userName)
    .order("created_at", { ascending: false });

  tbody.innerHTML = (data && data.length)
    ? data.map((r) => `
        <tr>
          <td data-label="Time">${new Date(r.created_at).toLocaleString()}</td>
          <td data-label="Name">${escapeHtml(r.name)}</td>
          <td data-label="Phone" class="phone-cell">${formatPhone(r.mob_no)}</td>
          <td data-label="Profession">${escapeHtml(r.profession)}</td>
          <td data-label="Gender">${escapeHtml(r.gender)}</td>
          <td data-label="Staying">${escapeHtml(r.staying || "—")}</td>
          <td data-label="Comment">${escapeHtml(r.comment || "—")}</td>
        </tr>`).join("")
    : `<tr><td colspan="7" class="loading-row">You haven't submitted any contacts yet.</td></tr>`;
}
