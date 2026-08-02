import { supabase } from "./supabaseClient.js";
import { showToast, formatPhone, escapeHtml, normalizePhoneInput } from "./utils.js";
import { setSession } from "./auth.js";

/* ======================= ADMIN: One to One ======================= */

let adminName = "";
let remarksContext = null; // { mob, name }

export async function initAdminOneToOne(currentUser) {
  adminName = currentUser?.user_name || "";
  wireOneToOneSearch();
  wireHelpRequestsModal();
  wireRemarksModal();
  await renderOneToOneTable();
}

async function renderOneToOneTable() {
  const tbody = document.getElementById("one-to-one-table-body");
  tbody.innerHTML = `<tr><td colspan="7" class="loading-row">Loading…</td></tr>`;

  const [{ data: members, error }, { data: allHelpMobs }] = await Promise.all([
    supabase
      .from("contacts")
      .select("id,s_no,name,mob_no,ws")
      .eq("one_to_one_status", true)
      .order("s_no", { ascending: true, nullsFirst: false }),
    supabase.from("help_requests").select("mob_no"),
  ]);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading-row">Could not load One to One list.</td></tr>`;
    return;
  }

  // Anyone who asked for a slot (help_requests) but isn't an official member
  // yet shows up too, as a pending request — admin can Add them straight
  // from here, with their requested text already sitting in Help Asked.
  const memberMobs = new Set((members || []).map((c) => c.mob_no));
  const pendingMobs = [...new Set((allHelpMobs || []).map((r) => r.mob_no))].filter((m) => !memberMobs.has(m));
  let pendingContacts = [];
  if (pendingMobs.length) {
    const { data } = await supabase.from("contacts").select("id,s_no,name,mob_no,ws").in("mob_no", pendingMobs).order("name");
    pendingContacts = data || [];
  }

  const rows = [
    ...(members || []).map((c) => ({ ...c, isPending: false })),
    ...pendingContacts.map((c) => ({ ...c, isPending: true })),
  ];

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading-row">No one added to One to One yet. Search a phone number above to add someone.</td></tr>`;
    return;
  }

  const mobNos = rows.map((c) => c.mob_no);
  const [{ data: helpRows }, { data: remarkRows }] = await Promise.all([
    supabase.from("help_requests").select("mob_no,resolved").in("mob_no", mobNos),
    supabase.from("one_to_one_remarks").select("mob_no").in("mob_no", mobNos),
  ]);
  const helpCounts = {};
  const unresolvedCounts = {};
  (helpRows || []).forEach((r) => {
    helpCounts[r.mob_no] = (helpCounts[r.mob_no] || 0) + 1;
    if (!r.resolved) unresolvedCounts[r.mob_no] = (unresolvedCounts[r.mob_no] || 0) + 1;
  });
  const remarkCounts = {};
  (remarkRows || []).forEach((r) => { remarkCounts[r.mob_no] = (remarkCounts[r.mob_no] || 0) + 1; });

  // S.No here is this roster's own position, not Master Contact's s_no — it
  // must renumber 1..N for whatever's currently in the list, not carry over
  // a serial number from an unrelated table.
  tbody.innerHTML = rows.map((c, i) => {
    const hasUnresolved = (unresolvedCounts[c.mob_no] || 0) > 0;
    const actionBtn = c.isPending
      ? `<button class="cell-chip one-to-one-add-btn" data-id="${c.id}" data-name="${escapeHtml(c.name)}">+ Add</button>`
      : `<button class="cell-chip danger one-to-one-remove-btn" data-id="${c.id}" data-name="${escapeHtml(c.name)}">Delete</button>`;
    return `
    <tr${hasUnresolved ? ` class="one-to-one-row-alert"` : ""}>
      <td data-label="S.No">${i + 1}</td>
      <td data-label="Name">${escapeHtml(c.name)}${c.isPending ? ` <span class="muted-text">(Requested)</span>` : ""}</td>
      <td data-label="Phone" class="phone-cell">${formatPhone(c.mob_no)}</td>
      <td data-label="W/S">${c.ws || "NA"}</td>
      <td data-label="Help Asked by the Boy"><button class="cell-chip help-requests-link" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">${helpCounts[c.mob_no] || 0}</button></td>
      <td data-label="Remarks by SNKD"><button class="cell-chip remarks-link" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">${remarkCounts[c.mob_no] || 0}</button></td>
      <td data-label="">${actionBtn}</td>
    </tr>
  `;
  }).join("");

  tbody.querySelectorAll(".help-requests-link").forEach((btn) => {
    btn.onclick = (e) => openHelpRequestsModal(e.target.dataset.mob, e.target.dataset.name);
  });
  tbody.querySelectorAll(".remarks-link").forEach((btn) => {
    btn.onclick = (e) => openRemarksModal(e.target.dataset.mob, e.target.dataset.name);
  });
  tbody.querySelectorAll(".one-to-one-add-btn").forEach((btn) => {
    btn.onclick = async () => {
      await supabase.from("contacts").update({ one_to_one_status: true }).eq("id", btn.dataset.id);
      showToast(`${btn.dataset.name} added to One to One`, "success");
      renderOneToOneTable();
    };
  });
  tbody.querySelectorAll(".one-to-one-remove-btn").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(`Remove ${btn.dataset.name} from One to One? Their Master Contact record won't be affected.`)) return;
      await supabase.from("contacts").update({ one_to_one_status: false }).eq("id", btn.dataset.id);
      showToast(`${btn.dataset.name} removed from One to One`, "success");
      renderOneToOneTable();
    };
  });
}

