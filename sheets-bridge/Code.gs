/**
 * NRG Caller — Sheets <-> Supabase bridge.
 * Paste this whole file into the Sheet's Extensions > Apps Script editor.
 * See docs/SHEETS_SYNC_SETUP.md for the one-time setup steps.
 */

const SHEET_ADMIN = 'Admin Page';
const SHEET_CONTACTS = 'Master Contact';
const SHEET_NEW_CONTACTS = 'New Contacts';
const SHEET_BODY_TEXT = 'Body Text';
const SHEET_CALL_RESPONSES = 'Calling Responce';
const SHEET_SESSION_ATT = 'Session Att';
const MESSAGE_CELL = 'E3';

function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    SUPABASE_URL: props.getProperty('SUPABASE_URL'),
    SERVICE_KEY: props.getProperty('SUPABASE_SERVICE_ROLE_KEY'),
  };
}

/**
 * Run this ONCE from the Apps Script editor (Run > setup) after filling in
 * Script Properties. It installs the onEdit trigger with the permissions
 * needed to call Supabase (a plain `function onEdit` can't call UrlFetchApp).
 */
function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'onEditInstallable') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onEditInstallable')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();
  Logger.log('Installable onEdit trigger installed.');
}

/**
 * Run this ONCE from the Apps Script editor after `setup()`. Installs a
 * time-based trigger that self-heals every synced tab every minute — a
 * safety net for the per-row webhook below, which is fire-and-forget with no
 * retry: two rows changing at nearly the same instant (e.g. a new contact
 * registered in Reception inserts into `contacts` AND `session_attendance`
 * within milliseconds) can fire more simultaneous webhook calls than Apps
 * Script's concurrency limit allows, silently dropping one. This also
 * removes Master Contact rows for contacts deleted in Supabase, which the
 * webhook can't do (it only fires on insert/update, never delete).
 *
 * Note: Apps Script's time-based trigger service has no seconds-level
 * option — `everyMinutes()` only accepts 1/5/10/15/30, so 1 minute is the
 * fastest this backup trigger can run. Real-time changes still reach the
 * Sheet within seconds via the doPost webhook below; this trigger only
 * matters when a webhook call gets silently dropped.
 */
function setupResyncTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'fullResyncMasterContact' || t.getHandlerFunction() === 'fullResyncAll') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('fullResyncAll')
    .timeBased()
    .everyMinutes(1)
    .create();
  Logger.log('Full-resync time trigger installed (every 1 minute).');
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('NRG Caller')
    .addItem('Full Resync All Sheets (now)', 'fullResyncAll')
    .addToUi();
}

// Resyncs Master Contact plus the three append-only log tabs from Supabase,
// the source of truth for all of them. Safe to run anytime: every one of
// these tabs is "app-managed only" per the setup doc, so clearing and
// rewriting from Supabase never loses anything a human typed by hand.
function fullResyncAll() {
  fullResyncMasterContact();
  fullResyncLogSheet('call_responses', SHEET_CALL_RESPONSES, mapCallResponseToRow, 'ts');
  fullResyncLogSheet('session_attendance', SHEET_SESSION_ATT, mapAttendanceToRow, 'ts');
}

/* ============ INBOUND: human edits this Sheet -> Supabase ============ */

function onEditInstallable(e) {
  try {
    const sheet = e.range.getSheet();
    const name = sheet.getName();
    const row = e.range.getRow();

    if (name === SHEET_BODY_TEXT) {
      if (e.range.getA1Notation() === MESSAGE_CELL) syncBodyText(sheet);
      return;
    }
    if (row === 1) return; // header row edits ignored

    if (name === SHEET_ADMIN) syncAdminPageRow(sheet, row);
    else if (name === SHEET_CONTACTS) syncMasterContactRow(sheet, row, e);
  } catch (err) {
    Logger.log('onEdit error: ' + err);
  }
}

function headerMap(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h, i) => { if (h) map[String(h).trim()] = i + 1; });
  return map;
}

