import { supabase, setAuditUser } from "./supabaseClient.js";

const SESSION_KEY = "nrg_session";

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const user = raw ? JSON.parse(raw) : null;
    if (user) setAuditUser(user.id);
    return user;
  } catch {
    return null;
  }
}

export function setSession(user) {
  setAuditUser(user.id);
  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
}

export function clearSession() {
  setAuditUser(null);
  localStorage.removeItem(SESSION_KEY);
}

export async function login(userName, password) {
  const { data, error } = await supabase
    .from("users")
    .select("id,user_name,login_pw,role,call_limit,auto_assign,commander,allowed_pages,allowed_trip_events")
    .ilike("user_name", userName.trim())
    .limit(1);

  if (error) return { ok: false, message: "Could not reach the server. Please try again." };
  const row = data && data[0];
  if (!row) return { ok: false, message: "User not found." };
  if (row.login_pw !== password.trim()) return { ok: false, message: "Incorrect password." };

  const user = { id: row.id, user_name: row.user_name, role: row.role, call_limit: row.call_limit, auto_assign: row.auto_assign, commander: row.commander, login_pw: row.login_pw, allowed_pages: row.allowed_pages, allowed_trip_events: row.allowed_trip_events };
  setSession(user);
  return { ok: true, user };
}

// Cached sessions predate fields added later (e.g. commander) — refetch the
// user's row on boot so a stale localStorage session self-heals instead of
// requiring a manual logout/login.
export async function refreshSession(existing) {
  const { data, error } = await supabase
    .from("users")
    .select("id,user_name,role,call_limit,auto_assign,commander,allowed_pages,allowed_trip_events")
    .eq("id", existing.id)
    .limit(1);
  const row = data && data[0];
  if (error || !row) return existing;

  const user = { ...existing, role: row.role, call_limit: row.call_limit, auto_assign: row.auto_assign, commander: row.commander, allowed_pages: row.allowed_pages, allowed_trip_events: row.allowed_trip_events };
  setSession(user);
  return user;
}

export function logout() {
  clearSession();
  location.reload();
}
