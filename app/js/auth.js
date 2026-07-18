import { supabase } from "./supabaseClient.js";

const SESSION_KEY = "nrg_session";

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSession(user) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

export async function login(userName, password) {
  const { data, error } = await supabase
    .from("users")
    .select("id,user_name,login_pw,role,call_limit,auto_assign")
    .ilike("user_name", userName.trim())
    .limit(1);

  if (error) return { ok: false, message: "Could not reach the server. Please try again." };
  const row = data && data[0];
  if (!row) return { ok: false, message: "User not found." };
  if (row.login_pw !== password.trim()) return { ok: false, message: "Incorrect password." };

  const user = { id: row.id, user_name: row.user_name, role: row.role, call_limit: row.call_limit, auto_assign: row.auto_assign };
  setSession(user);
  return { ok: true, user };
}

export function logout() {
  clearSession();
  location.reload();
}
