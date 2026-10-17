// Column-width / PDF-width settings are shared by every user: they live in the
// ui_layouts table (key -> jsonb) instead of one browser's localStorage. They are
// loaded once at start-up (and again when the tab comes back after a minute or more),
// kept in memory, and written back a moment after each change. If the table isn't
// there yet (supabase/ui-layouts.sql not run) everything falls back to this device's
// localStorage, as before. Settings an earlier version saved in this browser are
// uploaded the first time they are seen and then removed locally.
import { supabase } from "./supabaseClient.js";

const LOCAL_PREFIXES = ["nrg-col-layout:", "nrg-pdf-layout:"];
let cache = new Map();
let remoteOk = false;
let lastLoad = 0;
const timers = new Map();

const readLocal = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };

export function getLayout(key) {
  if (cache.has(key)) return cache.get(key);
  return remoteOk ? null : readLocal(key);
}

export function setLayout(key, value) {
  if (value == null) cache.delete(key); else cache.set(key, value);
  if (!remoteOk) {
    try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ }
    return;
  }
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    const q = value == null
      ? supabase.from("ui_layouts").delete().eq("key", key)
      : supabase.from("ui_layouts").upsert({ key, value, updated_at: new Date().toISOString() });
    q.then(({ error }) => { if (error) console.warn("Could not save layout:", error.message); });
  }, 400));
}

export async function loadLayouts() {
  try {
    const { data, error } = await supabase.from("ui_layouts").select("key,value");
    if (error) throw error;
    cache = new Map((data || []).map((r) => [r.key, r.value]));
    remoteOk = true;
    // carry over what this browser saved before layouts were shared, without overriding shared ones
    const mine = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && LOCAL_PREFIXES.some((p) => k.startsWith(p))) mine.push(k);
    }
    const up = [];
    mine.forEach((k) => {
      const v = readLocal(k);
      if (!cache.has(k) && v && typeof v === "object" && Object.keys(v).length) { cache.set(k, v); up.push({ key: k, value: v }); }
    });
    if (up.length) await supabase.from("ui_layouts").upsert(up);
    mine.forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
  } catch {
    remoteOk = false;
  }
  lastLoad = Date.now();
  return remoteOk;
}

export const layoutsStale = () => Date.now() - lastLoad > 60000;
