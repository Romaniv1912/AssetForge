import {
  decodeAvif,
  decodeJpeg,
  decodePng,
  decodeWebp,
  encodeAvif,
  encodeJpeg,
  encodeWebp,
  optimisePngRaw,
} from '../codecs';
import type { EncodableFormat, ImageAnalysis, RgbaImage } from '../types';
import type { QualityTarget } from './presets';
import { libimagequantQuantizer } from './libimagequant';
import { wuQuantizer, type Quantizer } from './quantize';

export type CandidateId =
  | 'jpeg-420'
  | 'jpeg-444'
  | 'jpeg-gray'
  | 'webp'
  | 'webp-lossless'
  | 'avif'
  | 'avif-lossless'
  | 'png-quant'
  | 'webp-palette'
  | 'png-lossless';

export type Phase = 'search' | 'final';

export interface EncodedCandidate {
  bytes: Uint8Array;
  /** Pixels as a decoder will reproduce them, when already known without decoding. */
  decoded?: RgbaImage;
}

export interface CandidateEncoder {
  id: CandidateId;
  format: EncodableFormat;
  /**
   * lossy: `level` is encoder quality 0–100.
   * palette: `level` is the palette size.
   * lossless: `level` is ignored.
   */
  kind: 'lossy' | 'palette' | 'lossless';
  encode(level: number, phase: Phase): Promise<EncodedCandidate>;
  decode(bytes: Uint8Array): Promise<RgbaImage>;
  describe(level: number, phase: Phase): string;
}

export interface CandidateContext {
  image: RgbaImage;
  analysis: ImageAnalysis;
  target: QualityTarget;
  quantizer?: Quantizer;
  /** Quantised pixels per palette size, shared by the PNG and WebP palette candidates. */
  paletteCache?: Map<number, RgbaImage>;
}

let fallbackWarned = false;

/**
 * Palette-quantised pixels (libimagequant by default, image-q Wu + k-means if
 * the libimagequant WASM cannot be loaded). Cached per palette size.
 */
async function quantized(ctx: CandidateContext, colors: number): Promise<RgbaImage> {
  ctx.paletteCache ??= new Map();
  const hit = ctx.paletteCache.get(colors);
  if (hit) return hit;
  let quantizer: Quantizer = ctx.quantizer ?? libimagequantQuantizer;
  try {
    await quantizer.ready?.();
  } catch (error) {
    if (!fallbackWarned) console.warn('[AssetForge] libimagequant unavailable, using the built-in quantiser:', error);
    fallbackWarned = true;
    quantizer = wuQuantizer;
  }
  const pixels = quantizer.quantize(ctx.image, colors, { dithering: ctx.target.dithering });
  ctx.paletteCache.set(colors, pixels);
  return pixels;
}

const megapixels = (image: RgbaImage) => (image.width * image.height) / 1e6;

