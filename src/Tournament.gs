/**
 * 上位・下位トーナメント
 *
 * - リーグ戦の結果から、上位（各リーグ上位 advanceCount 名）・下位（それ以外）のトーナメントを作る
 * - シード順: リーグ内順位 → 勝率 → セット率 → 獲得セット数（完全に同じならランダム）
 * - シード順に標準的な位置へ配置（上位シードほど不戦勝になる）。1回戦で同じリーグの選手が当たる場合は入れ替える
 * - 台の数を設定し、対戦相手が決まった試合に空いている台を自動で割り当てる（上位・下位の残り試合数に比例して配分）
 * - 結果を保存すると勝者が次の試合へ進み、空いた台に次の試合が入る
 * - 3位決定戦（準決勝の敗者どうし）。決勝と同じ回戦の pos=1 として持つ
 * - 決勝は台を割り当てない（大会スタッフが個別に案内する）
 * - 棄権（参加者シートの「棄権」にチェック）した選手の試合は不戦敗にして、相手を勝ち上がらせる
 */

const TSTATUS = {
  WAIT: '待機',     // 対戦相手が未決定
  NONE: '未実施',   // 対戦相手決定（台があれば「台Nで試合」、なければ「台の空き待ち」）
  PROGRESS: '試合中',
  DONE: '終了',
  BYE: '不戦勝',
};

const TTYPE = { UPPER: '上位', LOWER: '下位' };

const TCOL = {
  ID: 0, TYPE: 1, ROUND: 2, POS: 3,
  P1: 4, N1: 5, S1: 6, P2: 7, N2: 8, S2: 9,
  STATUS: 10, BEST_OF: 11, C1: 12, C2: 13, WINNER: 14,
  SET0: 15, // 15..21
  TABLE: 22, UPDATED: 23, VER: 24, SEQ: 25, WO: 26,
};
const TOUR_HEADERS = [
  '試合ID', '種別', '回戦', '位置', '選手1番号', '選手1名前', '選手1シード', '選手2番号', '選手2名前', '選手2シード',
  '状態', 'セット数', '選手1獲得セット', '選手2獲得セット', '勝者番号',
  '第1セット', '第2セット', '第3セット', '第4セット', '第5セット', '第6セット', '第7セット',
  '台', '更新日時', '版', '呼出順', '不戦敗（棄権）',
];

/* ------------------------------------------------------------------ */
/* 純粋ロジック                                                        */
/* ------------------------------------------------------------------ */

/** 標準的なシード配置（B=8 → [1,8,4,5,2,7,3,6]）。隣同士が1回戦の対戦 */
function seedOrder_(B) {
  let o = [1];
  while (o.length < B) {
    const n = o.length * 2;
    const next = [];
    o.forEach(function (s) { next.push(s); next.push(n + 1 - s); });
    o = next;
  }
  return o;
}

function bracketSize_(n) {
  let b = 1;
  while (b < n) b *= 2;
  return b;
}

function roundName_(R, r, pos) {
  if (r === R && pos === 1 && R >= 2) return '3位決定戦';
  const left = R - r;
  if (left === 0) return '決勝';
  if (left === 1) return '準決勝';
  if (left === 2) return '準々決勝';
  return r + '回戦';
}

/**
 * シード順に並べる。
 * entries: [{ num, name, team, league, rank, wins, played, setsWon, setsLost, ratioInf }]
 */
function seedPlayers_(entries) {
  const list = shuffle_(entries); // 完全に同じ成績のときはランダム
  list.sort(function (x, y) {
    return (x.rank - y.rank) || recordCompare_(x, y);
  });
  list.forEach(function (e, i) { e.seed = i + 1; });
  return list;
}

/** シード順の選手を山に配置する。戻り値: 長さ B の配列（null は不戦勝枠） */
function placeSlots_(seeded, B) {
  const order = seedOrder_(B);
  const slots = order.map(function (s) { return seeded[s - 1] || null; });
  // 1回戦で同じリーグの選手が当たらないよう、同じリーグ内順位の選手と入れ替える
  const conflict = function (i) {
    const a = slots[i - (i % 2)], b = slots[i - (i % 2) + 1];
    return !!(a && b && a.league === b.league);
  };
  for (let pass = 0; pass < 3; pass++) {
    for (let k = 0; k < B; k += 2) {
      if (!conflict(k)) continue;
      const i = slots[k].seed > slots[k + 1].seed ? k : k + 1; // 下位シード側を動かす
      for (let j = 0; j < B; j++) {
        if (j === k || j === k + 1 || !slots[j] || slots[j].rank !== slots[i].rank) continue;
        const t = slots[i]; slots[i] = slots[j]; slots[j] = t;
        if (!conflict(k) && !conflict(j)) break;
        slots[j] = slots[i]; slots[i] = t; // 戻す
      }
    }
  }
  return slots;
}

function tMatchId_(code, round, pos) {
  return code + '-' + round + '-' + (pos + 1 < 10 ? '0' : '') + (pos + 1);
}

