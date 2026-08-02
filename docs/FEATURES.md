# NRG Caller v2 — Feature Documentation

*What we are building. Read this, mark changes, and once you approve we build.*

---

## 1. What this app is

A calling-campaign app for HKM Hyderabad. Admins collect contacts for events (GIC weekly sessions, Rath Yatra, Janmashtami, ...), assign them to callers, and callers phone/WhatsApp those people and record the response. Receptionists mark attendance when people actually show up. Everything the team does in the app is saved instantly, and a Google Sheet stays in sync as a mirror — so admins can still view and edit data in Sheets like they are used to.

**The one promise driving every decision: every action in the app — login, opening a section, submitting a response — feels instant (under half a second), like a modern polished app.**

---

## 2. The three roles

| Role | What they can do |
|---|---|
| **Admin** | Everything: manage users, select the active event, assign contacts, edit the WhatsApp message, see all data and all responses |
| **User** (caller) | See only *their* assigned contacts, call/WhatsApp them, submit responses, mark attendance (reception section), add new contacts |
| **Receptionist** | Only the reception section: search a person and mark attendance |

Contacts are **only ever assigned to people with the "User" role** — Admins and Receptionists never receive calling lists.

---

## 3. Login

- One login screen: **User Name + Password** (the phone number stored in Admin Page).
- The app remembers you — close and reopen, you're still logged in, and it opens instantly.
- Based on your role, you land on the Admin dashboard, the Caller home, or the Reception screen.

---

## 4. Admin — Users & Assignment page

This is the control room. It shows every user in a table:

| Column | Meaning |
|---|---|
| User Name | Caller's name (also their login ID) |
| Password | Their phone number |
| Role | User / Admin / Receptionist |
| Call Limit | Max contacts this user should get in an assignment (set by admin, optional) |
| Assigned Count | How many contacts they currently hold — **shown live on this same page** |
| Auto Assign | Yes/No — should this user be included when contacts are distributed? |

Admin can add, edit, and remove users here.

### 4a. The active event (Calling Purpose)

One single selector at the top: **the current event** (GIC, RY, JSTM, ...). When admin picks an event, the app fetches every contact from Master Contact whose Calling Purpose matches that event — this becomes the pool to assign.

### 4b. Admin-tag filter

Before assigning, admin can narrow the pool by **Admin tag**:

- **No tag selected** → all contacts of that event are fetched.
- **One or more tags selected** (e.g. *Core*) → only contacts having the event **and** that tag are fetched.
- Contacts tagged **Don't Call are never fetched — for any event, ever.**

### 4c. Auto-assignment (one button)

Admin clicks **Assign**, and the pool is distributed to all users whose Auto Assign = Yes:

1. Users **with a Call Limit** get exactly up to their limit first.
2. The **remaining contacts are divided equally** among the users with no limit (differences of at most one contact between them).
3. Assigned Count updates immediately on the page.

*Your example: 10 GIC contacts, 5 users on. Two users have limits (2 and 1) → they take 3. Remaining 7 split across the other 3 users as 3 / 2 / 2.*

**Core Cultivation rule in auto-assign:** a contact with a Core Cultivation user **always goes to that cultivator first**, and it counts toward that user's limit. If the cultivator is not receiving contacts in this round (Auto Assign off / not eligible), the contact is assigned to any other user like normal.

Assignment is **not stored on the contact** — it is its own record (who, which contact, which event, when). So the same contact can go to different users at different times, and we keep the history of every round.

**When admin switches to a new event (Calling Purpose):** all previous *temporary* assignments are erased from every user's list automatically (core-cultivated relationships are untouched), and the new event's contacts are **auto-assigned immediately** to all eligible users according to the limits/equal-split rules above. One selection — old lists gone, new lists delivered.

### 4d. WhatsApp message (Body Text)

The **E3 box holds the current message** — the one every caller's **Send Message** button uses. When a new event comes, admin writes the new message in E3 and moves/keeps older messages in the other boxes below. Only E3 is ever sent. The message is text only — attaching a poster image was removed.

---

## 5. Admin — Master Contact page

The full contact database, everything in one table:

Mob No, Name, PG Name, Profession, Company Name, No of Sessions (auto-counted from attendance), Admin Remarks, Admin tag, Core Cultivation, Calling Purpose.

What admin does here:

