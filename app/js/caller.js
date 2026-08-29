import { supabase } from "./supabaseClient.js";
import { formatPhone, telHref, waHref, sendWhatsAppMessage, showToast, escapeHtml, wireCardNameEdit, cardNameDisplayHtml, normalizePhoneInput, statusSelectHtml, gycSelectHtml, orgFieldHtml, saveContactOrg, startOfLast4Weeks, debounce } from "./utils.js";
import { logEvent } from "./activityLog.js";

const STATUS_DEFAULT = ""; // an un-called contact has an empty status, shown as a blank option
const STATUS_OPTIONS = [
  { value: "", label: "" },
  { value: "Joining the session", label: "Joining the session" },
  { value: "Next Week will join", label: "Next Week will join" },
  { value: "Out of Station", label: "Out of Station" },
  { value: "Wrong Number", label: "Wrong Number" },
  { value: "Shifted to Home Town", label: "Shifted to Home Town" },
  { value: "Need to Call Again", label: "Need to Call Again" },
  { value: "Available on Weekend", label: "Available on Weekend" },
  { value: "Others", label: "Others" },
];
const POSITIVE = ["joining the session"];
const PENDING = ["not done", "yet to call", ""];
// "yet to call again" kept for older rows already saved under the previous label
const NEGATIVE = ["out of station", "wrong number", "shifted to home town", "yet to call again", "need to call again", "available on weekend", "next week will join", "will try to attend"];
const WS_OPTIONS = ["NA", "W", "S"];
// Sending the WhatsApp invite only gates Submit for the two statuses where the
// contact actually intends to come — for "Wrong Number", "Out of Station" etc.
// there is nothing worth sending, so a call alone is enough.
const MESSAGE_REQUIRED_STATUSES = ["Joining the session", "Next Week will join"];

function statusCategory(status) {
  const s = (status || "").toLowerCase();
  if (NEGATIVE.includes(s)) return "negative";
  if (POSITIVE.includes(s)) return "positive";
  return "neutral";
}

const cardState = new Map(); // assignment.id -> { called, sent, submitted, lastStatus }
let eventNameByCode = {}; // assignments now span every event a caller was assigned in, not just one
let messageText = "";
let currentUser = null;

// contact_id|event_code for every row in this caller's own (unfiltered by
// handoff) `assignments` result — lets the realtime handler below decide
// whether a follow_up_assignments change is relevant to this caller without
// a network round-trip. Stays correct across a handoff-and-back cycle since
// it's keyed off `assignments`, which a handoff never touches (see the
// handedOffKeys comment in loadAndRenderCards).
let myAssignmentKeys = new Set();

// This screen is the single most-visited one in the app (every call a
// coordinator makes routes back through it), so unlike the admin tabs it
// used to reload on every single visit. Short TTL + a dirty flag that
// realtime flips when something relevant changed while this tab was hidden —
// so a cached visit is only ever shown when nothing has actually changed.
let lastLoadedAt = 0;
let sectionDirty = true;
const CALLER_CACHE_TTL_MS = 45 * 1000;

const SKELETON_CARD = `
  <div class="call-card skeleton-card">
    <div class="call-card-row1">
      <span class="skeleton skeleton-avatar"></span>
      <span class="skeleton skeleton-line" style="width:40%"></span>
    </div>
    <div class="skeleton skeleton-line" style="width:70%;height:32px;border-radius:20px;"></div>
  </div>
`;

export async function init(user, { forceRefresh = false } = {}) {
  const sameUser = currentUser?.user_name === user.user_name;
  currentUser = user;

  wireReviewModal();
  wireHistoryModal();
  wireRefreshButton();
  wireFollowUpToggle();
  wireSearch();
  subscribeRealtime();

  // Nothing relevant has changed since the last visit — the DOM from that
  // visit is still sitting there (main.js only hides/shows sections, it never
  // tears them down), so there's genuinely nothing to do. The page's own
  // refresh button and the header's global refresh button both pass
  // forceRefresh:true and always bypass this.
  if (!forceRefresh && sameUser && !sectionDirty && Date.now() - lastLoadedAt < CALLER_CACHE_TTL_MS) return;

  const listEl = document.getElementById("caller-cards");
  listEl.innerHTML = SKELETON_CARD.repeat(3);

  const [{ data: msgRow }, { data: eventsData }] = await Promise.all([
    supabase.from("settings").select("value").eq("key", "message_text").single(),
    supabase.from("events").select("code,name"),
  ]);
  messageText = msgRow?.value || "";
  eventNameByCode = {};
  (eventsData || []).forEach((e) => { eventNameByCode[e.code] = e.name; });

  document.getElementById("caller-event-title").textContent = "Your Calls";
  document.getElementById("dash-event-name").textContent = "All Events";

  await loadAndRenderCards();
}