function newTMatch_(type, round, pos, bestOf, id) {
  const code = type === TTYPE.UPPER ? 'U' : 'L';
  return {
    id: id || tMatchId_(code, round, pos), type: type, round: round, pos: pos,
    p1: null, n1: '', s1: '', p2: null, n2: '', s2: '',
    status: TSTATUS.WAIT, bestOf: bestOf, c1: 0, c2: 0, winner: null, sets: [], table: '', updated: '', ver: 0, seq: '',
  };
}

/** 3位決定戦の試合（決勝と同じ回戦の pos=1） */
function thirdOf_(ms, type) {
  const R = roundsOf_(ms, type);
  return R >= 2 ? findT_(ms, type, R, 1) : null;
}

function isThird_(ms, m) {
  return m.pos === 1 && m.round === roundsOf_(ms, m.type) && m.round >= 2;
}

/**
 * 3位決定戦を設定に合わせて追加・削除する。
 * 準決勝の両方が実際の試合（不戦勝でない）のときだけ作る（3名の山などでは作らない）。
 */
function syncThirdPlace_(ms, on) {
  [TTYPE.UPPER, TTYPE.LOWER].forEach(function (type) {
    const R = roundsOf_(ms, type);
    if (R < 2) return;
    const third = findT_(ms, type, R, 1);
    const semis = ms.filter(function (m) { return m.type === type && m.round === R - 1; });
    const possible = semis.length === 2 && semis.every(function (m) { return m.status !== TSTATUS.BYE; });
    if (on && !third && possible) {
      ms.push(newTMatch_(type, R, 1, semis[0].bestOf, (type === TTYPE.UPPER ? 'U' : 'L') + '-3P'));
      semis.forEach(function (s) { if (s.status === TSTATUS.DONE) advanceLoser_(ms, s); });
    } else if (!on && third && third.status !== TSTATUS.PROGRESS && third.status !== TSTATUS.DONE) {
      ms.splice(ms.indexOf(third), 1);
    }
  });
}

/** トーナメントの全試合を作る */
function buildBracketMatches_(type, slots, bestOf, thirdPlace) {
  const B = slots.length;
  const R = Math.round(Math.log(B) / Math.log(2));
  const ms = [];
  for (let r = 1; r <= R; r++) {
    const count = B / Math.pow(2, r);
    for (let pos = 0; pos < count; pos++) {
      const m = newTMatch_(type, r, pos, bestOf);
      if (r === 1) {
        const a = slots[pos * 2], b = slots[pos * 2 + 1];
        if (a) { m.p1 = a.num; m.n1 = a.name; m.s1 = a.seed; }
        if (b) { m.p2 = b.num; m.n2 = b.name; m.s2 = b.seed; }
        if (a && b) m.status = TSTATUS.NONE;
        else if (a || b) { m.status = TSTATUS.BYE; m.winner = a ? a.num : b.num; }
      }
      ms.push(m);
    }
  }
  ms.filter(function (m) { return m.status === TSTATUS.BYE; }).forEach(function (m) { advanceWinner_(ms, m); });
  if (thirdPlace) syncThirdPlace_(ms, true);
  return ms;
}

function findT_(ms, type, round, pos) {
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.type === type && m.round === round && m.pos === pos) return m;
  }
  return null;
}

function nextMatchOf_(ms, m) {
  if (isThird_(ms, m)) return null;
  return findT_(ms, m.type, m.round + 1, Math.floor(m.pos / 2));
}

/** 準決勝の敗者を3位決定戦に入れる */
function advanceLoser_(ms, m) {
  if (m.round !== roundsOf_(ms, m.type) - 1 || m.status !== TSTATUS.DONE || !m.winner) return;
  const third = thirdOf_(ms, m.type);
  if (!third) return;
  const isP1 = m.winner !== m.p1; // 敗者が選手1か
  const num = isP1 ? m.p1 : m.p2;
  const name = isP1 ? m.n1 : m.n2;
  const seed = isP1 ? m.s1 : m.s2;
  if (m.pos % 2 === 0) { third.p1 = num; third.n1 = name; third.s1 = seed; }
  else { third.p2 = num; third.n2 = name; third.s2 = seed; }
  if (third.p1 && third.p2 && third.status === TSTATUS.WAIT) third.status = TSTATUS.NONE;
}

function retractLoser_(ms, m) {
  if (m.round !== roundsOf_(ms, m.type) - 1) return;
  const third = thirdOf_(ms, m.type);
  if (!third) return;
  if (m.pos % 2 === 0) { third.p1 = null; third.n1 = ''; third.s1 = ''; }
  else { third.p2 = null; third.n2 = ''; third.s2 = ''; }
  third.status = TSTATUS.WAIT;
  third.table = '';
}

