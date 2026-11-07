/**
 * スプレッドシートの読み書き
 */

const SETTING_DEFS = [
  { key: 'title', label: '大会名', def: '卓球大会', type: 'string', desc: 'Webページのタイトルに表示されます' },
  { key: 'leagueCount', label: 'リーグ戦の数', def: 4, type: 'int', desc: 'リーグ（グループ）の数' },
  { key: 'playersPerLeague', label: '各リーグの標準選手数', def: 4, type: 'int', desc: 'リーグ数の目安計算に使います。人数が割り切れない場合は ±1 名で調整されます' },
  { key: 'leagueSets', label: 'リーグ戦のセット数', def: 3, type: 'sets', desc: '3 = 3セットマッチ（2セット先取）' },
  { key: 'upperSets', label: '上位トーナメントのセット数', def: 5, type: 'sets', desc: '5 = 5セットマッチ（3セット先取）' },
  { key: 'lowerSets', label: '下位トーナメントのセット数', def: 3, type: 'sets', desc: '3 = 3セットマッチ（2セット先取）' },
  { key: 'advanceCount', label: '上位トーナメント進出人数（各リーグ）', def: 2, type: 'int', desc: '各リーグの上位何名が上位トーナメントに進むか' },
  { key: 'autoAssignLate', label: '遅れて来た選手をリーグに自動追加', def: true, type: 'bool', desc: 'TRUE なら、リーグ作成後に参加・支払確認が付いた選手を人数の少ないリーグへ自動で追加します（くじ番号が空欄なら自動で付けます）' },
  { key: 'adminPassword', label: '管理者パスワード', def: 'admin', type: 'string', desc: 'Web の管理者メニューに入るためのパスワード。必ず変更してください' },
  { key: 'entryCode', label: '選手入力パスコード', def: '', type: 'string', desc: '空欄なら不要。設定すると「選手用」に入るときに入力を求めます' },
];

const PLAYER_HEADERS = ['名前', '所属', '参加確認', '支払確認', 'くじ番号', 'リーグ', '備考'];
const LEAGUE_HEADERS = ['リーグ', 'くじ番号', '名前', '所属'];
const STANDING_HEADERS = ['リーグ', '順位', 'くじ番号', '名前', '所属', '試合数', '勝', '敗', '勝率', '獲得セット', '失セット', 'セット率', '得点', '失点', '進出先', '状態'];

function ss_() {
  if (CTX.ss) return CTX.ss;
  if (CTX.ssId) {
    CTX.ss = SpreadsheetApp.openById(CTX.ssId);
    return CTX.ss;
  }
  // スプレッドシートに紐付いたスクリプトとして使う場合（メニューからの実行）
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('大会が選択されていません。トップに戻って大会を選んでください。');
  return active;
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) {
    throw new Error('シート「' + name + '」が見つかりません。スプレッドシートのメニュー「🏓 卓球大会 > 初期セットアップ」を実行してください。');
  }
  return sh;
}

/* ------------------------------------------------------------------ */
/* セットアップ                                                        */
/* ------------------------------------------------------------------ */

