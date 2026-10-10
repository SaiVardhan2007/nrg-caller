// Emails an Excel file built from a FOLK Yatras table (Dashboard, Attendance,
// Disposables, Cooking / Serving Items, Feedback, or one of the stat popups).
//
// The browser sends the rows it is already showing ({ to, title, filename,
// headers, rows }) plus the logged-in user's id/password; this function checks
// those against the users table (so the endpoint can't be used as an open mail
// relay), builds the workbook, and sends it over the same SMTP account the
// daily DB backup uses.
//
// Required Vercel env vars (already set for api/cron/db-export.js):
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SMTP_HOST (default smtp.gmail.com),
// SMTP_PORT (default 465), SMTP_USER, SMTP_PASS.

const XLSX = require("xlsx");
const nodemailer = require("nodemailer");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || "465");
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const MAX_ROWS = 20000;

// Admin always; a Limited Admin only if they were given a FOLK Yatras page.
async function isAllowed(userName, loginPw) {
  if (!userName || !loginPw) return false;
  const url = `${SUPABASE_URL}/rest/v1/users?select=role,allowed_pages&user_name=eq.${encodeURIComponent(userName)}&login_pw=eq.${encodeURIComponent(loginPw)}&limit=1`;
  const r = await fetch(url, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  if (!r.ok) return false;
  const [u] = await r.json();
  if (!u) return false;
  if (u.role === "Admin") return true;
  return u.role === "Limited Admin" && Array.isArray(u.allowed_pages) && u.allowed_pages.some((p) => String(p).startsWith("yatras-") || p === "folk-yatras-section");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);
    const { to, title, filename, headers, rows, user_name, login_pw } = body || {};

    if (!(await isAllowed(user_name, login_pw))) return res.status(403).json({ error: "Not allowed." });
    if (!SMTP_USER || !SMTP_PASS) return res.status(500).json({ error: "SMTP_USER/SMTP_PASS are not set on the server." });
    if (typeof to !== "string" || !EMAIL_RE.test(to.trim())) return res.status(400).json({ error: "Enter one valid email address." });
    if (!Array.isArray(headers) || !Array.isArray(rows) || rows.length > MAX_ROWS) return res.status(400).json({ error: "Bad data." });

    const sheetName = String(title || "Sheet").replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet";
    const safeName = String(filename || "FOLK_Yatras.xlsx").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), sheetName);
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    await transporter.sendMail({
      from: SMTP_USER,
      to: to.trim(),
      subject: `FOLK Yatras — ${String(title || "Export").slice(0, 100)}`,
      text: `Attached: ${String(title || "Export").slice(0, 100)} (${rows.length} row${rows.length === 1 ? "" : "s"}), sent from the FNRG Preaching app by ${user_name}.`,
      attachments: [{
        filename: safeName,
        content: buffer,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }],
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("yatras-email error:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};
