// NRG Caller — sends Web Push notifications.
//
// Invoked by notify_push_bridge() (see supabase/push-notifications.sql) via
// pg_net whenever a row is inserted into a table that trigger watches. Body
// is always { table, record } — the same shape notify_sheets_bridge posts to
// Apps Script. This function decides who the notification is for based on
// `table`, looks up their push_subscriptions, and delivers via Web Push.
//
// Secrets needed (set once, never exposed to the client):
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY  — from `npx web-push generate-vapid-keys`
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto-provided by Supabase

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;

webpush.setVapidDetails("mailto:webdeveloper@hkmhyderabad.org", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Notification = { userNames: string[]; title: string; body: string; url: string };

// Decide who should be notified and what each notification says, given the
// table + payload that triggered this call. Returns one entry per distinct
// message — e.g. a bulk assignment produces one entry per affected caller
// (each with their own count), not one per row.
async function resolveNotifications(
  supabase: ReturnType<typeof createClient>,
  table: string,
  payload: Record<string, unknown>,
): Promise<Notification[]> {
  if (table === "assignments") {
    const groups = (payload.groups as { user_name: string; count: number }[]) ?? [];
    return groups.map((g) => ({
      userNames: [g.user_name],
      title: g.count === 1 ? "New contact assigned" : "New contacts assigned",
      body: g.count === 1
        ? "You've been assigned a new contact to call."
        : `You've been assigned ${g.count} new contacts to call.`,
      url: "/",
    }));
  }

  if (table === "help_requests") {
    const record = payload.record as Record<string, unknown>;
    const { data: admins } = await supabase.from("users").select("user_name").eq("role", "Admin");
    const message = String(record.message ?? "");
    return [{
      userNames: (admins ?? []).map((a) => a.user_name as string),
      title: "New One to One message",
      body: message.length > 120 ? message.slice(0, 117) + "..." : message,
      url: "/",
    }];
  }

  return [];
}

const PENDING_STATUSES = new Set(["not done", "yet to call", ""]);

// Mirrors app/js/caller.js's refreshDashboardBadge (assignments pending) and
// app/js/coreCultivation.js's refreshDashboardBadge (contacts this cultivator
// hasn't logged a call for yet) — kept in sync with those so the OS app-icon
// badge always matches what the in-app dashboard dots show.
async function computeBadgeCount(supabase: ReturnType<typeof createClient>, userName: string): Promise<number> {
  const [{ data: assignments }, { data: ccContacts }] = await Promise.all([
    supabase.from("assignments").select("status").eq("user_name", userName),
    supabase.from("contacts").select("mob_no").eq("core_cultivation", userName),
  ]);

  const myCallsPending = (assignments ?? []).filter((a) =>
    PENDING_STATUSES.has(String(a.status ?? "").toLowerCase())
  ).length;

  let ccPending = 0;
  if (ccContacts && ccContacts.length) {
    const mobNos = ccContacts.map((c) => c.mob_no);
    const { data: history } = await supabase
      .from("call_responses")
      .select("mob_no, remarks, ts")
      .eq("caller_name", userName)
      .in("mob_no", mobNos)
      .order("ts", { ascending: false });

    const lastStatusByMob: Record<string, string> = {};
    (history ?? []).forEach((r) => {
      if (!(r.mob_no in lastStatusByMob)) lastStatusByMob[r.mob_no as string] = r.remarks as string;
    });

    ccPending = ccContacts.filter((c) =>
      PENDING_STATUSES.has(String(lastStatusByMob[c.mob_no as string] ?? "").toLowerCase())
    ).length;
  }

  return myCallsPending + ccPending;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { table } = body;
    if (!table) return json({ error: "missing table" }, 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const notifications = await resolveNotifications(supabase, table, body);
    if (!notifications.length) return json({ sent: 0, reason: "no recipients" });

    let sent = 0;
    const staleIds = new Set<string>();

    for (const notification of notifications) {
      if (!notification.userNames.length) continue;

      const { data: subs, error } = await supabase
        .from("push_subscriptions")
        .select("id, user_name, endpoint, p256dh, auth")
        .in("user_name", notification.userNames);
      if (error) throw error;
      if (!subs || !subs.length) continue;

      // Each recipient sees their own badge total, not the count of this one
      // event — compute it once per distinct user in this batch.
      const badgeCountByUser = new Map<string, number>();
      await Promise.all([...new Set(subs.map((s) => s.user_name as string))].map(async (userName) => {
        badgeCountByUser.set(userName, await computeBadgeCount(supabase, userName));
      }));

      await Promise.all(subs.map(async (sub) => {
        const payload = JSON.stringify({
          title: notification.title,
          body: notification.body,
          url: notification.url,
          badgeCount: badgeCountByUser.get(sub.user_name as string) ?? 0,
        });
        try {
          // urgency: "high" + a short TTL tells Android's push service (FCM)
          // to wake the device immediately instead of batching delivery for
          // the next time it's idle/awake (the default behavior otherwise,
          // which shows the notification only once the phone/app is opened).
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { urgency: "high", TTL: 60 },
          );
          sent++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) staleIds.add(sub.id as string);
          else console.error("push send failed:", sub.endpoint, err);
        }
      }));
    }

    if (staleIds.size) await supabase.from("push_subscriptions").delete().in("id", [...staleIds]);

    return json({ sent, stale: staleIds.size });
  } catch (err) {
    console.error("send-push error:", err);
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
