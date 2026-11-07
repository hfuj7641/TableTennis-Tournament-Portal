/**
 * 表示用データ（スナップショット）の生成とキャッシュ
 *
 * 100名程度が同時に閲覧しても速く動くよう、閲覧系のリクエストは
 * スプレッドシートを読まずに CacheService から JSON をそのまま返す。
 * 試合結果の保存時には、ロック中にスナップショットを作り直してキャッシュを更新する。
 */

const CACHE_KEY_BOOT = 'boot_v2';
const CACHE_KEY_LEAGUE = 'league_v2_';

/** 大会ごとにキャッシュのキーを分ける */
function ck_(key) {
  return (CTX.tid || 'bound') + ':' + key;
}
const MAX_LEAGUES_CACHE = 100;
const CACHE_KEY_TOUR = 'tour_v1';

function buildSnapshot_(opt) {
  opt = opt || {};
  const settings = opt.settings || getSettings_();
  const players = opt.players || readPlayers_();
  const leagueRows = opt.leagueRows || readLeagueRows_();
  const matches = opt.matches || valuesToMatches_(readMatchValues_());
  const tmatches = opt.tmatches || readTMatches_();

  const byNum = {};
  players.forEach(function (p) {
    if (p.num != null && !byNum[p.num]) byNum[p.num] = p;
  });
  const nameOf = function (num, fallback) { return byNum[num] ? byNum[num].name : fallback || '#' + num; };
  const teamOf = function (num, fallback) { return byNum[num] ? byNum[num].team : fallback || ''; };

  const leagues = {};
  leagueRows.forEach(function (r) {
    if (!leagues[r.league]) leagues[r.league] = { no: r.league, players: [], matches: [] };
    leagues[r.league].players.push({ num: r.num, name: nameOf(r.num, r.name), team: teamOf(r.num, r.team) });
  });
  matches.forEach(function (m) {
    if (!leagues[m.league]) return;
    m.n1 = nameOf(m.p1, m.n1);
    m.n2 = nameOf(m.p2, m.n2);
    leagues[m.league].matches.push(m);
  });

  const leagueList = Object.keys(leagues).map(Number).sort(function (a, b) { return a - b; });
  const bootLeagues = [];
  const bootPlayers = [];
  leagueList.forEach(function (no) {
    const L = leagues[no];
    L.players.sort(function (a, b) { return a.num - b.num; });
    L.matches.sort(function (a, b) { return a.no - b.no; });
    L.bestOf = L.matches.length ? L.matches[0].bestOf : settings.leagueSets;
    L.need = setsToWin_(L.bestOf);
    L.advanceCount = settings.advanceCount;
    L.total = L.matches.length;
    L.done = L.matches.filter(function (m) { return m.status === STATUS.DONE; }).length;
    L.inProgress = L.matches.filter(function (m) { return m.status === STATUS.PROGRESS; }).length;
    L.complete = L.total > 0 && L.done === L.total;
    L.standings = computeStandings_(L.players, L.matches, settings.advanceCount);
    bootLeagues.push({ no: no, count: L.players.length, total: L.total, done: L.done, inProgress: L.inProgress, complete: L.complete });
    L.players.forEach(function (p) {
      bootPlayers.push({ num: p.num, name: p.name, team: p.team, league: no });
    });
  });
  bootPlayers.sort(function (a, b) { return a.num - b.num; });

  const tour = buildTourData_(tmatches, settings, byNum);
  const tourOf = {};
  if (tour.exists) {
    tmatches.forEach(function (m) {
      if (m.round !== 1) return;
      if (m.p1) tourOf[m.p1] = m.type;
      if (m.p2) tourOf[m.p2] = m.type;
    });
    bootPlayers.forEach(function (p) { p.tour = tourOf[p.num] || ''; });
  }
  const tourSummary = function (b) {
    return b ? { players: b.players, total: b.total, done: b.done, champion: b.champion, bestOf: b.bestOf } : null;
  };

  return {
    leagueList: leagueList,
    leagues: leagues,
    tour: tour,
    boot: {
      hasTournament: !!tour.exists,
      tour: tour.exists ? { upper: tourSummary(tour.upper), lower: tourSummary(tour.lower), tables: tour.tables } : null,
      title: settings.title,
      leagueSets: settings.leagueSets,
      advanceCount: settings.advanceCount,
      requiresEntryCode: !!settings.entryCode,
      leagues: bootLeagues,
      players: bootPlayers,
      generatedAt: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm:ss'),
    },
  };
}

function putSnapshotCache_(snap) {
  const cache = CacheService.getScriptCache();
  const items = {};
  items[ck_(CACHE_KEY_BOOT)] = JSON.stringify(snap.boot);
  items[ck_(CACHE_KEY_TOUR)] = JSON.stringify(snap.tour);
  snap.leagueList.forEach(function (no) {
    items[ck_(CACHE_KEY_LEAGUE + no)] = JSON.stringify(snap.leagues[no]);
  });
  try {
    cache.putAll(items, CACHE_TTL);
  } catch (err) {
    // 1件あたり100KBを超えた等。キャッシュ無しでも動作はする。
    console.warn('cache putAll failed: ' + err);
  }
}

function clearCache_() {
  const keys = [ck_(CACHE_KEY_BOOT), ck_(CACHE_KEY_TOUR)];
  for (let i = 1; i <= MAX_LEAGUES_CACHE; i++) keys.push(ck_(CACHE_KEY_LEAGUE + i));
  CacheService.getScriptCache().removeAll(keys);
}

/** boot データ（JSON 文字列） */
/**
 * キャッシュが無いときにスナップショットを作り直す。
 * ついでに、遅れて来た選手（リーグ作成後に参加・支払済みになった選手）がいればリーグに自動追加する。
 * （編集トリガーが動かなかった場合の保険。普段の読み込みでは追加の読み取りは発生しない）
 */
function buildFreshSnapshot_() {
  const settings = getSettings_();
  const players = readPlayers_();
  const leagueRows = readLeagueRows_();
  const tmatches = readTMatches_();
  if (!tmatches.length && settings.autoAssignLate && lateCandidates_(players, leagueRows).length) {
    try {
      const res = autoAssignLatePlayers_();
      if (res.snap) return res.snap;
    } catch (err) {
      console.warn('auto assign failed: ' + err);
    }
  }
  return buildSnapshot_({ settings: settings, players: players, leagueRows: leagueRows, tmatches: tmatches });
}

function getBootJson_() {
  const cached = CacheService.getScriptCache().get(ck_(CACHE_KEY_BOOT));
  if (cached) return cached;
  const snap = buildFreshSnapshot_();
  putSnapshotCache_(snap);
  return JSON.stringify(snap.boot);
}

/** トーナメントのデータ（JSON 文字列） */
function getTourJson_() {
  const cached = CacheService.getScriptCache().get(ck_(CACHE_KEY_TOUR));
  if (cached) return cached;
  const snap = buildFreshSnapshot_();
  putSnapshotCache_(snap);
  return JSON.stringify(snap.tour);
}

/** リーグのデータ（JSON 文字列） */
function getLeagueJson_(no) {
  no = Number(no);
  const cached = CacheService.getScriptCache().get(ck_(CACHE_KEY_LEAGUE + no));
  if (cached) return cached;
  const snap = buildFreshSnapshot_();
  putSnapshotCache_(snap);
  if (!snap.leagues[no]) throw new Error('リーグ ' + no + ' は存在しません。');
  return JSON.stringify(snap.leagues[no]);
}
