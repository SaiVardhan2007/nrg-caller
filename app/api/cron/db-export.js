// Vercel Cron entry point for the full-database backup email.
//
// Replaces the old "ping on admin page load, hope 7 days passed" trigger
// (app/js/admin.js maybeRunWeeklyDbExport) with a precise daily schedule —
// see vercel.json for the cron expression.
//
// Both the workbook build AND the SMTP send happen right here in this Node
// function. It used to call the Supabase `weekly-db-export` Edge Function to
// send the mail, but that function kept dying with WORKER_RESOURCE_LIMIT —
// not because it builds the file (it doesn't, this does), but because just
// receiving/relaying the ~5MB base64 attachment and running the SMTP client
// inside Deno's isolate was itself enough to blow the resource ceiling as the
// database grew. A Vercel Node function has real memory/CPU headroom, so it
// builds the workbook, emails it directly via SMTP, and records the last-run
// timestamp — no Edge Function in the path at all.
//
// Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on
// cron-triggered requests when the CRON_SECRET env var is set — this checks
// that header so the endpoint can't be triggered by anyone else who finds
// the URL.
//
// Required Vercel env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// CRON_SECRET, SMTP_HOST (defaults to smtp.gmail.com), SMTP_PORT (defaults
// to 465), SMTP_USER, SMTP_PASS (a Gmail App Password), DB_EXPORT_TO.

const XLSX = require("xlsx");
const nodemailer = require("nodemailer");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || "465");
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const DB_EXPORT_TO = process.env.DB_EXPORT_TO;

const LAST_RUN_KEY = "weekly_db_export_last_run";

async function fetchAllRows(table) {
  const pageSize = 1000;
  let from = 0;
  const rows = [];
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?select=*&offset=${from}&limit=${pageSize}`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    const data = await res.json();
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    if (!SMTP_USER || !SMTP_PASS) {
      return res.status(500).json({ error: "SMTP_USER/SMTP_PASS Vercel env vars are not set" });
    }
    if (!DB_EXPORT_TO) {
      return res.status(500).json({ error: "DB_EXPORT_TO Vercel env var is not set" });
    }

    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/list_app_tables`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const tables = await rpcRes.json();

    const wb = XLSX.utils.book_new();
    let rowCount = 0;
    for (const table of tables) {
      let rows = [];
      try {
        rows = await fetchAllRows(table);
      } catch (err) {
        console.warn(`Could not fetch ${table}:`, err.message);
      }
      rowCount += rows.length;
      const aoa = rows.length
        ? [Object.keys(rows[0]), ...rows.map((row) => Object.keys(rows[0]).map((h) => {
            const v = row[h];
            return v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v;
          }))]
        : [["(empty)"]];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws, table.slice(0, 31));
    }

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const today = new Date().toISOString().slice(0, 10);

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    await transporter.sendMail({
      from: SMTP_USER,
      to: DB_EXPORT_TO,
      subject: `NRG Caller — Full Database Backup (${today})`,
      text:
        `Automated daily backup from the NRG Caller app.\n\n` +
        `Attached is a full export of every table in the database as of ${today} ` +
        `(${tables.length} tables, ${rowCount} rows total), one sheet per table, in Excel format.`,
      attachments: [{
        filename: `NRG_Caller_Full_DB_${today}.xlsx`,
        content: buffer,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }],
    });

    await fetch(`${SUPABASE_URL}/rest/v1/settings?on_conflict=key`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ key: LAST_RUN_KEY, value: new Date().toISOString() }),
    });

    return res.status(200).json({ ok: true, tables: tables.length, rows: rowCount });
  } catch (err) {
    console.error("cron db-export error:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};

module.exports.config = { maxDuration: 60 };
