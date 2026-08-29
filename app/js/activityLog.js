import { supabase } from "./supabaseClient.js";

// Weekly-reviewed usage log — see supabase/activity-log.sql for the table
// and supabase/functions/weekly-activity-report for the reconcile-and-purge
// job. Deliberately logs structured events (which section, which action),
// not raw DOM clicks or full row payloads — that's what actually answers
// "where is usage concentrated" without drowning the weekly review in noise,
// and it's what this session's whole egress audit was measured against.
//
// Batched on purpose: every logEvent() call just pushes into an in-memory
// (and localStorage-backed) queue. One flush — a single multi-row insert —
// goes out every FLUSH_INTERVAL_MS instead of one request per event, so this
// logger's own network cost stays close to zero regardless of how chatty a
// session is.

const FLUSH_INTERVAL_MS = 25 * 1000;
const MAX_BATCH = 200; // caps a single flush payload; also the point at which a burst forces an early flush
const STORAGE_KEY = "nrg_activity_log_pending_v1";

let queue = [];
let currentUser = null;
let sessionId = null;
let flushTimer = null;
let flushing = false;
let wired = false;

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    if (Array.isArray(saved) && saved.length) queue = saved.concat(queue);
  } catch {
    // corrupt or unavailable storage — logging is best-effort, never worth breaking the app over
  }
}

function persist() {
  try {
    // Cap what we persist, not just what we hold in memory — a session that
    // never successfully flushes (offline device left logged in) shouldn't
    // grow localStorage without bound.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue.slice(-MAX_BATCH * 2)));
  } catch {
    // ignore — same reasoning as above
  }
}

export function initActivityLog(user) {
  currentUser = user;
  if (!sessionId) sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (wired) return;
  wired = true;
  loadPersisted();
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  window.addEventListener("beforeunload", () => { flush(); });
}

export function logEvent(action, { section = null, target = null, meta = null } = {}) {
  if (!currentUser) return;
  queue.push({
    ts: new Date().toISOString(),
    user_name: currentUser.user_name,
    role: currentUser.role || null,
    session_id: sessionId,
    action,
    section,
    target,
    // meta is a jsonb column — pass the object itself, not a JSON string,
    // or Postgres stores a double-encoded jsonb *string* scalar and every
    // ->> / #> query on it comes back null. Still cap size so one
    // unexpectedly large payload can't balloon a batch.
    meta: meta && JSON.stringify(meta).length > 2000 ? { truncated: true } : meta,
  });
  if (queue.length >= MAX_BATCH) flush();
  else persist();
}

async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  const batch = queue.splice(0, MAX_BATCH);
  persist();
  try {
    const { error } = await supabase.from("activity_log").insert(batch);
    if (error) throw error;
  } catch {
    // Never let a logging failure surface to the user or lose events —
    // put the batch back and let the next timer tick retry it.
    queue = batch.concat(queue);
    persist();
  } finally {
    flushing = false;
  }
}