/** 勝者を次の試合に入れる */
function advanceWinner_(ms, m) {
  const next = nextMatchOf_(ms, m);
  if (!next || !m.winner) return;
  const isP1 = m.winner === m.p1;
  const seed = isP1 ? m.s1 : m.s2;
  const name = isP1 ? m.n1 : m.n2;
  if (m.pos % 2 === 0) { next.p1 = m.winner; next.n1 = name; next.s1 = seed; }
  else { next.p2 = m.winner; next.n2 = name; next.s2 = seed; }
  if (next.p1 && next.p2 && next.status === TSTATUS.WAIT) next.status = TSTATUS.NONE;
}

/** 次の試合から勝者を外す（結果の取り消し・勝者変更時） */
function retractWinner_(ms, m) {
  const next = nextMatchOf_(ms, m);
  if (!next) return;
  if (m.pos % 2 === 0) { next.p1 = null; next.n1 = ''; next.s1 = ''; }
  else { next.p2 = null; next.n2 = ''; next.s2 = ''; }
  next.status = TSTATUS.WAIT;
  next.table = '';
}

function roundsOf_(ms, type) {
  const r1 = ms.filter(function (m) { return m.type === type && m.round === 1; }).length;
  return r1 ? Math.round(Math.log(r1 * 2) / Math.log(2)) : 0;
}

/**
 * 棄権した選手の試合を不戦敗にする（勝ち上がった先でも続けて適用）。
 * 棄権が取り消された場合は、次の試合がまだ始まっていなければ元に戻す。
 * W: { くじ番号: true }。戻り値: 変更があったか
 */
function applyWithdrawals_(ms, W) {
  let changed = false;
  // 取り消し
  ms.forEach(function (m) {
    if (!m.wo || W[m.wo] || m.status !== TSTATUS.DONE) return;
    const R = roundsOf_(ms, m.type);
    const affected = [nextMatchOf_(ms, m)];
    if (m.round === R - 1) affected.push(thirdOf_(ms, m.type));
    const started = affected.some(function (x) { return x && (x.status === TSTATUS.PROGRESS || x.status === TSTATUS.DONE); });
    if (started) return;
    retractWinner_(ms, m);
    retractLoser_(ms, m);
    m.status = TSTATUS.NONE; m.winner = null; m.wo = ''; m.c1 = 0; m.c2 = 0; m.sets = [];
    m.ver = (m.ver || 0) + 1; m.updatedAt = new Date();
    changed = true;
  });
  // 不戦敗にする（回戦の早い順。勝ち上がった先で再び当たる場合もあるので繰り返す）
  for (let guard = 0; guard < 20; guard++) {
    let again = false;
    ms.slice().sort(function (a, b) { return a.round - b.round || a.pos - b.pos; }).forEach(function (m) {
      if (m.status !== TSTATUS.NONE && m.status !== TSTATUS.PROGRESS) return;
      if (!m.p1 || !m.p2) return;
      const w1 = !!W[m.p1], w2 = !!W[m.p2];
      if (!w1 && !w2) return;
      // 両方棄権なら上位シード側を勝ち上がり扱い（次の試合でも不戦敗になる）
      const loser1 = w1 && w2 ? (Number(m.s1) || 999) > (Number(m.s2) || 999) : w1;
      m.wo = loser1 ? m.p1 : m.p2;
      m.winner = loser1 ? m.p2 : m.p1;
      m.status = TSTATUS.DONE; m.c1 = 0; m.c2 = 0; m.sets = []; m.table = '';
      m.ver = (m.ver || 0) + 1; m.updatedAt = new Date();
      advanceWinner_(ms, m);
      advanceLoser_(ms, m);
      changed = again = true;
    });
    if (!again) break;
  }
  return changed;
}

/**
 * 棄権の反映と台の割り当てを最新のルールに合わせる。
 * （古いバージョンで決勝に台が付いている場合なども直す）戻り値: 変更があったか
 */
function normalizeTour_(ms, settings, W) {
  const sig = function () { return ms.map(function (m) { return [m.id, m.status, m.table, m.winner, m.wo, m.p1, m.p2].join(':'); }).join(','); };
  const before = sig();
  applyWithdrawals_(ms, W);
  assignTables_(ms, settings.tableCount);
  return sig() !== before;
}

