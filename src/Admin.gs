/**
 * 管理者向けの機能（設定・くじ番号・リーグ戦作成・当日追加）
 */

/** 大会管理者パスワード（またはシステム管理者パスワード）を確認する */
function checkAdmin_(pw) {
  const s = getSettings_();
  if (isMaster_(pw)) return s;
  if (!s.adminPassword) throw new Error('「設定」シートで管理者パスワードを設定してください。');
  if (String(pw || '') !== s.adminPassword) throw new Error('管理者パスワードが違います。');
  return s;
}

function adminLogin(tid, pw) {
  useTournament_(tid);
  checkAdmin_(pw);
  return adminGetData(tid, pw);
}

function adminGetData(tid, pw, autoAdded) {
  if (autoAdded && autoAdded.__meta) autoAdded = null; // 画面の情報（更新ログ用）は無視
  useTournament_(tid);
  const settings = checkAdmin_(pw);
  if (!autoAdded) autoAdded = autoAssignLatePlayers_().added;
  // 列を追加したら表示データを作り直す
  if (ensureWithdrawColumn_() | ensureGradeColumn_() | ensureEmailColumn_()) clearCache_();
  syncWithdrawals_();
  const players = readPlayers_();
  const leagueRows = readLeagueRows_();
  const matches = valuesToMatches_(readMatchValues_());
  const assigned = {};
  leagueRows.forEach(function (r) { assigned[r.num] = r.league; });

  const elig = eligiblePlayers_(players);
  const t = getTournament_(tid);
  const url = webAppUrl_();
  const leagueNos = {};
  leagueRows.forEach(function (r) { leagueNos[r.league] = (leagueNos[r.league] || 0) + 1; });

  return JSON.stringify({
    tournament: { id: tid, name: t ? t.name : settings.title, date: t ? t.date : '' },
    ssUrl: ss_().getUrl(),
    link: url ? url + '?t=' + tid : '',
    settings: settings,
    autoAdded: autoAdded || [],
    stats: {
      total: players.length,
      attend: players.filter(function (p) { return p.attend; }).length,
      paid: players.filter(function (p) { return p.paid; }).length,
      attendPaid: players.filter(function (p) { return p.attend && p.paid; }).length,
      eligible: elig.length,
    },
    withdrawn: players.filter(function (p) { return p.withdrawn; }).map(pick_),
    attendNotPaid: players.filter(function (p) { return p.attend && !p.paid; }).map(pick_),
    missingNumber: players.filter(function (p) { return p.attend && p.paid && p.num == null; }).map(pick_),
    duplicates: duplicateNumbers_(players),
    leagues: Object.keys(leagueNos).map(Number).sort(function (a, b) { return a - b; }).map(function (no) {
      const ms = matches.filter(function (m) { return m.league === no; });
      return {
        no: no,
        count: leagueNos[no],
        total: ms.length,
        done: ms.filter(function (m) { return m.status === STATUS.DONE; }).length,
      };
    }),
    resultCount: matches.filter(function (m) { return m.status !== STATUS.NONE; }).length,
    leaguesComplete: leagueRows.length > 0 && matches.length > 0 && matches.every(function (m) { return m.status === STATUS.DONE; }),
    tour: (function () {
      const ms = readTMatches_();
      if (!ms.length) return null;
      const cnt = function (type) {
        const r1 = ms.filter(function (m) { return m.type === type && m.round === 1; });
        const real = ms.filter(function (m) { return m.type === type && m.status !== TSTATUS.BYE; });
        return {
          players: r1.reduce(function (n, m) { return n + (m.p1 ? 1 : 0) + (m.p2 ? 1 : 0); }, 0),
          total: real.length,
          done: real.filter(function (m) { return m.status === TSTATUS.DONE; }).length,
        };
      };
      return { upper: cnt(TTYPE.UPPER), lower: cnt(TTYPE.LOWER) };
    })(),
    unassigned: elig.filter(function (p) { return assigned[p.num] === undefined; }).map(pick_),
  });
}

function adminAddSamplePlayers(tid, pw, n) {
  useTournament_(tid);
  checkAdmin_(pw);
  addSamplePlayers_(Math.max(2, Math.min(100, Number(n) || 18)));
  return JSON.stringify({ ok: true });
}

function pick_(p) {
  return { name: p.name, team: p.team, num: p.num, row: p.row };
}