function setupSheets_() {
  const ss = ss_();

  // 設定
  let sh = ss.getSheetByName(SHEET.SETTINGS) || ss.insertSheet(SHEET.SETTINGS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 3).setValues([['項目', '値', '説明']]).setFontWeight('bold').setBackground('#e8eef7');
  }
  const existing = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  SETTING_DEFS.forEach(function (d) {
    if (existing.indexOf(d.label) < 0) sh.appendRow([d.label, d.def, d.desc]);
  });
  sh.setColumnWidth(1, 280);
  sh.setColumnWidth(2, 160);
  sh.setColumnWidth(3, 480);
  sh.setFrozenRows(1);

  // 参加者
  sh = ss.getSheetByName(SHEET.PLAYERS) || ss.insertSheet(SHEET.PLAYERS, 0);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, PLAYER_HEADERS.length).setValues([PLAYER_HEADERS]).setFontWeight('bold').setBackground('#e8eef7');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 160);
    sh.setColumnWidth(2, 140);
    sh.setColumnWidth(7, 240);
  }
  const pc = playerColumns_(sh);
  const rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sh.getRange(2, pc.attend + 1, 500, 1).setDataValidation(rule);
  sh.getRange(2, pc.paid + 1, 500, 1).setDataValidation(rule);

  // リーグ（システムが書き込む）
  sh = ss.getSheetByName(SHEET.LEAGUES) || ss.insertSheet(SHEET.LEAGUES);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, LEAGUE_HEADERS.length).setValues([LEAGUE_HEADERS]).setFontWeight('bold').setBackground('#f3e8d6');
    sh.setFrozenRows(1);
  }

  // 試合（システムが書き込む）
  sh = ss.getSheetByName(SHEET.MATCHES) || ss.insertSheet(SHEET.MATCHES);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, MATCH_HEADERS.length).setValues([MATCH_HEADERS]).setFontWeight('bold').setBackground('#f3e8d6');
    sh.setFrozenRows(1);
  }
  sh.getRange(2, MCOL.SET0 + 1, Math.max(sh.getMaxRows() - 1, 1), MAX_SETS).setNumberFormat('@');

  // 順位（システムが書き込む）
  sh = ss.getSheetByName(SHEET.STANDINGS) || ss.insertSheet(SHEET.STANDINGS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, STANDING_HEADERS.length).setValues([STANDING_HEADERS]).setFontWeight('bold').setBackground('#f3e8d6');
    sh.setFrozenRows(1);
  }

  clearCache_();
}

function addSamplePlayers_(n) {
  const sh = sheet_(SHEET.PLAYERS);
  const pc = playerColumns_(sh);
  const last = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田', '佐々木', '山口', '松本', '井上', '木村', '林', '清水', '森'];
  const first = ['翔太', '陽菜', '蓮', '結衣', '大翔', 'さくら', '悠真', '美咲', '湊', '葵'];
  const teams = ['A中学', 'B中学', 'Cクラブ', 'D高校'];
  const nums = shuffle_(Array.from({ length: n }, function (_, i) { return i + 1; }));
  const width = Math.max(sh.getLastColumn(), PLAYER_HEADERS.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(width).fill('');
    row[pc.name] = last[i % last.length] + ' ' + first[(i * 3) % first.length];
    row[pc.team] = teams[i % teams.length];
    row[pc.attend] = true;
    row[pc.paid] = true;
    row[pc.num] = nums[i];
    rows.push(row);
  }
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, width).setValues(rows);
  clearCache_();
}

/* ------------------------------------------------------------------ */
/* 設定                                                                */
/* ------------------------------------------------------------------ */

function getSettings_() {
  const sh = sheet_(SHEET.SETTINGS);
  const values = sh.getDataRange().getValues();
  const byLabel = {};
  for (let i = 1; i < values.length; i++) byLabel[String(values[i][0]).trim()] = values[i][1];
  const s = {};
  SETTING_DEFS.forEach(function (d) {
    const v = byLabel[d.label];
    s[d.key] = normalizeSetting_(d, v === undefined || v === '' ? d.def : v);
  });
  return s;
}

function normalizeSetting_(d, v) {
  if (d.type === 'bool') return truthy_(v);
  if (d.type === 'string') return String(v == null ? '' : v).trim();
  const n = parseInt(v, 10);
  return isNaN(n) ? d.def : n;
}

/** 入力値チェック。エラーなら例外。 */
function validateSettings_(s) {
  const errs = [];
  ['leagueCount', 'playersPerLeague', 'advanceCount'].forEach(function (k) {
    if (!(Number.isInteger(s[k]) && s[k] >= 1)) errs.push(labelOf_(k) + ' は 1 以上の整数で入力してください');
  });
  ['leagueSets', 'upperSets', 'lowerSets'].forEach(function (k) {
    if ([1, 3, 5, 7].indexOf(s[k]) < 0) errs.push(labelOf_(k) + ' は 1 / 3 / 5 / 7 のいずれかにしてください');
  });
  if (errs.length) throw new Error(errs.join('\n'));
}

