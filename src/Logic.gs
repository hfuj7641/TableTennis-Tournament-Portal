/**
 * 純粋なロジック（スプレッドシートに依存しない）
 * ローカルの Node.js でもテストできるようにしてある。
 */

/** 何セット先取か（3セットマッチ → 2） */
function setsToWin_(bestOf) {
  return Math.floor(Number(bestOf) / 2) + 1;
}

function shuffle_(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/** n 人を L リーグに分けたときの各リーグの人数（差は最大1） */
function leagueSizes_(n, L) {
  const base = Math.floor(n / L);
  const extra = n % L;
  const out = [];
  for (let i = 0; i < L; i++) out.push(base + (i < extra ? 1 : 0));
  return out;
}

/** 選手をランダムに L 個のリーグに振り分ける。各リーグ内はくじ番号順。 */
function distributeToLeagues_(players, L) {
  const shuffled = shuffle_(players);
  const sizes = leagueSizes_(shuffled.length, L);
  const out = [];
  let k = 0;
  sizes.forEach(function (sz) {
    out.push(shuffled.slice(k, k + sz).sort(function (a, b) { return a.num - b.num; }));
    k += sz;
  });
  return out;
}

/**
 * 総当たりの組み合わせ（サークル方式）。
 * 同じ選手が連続しにくい順番になる。
 */
function roundRobinPairs_(ids) {
  const arr = ids.slice();
  if (arr.length % 2) arr.push(null);
  const n = arr.length;
  const out = [];
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a !== null && b !== null) out.push(a < b ? [a, b] : [b, a]);
    }
    arr.splice(1, 0, arr.pop());
  }
  return out;
}

/** "11-8" → [11, 8] */
function parseSetCell_(v) {
  if (v === '' || v == null) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    // 万一スプレッドシートが日付に変換してしまった場合（"11-8" → 11月8日）
    return [v.getMonth() + 1, v.getDate()];
  }
  const m = String(v).match(/^\s*'?\s*(\d+)\s*[-－ー−‐:：]\s*(\d+)\s*$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function formatSetCell_(s) {
  return s ? s[0] + '-' + s[1] : '';
}

/**
 * 各セットの得点から獲得セット数・勝者を求め、矛盾をチェックする。
 * sets: [[選手1の得点, 選手2の得点], ...]
 * 戻り値: { a, b, need, winner(0|1|2), errors[] }
 */
function evaluateSets_(sets, bestOf) {
  const need = setsToWin_(bestOf);
  const errors = [];
  let a = 0;
  let b = 0;
  if (sets.length > bestOf) errors.push('セット数が多すぎます（最大 ' + bestOf + ' セット）');
  for (let i = 0; i < sets.length; i++) {
    const s = sets[i];
    const ok = Array.isArray(s) && s.length === 2 && Number.isInteger(s[0]) && Number.isInteger(s[1]) && s[0] >= 0 && s[1] >= 0 && s[0] <= 99 && s[1] <= 99;
    if (!ok) {
      errors.push('第' + (i + 1) + 'セットの得点が正しくありません');
      continue;
    }
    if (a >= need || b >= need) {
      errors.push('第' + (i + 1) + 'セット: 勝敗が決まった後のセットが入力されています');
      continue;
    }
    if (s[0] === s[1]) {
      errors.push('第' + (i + 1) + 'セットが同点です');
      continue;
    }
    if (s[0] > s[1]) a++;
    else b++;
  }
  const winner = a >= need ? 1 : b >= need ? 2 : 0;
  return { a: a, b: b, need: need, winner: winner, errors: errors };
}

/** 卓球のルール（11点先取・10-10以降は2点差）として成り立つ得点か */
function isValidGameScore_(x, y) {
  const w = Math.max(x, y);
  const l = Math.min(x, y);
  return (w === 11 && l <= 9) || (w > 11 && w - l === 2);
}

/**
 * リーグの順位を計算する。
 * 1. 勝率
 * 2. セット率（獲得セット ÷ 失セット。失セット0なら∞）
 * 3. 獲得セット数
 * 4. 当該選手間の直接対決（3名以上が並んだ場合は、その選手間での勝数）
 * それでも決まらない場合は同順位。
 */