// Follow Up Calls stays out of the way while there's still work in the main
// list — it auto-reveals once every assigned call is done, but a caller can
// always peek at it early via the Follow-up stat box.
let followUpRevealed = false;
function applyFollowUpVisibility(pending) {
  document.getElementById("caller-followup-section").classList.toggle("hidden", !(pending === 0 || followUpRevealed));
}

let followUpToggleWired = false;
function wireFollowUpToggle() {
  if (followUpToggleWired) return;
  followUpToggleWired = true;
  document.getElementById("stat-followup-box").addEventListener("click", () => {
    followUpRevealed = !followUpRevealed;
    const pending = Number(document.getElementById("stat-pending").textContent) || 0;
    applyFollowUpVisibility(pending);
  });
}

let searchWired = false;
function wireSearch() {
  if (searchWired) return;
  searchWired = true;
  document.getElementById("caller-search").addEventListener("input", applySearchFilter);
}

function applySearchFilter() {
  const q = document.getElementById("caller-search").value.trim().toLowerCase();
  const qDigits = normalizePhoneInput(q);
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

// Postgrest has no default row order, so without an explicit sort the list
// can land in a different spot on every reload (the bug: submitting a
// contact sometimes moved it to the bottom, sometimes to the middle).
// Not-yet-submitted contacts keep a stable position (by assignment time);
// submitted ones always sort after them, oldest-submitted first — so
// submitting a contact always sends it to the bottom, consistently.
function sortBySubmission(list) {
  list.sort((a, b) => {
    if (!!a.submitted_at !== !!b.submitted_at) return a.submitted_at ? 1 : -1;
    const aTime = a.submitted_at || a.assigned_at;
    const bTime = b.submitted_at || b.assigned_at;
    return new Date(aTime) - new Date(bTime);
  });
}

function ensureCardState(item) {
  if (!cardState.has(item.id)) {
    cardState.set(item.id, { called: false, sent: false, submitted: !!item.submitted_at, lastStatus: item.status, review: "" });
  }
}

async function loadAndRenderCards() {
  const { data: assignments, error } = await supabase
    .from("assignments")
    .select("id,status,submitted_at,assigned_at,event_code,contact_id,contacts(id,name,mob_no,ws,sessions_count,core_cultivation,gyc_status,company_name)")
    .eq("user_name", currentUser.user_name);

  const listEl = document.getElementById("caller-cards");
  if (error) {
    listEl.innerHTML = `<p class="loading-row">Could not load your contacts.</p>`;
    return;
  }

  myAssignmentKeys = new Set((assignments || []).map((a) => `${a.contact_id}|${a.event_code}`));
  lastLoadedAt = Date.now();
  sectionDirty = false;

  // Every contact handed off for a follow-up call (to anyone) leaves the
  // original owner's view entirely — the live `assignments` row itself is
  // left completely untouched, so Users & Assignment never sees this.
  const { data: followUps, error: followUpError } = await supabase
    .from("follow_up_assignments")
    .select("id,status,submitted_at,assigned_at,event_code,contact_id,user_name,contacts(id,name,mob_no,ws,sessions_count,core_cultivation,gyc_status,company_name)");
  if (followUpError) console.error("Could not load follow-up assignments:", followUpError.message);

  const handedOffKeys = new Set((followUps || []).map((f) => `${f.contact_id}|${f.event_code}`));
  const visibleAssignments = (assignments || []).filter((a) => !handedOffKeys.has(`${a.contact_id}|${a.event_code}`));
  const myFollowUps = (followUps || []).filter((f) => f.user_name === currentUser.user_name);

  visibleAssignments.forEach(ensureCardState);
  myFollowUps.forEach(ensureCardState);
  sortBySubmission(visibleAssignments);
  sortBySubmission(myFollowUps);

  // Follow Up Calls only ever shows contacts an admin explicitly handed off
  // via follow_up_assignments — a caller's own "Need to Call Again" /
  // "Available on Weekend" contacts stay in the main list until an admin
  // moves them.
  const followUpSection = myFollowUps.map((f) => ({ ...f, __source: "followup" }));

  const allMobNos = [...visibleAssignments, ...myFollowUps].map((x) => x.contacts.mob_no);
  const weekCallCounts = {};
  if (allMobNos.length) {
    const { data: weekCalls } = await supabase
      .from("call_responses")
      .select("mob_no")
      .in("mob_no", allMobNos)
      .gte("ts", startOfLast4Weeks().toISOString());
    (weekCalls || []).forEach((r) => { weekCallCounts[r.mob_no] = (weekCallCounts[r.mob_no] || 0) + 1; });
  }

  if (!visibleAssignments.length) {
    listEl.innerHTML = `<p class="loading-row">No contacts assigned to you yet.</p>`;
  } else {
    listEl.innerHTML = visibleAssignments.map((a) => renderCard(a, weekCallCounts[a.contacts.mob_no] || 0)).join("");
    wireCard(listEl, visibleAssignments);
  }
  updateStatsBar(visibleAssignments, followUpSection);

  const followUpListEl = document.getElementById("caller-followup-cards");
  document.getElementById("caller-followup-count").textContent = followUpSection.length;
  if (!followUpSection.length) {
    followUpListEl.innerHTML = `<p class="loading-row">No follow-up calls right now.</p>`;
  } else {
    followUpListEl.innerHTML = followUpSection.map((item) => renderCard(item, weekCallCounts[item.contacts.mob_no] || 0)).join("");
    wireCard(followUpListEl, followUpSection);
  }

  applySearchFilter();
}

function renderCard(a, weekCallCount) {
  const c = a.contacts;
  const st = cardState.get(a.id);
  const submittedLabel = st.submitted && st.lastStatus === a.status;
  const category = statusCategory(a.status);
  return `
    <div class="call-card" data-assignment-id="${a.id}" data-contact-id="${c.id}" data-source="${a.__source || "assignments"}">
      <div class="call-card-row1">
        <select class="ws-select" data-ws="${c.ws || "NA"}">
          ${WS_OPTIONS.map((o) => `<option value="${o}" ${o === (c.ws || "NA") ? "selected" : ""}>${o}</option>`).join("")}
        </select>
        <span class="call-card-name-wrap">
          ${cardNameDisplayHtml(c.name)}
          <span class="name-edit-wrap hidden">
            <input type="text" class="name-edit-input" value="${escapeHtml(c.name || "")}" />
            <button type="button" class="name-save-btn" title="Save">✓</button>
            <button type="button" class="name-cancel-btn" title="Cancel">✕</button>
          </span>
        </span>
      </div>
      <div class="call-card-row2">
        <div class="card-badges">
          <span class="calls-link" style="cursor:default;">🏷️ ${escapeHtml(eventNameByCode[a.event_code] || a.event_code)}</span>
          <button class="sessions-link" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">📋 Sessions: ${c.sessions_count}</button>
          <button class="calls-link" data-mob="${c.mob_no}" data-name="${escapeHtml(c.name)}">📞 Last 4 weeks: ${weekCallCount}</button>
        </div>
        <div class="card-phone-group">
          <a class="phone-pill" href="${telHref(c.mob_no)}">📞 ${formatPhone(c.mob_no)}</a>
          ${gycSelectHtml(c.gyc_status)}
        </div>
      </div>
      <div class="call-card-row3">
        ${statusSelectHtml(STATUS_OPTIONS, a.status || STATUS_DEFAULT, category)}
        ${orgFieldHtml(c.company_name)}
      </div>
      <div class="call-card-review${st.review ? "" : " hidden"}">
        <span class="review-note-text">📝 ${escapeHtml(st.review || "")}</span>
        <button type="button" class="review-note-edit" title="Edit comment">✎</button>
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
  const needsMessage = MESSAGE_REQUIRED_STATUSES.includes(status);
  if (st.called && (st.sent || !needsMessage)) {
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

function wireCard(container, assignments) {
  container.querySelectorAll(".call-card").forEach((card) => {
    const assignmentId = card.dataset.assignmentId;
    const contactId = card.dataset.contactId;
    const source = card.dataset.source || "assignments";
    const a = assignments.find((x) => x.id === assignmentId);
    const c = a.contacts;

    refreshSubmitButton(card, assignmentId);
    wireCardNameEdit(card, contactId, c);

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
      e.target.closest(".status-field").classList.toggle("is-set", !!e.target.value);
      if (e.target.value && e.target.value !== STATUS_DEFAULT) {
        const mandatory = e.target.value === "Others" || !!c.core_cultivation;
        openReviewModal(card, assignmentId, c, mandatory);
      }
      refreshSubmitButton(card, assignmentId);
    });

    card.querySelector(".gyc-select").addEventListener("change", async (e) => {
      const { error } = await supabase.from("contacts").update({ gyc_status: e.target.value || null }).eq("id", contactId);
      if (error) {
        showToast("Could not save GFY/AOMC: " + error.message, "error");
        return;
      }
      c.gyc_status = e.target.value || null;
      e.target.closest(".gyc-field").classList.toggle("is-set", !!c.gyc_status);
      showToast("GFY/AOMC updated", "success", 1200);
    });

    // Lets a caller reopen/adjust the note without having to re-pick the status.
    card.querySelector(".org-input").addEventListener("change", async (e) => {
      if (await saveContactOrg(e.target, contactId, c)) showToast("Org updated", "success", 1200);
    });

    card.querySelector(".review-note-edit").addEventListener("click", () => {
      openReviewModal(card, assignmentId, c, false);
    });

    card.querySelector(".send-btn").addEventListener("click", () => {
      sendWhatsAppMessage(c.mob_no, c.name, messageText);
      cardState.get(assignmentId).sent = true;
      refreshSubmitButton(card, assignmentId);
    });

    card.querySelector(".row-submit-btn").addEventListener("click", () => {
      submitCard(card, assignmentId, contactId, c, a.event_code, source);
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

async function submitCard(card, assignmentId, contactId, contact, eventCode, source = "assignments") {
  const statusSelect = card.querySelector(".status-select");
  const submitBtn = card.querySelector(".row-submit-btn");
  const status = statusSelect.value;
  const addl = (cardState.get(assignmentId).review || "").trim() || null;

  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";
  card.classList.add("row-saving");

  // A follow-up card's outcome is recorded on its own follow_up_assignments
  // row, never on `assignments` — Users & Assignment must never see this write.
  const table = source === "followup" ? "follow_up_assignments" : "assignments";
  const { error: e1 } = await supabase.from(table)
    .update({ status, submitted_at: new Date().toISOString() })
    .eq("id", assignmentId);
  const { error: e2 } = await supabase.from("call_responses").insert({
    caller_name: currentUser.user_name,
    contact_name: contact.name,
    mob_no: contact.mob_no,
    event_code: eventCode,
    remarks: status,
    addl_remarks: addl,
  });

  card.classList.remove("row-saving");

  // The weekly reconcile job cross-checks these against call_responses to
  // catch a submit that silently didn't stick — ok:false is the more
  // important half, since that's the actual data-loss signal.
  logEvent("submit_call", {
    section: "caller-section",
    target: assignmentId,
    meta: { ok: !e1 && !e2, mob_no: contact.mob_no, status, table, source },
  });

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
  card.parentElement.appendChild(card);
  updateStatsBarFromDom();
}

// Lightweight dashboard-only refresh — usable on boot/refresh without loading
// the full My Calls page (which also renders every call card).
export async function refreshDashboardBadge(user) {
  document.getElementById("dash-event-name").textContent = "All Events";

  const { data: assignments } = await supabase
    .from("assignments")
    .select("status")
    .eq("user_name", user.user_name);

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

// Total/Positive/Pending fold in the handed-off follow-up load too, so the
// bar always reflects everything a caller actually owes (main + follow-up).
// The Follow-up tile stays a separate count of how much of that is follow-up.
// Follow-up visibility (auto-reveal once the main list is clear) still keys
// off main-list pending only — a caller shouldn't need to finish follow-ups
// just to have the section reveal itself.
function updateStatsBar(assignments, followUps = []) {
  let positive = 0, mainPending = 0;
  assignments.forEach((a) => {
    const s = (a.status || STATUS_DEFAULT).toLowerCase();
    if (POSITIVE.includes(s)) positive++;
    else if (PENDING.includes(s)) mainPending++;
  });
  let followUpPositive = 0, followUpPending = 0;
  followUps.forEach((f) => {
    const s = (f.status || STATUS_DEFAULT).toLowerCase();
    if (POSITIVE.includes(s)) followUpPositive++;
    else if (PENDING.includes(s)) followUpPending++;
  });
  const total = assignments.length + followUps.length;
  const pending = mainPending + followUpPending;
  document.getElementById("stat-total").textContent = total;
  document.getElementById("stat-positive").textContent = positive + followUpPositive;
  document.getElementById("stat-pending").textContent = pending;
  document.getElementById("stat-followup").textContent = followUps.length;
  updateCompletionBadges(total, pending);
  applyFollowUpVisibility(mainPending);
}

function updateStatsBarFromDom() {
  const mainCards = document.querySelectorAll("#caller-cards .call-card");
  const followUpCards = document.querySelectorAll("#caller-followup-cards .call-card");
  let positive = 0, mainPending = 0;
  mainCards.forEach((card) => {
    const s = card.querySelector(".status-select").value.toLowerCase();
    if (POSITIVE.includes(s)) positive++;
    else if (PENDING.includes(s)) mainPending++;
  });
  let followUpPositive = 0, followUpPending = 0;
  followUpCards.forEach((card) => {
    const s = card.querySelector(".status-select").value.toLowerCase();
    if (POSITIVE.includes(s)) followUpPositive++;
    else if (PENDING.includes(s)) followUpPending++;
  });
  const total = mainCards.length + followUpCards.length;
  const pending = mainPending + followUpPending;
  document.getElementById("stat-total").textContent = total;
  document.getElementById("stat-positive").textContent = positive + followUpPositive;
  document.getElementById("stat-pending").textContent = pending;
  document.getElementById("stat-followup").textContent = followUpCards.length;
  updateCompletionBadges(total, pending);
  applyFollowUpVisibility(mainPending);
}

// Fires the moment a status is picked (any status, not just "Others"), mirroring
// how "Others" used to work on its own. Mandatory for "Others" or a core-cultivated
// contact (no Skip shown, Cancel reverts the status pick); optional otherwise
// (Skip keeps the status but records no comment).
let pendingReview = null;

// Paints the saved comment back onto the card so a caller can always see what
// they already wrote — and so it survives a later status change.
function renderCardReview(card, assignmentId) {
  const text = cardState.get(assignmentId).review || "";
  const row = card.querySelector(".call-card-review");
  row.querySelector(".review-note-text").textContent = text ? `📝 ${text}` : "";
  row.classList.toggle("hidden", !text);
}

function openReviewModal(card, assignmentId, contact, mandatory) {
  pendingReview = { card, assignmentId, mandatory };
  // Pre-fill with whatever was already saved, so re-opening after a status
  // change shows the existing comment instead of a blank box.
  document.getElementById("review-input").value = cardState.get(assignmentId).review || "";
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
    }
    // Skip just closes the box — any comment saved earlier is kept.
    renderCardReview(card, assignmentId);
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
    cardState.get(assignmentId).review = input.value.trim();
    renderCardReview(card, assignmentId);
    refreshSubmitButton(card, assignmentId);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) document.getElementById("review-confirm").click();
  });
}

function historyTimeParts(ts) {
  const d = new Date(ts);
  return {
    date: d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
  };
}

function historyEmptyState(text) {
  return `<div class="history-empty">${escapeHtml(text)}</div>`;
}

async function openHistoryModal(mob, name, kind = "calls") {
  const titleEl = document.getElementById("history-modal-title");
  const countBadge = document.getElementById("history-count-badge");
  const body = document.getElementById("history-body");

  document.getElementById("history-contact-info").textContent = `Contact: ${name} (${formatPhone(mob)})`;
  countBadge.textContent = "";
  body.innerHTML = historyEmptyState("Loading…");
  document.getElementById("history-modal").classList.add("active");

  if (kind === "sessions") {
    titleEl.textContent = "Session Attendance";

    const { data, error } = await supabase
      .from("session_attendance")
      .select("ts,took_by,event_code")
      .eq("mob_no", mob)
      .order("ts", { ascending: false });

    if (error || !data || !data.length) {
      body.innerHTML = historyEmptyState("No sessions attended yet.");
      return;
    }
    countBadge.textContent = `${data.length} session${data.length === 1 ? "" : "s"}`;
    body.innerHTML = data.map((r) => {
      const { date, time } = historyTimeParts(r.ts);
      return `
        <div class="history-item">
          <div class="history-item-head">
            <span class="history-item-datetime"><strong>${date}</strong> · ${time}</span>
            <span class="history-badge history-badge-neutral">${escapeHtml(r.event_code || "—")}</span>
          </div>
          <div class="history-item-meta">Marked by ${escapeHtml(r.took_by)}</div>
        </div>
      `;
    }).join("");
  } else {
    titleEl.textContent = "Call History";

    const { data, error } = await supabase
      .from("call_responses")
      .select("ts,remarks,addl_remarks")
      .eq("mob_no", mob)
      .order("ts", { ascending: false });

    if (error || !data || !data.length) {
      body.innerHTML = historyEmptyState("No call history yet.");
      return;
    }
    countBadge.textContent = `${data.length} call${data.length === 1 ? "" : "s"}`;
    body.innerHTML = data.map((r) => {
      const { date, time } = historyTimeParts(r.ts);
      const status = r.remarks || "—";
      return `
        <div class="history-item">
          <div class="history-item-head">
            <span class="history-item-datetime"><strong>${date}</strong> · ${time}</span>
            <span class="history-badge history-badge-${statusCategory(status)}">${escapeHtml(status)}</span>
          </div>
          ${r.addl_remarks ? `<div class="history-item-note">${escapeHtml(r.addl_remarks)}</div>` : ""}
        </div>
      `;
    }).join("");
  }
}

function wireHistoryModal() {
  const modal = document.getElementById("history-modal");
  document.getElementById("history-close").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
}

// Coalesces a burst of individual row-change events (e.g. an admin bulk
// reassignment touching dozens of rows in one go) into a single reload
// instead of one per row.
const scheduleReload = debounce(() => loadAndRenderCards(), 400);

function onRelevantChange() {
  if (document.getElementById("caller-section").classList.contains("hidden")) {
    // Nothing on screen to update right now, and reloading into a hidden
    // section would just be thrown away — instead flag the cache in init()
    // above as stale so the *next* visit fetches for real regardless of TTL.
    sectionDirty = true;
    return;
  }
  scheduleReload();
}

let realtimeWired = false;
function subscribeRealtime() {
  if (realtimeWired) return;
  realtimeWired = true;
  supabase
    .channel("assignments-live")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "assignments", filter: `user_name=eq.${currentUser.user_name}` },
      onRelevantChange
    )
    .subscribe();

  // Unfiltered at the Postgres level (a hand-off of one of *my* contacts to
  // someone else lands as a row I don't own, but I still need to react to it
  // to hide that contact) — filtered here in JS instead against
  // myAssignmentKeys, so a change between two *other* callers' follow-ups
  // (the overwhelming majority of rows on this table) costs nothing and
  // never touches every other caller's session the way an unfiltered
  // requery-on-every-event handler used to.
  supabase
    .channel("follow-up-assignments-live")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "follow_up_assignments" },
      (payload) => {
        const rec = payload.new || payload.old;
        if (!rec) return;
        const relevant = rec.user_name === currentUser.user_name || myAssignmentKeys.has(`${rec.contact_id}|${rec.event_code}`);
        if (!relevant) return;
        onRelevantChange();
      }
    )
    .subscribe();
}
