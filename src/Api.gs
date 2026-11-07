/**
 * Web画面（google.script.run）から呼ばれる関数
 * 戻り値はすべて JSON 文字列（キャッシュをそのまま返せるため）。
 */

function apiGetBoot() {
  return getBootJson_();
}

function apiGetLeague(no) {
  return getLeagueJson_(no);
}

function apiVerifyEntryCode(code) {
  const s = getSettings_();
  return JSON.stringify({ ok: !s.entryCode || String(code || '').trim() === s.entryCode });
}

function checkEntryCode_(code) {
  const s = getSettings_();
  if (s.entryCode && String(code || '').trim() !== s.entryCode) {
    throw new Error('選手入力パスコードが正しくありません。トップ画面から入り直してください。');
  }
  return s;
}

/**
 * 試合結果を保存する。
 * p = { matchId, ver, sets: [[a,b],...], c1, c2, force, reset, code }
 *   ver   : 画面を開いた時点の版。他の人が先に更新していたら conflict を返す。
 *   force : true なら版が違っても上書き。
 *   reset : true なら結果を消して「未実施」に戻す。
 */
function apiSaveMatch(p) {
  p = p || {};
  const settings = checkEntryCode_(p.code);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    throw new Error('ただいま混み合っています。少し待ってからもう一度「保存」を押してください。');
  }
  try {
    const sh = sheet_(SHEET.MATCHES);
    const values = readMatchValues_();
    let idx = -1;
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][MCOL.ID]) === String(p.matchId)) {
        idx = i;
        break;
      }
    }
    if (idx < 0) throw new Error('試合が見つかりません。リーグが作り直された可能性があります。画面を更新してください。');

    const cur = rowToMatch_(values[idx]);
    if (!p.force && Number(p.ver) !== cur.ver) {
      return JSON.stringify({ conflict: true, current: cur });
    }

    let status = STATUS.NONE;
    let c1 = '';
    let c2 = '';
    let winner = '';
    let sets = [];
    if (!p.reset) {
      sets = sanitizeSets_(p.sets);
      if (!sets.length) throw new Error('各セットの得点が入力されていません。');
      const ev = evaluateSets_(sets, cur.bestOf);
      if (ev.errors.length) throw new Error(ev.errors.join('\n'));
      if (ev.a !== Number(p.c1) || ev.b !== Number(p.c2)) {
        throw new Error('獲得セット数（' + p.c1 + '-' + p.c2 + '）と各セットの結果（' + ev.a + '-' + ev.b + '）が一致しません。');
      }
      c1 = ev.a;
      c2 = ev.b;
      status = ev.winner ? STATUS.DONE : STATUS.PROGRESS;
      winner = ev.winner === 1 ? cur.p1 : ev.winner === 2 ? cur.p2 : '';
    }

    const setCells = [];
    for (let k = 0; k < MAX_SETS; k++) setCells.push(sets[k] ? formatSetCell_(sets[k]) : '');
    const now = new Date();
    const tail = [status, cur.bestOf, c1, c2, winner].concat(setCells, [now, cur.ver + 1]);

    const rowNo = idx + 2;
    sh.getRange(rowNo, MCOL.SET0 + 1, 1, MAX_SETS).setNumberFormat('@');
    sh.getRange(rowNo, MCOL.STATUS + 1, 1, tail.length).setValues([tail]);

    for (let k = 0; k < tail.length; k++) values[idx][MCOL.STATUS + k] = tail[k];

    const snap = buildSnapshot_({ settings: settings, matches: valuesToMatches_(values) });
    putSnapshotCache_(snap);
    writeStandingsSheet_(snap);
    SpreadsheetApp.flush();

    const L = snap.leagues[cur.league];
    return JSON.stringify({ ok: true, league: L || null });
  } finally {
    lock.releaseLock();
  }
}

function sanitizeSets_(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length && i < MAX_SETS; i++) {
    const s = raw[i];
    if (!Array.isArray(s) || s.length !== 2) break;
    const a = parseInt(s[0], 10);
    const b = parseInt(s[1], 10);
    if (isNaN(a) || isNaN(b)) break;
    out.push([a, b]);
  }
  return out;
}
