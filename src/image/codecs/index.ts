export * from './wasm-provider';
export { encodeJpeg, decodeJpeg, MOZJPEG_DEFAULTS, type MozJpegOptions } from './jpeg';
export { encodeWebp, decodeWebp, LIBWEBP_DEFAULTS, type WebpOptions } from './webp';
export { encodeAvif, decodeAvif, AVIF_DEFAULTS, type AvifOptions } from './avif';
export { encodePng, decodePng, optimisePngRaw, optimisePngFile, OXIPNG_DEFAULTS, type OxipngOptions } from './png';
export { resample, type ResampleOptions, type ResampleFilter } from './resize';

import { releaseAvif } from './avif';
import { releaseJpeg } from './jpeg';
import { releaseWebp } from './webp';

/** Drops every re-creatable codec instance so its WebAssembly heap can be garbage-collected. */
export function releaseCodecMemory(): void {
  releaseAvif();
  releaseJpeg();
  releaseWebp();
}
