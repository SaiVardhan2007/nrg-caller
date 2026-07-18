# NRG Caller v2 — Google Sheets Schema (as built)

Source: https://docs.google.com/spreadsheets/d/1A7YS5-WjuT7G1xPifeYkfpsgylCtXt2n96kiNtxRgYc
Snapshot date: 2026-07-17

## Tabs

### 1. Admin Page (users)
| Column | Notes |
|---|---|
| S No | Serial number |
| User Name | Full name (e.g. SNKD, Abhinay, Sai Vardhan) |
| Login PW | Phone number used as password (SNKD has `1896`) |
| User Status | `User` / `Admin` / `Reception` |
| Call Limit By Admin | Max calls assignable |
| No of Call Assigned by Automation | Calculated |
| Auto Assign Status | Yes / No |
| Calling Purpose | Campaign tag (e.g. GIC) |
| Admin tag | e.g. Core |

15 users currently. Per Task #1: Login ID = user's first name.

### 2. Body Text
Nearly empty — one cell "BODY TEST". Likely intended for WhatsApp/message templates.

### 3. Thuresday calling (per-day assignment limits)
Two side-by-side blocks:
- GIC calling: Name | limit | count
- Festival calling: Name | limit | count

4 callers listed with per-campaign limits (Dushmanth 5, Guruswami 5, Narendra 3, Sai Vardhan 3).

### 4. Master Contact (single unified contacts DB)
| Column | Notes |
|---|---|
| S No | |
| Mob No | |
| Name | |
| PG Name | |
| Profession | |
| Company Name | |
| No of Sessions | Formula (from Session Att) |
| Admin Remakrs | Free text |
| Admin tag | Values seen: `Don't Call`, `Janata`, `Call`, `Core`, `Assigned` |
| Core Cultivation | |
| Calling Purpose | Campaign: values seen `GIC`, `RY`, `JSTM` |
| Action | |
| Whatsapp Message | |

No data rows yet — only dropdown/validation values present in Admin tag & Calling Purpose columns. Note: unlike v1, there is ONE master contact sheet for all campaigns (no separate GIC Calling / Special Events sheets). No `Assigned To` column exists yet.

### 5. Calling Responce (call log)
Columns: Time Stamp | Name | Mob No | Remarks | Addl. Remarks
(User confirmed: a **Caller Name** column should be added — it was forgotten.)

### 6. Session Att (attendance)
Columns: Time stamp | Mob No | Name | took by

### 7. Task (requirements backlog from user)
1. For a user, first name will be the user ID — Both — Yet To Start
2. Admin should see number of calls a user made in a selected period and download it — App — Yet To Start
3. Calling Purpose will have one row for current event selection — Google Sheet — Yet To Start
4. Unattempted calls should be captured per campaign — Both — Yet To Start
5. New section in user page called Contact Collection — Both — Yet To Start

### 8. Contact collection
Columns: time stamp | Mob No | Name | PG Name | Profession | Company Name | collected by | remarks

## Answers from user (2026-07-17)
- **No `Assigned To` column by design**: a contact not yet cultivated may be assigned to different users at different times — assignment is fluid, not a fixed contact attribute. (Implication: assignments live in their own table/mechanism, not on Master Contact.)
- **Calling Responce** should also have a **Caller Name** column (forgotten in the sheet).
- **Calling Purpose = event codes**: GIC = weekly Bhagavad Gita session; RY = Rath Yatra; JSTM = Janmashtami. New contacts are collected per event and tagged with these codes.