- **Add / edit / search** contacts.
- **Admin tag** per contact: Don't Call, Janata, Call, Core, Assigned — used for filtering during assignment; *Don't Call* removes the contact from every future fetch.
- **Core Cultivation**: admin picks a specific user as the permanent cultivator of this person. (This is separate from calling assignments — it's a fixed relationship.)
- **No of Sessions** fills itself: every attendance marked at reception adds to this count automatically.

Admin can do all of this **either in the app or directly in the Google Sheet** — both stay in sync.

---

## 6. Caller (User) home

When a caller logs in, they see **their assigned contacts for the current event** as clean mobile cards. Each card:

- **Name** of the contact (+ small details: sessions attended so far).
- **W/S dropdown** — Working / Student / NA, same as v1.
- **📞 Call** — taps open the phone dialer with the number.
- **💬 Send Message** — opens that person's WhatsApp with the admin's E3 message ready to go; caller just presses send.
- **Response dropdown** — the v1 options list (Not Done, Joining the session, Will try to attend, Next Week will join, Busy, Wrong Number, Out of station, Didn't Receive – Sent in WhatsApp, Out of Network Coverage, Shifted to Home town, Only Online session, Sunday Available, Will come for Saturday, evening Shift, Don't Call him again, Yet To Call, Others → free text).
- **Submit** — saves the response **instantly** (no waiting spinner; the card updates the moment you tap).

**Submit activation sequence (first submission):** the Submit button unlocks only after the caller has, in order — ① tapped the phone number (called), ② chosen a status, ③ tapped Send Message. **After the first submission**, if the caller changes the status again, they can re-submit directly — no call or message required the second time.

Extra:

- A small counter on top: *assigned / done / pending* for today.
- Every submit is logged with time, caller name, contact, and response → this is what fills the **Calling Response** page.
- **Unattempted contacts stay visible as pending** — nothing gets lost if a caller stops midway.

---

## 7. Calling Response (log of every call)

Every submitted response becomes one permanent row: **Time, Caller Name, Contact Name, Mob No, Remarks (the response), Additional Remarks (optional free text)**.

- Admin sees all of it, filterable by caller / event / date range.
- A caller's full history with a particular person is visible from the contact card (so the caller knows what happened last time before dialing).

---

## 8. Reception section

Available to Receptionists and Users:

- **Search** a person from Master Contact by phone number or name (live search, results appear as you type).
- Tap **Mark Attendance** → one row is saved: time, mob no, name, and *took by* (who marked it).
- Double-tap protection: marking the same person twice in one session is blocked.
- Each attendance automatically increases that person's **No of Sessions** count in Master Contact.

---

## 9. Contact Collection section

For gathering **new** contacts (e.g. during an event):

- A simple form: Mob No, Name, PG Name, Profession, Company Name, Remarks.
- **Collected by** is filled automatically (the logged-in user).
- If the number **already exists** in Master Contact, the app says so and shows that person's history instead of creating a duplicate.
- Admin later reviews collected contacts and moves them into Master Contact with the right event tag (one tap per contact, or "add all").

---

## 10. How everything connects (the four flows)

```
① ASSIGN   Admin picks event → pool fetched (event + tags, minus Don't Call)
           → Assign button → distributed by limits/equal split
           → each caller's home fills with their cards

② CALL     Caller taps Call / Send Message → picks response → Submit
           → saved instantly → appears in Calling Response
           → admin's Assigned/Done counters update live

③ ATTEND   Person arrives → reception searches → Mark Attendance
           → Session Att row saved → No of Sessions +1 on Master Contact

④ COLLECT  New person met → Contact Collection form → saved with collector name
           → admin promotes it into Master Contact for the next event
```

---

## 11. Google Sheets mirror (two-way)

- **App → Sheet:** every change made in the app appears in the Google Sheet within a few seconds. The app never waits for this — it happens in the background, which is why the app stays instant.
- **Sheet → App:** when admin edits a cell in the Sheet by hand (fix a name, change a tag, add a contact row), it flows back into the app automatically.
- Calculated columns (No of Sessions) are computed by the app and *written* to the sheet — no heavy formulas, no cross-sheet fetching scripts. Simple.

---

## 12. The stack (short — you asked me to decide)

- **Database & login:** Supabase (data lives here; this is why everything is milliseconds).
- **Frontend:** a simple, installable PWA — loads instantly, works like an app on the phone, same Krishna theme.
- **Sheets sync:** one small background bridge (no Apps Script doing heavy work anymore — the slow part of v1 is gone entirely).

No frameworks-for-the-sake-of-frameworks, no complex logic. Every feature above is a simple read or write.

---

## 13. Decisions — RESOLVED (2026-07-17)

1. **Response options** — reuse the full v1 list (incl. "Others" with mandatory free text). ✅
2. **W/S** — kept, same as v1 (W / S / NA). A W/S column will be added to Master Contact. ✅
3. **Re-assignment** — switching to a new Calling Purpose erases all temporary assignments and auto-assigns the new event's contacts immediately. Core-cultivation links are permanent and untouched. ✅
4. **Message** — E3 is always the live message; older messages parked in other boxes. Only E3 is sent. ✅
5. **Contact Collection** — open to all users. ✅
6. **Submit gating** — first submission requires tap-phone → set status → send message, in order. After first submission, status changes can be re-submitted freely without calling/messaging again. ✅
7. **Poster image** — removed. Messages are text only. A plain WhatsApp link (`wa.me`) cannot attach an image, and both workarounds tried (native share, and a link-preview card served from `/api/poster-preview`) were dropped — the share sheet cannot carry the recipient's number, and the preview card cluttered the message.
