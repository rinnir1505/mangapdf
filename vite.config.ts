import { defineConfig } from 'vite';

/**
 * GitHub Pages はレスポンスヘッダを設定できないため、
 * CSP は本番ビルドの meta タグとして埋め込む。
 * 開発時は Vite の HMR が WebSocket を使うので注入しない。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'none'", // 画像もPDFも外へ出さない
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

export default defineConfig({
  // 相対パスにしておくと /mangapdf/ のようなサブパスでもそのまま動く
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  plugins: [
    {
      name: 'inject-csp',
      apply: 'build',
      // charset より後ろに置く。文字エンコーディングの宣言は head の先頭に
      // なければならないため、tags での head-prepend は使えない。
      transformIndexHtml(html: string) {
        const charset = '<meta charset="UTF-8" />';
        const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`;
        if (!html.includes(charset)) throw new Error('charset メタタグが見つかりません');
        return html.replace(charset, `${charset}\n    ${meta}`);
      },
    },
  ],
});