function wireOneToOneSearch() {
  const input = document.getElementById("one-to-one-search");
  const resultEl = document.getElementById("one-to-one-search-result");
  const notFoundEl = document.getElementById("one-to-one-search-not-found");
  const addBtn = document.getElementById("one-to-one-search-add");
  let found = null;

  input.oninput = async (e) => {
    const digits = normalizePhoneInput(e.target.value);
    e.target.value = digits;
    resultEl.classList.add("hidden");
    notFoundEl.classList.add("hidden");
    found = null;
    if (digits.length !== 10) return;

    const { data } = await supabase
      .from("contacts")
      .select("id,name,mob_no,one_to_one_status")
      .eq("mob_no", digits)
      .maybeSingle();

    if (!data) {
      notFoundEl.classList.remove("hidden");
      return;
    }
    found = data;
    document.getElementById("one-to-one-search-name").textContent = data.name;
    document.getElementById("one-to-one-search-phone").textContent = formatPhone(data.mob_no);
    if (data.one_to_one_status) {
      addBtn.disabled = true;
      addBtn.textContent = "✓ Already Added";
    } else {
      addBtn.disabled = false;
      addBtn.textContent = "Add";
    }
    resultEl.classList.remove("hidden");
  };

  addBtn.onclick = async () => {
    if (!found || found.one_to_one_status) return;
    addBtn.disabled = true;
    addBtn.textContent = "Adding…";
    const { error } = await supabase.from("contacts").update({ one_to_one_status: true }).eq("id", found.id);
    addBtn.disabled = false;
    addBtn.textContent = "Add";
    if (error) {
      showToast("Failed: " + error.message, "error");
      return;
    }
    showToast(`${found.name} added to One to One`, "success");
    resultEl.classList.add("hidden");
    input.value = "";
    found = null;
    renderOneToOneTable();
  };

  document.getElementById("one-to-one-search-cancel").onclick = () => {
    resultEl.classList.add("hidden");
    input.value = "";
    found = null;
  };
}

let helpRequestsContext = null; // { mob, name }

async function openHelpRequestsModal(mob, name) {
  helpRequestsContext = { mob, name };
  document.getElementById("help-requests-sub").textContent = name;
  document.getElementById("help-requests-modal").classList.add("active");
  await renderHelpRequestsList();
}

async function renderHelpRequestsList() {
  const tbody = document.getElementById("help-requests-body");
  tbody.innerHTML = `<tr><td colspan="6" class="loading-row">Loading…</td></tr>`;

  // select("*") rather than an explicit column list: on databases where the
  // later `response` column was never migrated in, naming it makes PostgREST
  // reject the whole query — which showed up as a non-zero help count with an
  // empty modal. Any error is now surfaced instead of looking like "no rows".
  const { data, error } = await supabase
    .from("help_requests")
    .select("*")
    .eq("mob_no", helpRequestsContext.mob)
    .order("created_at", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="loading-row">Could not load questions: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  tbody.innerHTML = (data && data.length)
    ? data.map((r, i) => `
        <tr>
          <td data-label="S.No">${i + 1}</td>
          <td data-label="Time">${new Date(r.created_at).toLocaleString()}</td>
          <td data-label="Question">${escapeHtml(r.message)}</td>
          <td data-label="Status"><button class="cell-chip${r.resolved ? "" : " danger"} resolve-help-btn" data-id="${r.id}" data-resolved="${r.resolved}">${r.resolved ? "✓ Resolved" : "✕ Unresolved"}</button></td>
          <td data-label="Response"><button class="cell-chip respond-help-btn" data-id="${r.id}" data-response="${escapeHtml(r.response || "")}">${r.response ? "✎ Edit" : "+ Add"}</button>${r.response ? `<div class="muted-text" style="margin-top:4px;">${escapeHtml(r.response)}</div>` : ""}</td>
          <td data-label=""><button class="cell-chip danger delete-help-btn" data-id="${r.id}">Delete</button></td>
        </tr>`).join("")
    : `<tr><td colspan="6" class="loading-row">No questions asked yet.</td></tr>`;

  tbody.querySelectorAll(".resolve-help-btn").forEach((btn) => {
    btn.onclick = async () => {
      const newResolved = btn.dataset.resolved !== "true";
      await supabase.from("help_requests").update({ resolved: newResolved }).eq("id", btn.dataset.id);
      await renderHelpRequestsList();
      renderOneToOneTable();
    };
  });

  tbody.querySelectorAll(".respond-help-btn").forEach((btn) => {
    btn.onclick = async () => {
      const val = prompt("Response to the boy's question:", btn.dataset.response || "");
      if (val === null) return;
      const { error } = await supabase.from("help_requests").update({ response: val.trim() || null }).eq("id", btn.dataset.id);
      if (error) {
        showToast("Failed: " + error.message, "error");
        return;
      }
      await renderHelpRequestsList();
    };
  });

  tbody.querySelectorAll(".delete-help-btn").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Delete this question?")) return;
      await supabase.from("help_requests").delete().eq("id", btn.dataset.id);
      await renderHelpRequestsList();
      renderOneToOneTable();
    };
  });
}

