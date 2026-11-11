/**
 * 卓球大会ポータル - 独自ドメイン用 Cloudflare Worker
 *
 * 独自ドメイン（例: https://portal.example.com/）にアクセスすると、
 * Google Apps Script のウェブアプリを全画面の iframe で表示するページを返す。
 * アドレスバーは独自ドメインのまま。?t=大会ID などのパラメータはそのまま引き継ぐ。
 *
 * アクセスログ:
 *   - ページを開くたびに、日時・IPアドレス・国/地域・ブラウザ・URL を記録する
 *   - Workers Logs（Cloudflare の画面で検索。無料プランは3日間）には常に出力
 *   - D1 データベース（バインド名 ACCESS_DB）を設定すると、長期保存する
 *     https://独自ドメイン/__access-log.csv?key=LOG_VIEW_KEY&days=7 で CSV をダウンロードできる
 *
 * 更新ログ（アプリの「更新ログ」シート）への IP アドレスの記録:
 *   - LOG_SECRET を設定すると、「IPアドレス|時刻」に署名を付けてアプリに渡す
 *   - アプリ側（大会の作成・管理 →「アクセスログ連携キー」）にも同じ値を設定する
 *
 * 設定（ダッシュボードの「設定 → 変数とシークレット」、または wrangler.toml）:
 *   GAS_URL      : Apps Script のウェブアプリの URL（…/exec）
 *   SITE_TITLE   : ページのタイトル（共有時のタイトルにもなる）
 *   SITE_DESC    : 共有時の説明文（任意）
 *   OG_IMAGE     : 共有時の画像の URL（任意）
 *   LOG_SECRET   : 更新ログ用の署名キー（シークレット。任意）
 *   LOG_VIEW_KEY : アクセスログの CSV をダウンロードするためのキー（シークレット。任意）
 *   ACCESS_DB    : D1 データベースのバインド（任意）
 */

const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbw8GYM-5psJbPkUbT-iPN7x2L-E76JqAHlGUSY7R6P6uVG8zaMRpfe42PumgcL6ZYE5dg/exec';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 「IPアドレス|UNIX秒」に HMAC-SHA256 の署名を付ける（base64url(本文) + "." + 署名の16進） */
async function signAccess(secret, ip) {
  const enc = new TextEncoder();
  const payload = ip + '|' + Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
  const hex = Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_');
  return b64 + '.' + hex;
}

function accessInfo(request, url) {
  const cf = request.cf || {};
  return {
    ts: new Date().toISOString(),
    ip: request.headers.get('CF-Connecting-IP') || '',
    country: cf.country || '',
    region: cf.region || '',
    city: cf.city || '',
    ua: (request.headers.get('User-Agent') || '').slice(0, 300),
    url: url.pathname + url.search,
    tid: url.searchParams.get('t') || '',
    referer: (request.headers.get('Referer') || '').slice(0, 300),
  };
}

let tableReady = null;
function ensureTable(db) {
  if (!tableReady) {
    tableReady = db.prepare(
      'CREATE TABLE IF NOT EXISTS access_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, ip TEXT, country TEXT, region TEXT, city TEXT, ua TEXT, url TEXT, tid TEXT, referer TEXT)'
    ).run().catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

async function saveAccess(db, a) {
  await ensureTable(db);
  await db.prepare('INSERT INTO access_log (ts, ip, country, region, city, ua, url, tid, referer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(a.ts, a.ip, a.country, a.region, a.city, a.ua, a.url, a.tid, a.referer).run();
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s; // 表計算ソフトで数式と解釈されないように
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

function toJst(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** アクセスログの CSV（Excel で開けるよう BOM 付き UTF-8） */
async function exportCsv(env, url) {
  if (!env.ACCESS_DB || !env.LOG_VIEW_KEY) return new Response('アクセスログ（D1）が設定されていません。', { status: 404 });
  if (url.searchParams.get('key') !== env.LOG_VIEW_KEY) return new Response('キーが違います。', { status: 403 });
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 366);
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  await ensureTable(env.ACCESS_DB);
  const { results } = await env.ACCESS_DB.prepare(
    'SELECT ts, ip, country, region, city, ua, url, tid, referer FROM access_log WHERE ts >= ? ORDER BY id DESC LIMIT 100000'
  ).bind(since).all();
  const head = ['日時(JST)', 'IPアドレス', '国', '地域', '都市', 'ブラウザ', 'URL', '大会ID', '参照元'];
  const lines = [head.join(',')].concat((results || []).map((r) =>
    [toJst(r.ts), r.ip, r.country, r.region, r.city, r.ua, r.url, r.tid, r.referer].map(csvCell).join(',')));
  return new Response('﻿' + lines.join('\r\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="access-log-' + new Date().toISOString().slice(0, 10) + '.csv"',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    env = env || {};
    const url = new URL(request.url);
    const gasUrl = env.GAS_URL || DEFAULT_GAS_URL;
    const title = env.SITE_TITLE || '卓球大会ポータル';
    const desc = env.SITE_DESC || '卓球大会のリーグ戦・トーナメントの試合結果ポータル';
    const image = env.OG_IMAGE || '';

    if (url.pathname === '/favicon.ico') {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🏓</text></svg>';
      return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
    }
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow:\n', { headers: { 'content-type': 'text/plain' } });
    }
    if (url.pathname === '/__access-log.csv') {
      return exportCsv(env, url);
    }
    if (url.pathname !== '/') {
      // パスは使わない（大会の指定は ?t=大会ID）。トップへ転送
      return Response.redirect(url.origin + '/' + url.search, 302);
    }

    // アクセスログ
    const a = accessInfo(request, url);
    console.log(JSON.stringify(Object.assign({ type: 'access' }, a))); // Workers Logs
    if (env.ACCESS_DB && ctx && ctx.waitUntil) {
      ctx.waitUntil(saveAccess(env.ACCESS_DB, a).catch((e) => console.error('access log save failed: ' + e)));
    }

    const target = new URL(gasUrl);
    url.searchParams.forEach((v, k) => { if (k !== 'cfp') target.searchParams.set(k, v); });
    if (env.LOG_SECRET && a.ip) target.searchParams.set('cfp', await signAccess(env.LOG_SECRET, a.ip));

    const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url.toString())}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<link rel="icon" href="/favicon.ico" type="image/svg+xml">
<meta name="theme-color" content="#f4f6f9">
<style>
  html, body { margin: 0; height: 100%; background: #f4f6f9; overflow: hidden; }
  iframe { display: block; border: 0; width: 100%; height: 100vh; height: 100dvh; }
  .loading { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; font-family: -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; color: #667085; z-index: -1; }
</style>
</head>
<body>
<div class="loading">読み込み中…</div>
<iframe src="${esc(target.toString())}" title="${esc(title)}" allow="clipboard-write" referrerpolicy="no-referrer-when-downgrade"></iframe>
</body>
</html>`;
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // 署名付きの値を含むので、共有キャッシュには置かない
        'cache-control': env.LOG_SECRET ? 'private, no-store' : 'public, max-age=300',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
      },
    });
  },
};