/** シートの棄権チェックをトーナメントに反映する（変更があれば保存） */
function syncWithdrawals_() {
  if (!tourExists_()) return false;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return false;
  try {
    const settings = getSettings_();
    const players = readPlayers_();
    const ms = readTMatches_();
    if (!normalizeTour_(ms, settings, withdrawnSet_(players))) return false;
    writeTMatches_(ms);
    const snap = buildSnapshot_({ settings: settings, players: players, tmatches: ms });
    putSnapshotCache_(snap);
    SpreadsheetApp.flush();
    return true;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 呼出順を付けるときの順番（決勝から遠い試合を先に。同じなら上位・下位を交互に）。
 * 一度付いた呼出順は変わらない（先に対戦相手が決まった試合から台に入る）。
 */
function tablePriority_(ms) {
  const R = {};
  R[TTYPE.UPPER] = roundsOf_(ms, TTYPE.UPPER);
  R[TTYPE.LOWER] = roundsOf_(ms, TTYPE.LOWER);
  return function (a, b) {
    const left = function (m) { return R[m.type] - m.round + (m.round === R[m.type] && m.pos === 1 ? 0.5 : 0); }; // 3位決定戦は決勝より先
    return (left(b) - left(a)) || (a.pos - b.pos) || (a.type === TTYPE.UPPER ? -1 : 1);
  };
}

/**
 * 空いている台に、対戦相手が決まっている試合を割り当てる。
 * 戻り値: 新たに台が決まった試合
 */
/** 決勝（決勝の回戦の pos=0）か */
function isFinal_(ms, m) {
  return m.pos === 0 && m.round === roundsOf_(ms, m.type);
}

function assignTables_(ms, T) {
  const busy = {};
  ms.forEach(function (m) {
    if (m.status === TSTATUS.WAIT || m.status === TSTATUS.BYE || isFinal_(ms, m)) { m.table = ''; return; } // 決勝は台を指定しない
    if (!m.table) return;
    if (m.status === TSTATUS.PROGRESS) { busy[m.table] = true; return; }
    if (m.status === TSTATUS.NONE) {
      if (m.table > T || busy[m.table]) m.table = '';
      else busy[m.table] = true;
    }
  });
  // 新たに対戦相手が決まった試合に呼出順を付ける
  let maxSeq = 0;
  ms.forEach(function (m) {
    if (m.status === TSTATUS.WAIT || m.status === TSTATUS.BYE || isFinal_(ms, m)) m.seq = '';
    if (m.seq) maxSeq = Math.max(maxSeq, m.seq);
  });
  ms.filter(function (m) { return m.status === TSTATUS.NONE && !m.seq && !isFinal_(ms, m); }).sort(tablePriority_(ms))
    .forEach(function (m) { m.seq = ++maxSeq; });
  const plan = tableLoad_(ms);
  const assigned = [];
  for (let t = 1; t <= T; t++) {
    if (busy[t]) continue;
    const m = pickNext_(plan);
    if (!m) break;
    m.table = t;
    busy[t] = true;
    assigned.push(m);
  }
  return assigned;
}

/**
 * 上位・下位それぞれの「残り試合数」「台を使っている試合数」「台の空き待ちの試合」。
 * 残り試合数は、終わっていない試合（対戦相手待ちを含む。不戦勝と、台を使わない決勝は除く）。
 */
function tableLoad_(ms) {
  const plan = {};
  [TTYPE.UPPER, TTYPE.LOWER].forEach(function (type) {
    const list = ms.filter(function (m) { return m.type === type && !isFinal_(ms, m); });
    plan[type] = {
      remaining: list.filter(function (m) { return m.status !== TSTATUS.DONE && m.status !== TSTATUS.BYE; }).length,
      active: list.filter(function (m) { return m.table && (m.status === TSTATUS.NONE || m.status === TSTATUS.PROGRESS); }).length,
      queue: list.filter(function (m) { return m.status === TSTATUS.NONE && !m.table; }).sort(bySeq_),
      rounds: roundsOf_(ms, type),
    };
  });
  return plan;
}

/**
 * 次に台に入れる試合を選ぶ。
 * 残り試合数に比例して台を配分する（残り試合数 ÷（台を使っている試合数 + 1）が大きい方）。
 * 同じなら残りの回戦が多い方 → 上位。それぞれの中では呼出順（対戦相手が決まった順）。
 */
function pickNext_(plan) {
  let best = null, bestScore = -1;
  [TTYPE.UPPER, TTYPE.LOWER].forEach(function (type) {
    const p = plan[type];
    if (!p.queue.length) return;
    const score = p.remaining / (p.active + 1);
    const left = p.rounds - p.queue[0].round;
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && best && left > plan[best].rounds - plan[best].queue[0].round)) {
      best = type;
      bestScore = score;
    }
  });
  if (!best) return null;
  plan[best].active++;
  return plan[best].queue.shift();
}

function bySeq_(a, b) {
  return (a.seq || 1e9) - (b.seq || 1e9);
}

/* ------------------------------------------------------------------ */
/* シートの読み書き                                                     */
/* ------------------------------------------------------------------ */

