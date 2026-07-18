/* ============================================================
   婚活 すり合わせ – GAS バックエンド (Code.gs)
   スプレッドシートID: 1U2s4pXIuHtxGr71hzx3psW62Co0fx9mKBcMarHZA_hE
   ------------------------------------------------------------
   ・Shares    シート : 共有用の暗号化済み回答（本人／初回閲覧者のみ復号可）
   ・Analytics シート : 統計集計に必要な項目のみを平文で保存
   ------------------------------------------------------------
   デプロイ方法:
   1. スプレッドシートを開き「拡張機能 > Apps Script」でこのコードを貼り付ける。
   2. 「デプロイ > 新しいデプロイ」→ 種類「ウェブアプリ」
      - 実行するユーザー: 自分
      - アクセスできるユーザー: 全員
      でデプロイする（すでに発行済みの /exec URL を app.js の
      GAS_ENDPOINT に設定済み）。
   ============================================================ */

var SPREADSHEET_ID  = '1U2s4pXIuHtxGr71hzx3psW62Co0fx9mKBcMarHZA_hE';
var SHARES_SHEET     = 'Shares';
var ANALYTICS_SHEET  = 'Analytics';
var SCHEMA_VERSION   = 1;

// Shares シートの列番号（1-indexed）
var COL = {
  ID: 1, CIPHER_TEXT: 2, ENCRYPTED_KEY: 3, OWNER_HASH: 4, VIEWER_HASH: 5,
  STATUS: 6, SCHEMA_VERSION: 7, CREATED_AT: 8, UPDATED_AT: 9,
  FIRST_VIEWED_AT: 10, LAST_VIEWED_AT: 11, VIEW_COUNT: 12
};

// Analytics シートの列番号（1-indexed）
// ※ q6（健康上のことで伝えておくこと）は個人特定性が高いため対象外。
//   q39（結婚費用について）はスプレッドシートに列自体が存在しないため
//   現状は書き込んでいません（列を追加すれば拾えるようにできます）。
var ACOL = {
  ID: 1, OWNER_HASH: 2, VIEWER_HASH: 3, CREATED_AT: 4,
  Q1: 5, Q2: 6, Q3: 7, Q4: 8, Q5: 9, Q7: 10, Q8: 11, Q8_OTHER: 12, Q9: 13,
  Q10_1: 14, Q10_2: 15, Q10_3: 16, Q10_4: 17,
  Q11: 18, Q12: 19, Q12_OTHER: 20, Q13: 21, Q13_OTHER: 22,
  Q14: 23, Q14_OTHER: 24, Q15: 25, Q15_OTHER: 26, Q16: 27, Q16_OTHER: 28,
  Q17: 29, Q17_OTHER: 30, Q18: 31, Q18_OTHER: 32,
  Q19: 33, Q20: 34, Q21: 35, Q22: 36, Q23: 37, Q24: 38, Q25: 39, Q26: 40,
  Q27: 41, Q28: 42, Q29: 43, Q30_BUDGET: 44, Q30_AREA: 45, Q31: 46,
  Q32: 47, Q32_PET: 48, Q33: 49, Q34: 50, Q35: 51, Q36: 52, Q37: 53, Q38: 54,
  // ↓ 真剣交際パートナー機能追加分（末尾に追加。既存データには影響しない）
  SERIOUS_RELATIONSHIP_STATUS: 55, PARTNER_HASH: 56,
  SERIOUS_RELATIONSHIP_STARTED_AT: 57, SERIOUS_RELATIONSHIP_ENDED_AT: 58,
  // ↓ Q40（日常生活での気の遣い方）・Q41（嫌なこと）追加分（末尾に追加）
  Q40: 59, Q41: 60
};

var DATA_START_ROW = 2; // 1行目=見出し, 2行目以降がデータ

/* ------------------------------------------------------------
   真剣交際パートナー機能連携（Partners中央API）
   ------------------------------------------------------------ */
