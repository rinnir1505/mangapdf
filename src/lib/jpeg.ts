/**
 * JPEG ヘッダのみを読む軽量パーサ。
 * 画素データをデコードしないので、巨大画像でもメモリをほとんど使わない。
 */

export interface JpegInfo {
  /** ファイルに記録されている幅（EXIF回転前） */
  width: number;
  /** ファイルに記録されている高さ（EXIF回転前） */
  height: number;
  /** 1=グレースケール, 3=RGB(YCbCr), 4=CMYK */
  components: number;
  /** EXIF Orientation (1-8)。1 または EXIF 無しなら 1 */
  orientation: number;
}

/** EXIF の回転を適用した、実際に表示される向きの寸法 */
export function displaySize(info: JpegInfo): { width: number; height: number } {
  return info.orientation >= 5 && info.orientation <= 8
    ? { width: info.height, height: info.width }
    : { width: info.width, height: info.height };
}

/** 再エンコードせずにそのまま PDF へ埋め込めるか */
export function canEmbedDirectly(info: JpegInfo): boolean {
  // CMYK は PDF 側の色変換が環境依存になるため必ず再エンコードする。
  // EXIF 回転は DCTDecode では再現できないのでデコードが必要。
  return info.orientation === 1 && (info.components === 1 || info.components === 3);
}

export async function readJpegInfo(file: File): Promise<JpegInfo | null> {
  // EXIF にサムネイルが埋まっていると SOF が後方へずれるため段階的に読む
  let limit = Math.min(file.size, 128 * 1024);
  const max = Math.min(file.size, 8 * 1024 * 1024);

  for (;;) {
    const buf = await file.slice(0, limit).arrayBuffer();
    const info = parse(new DataView(buf));
    if (info) return info;
    if (limit >= max) return null;
    limit = Math.min(limit * 4, max);
  }
}

function parse(view: DataView): JpegInfo | null {
  if (view.byteLength < 4) return null;
  if (view.getUint16(0) !== 0xffd8) return null; // SOI ではない

  let offset = 2;
  let orientation = 1;

  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) {
      offset++; // パディング / 破損。次のマーカーを探す
      continue;
    }
    const marker = view.getUint8(offset + 1);

    // 長さフィールドを持たないマーカー
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // EOI / SOS 以降に SOF は現れない
    if (marker === 0xd9 || marker === 0xda) return null;

    const length = view.getUint16(offset + 2);
    if (length < 2) return null;

    const isSOF =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isSOF) {
      if (offset + 10 > view.byteLength) return null; // 読み足りない
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
        components: view.getUint8(offset + 9),
        orientation,
      };
    }

    if (marker === 0xe1) {
      const found = readExifOrientation(view, offset + 4);
      if (found) orientation = found;
    }

    offset += 2 + length;
  }
  return null;
}

function readExifOrientation(view: DataView, start: number): number | null {
  if (start + 8 > view.byteLength) return null;
  // "Exif\0\0"
  if (view.getUint32(start) !== 0x45786966) return null;
  if (view.getUint16(start + 4) !== 0x0000) return null;

  const tiff = start + 6;
  if (tiff + 8 > view.byteLength) return null;

  const bom = view.getUint16(tiff);
  const little = bom === 0x4949;
  if (!little && bom !== 0x4d4d) return null;
  if (view.getUint16(tiff + 2, little) !== 0x002a) return null;

  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > view.byteLength) return null;

  const entries = view.getUint16(ifd, little);
  for (let i = 0; i < entries; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > view.byteLength) return null;
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}
