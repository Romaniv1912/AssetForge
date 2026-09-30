import * as pngGlue from '@jsquash/png/codec/pkg/squoosh_png.js';
import * as oxipngGlue from '@jsquash/oxipng/codec/pkg/squoosh_oxipng.js';
import type { RgbaImage } from '../types';
import { initBindgenOnce } from './wasm-bindgen';
import { ownedBytes, toRgbaImage } from './util';


const initPng = initBindgenOnce('png', async () => pngGlue.default as never);

/**
 * oxipng is loaded from the single-threaded build: its parallel build relies on
 * wasm-bindgen-rayon, which needs SharedArrayBuffer (unavailable in Figma).
 */
const initOxipng = initBindgenOnce('oxipng', async () => oxipngGlue.default as never);

/** Plain (unoptimised) RGBA PNG. Use `optimisePngRaw` for production output. */
export async function encodePng(image: RgbaImage): Promise<Uint8Array> {
  await initPng();
  const bytes = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return ownedBytes(pngGlue.encode(bytes, image.width, image.height, 8));
}

export async function decodePng(bytes: Uint8Array): Promise<RgbaImage> {
  await initPng();
  const result = pngGlue.decode(bytes);
  if (!result) throw new Error('PNG decoding failed: the file is corrupt');
  return toRgbaImage(result);
}

export interface OxipngOptions {
  /** 0–6; higher tries more filter/deflate combinations. */
  level: number;
  interlace: boolean;
  /** Clear the colour of fully transparent pixels so they compress better (visually lossless). */
  optimiseAlpha: boolean;
}

export const OXIPNG_DEFAULTS: OxipngOptions = { level: 3, interlace: false, optimiseAlpha: true };

/**
 * Encodes raw RGBA with oxipng. oxipng performs lossless colour-type and
 * bit-depth reduction (RGBA → RGB / grey / palette when possible), tries all
 * PNG filter strategies and recompresses the DEFLATE stream.
 */
export async function optimisePngRaw(image: RgbaImage, options: Partial<OxipngOptions> = {}): Promise<Uint8Array> {
  await initOxipng();
  const o = { ...OXIPNG_DEFAULTS, ...options };
  return ownedBytes(oxipngGlue.optimise_raw(image.data, image.width, image.height, o.level, o.interlace, o.optimiseAlpha));
}

/** Losslessly re-optimises an existing PNG file. */
export async function optimisePngFile(bytes: Uint8Array, options: Partial<OxipngOptions> = {}): Promise<Uint8Array> {
  await initOxipng();
  const o = { ...OXIPNG_DEFAULTS, ...options };
  return ownedBytes(oxipngGlue.optimise(bytes, o.level, o.interlace, o.optimiseAlpha));
}