var PARTNERS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzqT-qmVRh_jI04stlgYiWCypqWHjWkGv-0pNGkpvUt3c8FGQzQG_FBF7eWeb3frcDk/exec'; // ← Partners用GASの/exec URLを設定
var INTERNAL_SECRET    = PropertiesService.getScriptProperties().getProperty('INTERNAL_SECRET') || '';

/* 指定ownerHashの現在の真剣交際ステータスをPartners APIに問い合わせる。
   ・ active: true  → viewerHash が partnerHash と一致する場合のみ閲覧許可
   ・ everPartnered: true（かつ active:false）→ 過去に交際していたが現在は
     パートナー不在（交際終了後など）。本人以外は誰にも見せない。
   ・ 両方 false → 従来通り「初回閲覧者固定」ロジックを使う
   結果は120秒キャッシュし、Partners API不通時は「everPartnered:false」
   として従来ロジックにフォールバックする（閲覧を過剰にブロックしないため）。 */
function getPartnerStatus(ownerHash) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'partner_' + ownerHash;
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var result = { active: false, everPartnered: false, partnerHash: '' };
  try {
    var url = PARTNERS_ENDPOINT + '?action=status'
      + '&ownerHash=' + encodeURIComponent(ownerHash)
      + '&secret=' + encodeURIComponent(INTERNAL_SECRET);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var body = JSON.parse(res.getContentText());
    if (body.ok) {
      result = {
        active: !!body.active,
        everPartnered: !!body.everPartnered,
        partnerHash: body.partnerHash || ''
      };
    }
  } catch (err) {
    Logger.log('getPartnerStatus failed: ' + err);
  }
  cache.put(cacheKey, JSON.stringify(result), 120);
  return result;
}


/* ------------------------------------------------------------
   エントリポイント
   ------------------------------------------------------------ */
function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'view') {
      return handleView(e.parameter.id, e.parameter.viewerHash);
    }
    return jsonResponse({ ok: false, reason: 'invalid_action' });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'share') {
      return handleShare(body);
    }
    if (body.action === 'syncPartnerStatus') {
      return handleSyncPartnerStatus(body);
    }
    return jsonResponse({ ok: false, reason: 'invalid_action' });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}


/* ------------------------------------------------------------
   共有登録（回答の保存）
   ・cipherText はクライアント側で AES-GCM 暗号化済みのため、
     このサーバー（および管理者）は復号鍵を一切受け取らない。
   ・Analytics: 同じ ownerHash（同一LINEアカウント）から再度共有
     された場合、以前の行を削除したうえで新しい行を追加する
     （＝完全上書き。1人1行に統一される）。
   ・Shares: 同じ ownerHash の既存行のうち、まだ誰にも開かれて
     いない（VIEWER_HASH が空の）行だけを上書き（削除→新規追加）。
     すでに誰かが開いた行は履歴として残し、新しい行を追加する。
     つまり「誰かが開くまでは上書き、開いたら次回は新規行」。
   ------------------------------------------------------------ */
