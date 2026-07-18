# Sheets Sync Setup — your one manual step

Everything on the Supabase side is already done (triggers are live, currently
dormant until you complete this). This is the only piece I cannot do for you —
it requires clicking inside your own Google account.

## 1. Add two columns to your Sheet first

- **Master Contact**: add a column named exactly **`W/S`** (any position after
  Company Name is fine).
- **Calling Responce**: add two columns named exactly **`Caller Name`** and
  **`Event`** (at the end is fine).

The bridge script matches columns by their header text, not position — so as
long as the header names match exactly, you can put them wherever you like.

## 2. Paste the bridge script

1. Open your Sheet → **Extensions → Apps Script**.
2. Delete anything in the editor and paste the full contents of
   [`sheets-bridge/Code.gs`](../sheets-bridge/Code.gs) from this project.
3. Click the **gear icon (Project Settings)** on the left → scroll to
   **Script Properties** → add two properties:
   - `SUPABASE_URL` = `https://ppdtmtswbxckpzouavql.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` = (the service_role key you gave me earlier)

## 3. Run `setup()` once (this is the one-time authorization)

1. Back in the editor, in the function dropdown at the top, select **`setup`**.
2. Click **Run**. Google will ask to review permissions — click through:
   *Review permissions → pick your account → Advanced → Go to project (unsafe) → Allow.*
   ("Unsafe" just means Google hasn't manually reviewed your own private
   script — this is expected and safe for a script you wrote yourself.)
3. This installs the trigger that lets edits in the Sheet reach Supabase.

## 4. Deploy as a Web App (so Supabase can reach the Sheet)

1. Click **Deploy → New deployment**.
2. Type: **Web app**.
3. Execute as: **Me**. Who has access: **Anyone**.
4. Click **Deploy**, authorize again if asked.
5. Copy the **Web app URL** it gives you (ends in `/exec`).

## 5. Send me that URL

Once you send it, I'll run one command to store it, and both directions go
live immediately — no further steps needed.

---

### What happens after this
- Edit a cell in **Admin Page** or **Master Contact** (or the message in
  **Body Text** cell **E3**) → appears in the app within seconds.
- Anything done in the app (add contact, assign, call response, attendance,
  new collection) → appears in the matching Sheet tab automatically.
- The three log tabs (**Calling Responce**, **Session Att**, **Contact
  collection**) are filled by the app only — they're permanent logs, not
  meant for manual editing.
