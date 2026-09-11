import {
  QUALITY_PRESETS,
  SAFE_CANVAS_AREA,
  SAFE_CANVAS_SIDE,
  THUMB_MAX_EDGE,
  type QualityMode,
} from '../config';
import { canEmbedDirectly, displaySize, type JpegInfo } from './jpeg';
import type { PdfImagePage } from './pdfWriter';

/**
 * PDF へ入れる 1 ページ分のデータを用意する。
 *
 * 再圧縮が不要なページは File をそのまま返すので、
 * 画素データが JS ヒープに載らない（= 速くてメモリを使わない）。
 */
export async function prepareForPdf(
  file: File,
  info: JpegInfo,
  mode: QualityMode,
): Promise<PdfImagePage> {
  const preset = QUALITY_PRESETS[mode];
  const display = displaySize(info);
  const longEdge = Math.max(display.width, display.height);

  if (canEmbedDirectly(info) && longEdge <= preset.maxEdge) {
    return {
      data: file,
      byteLength: file.size,
      width: info.width,
      height: info.height,
      components: info.components,
    };
  }

  const scale = Math.min(1, preset.maxEdge / longEdge);
  const target = clampToCanvas(
    Math.max(1, Math.round(display.width * scale)),
    Math.max(1, Math.round(display.height * scale)),
  );

  const blob = await renderJpeg(file, target.width, target.height, preset.quality);
  return {
    data: blob,
    byteLength: blob.size,
    width: target.width,
    height: target.height,
    components: 3, // Canvas の出力は常に RGB
  };
}

/** 一覧用の小さなサムネイルを作る。戻り値の Object URL は呼び出し側が解放する */
export async function makeThumbnail(file: File, info: JpegInfo): Promise<string> {
  const display = displaySize(info);
  const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(display.width, display.height));
  const width = Math.max(1, Math.round(display.width * scale));
  const height = Math.max(1, Math.round(display.height * scale));
  const blob = await renderJpeg(file, width, height, 0.8);
  return URL.createObjectURL(blob);
}

function clampToCanvas(width: number, height: number): { width: number; height: number } {
  let w = width;
  let h = height;

  const sideScale = Math.min(1, SAFE_CANVAS_SIDE / Math.max(w, h));
  if (sideScale < 1) {
    w = Math.max(1, Math.floor(w * sideScale));
    h = Math.max(1, Math.floor(h * sideScale));
  }

  const area = w * h;
  if (area > SAFE_CANVAS_AREA) {
    const areaScale = Math.sqrt(SAFE_CANVAS_AREA / area);
    w = Math.max(1, Math.floor(w * areaScale));
    h = Math.max(1, Math.floor(h * areaScale));
  }
  return { width: w, height: h };
}

/**
 * 縮小しながらデコードして JPEG へ再エンコードする。
 * createImageBitmap に寸法を渡すことで、原寸の Canvas を作らずに済む。
 */
async function renderJpeg(
  file: File,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  let bitmap: ImageBitmap | null = null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    bitmap = await createImageBitmap(file, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
      imageOrientation: 'from-image',
    });

    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('画像を処理できませんでした');

    // 透過 PNG などが混ざっても黒くならないよう白で下地を塗る
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    // resizeWidth が無視される環境でも drawImage 側で確実に縮小する
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas!.toBlob(resolve, 'image/jpeg', quality),
    );
    if (!blob) throw new Error('画像を変換できませんでした');
    return blob;
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
