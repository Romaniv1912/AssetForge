import webpEncFactory, { type EncodeOptions as WebpOptions, type WebPModule as WebpEncoder } from '@jsquash/webp/codec/enc/webp_enc.js';
import webpEncSimdFactory from '@jsquash/webp/codec/enc/webp_enc_simd.js';
import webpDecFactory, { type WebPModule as WebpDecoder } from '@jsquash/webp/codec/dec/webp_dec.js';
import { simd } from 'wasm-feature-detect';
import type { RgbaImage } from '../types';
import { EmscriptenSlot } from './emscripten';
import { ownedBytes, toRgbaImage } from './util';

export type { WebpOptions };

/** libwebp `WebPConfig` defaults (see encode.h). */
export const LIBWEBP_DEFAULTS: WebpOptions = {
  quality: 75,
  target_size: 0,
  target_PSNR: 0,
  method: 4,
  sns_strength: 50,
  filter_strength: 60,
  filter_sharpness: 0,
  filter_type: 1,
  partitions: 0,
  segments: 4,
  pass: 1,
  show_compressed: 0,
  preprocessing: 0,
  autofilter: 0,
  partition_limit: 0,
  alpha_compression: 1,
  alpha_filtering: 1,
  alpha_quality: 100,
  lossless: 0,
  exact: 0,
  image_hint: 0,
  emulate_jpeg_size: 0,
  thread_level: 0,
  low_memory: 0,
  near_lossless: 100,
  use_delta_palette: 0,
  use_sharp_yuv: 0,
};

let simdSupported: Promise<boolean> | undefined;

const encoderSimd = new EmscriptenSlot<WebpEncoder>(
  'webp_enc_simd',
  async () => webpEncSimdFactory,
);
const encoderScalar = new EmscriptenSlot<WebpEncoder>(
  'webp_enc',
  async () => webpEncFactory,
);
const decoder = new EmscriptenSlot<WebpDecoder>(
  'webp_dec',
  async () => webpDecFactory,
);

async function encoderSlot(): Promise<EmscriptenSlot<WebpEncoder>> {
  simdSupported ??= simd().catch(() => false);
  return (await simdSupported) ? encoderSimd : encoderScalar;
}

export async function encodeWebp(image: RgbaImage, options: Partial<WebpOptions> = {}): Promise<Uint8Array> {
  const slot = await encoderSlot();
  const module = await slot.get();
  const result = module.encode(image.data as BufferSource, image.width, image.height, { ...LIBWEBP_DEFAULTS, ...options });
  slot.recordWork(image.width * image.height);
  if (!result) throw new Error('libwebp encoding failed');
  return ownedBytes(result);
}

export async function decodeWebp(bytes: Uint8Array): Promise<RgbaImage> {
  const module = await decoder.get();
  const result = module.decode(bytes as BufferSource);
  if (!result) throw new Error('WebP decoding failed: the file is corrupt or animated');
  decoder.recordWork(result.width * result.height);
  return toRgbaImage(result);
}

export function releaseWebp(): void {
  encoderSimd.release();
  encoderScalar.release();
  decoder.release();
}
