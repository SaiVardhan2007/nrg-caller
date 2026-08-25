// Weekly full-database backup, emailed as an .xlsx attachment.
//
// Pinged (fire-and-forget) once per admin page load from app/js/admin.js
// (maybeRunWeeklyDbExport). This function is the actual gate: it checks
// settings.weekly_db_export_last_run and only does real work if 7+ days
// have passed, so pinging it more often than weekly is harmless.
//
// Required secrets (set with `supabase secrets set`):
//   SMTP_HOST  (defaults to smtp.gmail.com)
//   SMTP_PORT  (defaults to 465)
//   SMTP_USER  — the Gmail address sending the backup
//   SMTP_PASS  — a 16-char Gmail App Password (not the normal account password)
//   DB_EXPORT_TO (defaults to snkdasa@gmail.com)
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
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

// Kept in sync with app/js/admin.js's DB_TABLES_FALLBACK — used only if the
// list_app_tables() RPC (schema.sql) isn't deployed on this project yet.
const FALLBACK_TABLES = [
  "users", "contacts", "assignments", "assignment_rounds", "follow_up_assignments",
  "call_responses", "session_attendance", "events", "settings", "help_requests",
  "one_to_one_remarks", "contact_collection", "book_places", "book_inward_stock",
  "book_outward_stock", "book_standard_prices", "book_requests", "book_expenses", "fnrg_sadhana",
];

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

async function fetchAllRows(supabase: ReturnType<typeof createClient>, table: string) {
  const pageSize = 1000;
  let from = 0;
  const rows: Record<string, unknown>[] = [];
  while (true) {
    const { data, error } = await supabase.from(table).select("*").range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: settingRow } = await supabase
      .from("settings").select("value").eq("key", LAST_RUN_KEY).maybeSingle();
    const lastRun = settingRow?.value ? new Date(settingRow.value as string).getTime() : 0;
    const force = new URL(req.url).searchParams.get("force") === "1";

    if (!force && Date.now() - lastRun < WEEK_MS) {
      return json({ skipped: true, reason: "ran within the last 7 days", lastRun: settingRow?.value ?? null });
    }

    let tables = FALLBACK_TABLES;
    const { data: liveTables } = await supabase.rpc("list_app_tables");
    if (Array.isArray(liveTables) && liveTables.length) tables = liveTables as string[];

    const wb = XLSX.utils.book_new();
    let totalRows = 0;
    for (const table of tables) {
      let rows: Record<string, unknown>[] = [];
      try {
        rows = await fetchAllRows(supabase, table);
      } catch (err) {
        console.warn(`weekly-db-export: could not fetch ${table}:`, (err as Error).message);
      }
      totalRows += rows.length;
      const aoa = rows.length
        ? [Object.keys(rows[0]), ...rows.map((row) =>
            Object.keys(rows[0]).map((h) => {
              const v = row[h];
              return v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v;
            }))]
        : [["(empty)"]];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws, table.slice(0, 31));
    }

    const base64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" }) as string;
    const today = new Date().toISOString().slice(0, 10);

    if (!SMTP_USER || !SMTP_PASS) {
      return json({ error: "SMTP_USER/SMTP_PASS secrets are not set — run `supabase secrets set`" }, 500);
    }

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
        `(${tables.length} tables, ${totalRows} rows total), one sheet per table, in Excel format.\n\n` +
        `This runs automatically at most once every 7 days — triggered the next time an admin opens ` +
        `the app after 7 days have passed since the last run. No action is needed unless you want to ` +
        `review or archive this data.`,
      attachments: [{
        filename: `FNRG_Preaching_Full_DB_${today}.xlsx`,
        content: base64,
        encoding: "base64",
      }],
    });
    await client.close();

    await supabase.from("settings").upsert({ key: LAST_RUN_KEY, value: new Date().toISOString() });

    return json({ sent: true, tables: tables.length, rows: totalRows });
  } catch (err) {
    console.error("weekly-db-export error:", err);
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
