/**
 * 画像専用の最小 PDF ライタ。
 *
 * pdf-lib を使わない理由:
 *  - save() が PDF 全体を 1 本の連続バッファへ展開するため、
 *    大きな原稿では瞬間的に約 2 倍のメモリを要求する。
 *  - ここでは書き出しながら一定量ごとに Blob へ退避するので、
 *    メモリ使用量が FLUSH_BYTES 前後に張り付いたまま増えない。
 *  - JPEG を Blob のまま渡せる（File をそのまま追記できる）ので、
 *    再圧縮しないページは画素データを一度も JS ヒープに載せない。
 */

import { yieldToUI } from './schedule';

const encoder = new TextEncoder();

/** この量たまったら Blob へ退避する（ブラウザがディスクへ逃がせる） */
const FLUSH_BYTES = 16 * 1024 * 1024;

export interface PdfImagePage {
  /** JPEG のバイト列。File/Blob を渡すとコピーせずそのまま埋め込む */
  data: Blob | Uint8Array<ArrayBuffer>;
  byteLength: number;
  /** JPEG ヘッダ上の画素数 */
  width: number;
  height: number;
  /** 1 = DeviceGray, 3 = DeviceRGB */
  components: number;
}

export interface WriteOptions {
  /** 長辺の物理サイズ（pt）。B5 短辺 182mm なら 516、長辺 257mm なら 728.5 */
  longEdgePt: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

export async function writeImagePdf(
  total: number,
  produce: (index: number) => Promise<PdfImagePage>,
  options: WriteOptions,
): Promise<Blob> {
  if (total < 1) throw new Error('ページがありません');

  const flushed: Blob[] = [];
  let pending: BlobPart[] = [];
  let pendingBytes = 0;
  let offset = 0;
  const objectOffsets = new Map<number, number>();

  const put = (data: string | Uint8Array<ArrayBuffer> | Blob, byteLength?: number) => {
    let part: BlobPart;
    let size: number;
    if (typeof data === 'string') {
      const bytes = encoder.encode(data);
      part = bytes;
      size = bytes.byteLength;
    } else if (data instanceof Blob) {
      part = data;
      size = byteLength ?? data.size;
    } else {
      part = data;
      size = data.byteLength;
    }
    pending.push(part);
    pendingBytes += size;
    offset += size;
  };

  const flush = () => {
    if (!pending.length) return;
    flushed.push(new Blob(pending));
    pending = [];
    pendingBytes = 0;
  };

  const beginObject = (id: number) => {
    objectOffsets.set(id, offset);
    put(`${id} 0 obj\n`);
  };

  // オブジェクト番号は事前に確定させる（/Kids を先に書くため）
  const pageId = (i: number) => 3 + i * 3;
  const imageId = (i: number) => 4 + i * 3;
  const contentId = (i: number) => 5 + i * 3;
  const infoId = 3 + total * 3;
  const maxId = infoId;

  // ヘッダ。2 行目のバイナリコメントで「テキストではない」と宣言する
  put(new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a,
    0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a,
  ]));

  beginObject(1);
  put('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObject(2);
  const kids = Array.from({ length: total }, (_, i) => `${pageId(i)} 0 R`).join(' ');
  put(`<< /Type /Pages /Count ${total} /Kids [ ${kids} ] >>\nendobj\n`);

  for (let i = 0; i < total; i++) {
    if (options.signal?.aborted) throw new AbortError();

    const image = await produce(i);
    if (options.signal?.aborted) throw new AbortError();

    const scale = options.longEdgePt / Math.max(image.width, image.height);
    const pageW = round(image.width * scale);
    const pageH = round(image.height * scale);

    beginObject(pageId(i));
    put(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}]` +
      ` /Resources << /XObject << /Im0 ${imageId(i)} 0 R >>` +
      ` /ProcSet [/PDF /ImageB /ImageC] >>` +
      ` /Contents ${contentId(i)} 0 R >>\nendobj\n`,
    );

    const colorSpace = image.components === 1 ? '/DeviceGray' : '/DeviceRGB';
    beginObject(imageId(i));
    put(
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height}` +
      ` /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode` +
      ` /Length ${image.byteLength} >>\nstream\n`,
    );
    put(image.data, image.byteLength);
    put('\nendstream\nendobj\n');

    const content = `q\n${pageW} 0 0 ${pageH} 0 0 cm\n/Im0 Do\nQ\n`;
    const contentBytes = encoder.encode(content);
    beginObject(contentId(i));
    put(`<< /Length ${contentBytes.byteLength} >>\nstream\n`);
    put(contentBytes);
    put('\nendstream\nendobj\n');

    if (pendingBytes >= FLUSH_BYTES) flush();

    options.onProgress?.(i + 1, total);
    await yieldToUI();
  }

  beginObject(infoId);
  put(`<< /Producer (まんがPDF) /CreationDate (${pdfDate(new Date())}) >>\nendobj\n`);

  const xrefOffset = offset;
  const size = maxId + 1;
  put(`xref\n0 ${size}\n`);
  put('0000000000 65535 f\r\n'); // 各エントリはちょうど 20 バイト
  for (let id = 1; id <= maxId; id++) {
    const at = objectOffsets.get(id) ?? 0;
    put(`${at.toString().padStart(10, '0')} 00000 n\r\n`);
  }
  put(
    `trailer\n<< /Size ${size} /Root 1 0 R /Info ${infoId} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`,
  );

  flush();
  return new Blob(flushed, { type: 'application/pdf' });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  return (
    `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}'${p(abs % 60)}'`
  );
}