function tourSheet_(create) {
  const ss = ss_();
  let sh = ss.getSheetByName(SHEET.TOUR);
  if (!sh && create) {
    sh = ss.insertSheet(SHEET.TOUR);
    sh.getRange(1, 1, 1, TOUR_HEADERS.length).setValues([TOUR_HEADERS]).setFontWeight('bold').setBackground('#f3e8d6');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readTMatches_() {
  const sh = tourSheet_(false);
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, TOUR_HEADERS.length).getValues()
    .filter(function (r) { return String(r[TCOL.ID]).trim() !== ''; })
    .map(tRowToMatch_);
}

function tRowToMatch_(r) {
  const sets = [];
  for (let k = 0; k < MAX_SETS; k++) {
    const s = parseSetCell_(r[TCOL.SET0 + k]);
    if (!s) break;
    sets.push(s);
  }
  const st = String(r[TCOL.STATUS] || '');
  const known = [TSTATUS.WAIT, TSTATUS.NONE, TSTATUS.PROGRESS, TSTATUS.DONE, TSTATUS.BYE];
  const updated = r[TCOL.UPDATED];
  return {
    id: String(r[TCOL.ID]),
    type: String(r[TCOL.TYPE]) === TTYPE.LOWER ? TTYPE.LOWER : TTYPE.UPPER,
    round: Number(r[TCOL.ROUND]) || 1,
    pos: Number(r[TCOL.POS]) || 0,
    p1: toNum_(r[TCOL.P1]), n1: String(r[TCOL.N1] || ''), s1: toNum_(r[TCOL.S1]) || '',
    p2: toNum_(r[TCOL.P2]), n2: String(r[TCOL.N2] || ''), s2: toNum_(r[TCOL.S2]) || '',
    status: known.indexOf(st) >= 0 ? st : TSTATUS.WAIT,
    bestOf: toNum_(r[TCOL.BEST_OF]) || 3,
    c1: Number(r[TCOL.C1]) || 0,
    c2: Number(r[TCOL.C2]) || 0,
    winner: toNum_(r[TCOL.WINNER]),
    sets: sets,
    table: toNum_(r[TCOL.TABLE]) || '',
    updated: updated instanceof Date ? Utilities.formatDate(updated, 'Asia/Tokyo', 'M/d HH:mm') : String(updated || ''),
    ver: Number(r[TCOL.VER]) || 0,
    seq: toNum_(r[TCOL.SEQ]) || '',
    wo: toNum_(r[TCOL.WO]) || '',
  };
}

function tMatchToRow_(m) {
  const row = new Array(TOUR_HEADERS.length).fill('');
  row[TCOL.ID] = m.id; row[TCOL.TYPE] = m.type; row[TCOL.ROUND] = m.round; row[TCOL.POS] = m.pos;
  row[TCOL.P1] = m.p1 || ''; row[TCOL.N1] = m.n1 || ''; row[TCOL.S1] = m.s1 || '';
  row[TCOL.P2] = m.p2 || ''; row[TCOL.N2] = m.n2 || ''; row[TCOL.S2] = m.s2 || '';
  row[TCOL.STATUS] = m.status; row[TCOL.BEST_OF] = m.bestOf;
  const hasScore = m.status === TSTATUS.PROGRESS || m.status === TSTATUS.DONE;
  row[TCOL.C1] = hasScore ? m.c1 : '';
  row[TCOL.C2] = hasScore ? m.c2 : '';
  row[TCOL.WINNER] = m.winner || '';
  for (let k = 0; k < MAX_SETS; k++) row[TCOL.SET0 + k] = m.sets && m.sets[k] ? formatSetCell_(m.sets[k]) : '';
  row[TCOL.TABLE] = m.table || '';
  row[TCOL.UPDATED] = m.updatedAt || m.updated || '';
  row[TCOL.VER] = m.ver || 0;
  row[TCOL.SEQ] = m.seq || '';
  row[TCOL.WO] = m.wo || '';
  return row;
}

function writeTMatches_(ms) {
  const sh = tourSheet_(true);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, TOUR_HEADERS.length).clearContent();
  if (!ms.length) return;
  if (sh.getMaxRows() < ms.length + 1) sh.insertRowsAfter(sh.getMaxRows(), ms.length + 1 - sh.getMaxRows());
  sh.getRange(2, TCOL.SET0 + 1, ms.length, MAX_SETS).setNumberFormat('@');
  sh.getRange(2, 1, ms.length, TOUR_HEADERS.length).setValues(ms.map(tMatchToRow_));
}

function tourExists_() {
  const sh = tourSheet_(false);
  return !!sh && sh.getLastRow() > 1;
}

/* ------------------------------------------------------------------ */
/* 表示用データ                                                         */
/* ------------------------------------------------------------------ */

