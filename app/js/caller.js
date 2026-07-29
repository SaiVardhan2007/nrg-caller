import { supabase } from "./supabaseClient.js";
import { formatPhone, telHref, waHref, sendWhatsAppMessage, showToast, escapeHtml } from "./utils.js";

const STATUS_DEFAULT = ""; // "Not Done" is stored as an empty status, not the literal text
const STATUS_OPTIONS = [
  { value: "", label: "Not Done" },
  { value: "Joining the session", label: "Joining the session" },
  { value: "Next Week will join", label: "Next Week will join" },
  { value: "Out of Station", label: "Out of Station" },
  { value: "Wrong Number", label: "Wrong Number" },
  { value: "Shifted to Home Town", label: "Shifted to Home Town" },
  { value: "Need to Call Again", label: "Need to Call Again" },
  { value: "Available on Weekend", label: "Available on Weekend" },
  { value: "Others", label: "Others" },
];
const POSITIVE = ["joining the session", "next week will join", "will try to attend"];
const PENDING = ["not done", "yet to call", ""];
// "yet to call again" kept for older rows already saved under the previous label
const NEGATIVE = ["out of station", "wrong number", "shifted to home town", "yet to call again", "need to call again", "available on weekend"];
const WS_OPTIONS = ["NA", "W", "S"];

function statusCategory(status) {
  const s = (status || "").toLowerCase();
  if (NEGATIVE.includes(s)) return "negative";
  if (POSITIVE.includes(s)) return "positive";
  return "neutral";
}

const cardState = new Map(); // assignment.id -> { called, sent, submitted, lastStatus }
let currentEventCode = "";
let currentEventName = "";
let messageText = "";
let messageImageUrl = "";
let currentUser = null;

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

  const [{ data: eventRow }, { data: msgRow }, { data: imgRow }] = await Promise.all([
    supabase.from("settings").select("value").eq("key", "current_event").single(),
    supabase.from("settings").select("value").eq("key", "message_text").single(),
    supabase.from("settings").select("value").eq("key", "poster_url").single(),
  ]);
  currentEventCode = eventRow?.value || "";
  messageText = msgRow?.value || "";
  messageImageUrl = imgRow?.value || "";

  const { data: eventInfo } = await supabase.from("events").select("name").eq("code", currentEventCode).single();
  currentEventName = eventInfo?.name || currentEventCode;
  document.getElementById("caller-event-title").textContent = currentEventName;
  document.getElementById("dash-event-name").textContent = currentEventName;

  await loadAndRenderCards();
  wireReviewModal();
  wireHistoryModal();
  wireRefreshButton();
  wireSearch();
  subscribeRealtime();
}

let searchWired = false;
function wireSearch() {
  if (searchWired) return;
  searchWired = true;
  document.getElementById("caller-search").addEventListener("input", applySearchFilter);
}

function applySearchFilter() {
  const q = document.getElementById("caller-search").value.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, "");
  document.querySelectorAll("#caller-cards .call-card").forEach((card) => {
    if (!q) { card.classList.remove("hidden"); return; }
    const name = (card.querySelector(".call-card-name")?.textContent || "").toLowerCase();
    const phoneDigits = (card.querySelector(".phone-pill")?.textContent || "").replace(/\D/g, "");
    const match = name.includes(q) || (qDigits && phoneDigits.includes(qDigits));
    card.classList.toggle("hidden", !match);
  });
}

let refreshWired = false;
function wireRefreshButton() {
  if (refreshWired) return;
  refreshWired = true;
  const btn = document.getElementById("caller-refresh-btn");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Refreshing…";
    await loadAndRenderCards();
    btn.disabled = false;
    btn.textContent = original;
  });
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

  const mobNos = assignments.map((a) => a.contacts.mob_no);
  const { data: weekCalls } = await supabase
    .from("call_responses")
    .select("mob_no")
    .in("mob_no", mobNos)
    .gte("ts", startOfWeek().toISOString());
  const weekCallCounts = {};
  (weekCalls || []).forEach((r) => { weekCallCounts[r.mob_no] = (weekCallCounts[r.mob_no] || 0) + 1; });

  listEl.innerHTML = assignments.map((a) => renderCard(a, weekCallCounts[a.contacts.mob_no] || 0)).join("");
  wireCard(assignments);
  updateStatsBar(assignments);
  applySearchFilter();
}

