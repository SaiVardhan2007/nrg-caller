import { supabase } from "./supabaseClient.js";
import { formatPhone, telHref, waHref, showToast, escapeHtml } from "./utils.js";

const STATUS_DEFAULT = ""; // "Not Done" is stored as an empty status, not the literal text
const STATUS_OPTIONS = [
  { value: "", label: "Not Done" },
  { value: "Joining the session", label: "Joining the session" },
  { value: "Next Week will join", label: "Next Week will join" },
  { value: "Out of Station", label: "Out of Station" },
  { value: "Wrong Number", label: "Wrong Number" },
  { value: "Shifted to Home Town", label: "Shifted to Home Town" },
  { value: "Yet to Call Again", label: "Yet to Call Again" },
  { value: "Available on Weekend", label: "Available on Weekend" },
  { value: "Others", label: "Others" },
];
const POSITIVE = ["joining the session", "next week will join", "will try to attend"];
const PENDING = ["not done", "yet to call", ""];
const NEGATIVE = ["out of station", "wrong number", "shifted to home town", "yet to call again", "available on weekend"];
const WS_OPTIONS = ["NA", "W", "S"];

function statusCategory(status) {
  const s = (status || "").toLowerCase();
  if (NEGATIVE.includes(s)) return "negative";
  if (POSITIVE.includes(s)) return "positive";
  return "neutral";
}

// keyed by contact.id, since (unlike My Calls) there's no assignments row
// guaranteed to exist for every core-cultivated contact
const cardState = new Map(); // contact.id -> { called, sent, submitted, lastStatus }
let messageText = "";
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
  const listEl = document.getElementById("cc-cards");
  listEl.innerHTML = SKELETON_CARD.repeat(3);

  const { data: msgRow } = await supabase.from("settings").select("value").eq("key", "message_text").single();
  messageText = msgRow?.value || "";

  await loadAndRenderCards();
  wireReviewModal();
  wireHistoryModal();
  wireRefreshButton();
}

let refreshWired = false;
function wireRefreshButton() {
  if (refreshWired) return;
  refreshWired = true;
  const btn = document.getElementById("cc-refresh-btn");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Refreshing…";
    await loadAndRenderCards();
    btn.disabled = false;
    btn.textContent = original;
  });
}

