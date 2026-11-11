/**
 * 更新ログ（各大会のスプレッドシートの「更新ログ」シート）
 *
 * 結果の入力・修正・消去、途中経過、セット数の変更、一括「試合中」、管理者の操作を1行ずつ記録する。
 * 端末番号・ブラウザは画面から送られる値。IPアドレスは Cloudflare Worker が付けた署名付きの値を確認して記録する。
 */

const LOG_SHEET = '更新ログ';
const LOG_HEADERS = ['日時', '種類', '試合ID', '試合', '操作', '変更前', '変更後', '端末', 'IPアドレス', 'IP確認', 'ブラウザ'];
const PROP_LOG_SECRET = 'LOG_SECRET'; // Cloudflare Worker と共通の署名キー

/** 引数の最後にある「画面の情報」（{ __meta: true, device, ua, cfp }）を取り出す */
function metaFrom_(args) {
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (a && typeof a === 'object' && a.__meta) return a;
  }
  return null;
}

function bytesToHex_(bytes) {
  return bytes.map(function (b) { const v = b < 0 ? b + 256 : b; return (v < 16 ? '0' : '') + v.toString(16); }).join('');
}

/**
 * Worker が付けた「IP|時刻」の署名を確認する。
 * 戻り値: { ip, status: '確認済' | '署名不一致' | '期限切れ' | '未確認（キー未設定）' | '不正' | 'なし' }
 */
function verifyAccessToken_(token) {
  if (!token) return { ip: '', status: 'なし' };
  const parts = String(token).split('.');
  if (parts.length !== 2) return { ip: '', status: '不正' };
  let payload;
  try {
    payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  } catch (err) {
    return { ip: '', status: '不正' };
  }
  const sep = payload.lastIndexOf('|');
  if (sep < 0) return { ip: '', status: '不正' };
  const ip = payload.slice(0, sep).slice(0, 64);
  const ts = Number(payload.slice(sep + 1));
  const secret = props_().getProperty(PROP_LOG_SECRET);
  if (!secret) return { ip: ip, status: '未確認（キー未設定）' };
  const sig = bytesToHex_(Utilities.computeHmacSha256Signature(payload, secret));
  if (sig !== parts[1].toLowerCase()) return { ip: ip, status: '署名不一致' };
  const age = Date.now() / 1000 - ts;
  if (!(age > -600 && age < 2 * 86400)) return { ip: ip, status: '期限切れ' };
  return { ip: ip, status: '確認済' };
}

function logSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LOG_SHEET);
    sh.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold').setBackground('#f3e8d6');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 数式と解釈されないように */
function logText_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/**
 * 更新ログを書き込む。失敗しても保存処理は止めない。
 * entries: [{ kind, id, label, action, before, after }]
 */
function writeLog_(entries, meta) {
  if (!entries || !entries.length) return;
  try {
    const m = meta || {};
    const ipInfo = verifyAccessToken_(m.cfp);
    const now = new Date();
    const rows = entries.map(function (e) {
      return [
        now, logText_(e.kind), logText_(e.id || ''), logText_(e.label || ''), logText_(e.action || ''),
        logText_(e.before || ''), logText_(e.after || ''),
        logText_(String(m.device || '').slice(0, 32)),
        logText_(ipInfo.ip), logText_(m.cfp || m.device ? ipInfo.status : ''),
        logText_(String(m.ua || '').slice(0, 200)),
      ];
    });
    const sh = logSheet_();
    const start = sh.getLastRow() + 1;
    if (sh.getMaxRows() < start + rows.length - 1) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 100);
    sh.getRange(start, 1, rows.length, LOG_HEADERS.length).setValues(rows);
  } catch (err) {
    console.warn('update log failed: ' + err);
  }
}

/** 試合の状態を1行の文章に（例: 終了 2-1（11-8, 9-11, 11-5）） */
function matchSummary_(status, c1, c2, sets, extra) {
  let s = status || '未実施';
  if (status === '試合中' || status === '終了') s += ' ' + (Number(c1) || 0) + '-' + (Number(c2) || 0);
  if (sets && sets.length) s += '（' + sets.map(function (x) { return x[0] + '-' + x[1]; }).join(', ') + '）';
  if (extra) s += ' ' + extra;
  return s;
}

/** 状態の変化から操作の名前を決める */
function actionName_(before, after, force) {
  let a;
  if (after === '未実施' || after === '') a = before === '未実施' || before === '' ? '変更なし' : '結果を消去';
  else if (after === '試合中') a = before === '試合中' ? '途中経過を更新' : '試合開始・途中経過';
  else if (after === '終了') a = before === '終了' ? '結果を修正' : '結果を入力';
  else a = '保存';
  return a + (force ? '（他の人の更新を上書き）' : '');
}

/* ------------------------------------------------------------------ */
/* システム管理者: 署名キーの設定                                        */
/* ------------------------------------------------------------------ */

function sysSetLogSecret(pw, secret) {
  checkMaster_(pw);
  secret = String(secret || '').trim();
  if (secret) {
    if (secret.length < 16 || /\s/.test(secret)) throw new Error('連携キーは空白なしの16文字以上にしてください。');
    props_().setProperty(PROP_LOG_SECRET, secret);
  } else {
    props_().deleteProperty(PROP_LOG_SECRET);
  }
  return sysGetData(pw);
}
