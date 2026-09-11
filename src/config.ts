/**
 * 実機検証で調整する定数をここに集約する。
 */

export const APP_NAME = 'まんがPDF';

/** PDF の 1 ページ長辺の物理サイズ。B5 長辺 = 257mm */
export const PAGE_LONG_EDGE_MM = 257;
export const PAGE_LONG_EDGE_PT = (PAGE_LONG_EDGE_MM / 25.4) * 72;

/** 推奨する最大ページ数 */
export const MAX_PAGES = 50;

/** サムネイルの長辺（CSS px の約 2 倍にしておくと Retina でも粗くならない） */
export const THUMB_MAX_EDGE = 220;

/**
 * Canvas の安全上限。iOS Safari は端末メモリに応じて上限が変わり、
 * 超えると例外を出さずに真っ白な描画結果を返すことがある。
 */
export const SAFE_CANVAS_AREA = 16_000_000;
export const SAFE_CANVAS_SIDE = 8192;

/** この容量を超えたら分割を提案する */
export const SPLIT_SUGGEST_BYTES = 400 * 1024 * 1024;

export type QualityMode = 'original' | 'high' | 'share';

export interface QualityPreset {
  label: string;
  note: string;
  /** 長辺がこれ以下なら再圧縮しない */
  maxEdge: number;
  /** 再圧縮するときの JPEG 品質 */
  quality: number;
}

export const QUALITY_PRESETS: Record<QualityMode, QualityPreset> = {
  original: {
    label: '原寸',
    note: '劣化なし・最速。容量は大きい',
    maxEdge: Number.POSITIVE_INFINITY,
    quality: 1,
  },
  high: {
    label: '高画質',
    note: '印刷にも使える。容量は中くらい',
    maxEdge: 3000,
    quality: 0.92,
  },
  share: {
    label: '共有用',
    note: '軽くて送りやすい。画面で読む用',
    maxEdge: 2048,
    quality: 0.85,
  },
};

export const QUALITY_ORDER: QualityMode[] = ['original', 'high', 'share'];
