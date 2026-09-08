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

// Decide who should be notified and what the notification says, given the
// table + row that triggered this call. Returns null if this table/record
// isn't one we notify on (defensive — the trigger only fires for these two
// tables today, but new triggers may be added later without updating this).
async function resolveNotification(
  supabase: ReturnType<typeof createClient>,
  table: string,
  record: Record<string, unknown>,
): Promise<{ userNames: string[]; title: string; body: string; url: string } | null> {
  if (table === "assignments") {
    return {
      userNames: [record.user_name as string],
      title: "New contact assigned",
      body: "You've been assigned a new contact to call.",
      url: "/",
    };
  }

  if (table === "help_requests") {
    const { data: admins } = await supabase.from("users").select("user_name").eq("role", "Admin");
    const message = String(record.message ?? "");
    return {
      userNames: (admins ?? []).map((a) => a.user_name as string),
      title: "New One to One message",
      body: message.length > 120 ? message.slice(0, 117) + "..." : message,
      url: "/",
    };
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { table, record } = await req.json();
    if (!table || !record) return json({ error: "missing table/record" }, 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const notification = await resolveNotification(supabase, table, record);
    if (!notification || !notification.userNames.length) {
      return json({ sent: 0, reason: "no recipients" });
    }

    const { data: subs, error } = await supabase
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .in("user_name", notification.userNames);
    if (error) throw error;
    if (!subs || !subs.length) return json({ sent: 0, reason: "no subscriptions for recipients" });

    const payload = JSON.stringify({ title: notification.title, body: notification.body, url: notification.url });

    let sent = 0;
    const staleIds: string[] = [];
    await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) staleIds.push(sub.id as string);
        else console.error("push send failed:", sub.endpoint, err);
      }
    }));

    if (staleIds.length) await supabase.from("push_subscriptions").delete().in("id", staleIds);

    return json({ sent, stale: staleIds.length });
  } catch (err) {
    console.error("send-push error:", err);
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