function cellVal(sheet, row, map, header) {
  const col = map[header];
  if (!col) return '';
  return sheet.getRange(row, col).getValue();
}

function supabaseUpsert(table, payload, onConflict) {
  const cfg = getConfig();
  if (!cfg.SUPABASE_URL || !cfg.SERVICE_KEY) {
    Logger.log('Supabase credentials not set in Script Properties.');
    return;
  }
  UrlFetchApp.fetch(cfg.SUPABASE_URL + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: cfg.SERVICE_KEY,
      Authorization: 'Bearer ' + cfg.SERVICE_KEY,
      Prefer: 'resolution=merge-duplicates',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

function syncAdminPageRow(sheet, row) {
  const map = headerMap(sheet);
  const userName = String(cellVal(sheet, row, map, 'User Name') || '').trim();
  if (!userName) return;

  const status = String(cellVal(sheet, row, map, 'User Status') || 'Coordinator').trim();
  const role = (status === 'Admin' || status === 'Reception') ? status : 'Coordinator';
  const limitRaw = cellVal(sheet, row, map, 'Call Limit By Admin');
  const auto = String(cellVal(sheet, row, map, 'Auto Assign Status') || '').trim().toLowerCase() === 'yes';

  supabaseUpsert('users', {
    user_name: userName,
    login_pw: String(cellVal(sheet, row, map, 'Login PW') || '').trim(),
    role: role,
    call_limit: (limitRaw === '' || limitRaw === null) ? null : Number(limitRaw),
    auto_assign: auto,
  }, 'user_name');
}

function syncMasterContactRow(sheet, row, e) {
  const map = headerMap(sheet);
  const colPhone = map['Phone'] || map['Mob No'];
  const mob = String(colPhone ? cellVal(sheet, row, map, colPhone) : '').replace(/\D/g, '');
  if (mob.length !== 10) return;

  const colProf = map['Profession'] || map['W/S'];
  const wsVal = colProf ? String(cellVal(sheet, row, map, colProf) || 'NA').trim() : 'NA';
  const tagCol = map['Admin Tag'] || map['Admin tag'];

  const payload = {
    mob_no: mob,
    name: String(cellVal(sheet, row, map, 'Name') || '').trim(),
    pg_name: String(cellVal(sheet, row, map, 'PG Name') || '') || null,
    profession: null,
    company_name: String(cellVal(sheet, row, map, 'Company Name') || '') || null,
    ws: ['W', 'S', 'NA'].includes(wsVal) ? wsVal : 'NA',
    gender: String(cellVal(sheet, row, map, 'Gender') || '').trim() || null,
    admin_remarks: String(cellVal(sheet, row, map, 'Admin Remarks') || '') || null,
    admin_tag: tagCol ? String(cellVal(sheet, row, map, tagCol) || '') || null : null,
    core_cultivation: String(cellVal(sheet, row, map, 'Core Cultivation') || '') || null,
    calling_purpose: String(cellVal(sheet, row, map, 'Calling Purpose') || '') || null,
  };

  // If this edit changed the Phone cell itself, upserting under the new
  // number would create a duplicate row instead of updating the existing
  // contact (mob_no is the match key). Use the edit event's oldValue to
  // find the existing row by its previous number and update it in place.
  const editedMobNoCell = e && colPhone && e.range.getColumn() === colPhone;
  const oldMob = editedMobNoCell && e.oldValue ? String(e.oldValue).replace(/\D/g, '') : '';
  if (oldMob.length === 10 && oldMob !== mob) {
    const cfg = getConfig();
    if (!cfg.SUPABASE_URL || !cfg.SERVICE_KEY) return;
    UrlFetchApp.fetch(cfg.SUPABASE_URL + '/rest/v1/contacts?mob_no=eq.' + oldMob, {
      method: 'patch',
      contentType: 'application/json',
      headers: {
        apikey: cfg.SERVICE_KEY,
        Authorization: 'Bearer ' + cfg.SERVICE_KEY,
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    return;
  }

  supabaseUpsert('contacts', payload, 'mob_no');
}

function syncBodyText(sheet) {
  const cfg = getConfig();
  if (!cfg.SUPABASE_URL || !cfg.SERVICE_KEY) return;
  const text = sheet.getRange(MESSAGE_CELL).getValue();
  UrlFetchApp.fetch(cfg.SUPABASE_URL + '/rest/v1/settings?on_conflict=key', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: cfg.SERVICE_KEY,
      Authorization: 'Bearer ' + cfg.SERVICE_KEY,
      Prefer: 'resolution=merge-duplicates',
    },
    payload: JSON.stringify({ key: 'message_text', value: String(text) }),
    muteHttpExceptions: true,
  });
}

// current_event / tag_filter are single global settings, mirrored onto row 2
// of Admin Page (the "Calling Purpose" / "Admin tag" columns), same idea as
// message_text living in Body Text!E3.
function syncAdminGlobalSetting(key, value) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_ADMIN);
  if (!sheet) return;
  const map = headerMap(sheet);
  const header = key === 'current_event' ? 'Calling Purpose' : 'Admin tag';
  const col = map[header];
  if (!col) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const rowCount = lastRow - 1;
  const values = new Array(rowCount).fill([value]);
  sheet.getRange(2, col, rowCount, 1).setValues(values);
}

/* ============ OUTBOUND: Supabase change -> this Sheet ============ */
/* Called by a Supabase Database Webhook (pg_net) on insert/update. */

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body && body.action === 'delete_new_contacts') {
      const mobNos = body.mob_nos;
      const deletedCount = deleteNewContactsFromSheet(mobNos);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, deleted: deletedCount }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const table = body.table;
    const record = body.record;

    if (table === 'users') {
      upsertSheetRow(SHEET_ADMIN, 'User Name', record.user_name, mapUserToRow(record));
    } else if (table === 'contacts') {
      upsertSheetRow(SHEET_CONTACTS, 'Phone', record.mob_no, mapContactToRow(record));
    } else if (table === 'settings' && record.key === 'message_text') {
      SpreadsheetApp.getActive().getSheetByName(SHEET_BODY_TEXT).getRange(MESSAGE_CELL).setValue(record.value);
    } else if (table === 'settings' && (record.key === 'current_event' || record.key === 'tag_filter')) {
      syncAdminGlobalSetting(record.key, record.value);
    } else if (table === 'call_responses') {
      appendSheetRow(SHEET_CALL_RESPONSES, mapCallResponseToRow(record));
    } else if (table === 'session_attendance') {
      appendSheetRow(SHEET_SESSION_ATT, mapAttendanceToRow(record));
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) })).setMimeType(ContentService.MimeType.JSON);
  }
}

