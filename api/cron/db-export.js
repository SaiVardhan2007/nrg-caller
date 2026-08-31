// Vercel Cron entry point for the full-database backup email.
//
// Replaces the old "ping on admin page load, hope 7 days passed" trigger
// (app/js/admin.js maybeRunWeeklyDbExport) with a precise daily schedule —
// see vercel.json for the cron expression. Unlike the Supabase Edge
// Function this used to require a browser to build the .xlsx for (Supabase's
// Deno isolate hit WORKER_RESOURCE_LIMIT trying to do it server-side), a
// Vercel Node function has enough memory/CPU headroom to build the workbook
// itself — so this fetches every table directly and only calls the existing
// weekly-db-export Edge Function to actually send the mail (it already has
// the SMTP secrets wired up).
//
// Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on
// cron-triggered requests when the CRON_SECRET env var is set — this checks
// that header so the endpoint can't be triggered by anyone else who finds
// the URL.

const XLSX = require("xlsx");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

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

    const base64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" });

    const mailRes = await fetch(`${SUPABASE_URL}/functions/v1/weekly-db-export?force=1`, {
      method: "POST",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ base64, tables: tables.length, rows: rowCount }),
    });
    const mailResult = await mailRes.json();

    return res.status(200).json({ ok: true, tables: tables.length, rows: rowCount, mail: mailResult });
  } catch (err) {
    console.error("cron db-export error:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};

module.exports.config = { maxDuration: 30 };