function adminSaveSettings(tid, pw, input) {
  useTournament_(tid);
  checkAdmin_(pw);
  const prev = getSettings_();
  const next = saveSettings_(input);
  const changed = SETTING_DEFS.filter(function (d) { return d.key !== 'rules' && d.key !== 'status' && String(prev[d.key]) !== String(next[d.key]); })
    .map(function (d) { return d.key === 'adminPassword' || d.key === 'entryCode' ? d.label + '（変更）' : d.label + ': ' + prev[d.key] + '→' + next[d.key]; });
  if (changed.length) writeLog_([{ kind: '管理', action: '設定を保存', after: changed.join(' / ') }], metaFrom_(arguments));
  if (next.title) updateTournament_(tid, { name: next.title });
  if (tourExists_()) reassignTables_(next); // 台の数が変わったら割り当てをやり直す
  clearCache_();
  return adminGetData(tid, isMaster_(pw) ? pw : next.adminPassword);
}

function adminAutoAssign(tid, pw) {
  useTournament_(tid);
  checkAdmin_(pw);
  const res = autoAssignNumbers_();
  return JSON.stringify({ assigned: res.assigned });
}

/** 画面の設定値を保存してからリーグ戦を作成する */
function adminCreateLeagues(tid, pw, input, force) {
  useTournament_(tid);
  checkAdmin_(pw);
  const s = input ? saveSettings_(input) : getSettings_();
  if (input && s.title) updateTournament_(tid, { name: s.title });
  const res = createLeagues_(s, !!force);
  if (res.ok) {
    writeLog_([{ kind: '管理', action: 'リーグ戦作成', after: res.summary.length + 'リーグ・' + res.summary.reduce(function (n, g) { return n + g.count; }, 0) + '名（' + res.summary.map(function (g) { return 'リーグ' + g.league + ':' + g.count + '名'; }).join(', ') + '）' }], metaFrom_(arguments));
  }
  return JSON.stringify(res);
}

function adminAddPlayer(tid, pw, num, leagueNo) {
  useTournament_(tid);
  checkAdmin_(pw);
  const res = addPlayerToLeague_(Number(num), Number(leagueNo));
  writeLog_([{ kind: '管理', action: '選手をリーグに追加', after: res.name + ' → リーグ' + res.league + '（' + res.added + '試合を追加）' }], metaFrom_(arguments));
  return JSON.stringify(res);
}

function adminAutoAssignLate(tid, pw) {
  useTournament_(tid);
  checkAdmin_(pw);
  const res = autoAssignLatePlayers_();
  return adminGetData(tid, pw, res.added.length ? res.added : [{ none: true }]);
}

/** 画面の設定値を保存してから、作成前の確認用にトーナメント表を作る（シートには書かない） */
function adminPreviewBrackets(tid, pw, input) {
  useTournament_(tid);
  checkAdmin_(pw);
  const s = input ? saveSettings_(input) : getSettings_();
  if (input && s.title) updateTournament_(tid, { name: s.title });
  if (input && tourExists_()) reassignTables_(s);
  clearCache_();
  return JSON.stringify(previewBrackets_(s));
}

/**
 * 上位・下位トーナメントを作成する。
 * planId: 確認画面（adminPreviewBrackets）の組み合わせをそのまま使う
 */
function adminCreateBrackets(tid, pw, input, force, planId) {
  useTournament_(tid);
  checkAdmin_(pw);
  const s = input ? saveSettings_(input) : getSettings_();
  if (input && s.title) updateTournament_(tid, { name: s.title });
  const res = createBrackets_(s, !!force, planId && typeof planId === 'string' ? planId : null);
  if (res.ok) {
    const u = res.summary.upper || {}, l = res.summary.lower || {};
    writeLog_([{ kind: '管理', action: 'トーナメント作成', after: '上位' + (u.count || 0) + '名・下位' + (l.count || 0) + '名・台' + res.tables + '台' }], metaFrom_(arguments));
  }
  return JSON.stringify(res);
}

/** 開催ステータスを変更する（開催前 / 開催中 / 終了） */
function adminSetStatus(tid, pw, status) {
  useTournament_(tid);
  checkAdmin_(pw);
  if (TOUR_STATUSES.indexOf(status) < 0) throw new Error('開催ステータスが正しくありません。');
  const prevStatus = getSettings_().status;
  saveSettings_({ status: status });
  writeLog_([{ kind: '管理', action: '公開ステータスを変更', before: prevStatus, after: status }], metaFrom_(arguments));
  updateTournament_(tid, { status: status });
  clearCache_();
  return adminGetData(tid, pw);
}