function mapUserToRow(r) {
  return {
    'User Name': r.user_name,
    'Login PW': r.login_pw,
    'User Status': r.role,
    'Call Limit By Admin': r.call_limit === null || r.call_limit === undefined ? '' : r.call_limit,
    'No of Call Assigned by Automation': r.assigned_count === null || r.assigned_count === undefined ? 0 : r.assigned_count,
    'Auto Assign Status': r.auto_assign ? 'Yes' : 'No',
  };
}

function mapContactToRow(r) {
  return {
    'S No': r.s_no === null || r.s_no === undefined ? '' : r.s_no,
    'Time Stamp': r.created_at ? new Date(r.created_at).toLocaleString() : '',
    'Name': r.name,
    'Phone': r.mob_no,
    'PG Name': r.pg_name || '',
    'Profession': r.ws || 'NA',
    'Gender': r.gender || '',
    'Sessions': r.sessions_count === null || r.sessions_count === undefined ? 0 : r.sessions_count,
    'Calls': r.calls_count === null || r.calls_count === undefined ? 0 : r.calls_count,
    'Admin Tag': r.admin_tag || '',
    'Core Cultivation': r.core_cultivation || '',
    'Calling Purpose': r.calling_purpose || '',
    'Company Name': r.company_name || '',
    'Admin Remarks': r.admin_remarks || '',
  };
}