// Core cultivation is a permanent 1:1 link on the contact itself, not tied to
// the active event's assignments table (which gets wiped on every event
// switch) — so this reads straight from contacts, and derives "current
// status" from this cultivator's own most recent call_responses entry for
// each contact rather than from an assignments row that may not exist.
async function loadAndRenderCards() {
  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("id,name,mob_no,ws,sessions_count,calling_purpose")
    .eq("core_cultivation", currentUser.user_name);

  const listEl = document.getElementById("cc-cards");
  if (error) {
    listEl.innerHTML = `<p class="loading-row">Could not load your core cultivation contacts.</p>`;
    return;
  }
  if (!contacts || !contacts.length) {
    listEl.innerHTML = `<p class="loading-row">No contacts under your core cultivation yet.</p>`;
    updateStatsBar([]);
    return;
  }

  const mobNos = contacts.map((c) => c.mob_no);
  const [{ data: weekCalls }, { data: ownHistory }] = await Promise.all([
    supabase.from("call_responses").select("mob_no").in("mob_no", mobNos).gte("ts", startOfWeek().toISOString()),
    supabase.from("call_responses").select("mob_no,remarks,ts").eq("caller_name", currentUser.user_name).in("mob_no", mobNos).order("ts", { ascending: false }),
  ]);
  const weekCallCounts = {};
  (weekCalls || []).forEach((r) => { weekCallCounts[r.mob_no] = (weekCallCounts[r.mob_no] || 0) + 1; });
  // first row per mob_no wins — list is already newest-first
  const lastStatusByMob = {};
  (ownHistory || []).forEach((r) => { if (!(r.mob_no in lastStatusByMob)) lastStatusByMob[r.mob_no] = r.remarks; });

  contacts.forEach((c) => {
    if (!cardState.has(c.id)) {
      const lastStatus = lastStatusByMob[c.mob_no] || null;
      cardState.set(c.id, { called: false, sent: false, submitted: !!lastStatus, lastStatus });
    }
  });

  listEl.innerHTML = contacts.map((c) => renderCard(c, weekCallCounts[c.mob_no] || 0)).join("");
  wireCard(contacts);
  updateStatsBar(contacts);
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

function renderCard(c, weekCallCount) {
  const st = cardState.get(c.id);
  const status = st.lastStatus || STATUS_DEFAULT;
  const submittedLabel = st.submitted;
  const category = statusCategory(status);
  return `
    <div class="call-card" data-contact-id="${c.id}">
      <div class="call-card-row1">
        <select class="ws-select" data-ws="${c.ws || "NA"}">
          ${WS_OPTIONS.map((o) => `<option value="${o}" ${o === (c.ws || "NA") ? "selected" : ""}>${o}</option>`).join("")}
        </select>
        <span class="call-card-name">${escapeHtml(c.name)}</span>
      </div>
      <div class="call-card-row2">
        <div class="card-badges">
          <span class="calls-link" style="cursor:default;">🌱 ${escapeHtml(c.calling_purpose || "—")}</span>
          <button class="sessions-link" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">📋 Sessions: ${c.sessions_count}</button>
          <button class="calls-link" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">📞 This week: ${weekCallCount}</button>
        </div>
        <a class="phone-pill" href="${telHref(c.mob_no)}">📞 ${formatPhone(c.mob_no)}</a>
      </div>
      <div class="call-card-row3">
        <select class="status-select status-${category}">
          ${STATUS_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === status ? "selected" : ""}>${o.label}</option>`).join("")}
        </select>
      </div>
      <div class="call-card-row4">
        <button class="btn btn-secondary send-btn">💬 Send Message</button>
        <button class="btn btn-primary row-submit-btn" disabled>
          ${submittedLabel ? "✓ Submitted" : "Submit"}
        </button>
      </div>
    </div>
  `;
}

function refreshSubmitButton(card, contactId) {
  const st = cardState.get(contactId);
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

function wireCard(contacts) {
  document.querySelectorAll("#cc-cards .call-card").forEach((card) => {
    const contactId = card.dataset.contactId;
    const c = contacts.find((x) => x.id === contactId);

    refreshSubmitButton(card, contactId);

    card.querySelector(".ws-select").addEventListener("change", async (e) => {
      e.target.dataset.ws = e.target.value;
      await supabase.from("contacts").update({ ws: e.target.value }).eq("id", contactId);
    });

    card.querySelector(".phone-pill").addEventListener("click", () => {
      cardState.get(contactId).called = true;
      refreshSubmitButton(card, contactId);
    });

    card.querySelector(".status-select").addEventListener("change", (e) => {
      e.target.classList.remove("status-positive", "status-negative", "status-neutral");
      e.target.classList.add(`status-${statusCategory(e.target.value)}`);
      if (e.target.value && e.target.value !== STATUS_DEFAULT) {
        // every contact here is under core cultivation, so a comment is
        // always required, not just for "Others" like on the regular My Calls page.
        openReviewModal(card, contactId, c);
      }
      refreshSubmitButton(card, contactId);
    });

    card.querySelector(".send-btn").addEventListener("click", () => {
      const text = (messageText || "").replace(/\{name\}/g, c.name);
      window.open(waHref(c.mob_no, text), "_blank");
      cardState.get(contactId).sent = true;
      refreshSubmitButton(card, contactId);
    });

    card.querySelector(".row-submit-btn").addEventListener("click", () => {
      submitCard(card, contactId, c);
    });

    card.querySelectorAll(".calls-link[data-mob]").forEach((btn) => {
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

async function submitCard(card, contactId, contact) {
  const statusSelect = card.querySelector(".status-select");
  const submitBtn = card.querySelector(".row-submit-btn");
  const status = statusSelect.value;
  const addl = statusSelect.dataset.review || null;
  const eventCode = contact.calling_purpose || null;

  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";
  card.classList.add("row-saving");

  const { error } = await supabase.from("call_responses").insert({
    caller_name: currentUser.user_name,
    contact_name: contact.name,
    mob_no: contact.mob_no,
    event_code: eventCode,
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
          event_code: eventCode,
          ts: new Date().toISOString()
        });
      }
    } catch (err) {
      console.warn("Could not auto-mark session attendance:", err);
    }
  }

  card.classList.remove("row-saving");
  if (error) {
    card.classList.add("row-error");
    setTimeout(() => card.classList.remove("row-error"), 1600);
    showToast("Save failed. Please try again.", "error");
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit";
    return;
  }

  const st = cardState.get(contactId);
  st.submitted = true;
  st.lastStatus = status;
  st.called = false;
  st.sent = false;

  card.classList.add("row-saved");
  setTimeout(() => card.classList.remove("row-saved"), 1200);
  showToast("Thanks for submitting 🙏", "success", 1500);
  refreshSubmitButton(card, contactId);
  updateStatsBarFromDom();
}

function updateStatsBar(contacts) {
  const total = contacts.length;
  let positive = 0, pending = 0;
  contacts.forEach((c) => {
    const s = (cardState.get(c.id)?.lastStatus || STATUS_DEFAULT).toLowerCase();
    if (POSITIVE.includes(s)) positive++;
    else if (PENDING.includes(s)) pending++;
  });
  document.getElementById("cc-stat-total").textContent = total;
  document.getElementById("cc-stat-positive").textContent = positive;
  document.getElementById("cc-stat-pending").textContent = pending;
}

function updateStatsBarFromDom() {
  const cards = document.querySelectorAll("#cc-cards .call-card");
  let total = cards.length, positive = 0, pending = 0;
  cards.forEach((card) => {
    const s = card.querySelector(".status-select").value.toLowerCase();
    if (POSITIVE.includes(s)) positive++;
    else if (PENDING.includes(s)) pending++;
  });
  document.getElementById("cc-stat-total").textContent = total;
  document.getElementById("cc-stat-positive").textContent = positive;
  document.getElementById("cc-stat-pending").textContent = pending;
}

// Every status pick here requires a comment — unlike My Calls, there is no
// Skip; Cancel backs out of the status pick entirely (same as the mandatory
// path there for "Others" / core-cultivated cards).
let pendingReview = null;

function openReviewModal(card, contactId, contact) {
  pendingReview = { card, contactId };
  document.getElementById("review-input").value = "";
  document.getElementById("review-error").classList.add("hidden");
  document.getElementById("review-skip").textContent = "Cancel";
  document.getElementById("review-confirm").textContent = "Submit";
  document.getElementById("review-title").textContent = "Review required";
  document.getElementById("review-hint").textContent =
    `${contact.name} is under your core cultivation — please leave a short note so nothing gets missed.`;
  document.getElementById("review-modal").classList.add("active");
  setTimeout(() => document.getElementById("review-input").focus(), 60);
}

function wireReviewModal() {
  const modal = document.getElementById("review-modal");
  const input = document.getElementById("review-input");
  const errorEl = document.getElementById("review-error");

  document.getElementById("review-skip").onclick = () => {
    if (!pendingReview) return;
    const { card, contactId } = pendingReview;
    modal.classList.remove("active");
    pendingReview = null;
    const statusSelect = card.querySelector(".status-select");
    statusSelect.value = STATUS_DEFAULT;
    statusSelect.classList.remove("status-positive", "status-negative", "status-neutral");
    statusSelect.classList.add("status-neutral");
    refreshSubmitButton(card, contactId);
  };
  document.getElementById("review-confirm").onclick = () => {
    if (!pendingReview) return;
    if (!input.value.trim()) {
      errorEl.textContent = "A review is required for this response.";
      errorEl.classList.remove("hidden");
      return;
    }
    const { card, contactId } = pendingReview;
    modal.classList.remove("active");
    pendingReview = null;
    card.querySelector(".status-select").dataset.review = input.value.trim();
    refreshSubmitButton(card, contactId);
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