/** 大会情報（場所・住所・開始時間・当日の連絡先・メモ）を保存する */
function adminSaveInfo(tid, pw, info) {
  useTournament_(tid);
  checkAdmin_(pw);
  info = info || {};
  const keys = ['venue', 'address', 'startTime', 'contact', 'memo'];
  const prev = getSettings_();
  const input = {};
  keys.forEach(function (k) {
    const v = String(info[k] == null ? '' : info[k]);
    if (v.length > (k === 'memo' ? 5000 : 300)) throw new Error(labelOf_(k) + 'が長すぎます。');
    input[k] = v;
  });
  const next = saveSettings_(input);
  const changed = keys.filter(function (k) { return String(prev[k]) !== String(next[k]); })
    .map(function (k) { return labelOf_(k) + ': ' + (String(next[k]).replace(/\s+/g, ' ').slice(0, 40) || '（空欄）'); });
  if (changed.length) writeLog_([{ kind: '管理', action: '大会情報を保存', after: changed.join(' / ') }], metaFrom_(arguments));
  clearCache_();
  return adminGetData(tid, pw);
}

/** ルールの文章を保存する */
function adminSaveRules(tid, pw, text) {
  useTournament_(tid);
  checkAdmin_(pw);
  text = String(text == null ? '' : text);
  if (text.length > 40000) throw new Error('ルールの文章が長すぎます（40,000文字まで）。');
  saveSettings_({ rules: text });
  writeLog_([{ kind: '管理', action: 'ルールを保存', after: text.replace(/\s+/g, ' ').slice(0, 80) + (text.length > 80 ? '…' : '') }], metaFrom_(arguments));
  clearCache_();
  return adminGetData(tid, pw);
}

function adminExportStandings(tid, pw) {
  useTournament_(tid);
  checkAdmin_(pw);
  const snap = buildSnapshot_();
  putSnapshotCache_(snap);
  writeStandingsSheet_(snap);
  return JSON.stringify({ ok: true });
}

function adminClearCache(tid, pw) {
  useTournament_(tid);
  checkAdmin_(pw);
  clearCache_();
  return JSON.stringify({ ok: true });
}

/* ------------------------------------------------------------------ */

function newMatchRow_(league, no, a, b, bestOf) {
  const row = new Array(MATCH_HEADERS.length).fill('');
  row[MCOL.ID] = 'L' + league + '-' + (no < 10 ? '0' + no : no);
  row[MCOL.LEAGUE] = league;
  row[MCOL.NO] = no;
  row[MCOL.P1] = a.num;
  row[MCOL.N1] = a.name;
  row[MCOL.P2] = b.num;
  row[MCOL.N2] = b.name;
  row[MCOL.STATUS] = STATUS.NONE;
  row[MCOL.BEST_OF] = bestOf;
  row[MCOL.VER] = 0;
  return row;
}

/**
 * リーグ戦を作成する。
 * 参加確認・支払確認済みでくじ番号のある選手を、ランダムに leagueCount 個のリーグへ振り分ける。
 */
