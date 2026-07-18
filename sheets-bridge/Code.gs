/**
 * NRG Caller — Sheets <-> Supabase bridge.
 * Paste this whole file into the Sheet's Extensions > Apps Script editor.
 * See docs/SHEETS_SYNC_SETUP.md for the one-time setup steps.
 */

const SHEET_ADMIN = 'Admin Page';
const SHEET_CONTACTS = 'Master Contact';
const SHEET_BODY_TEXT = 'Body Text';
const SHEET_CALL_RESPONSES = 'Calling Responce';
const SHEET_SESSION_ATT = 'Session Att';
const SHEET_COLLECTION = 'Contact collection';
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
    else if (name === SHEET_CONTACTS) syncMasterContactRow(sheet, row);
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

  const status = String(cellVal(sheet, row, map, 'User Status') || 'User').trim();
  const role = (status === 'Admin' || status === 'Reception') ? status : 'User';
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

function syncMasterContactRow(sheet, row) {
  const map = headerMap(sheet);
  const mob = String(cellVal(sheet, row, map, 'Mob No') || '').replace(/\D/g, '');
  if (mob.length !== 10) return;

  supabaseUpsert('contacts', {
    mob_no: mob,
    name: String(cellVal(sheet, row, map, 'Name') || '').trim(),
    pg_name: String(cellVal(sheet, row, map, 'PG Name') || '') || null,
    profession: String(cellVal(sheet, row, map, 'Profession') || '') || null,
    company_name: String(cellVal(sheet, row, map, 'Company Name') || '') || null,
    ws: String(cellVal(sheet, row, map, 'W/S') || 'NA').trim() || 'NA',
    admin_remarks: String(cellVal(sheet, row, map, 'Admin Remakrs') || '') || null,
    admin_tag: String(cellVal(sheet, row, map, 'Admin tag') || '') || null,
    core_cultivation: String(cellVal(sheet, row, map, 'Core Cultivation') || '') || null,
    calling_purpose: String(cellVal(sheet, row, map, 'Calling Purpose') || '') || null,
  }, 'mob_no');
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

/* ============ OUTBOUND: Supabase change -> this Sheet ============ */
/* Called by a Supabase Database Webhook (pg_net) on insert/update. */

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const table = body.table;
    const record = body.record;

    if (table === 'users') {
      upsertSheetRow(SHEET_ADMIN, 'User Name', record.user_name, mapUserToRow(record));
    } else if (table === 'contacts') {
      upsertSheetRow(SHEET_CONTACTS, 'Mob No', record.mob_no, mapContactToRow(record));
    } else if (table === 'settings' && record.key === 'message_text') {
      SpreadsheetApp.getActive().getSheetByName(SHEET_BODY_TEXT).getRange(MESSAGE_CELL).setValue(record.value);
    } else if (table === 'call_responses') {
      appendSheetRow(SHEET_CALL_RESPONSES, mapCallResponseToRow(record));
    } else if (table === 'session_attendance') {
      appendSheetRow(SHEET_SESSION_ATT, mapAttendanceToRow(record));
    } else if (table === 'contact_collection') {
      appendSheetRow(SHEET_COLLECTION, mapCollectionToRow(record));
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
    'Mob No': r.mob_no,
    'Name': r.name,
    'PG Name': r.pg_name || '',
    'Profession': r.profession || '',
    'Company Name': r.company_name || '',
    'W/S': r.ws || 'NA',
    'No of Sessions': r.sessions_count === null || r.sessions_count === undefined ? 0 : r.sessions_count,
    'Admin Remakrs': r.admin_remarks || '',
    'Admin tag': r.admin_tag || '',
    'Core Cultivation': r.core_cultivation || '',
    'Calling Purpose': r.calling_purpose || '',
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
  return { 'Time stamp': r.ts, 'Mob No': r.mob_no, 'Name': r.name, 'took by': r.took_by };
}

function mapCollectionToRow(r) {
  return {
    'time stamp': r.ts,
    'Mob No': r.mob_no,
    'Name': r.name,
    'PG Name': r.pg_name || '',
    'Profession': r.profession || '',
    'Company Name': r.company_name || '',
    'collected by': r.collected_by,
    'remarks': r.remarks || '',
  };
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
