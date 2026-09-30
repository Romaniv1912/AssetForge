import mozjpegEncFactory, { type EncodeOptions as MozJpegOptions, type MozJPEGModule as MozJpegEncoder } from '@jsquash/jpeg/codec/enc/mozjpeg_enc.js';
import mozjpegDecFactory, { type MozJPEGModule as MozJpegDecoder } from '@jsquash/jpeg/codec/dec/mozjpeg_dec.js';
import type { RgbaImage } from '../types';
import { EmscriptenSlot } from './emscripten';
import { ownedBytes, toRgbaImage } from './util';

export type { MozJpegOptions };

/**
 * MozJPEG defaults: progressive scans, optimised Huffman tables, trellis
 * quantisation and the ImageMagick quant table (index 3), which gives the best
 * perceptual rate–distortion in MozJPEG's own tuning.
 */
export const MOZJPEG_DEFAULTS: MozJpegOptions = {
  quality: 75,
  baseline: false,
  arithmetic: false,
  progressive: true,
  optimize_coding: true,
  smoothing: 0,
  color_space: 3 /* YCbCr */,
  quant_table: 3,
  trellis_multipass: false,
  trellis_opt_zero: false,
  trellis_opt_table: false,
  trellis_loops: 1,
  auto_subsample: false,
  chroma_subsample: 2,
  separate_chroma_quality: false,
  chroma_quality: 75,
};

const encoder = new EmscriptenSlot<MozJpegEncoder>(
  'mozjpeg_enc',
  async () => mozjpegEncFactory,
);
const decoder = new EmscriptenSlot<MozJpegDecoder>(
  'mozjpeg_dec',
  async () => mozjpegDecFactory,
);

/** JPEG has no alpha channel: the caller must flatten transparent images first. */
export async function encodeJpeg(image: RgbaImage, options: Partial<MozJpegOptions> = {}): Promise<Uint8Array> {
  const module = await encoder.get();
  const result = module.encode(image.data as BufferSource, image.width, image.height, { ...MOZJPEG_DEFAULTS, ...options });
  encoder.recordWork(image.width * image.height);
  if (!result) throw new Error('MozJPEG encoding failed');
  return ownedBytes(result);
}

/** Decodes a JPEG, applying the EXIF orientation like browsers do. */
export async function decodeJpeg(bytes: Uint8Array): Promise<RgbaImage> {
  const module = await decoder.get();
  const result = module.decode(bytes as BufferSource, true);
  if (!result) throw new Error('JPEG decoding failed: the file is corrupt or uses an unsupported variant');
  decoder.recordWork(result.width * result.height);
  return toRgbaImage(result);
}

export function releaseJpeg(): void {
  encoder.release();
  decoder.release();
}
