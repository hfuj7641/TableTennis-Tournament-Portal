/**
 * 卓球大会ポータル - 独自ドメイン用 Cloudflare Worker
 *
 * 独自ドメイン（例: https://portal.example.com/）にアクセスすると、
 * Google Apps Script のウェブアプリを全画面の iframe で表示するページを返す。
 * アドレスバーは独自ドメインのまま。?t=大会ID などのパラメータはそのまま引き継ぐ。
 *
 * 設定（wrangler.toml の [vars]、またはダッシュボードの「設定 → 変数」）:
 *   GAS_URL    : Apps Script のウェブアプリの URL（…/exec）
 *   SITE_TITLE : ページのタイトル（共有時のタイトルにもなる）
 *   SITE_DESC  : 共有時の説明文（任意）
 *   OG_IMAGE   : 共有時の画像の URL（任意）
 */

const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbw8GYM-5psJbPkUbT-iPN7x2L-E76JqAHlGUSY7R6P6uVG8zaMRpfe42PumgcL6ZYE5dg/exec';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const gasUrl = (env && env.GAS_URL) || DEFAULT_GAS_URL;
    const title = (env && env.SITE_TITLE) || '卓球大会ポータル';
    const desc = (env && env.SITE_DESC) || '卓球大会のリーグ戦・トーナメントの試合結果ポータル';
    const image = (env && env.OG_IMAGE) || '';

    if (url.pathname === '/favicon.ico') {
      // 卓球の絵文字をアイコンに
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🏓</text></svg>';
      return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
    }
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow:\n', { headers: { 'content-type': 'text/plain' } });
    }
    if (url.pathname !== '/') {
      // パスは使わない（大会の指定は ?t=大会ID）。トップへ転送
      return Response.redirect(url.origin + '/' + url.search, 302);
    }

    const target = new URL(gasUrl);
    url.searchParams.forEach((v, k) => target.searchParams.set(k, v));

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
        'cache-control': 'public, max-age=300',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
      },
    });
  },
};