function createLeagues_(settings, force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('他の処理が実行中です。少し待ってから再度実行してください。');
  try {
    validateSettings_(settings);
    const L = settings.leagueCount;
    assignMissingNumbersCore_(); // 参加・支払済みでくじ番号が空欄の選手にも番号を付けて対象に含める
    const players = readPlayers_();
    const dup = duplicateNumbers_(players);
    if (dup.length) {
      throw new Error('くじ番号が重複しています: ' + dup.map(function (d) { return d.num + '番（' + d.names.join('、') + '）'; }).join(' / '));
    }
    const elig = eligiblePlayers_(players);
    if (elig.length < L * 2) {
      throw new Error('対象選手が ' + elig.length + ' 名です。' + L + ' リーグを作るには最低 ' + L * 2 + ' 名（各リーグ2名以上）必要です。');
    }

    const existing = valuesToMatches_(readMatchValues_());
    const resultCount = existing.filter(function (m) { return m.status !== STATUS.NONE; }).length;
    if (resultCount > 0 && !force) {
      return { needConfirm: true, resultCount: resultCount };
    }

    const groups = distributeToLeagues_(elig, L);
    const leagueValues = [];
    const matchValues = [];
    const summary = [];
    groups.forEach(function (g, gi) {
      const no = gi + 1;
      g.forEach(function (p) { leagueValues.push([no, p.num, p.name, p.team]); });
      const byNum = {};
      g.forEach(function (p) { byNum[p.num] = p; });
      const pairs = roundRobinPairs_(g.map(function (p) { return p.num; }));
      pairs.forEach(function (pr, i) {
        matchValues.push(newMatchRow_(no, i + 1, byNum[pr[0]], byNum[pr[1]], settings.leagueSets));
      });
      summary.push({ league: no, count: g.length, matches: pairs.length, players: g.map(function (p) { return p.num + ' ' + p.name + (p.team ? '（' + p.team + '）' : ''); }) });
    });

    // リーグシート
    const lsh = sheet_(SHEET.LEAGUES);
    if (lsh.getLastRow() > 1) lsh.getRange(2, 1, lsh.getLastRow() - 1, LEAGUE_HEADERS.length).clearContent();
    lsh.getRange(2, 1, leagueValues.length, LEAGUE_HEADERS.length).setValues(leagueValues);

    // 試合シート
    const msh = sheet_(SHEET.MATCHES);
    if (msh.getLastRow() > 1) msh.getRange(2, 1, msh.getLastRow() - 1, MATCH_HEADERS.length).clearContent();
    if (msh.getMaxRows() < matchValues.length + 1) msh.insertRowsAfter(msh.getMaxRows(), matchValues.length + 1 - msh.getMaxRows());
    msh.getRange(2, MCOL.SET0 + 1, matchValues.length, MAX_SETS).setNumberFormat('@');
    msh.getRange(2, 1, matchValues.length, MATCH_HEADERS.length).setValues(matchValues);

    // 参加者シートのリーグ列
    writePlayerLeagueColumn_(leagueValues);

    const snap = buildSnapshot_({ settings: settings });
    putSnapshotCache_(snap);
    writeStandingsSheet_(snap);
    SpreadsheetApp.flush();
    return { ok: true, summary: summary };
  } finally {
    lock.releaseLock();
  }
}

function writePlayerLeagueColumn_(leagueValues) {
  const sh = sheet_(SHEET.PLAYERS);
  const c = playerColumns_(sh);
  if (c.league < 0) return;
  const last = sh.getLastRow();
  if (last < 2) return;
  const byNum = {};
  leagueValues.forEach(function (r) { byNum[r[1]] = r[0]; });
  const players = readPlayers_();
  const col = sh.getRange(2, c.league + 1, last - 1, 1).getValues();
  for (let i = 0; i < col.length; i++) col[i][0] = '';
  players.forEach(function (p) {
    if (p.attend && p.paid && p.num != null && byNum[p.num] !== undefined) col[p.row - 2][0] = byNum[p.num];
  });
  sh.getRange(2, c.league + 1, last - 1, 1).setValues(col);
}

/**
 * 選手1名をリーグに追加し、そのリーグの全選手との試合を作る（ロック・キャッシュ更新は呼び出し側）。
 * 戻り値: 追加した試合数
 */
function addPlayerCore_(p, leagueNo, settings) {
  const leagueRows = readLeagueRows_();
  if (leagueRows.some(function (r) { return r.num === p.num; })) throw new Error(p.name + ' さんは既にリーグに入っています。');
  const members = leagueRows.filter(function (r) { return r.league === leagueNo; });
  if (!members.length) throw new Error('リーグ ' + leagueNo + ' が見つかりません。');

  const matches = valuesToMatches_(readMatchValues_()).filter(function (m) { return m.league === leagueNo; });
  const bestOf = matches.length ? matches[0].bestOf : settings.leagueSets;
  let no = matches.reduce(function (mx, m) { return Math.max(mx, m.no || 0); }, 0);

  sheet_(SHEET.LEAGUES).appendRow([leagueNo, p.num, p.name, p.team]);

  const rows = members.map(function (m) {
    no++;
    const a = { num: m.num, name: m.name };
    const b = { num: p.num, name: p.name };
    return m.num < p.num ? newMatchRow_(leagueNo, no, a, b, bestOf) : newMatchRow_(leagueNo, no, b, a, bestOf);
  });
  const msh = sheet_(SHEET.MATCHES);
  const start = msh.getLastRow() + 1;
  msh.getRange(start, MCOL.SET0 + 1, rows.length, MAX_SETS).setNumberFormat('@');
  msh.getRange(start, 1, rows.length, MATCH_HEADERS.length).setValues(rows);
  return rows.length;
}

