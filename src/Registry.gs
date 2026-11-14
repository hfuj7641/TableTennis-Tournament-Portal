/**
 * 大会（トーナメント）の登録簿
 *
 * 1つの Web アプリで複数の大会を扱えるようにする。
 * 大会ごとに専用のスプレッドシートを持ち、一覧はスクリプトプロパティに保存する。
 *
 *   TOURNAMENTS     : [{ id, name, date, ssId, createdAt, hidden }]
 *   MASTER_PASSWORD : 大会を作成・管理するためのシステム管理者パスワード
 */

const PROP_TOURNAMENTS = 'TOURNAMENTS';
const PROP_MASTER = 'MASTER_PASSWORD';
const PROP_PUBLIC_URL = 'PUBLIC_URL'; // 独自ドメインの公開URL（例: https://portal.example.com/）

/** 現在のリクエストで扱っている大会 */
const CTX = { tid: null, ssId: null, ss: null };

function props_() {
  return PropertiesService.getScriptProperties();
}

function listTournaments_() {
  const raw = props_().getProperty(PROP_TOURNAMENTS);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

function saveTournaments_(list) {
  props_().setProperty(PROP_TOURNAMENTS, JSON.stringify(list));
}

function getTournament_(tid) {
  const list = listTournaments_();
  for (let i = 0; i < list.length; i++) if (list[i].id === tid) return list[i];
  return null;
}

/** 以降の処理（ss_() やキャッシュ）をこの大会のものにする */
function useTournament_(tid) {
  const t = getTournament_(String(tid || ''));
  if (!t) throw new Error('大会が見つかりません。トップに戻って大会を選び直してください。');
  CTX.tid = t.id;
  CTX.ssId = t.ssId;
  CTX.ss = null;
  return t;
}

function updateTournament_(tid, patch) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const list = listTournaments_();
    list.forEach(function (t) {
      if (t.id === tid) Object.keys(patch).forEach(function (k) { t[k] = patch[k]; });
    });
    saveTournaments_(list);
  } finally {
    lock.releaseLock();
  }
}

/** Apps Script のウェブアプリの URL */
function gasUrl_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (err) {
    return '';
  }
}

/** 共有用の URL（公開URL＝独自ドメインが設定されていればそちら） */
function webAppUrl_() {
  const pub = props_().getProperty(PROP_PUBLIC_URL);
  return pub || gasUrl_();
}

/** 公開URL（独自ドメイン）を設定する。空なら Apps Script の URL に戻す */
function sysSetPublicUrl(pw, url) {
  checkMaster_(pw);
  url = String(url || '').trim();
  if (url) {
    if (!/^https:\/\/[^\s/?#]+\.[^\s/?#]+/.test(url)) throw new Error('公開URLは https:// から始まるURLで入力してください（例: https://portal.example.com/）。');
    url = url.replace(/[?#].*$/, '');
    if (!/\/$/.test(url)) url += '/';
    props_().setProperty(PROP_PUBLIC_URL, url);
  } else {
    props_().deleteProperty(PROP_PUBLIC_URL);
  }
  return sysGetData(pw);
}

function publicTournament_(t) {
  return { id: t.id, name: t.name, date: t.date || '', hidden: !!t.hidden, status: t.status || '開催中' };
}

/* ------------------------------------------------------------------ */
/* 公開 API                                                            */
/* ------------------------------------------------------------------ */

/** 選手・閲覧者向けの大会一覧（非表示の大会は除く） */
function apiListTournaments() {
  const list = listTournaments_()
    .filter(function (t) { return !t.hidden; })
    .map(publicTournament_);
  list.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return JSON.stringify({ tournaments: list, masterSet: !!props_().getProperty(PROP_MASTER) });
}

/** URL の ?t=xxx で直接開く場合（非表示の大会でも ID が分かれば開ける） */
function apiGetTournament(tid) {
  const t = getTournament_(String(tid || ''));
  return JSON.stringify(t ? publicTournament_(t) : null);
}

/* ------------------------------------------------------------------ */
/* システム管理者（大会の作成・管理）                                    */
/* ------------------------------------------------------------------ */

function checkMaster_(pw) {
  const m = props_().getProperty(PROP_MASTER);
  if (!m) throw new Error('システム管理者パスワードが未設定です。');
  if (String(pw || '') !== m) throw new Error('システム管理者パスワードが違います。');
}

function isMaster_(pw) {
  const m = props_().getProperty(PROP_MASTER);
  return !!m && String(pw || '') === m;
}

/** 初回のみ: システム管理者パスワードを設定する */
function sysSetup(pw) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (props_().getProperty(PROP_MASTER)) throw new Error('システム管理者パスワードは設定済みです。');
    pw = String(pw || '');
    if (pw.length < 4) throw new Error('パスワードは4文字以上にしてください。');
    props_().setProperty(PROP_MASTER, pw);
  } finally {
    lock.releaseLock();
  }
  return sysGetData(pw);
}

function sysGetData(pw) {
  checkMaster_(pw);
  const url = webAppUrl_();
  const list = listTournaments_().map(function (t) {
    return {
      id: t.id, name: t.name, date: t.date || '', hidden: !!t.hidden, status: t.status || '開催中', createdAt: t.createdAt || '',
      ssUrl: 'https://docs.google.com/spreadsheets/d/' + t.ssId + '/edit',
      link: url ? url + '?t=' + t.id : '',
    };
  });
  list.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return JSON.stringify({ tournaments: list, publicUrl: props_().getProperty(PROP_PUBLIC_URL) || '', gasUrl: gasUrl_(), logSecret: props_().getProperty(PROP_LOG_SECRET) || '', mail: mailConfig_() });
}

function sysChangePassword(pw, next) {
  checkMaster_(pw);
  next = String(next || '');
  if (next.length < 4) throw new Error('パスワードは4文字以上にしてください。');
  props_().setProperty(PROP_MASTER, next);
  return sysGetData(next);
}

/**
 * 大会を作成する。
 * input = { name, date, adminPassword, sheetUrl }
 *   sheetUrl を指定した場合は、そのスプレッドシート（事前に選手名を入れたもの等）を使う。
 *   空なら新しいスプレッドシートを作る。
 */
function sysCreateTournament(pw, input) {
  checkMaster_(pw);
  input = input || {};
  const name = String(input.name || '').trim();
  if (!name) throw new Error('大会名を入力してください。');
  const adminPassword = String(input.adminPassword || '').trim();
  if (!adminPassword) throw new Error('大会管理者パスワードを入力してください。');

  let ss;
  const sheetUrl = String(input.sheetUrl || '').trim();
  if (sheetUrl) {
    const m = sheetUrl.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
    const id = m ? m[1] : sheetUrl;
    try {
      ss = SpreadsheetApp.openById(id);
    } catch (err) {
      throw new Error('スプレッドシートを開けませんでした。URL と、このアプリを公開したアカウントに編集権限があるか確認してください。');
    }
    if (listTournaments_().some(function (t) { return t.ssId === ss.getId(); })) {
      throw new Error('このスプレッドシートは既に別の大会で使われています。');
    }
  } else {
    ss = SpreadsheetApp.create('【卓球大会】' + name + (input.date ? '（' + input.date + '）' : ''));
  }

  const t = {
    id: Utilities.getUuid().replace(/-/g, '').slice(0, 10),
    name: name,
    date: String(input.date || ''),
    ssId: ss.getId(),
    createdAt: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'),
    hidden: false,
    status: '開催前',
  };

  CTX.tid = t.id;
  CTX.ssId = t.ssId;
  CTX.ss = ss;
  setupSheets_();
  // 新規作成時に自動で作られる「シート1」を削除
  const first = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);
  saveSettings_({ title: name, adminPassword: adminPassword, status: '開催前' }); // 新しい大会は「開催前」から
  installEditTrigger_(ss);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const list = listTournaments_();
    list.push(t);
    saveTournaments_(list);
  } finally {
    lock.releaseLock();
  }
  const data = JSON.parse(sysGetData(pw));
  data.created = t.id;
  return JSON.stringify(data);
}