export function createCandidate(id: CandidateId, ctx: CandidateContext): CandidateEncoder {
  const { image, analysis, target } = ctx;
  const mp = megapixels(image);

  switch (id) {
    case 'jpeg-420':
    case 'jpeg-444':
    case 'jpeg-gray': {
      const settings = {
        chroma_subsample: id === 'jpeg-444' ? 1 : 2,
        color_space: id === 'jpeg-gray' ? 1 : 3,
      } as const;
      const label = id === 'jpeg-444' ? '4:4:4' : id === 'jpeg-gray' ? 'grayscale' : '4:2:0';
      return {
        id,
        format: 'jpeg',
        kind: 'lossy',
        encode: async (quality) => ({
          bytes: await encodeJpeg(image, {
            quality,
            ...settings,
            progressive: true,
            optimize_coding: true,
            // Trellis on DC and EOB optimisation squeeze out a few % more.
            trellis_opt_zero: true,
            trellis_opt_table: false,
            trellis_multipass: false,
          }),
        }),
        decode: decodeJpeg,
        describe: (quality) => `MozJPEG q${quality} progressive ${label}`,
      };
    }

    case 'webp': {
      const alphaQuality = analysis.hasAlpha ? target.webpAlphaQuality : 100;
      return {
        id,
        format: 'webp',
        kind: 'lossy',
        encode: async (quality, phase) => ({
          bytes: await encodeWebp(image, {
            quality,
            // method 6 is libwebp's slowest/best; the search uses 4 for speed.
            method: phase === 'final' && mp <= 12 ? 6 : 4,
            use_sharp_yuv: 1,
            alpha_quality: alphaQuality,
            alpha_filtering: 2,
            exact: 0,
            pass: phase === 'final' ? 3 : 1,
            image_hint: analysis.contentType === 'photo' ? 2 : analysis.contentType === 'flat-graphic' ? 3 : 0,
          }),
        }),
        decode: decodeWebp,
        describe: (quality, phase) =>
          `libwebp lossy q${quality} m${phase === 'final' && mp <= 12 ? 6 : 4} sharp-yuv${analysis.hasAlpha ? ` alpha-q${alphaQuality}` : ''}`,
      };
    }

    case 'webp-lossless': {
      // Effort scaled with size: z9-equivalent (q100/m6) is only affordable on small images.
      const effort = mp <= 0.3 ? { quality: 100, method: 6 } : mp <= 2 ? { quality: 80, method: 5 } : { quality: 60, method: 4 };
      return {
        id,
        format: 'webp',
        kind: 'lossless',
        encode: async () => ({
          bytes: await encodeWebp(image, { lossless: 1, exact: 0, ...effort }),
          // Lossless: only the RGB of fully transparent pixels may change, which is invisible.
          decoded: image,
        }),
        decode: decodeWebp,
        describe: () => `libwebp lossless z${effort.method}`,
      };
    }

    case 'avif':
    case 'avif-lossless': {
      const lossless = id === 'avif-lossless';
      const subsample = analysis.isGrayscale && !analysis.hasAlpha ? 0 : analysis.contentType === 'photo' ? 1 : 3;
      const speedFor = (phase: Phase) => (phase === 'search' ? 8 : mp <= 2 ? 6 : 7);
      return {
        id,
        format: 'avif',
        kind: lossless ? 'lossless' : 'lossy',
        encode: async (quality, phase) => ({
          bytes: await encodeAvif(
            image,
            lossless
              ? { quality: 100, qualityAlpha: -1, subsample: 3, speed: speedFor(phase) }
              : {
                  quality,
                  // Alpha errors show up as halos: keep the alpha plane at higher quality.
                  qualityAlpha: Math.min(100, quality + 20),
                  subsample,
                  enableSharpYUV: subsample === 1,
                  speed: speedFor(phase),
                  tileColsLog2: mp > 4 ? 1 : 0,
                  tileRowsLog2: mp > 8 ? 1 : 0,
                },
          ),
        }),
        decode: decodeAvif,
        describe: (quality, phase) =>
          lossless
            ? `libavif lossless s${speedFor(phase)}`
            : `libavif q${quality} ${['4:0:0', '4:2:0', '4:2:2', '4:4:4'][subsample]} s${speedFor(phase)}`,
      };
    }

    case 'png-quant':
      return {
        id,
        format: 'png',
        kind: 'palette',
        encode: async (colors, phase) => {
          const pixels = await quantized(ctx, colors);
          const bytes = await optimisePngRaw(pixels, { level: phase === 'final' ? pngLevel(mp) : 1, optimiseAlpha: true });
          return { bytes, decoded: pixels };
        },
        decode: decodePng,
        describe: (colors, phase) => `Quantised PNG ${colors} colours, dithered, oxipng o${phase === 'final' ? pngLevel(mp) : 1}`,
      };

    case 'webp-palette': {
      // Palette pixels stored as lossless WebP: libwebp's colour-indexing
      // transform makes this far smaller than lossless WebP of the full-colour
      // image, and usually smaller than the palette PNG too.
      const effortFor = (phase: Phase) =>
        phase === 'search' ? { quality: 50, method: 2 } : mp <= 1 ? { quality: 100, method: 6 } : { quality: 80, method: 5 };
      return {
        id,
        format: 'webp',
        kind: 'palette',
        encode: async (colors, phase) => {
          const pixels = await quantized(ctx, colors);
          const bytes = await encodeWebp(pixels, { lossless: 1, exact: 0, ...effortFor(phase) });
          return { bytes, decoded: pixels };
        },
        decode: decodeWebp,
        describe: (colors, phase) => `Palette WebP lossless ${colors} colours, dithered, z${effortFor(phase).method}`,
      };
    }

    case 'png-lossless':
      return {
        id,
        format: 'png',
        kind: 'lossless',
        encode: async () => ({
          bytes: await optimisePngRaw(image, { level: pngLevel(mp), optimiseAlpha: true }),
          decoded: image,
        }),
        decode: decodePng,
        describe: () => `Lossless PNG, oxipng o${pngLevel(mp)}`,
      };
  }
}

/** oxipng effort scaled with image size to keep worst-case latency bounded. */
function pngLevel(mp: number): number {
  if (mp <= 0.5) return 4;
  if (mp <= 2) return 3;
  if (mp <= 8) return 2;
  return 1;
}
