import type { ImageFormat } from '../types';

/** Detects the container format from magic bytes (never trusts file names). */
export function sniffFormat(bytes: Uint8Array): ImageFormat {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return 'png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    // Compatible brands list may contain avif (e.g. "mif1" major brand).
    const boxSize = (b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!;
    for (let i = 16; i + 4 <= Math.min(boxSize, b.length); i += 4) {
      if (ascii(b, i, 4) === 'avif') return 'avif';
    }
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return 'unknown';
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = offset; i < offset + length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

export const MIME_TYPES: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  bmp: 'image/bmp',
  unknown: 'application/octet-stream',
};

export const FILE_EXTENSIONS: Record<ImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
  bmp: 'bmp',
  unknown: 'bin',
};