function refreshAfterLeagueChange_(settings) {
  writePlayerLeagueColumn_(readLeagueRows_().map(function (r) { return [r.league, r.num]; }));
  const snap = buildSnapshot_({ settings: settings });
  putSnapshotCache_(snap);
  writeStandingsSheet_(snap);
  SpreadsheetApp.flush();
  return snap;
}

/** 当日参加などで、作成済みのリーグに選手を追加する（管理者が追加先を選ぶ場合） */
function addPlayerToLeague_(num, leagueNo) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('他の処理が実行中です。少し待ってから再度実行してください。');
  try {
    const settings = getSettings_();
    const p = eligiblePlayers_(readPlayers_()).filter(function (x) { return x.num === num; })[0];
    if (!p) throw new Error('くじ番号 ' + num + ' の参加・支払済み選手が見つかりません。');
    const added = addPlayerCore_(p, leagueNo, settings);
    refreshAfterLeagueChange_(settings);
    return { ok: true, name: p.name, team: p.team, league: leagueNo, added: added };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* 遅れて来た選手の自動追加                                              */
/* ------------------------------------------------------------------ */

/**
 * リーグ作成後に「参加確認・支払確認」が付いたのに、まだリーグに入っていない選手。
 * くじ番号が空欄の選手も含む（自動で番号を付ける）。
 */
function lateCandidates_(players, leagueRows) {
  if (!leagueRows.length) return [];
  const assigned = {};
  leagueRows.forEach(function (r) { assigned[r.num] = true; });
  return players.filter(function (p) {
    if (!p.attend || !p.paid) return false;
    if (p.num == null) return String(p.rawNum == null ? '' : p.rawNum).trim() === '';
    return !assigned[p.num];
  });
}

/**
 * 遅れて来た選手を、人数の少ないリーグへ自動で追加する。
 * （人数が同じリーグが複数あるときはその中からランダム）
 * 戻り値: { added: [{ name, num, league, matches }], snap }
 */
function autoAssignLatePlayers_() {
  const settings = getSettings_();
  if (!settings.autoAssignLate) return { added: [] };
  if (tourExists_()) return { added: [] }; // トーナメント作成後はリーグを変更しない
  if (!lateCandidates_(readPlayers_(), readLeagueRows_()).length) return { added: [] };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { added: [] }; // 次の機会に再実行される
  try {
    // ロック取得後に読み直す（同時に別の処理が追加済みかもしれないため）
    assignMissingNumbersCore_();
    const players = readPlayers_();
    let leagueRows = readLeagueRows_();
    const dupNums = {};
    duplicateNumbers_(players).forEach(function (d) { dupNums[d.num] = true; });
    const cands = lateCandidates_(players, leagueRows).filter(function (p) { return p.num != null && !dupNums[p.num]; });
    if (!cands.length) return { added: [] };

    const added = [];
    cands.forEach(function (p) {
      const counts = {};
      leagueRows.forEach(function (r) { counts[r.league] = (counts[r.league] || 0) + 1; });
      const nos = Object.keys(counts).map(Number);
      const min = Math.min.apply(null, nos.map(function (n) { return counts[n]; }));
      const choices = nos.filter(function (n) { return counts[n] === min; });
      const leagueNo = choices[Math.floor(Math.random() * choices.length)];
      const n = addPlayerCore_(p, leagueNo, settings);
      added.push({ name: p.name, team: p.team, num: p.num, league: leagueNo, matches: n, row: p.row });
      leagueRows = readLeagueRows_();
    });

    writeAutoAddNotes_(added);
    const snap = refreshAfterLeagueChange_(settings);
    return { added: added, snap: snap };
  } finally {
    lock.releaseLock();
  }
}

/** 参加者シートの「備考」に自動追加したことを書いておく */
function writeAutoAddNotes_(added) {
  if (!added.length) return;
  const sh = sheet_(SHEET.PLAYERS);
  const c = playerColumns_(sh);
  if (c.note < 0) return;
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm');
  added.forEach(function (a) {
    const cell = sh.getRange(a.row, c.note + 1);
    const cur = String(cell.getValue() || '');
    cell.setValue((cur ? cur + ' / ' : '') + '自動追加: リーグ' + a.league + '（' + stamp + '）');
  });
}