function buildTourData_(ms, settings, byNum) {
  if (!ms.length) return { exists: false };
  const T = settings.tableCount;
  const out = { exists: true, tables: T, upper: null, lower: null, board: [], queue: [], withdrawn: [] };
  Object.keys(byNum).forEach(function (k) { if (byNum[k].withdrawn) out.withdrawn.push(Number(k)); });
  const fill = function (m, side) {
    const num = side === 1 ? m.p1 : m.p2;
    if (!num) return;
    const p = byNum[num];
    if (p) {
      if (side === 1) { m.n1 = p.name; m.team1 = p.team || ''; m.w1 = !!p.withdrawn; } else { m.n2 = p.name; m.team2 = p.team || ''; m.w2 = !!p.withdrawn; }
    }
  };
  [TTYPE.UPPER, TTYPE.LOWER].forEach(function (type) {
    const list = ms.filter(function (m) { return m.type === type; })
      .sort(function (a, b) { return a.round - b.round || a.pos - b.pos; });
    if (!list.length) return;
    const R = roundsOf_(list, type);
    const names = [];
    for (let r = 1; r <= R; r++) names.push(roundName_(R, r));
    list.forEach(function (m) {
      m.roundName = roundName_(R, m.round, m.pos);
      m.third = m.round === R && m.pos === 1 && R >= 2;
      m.isFinal = m.round === R && m.pos === 0;
      fill(m, 1); fill(m, 2);
    });
    const final = findT_(list, type, R, 0);
    const third = findT_(list, type, R, 1);
    const loserOf = function (m) { return m && m.status === TSTATUS.DONE ? (m.winner === m.p1 ? m.p2 : m.p1) : null; };
    const real = list.filter(function (m) { return m.status !== TSTATUS.BYE; });
    out[type === TTYPE.UPPER ? 'upper' : 'lower'] = {
      type: type, size: Math.pow(2, R), rounds: R, roundNames: names, bestOf: list[0].bestOf,
      matches: list,
      champion: final && final.status === TSTATUS.DONE ? final.winner : null,
      runnerUp: loserOf(final),
      thirdPlace: third && third.status === TSTATUS.DONE ? third.winner : null,
      hasThird: !!third,
      total: real.length,
      done: real.filter(function (m) { return m.status === TSTATUS.DONE; }).length,
      players: list.filter(function (m) { return m.round === 1; }).reduce(function (n, m) { return n + (m.p1 ? 1 : 0) + (m.p2 ? 1 : 0); }, 0),
    };
  });
  const active = ms.filter(function (m) { return m.table && (m.status === TSTATUS.NONE || m.status === TSTATUS.PROGRESS); });
  const maxT = active.reduce(function (mx, m) { return Math.max(mx, m.table); }, T);
  for (let t = 1; t <= maxT; t++) {
    const m = active.filter(function (x) { return x.table === t; })[0];
    out.board.push({ table: t, id: m ? m.id : null, extra: t > T });
  }
  // 次の試合の表示順 = 台が空いたときに割り当てる順（同じ配分ルールで予測）
  const plan = tableLoad_(ms);
  out.queue = [];
  for (let m = pickNext_(plan); m; m = pickNext_(plan)) out.queue.push(m.id);
  // 対戦相手が決まった決勝（台は個別に案内）
  out.finals = ms.filter(function (m) { return isFinal_(ms, m) && (m.status === TSTATUS.NONE || m.status === TSTATUS.PROGRESS); })
    .sort(function (a, b) { return a.type === TTYPE.UPPER ? -1 : 1; }).map(function (m) { return m.id; });
  return out;
}

/* ------------------------------------------------------------------ */
/* 作成                                                                */
/* ------------------------------------------------------------------ */

/**
 * リーグ戦の結果からトーナメントの組み合わせを作る（シートには書かない）。
 * 戻り値: { ms, summary, reasons, tour(表示用), leagues(各リーグの進行状況) }
 */
