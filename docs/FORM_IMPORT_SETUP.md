# Form Import Setup — your one manual step

This is separate from the existing Sheets-sync bridge (which stays paused,
untouched). Form Import needs a small, fresh Apps Script project that can open
*any* Google Sheet by ID — a Google Form's response Sheet, for example — and
hand its rows back to the app on demand. Nothing here runs on a timer;
connecting a form, mapping its columns, and checking for new entries are all
things you trigger by clicking a button in the app.

## 1. Create a new, unbound script

1. Go to **script.google.com → New project**. Do **not** open this from
   inside a specific Sheet's Extensions menu — it needs to stay unbound so it
   can open any sheet by ID, not just one it's attached to.
2. Delete anything in the editor and paste the full contents of
   [`form-import-bridge/Code.gs`](../form-import-bridge/Code.gs) from this
   project.

## 2. Set a shared secret

1. Click the **gear icon (Project Settings)** on the left → scroll to
   **Script Properties** → add one property:
   - `FORM_IMPORT_SECRET` = any random string you make up (not a Supabase
     credential — this script never talks to Supabase, it only reads a Sheet
     and hands the rows to your browser).
2. Remember this value — you'll paste it into the app in step 4.

## 3. Deploy as a Web App

1. **Deploy → New deployment**.
2. Type: **Web app**.
3. Execute as: **Me**. Who has access: **Anyone**.
4. Click **Deploy**, authorize if asked (same "unsafe" warning as before —
   expected for your own script, click through it).
5. Copy the **Web app URL** it gives you (ends in `/exec`).

**Access reminder:** this script opens sheets "as you" (the deploying
account), not as whoever's using the app. If a Form's response Sheet lives
under a different Google account, share that Sheet with this account
(Viewer is enough) before connecting it in the app.

## 4. Paste into the app

1. Open the **Form Import** tab in the admin page (next to New Contacts).
2. In the small **Webhook Setup** box, paste the Web app URL and the secret
   from step 2, then **Save**. No further Supabase/SQL steps needed for this
   part — the app stores these itself.

---

### What happens after this

- **Connect a form**: paste the Sheet's URL or ID and a name, save — the app
  immediately opens the column-mapping screen for it.
- **Map columns**: pick which contact field each of the Sheet's headers
  corresponds to (or leave it "Ignore"). Saved once, reusable every time.
- **Check for new entries**: fetches the Sheet's current rows, applies your
  mapping, and shows only the ones whose phone number isn't already in Master
  Contact — you can optionally filter to entries from a chosen date onward if
  you mapped a Timestamp column.
- **Add**: one click per row (or "Add All") inserts it into Master Contact.
  Nothing is changed on the Sheet itself — you can Check again later and
  already-added entries simply won't reappear.