function startOfWeek() {
  const d = new Date();
  const day = d.getDay(); // 0 = Sun ... 6 = Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function renderCard(a, weekCallCount) {
  const c = a.contacts;
  const st = cardState.get(a.id);
  const submittedLabel = st.submitted && st.lastStatus === a.status;
  const category = statusCategory(a.status);
  return `
    <div class="call-card" data-assignment-id="${a.id}" data-contact-id="${c.id}">
      <div class="call-card-row1">
        <select class="ws-select" data-ws="${c.ws || "NA"}">
          ${WS_OPTIONS.map((o) => `<option value="${o}" ${o === (c.ws || "NA") ? "selected" : ""}>${o}</option>`).join("")}
        </select>
        <span class="call-card-name">${escapeHtml(c.name)}</span>
      </div>
      <div class="call-card-row2">
        <div class="card-badges">
          <button class="sessions-link" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">📋 Sessions: ${c.sessions_count}</button>
          <button class="calls-link" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">📞 This week: ${weekCallCount}</button>
        </div>
        <a class="phone-pill" href="${telHref(c.mob_no)}">📞 ${formatPhone(c.mob_no)}</a>
      </div>
      <div class="call-card-row3">
        <select class="status-select status-${category}">
          ${STATUS_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === (a.status || STATUS_DEFAULT) ? "selected" : ""}>${o.label}</option>`).join("")}
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
    submitBtn.classList.add("is-submitted");
    return;
  }
  submitBtn.classList.remove("is-submitted");
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
      e.target.dataset.ws = e.target.value;
      await supabase.from("contacts").update({ ws: e.target.value }).eq("id", contactId);
    });

    card.querySelector(".phone-pill").addEventListener("click", () => {
      cardState.get(assignmentId).called = true;
      refreshSubmitButton(card, assignmentId);
    });

    card.querySelector(".status-select").addEventListener("change", (e) => {
      e.target.classList.remove("status-positive", "status-negative", "status-neutral");
      e.target.classList.add(`status-${statusCategory(e.target.value)}`);
      if (e.target.value && e.target.value !== STATUS_DEFAULT) {
        const mandatory = e.target.value === "Others" || !!c.core_cultivation;
        openReviewModal(card, assignmentId, c, mandatory);
      }
      refreshSubmitButton(card, assignmentId);
    });

    card.querySelector(".send-btn").addEventListener("click", async () => {
      const sent = await sendWhatsAppMessage(c.mob_no, c.name, messageText, messageImageUrl);
      if (!sent) return;
      cardState.get(assignmentId).sent = true;
      refreshSubmitButton(card, assignmentId);
    });

    card.querySelector(".row-submit-btn").addEventListener("click", () => {
      submitCard(card, assignmentId, contactId, c);
    });

    card.querySelectorAll(".calls-link").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        openHistoryModal(e.currentTarget.dataset.mob, e.currentTarget.dataset.name, "calls");
      });
    });

    card.querySelectorAll(".sessions-link").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        openHistoryModal(e.currentTarget.dataset.mob, e.currentTarget.dataset.name, "sessions");
      });
    });
  });
}