function planBrackets_(settings) {
  validateSettings_(settings);
  const snap = buildSnapshot_({ settings: settings });
  if (!snap.leagueList.length) throw new Error('リーグ戦がまだ作成されていません。');

  const reasons = [];
  const incomplete = snap.leagueList.filter(function (no) { return !snap.leagues[no].complete; });
  if (incomplete.length) {
    reasons.push('終わっていない試合があるリーグ: ' + incomplete.map(function (no) {
      const L = snap.leagues[no];
      return 'リーグ' + no + '（' + L.done + '/' + L.total + '試合）';
    }).join('、') + '。現時点の順位で作成することになります。');
  }
  const existing = readTMatches_();
  const results = existing.filter(function (m) { return m.status === TSTATUS.PROGRESS || m.status === TSTATUS.DONE; }).length;
  if (existing.length) reasons.push('トーナメントは作成済みです' + (results ? '（' + results + '試合の結果が入力済み。作り直すと消えます）' : '') + '。作り直します。');

  const upper = [];
  const lower = [];
  snap.leagueList.forEach(function (no) {
    snap.leagues[no].standings.forEach(function (s, i) {
      const e = {
        num: s.num, name: s.name, team: s.team, league: no, rank: i + 1,
        wins: s.wins, played: s.played, setsWon: s.setsWon, setsLost: s.setsLost, ratioInf: s.ratioInf,
      };
      (i < settings.advanceCount ? upper : lower).push(e);
    });
  });

  let ms = [];
  const summary = {};
  [[TTYPE.UPPER, upper, settings.upperSets], [TTYPE.LOWER, lower, settings.lowerSets]].forEach(function (def) {
    const type = def[0], entries = def[1], bestOf = def[2];
    const key = type === TTYPE.UPPER ? 'upper' : 'lower';
    if (entries.length < 2) {
      summary[key] = { count: entries.length, seeds: [], skipped: true };
      return;
    }
    const seeded = seedPlayers_(entries);
    const B = bracketSize_(seeded.length);
    ms = ms.concat(buildBracketMatches_(type, placeSlots_(seeded, B), bestOf, settings.thirdPlace));
    summary[key] = {
      count: seeded.length, size: B, byes: B - seeded.length,
      seeds: seeded.map(function (e) {
        return { seed: e.seed, num: e.num, name: e.name, team: e.team, league: e.league, rank: e.rank, wins: e.wins, losses: e.played - e.wins, setsWon: e.setsWon, setsLost: e.setsLost, ratioInf: e.ratioInf };
      }),
    };
  });
  if (!ms.length) throw new Error('トーナメントを作れる人数がいません（各トーナメント2名以上必要です）。');
  const W = withdrawnSet_();
  applyWithdrawals_(ms, W);
  Object.keys(summary).forEach(function (k) { (summary[k].seeds || []).forEach(function (e) { e.withdrawn = !!W[e.num]; }); });
  if (Object.keys(W).length) {
    const names = [];
    Object.keys(summary).forEach(function (k) { (summary[k].seeds || []).forEach(function (e) { if (e.withdrawn) names.push(e.name); }); });
    if (names.length) reasons.push('棄権の選手: ' + names.join('、') + '。トーナメントには入りますが、試合は不戦敗になります。');
  }
  assignTables_(ms, settings.tableCount);

  const byNum = {};
  snap.boot.players.forEach(function (p) { byNum[p.num] = p; });
  return {
    ms: ms,
    summary: summary,
    reasons: reasons,
    tour: buildTourData_(JSON.parse(JSON.stringify(ms)), settings, byNum),
    leagues: snap.leagueList.map(function (no) {
      const L = snap.leagues[no];
      return { no: no, done: L.done, total: L.total, complete: L.complete };
    }),
  };
}

/** プレビュー後にリーグ戦の結果・設定・トーナメントが変わっていないかを判定するための値 */
function tourSignature_(settings) {
  const lm = valuesToMatches_(readMatchValues_()).map(function (m) { return m.id + ':' + m.ver + ':' + m.status; }).join(',');
  const tm = readTMatches_().map(function (m) { return m.id + ':' + m.ver; }).join(',');
  const w = Object.keys(withdrawnSet_()).sort().join(',');
  return [settings.advanceCount, settings.upperSets, settings.lowerSets, settings.tableCount, settings.thirdPlace].join('|') + '#' + lm + '#' + tm + '#' + w;
}

const CACHE_KEY_PLAN = 'tourplan_v1';

/** 作成前の確認用に組み合わせを作り、30分間保存しておく */
function previewBrackets_(settings) {
  const plan = planBrackets_(settings);
  const id = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  CacheService.getScriptCache().put(ck_(CACHE_KEY_PLAN), JSON.stringify({
    id: id, ms: plan.ms, summary: plan.summary, reasons: plan.reasons, signature: tourSignature_(settings),
  }), 1800);
  return { planId: id, summary: plan.summary, reasons: plan.reasons, tour: plan.tour, leagues: plan.leagues, tables: settings.tableCount };
}

/**
 * トーナメントを作成してシートに書き込む。
 * planId を渡すと、確認画面で表示した組み合わせをそのまま使う。
 * 注意事項（未終了のリーグ・作り直し）がある場合は、force でないと needConfirm を返す。
 */
function createBrackets_(settings, force, planId) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('他の処理が実行中です。少し待ってから再度実行してください。');
  try {
    let plan;
    if (planId) {
      const raw = CacheService.getScriptCache().get(ck_(CACHE_KEY_PLAN));
      plan = raw ? JSON.parse(raw) : null;
      if (!plan || plan.id !== planId) throw new Error('確認画面の有効期限が切れました。もう一度「トーナメント表を確認して作成」からやり直してください。');
      if (plan.signature !== tourSignature_(settings)) {
        throw new Error('確認画面を開いた後に、リーグ戦の結果または設定が変わりました。もう一度「トーナメント表を確認して作成」からやり直してください。');
      }
    } else {
      plan = planBrackets_(settings);
    }
    if (plan.reasons.length && !force) return { needConfirm: true, reasons: plan.reasons };

    writeTMatches_(plan.ms);
    CacheService.getScriptCache().removeAll([ck_(CACHE_KEY_PLAN)]);
    const snap2 = buildSnapshot_({ settings: settings, tmatches: readTMatches_() });
    putSnapshotCache_(snap2);
    SpreadsheetApp.flush();
    return { ok: true, summary: plan.summary, tables: settings.tableCount };
  } finally {
    lock.releaseLock();
  }
}