function labelOf_(key) {
  for (let i = 0; i < SETTING_DEFS.length; i++) if (SETTING_DEFS[i].key === key) return SETTING_DEFS[i].label;
  return key;
}

function saveSettings_(input) {
  const cur = getSettings_();
  const next = {};
  SETTING_DEFS.forEach(function (d) {
    next[d.key] = input && input[d.key] !== undefined && input[d.key] !== null ? normalizeSetting_(d, input[d.key]) : cur[d.key];
  });
  if (!next.adminPassword) next.adminPassword = cur.adminPassword; // 空にはさせない
  validateSettings_(next);

  const sh = sheet_(SHEET.SETTINGS);
  const values = sh.getDataRange().getValues();
  SETTING_DEFS.forEach(function (d) {
    let row = -1;
    for (let i = 1; i < values.length; i++) if (String(values[i][0]).trim() === d.label) row = i + 1;
    if (row < 0) {
      sh.appendRow([d.label, next[d.key], d.desc]);
    } else {
      sh.getRange(row, 2).setValue(next[d.key]);
    }
  });
  return next;
}

/* ------------------------------------------------------------------ */
/* 参加者                                                              */
/* ------------------------------------------------------------------ */

function playerColumns_(sh) {
  const width = Math.max(sh.getLastColumn(), 1);
  const header = sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); });
  const find = function (names) {
    for (let i = 0; i < names.length; i++) {
      const idx = header.indexOf(names[i]);
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const c = {
    name: find(['名前', '氏名', '選手名']),
    team: find(['所属', 'チーム', 'クラブ']),
    attend: find(['参加確認', '参加']),
    paid: find(['支払確認', '支払', '支払い確認']),
    num: find(['くじ番号', '番号', 'くじ']),
    league: find(['リーグ']),
    note: find(['備考']),
  };
  const missing = [];
  if (c.name < 0) missing.push('名前');
  if (c.attend < 0) missing.push('参加確認');
  if (c.paid < 0) missing.push('支払確認');
  if (c.num < 0) missing.push('くじ番号');
  if (missing.length) {
    throw new Error('「参加者」シートの1行目に次の見出しが必要です: ' + missing.join('、'));
  }
  return c;
}

function truthy_(v) {
  if (v === true) return true;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return ['true', '済', '済み', '○', '〇', '◯', 'o', 'ok', 'はい', 'yes', 'y', '1', '✓', '✔', 'レ'].indexOf(s) >= 0;
}

function toNum_(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); }).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

function readPlayers_() {
  const sh = sheet_(SHEET.PLAYERS);
  const c = playerColumns_(sh);
  const values = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const name = String(r[c.name] == null ? '' : r[c.name]).trim();
    if (!name) continue;
    out.push({
      row: i + 1,
      name: name,
      team: c.team >= 0 ? String(r[c.team] == null ? '' : r[c.team]).trim() : '',
      attend: truthy_(r[c.attend]),
      paid: truthy_(r[c.paid]),
      num: toNum_(r[c.num]),
      rawNum: r[c.num],
      league: c.league >= 0 ? r[c.league] : '',
    });
  }
  return out;
}

function eligiblePlayers_(players) {
  return players.filter(function (p) { return p.attend && p.paid && p.num != null; });
}

/** くじ番号の重複チェック（参加・支払済みの選手のみ） */
function duplicateNumbers_(players) {
  const seen = {};
  eligiblePlayers_(players).forEach(function (p) {
    (seen[p.num] = seen[p.num] || []).push(p.name);
  });
  return Object.keys(seen)
    .filter(function (k) { return seen[k].length > 1; })
    .map(function (k) { return { num: Number(k), names: seen[k] }; });
}

