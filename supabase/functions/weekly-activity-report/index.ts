// Weekly activity-log review: summarizes a week of app usage (which
// sections got visited, how many were real backend loads vs. cache hits,
// which write actions happened) and cross-checks every logged call
// submission against call_responses to flag one that silently didn't stick —
// then deletes the rows it just processed. See supabase/activity-log.sql for
// the table and app/js/activityLog.js for what writes into it.
//
// Pinged (fire-and-forget) once per admin page load from app/js/admin.js
// (maybeRunWeeklyActivityReport), same pattern as maybeRunWeeklyDbExport.
// This function is the actual gate: it checks
// settings.weekly_activity_report_last_run and only does real work if 7+
// days have passed, so pinging it more often than weekly is harmless.
//
// Reuses the same SMTP secrets as weekly-db-export — no new secrets needed:
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / DB_EXPORT_TO

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SMTP_HOST = Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com";
const SMTP_PORT = Number(Deno.env.get("SMTP_PORT") ?? "465");
const SMTP_USER = Deno.env.get("SMTP_USER") ?? "";
const SMTP_PASS = Deno.env.get("SMTP_PASS") ?? "";
const REPORT_TO = Deno.env.get("DB_EXPORT_TO") ?? "snkdasa@gmail.com";

const LAST_RUN_KEY = "weekly_activity_report_last_run";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// A submit_call logged as ok:true should show up in call_responses within
// minutes — this is generous slack for clock skew / retry timing, not a
// real-world expectation of a slow write.
const RECONCILE_WINDOW_MS = 15 * 60 * 1000;

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

async function fetchAllRows(supabase: ReturnType<typeof createClient>, table: string, filters?: (q: any) => any) {
  const pageSize = 1000;
  let from = 0;
  const rows: Record<string, unknown>[] = [];
  while (true) {
    let q = supabase.from(table).select("*").range(from, from + pageSize - 1);
    if (filters) q = filters(q);
    const { data, error } = await q;
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

    const windowEnd = new Date().toISOString();
    const logRows = await fetchAllRows(supabase, "activity_log", (q) => q.lte("ts", windowEnd).order("ts", { ascending: true }));

    if (!logRows.length) {
      await supabase.from("settings").upsert({ key: LAST_RUN_KEY, value: new Date().toISOString() });
      return json({ sent: false, reason: "no activity logged this window", rows: 0 });
    }

    // ---- aggregate ----
    const bySection = new Map<string, { visits: number; realLoads: number }>();
    const byAction = new Map<string, number>();
    const byUser = new Map<string, number>();
    const submits: Record<string, unknown>[] = [];

    for (const r of logRows) {
      byAction.set(r.action as string, (byAction.get(r.action as string) || 0) + 1);
      byUser.set(r.user_name as string, (byUser.get(r.user_name as string) || 0) + 1);

      let meta: Record<string, unknown> | null = null;
      if (typeof r.meta === "string") { try { meta = JSON.parse(r.meta); } catch { meta = null; } }
      else if (r.meta && typeof r.meta === "object") meta = r.meta as Record<string, unknown>;

      if (r.action === "nav_section" && r.section) {
        const cur = bySection.get(r.section as string) || { visits: 0, realLoads: 0 };
        cur.visits++;
        if (meta?.loaded) cur.realLoads++;
        bySection.set(r.section as string, cur);
      }
      if (r.action === "submit_call") submits.push({ ...r, meta });
    }

    // ---- reconcile submit_call against call_responses ----
    const minTs = logRows[0].ts as string;
    const candidates = submits.filter((s) => (s.meta as any)?.ok);
    const mobNos = [...new Set(candidates.map((s) => (s.meta as any)?.mob_no).filter(Boolean))];
    let responses: Record<string, unknown>[] = [];
    if (mobNos.length) {
      const { data } = await supabase
        .from("call_responses")
        .select("mob_no,remarks,ts")
        .in("mob_no", mobNos)
        .gte("ts", new Date(new Date(minTs).getTime() - RECONCILE_WINDOW_MS).toISOString());
      responses = data ?? [];
    }
    const missing = candidates.filter((s) => {
      const meta = s.meta as any;
      const loggedTs = new Date(s.ts as string).getTime();
      return !responses.some((r) =>
        r.mob_no === meta.mob_no &&
        r.remarks === meta.status &&
        Math.abs(new Date(r.ts as string).getTime() - loggedTs) <= RECONCILE_WINDOW_MS
      );
    });
    const knownFailed = submits.filter((s) => (s.meta as any)?.ok === false);

    // ---- build workbook ----
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Section", "Visits", "Real loads", "Cache hits"],
      ...[...bySection.entries()].sort((a, b) => b[1].visits - a[1].visits)
        .map(([s, c]) => [s, c.visits, c.realLoads, c.visits - c.realLoads]),
    ]), "Section Visits");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Action", "Count"],
      ...[...byAction.entries()].sort((a, b) => b[1] - a[1]),
    ]), "Actions");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["User", "Events"],
      ...[...byUser.entries()].sort((a, b) => b[1] - a[1]),
    ]), "By User");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Time", "User", "Mob No", "Status", "Section"],
      ...missing.map((s) => [s.ts, s.user_name, (s.meta as any)?.mob_no, (s.meta as any)?.status, s.section]),
    ]), "Possible Data Loss");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Time", "User", "Mob No", "Status", "Section"],
      ...knownFailed.map((s) => [s.ts, s.user_name, (s.meta as any)?.mob_no, (s.meta as any)?.status, s.section]),
    ]), "Known Failed Submits");

    const base64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" }) as string;
    const today = new Date().toISOString().slice(0, 10);

    if (SMTP_USER && SMTP_PASS) {
      const client = new SMTPClient({
        connection: { hostname: SMTP_HOST, port: SMTP_PORT, tls: true, auth: { username: SMTP_USER, password: SMTP_PASS } },
      });
      await client.send({
        from: SMTP_USER,
        to: REPORT_TO,
        subject: `NRG Caller — Weekly Activity Report (${today})`,
        content:
          `Automated weekly usage review from the NRG Caller app.\n\n` +
          `${logRows.length} events logged this window across ${byUser.size} user(s).\n` +
          `${missing.length} call submission(s) could not be confirmed in call_responses — see the ` +
          `"Possible Data Loss" sheet.\n` +
          `${knownFailed.length} submission(s) the app itself already reported as failed at the time.\n\n` +
          `These rows have now been deleted from activity_log — this report is the only copy.`,
        attachments: [{
          filename: `NRG_Caller_Activity_Report_${today}.xlsx`,
          content: base64,
          encoding: "base64",
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }],
      });
      await client.close();
    }

    // ---- purge what we just processed ----
    const maxId = Math.max(...logRows.map((r) => Number(r.id)));
    await supabase.from("activity_log").delete().lte("id", maxId);

    await supabase.from("settings").upsert({ key: LAST_RUN_KEY, value: new Date().toISOString() });

    return json({ sent: !!(SMTP_USER && SMTP_PASS), rows: logRows.length, missing: missing.length, knownFailed: knownFailed.length });
  } catch (err) {
    console.error("weekly-activity-report error:", err);
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
