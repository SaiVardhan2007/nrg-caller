import { supabase } from "./supabaseClient.js";
import { formatPhone, telHref, waHref, showToast, escapeHtml } from "./utils.js";
import { STORAGE_BUCKET } from "./config.js";

const STATUS_DEFAULT = "Not Done";
const STATUS_OPTIONS = [
  "Not Done",
  "Don't Call him again",
  "Joining the session",
  "Next Week will join",
  "Out of station",
  "evening Shift",
  "Busy",
  "Will come for Saturday",
  "Wrong Number",
  "Sunday Available",
  "Will try to attend",
  "Yet To Call",
  "Didn't Receive, Sent in WhatsApp",
  "Out of Network Coverage",
  "Shifted to Home town",
  "Only Online session",
  "Others",
];
const POSITIVE = ["joining the session", "will try to attend"];
const PENDING = ["not done", "yet to call", ""];
const NEGATIVE = ["don't call him again", "wrong number", "out of network coverage", "shifted to home town"];
const WS_OPTIONS = ["NA", "W", "S"];
const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#059669,#047857)",
  "linear-gradient(135deg,#d97706,#b45309)",
  "linear-gradient(135deg,#4f46e5,#4338ca)",
  "linear-gradient(135deg,#0891b2,#0e7490)",
  "linear-gradient(135deg,#db2777,#be185d)",
  "linear-gradient(135deg,#65a30d,#4d7c0f)",
];

function statusCategory(status) {
  const s = (status || "").toLowerCase();
  if (NEGATIVE.includes(s)) return "negative";
  if (POSITIVE.includes(s)) return "positive";
  return "neutral";
}

function avatarGradient(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}

const cardState = new Map(); // assignment.id -> { called, sent, submitted, lastStatus }
let currentEventCode = "";
let currentEventName = "";
let posterUrl = "";
let messageText = "";
let currentUser = null;
let othersTargetAssignmentId = null;

const SKELETON_CARD = `
  <div class="call-card skeleton-card">
    <div class="call-card-row1">
      <span class="skeleton skeleton-avatar"></span>
      <span class="skeleton skeleton-line" style="width:40%"></span>
    </div>
    <div class="skeleton skeleton-line" style="width:70%;height:32px;border-radius:20px;"></div>
  </div>
`;

export async function init(user) {
  currentUser = user;
  const listEl = document.getElementById("caller-cards");
  listEl.innerHTML = SKELETON_CARD.repeat(3);

  const [{ data: eventRow }, { data: msgRow }, { data: posterRow }] = await Promise.all([
    supabase.from("settings").select("value").eq("key", "current_event").single(),
    supabase.from("settings").select("value").eq("key", "message_text").single(),
    supabase.from("settings").select("value").eq("key", "poster_url").single(),
  ]);
  currentEventCode = eventRow?.value || "";
  messageText = msgRow?.value || "";
  posterUrl = posterRow?.value || "";

  const { data: eventInfo } = await supabase.from("events").select("name").eq("code", currentEventCode).single();
  currentEventName = eventInfo?.name || currentEventCode;
  document.getElementById("caller-event-title").textContent = currentEventName;
  document.getElementById("dash-event-name").textContent = currentEventName;

  await loadAndRenderCards();
  wireOthersModal();
  wireReviewModal();
  wireHistoryModal();
  subscribeRealtime();
}

async function loadAndRenderCards() {
  const { data: assignments, error } = await supabase
    .from("assignments")
    .select("id,status,submitted_at,contact_id,contacts(id,name,mob_no,ws,sessions_count,core_cultivation)")
    .eq("user_name", currentUser.user_name)
    .eq("event_code", currentEventCode);

  const listEl = document.getElementById("caller-cards");
  if (error) {
    listEl.innerHTML = `<p class="loading-row">Could not load your contacts.</p>`;
    return;
  }
  if (!assignments || !assignments.length) {
    listEl.innerHTML = `<p class="loading-row">No contacts assigned to you yet for ${escapeHtml(currentEventName)}.</p>`;
    updateStatsBar([]);
    return;
  }

  assignments.forEach((a) => {
    if (!cardState.has(a.id)) {
      cardState.set(a.id, { called: false, sent: false, submitted: !!a.submitted_at, lastStatus: a.status });
    }
  });

  listEl.innerHTML = assignments.map((a) => renderCard(a)).join("");
  wireCard(assignments);
  updateStatsBar(assignments);
}