function computeStandings_(players, matches, advanceCount) {
  const st = {};
  players.forEach(function (p) {
    st[p.num] = {
      num: p.num, name: p.name, team: p.team || '',
      played: 0, wins: 0, losses: 0, setsWon: 0, setsLost: 0, ptsWon: 0, ptsLost: 0,
    };
  });
  const done = matches.filter(function (m) { return m.status === STATUS.DONE && m.winner; });
  done.forEach(function (m) {
    const A = st[m.p1];
    const B = st[m.p2];
    if (!A || !B) return;
    A.played++;
    B.played++;
    A.setsWon += m.c1;
    A.setsLost += m.c2;
    B.setsWon += m.c2;
    B.setsLost += m.c1;
    (m.sets || []).forEach(function (s) {
      A.ptsWon += s[0];
      A.ptsLost += s[1];
      B.ptsWon += s[1];
      B.ptsLost += s[0];
    });
    if (m.winner === m.p1) {
      A.wins++;
      B.losses++;
    } else {
      B.wins++;
      A.losses++;
    }
  });

  const list = Object.keys(st).map(function (k) { return st[k]; });
  list.forEach(function (s) {
    s.winRate = s.played ? s.wins / s.played : 0;
    s.ratioInf = s.setsLost === 0 && s.setsWon > 0;
    s.ratio = s.setsLost ? s.setsWon / s.setsLost : 0;
  });

  const primary = recordCompare_;

  list.sort(function (x, y) { return primary(x, y) || x.num - y.num; });

  // 主要指標で並んだグループごとに直接対決で解決する
  const tiers = [];
  let i = 0;
  while (i < list.length) {
    let j = i + 1;
    while (j < list.length && primary(list[i], list[j]) === 0) j++;
    resolveByHeadToHead_(list.slice(i, j), done).forEach(function (t) { tiers.push(t); });
    i = j;
  }

  const out = [];
  let pos = 0;
  tiers.forEach(function (tier) {
    tier.forEach(function (s) {
      s.rank = pos + 1;
      s.tied = tier.length > 1;
      s.advance = s.rank <= advanceCount ? 'upper' : 'lower';
      out.push(s);
    });
    pos += tier.length;
  });
  return out;
}

/**
 * 成績の比較（負なら x が上）: 勝率 → セット率（失セット0は∞）→ 獲得セット数
 * 小数の誤差を避けるため、比較は掛け算で行う
 */
function recordCompare_(x, y) {
  const d1 = y.wins * Math.max(x.played, 1) - x.wins * Math.max(y.played, 1);
  if (d1) return d1;
  if (!!x.ratioInf !== !!y.ratioInf) return x.ratioInf ? -1 : 1;
  if (!x.ratioInf) {
    const d2 = y.setsWon * Math.max(x.setsLost, 1) - x.setsWon * Math.max(y.setsLost, 1);
    if (d2) return d2;
  }
  return y.setsWon - x.setsWon;
}

/** 同じ成績の選手群を、その選手間の勝数で順位付けする。戻り値は「同順位グループ」の配列。 */
function resolveByHeadToHead_(group, doneMatches) {
  if (group.length < 2) return [group];
  const ids = {};
  group.forEach(function (s) { ids[s.num] = true; });
  const hw = {};
  group.forEach(function (s) { hw[s.num] = 0; });
  doneMatches.forEach(function (m) {
    if (ids[m.p1] && ids[m.p2] && hw[m.winner] !== undefined) hw[m.winner]++;
  });
  const vals = group.map(function (s) { return hw[s.num]; });
  if (vals.every(function (v) { return v === vals[0]; })) {
    return [group.slice().sort(function (a, b) { return a.num - b.num; })];
  }
  const sorted = group.slice().sort(function (a, b) { return hw[b.num] - hw[a.num] || a.num - b.num; });
  const out = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && hw[sorted[j].num] === hw[sorted[i].num]) j++;
    resolveByHeadToHead_(sorted.slice(i, j), doneMatches).forEach(function (t) { out.push(t); });
    i = j;
  }
  return out;
}
