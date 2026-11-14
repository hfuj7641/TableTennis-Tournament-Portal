/**
 * 管理者からのメール送信
 *
 * - 宛先は「参加者」シートの名前とメールアドレス（同じアドレスは1通にまとめる）
 * - 件名・本文は管理者画面で入力。本文の {名前} は宛先の名前に置き換える
 * - 送信方法:
 *     送信中継（MAIL_RELAY_URL が設定されている場合）… 別アカウント（例: hiroaki@machineguntalk.com）で
 *       デプロイした送信専用スクリプト（mailer/Mailer.gs）に依頼して送る
 *     直接送信（未設定の場合）… このアプリをデプロイしたアカウントの Gmail から送る
 *   どちらも送信元（from）は Gmail の「他のメールアドレス（送信元）」に登録済みのアドレスである必要がある
 * - 送信結果は「メール送信ログ」シートと「更新ログ」に記録する
 */

const PROP_MAIL_RELAY_URL = 'MAIL_RELAY_URL';
const PROP_MAIL_RELAY_SECRET = 'MAIL_RELAY_SECRET';
const PROP_MAIL_FROM = 'MAIL_FROM';
const PROP_MAIL_FROM_NAME = 'MAIL_FROM_NAME';
const DEFAULT_MAIL_FROM = 'mark@rapid-stella.club';
const DEFAULT_MAIL_FROM_NAME = 'DP杯大会運営管理者';
const MAIL_LOG_SHEET = 'メール送信ログ';
const MAIL_LOG_HEADERS = ['日時', '件名', '宛先の名前', 'メールアドレス', '結果', '送信方法', '送信元', 'テスト'];
const MAIL_BATCH_MAX = 25; // 1回の呼び出しで送る最大件数（画面側で分けて送る）

function mailConfig_() {
  const p = props_();
  return {
    relayUrl: p.getProperty(PROP_MAIL_RELAY_URL) || '',
    relaySecret: p.getProperty(PROP_MAIL_RELAY_SECRET) || '',
    from: p.getProperty(PROP_MAIL_FROM) || DEFAULT_MAIL_FROM,
    fromName: p.getProperty(PROP_MAIL_FROM_NAME) || DEFAULT_MAIL_FROM_NAME,
  };
}

function isEmail_(s) {
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(String(s || '').trim());
}

/** 「参加者」シートの名前・メールアドレス（管理者専用。Web の公開データには使わない） */
function readPlayerEmails_() {
  const sh = sheet_(SHEET.PLAYERS);
  const c = playerColumns_(sh);
  if (c.email < 0) return [];
  const players = readPlayers_();
  const byRow = {};
  players.forEach(function (p) { byRow[p.row] = p; });
  const last = sh.getLastRow();
  if (last < 2) return [];
  const col = sh.getRange(2, c.email + 1, last - 1, 1).getValues();
  const out = [];
  col.forEach(function (r, i) {
    const p = byRow[i + 2];
    if (!p) return;
    const email = String(r[0] == null ? '' : r[0]).trim();
    out.push({
      row: p.row, name: p.name, team: p.team, email: email, valid: isEmail_(email),
      attend: p.attend, paid: p.paid, withdrawn: p.withdrawn, num: p.num,
      eligible: p.attend && p.paid && p.num != null,
    });
  });
  return out;
}

/** 管理者画面: 送信元と宛先の一覧 */
function adminGetMailInfo(tid, pw) {
  useTournament_(tid);
  checkAdmin_(pw);
  ensureEmailColumn_();
  const cfg = mailConfig_();
  let me = '';
  try { me = Session.getEffectiveUser().getEmail(); } catch (err) { me = ''; }
  return JSON.stringify({
    from: cfg.from, fromName: cfg.fromName,
    mode: cfg.relayUrl ? 'relay' : 'direct',
    sender: cfg.relayUrl ? '送信中継' : (me || 'このアプリをデプロイしたアカウント'),
    recipients: readPlayerEmails_(),
  });
}