function renderCard(a) {
  const c = a.contacts;
  const st = cardState.get(a.id);
  const submittedLabel = st.submitted && st.lastStatus === a.status;
  const category = statusCategory(a.status);
  return `
    <div class="call-card" data-assignment-id="${a.id}" data-contact-id="${c.id}">
      <div class="call-card-row1">
        <span class="call-card-avatar" style="background:${avatarGradient(c.name)}">${initials(c.name)}</span>
        <span class="call-card-name">${escapeHtml(c.name)}</span>
        <select class="ws-select">
          ${WS_OPTIONS.map((o) => `<option value="${o}" ${o === (c.ws || "NA") ? "selected" : ""}>${o}</option>`).join("")}
        </select>
      </div>
      <div class="call-card-row2">
        <button class="calls-link" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">📋 Sessions: ${c.sessions_count}</button>
        <a class="phone-pill" href="${telHref(c.mob_no)}">📞 ${formatPhone(c.mob_no)}</a>
      </div>
      <div class="call-card-row3">
        <select class="status-select status-${category}">
          ${STATUS_OPTIONS.map((o) => `<option value="${o}" ${o === (a.status || STATUS_DEFAULT) ? "selected" : ""}>${o}</option>`).join("")}
        </select>
      </div>
      <div class="call-card-row4">
        <button class="btn btn-secondary send-btn">💬 Send Message</button>
        <button class="btn btn-primary row-submit-btn" ${submittedLabel ? "disabled" : "disabled"}>
          ${submittedLabel ? "✓ Submitted" : "Submit"}
        </button>
      </div>
    </div>
  `;
}

function refreshSubmitButton(card, assignmentId) {
  const st = cardState.get(assignmentId);
  const statusSelect = card.querySelector(".status-select");
  const submitBtn = card.querySelector(".row-submit-btn");
  const status = statusSelect.value;

  if (st.submitted && status === st.lastStatus) {
    submitBtn.disabled = true;
    submitBtn.textContent = "✓ Submitted";
    return;
  }
  if (status === STATUS_DEFAULT) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Submit";
    return;
  }
  if (st.submitted) {
    // already submitted once before: re-submitting a changed status needs no re-call/message
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit";
    return;
  }
  if (st.called && st.sent) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit";
  } else if (!st.called) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Call first";
  } else {
    submitBtn.disabled = true;
    submitBtn.textContent = "Send message first";
  }
}

