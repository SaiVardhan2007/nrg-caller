# NRG Caller v2 — UI Reference (from v1 app)

*What we keep from v1's look-and-feel, extracted from `previous-app-js.md`. Logic is NOT copied — only the UI patterns.*

## Look & feel to keep

- **Krishna theme**: Tulsi green (#047857/#065f46), saffron gold (#b45309), sandalwood cream background (#fefbf3), sandstone borders (#e6dfcd). Warm cream + green, generous rounded cards.
- **Responsive table → mobile cards**: desktop shows tables, phones show stacked cards (v1 used `data-label` cells; v2 renders real cards on mobile).
- **Emoji vocabulary**: 🙏 (thanks/attendance), 🎉 (bulk success), 📞 (call), ✎ (inline edit), 🦚 (festival).

## Screens (v2 mapping)

1. **Login** — User Name + Password, button label swaps "Enter" → "Checking…" while busy. Remembered session → app opens straight to the right home.
2. **Home dashboard** (users): stat bar on top (**Total / Positive / Pending**) + tappable section cards with elastic press animation (~200ms `.clicked` scale-down) and disabled state for sections the role can't use. v2 cards: **My Calls, Reception, Contact Collection** (+ admin-only ones grayed out).
3. **Caller card** (the heart of the app) — 2-row compact card:
   - Row 1: contact **name** (left, full), **response dropdown** (right).
   - Row 2: **CALLS: n** (tap → history modal), **📞 phone pill** (tel: link, `XXXXX XXXXX` format, +91), **Send message** (WhatsApp `wa.me/91...` with admin's Body Text prefilled), **Submit** (solid green).
   - Submit gating kept from v1: disabled until a response is chosen; "Others"-style free-text via small modal; after save the button locks to **"Submitted"**.
   - Row flash states: dirty → saving → **saved flash (~1.2s green)** / error flash red.
4. **Admin pages**: users table (limits, live assigned counts, auto-assign toggles), Master Contact table with inline edit (✎ pencil, Save/Cancel, Enter/Escape), active-event selector, assignment button, message editor modal, Excel export/import with column mapping.
5. **Reception**: digits-only search box (auto-trims to 10 digits, debounced live search), found-person card with "Sessions attended: n", big **🙏 Mark Attendance** button ("Marking…" while busy), and a **"today's marked" list** below (newest first).
6. **Contact Collection**: simple form card; duplicate phone → shows existing person + history instead of saving.

## Feedback patterns to keep (these made v1 feel good)

- **Toasts**: bottom toast, kinds success/error/warning, auto-hide ~3s. Signature strings: "Thanks for submitting 🙏", "Attendance marked for <name> 🙏".
- **Sync status line**: "Saving…" / "All changes saved" (self-clears) / "Save failed".
- **Optimistic UI**: card updates the instant you tap Submit; save happens behind it. (With Supabase this is truly instant — v1's 3-retry/1s-delay network shim is NOT needed anymore.)
- **Instant open**: cached data renders immediately on open, fresh data replaces it silently (v1 did this with localStorage; v2 gets it natively from Supabase + realtime).
- **Live updates instead of polling**: v1 polled every 15s; v2 uses Supabase realtime — admin sees counts move as callers submit.
- **Pull-to-refresh** on mobile.
- **Double-tap guards** on every submit/save button.
- **Modals**: close on backdrop tap, Enter confirms, Escape cancels, auto-focus input.

## v1 things we deliberately DROP

- Per-campaign duplicate sheets/sections (GIC vs Festival split) — v2 has one Master Contact + event codes.
- Date-column "rounds" on the sheet — v2 logs every response as a row in Calling Response.
- Apps Script API + retry/cold-start handling — replaced by Supabase.

## v1 things CONFIRMED KEPT (user, 2026-07-17)

- W/S dropdown (W / S / NA) — column added to Master Contact.
- Poster image with the message — sent via native share (image + text together); text-only wa.me fallback with poster download where share isn't supported.
- Submit gating, stricter than v1: tap phone → set status → send message → Submit unlocks. After first submission, re-submitting a changed status is free (no call/message needed).
- Full v1 response options list.

## Constants from v1 (for reference)

- Positive statuses: "Joining the session", "Will try to attend". Pending: "Not Done", "Yet to call", empty.
- Default status: "Not Done"; free-text option: "Others" (text mandatory).
- Phone: store 10 digits; display `XXXXX XXXXX`; links `tel:+91…`, `https://wa.me/91…?text=…`.
