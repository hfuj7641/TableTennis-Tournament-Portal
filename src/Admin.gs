/**
 * 管理者向けの機能（設定・くじ番号・リーグ戦作成・当日追加）
 */

function checkAdmin_(pw) {
  const s = getSettings_();
  if (!s.adminPassword) throw new Error('「設定」シートで管理者パスワードを設定してください。');
  if (String(pw || '') !== s.adminPassword) throw new Error('管理者パスワードが違います。');
  return s;
}

function adminLogin(pw) {
  checkAdmin_(pw);
  return adminGetData(pw);
}

function adminGetData(pw) {
  const settings = checkAdmin_(pw);
  const players = readPlayers_();
  const leagueRows = readLeagueRows_();
  const matches = valuesToMatches_(readMatchValues_());
  const assigned = {};
  leagueRows.forEach(function (r) { assigned[r.num] = r.league; });

  const elig = eligiblePlayers_(players);
  const leagueNos = {};
  leagueRows.forEach(function (r) { leagueNos[r.league] = (leagueNos[r.league] || 0) + 1; });

  return JSON.stringify({
    settings: settings,
    stats: {
      total: players.length,
      attend: players.filter(function (p) { return p.attend; }).length,
      paid: players.filter(function (p) { return p.paid; }).length,
      attendPaid: players.filter(function (p) { return p.attend && p.paid; }).length,
      eligible: elig.length,
    },
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
    unassigned: elig.filter(function (p) { return assigned[p.num] === undefined; }).map(pick_),
  });
}

function pick_(p) {
  return { name: p.name, team: p.team, num: p.num, row: p.row };
}

function adminSaveSettings(pw, input) {
  checkAdmin_(pw);
  saveSettings_(input);
  clearCache_();
  return adminGetData(input && input.adminPassword ? input.adminPassword : pw);
}

function adminAutoAssign(pw) {
  checkAdmin_(pw);
  const res = autoAssignNumbers_();
  return JSON.stringify({ assigned: res.assigned });
}

/** 画面の設定値を保存してからリーグ戦を作成する */
function adminCreateLeagues(pw, input, force) {
  checkAdmin_(pw);
  const s = input ? saveSettings_(input) : getSettings_();
  const res = createLeagues_(s, !!force);
  return JSON.stringify(res);
}

function adminAddPlayer(pw, num, leagueNo) {
  checkAdmin_(pw);
  return JSON.stringify(addPlayerToLeague_(Number(num), Number(leagueNo)));
}

function adminExportStandings(pw) {
  checkAdmin_(pw);
  const snap = buildSnapshot_();
  putSnapshotCache_(snap);
  writeStandingsSheet_(snap);
  return JSON.stringify({ ok: true });
}

function adminClearCache(pw) {
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
      summary.push({ league: no, count: g.length, matches: pairs.length, players: g.map(function (p) { return p.num + ' ' + p.name; }) });
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

/** 当日参加などで、作成済みのリーグに選手を追加する（既存選手との試合を追加） */
function addPlayerToLeague_(num, leagueNo) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('他の処理が実行中です。少し待ってから再度実行してください。');
  try {
    const settings = getSettings_();
    const players = readPlayers_();
    const p = eligiblePlayers_(players).filter(function (x) { return x.num === num; })[0];
    if (!p) throw new Error('くじ番号 ' + num + ' の参加・支払済み選手が見つかりません。');
    const leagueRows = readLeagueRows_();
    if (leagueRows.some(function (r) { return r.num === num; })) throw new Error(p.name + ' さんは既にリーグに入っています。');
    const members = leagueRows.filter(function (r) { return r.league === leagueNo; });
    if (!members.length) throw new Error('リーグ ' + leagueNo + ' が見つかりません。');

    const matches = valuesToMatches_(readMatchValues_()).filter(function (m) { return m.league === leagueNo; });
    const bestOf = matches.length ? matches[0].bestOf : settings.leagueSets;
    let no = matches.reduce(function (mx, m) { return Math.max(mx, m.no || 0); }, 0);

    const lsh = sheet_(SHEET.LEAGUES);
    lsh.appendRow([leagueNo, p.num, p.name, p.team]);

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

    writePlayerLeagueColumn_(readLeagueRows_().map(function (r) { return [r.league, r.num]; }));

    const snap = buildSnapshot_({ settings: settings });
    putSnapshotCache_(snap);
    writeStandingsSheet_(snap);
    SpreadsheetApp.flush();
    return { ok: true, name: p.name, league: leagueNo, added: rows.length };
  } finally {
    lock.releaseLock();
  }
}
