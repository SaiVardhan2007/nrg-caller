// Deleting a FOLK Yatra needs a one-time code that is emailed to the owner.
//
//   POST { action: "send",    yatra_id, user_name, login_pw }
//        -> emails a 6-digit OTP to OTP_TO and returns { ok, token }
//   POST { action: "confirm", yatra_id, otp, token, user_name, login_pw }
//        -> if the OTP matches the token (and hasn't expired), deletes the yatra
//
// Nothing is stored: the token is an HMAC-signed { yatra_id, exp, otp-hash }
// blob, so it only proves "this OTP was issued for this yatra". The delete
// itself runs here with the service key, after the OTP check.
//
// Env vars (same as api/yatras-email.js): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS.

const crypto = require("crypto");
const nodemailer = require("nodemailer");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || "465");
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

const OTP_TO = "snkdasa@gmail.com";
const OTP_TTL_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hmac = (data) => crypto.createHmac("sha256", SERVICE_KEY || "").update(data).digest("hex");
const otpHash = (yatraId, exp, otp) => hmac(`otp|${yatraId}|${exp}|${otp}`);
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const sbHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

// Admin always; a Limited Admin only if they were given a FOLK Yatras page.
async function isAllowed(userName, loginPw) {
  if (!userName || !loginPw) return false;
  const url = `${SUPABASE_URL}/rest/v1/users?select=role,allowed_pages&user_name=eq.${encodeURIComponent(userName)}&login_pw=eq.${encodeURIComponent(loginPw)}&limit=1`;
  const r = await fetch(url, { headers: sbHeaders });
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
    const { action, yatra_id, otp, token, user_name, login_pw } = body || {};

    if (!(await isAllowed(user_name, login_pw))) return res.status(403).json({ error: "Not allowed." });
    if (typeof yatra_id !== "string" || !UUID_RE.test(yatra_id)) return res.status(400).json({ error: "Bad yatra." });

    if (action === "send") {
      if (!SMTP_USER || !SMTP_PASS) return res.status(500).json({ error: "SMTP_USER/SMTP_PASS are not set on the server." });
      const yr = await fetch(`${SUPABASE_URL}/rest/v1/yatras?select=name&id=eq.${yatra_id}&limit=1`, { headers: sbHeaders });
      const [yatra] = yr.ok ? await yr.json() : [];
      if (!yatra) return res.status(404).json({ error: "Yatra not found." });

      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      const exp = Date.now() + OTP_TTL_MS;
      const payload = `${yatra_id}.${exp}.${otpHash(yatra_id, exp, code)}`;
      const signed = `${payload}.${hmac(payload)}`;

      const transporter = nodemailer.createTransport({
        host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS },
      });
      await transporter.sendMail({
        from: SMTP_USER,
        to: OTP_TO,
        subject: `FOLK Yatras — OTP to delete "${String(yatra.name).slice(0, 80)}"`,
        text: `${user_name} asked to delete the yatra "${yatra.name}" in the FNRG Preaching app.\n\nOTP: ${code}\n\nIt is valid for 5 minutes. If you did not expect this, ignore this email — nothing is deleted without the OTP.`,
      });
      return res.status(200).json({ ok: true, token: signed });
    }

    if (action === "confirm") {
      const parts = String(token || "").split(".");
      if (parts.length !== 4) return res.status(400).json({ error: "Invalid request — ask for a new OTP." });
      const [tYatra, tExp, tHash, tSig] = parts;
      if (!safeEq(tSig, hmac(`${tYatra}.${tExp}.${tHash}`)) || tYatra !== yatra_id) return res.status(400).json({ error: "Invalid request — ask for a new OTP." });
      if (Date.now() > Number(tExp)) return res.status(400).json({ error: "OTP expired — ask for a new one." });
      if (!/^\d{6}$/.test(String(otp || "").trim()) || !safeEq(tHash, otpHash(yatra_id, tExp, String(otp).trim()))) {
        return res.status(400).json({ error: "Incorrect OTP." });
      }
      const del = await fetch(`${SUPABASE_URL}/rest/v1/yatras?id=eq.${yatra_id}`, { method: "DELETE", headers: sbHeaders });
      if (!del.ok) return res.status(500).json({ error: "Delete failed: " + (await del.text()).slice(0, 200) });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (err) {
    console.error("yatra-delete-otp error:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};