function mapCallResponseToRow(r) {
  return {
    'Time Stamp': r.ts,
    'Name': r.contact_name,
    'Mob No': r.mob_no,
    'Remarks': r.remarks,
    'Addl. Remarks': r.addl_remarks || '',
    'Caller Name': r.caller_name,
    'Event': r.event_code || '',
  };
}

function mapAttendanceToRow(r) {
  return { 'Time stamp': r.ts, 'Mob No': r.mob_no, 'Name': r.name, 'took by': r.took_by, 'Event': r.event_code || '' };
}

// Supabase fires one webhook per changed row, and several can land at nearly
// the same moment (e.g. a bulk insert). Without a lock, two concurrent calls
// can both read the same "next empty row" and overwrite each other. A script
// lock forces them to take turns, so getLastRow() is always accurate.
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function upsertSheetRow(sheetName, keyHeader, keyValue, valuesByHeader) {
  withLock(() => {
    const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
    if (!sheet) return;
    const map = headerMap(sheet);
    const keyCol = map[keyHeader];
    const lastRow = sheet.getLastRow();
    let targetRow = -1;

    if (lastRow >= 2 && keyCol) {
      const keyValues = sheet.getRange(2, keyCol, lastRow - 1, 1).getValues();
      for (let i = 0; i < keyValues.length; i++) {
        if (String(keyValues[i][0]).trim() === String(keyValue).trim()) { targetRow = i + 2; break; }
      }
    }
    if (targetRow === -1) targetRow = lastRow + 1;

    Object.keys(valuesByHeader).forEach((header) => {
      const col = map[header];
      if (col) sheet.getRange(targetRow, col).setValue(valuesByHeader[header]);
    });
  });
}

// Replaces every data row in Master Contact with a fresh pull from Supabase —
// the source of truth. Fixes both silently-dropped webhook rows (bulk ops)
// and rows for contacts that were since deleted in Supabase (which the
// per-row webhook never removes, since it only fires on insert/update).
// Only touches the columns this sync manages (see mapContactToRow); any
// other columns (S No, Action, Whatsapp Message, ...) are cleared and left
// blank for the current dataset, same as they already are for every row.
function fullResyncMasterContact() {
  const cfg = getConfig();
  if (!cfg.SUPABASE_URL || !cfg.SERVICE_KEY) {
    Logger.log('Supabase credentials not set in Script Properties.');
    return;
  }
  const resp = UrlFetchApp.fetch(
    cfg.SUPABASE_URL + '/rest/v1/contacts?select=*&order=s_no.asc.nullslast,created_at.asc',
    {
      method: 'get',
      headers: { apikey: cfg.SERVICE_KEY, Authorization: 'Bearer ' + cfg.SERVICE_KEY },
      muteHttpExceptions: true,
    }
  );
  if (resp.getResponseCode() !== 200) {
    Logger.log('Full resync fetch failed: ' + resp.getContentText());
    return;
  }
  const records = JSON.parse(resp.getContentText());

  withLock(() => {
    const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_CONTACTS);
    if (!sheet) return;

    const headers = [
      'S No', 'Time Stamp', 'Name', 'Phone', 'PG Name', 'Profession', 'Gender', 'Sessions', 'Calls',
      'Admin Tag', 'Core Cultivation', 'Calling Purpose', 'Company Name', 'Admin Remarks'
    ];
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();

    // Clear old content and headers completely
    if (lastRow > 0 && lastCol > 0) {
      sheet.getRange(1, 1, lastRow, lastCol).clearContent();
    }

    // Write new headers
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

    if (!records.length) return;

    const rows = records.map((r) => {
      const rowMap = mapContactToRow(r);
      const arr = new Array(headers.length).fill('');
      headers.forEach((h, i) => {
        if (h in rowMap) arr[i] = rowMap[h];
      });
      return arr;
    });
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  });
}

