import * as glue from 'libimagequant-wasm/wasm/libimagequant_wasm.js';
import { initBindgenOnce } from '../codecs/wasm-bindgen';
import type { RgbaImage } from '../types';
import type { QuantizeOptions, Quantizer } from './quantize';

/**
 * libimagequant — the quantiser behind pngquant, TinyPNG-class tools and
 * sharp's `png({ palette: true })` — compiled to WebAssembly.
 *
 * Licence: libimagequant is GPL-3.0-or-later (the npm wrapper is MIT). That is
 * why AssetForge as a whole is distributed under GPL-3.0-or-later.
 */
const initImagequant = initBindgenOnce('imagequant', async () =>
  // Newer wasm-bindgen glue takes `{ module_or_path }`.
  ((module: WebAssembly.Module) => glue.default({ module_or_path: module })) as never,
);

/** libimagequant speed 1–10: slower is better; scaled so huge images stay responsive. */
function speedFor(pixels: number): number {
  if (pixels <= 1_000_000) return 3;
  if (pixels <= 4_000_000) return 4;
  return 6;
}

export const libimagequantQuantizer: Quantizer = {
  ready: () => initImagequant(),
  quantize(image: RgbaImage, maxColors: number, options: QuantizeOptions = {}): RgbaImage {
    const quantizer = new glue.ImageQuantizer();
    let result: glue.QuantizationResult | undefined;
    try {
      quantizer.setMaxColors(Math.max(2, Math.min(256, Math.round(maxColors))));
      // Never refuse: AssetForge's own perceptual search decides what is acceptable.
      quantizer.setQuality(0, 100);
      quantizer.setSpeed(speedFor(image.width * image.height));
      result = quantizer.quantizeImage(image.data, image.width, image.height);
      result.setDithering(Math.max(0, Math.min(1, options.dithering ?? 1)));
      const pixels = result.remapImage(image.data, image.width, image.height);
      return { width: image.width, height: image.height, data: new Uint8ClampedArray(pixels) };
    } finally {
      result?.free();
      quantizer.free();
    }
  },
};
