/**
 * 卓球大会ポータル - メール送信中継
 *
 * 送信元（例: mark@rapid-stella.club）を Gmail の「他のメールアドレス（送信元）」に登録している
 * アカウント（例: hiroaki@machineguntalk.com）で、このスクリプトを作成・デプロイする。
 * ポータル本体から「連携キー」付きで依頼が来たときだけ、メールを送る。
 *
 * 設定:
 *   プロジェクトの設定 → スクリプト プロパティ → MAIL_RELAY_SECRET に連携キー（16文字以上）
 *   （ポータルの「大会の作成・管理」→「メール送信の設定」にも同じ値を設定する）
 * デプロイ:
 *   デプロイ → 新しいデプロイ → 種類: ウェブアプリ
 *   次のユーザーとして実行: 自分（このアカウント） / アクセスできるユーザー: 全員
 */

const MAX_MAILS_PER_REQUEST = 50;

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: '依頼の形式が正しくありません' });
  }
  const secret = PropertiesService.getScriptProperties().getProperty('MAIL_RELAY_SECRET') || '';
  if (!secret || secret.length < 16) return json_({ ok: false, error: '送信中継に連携キー（MAIL_RELAY_SECRET）が設定されていません' });
  if (!safeEqual_(String(req.secret || ''), secret)) return json_({ ok: false, error: '連携キーが一致しません' });

  const me = Session.getEffectiveUser().getEmail();
  const from = String(req.from || '').trim();
  const aliases = GmailApp.getAliases();
  const fromOk = !from || from === me || aliases.indexOf(from) >= 0;

  if (req.action === 'check') {
    return json_({ ok: true, account: me, from: from, fromOk: fromOk, aliases: aliases, remaining: MailApp.getRemainingDailyQuota() });
  }
  if (req.action !== 'send') return json_({ ok: false, error: '不明な依頼です' });
  if (!fromOk) return json_({ ok: false, error: '送信元 ' + from + ' は ' + me + ' の Gmail に「他のメールアドレス（送信元）」として登録されていません' });

  const mails = Array.isArray(req.mails) ? req.mails.slice(0, MAX_MAILS_PER_REQUEST) : [];
  const results = mails.map(function (m) {
    const to = String(m.to || '').trim();
    try {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('メールアドレスの形式が正しくありません');
      const opt = { name: String(req.fromName || '') };
      if (from && from !== me) opt.from = from;
      GmailApp.sendEmail(to, String(m.subject || ''), String(m.body || ''), opt);
      return { to: to, ok: true };
    } catch (err) {
      return { to: to, ok: false, error: String(err && err.message || err) };
    }
  });
  return json_({ ok: true, results: results, remaining: MailApp.getRemainingDailyQuota() });
}

function doGet() {
  return json_({ ok: true, message: '卓球大会ポータルのメール送信中継です（POST で利用）' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 文字列の比較（時間差で中身を推測されにくいように） */
function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 初回に1回だけ実行して、Gmail の送信の権限を承認する */
function authorize() {
  console.log('アカウント: ' + Session.getEffectiveUser().getEmail());
  console.log('送信元として使えるアドレス: ' + GmailApp.getAliases().join(', '));
  console.log('今日あと送信できる数: ' + MailApp.getRemainingDailyQuota());
}
