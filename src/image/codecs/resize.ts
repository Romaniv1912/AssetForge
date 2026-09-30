import * as glue from '@jsquash/resize/lib/resize/pkg/squoosh_resize.js';
import type { RgbaImage } from '../types';
import { initBindgenOnce } from './wasm-bindgen';

const initResize = initBindgenOnce('resize', async () => glue.default as never);

export type ResampleFilter = 'triangle' | 'catrom' | 'mitchell' | 'lanczos3';
const FILTER_INDEX: Record<ResampleFilter, number> = { triangle: 0, catrom: 1, mitchell: 2, lanczos3: 3 };

export interface ResampleOptions {
  filter: ResampleFilter;
  /** Resample premultiplied colours so transparent pixels do not bleed into edges. */
  premultiply: boolean;
  /** Resample in linear light (gamma-correct averaging). */
  linearRGB: boolean;
}

/**
 * High-quality separable resampling (Squoosh's Rust `resize` crate compiled to
 * WebAssembly).
 */
export async function resample(
  image: RgbaImage,
  width: number,
  height: number,
  options: ResampleOptions = { filter: 'lanczos3', premultiply: true, linearRGB: true },
): Promise<RgbaImage> {
  if (width === image.width && height === image.height) return image;
  await initResize();
  const input = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const out = glue.resize(
    input,
    image.width,
    image.height,
    width,
    height,
    FILTER_INDEX[options.filter],
    options.premultiply,
    options.linearRGB,
  );
  return { width, height, data: new Uint8ClampedArray(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)) };
}