function wireHelpRequestsModal() {
  const modal = document.getElementById("help-requests-modal");
  document.getElementById("help-requests-close").onclick = () => modal.classList.remove("active");
  modal.onclick = (e) => { if (e.target === modal) modal.classList.remove("active"); };
}

async function openRemarksModal(mob, name) {
  remarksContext = { mob, name };
  document.getElementById("remarks-sub").textContent = name;
  document.getElementById("remarks-text").value = "";
  document.getElementById("remarks-error").classList.add("hidden");
  document.getElementById("remarks-modal").classList.add("active");
  await renderRemarksList();
}

async function renderRemarksList() {
  const tbody = document.getElementById("remarks-body");
  tbody.innerHTML = `<tr><td colspan="4" class="loading-row">Loading…</td></tr>`;

  const { data } = await supabase
    .from("one_to_one_remarks")
    .select("id,remark,admin_name,created_at")
    .eq("mob_no", remarksContext.mob)
    .order("created_at", { ascending: false });

  tbody.innerHTML = (data && data.length)
    ? data.map((r, i) => `
        <tr>
          <td data-label="S.No">${i + 1}</td>
          <td data-label="Time">${new Date(r.created_at).toLocaleString()}${r.admin_name ? ` · ${escapeHtml(r.admin_name)}` : ""}</td>
          <td data-label="Remark">${escapeHtml(r.remark)}</td>
          <td data-label=""><button class="cell-chip danger delete-remark-btn" data-id="${r.id}">Delete</button></td>
        </tr>`).join("")
    : `<tr><td colspan="4" class="loading-row">No remarks yet.</td></tr>`;

  tbody.querySelectorAll(".delete-remark-btn").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Delete this remark?")) return;
      await supabase.from("one_to_one_remarks").delete().eq("id", btn.dataset.id);
      await renderRemarksList();
      renderOneToOneTable();
    };
  });
}

function wireRemarksModal() {
  const modal = document.getElementById("remarks-modal");
  document.getElementById("remarks-close").onclick = () => modal.classList.remove("active");
  modal.onclick = (e) => { if (e.target === modal) modal.classList.remove("active"); };

  document.getElementById("remarks-add").onclick = async () => {
    const text = document.getElementById("remarks-text").value.trim();
    const errorEl = document.getElementById("remarks-error");
    if (!text) {
      errorEl.textContent = "Please enter a remark.";
      errorEl.classList.remove("hidden");
      return;
    }
    errorEl.classList.add("hidden");
    const btn = document.getElementById("remarks-add");
    btn.disabled = true;
    btn.textContent = "Saving…";
    const { error } = await supabase.from("one_to_one_remarks").insert({
      mob_no: remarksContext.mob,
      remark: text,
      admin_name: adminName,
    });
    btn.disabled = false;
    btn.textContent = "Add Remark";
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    document.getElementById("remarks-text").value = "";
    await renderRemarksList();
    renderOneToOneTable();
    showToast("Remark added", "success");
  };
}

/* ======================= USER: One to One with Prabhu ======================= */

let currentContactMob = null;
let requestMob = null;

