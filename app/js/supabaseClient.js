import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// Tags every request with the logged-in user's id so the DB-side audit
// trigger (supabase/audit-log.sql) can record who made each change — see
// auth.js, which calls setAuditUser() whenever a session is set/loaded/
// cleared. A custom `global.fetch` is the only reliable way to inject a
// per-request header after the client already exists, since supabase-js
// copies `global.headers` once at createClient() time.
let auditUserId = null;
export function setAuditUser(id) {
  auditUserId = id ?? null;
}

function auditFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (auditUserId != null) headers.set("x-app-user", String(auditUserId));
  return fetch(url, { ...options, headers });
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
  global: { fetch: auditFetch },
});
