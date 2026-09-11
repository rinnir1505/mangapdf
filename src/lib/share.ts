export type ShareResult = 'shared' | 'cancelled' | 'unsupported';

/** 保存ボタンが実際に何をしたか。案内文を切り替えるのに使う */
export type SaveResult = 'downloaded' | 'opened' | 'blocked';

export function isIOS(): boolean {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS は既定で Mac を名乗るため、タッチの有無で見分ける
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/**
 * LINE などのアプリ内ブラウザ（WebView）で開かれていないか調べる。
 *
 * WebView はファイルのダウンロードができず、共有 API も使えないことが多い。
 * 「プレビューは出るのに保存できない」という状態になるため、
 * 気づけるように名前を返す。通常のブラウザなら null。
 */
export function inAppBrowserName(): string | null {
  const ua = navigator.userAgent;
  if (/\bLine\//i.test(ua)) return 'LINE';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'Facebook';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/\bTwitter/i.test(ua)) return 'X';
  // iOS で Safari を名乗らないものは WebView とみなす
  if (isIOS() && !/Safari\//.test(ua)) return 'アプリ内ブラウザ';
  return null;
}

export function canSharePdf(): boolean {
  return typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
}

/**
 * 共有シートを開く。
 * navigator.share はユーザー操作から同期的に呼ぶ必要があるため、
 * この関数はクリックハンドラから直接呼び、先に await を挟まないこと。
 */
export async function sharePdf(blob: Blob, fileName: string): Promise<ShareResult> {
  if (!canSharePdf()) return 'unsupported';

  const file = new File([blob], fileName, { type: 'application/pdf' });
  if (!navigator.canShare({ files: [file] })) return 'unsupported';

  try {
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (error) {
    // 共有シートを閉じただけならエラー扱いにしない
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    return 'unsupported';
  }
}

/**
 * PDF を保存する。URL は呼び出し側が保持しているものを使う。
 *
 * iOS Safari は <a download> を無視して同じタブで PDF を開く。
 * するとアプリのページが破棄され、そのページに紐づく Blob URL ごと
 * 無効になるため、プレビューは出るのに保存できないという状態になる。
 * iOS では最初から別タブで開き、元のページを生かしておく。
 */
export function savePdf(url: string, fileName: string): SaveResult {
  if (isIOS()) {
    const opened = window.open(url, '_blank');
    return opened ? 'opened' : 'blocked';
  }

  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  // Safari は click 直後に要素を外すとダウンロードが中断されることがある
  setTimeout(() => link.remove(), 2000);
  return 'downloaded';
}
