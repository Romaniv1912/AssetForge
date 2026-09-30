import avifEncFactory, { type EncodeOptions as AvifOptions, type AVIFModule as AvifEncoder } from '@jsquash/avif/codec/enc/avif_enc.js';
import avifDecFactory, { type AVIFModule as AvifDecoder } from '@jsquash/avif/codec/dec/avif_dec.js';
import type { RgbaImage } from '../types';
import { EmscriptenSlot } from './emscripten';
import { ownedBytes, toRgbaImage } from './util';

export type { AvifOptions };

export const AVIF_DEFAULTS: AvifOptions = {
  quality: 50,
  qualityAlpha: -1,
  denoiseLevel: 0,
  tileColsLog2: 0,
  tileRowsLog2: 0,
  speed: 6,
  subsample: 1,
  chromaDeltaQ: false,
  sharpness: 0,
  tune: 0 /* auto */,
  enableSharpYUV: false,
  bitDepth: 8,
};

/**
 * The single-threaded libavif/aom build is used on purpose: the multi-threaded
 * build needs SharedArrayBuffer, which requires cross-origin isolation that a
 * Figma plugin iframe (opaque origin) cannot provide.
 */
const encoder = new EmscriptenSlot<AvifEncoder>(
  'avif_enc',
  async () => avifEncFactory,
  24_000_000,
);
const decoder = new EmscriptenSlot<AvifDecoder>(
  'avif_dec',
  async () => avifDecFactory,
);

export async function encodeAvif(image: RgbaImage, options: Partial<AvifOptions> = {}): Promise<Uint8Array> {
  const module = await encoder.get();
  const result = module.encode(
    new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength) as BufferSource,
    image.width,
    image.height,
    { ...AVIF_DEFAULTS, ...options },
  );
  encoder.recordWork(image.width * image.height);
  if (!result) throw new Error('libavif encoding failed');
  return ownedBytes(result);
}

export async function decodeAvif(bytes: Uint8Array): Promise<RgbaImage> {
  const module = await decoder.get();
  const result = module.decode(bytes as BufferSource, 8);
  if (!result) throw new Error('AVIF decoding failed: the file is corrupt or unsupported');
  decoder.recordWork(result.width * result.height);
  return toRgbaImage(result as ImageData);
}

export function releaseAvif(): void {
  encoder.release();
  decoder.release();
}