function wireCard(assignments) {
  document.querySelectorAll(".call-card").forEach((card) => {
    const assignmentId = card.dataset.assignmentId;
    const contactId = card.dataset.contactId;
    const a = assignments.find((x) => x.id === assignmentId);
    const c = a.contacts;

    refreshSubmitButton(card, assignmentId);

    card.querySelector(".ws-select").addEventListener("change", async (e) => {
      await supabase.from("contacts").update({ ws: e.target.value }).eq("id", contactId);
    });

    card.querySelector(".phone-pill").addEventListener("click", () => {
      cardState.get(assignmentId).called = true;
      refreshSubmitButton(card, assignmentId);
    });

    card.querySelector(".status-select").addEventListener("change", (e) => {
      if (e.target.value === "Others") {
        othersTargetAssignmentId = assignmentId;
        document.getElementById("others-input").value = "";
        document.getElementById("others-error").classList.add("hidden");
        document.getElementById("others-modal").classList.add("active");
        setTimeout(() => document.getElementById("others-input").focus(), 60);
      }
      e.target.classList.remove("status-positive", "status-negative", "status-neutral");
      e.target.classList.add(`status-${statusCategory(e.target.value)}`);
      refreshSubmitButton(card, assignmentId);
    });

    card.querySelector(".send-btn").addEventListener("click", async () => {
      const text = (messageText || "").replace(/\{name\}/g, c.name);
      if (posterUrl && navigator.canShare && navigator.share) {
        try {
          const resp = await fetch(posterUrl);
          const blob = await resp.blob();
          const file = new File([blob], "poster.jpg", { type: blob.type });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], text });
            cardState.get(assignmentId).sent = true;
            refreshSubmitButton(card, assignmentId);
            return;
          }
        } catch { /* fall through to wa.me link */ }
      }
      window.open(waHref(c.mob_no, text), "_blank");
      cardState.get(assignmentId).sent = true;
      refreshSubmitButton(card, assignmentId);
    });

    card.querySelector(".row-submit-btn").addEventListener("click", () => {
      const status = card.querySelector(".status-select").value;
      if (status === "Others") {
        // the Others flow already collected mandatory detail when it was selected; that text is the review.
        submitCard(card, assignmentId, contactId, c, card.querySelector(".status-select").dataset.othersText || "");
        return;
      }
      openReviewModal(card, assignmentId, contactId, c, !!c.core_cultivation);
    });

    card.querySelector(".calls-link").addEventListener("click", (e) => {
      openHistoryModal(e.target.dataset.mob, e.target.dataset.name);
    });
  });
}

async function submitCard(card, assignmentId, contactId, contact, review) {
  const statusSelect = card.querySelector(".status-select");
  const submitBtn = card.querySelector(".row-submit-btn");
  const status = statusSelect.value;
  const addl = review || null;

  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";
  card.classList.add("row-saving");

  const { error: e1 } = await supabase.from("assignments")
    .update({ status, submitted_at: new Date().toISOString() })
    .eq("id", assignmentId);
  const { error: e2 } = await supabase.from("call_responses").insert({
    caller_name: currentUser.user_name,
    contact_name: contact.name,
    mob_no: contact.mob_no,
    event_code: currentEventCode,
    remarks: status,
    addl_remarks: addl,
  });

  card.classList.remove("row-saving");
  if (e1 || e2) {
    card.classList.add("row-error");
    setTimeout(() => card.classList.remove("row-error"), 1600);
    showToast("Save failed. Please try again.", "error");
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit";
    return;
  }

  const st = cardState.get(assignmentId);
  st.submitted = true;
  st.lastStatus = status;
  st.called = false;
  st.sent = false;

  card.classList.add("row-saved");
  setTimeout(() => card.classList.remove("row-saved"), 1200);
  showToast("Thanks for submitting 🙏", "success", 1500);
  refreshSubmitButton(card, assignmentId);
  updateStatsBarFromDom();
}

function updateStatsBar(assignments) {
  const total = assignments.length;
  let positive = 0, pending = 0;
  assignments.forEach((a) => {
    const s = (a.status || STATUS_DEFAULT).toLowerCase();
    if (POSITIVE.includes(s)) positive++;
    else if (PENDING.includes(s)) pending++;
  });
  document.getElementById("stat-total").textContent = total;
  document.getElementById("stat-positive").textContent = positive;
  document.getElementById("stat-pending").textContent = pending;
}

function updateStatsBarFromDom() {
  const cards = document.querySelectorAll(".call-card");
  let total = cards.length, positive = 0, pending = 0;
  cards.forEach((card) => {
    const s = card.querySelector(".status-select").value.toLowerCase();
    if (POSITIVE.includes(s)) positive++;
    else if (PENDING.includes(s)) pending++;
  });
  document.getElementById("stat-total").textContent = total;
  document.getElementById("stat-positive").textContent = positive;
  document.getElementById("stat-pending").textContent = pending;
}

