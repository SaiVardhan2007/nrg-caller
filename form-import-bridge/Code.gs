/**
 * NRG Caller — Form Import bridge (standalone, unrelated to sheets-bridge).
 * Paste into a NEW, empty Apps Script project (script.google.com -> New
 * project) — NOT bound to any specific spreadsheet, since it must be able to
 * open ANY sheet by ID that the deploying Google account can view.
 * See docs/FORM_IMPORT_SETUP.md.
 */

function getSecret_() {
  return PropertiesService.getScriptProperties().getProperty('FORM_IMPORT_SECRET');
}

function doGet(e) {
  try {
    if (e.parameter.action !== 'get_rows') {
      return json_({ ok: false, error: 'Unknown action' });
    }

    const expected = getSecret_();
    if (!expected || e.parameter.secret !== expected) {
      return json_({ ok: false, error: 'Unauthorized' });
    }

    const sheetId = e.parameter.sheet_id;
    if (!sheetId) return json_({ ok: false, error: 'sheet_id is required' });

    const ss = SpreadsheetApp.openById(sheetId);
    const sheet = e.parameter.tab ? ss.getSheetByName(e.parameter.tab) : ss.getSheets()[0];
    if (!sheet) return json_({ ok: false, error: 'Tab not found' });

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return json_({ ok: true, headers: [], rows: [] });

    // getValues() returns Date objects for Timestamp-formatted cells; these
    // serialize through JSON.stringify as ISO strings automatically, which
    // the client parses back with new Date(...) for the date-filter step.
    const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    const headers = values[0].map(String);
    const rows = values.slice(1);

    return json_({ ok: true, headers: headers, rows: rows });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
