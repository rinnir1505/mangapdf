export type ShareResult = 'shared' | 'cancelled' | 'unsupported';

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

export function downloadPdf(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // iOS では保存処理が非同期に走るため、少し待ってから解放する
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