async function submitCard(card, assignmentId, contactId, contact) {
  const statusSelect = card.querySelector(".status-select");
  const submitBtn = card.querySelector(".row-submit-btn");
  const status = statusSelect.value;
  const addl = statusSelect.dataset.review || null;

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

  if (status === "Joining the session") {
    try {
      const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
      const { data: recentAtt } = await supabase
        .from("session_attendance")
        .select("id")
        .eq("mob_no", contact.mob_no)
        .gte("ts", eightHoursAgo)
        .limit(1);

      if (!recentAtt || recentAtt.length === 0) {
        await supabase.from("session_attendance").insert({
          mob_no: contact.mob_no,
          name: contact.name,
          took_by: currentUser.user_name,
          event_code: currentEventCode || null,
          ts: new Date().toISOString()
        });
      }
    } catch (err) {
      console.warn("Could not auto-mark session attendance:", err);
    }
  }

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

// Lightweight dashboard-only refresh — usable on boot/refresh without loading
// the full My Calls page (which also renders every call card).
export async function refreshDashboardBadge(user) {
  const { data: eventRow } = await supabase.from("settings").select("value").eq("key", "current_event").single();
  const eventCode = eventRow?.value || "";
  const { data: eventInfo } = await supabase.from("events").select("name").eq("code", eventCode).single();
  document.getElementById("dash-event-name").textContent = eventInfo?.name || eventCode;

  const { data: assignments } = await supabase
    .from("assignments")
    .select("status")
    .eq("user_name", user.user_name)
    .eq("event_code", eventCode);

  const total = assignments ? assignments.length : 0;
  const pending = (assignments || []).filter((a) => PENDING.includes((a.status || STATUS_DEFAULT).toLowerCase())).length;
  const pct = total > 0 ? Math.round(((total - pending) / total) * 100) : 0;
  document.getElementById("dash-completion-badge").textContent = `${pct}%`;
}

function updateCompletionBadges(total, pending) {
  const pct = total > 0 ? Math.round(((total - pending) / total) * 100) : 0;
  document.getElementById("caller-completion-badge").textContent = `${pct}% Completed`;
  document.getElementById("dash-completion-badge").textContent = `${pct}%`;
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
  updateCompletionBadges(total, pending);
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
  updateCompletionBadges(total, pending);
}

// Fires the moment a status is picked (any status, not just "Others"), mirroring
// how "Others" used to work on its own. Mandatory for "Others" or a core-cultivated
// contact (no Skip shown, Cancel reverts the status pick); optional otherwise
// (Skip keeps the status but records no comment).
let pendingReview = null;

function openReviewModal(card, assignmentId, contact, mandatory) {
  pendingReview = { card, assignmentId, mandatory };
  document.getElementById("review-input").value = "";
  document.getElementById("review-error").classList.add("hidden");
  document.getElementById("review-skip").textContent = mandatory ? "Cancel" : "Skip";
  document.getElementById("review-confirm").textContent = mandatory ? "Submit" : "Save";
  document.getElementById("review-title").textContent = mandatory ? "Review required" : "Add a review";
  document.getElementById("review-hint").textContent = mandatory
    ? (contact.core_cultivation
        ? `${contact.name} is under core cultivation — please leave a short note so nothing gets missed.`
        : "Please add a short note about what happened.")
    : "Optional — add any notes about this call, or skip.";
  document.getElementById("review-modal").classList.add("active");
  setTimeout(() => document.getElementById("review-input").focus(), 60);
}

function wireReviewModal() {
  const modal = document.getElementById("review-modal");
  const input = document.getElementById("review-input");
  const errorEl = document.getElementById("review-error");

  document.getElementById("review-skip").onclick = () => {
    if (!pendingReview) return;
    const { card, assignmentId, mandatory } = pendingReview;
    modal.classList.remove("active");
    pendingReview = null;
    const statusSelect = card.querySelector(".status-select");
    if (mandatory) {
      // Cancel: back out of the status pick entirely, same as the old Others-cancel behavior.
      statusSelect.value = STATUS_DEFAULT;
      statusSelect.classList.remove("status-positive", "status-negative", "status-neutral");
      statusSelect.classList.add("status-neutral");
    } else {
      statusSelect.dataset.review = "";
    }
    refreshSubmitButton(card, assignmentId);
  };
  document.getElementById("review-confirm").onclick = () => {
    if (!pendingReview) return;
    if (pendingReview.mandatory && !input.value.trim()) {
      errorEl.textContent = "A review is required for this response.";
      errorEl.classList.remove("hidden");
      return;
    }
    const { card, assignmentId } = pendingReview;
    modal.classList.remove("active");
    pendingReview = null;
    card.querySelector(".status-select").dataset.review = input.value.trim();
    refreshSubmitButton(card, assignmentId);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) document.getElementById("review-confirm").click();
  });
}

async function openHistoryModal(mob, name, kind = "calls") {
  const titleEl = document.getElementById("history-modal-title");
  const theadRow = document.querySelector("#history-modal thead tr");
  const tbody = document.getElementById("history-body");

  document.getElementById("history-contact-info").textContent = `Contact: ${name} (${formatPhone(mob)})`;
  tbody.innerHTML = `<tr><td colspan="3" class="no-history">Loading…</td></tr>`;
  document.getElementById("history-modal").classList.add("active");

  if (kind === "sessions") {
    titleEl.textContent = "Session Attendance";
    theadRow.innerHTML = "<th>Time</th><th>Marked By</th><th>Event</th>";

    const { data, error } = await supabase
      .from("session_attendance")
      .select("ts,took_by,event_code")
      .eq("mob_no", mob)
      .order("ts", { ascending: false });

    if (error || !data || !data.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="no-history">No sessions attended yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map((r) => `
      <tr>
        <td>${new Date(r.ts).toLocaleString()}</td>
        <td>${escapeHtml(r.took_by)}</td>
        <td>${escapeHtml(r.event_code || "—")}</td>
      </tr>
    `).join("");
  } else {
    titleEl.textContent = "Call History";
    theadRow.innerHTML = "<th>Time</th><th>Status</th><th>Additional</th>";

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