export async function initUserOneToOne(currentUser) {
  const notLinkedEl = document.getElementById("one-to-one-user-not-linked");
  const requestEl = document.getElementById("one-to-one-user-request");
  const contentEl = document.getElementById("one-to-one-user-content");
  notLinkedEl.classList.add("hidden");
  requestEl.classList.add("hidden");
  contentEl.classList.add("hidden");
  currentContactMob = null;
  requestMob = null;

  // Sessions created before login_pw was added to the session object won't
  // have it — re-fetch it here (and repair the stored session) instead of
  // requiring every already-logged-in user to log out and back in.
  let phone = currentUser?.login_pw;
  if (!phone && currentUser?.id) {
    const { data: userRow } = await supabase.from("users").select("login_pw").eq("id", currentUser.id).maybeSingle();
    phone = userRow?.login_pw || null;
    if (phone) {
      currentUser.login_pw = phone;
      setSession(currentUser);
    }
  }
  if (!phone) {
    notLinkedEl.classList.remove("hidden");
    return;
  }

  const { data: contact } = await supabase
    .from("contacts")
    .select("mob_no,one_to_one_status")
    .eq("mob_no", phone)
    .maybeSingle();

  if (!contact) {
    notLinkedEl.classList.remove("hidden");
    return;
  }

  if (!contact.one_to_one_status) {
    requestMob = contact.mob_no;
    requestEl.classList.remove("hidden");
    wireOneToOneRequestForm();
    return;
  }

  currentContactMob = contact.mob_no;
  contentEl.classList.remove("hidden");
  wireUserOneToOneForm();
  await renderUserQuestions();
}

function wireOneToOneRequestForm() {
  const btn = document.getElementById("one-to-one-request-btn");
  const form = document.getElementById("one-to-one-request-form");
  const textEl = document.getElementById("one-to-one-request-text");
  const errorEl = document.getElementById("one-to-one-request-error");
  const sentEl = document.getElementById("one-to-one-request-sent");
  const submitBtn = document.getElementById("one-to-one-request-submit");

  form.classList.add("hidden");
  sentEl.classList.add("hidden");
  errorEl.classList.add("hidden");
  textEl.value = "";
  btn.classList.remove("hidden");

  btn.onclick = () => {
    btn.classList.add("hidden");
    form.classList.remove("hidden");
  };

  submitBtn.onclick = async () => {
    const text = textEl.value.trim();
    if (!text) {
      errorEl.textContent = "Please enter a message.";
      errorEl.classList.remove("hidden");
      return;
    }
    errorEl.classList.add("hidden");
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";
    const { error } = await supabase.from("help_requests").insert({ mob_no: requestMob, message: text });
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit";
    if (error) {
      errorEl.textContent = "Failed: " + error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    form.classList.add("hidden");
    sentEl.classList.remove("hidden");
  };
}

async function renderUserQuestions() {
  const tbody = document.getElementById("one-to-one-user-questions-body");
  tbody.innerHTML = `<tr><td colspan="4" class="loading-row">Loading…</td></tr>`;

  // select("*") and a surfaced error, for the same reason as the admin modal:
  // naming a column the database doesn't have makes PostgREST reject the whole
  // query, which then reads as "you haven't asked anything yet".
  const { data, error } = await supabase
    .from("help_requests")
    .select("*")
    .eq("mob_no", currentContactMob)
    .order("created_at", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading-row">Could not load your questions: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  tbody.innerHTML = (data && data.length)
    ? data.map((r) => `
        <tr>
          <td data-label="Time">${new Date(r.created_at).toLocaleString()}</td>
          <td data-label="Question">${escapeHtml(r.message)}</td>
          <td data-label="Status"><button class="cell-chip${r.resolved ? "" : " danger"} user-resolve-btn" data-id="${r.id}" data-resolved="${r.resolved}">${r.resolved ? "✓ Resolved" : "✕ Unresolved"}</button></td>
          <td data-label="Response">${r.response ? escapeHtml(r.response) : `<span class="muted-text">Awaiting response…</span>`}</td>
        </tr>`).join("")
    : `<tr><td colspan="4" class="loading-row">You haven't asked anything yet.</td></tr>`;

  tbody.querySelectorAll(".user-resolve-btn").forEach((btn) => {
    btn.onclick = async () => {
      const newResolved = btn.dataset.resolved !== "true";
      await supabase.from("help_requests").update({ resolved: newResolved }).eq("id", btn.dataset.id);
      await renderUserQuestions();
    };
  });
}

function wireUserOneToOneForm() {
  const btn = document.getElementById("one-to-one-user-submit");
  const textEl = document.getElementById("one-to-one-user-text");

  btn.onclick = async () => {
    const text = textEl.value.trim();
    if (!text) {
      showToast("Please write your question first.", "error");
      return;
    }
    btn.disabled = true;
    btn.textContent = "Sending…";
    const { error } = await supabase.from("help_requests").insert({ mob_no: currentContactMob, message: text });
    btn.disabled = false;
    btn.textContent = "Send to Prabhu";
    if (error) {
      showToast("Failed: " + error.message, "error");
      return;
    }
    textEl.value = "";
    await renderUserQuestions();
    showToast("Sent", "success");
  };
}