/** 宛先ごとに本文の {名前} を置き換えた送信内容を作る */
function buildMails_(req) {
  const subject = String(req.subject || '').trim();
  const body = String(req.body || '');
  if (!subject) throw new Error('件名を入力してください。');
  if (!body.trim()) throw new Error('本文を入力してください。');
  if (subject.length > 200) throw new Error('件名が長すぎます（200文字まで）。');
  if (body.length > 20000) throw new Error('本文が長すぎます（20,000文字まで）。');
  const to = Array.isArray(req.to) ? req.to : [];
  if (!to.length) throw new Error('宛先がありません。');
  if (to.length > MAIL_BATCH_MAX) throw new Error('一度に送れるのは ' + MAIL_BATCH_MAX + ' 件までです。');
  return to.map(function (t) {
    const email = String(t.email || '').trim();
    const names = (Array.isArray(t.names) ? t.names : [t.names]).map(function (n) { return String(n || '').trim(); }).filter(Boolean);
    const nameText = names.join('・');
    return {
      to: email, names: nameText, valid: isEmail_(email),
      subject: (req.test ? '[テスト] ' : '') + subject.replace(/\{名前\}/g, nameText),
      body: body.replace(/\{名前\}/g, nameText),
    };
  });
}

/** 送信中継（別アカウントのスクリプト）に依頼する */
function sendViaRelay_(cfg, mails) {
  const res = UrlFetchApp.fetch(cfg.relayUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ secret: cfg.relaySecret, action: 'send', from: cfg.from, fromName: cfg.fromName, mails: mails.map(function (m) { return { to: m.to, subject: m.subject, body: m.body }; }) }),
    muteHttpExceptions: true,
    followRedirects: true,
  });
  let data;
  try {
    data = JSON.parse(res.getContentText());
  } catch (err) {
    throw new Error('送信中継から正しい応答がありません（HTTP ' + res.getResponseCode() + '）。送信中継のURLとデプロイ設定（アクセスできるユーザー: 全員）を確認してください。');
  }
  if (!data.ok) throw new Error('送信中継のエラー: ' + (data.error || '不明なエラー'));
  return data.results || [];
}

/** このアプリのアカウントの Gmail から直接送る */
function sendDirect_(cfg, mails) {
  let aliases;
  try {
    aliases = GmailApp.getAliases();
  } catch (err) {
    if (/permission|権限|authoriz/i.test(String(err && err.message || err))) {
      throw new Error('送信中継が設定されていないため、このアプリのアカウントから直接送ろうとしましたが、Gmail の権限が承認されていません。\n' +
        '・送信元（' + cfg.from + '）から送る場合は、「大会の作成・管理」→「メール送信の設定」で送信中継のURLと連携キーを保存してください。\n' +
        '・このアカウントから直接送る場合は、Apps Script のエディタで関数 authorize を実行して権限を承認してください。');
    }
    throw err;
  }
  let me = '';
  try { me = Session.getEffectiveUser().getEmail(); } catch (err) { me = ''; }
  if (cfg.from && cfg.from !== me && aliases.indexOf(cfg.from) < 0) {
    throw new Error('送信元 ' + cfg.from + ' は、このアプリをデプロイしたアカウント（' + (me || '不明') + '）の Gmail に「他のメールアドレス（送信元）」として登録されていません。送信中継を設定するか、Gmail の設定で送信元を追加してください。');
  }
  return mails.map(function (m) {
    try {
      const opt = { name: cfg.fromName };
      if (cfg.from && cfg.from !== me) opt.from = cfg.from;
      GmailApp.sendEmail(m.to, m.subject, m.body, opt);
      return { to: m.to, ok: true };
    } catch (err) {
      return { to: m.to, ok: false, error: String(err && err.message || err) };
    }
  });
}

/**
 * 管理者画面: メールを送る（画面側で MAIL_BATCH_MAX 件ずつに分けて呼ぶ）
 * req = { subject, body, to: [{ email, names: [..] }], test: boolean }
 */
