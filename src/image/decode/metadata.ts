import { unzlibSync } from 'fflate';
/**
 * Minimal, allocation-light readers for container metadata that affects how
 * pixels must be interpreted (colour profiles) and for stripping metadata from
 * files that are passed through without re-encoding.
 */

/**
 * Detects an embedded ICC profile (PNG iCCP / JPEG APP2) and whether it is an
 * sRGB profile, by reading the profile's description tag (not the chunk name,
 * which is often a generic "ICC Profile").
 */
export function detectColorProfile(bytes: Uint8Array): { present: boolean; looksLikeSrgb: boolean; description?: string } {
  let profile: Uint8Array | undefined;
  const png = findPngChunk(bytes, 'iCCP');
  if (png) {
    const nul = png.indexOf(0);
    try {
      profile = unzlibSync(png.subarray(nul + 2));
    } catch {
      return { present: true, looksLikeSrgb: true };
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const parts: Uint8Array[] = [];
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1]!;
      if (marker === 0xda || marker === 0xd9) break;
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      if (marker === 0xe2 && latin1(bytes, offset + 4, 11) === 'ICC_PROFILE') {
        parts.push(bytes.subarray(offset + 18, offset + 2 + length)); // after "ICC_PROFILE\0" + seq + count
      }
      offset += 2 + length;
    }
    if (parts.length) {
      const total = parts.reduce((n, p) => n + p.length, 0);
      profile = concat(parts, total);
    }
  }
  if (!profile) return { present: false, looksLikeSrgb: true };
  const description = iccDescription(profile);
  // Unreadable descriptions are assumed sRGB rather than warning spuriously.
  const looksLikeSrgb = description === undefined || /srgb|iec\s*61966/i.test(description);
  return { present: true, looksLikeSrgb, description };
}

/** Reads the `desc` tag of an ICC profile (v2 textDescriptionType or v4 multiLocalizedUnicodeType). */
export function iccDescription(profile: Uint8Array): string | undefined {
  if (profile.length < 132) return undefined;
  const count = readU32(profile, 128);
  for (let i = 0; i < count && 132 + i * 12 + 12 <= profile.length; i++) {
    const entry = 132 + i * 12;
    if (latin1(profile, entry, 4) !== 'desc') continue;
    const offset = readU32(profile, entry + 4);
    const type = latin1(profile, offset, 4);
    if (type === 'desc') {
      const length = readU32(profile, offset + 8);
      return latin1(profile, offset + 12, Math.max(0, length - 1)).replace(/\0+$/, '');
    }
    if (type === 'mluc') {
      // mluc: 'mluc', reserved, record count, record size, then the first record
      // (language, country, byte length, offset from the tag start) — UTF-16BE text.
      const len = readU32(profile, offset + 20);
      const start = offset + readU32(profile, offset + 24);
      let text = '';
      for (let j = 0; j + 1 < len && start + j + 1 < profile.length; j += 2) {
        text += String.fromCharCode((profile[start + j]! << 8) | profile[start + j + 1]!);
      }
      return text;
    }
  }
  return undefined;
}

function findPngChunk(bytes: Uint8Array, type: string): Uint8Array | undefined {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) return undefined;
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset);
    const chunkType = latin1(bytes, offset + 4, 4);
    if (chunkType === type) return bytes.subarray(offset + 8, offset + 8 + length);
    if (chunkType === 'IDAT' || chunkType === 'IEND') return undefined;
    offset += 12 + length;
  }
  return undefined;
}

/** PNG chunks that change how pixels render and must survive metadata stripping. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT']);

/** Removes text, time, EXIF and other non-rendering chunks from a PNG. */
export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) return bytes;
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  let total = 8;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return bytes; // truncated/corrupt: leave untouched
    const type = latin1(bytes, offset + 4, 4);
    if (PNG_KEEP.has(type)) {
      parts.push(bytes.subarray(offset, end));
      total += end - offset;
    }
    offset = end;
    if (type === 'IEND') break;
  }
  return concat(parts, total);
}

/**
 * Removes EXIF/XMP/comments/thumbnails from a JPEG. Keeps JFIF (APP0), ICC
 * profiles (APP2) and Adobe colour transform info (APP14). EXIF is only removed
 * when it does not carry a non-default orientation, otherwise the image would
 * render rotated.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  if (readJpegOrientation(bytes) > 1) return bytes;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let total = 2;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return bytes;
    const marker = bytes[offset + 1]!;
    if (marker === 0xda) {
      // Start of scan: the rest is entropy-coded data.
      parts.push(bytes.subarray(offset));
      total += bytes.length - offset;
      return concat(parts, total);
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const end = offset + 2 + length;
    if (end > bytes.length) return bytes;
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keep = !isApp || marker === 0xe0 || marker === 0xe2 || marker === 0xee;
    const drop = (isApp && !keep) || marker === 0xfe;
    if (!drop) {
      parts.push(bytes.subarray(offset, end));
      total += end - offset;
    }
    offset = end;
  }
  return bytes;
}

/** EXIF orientation (1–8), 1 when absent. */
export function readJpegOrientation(bytes: Uint8Array): number {
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (marker === 0xe1 && latin1(bytes, offset + 4, 6) === 'Exif\u0000\u0000') {
      const tiff = offset + 10;
      const little = bytes[tiff] === 0x49;
      const u16 = (o: number) => (little ? bytes[o]! | (bytes[o + 1]! << 8) : (bytes[o]! << 8) | bytes[o + 1]!);
      const u32 = (o: number) =>
        little
          ? (bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24)) >>> 0
          : readU32(bytes, o);
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > bytes.length) return 1;
      const entries = u16(ifd);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > bytes.length) break;
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    offset += 2 + length;
  }
  return 1;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function latin1(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  const end = Math.min(bytes.length, offset + length);
  for (let i = offset; i < end; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