// Shared by fullResyncAll() for the three append-only log tabs (Calling
// Responce, Session Att, Contact collection): clears every data row and
// rewrites it from the matching Supabase table, ordered oldest-first so the
// Sheet reads the same as it always has (append order).
function fullResyncLogSheet(table, sheetName, mapFn, orderCol) {
  const cfg = getConfig();
  if (!cfg.SUPABASE_URL || !cfg.SERVICE_KEY) {
    Logger.log('Supabase credentials not set in Script Properties.');
    return;
  }
  const resp = UrlFetchApp.fetch(
    cfg.SUPABASE_URL + '/rest/v1/' + table + '?select=*&order=' + orderCol + '.asc',
    {
      method: 'get',
      headers: { apikey: cfg.SERVICE_KEY, Authorization: 'Bearer ' + cfg.SERVICE_KEY },
      muteHttpExceptions: true,
    }
  );
  if (resp.getResponseCode() !== 200) {
    Logger.log('Full resync fetch failed for ' + table + ': ' + resp.getContentText());
    return;
  }
  const records = JSON.parse(resp.getContentText());

  withLock(() => {
    const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
    if (!sheet) return;
    const map = headerMap(sheet);
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
    if (!records.length) return;

    const headers = Object.keys(map);
    const rows = records.map((r) => {
      const rowMap = mapFn(r);
      const arr = new Array(lastCol).fill('');
      headers.forEach((h) => {
        if (h in rowMap) arr[map[h] - 1] = rowMap[h];
      });
      return arr;
    });
    sheet.getRange(2, 1, rows.length, lastCol).setValues(rows);
  });
}

function appendSheetRow(sheetName, valuesByHeader) {
  withLock(() => {
    const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
    if (!sheet) return;
    const map = headerMap(sheet);
    const row = sheet.getLastRow() + 1;
    Object.keys(valuesByHeader).forEach((header) => {
      const col = map[header];
      if (col) sheet.getRange(row, col).setValue(valuesByHeader[header]);
    });
  });
}

function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === 'get_new_contacts') {
      const data = getNewContactsData();
      return ContentService.createTextOutput(JSON.stringify({ ok: true, data: data }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Unknown action' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getNewContactsData() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NEW_CONTACTS);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const map = headerMap(sheet);
  const dataRange = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
  const values = dataRange.getValues();
  const result = [];

  for (let i = 0; i < values.length; i++) {
    const colPhone = map['Phone'] || map['Mob No'];
    const mobVal = colPhone ? values[i][colPhone - 1] : null;
    const mob = String(mobVal === undefined || mobVal === null ? '' : mobVal).replace(/\D/g, '');
    if (!mob || mob.length !== 10) continue; // skip empty or invalid phone number rows

    const colProf = map['Profession'] || map['W/S'];
    const rawWs = colProf ? String(values[i][colProf - 1] || 'NA').trim() : 'NA';
    
    result.push({
      mob_no: mob,
      name: String(values[i][map['Name'] - 1] || '').trim(),
      pg_name: String(values[i][map['PG Name'] - 1] || '').trim(),
      profession: String(rawProfession).trim(),
      ws: ['W', 'S', 'NA'].includes(String(rawWs).trim()) ? String(rawWs).trim() : 'NA',
      gender: String(values[i][map['Gender'] - 1] || '').trim(),
      calling_purpose: String(values[i][map['Calling Purpose'] - 1] || '').trim()
    });
  }
  return result;
}

function deleteNewContactsFromSheet(mobNos) {
  if (!mobNos || !mobNos.length) return 0;
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NEW_CONTACTS);
  if (!sheet) return 0;

  const map = headerMap(sheet);
  const col = map['Phone'] || map['Mob No'];
  if (!col) return 0;

  let deletedCount = 0;
  withLock(() => {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const vals = sheet.getRange(2, col, lastRow - 1, 1).getValues();
    for (let i = vals.length - 1; i >= 0; i--) {
      const mob = String(vals[i][0] || '').replace(/\D/g, '');
      if (mobNos.indexOf(mob) !== -1) {
        sheet.deleteRow(i + 2);
        deletedCount++;
      }
    }
  });
  return deletedCount;
}
