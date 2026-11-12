/**
 * Web画面（google.script.run）から呼ばれる関数
 * 戻り値はすべて JSON 文字列（キャッシュをそのまま返せるため）。
 */

/**
 * 大会の基本データ。開催前は試合の情報を返さない（参加者リストとルールのみ公開）。
 */
function apiGetBoot(tid) {
  useTournament_(tid);
  const json = getBootJson_();
  const b = JSON.parse(json);
  if (b.status !== '開催前') return json;
  return JSON.stringify({ title: b.title, status: b.status, rules: b.rules, info: b.info, leagues: [], players: [], hasTournament: false, requiresEntryCode: b.requiresEntryCode });
}

/** 開催前は試合の情報を見せない */
function requireOpened_() {
  const b = JSON.parse(getBootJson_());
  if (b.status === '開催前') throw new Error('大会はまだ開催前です。試合の情報は開催後に公開されます。');
  return b;
}

function apiGetLeague(tid, no) {
  useTournament_(tid);
  requireOpened_();
  return getLeagueJson_(no);
}

/** 参加者リスト（「参加者」シートの名前と所属。開催前から公開） */
function apiGetParticipants(tid) {
  useTournament_(tid);
  const key = ck_('participants_v1');
  const cache = CacheService.getScriptCache();
  const cached = cacheGet_(key);
  if (cached) return cached;
  const list = readPlayers_().map(function (p) { return { name: p.name, team: p.team, withdrawn: !!p.withdrawn }; });
  const json = JSON.stringify({ players: list, generatedAt: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm:ss') });
  try { cache.put(key, cacheWrap_(json), CACHE_TTL); } catch (err) { /* 大きすぎる場合はキャッシュしない */ }
  return json;
}

function apiVerifyEntryCode(tid, code) {
  useTournament_(tid);
  const s = getSettings_();
  return JSON.stringify({ ok: !s.entryCode || String(code || '').trim() === s.entryCode });
}

function checkEntryCode_(code) {
  const s = getSettings_();
  if (s.status !== '開催中') {
    throw new Error(s.status === '開催前' ? '大会はまだ開催前のため、結果は入力できません。' : '大会は終了したため、結果は入力できません。');
  }
  if (s.entryCode && String(code || '').trim() !== s.entryCode) {
    throw new Error('選手入力パスコードが正しくありません。トップ画面から入り直してください。');
  }
  return s;
}

/**
 * 試合結果を保存する。
 * tid = 大会ID
 * p = { matchId, ver, sets: [[a,b],...], progress, force, reset, code }（獲得セット数は sets から計算）
 *   progress: 'before'（試合前）| 'playing'（試合中）| 'done'（試合終了）
 *   ver   : 画面を開いた時点の版。他の人が先に更新していたら conflict を返す。
 *   force : true なら版が違っても上書き。
 *   reset : true なら結果を消して「未実施」に戻す。
 */
function apiSaveMatch(tid, p) {
  useTournament_(tid);
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
    // 獲得セット数は各セットの得点から自動計算する
    const d = decideResult_(p, cur.bestOf);
    if (d.status !== 'none') {
      sets = d.sets;
      c1 = d.a;
      c2 = d.b;
      status = d.status === 'done' ? STATUS.DONE : STATUS.PROGRESS;
      winner = d.winner === 1 ? cur.p1 : d.winner === 2 ? cur.p2 : '';
    }

    const setCells = [];
    for (let k = 0; k < MAX_SETS; k++) setCells.push(sets[k] ? formatSetCell_(sets[k]) : '');
    const now = new Date();
    const tail = [status, cur.bestOf, c1, c2, winner].concat(setCells, [now, cur.ver + 1]);

    const rowNo = idx + 2;
    sh.getRange(rowNo, MCOL.SET0 + 1, 1, MAX_SETS).setNumberFormat('@');
    sh.getRange(rowNo, MCOL.STATUS + 1, 1, tail.length).setValues([tail]);

    for (let k = 0; k < tail.length; k++) values[idx][MCOL.STATUS + k] = tail[k];

    writeLog_([{
      kind: 'リーグ戦', id: cur.id,
      label: 'リーグ' + cur.league + ' 第' + cur.no + '試合 ' + cur.n1 + ' vs ' + cur.n2,
      action: actionName_(cur.status, status, p.force),
      before: matchSummary_(cur.status, cur.c1, cur.c2, cur.sets),
      after: matchSummary_(status, c1, c2, sets),
    }], p.meta);

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

/**
 * 進捗（試合前 / 試合中 / 試合終了）と各セットの得点を確認して、保存する状態を決める。
 * p.progress: 'before' | 'playing' | 'done'（無い場合は得点から自動判定）
 * 戻り値: { status: 'none'|'progress'|'done', sets, a, b, winner(0|1|2) }
 */
function decideResult_(p, bestOf) {
  const sets = p.reset ? [] : sanitizeSets_(p.sets);
  const ev = evaluateSets_(sets, bestOf);
  if (ev.errors.length) throw new Error(ev.errors.join('\n'));
  const need = setsToWin_(bestOf);
  if (p.reset || p.progress === 'before') {
    if (sets.length) throw new Error('「試合前」を選んでいますが、得点が入力されています。試合前に戻す場合は得点を消してください。');
    return { status: 'none', sets: [], a: 0, b: 0, winner: 0 };
  }
  if (p.progress === 'playing') {
    if (ev.winner) throw new Error('勝敗が決まっています（' + ev.a + '-' + ev.b + '）。「試合終了」を選んでください。');
    return { status: 'progress', sets: sets, a: ev.a, b: ev.b, winner: 0 };
  }
  if (p.progress === 'done') {
    if (!sets.length) throw new Error('得点が入力されていません。「試合終了」にするには、全セットの得点を入力してください。');
    if (!ev.winner) throw new Error('まだ勝敗が決まっていません（現在 ' + ev.a + '-' + ev.b + '、' + need + 'セット先取）。全セットの得点を入力するか、「試合中」を選んでください。');
    return { status: 'done', sets: sets, a: ev.a, b: ev.b, winner: ev.winner };
  }
  // 旧画面からの保存（進捗の指定なし）
  if (!sets.length) throw new Error('各セットの得点が入力されていません。');
  return { status: ev.winner ? 'done' : 'progress', sets: sets, a: ev.a, b: ev.b, winner: ev.winner };
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