/** 参加・支払済みでくじ番号が空欄の選手に、未使用の番号をランダムに割り当てる（ロックは呼び出し側） */
function assignMissingNumbersCore_() {
  const sh = sheet_(SHEET.PLAYERS);
  const c = playerColumns_(sh);
  const players = readPlayers_();
  const used = {};
  players.forEach(function (p) { if (p.num != null) used[p.num] = true; });
  const targets = players.filter(function (p) { return p.attend && p.paid && p.num == null && String(p.rawNum == null ? '' : p.rawNum).trim() === ''; });
  const free = [];
  for (let n = 1; free.length < targets.length; n++) if (!used[n]) free.push(n);
  const picks = shuffle_(free);
  return targets.map(function (p, i) {
    sh.getRange(p.row, c.num + 1).setValue(picks[i]);
    return { name: p.name, team: p.team, num: picks[i] };
  });
}

function autoAssignNumbers_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const assigned = assignMissingNumbersCore_();
    clearCache_();
    return { assigned: assigned };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* リーグ / 試合                                                       */
/* ------------------------------------------------------------------ */

function readLeagueRows_() {
  const sh = sheet_(SHEET.LEAGUES);
  const values = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const league = toNum_(values[i][0]);
    const num = toNum_(values[i][1]);
    if (league == null || num == null) continue;
    out.push({ league: league, num: num, name: String(values[i][2] || ''), team: String(values[i][3] || '') });
  }
  return out;
}

function readMatchValues_() {
  const sh = sheet_(SHEET.MATCHES);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, MATCH_HEADERS.length).getValues();
}

function rowToMatch_(r) {
  const sets = [];
  for (let k = 0; k < MAX_SETS; k++) {
    const s = parseSetCell_(r[MCOL.SET0 + k]);
    if (!s) break;
    sets.push(s);
  }
  const status = String(r[MCOL.STATUS] || STATUS.NONE);
  const updated = r[MCOL.UPDATED];
  return {
    id: String(r[MCOL.ID]),
    league: toNum_(r[MCOL.LEAGUE]),
    no: toNum_(r[MCOL.NO]),
    p1: toNum_(r[MCOL.P1]),
    n1: String(r[MCOL.N1] || ''),
    p2: toNum_(r[MCOL.P2]),
    n2: String(r[MCOL.N2] || ''),
    status: status === STATUS.DONE || status === STATUS.PROGRESS ? status : STATUS.NONE,
    bestOf: toNum_(r[MCOL.BEST_OF]) || 3,
    c1: Number(r[MCOL.C1]) || 0,
    c2: Number(r[MCOL.C2]) || 0,
    winner: toNum_(r[MCOL.WINNER]),
    sets: sets,
    updated: updated instanceof Date ? Utilities.formatDate(updated, 'Asia/Tokyo', 'M/d HH:mm') : String(updated || ''),
    ver: Number(r[MCOL.VER]) || 0,
  };
}

function valuesToMatches_(values) {
  return values
    .filter(function (r) { return String(r[MCOL.ID]).trim() !== ''; })
    .map(rowToMatch_);
}

/** 順位シートを書き直す */
function writeStandingsSheet_(snap) {
  const sh = sheet_(SHEET.STANDINGS);
  const rows = [];
  snap.leagueList.forEach(function (no) {
    const L = snap.leagues[no];
    L.standings.forEach(function (s) {
      rows.push([
        no, s.rank, s.num, s.name, s.team, s.played, s.wins, s.losses,
        s.played ? Math.round((s.wins / s.played) * 1000) / 1000 : '',
        s.setsWon, s.setsLost,
        s.ratioInf ? '∞' : s.played ? Math.round(s.ratio * 1000) / 1000 : '',
        s.ptsWon, s.ptsLost,
        s.advance === 'upper' ? '上位トーナメント' : '下位トーナメント',
        L.complete ? '確定' : '暫定',
      ]);
    });
  });
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, STANDING_HEADERS.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, STANDING_HEADERS.length).setValues(rows);
}