function handleShare(body) {
  var id         = body.id;
  var cipherText = body.cipherText;
  var ownerHash  = body.ownerHash;
  var analytics  = body.analytics || {};

  if (!id || !cipherText || !ownerHash) {
    return jsonResponse({ ok: false, reason: 'invalid_params' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = getSpreadsheet();
    var sharesSheet    = ss.getSheetByName(SHARES_SHEET);
    var analyticsSheet = ss.getSheetByName(ANALYTICS_SHEET);
    var now = new Date();

    removePreviousShares(sharesSheet, ownerHash);
    removePreviousAnalytics(analyticsSheet, ownerHash);

    sharesSheet.appendRow([
      id, cipherText, '', ownerHash, '', 'active', SCHEMA_VERSION,
      now, now, '', '', 0
    ]);

    analyticsSheet.appendRow([
      id, ownerHash, '', now,
      analytics.q1 || '', analytics.q2 || '', analytics.q3 || '',
      analytics.q4 || '', analytics.q5 || '', analytics.q7 || '',
      analytics.q8 || '', analytics.q8_other || '', analytics.q9 || '',
      analytics['q10-1'] || '', analytics['q10-2'] || '', analytics['q10-3'] || '', analytics['q10-4'] || '',
      analytics.q11 || '', analytics.q12 || '', analytics.q12_other || '',
      analytics.q13 || '', analytics.q13_other || '',
      analytics.q14 || '', analytics.q14_other || '',
      analytics.q15 || '', analytics.q15_other || '',
      analytics.q16 || '', analytics.q16_other || '',
      analytics.q17 || '', analytics.q17_other || '',
      analytics.q18 || '', analytics.q18_other || '',
      analytics.q19 || '', analytics.q20 || '',
      analytics.q21 || '', analytics.q22 || '', analytics.q23 || '', analytics.q24 || '',
      analytics.q25 || '', analytics.q26 || '', analytics.q27 || '',
      analytics.q28 || '', analytics.q29 || '',
      analytics.q30_budget || '', analytics.q30_area || '',
      analytics.q31 || '', analytics.q32 || '', analytics.q32_pet || '',
      analytics.q33 || '', analytics.q34 || '', analytics.q35 || '',
      analytics.q36 || '', analytics.q37 || '', analytics.q38 || '',
      '', '', '', '', // SERIOUS_RELATIONSHIP_STATUS / PARTNER_HASH / STARTED_AT / ENDED_AT（初期値は空）
      analytics.q40 || '', analytics.q41 || ''
    ]);

    return jsonResponse({ ok: true, id: id });
  } finally {
    lock.releaseLock();
  }
}

/* 同じ ownerHash の既存 Shares 行のうち、まだ誰にも開かれていない
   （VIEWER_HASH が空の）行だけを削除する。
   ・誰にも開かれていない行 → 上書き対象として削除（この後 appendRow で作り直す）
   ・すでに誰かが開いた行   → 履歴として残す（削除しない）
   これにより「最初に誰かが開くまでは上書き、開いたら次は新規行」という
   挙動になる。 */
function removePreviousShares(sheet, ownerHash) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;
  var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, COL.VIEWER_HASH).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var rowOwnerHash  = values[i][COL.OWNER_HASH - 1];
    var rowViewerHash = values[i][COL.VIEWER_HASH - 1];
    if (rowOwnerHash === ownerHash && !rowViewerHash) {
      sheet.deleteRow(DATA_START_ROW + i);
    }
  }
}

/* 同じ ownerHash の既存 Analytics 行を削除する（完全上書き・1人1行に統一） */
function removePreviousAnalytics(sheet, ownerHash) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;
  var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, ACOL.OWNER_HASH).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (values[i][ACOL.OWNER_HASH - 1] === ownerHash) {
      sheet.deleteRow(DATA_START_ROW + i);
    }
  }
}


/* ------------------------------------------------------------
   閲覧（共有リンクを開いたとき）
   アクセス制御:
   ・本人（ownerHash と一致） → 常に許可
   ・viewerHash が未登録      → この人を初回閲覧者として登録し許可
   ・viewerHash が登録済み    → 一致すれば許可、不一致なら拒否
   ------------------------------------------------------------ */
