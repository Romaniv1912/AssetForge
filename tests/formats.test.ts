import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import './helpers/setup';
import { encodeAvif, encodeJpeg, encodePng, encodeWebp } from '../src/image/codecs';
import { decodeImage } from '../src/image/decode/decode';
import { detectColorProfile, readJpegOrientation, stripJpegMetadata, stripPngMetadata } from '../src/image/decode/metadata';
import { sniffFormat } from '../src/image/decode/sniff';
import { insertExifOrientation } from './helpers/exif';
import { photoLike, transparentIllustration } from './helpers/synthetic';

describe('format detection', () => {
  it('sniffs every supported container from magic bytes', async () => {
    const image = transparentIllustration(32, 32);
    expect(sniffFormat(await encodePng(image))).toBe('png');
    expect(sniffFormat(await encodeJpeg(photoLike(32, 32)))).toBe('jpeg');
    expect(sniffFormat(await encodeWebp(image))).toBe('webp');
    expect(sniffFormat(await encodeAvif(image, { speed: 9 }))).toBe('avif');
    expect(sniffFormat(new TextEncoder().encode('GIF89a......'))).toBe('gif');
    expect(sniffFormat(new Uint8Array([1, 2, 3]))).toBe('unknown');
  });

  it('rejects unknown and corrupt data with a clear error', async () => {
    await expect(decodeImage(new Uint8Array([0, 1, 2, 3, 4, 5]))).rejects.toThrow(/Unrecognised image format/);
    const png = await encodePng(transparentIllustration(64, 64));
    await expect(decodeImage(png.slice(0, 60))).rejects.toThrow();
  });

  it('explains that GIF needs a platform decoder when none is available', async () => {
    await expect(decodeImage(new TextEncoder().encode('GIF89a\u0001\u0000\u0001\u0000'))).rejects.toThrow(/GIF images cannot be decoded/);
  });
});

describe('metadata', () => {
  it('strips ancillary PNG chunks but keeps rendering chunks', async () => {
    const png = await encodePng(transparentIllustration(16, 16));
    const withText = insertPngChunk(png, 'tEXt', new TextEncoder().encode('Comment\u0000secret metadata'));
    expect(withText.length).toBeGreaterThan(png.length);
    const stripped = stripPngMetadata(withText);
    expect(stripped.length).toBe(png.length);
    expect((await decodeImage(stripped)).image.width).toBe(16);
  });

  it('strips JPEG metadata unless it carries a rotation', async () => {
    const jpeg = await encodeJpeg(photoLike(24, 16), { quality: 80 });
    const withExif = insertExifOrientation(jpeg, 1);
    expect(stripJpegMetadata(withExif).length).toBe(jpeg.length);
    const rotated = insertExifOrientation(jpeg, 6);
    expect(readJpegOrientation(rotated)).toBe(6);
    expect(stripJpegMetadata(rotated)).toBe(rotated);
  });

  it('detects embedded colour profiles', async () => {
    const png = await encodePng(transparentIllustration(8, 8));
    expect(detectColorProfile(png).present).toBe(false);
    const name = new TextEncoder().encode('ICC Profile\u0000\u0000');
    const compressed = zlibSync(minimalIccProfile('Display P3'));
    const chunk = new Uint8Array(name.length + compressed.length);
    chunk.set(name);
    chunk.set(compressed, name.length);
    const withP3 = insertPngChunk(png, 'iCCP', chunk);
    expect(detectColorProfile(withP3)).toMatchObject({ present: true, looksLikeSrgb: false, description: 'Display P3' });
  });
});

function insertPngChunk(png: Uint8Array, type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const ihdrEnd = 8 + 25; // signature + IHDR chunk
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, ihdrEnd));
  out.set(chunk, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('colour profile descriptions', () => {
  it('recognises the sRGB profile inside a compressed PNG iCCP chunk', async () => {
    const { fixture } = await import('./helpers/setup');
    expect(detectColorProfile(fixture('chelsea.png'))).toMatchObject({ present: true, looksLikeSrgb: true });
  });

  it('flags a real non-sRGB profile (Adobe RGB JPEG)', async () => {
    const { fixture } = await import('./helpers/setup');
    expect(detectColorProfile(fixture('rocket.jpg'))).toMatchObject({ present: true, looksLikeSrgb: false, description: 'Adobe RGB (1998)' });
  });
});

/** ICC profile with only a v2 `desc` tag — enough for description parsing. */
function minimalIccProfile(description: string): Uint8Array {
  const text = new TextEncoder().encode(description);
  const tagOffset = 144;
  const tagSize = 12 + text.length + 1;
  const out = new Uint8Array(tagOffset + tagSize);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  out.set(new TextEncoder().encode('RGB XYZ '), 16);
  view.setUint32(128, 1);
  out.set(new TextEncoder().encode('desc'), 132);
  view.setUint32(136, tagOffset);
  view.setUint32(140, tagSize);
  out.set(new TextEncoder().encode('desc'), tagOffset);
  view.setUint32(tagOffset + 8, text.length + 1);
  out.set(text, tagOffset + 12);
  return out;
}
