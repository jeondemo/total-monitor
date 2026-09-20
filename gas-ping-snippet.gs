function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'ping') return ping_();

  // ↓ 기존 doGet 내용은 그대로 두세요
}

var PING_APP_NAME = 'yaja';
var PING_VERSION = '1';

function ping_() {
  var out = { ok: true, app: PING_APP_NAME, version: PING_VERSION, ts: new Date().toISOString() };
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sh = ss.getSheets()[0];
    out.data = { sheet: sh.getName(), rows: sh.getLastRow() };
  } catch (err) {
    out.ok = false;
    out.error = String(err && err.message ? err.message : err);
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
