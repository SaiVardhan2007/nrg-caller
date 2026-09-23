// Weekly full-database backup, emailed as an .xlsx attachment.
//
// The actual .xlsx file is built client-side in the browser (see
// buildFullDbWorkbook/maybeRunWeeklyDbExport in app/js/admin.js) — the same
// code path the admin panel's "Download All DB Data" button already uses,
// which works fine because a browser tab has no CPU/memory ceiling.
// Building that same workbook inside this edge function used to blow past
// Supabase's per-invocation resource limit (WORKER_RESOURCE_LIMIT), killing
// the isolate before it ever sent an email. So this function no longer
// touches the database or the `xlsx` library at all — it's a thin mailer:
//
//   GET  — "is it time to run yet?" check (reads settings.weekly_db_export_last_run)
//   POST — { base64, tables, rows } already-built file → emails it, updates last-run
//
// Pinged once per admin page load from app/js/admin.js (maybeRunWeeklyDbExport).
//
// Required secrets (set with `supabase secrets set`):
//   SMTP_HOST  (defaults to smtp.gmail.com)
//   SMTP_PORT  (defaults to 465)
//   SMTP_USER  — the Gmail address sending the backup
//   SMTP_PASS  — a 16-char Gmail App Password (not the normal account password)
//   DB_EXPORT_TO (defaults to snkdasa@gmail.com)
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SMTP_HOST = Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com";
const SMTP_PORT = Number(Deno.env.get("SMTP_PORT") ?? "465");
const SMTP_USER = Deno.env.get("SMTP_USER") ?? "";
const SMTP_PASS = Deno.env.get("SMTP_PASS") ?? "";
const DB_EXPORT_TO = Deno.env.get("DB_EXPORT_TO") ?? "snkdasa@gmail.com";

const LAST_RUN_KEY = "weekly_db_export_last_run";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const force = new URL(req.url).searchParams.get("force") === "1";

    const { data: settingRow } = await supabase
      .from("settings").select("value").eq("key", LAST_RUN_KEY).maybeSingle();
    const lastRun = settingRow?.value ? new Date(settingRow.value as string).getTime() : 0;
    const dueToRun = force || Date.now() - lastRun >= WEEK_MS;

    if (req.method === "GET") {
      return json({ shouldRun: dueToRun, lastRun: settingRow?.value ?? null });
    }

    if (req.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    if (!dueToRun) {
      return json({ skipped: true, reason: "ran within the last 7 days", lastRun: settingRow?.value ?? null });
    }

    const body = await req.json().catch(() => ({}));
    const base64 = body?.base64;
    const tables = Number(body?.tables ?? 0);
    const rows = Number(body?.rows ?? 0);
    if (!base64 || typeof base64 !== "string") {
      return json({ error: "missing base64 file content in request body" }, 400);
    }

    if (!SMTP_USER || !SMTP_PASS) {
      return json({ error: "SMTP_USER/SMTP_PASS secrets are not set — run `supabase secrets set`" }, 500);
    }

    const today = new Date().toISOString().slice(0, 10);
    const client = new SMTPClient({
      connection: {
        hostname: SMTP_HOST,
        port: SMTP_PORT,
        tls: true,
        auth: { username: SMTP_USER, password: SMTP_PASS },
      },
    });

    await client.send({
      from: SMTP_USER,
      to: DB_EXPORT_TO,
      subject: `NRG Caller — Weekly Full Database Backup (${today})`,
      content:
        `Automated weekly backup from the NRG Caller app.\n\n` +
        `Attached is a full export of every table in the database as of ${today} ` +
        `(${tables} tables, ${rows} rows total), one sheet per table, in Excel format.\n\n` +
        `This runs automatically at most once every 7 days — triggered the next time an admin opens ` +
        `the app after 7 days have passed since the last run. No action is needed unless you want to ` +
        `review or archive this data.`,
      attachments: [{
        filename: `FNRG_Preaching_Full_DB_${today}.xlsx`,
        content: base64,
        encoding: "base64",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }],
    });
    await client.close();

    await supabase.from("settings").upsert({ key: LAST_RUN_KEY, value: new Date().toISOString() });

    return json({ sent: true, tables, rows });
  } catch (err) {
    console.error("weekly-db-export error:", err);
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