function handleView(id, viewerHash) {
  if (!id) return jsonResponse({ ok: false, reason: 'invalid_params' });
  if (!viewerHash) return jsonResponse({ ok: false, reason: 'login_required' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSpreadsheet().getSheetByName(SHARES_SHEET);
    var rowIndex = findRowById(sheet, id);
    if (!rowIndex) return jsonResponse({ ok: false, reason: 'not_found' });

    var row = sheet.getRange(rowIndex, 1, 1, COL.VIEW_COUNT).getValues()[0];
    var cipherText         = row[COL.CIPHER_TEXT - 1];
    var ownerHash           = row[COL.OWNER_HASH - 1];
    var existingViewerHash  = row[COL.VIEWER_HASH - 1];
    var status              = row[COL.STATUS - 1];

    if (status !== 'active') {
      return jsonResponse({ ok: false, reason: status === 'active' ? 'not_found' : status });
    }

    var now = new Date();
    var allowed = false;
    var partnerInfo = getPartnerStatus(ownerHash);

    if (viewerHash === ownerHash) {
      allowed = true;
    } else if (partnerInfo.active) {
      allowed = (viewerHash === partnerInfo.partnerHash);
    } else if (partnerInfo.everPartnered) {
      allowed = false;
    } else if (!existingViewerHash) {
      allowed = true;
      sheet.getRange(rowIndex, COL.VIEWER_HASH).setValue(viewerHash);
      sheet.getRange(rowIndex, COL.FIRST_VIEWED_AT).setValue(now);
      updateAnalyticsViewerHash(id, viewerHash);
    } else if (existingViewerHash === viewerHash) {
      allowed = true;
    } else {
      allowed = false;
    }

    if (!allowed) {
      return jsonResponse({ ok: false, reason: (partnerInfo.active || partnerInfo.everPartnered) ? 'partner_locked' : 'forbidden' });
    }

    sheet.getRange(rowIndex, COL.LAST_VIEWED_AT).setValue(now);
    var viewCountCell = sheet.getRange(rowIndex, COL.VIEW_COUNT);
    viewCountCell.setValue((Number(viewCountCell.getValue()) || 0) + 1);

    return jsonResponse({ ok: true, cipherText: cipherText });
  } finally {
    lock.releaseLock();
  }
}

function updateAnalyticsViewerHash(id, viewerHash) {
  var sheet = getSpreadsheet().getSheetByName(ANALYTICS_SHEET);
  var rowIndex = findRowById(sheet, id);
  if (rowIndex) sheet.getRange(rowIndex, ACOL.VIEWER_HASH).setValue(viewerHash);
}

/* ------------------------------------------------------------
   Partners APIからの真剣交際ステータス同期
   ------------------------------------------------------------ */
function handleSyncPartnerStatus(body) {
  if (!INTERNAL_SECRET || body.secret !== INTERNAL_SECRET) {
    return jsonResponse({ ok: false, reason: 'forbidden' });
  }
  var ownerHash = body.ownerHash;
  if (!ownerHash) return jsonResponse({ ok: false, reason: 'invalid_params' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSpreadsheet().getSheetByName(ANALYTICS_SHEET);
    var rowIndex = findAnalyticsRowByOwnerHash(sheet, ownerHash);
    if (!rowIndex) return jsonResponse({ ok: true, skipped: true });

    sheet.getRange(rowIndex, ACOL.SERIOUS_RELATIONSHIP_STATUS).setValue(body.status || '');
    sheet.getRange(rowIndex, ACOL.PARTNER_HASH).setValue(body.partnerHash || '');
    sheet.getRange(rowIndex, ACOL.SERIOUS_RELATIONSHIP_STARTED_AT).setValue(body.startedAt || '');
    sheet.getRange(rowIndex, ACOL.SERIOUS_RELATIONSHIP_ENDED_AT).setValue(body.endedAt || '');
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

/* Analyticsシート上で ownerHash が一致する行を探す（見つからなければ null） */
function findAnalyticsRowByOwnerHash(sheet, ownerHash) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return null;
  var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, ACOL.OWNER_HASH).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][ACOL.OWNER_HASH - 1] === ownerHash) return DATA_START_ROW + i;
  }
  return null;
}

/* id (A列) からデータ行番号を探す。見つからなければ null */
function findRowById(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return null;
  var ids = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return DATA_START_ROW + i;
  }
  return null;
}