/** 台の数を変えたときなどに割り当てをやり直す */
function reassignTables_(settings) {
  const ms = readTMatches_();
  if (!ms.length) return;
  syncThirdPlace_(ms, settings.thirdPlace); // 3位決定戦の有無を変えた場合（作成済みのトーナメントにも追加できる）
  applyWithdrawals_(ms, withdrawnSet_());
  assignTables_(ms, settings.tableCount);
  writeTMatches_(ms);
}

/* ------------------------------------------------------------------ */
/* 結果の保存                                                          */
/* ------------------------------------------------------------------ */

/**
 * p = { matchId, ver, sets, reset, force, code }
 */
function apiSaveTMatch(tid, p) {
  useTournament_(tid);
  p = p || {};
  const settings = checkEntryCode_(p.code);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('ただいま混み合っています。少し待ってからもう一度「保存」を押してください。');
  try {
    const ms = readTMatches_();
    const m = ms.filter(function (x) { return x.id === String(p.matchId); })[0];
    if (!m) throw new Error('試合が見つかりません。トーナメントが作り直された可能性があります。画面を更新してください。');
    if (!p.force && Number(p.ver) !== m.ver) return JSON.stringify({ conflict: true, current: m });
    if (!m.p1 || !m.p2 || m.status === TSTATUS.BYE) throw new Error('この試合はまだ対戦相手が決まっていません。');
    if (m.wo) throw new Error('この試合は棄権による不戦勝です。取り消す場合は「参加者」シートの「棄権」のチェックを外してください。');

    let status = TSTATUS.NONE, winner = null, sets = [], c1 = 0, c2 = 0;
    const d = decideResult_(p, m.bestOf);
    if (d.status !== 'none') {
      sets = d.sets;
      c1 = d.a; c2 = d.b;
      status = d.status === 'done' ? TSTATUS.DONE : TSTATUS.PROGRESS;
      winner = d.winner === 1 ? m.p1 : d.winner === 2 ? m.p2 : null;
    }

    // 勝者が変わる（または取り消す）場合、次の試合がまだ始まっていなければ差し替える
    if (m.status === TSTATUS.DONE && m.winner !== winner) {
      const R = roundsOf_(ms, m.type);
      const affected = [nextMatchOf_(ms, m)];
      if (m.round === R - 1) affected.push(thirdOf_(ms, m.type)); // 準決勝なら3位決定戦も
      affected.forEach(function (x) {
        if (x && (x.status === TSTATUS.PROGRESS || x.status === TSTATUS.DONE)) {
          throw new Error('次の試合（' + roundName_(R, x.round, x.pos) + '）が既に始まっているため、勝敗を変更できません。先にその試合の結果を消してください。');
        }
      });
      retractWinner_(ms, m);
      retractLoser_(ms, m);
    }

    m.status = status; m.winner = winner; m.sets = sets; m.c1 = c1; m.c2 = c2;
    m.ver = m.ver + 1;
    m.updatedAt = new Date();
    if (status === TSTATUS.DONE) {
      advanceWinner_(ms, m);
      advanceLoser_(ms, m);
    }
    applyWithdrawals_(ms, withdrawnSet_()); // 勝ち上がった先の相手が棄権していれば不戦勝
    assignTables_(ms, settings.tableCount); // 空いた台に次の試合を入れる
    writeTMatches_(ms);

    const snap = buildSnapshot_({ settings: settings, tmatches: ms });
    putSnapshotCache_(snap);
    SpreadsheetApp.flush();
    return JSON.stringify({ ok: true, tour: snap.tour });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 呼び出し中の試合をまとめて「試合中」にする。
 * ids: 試合IDの配列。まだ「呼び出し中」（未実施・台あり）の試合だけを移し、それ以外は飛ばす。
 */
function apiStartTMatches(tid, ids, code) {
  useTournament_(tid);
  const settings = checkEntryCode_(code);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('ただいま混み合っています。少し待ってからもう一度お試しください。');
  try {
    const want = {};
    (ids || []).forEach(function (id) { want[String(id)] = true; });
    const ms = readTMatches_();
    const started = [], skipped = [];
    ms.forEach(function (m) {
      if (!want[m.id]) return;
      if (m.status === TSTATUS.NONE && m.p1 && m.p2 && !m.wo && m.table) {
        m.status = TSTATUS.PROGRESS;
        m.sets = []; m.c1 = 0; m.c2 = 0;
        m.ver = (m.ver || 0) + 1;
        m.updatedAt = new Date();
        started.push(m.id);
      } else {
        skipped.push(m.id);
      }
    });
    if (started.length) {
      assignTables_(ms, settings.tableCount);
      writeTMatches_(ms);
    }
    const snap = buildSnapshot_({ settings: settings, tmatches: ms });
    putSnapshotCache_(snap);
    SpreadsheetApp.flush();
    return JSON.stringify({ ok: true, started: started, skipped: skipped, tour: snap.tour });
  } finally {
    lock.releaseLock();
  }
}

function apiGetBracket(tid) {
  useTournament_(tid);
  return getTourJson_();
}