function wireOthersModal() {
  const modal = document.getElementById("others-modal");
  const input = document.getElementById("others-input");
  const errorEl = document.getElementById("others-error");

  document.getElementById("others-cancel").onclick = () => {
    modal.classList.remove("active");
    if (othersTargetAssignmentId) {
      const card = document.querySelector(`.call-card[data-assignment-id="${othersTargetAssignmentId}"]`);
      if (card) card.querySelector(".status-select").value = STATUS_DEFAULT;
    }
  };
  document.getElementById("others-confirm").onclick = () => {
    if (!input.value.trim()) {
      errorEl.textContent = "Details are mandatory — please type something.";
      errorEl.classList.remove("hidden");
      return;
    }
    const card = document.querySelector(`.call-card[data-assignment-id="${othersTargetAssignmentId}"]`);
    if (card) {
      const sel = card.querySelector(".status-select");
      sel.dataset.othersText = input.value.trim();
      refreshSubmitButton(card, othersTargetAssignmentId);
    }
    modal.classList.remove("active");
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("others-confirm").click();
    if (e.key === "Escape") document.getElementById("others-cancel").click();
  });
}

let pendingReview = null;

function openReviewModal(card, assignmentId, contactId, contact, mandatory) {
  pendingReview = { card, assignmentId, contactId, contact, mandatory };
  document.getElementById("review-input").value = "";
  document.getElementById("review-error").classList.add("hidden");
  document.getElementById("review-skip").classList.toggle("hidden", mandatory);
  document.getElementById("review-title").textContent = mandatory ? "Review required" : "Add a review";
  document.getElementById("review-hint").textContent = mandatory
    ? `${contact.name} is under core cultivation — please leave a short note so nothing gets missed.`
    : "Optional — add any notes about this call.";
  document.getElementById("review-modal").classList.add("active");
  setTimeout(() => document.getElementById("review-input").focus(), 60);
}

function wireReviewModal() {
  const modal = document.getElementById("review-modal");
  const input = document.getElementById("review-input");
  const errorEl = document.getElementById("review-error");

  document.getElementById("review-skip").onclick = () => {
    if (!pendingReview) return;
    modal.classList.remove("active");
    const { card, assignmentId, contactId, contact } = pendingReview;
    pendingReview = null;
    submitCard(card, assignmentId, contactId, contact, "");
  };
  document.getElementById("review-confirm").onclick = () => {
    if (!pendingReview) return;
    if (pendingReview.mandatory && !input.value.trim()) {
      errorEl.textContent = "A review is required for this contact.";
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    const { card, assignmentId, contactId, contact } = pendingReview;
    pendingReview = null;
    submitCard(card, assignmentId, contactId, contact, input.value.trim());
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) document.getElementById("review-confirm").click();
  });
}

async function openHistoryModal(mob, name) {
  document.getElementById("history-modal-title").textContent = "Call History";
  document.getElementById("history-contact-info").textContent = `Contact: ${name} (${formatPhone(mob)})`;
  const tbody = document.getElementById("history-body");
  tbody.innerHTML = `<tr><td colspan="3" class="no-history">Loading…</td></tr>`;
  document.getElementById("history-modal").classList.add("active");

  const { data, error } = await supabase
    .from("call_responses")
    .select("ts,remarks,addl_remarks")
    .eq("mob_no", mob)
    .order("ts", { ascending: false });

  if (error || !data || !data.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="no-history">No call history yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map((r) => `
    <tr>
      <td>${new Date(r.ts).toLocaleString()}</td>
      <td>${escapeHtml(r.remarks)}</td>
      <td>${escapeHtml(r.addl_remarks || "")}</td>
    </tr>
  `).join("");
}

function wireHistoryModal() {
  const modal = document.getElementById("history-modal");
  document.getElementById("history-close").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
}

let realtimeWired = false;
function subscribeRealtime() {
  if (realtimeWired) return;
  realtimeWired = true;
  supabase
    .channel("assignments-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "assignments" }, () => {
      if (document.getElementById("caller-section").classList.contains("hidden")) return;
      loadAndRenderCards();
    })
    .subscribe();
}
