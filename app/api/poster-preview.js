// Serves a tiny HTML page with real Open Graph tags for the currently attached
// message poster, read live from Supabase on every request. WhatsApp's link
// crawler needs an actual `text/html` response with og:image to render a big
// photo preview card — Supabase Storage forces uploaded HTML to text/plain
// (an anti-XSS policy), so this lives on Vercel instead, which serves it correctly.

const SUPABASE_URL = "https://ppdtmtswbxckpzouavql.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwZHRtdHN3Ynhja3B6b3VhdnFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzMzkxNjksImV4cCI6MjA5OTkxNTE2OX0.c6Qlae6BQ0PzG9VWUmFflte3u3oJnLOo7onf3IWMxc0";

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function fetchSetting(key) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/settings?key=eq.${encodeURIComponent(key)}&select=value`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
  );
  const rows = await res.json();
  return rows[0]?.value || "";
}

module.exports = async (req, res) => {
  const [imageUrl, eventCode] = await Promise.all([
    fetchSetting("poster_url"),
    fetchSetting("current_event"),
  ]);

  let eventName = "Session Update";
  if (eventCode) {
    const evRes = await fetch(
      `${SUPABASE_URL}/rest/v1/events?code=eq.${encodeURIComponent(eventCode)}&select=name`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    const evRows = await evRes.json();
    eventName = evRows[0]?.name || eventName;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");

  if (!imageUrl) {
    res.status(200).send(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(eventName)}</title></head><body></body></html>`);
    return;
  }

  res.status(200).send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(eventName)}">
<meta property="og:description" content="Hare Krishna! Tap to view.">
<meta property="og:image" content="${imageUrl}">
<meta name="twitter:card" content="summary_large_image">
<title>${esc(eventName)}</title>
</head>
<body><img src="${imageUrl}" alt="${esc(eventName)}" style="max-width:100%" /></body>
</html>`);
};