function adminSendMail(tid, pw, req) {
  useTournament_(tid);
  checkAdmin_(pw);
  req = req || {};
  const cfg = mailConfig_();
  const mails = buildMails_(req);
  const valid = mails.filter(function (m) { return m.valid; });
  let results = [];
  if (valid.length) results = cfg.relayUrl ? sendViaRelay_(cfg, valid) : sendDirect_(cfg, valid);
  const byTo = {};
  results.forEach(function (r) { byTo[r.to] = r; });
  const out = mails.map(function (m) {
    if (!m.valid) return { to: m.to, names: m.names, ok: false, error: 'メールアドレスの形式が正しくありません' };
    const r = byTo[m.to] || { ok: false, error: '送信結果がありません' };
    return { to: m.to, names: m.names, ok: !!r.ok, error: r.ok ? '' : (r.error || '送信に失敗しました') };
  });

  // メール送信ログ
  try {
    const ss = ss_();
    let sh = ss.getSheetByName(MAIL_LOG_SHEET);
    if (!sh) {
      sh = ss.insertSheet(MAIL_LOG_SHEET);
      sh.getRange(1, 1, 1, MAIL_LOG_HEADERS.length).setValues([MAIL_LOG_HEADERS]).setFontWeight('bold').setBackground('#f3e8d6');
      sh.setFrozenRows(1);
    }
    const now = new Date();
    const subj = String(req.subject || '').trim();
    const rows = out.map(function (r) {
      return [now, logText_(subj), logText_(r.names), logText_(r.to), r.ok ? '送信済み' : '失敗: ' + r.error, cfg.relayUrl ? '送信中継' : '直接', cfg.from, req.test ? 'テスト' : ''];
    });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, MAIL_LOG_HEADERS.length).setValues(rows);
  } catch (err) {
    console.warn('mail log failed: ' + err);
  }
  const okCount = out.filter(function (r) { return r.ok; }).length;
  writeLog_([{
    kind: '管理', action: req.test ? 'メールをテスト送信' : 'メールを送信',
    after: '件名「' + String(req.subject || '').trim().slice(0, 60) + '」 送信 ' + okCount + '件' + (out.length - okCount ? '・失敗 ' + (out.length - okCount) + '件' : ''),
  }], metaFrom_(arguments));
  return JSON.stringify({ results: out });
}

/* ------------------------------------------------------------------ */
/* システム管理者: メール送信の設定                                      */
/* ------------------------------------------------------------------ */

function sysSetMailConfig(pw, cfg) {
  checkMaster_(pw);
  cfg = cfg || {};
  const p = props_();
  const url = String(cfg.relayUrl || '').trim();
  if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    throw new Error('送信中継のURLは https://script.google.com/macros/s/…/exec の形で入力してください。');
  }
  const from = String(cfg.from || '').trim();
  if (from && !isEmail_(from)) throw new Error('送信元のメールアドレスが正しくありません。');
  const secret = String(cfg.relaySecret || '').trim();
  if (url && secret.length < 16) throw new Error('送信中継の連携キーは16文字以上にしてください。');
  const set = function (k, v) { if (v) p.setProperty(k, v); else p.deleteProperty(k); };
  set(PROP_MAIL_RELAY_URL, url);
  set(PROP_MAIL_RELAY_SECRET, secret);
  set(PROP_MAIL_FROM, from);
  set(PROP_MAIL_FROM_NAME, String(cfg.fromName || '').trim());
  return sysGetData(pw);
}

/** システム管理者: 送信中継の接続確認（送信元が使えるか・残りの送信可能数） */
function sysTestMailRelay(pw) {
  checkMaster_(pw);
  const cfg = mailConfig_();
  if (!cfg.relayUrl) throw new Error('送信中継のURLが設定されていません。');
  const res = UrlFetchApp.fetch(cfg.relayUrl, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, followRedirects: true,
    payload: JSON.stringify({ secret: cfg.relaySecret, action: 'check', from: cfg.from }),
  });
  let data;
  try { data = JSON.parse(res.getContentText()); } catch (err) {
    throw new Error('送信中継から正しい応答がありません（HTTP ' + res.getResponseCode() + '）。URLとデプロイ設定を確認してください。');
  }
  if (!data.ok) throw new Error('送信中継のエラー: ' + (data.error || '不明なエラー'));
  return JSON.stringify(data);
}