function sysUpdateTournament(pw, tid, patch) {
  checkMaster_(pw);
  const t = getTournament_(tid);
  if (!t) throw new Error('大会が見つかりません。');
  const p = {};
  if (patch && patch.name !== undefined) {
    p.name = String(patch.name).trim() || t.name;
    useTournament_(tid);
    saveSettings_({ title: p.name });
    clearCache_();
  }
  if (patch && patch.date !== undefined) p.date = String(patch.date);
  if (patch && patch.hidden !== undefined) p.hidden = !!patch.hidden;
  updateTournament_(tid, p);
  return sysGetData(pw);
}

/** 一覧から削除する（スプレッドシート自体は削除しない） */
function sysRemoveTournament(pw, tid) {
  checkMaster_(pw);
  const t = getTournament_(tid);
  if (!t) throw new Error('大会が見つかりません。');
  removeEditTrigger_(t.ssId);
  CTX.tid = t.id;
  clearCache_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    saveTournaments_(listTournaments_().filter(function (x) { return x.id !== tid; }));
  } finally {
    lock.releaseLock();
  }
  return sysGetData(pw);
}

/* ------------------------------------------------------------------ */
/* スプレッドシートを直接編集したときにキャッシュを破棄するトリガー        */
/* ------------------------------------------------------------------ */

function installEditTrigger_(ss) {
  try {
    removeEditTrigger_(ss.getId());
    ScriptApp.newTrigger('handleTournamentEdit').forSpreadsheet(ss).onEdit().create();
  } catch (err) {
    console.warn('trigger install failed: ' + err);
  }
}

function removeEditTrigger_(ssId) {
  try {
    ScriptApp.getProjectTriggers().forEach(function (tr) {
      if (tr.getHandlerFunction() === 'handleTournamentEdit' && tr.getTriggerSourceId() === ssId) ScriptApp.deleteTrigger(tr);
    });
  } catch (err) {
    console.warn('trigger remove failed: ' + err);
  }
}

/** インストール型 onEdit トリガーのハンドラ */
function handleTournamentEdit(e) {
  try {
    const ssId = e && e.source ? e.source.getId() : '';
    const t = listTournaments_().filter(function (x) { return x.ssId === ssId; })[0];
    if (!t) return;
    CTX.tid = t.id;
    CTX.ssId = t.ssId;
    CTX.ss = e.source;
    clearCache_();
    // 参加者シートの編集なら、遅れて来た選手をリーグへ自動追加
    if (e.range && e.range.getSheet().getName() === SHEET.PLAYERS) {
      autoAssignLatePlayers_();
      syncWithdrawals_(); // 棄権のチェック → トーナメントの不戦敗
    }
  } catch (err) {
    console.warn('handleTournamentEdit: ' + err);
  }
}
