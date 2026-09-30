import type { WasmBinaryName } from './wasm-provider';

/** Location of every codec binary inside node_modules: [package, path]. */
export const WASM_FILES: Record<WasmBinaryName, [pkg: string, path: string]> = {
  mozjpeg_enc: ['@jsquash/jpeg', 'codec/enc/mozjpeg_enc.wasm'],
  mozjpeg_dec: ['@jsquash/jpeg', 'codec/dec/mozjpeg_dec.wasm'],
  webp_enc: ['@jsquash/webp', 'codec/enc/webp_enc.wasm'],
  webp_enc_simd: ['@jsquash/webp', 'codec/enc/webp_enc_simd.wasm'],
  webp_dec: ['@jsquash/webp', 'codec/dec/webp_dec.wasm'],
  avif_enc: ['@jsquash/avif', 'codec/enc/avif_enc.wasm'],
  avif_dec: ['@jsquash/avif', 'codec/dec/avif_dec.wasm'],
  png: ['@jsquash/png', 'codec/pkg/squoosh_png_bg.wasm'],
  oxipng: ['@jsquash/oxipng', 'codec/pkg/squoosh_oxipng_bg.wasm'],
  resize: ['@jsquash/resize', 'lib/resize/pkg/squoosh_resize_bg.wasm'],
};
