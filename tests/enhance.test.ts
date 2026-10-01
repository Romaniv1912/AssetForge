import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import './helpers/setup';
import { OnnxSegmentationRunner } from '../src/image/background-removal/onnx-runner';
import { encodeJpeg, encodePng, resample } from '../src/image/codecs';
import { cropImage } from '../src/image/crop/smart-crop';
import { decodeImage } from '../src/image/decode/decode';
import { getEnhanceModelSpec } from '../src/image/enhance/models';
import { detailFactor } from '../src/image/enhance/softness';
import { aiUpscale, bleedColours } from '../src/image/enhance/upscale';
import { compareImages } from '../src/image/metrics/ssim';
import { enhanceDecision, processImage } from '../src/image/pipeline/process-image';
import type { RgbaImage } from '../src/image/types';
import { fixture, options } from './helpers/setup';
import { blank, flatGraphic, transparentIllustration } from './helpers/synthetic';

const require = createRequire(import.meta.url);
const modelFile = (url: string) => fileURLToPath(new URL(`../models/${url.split('/').pop()}`, import.meta.url));
const spec = getEnhanceModelSpec('realesr-general-x4v3');

let modelLoads = 0;
const runner = new OnnxSegmentationRunner({
  loadRuntime: async () => {
    const ort = await import('onnxruntime-web/wasm');
    ort.env.wasm.wasmBinary = readFileSync(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
    ort.env.wasm.numThreads = 1;
    return { ort: ort as never, executionProviders: ['wasm'], label: 'WebAssembly (CPU)' };
  },
  loadModel: async (url) => {
    modelLoads++;
    return new Uint8Array(readFileSync(modelFile(url)));
  },
});

async function cat(size: number): Promise<RgbaImage> {
  const { image } = await decodeImage(fixture('chelsea.png'));
  return cropImage(image, { x: 150, y: 60, width: size, height: size });
}

/**
 * JPEG blocking: how much larger luma steps are across 8×8 block borders than
 * inside blocks (≈1 for a clean image).
 */
function blockiness(image: RgbaImage): number {
  const { width, height, data } = image;
  const luma = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
  };
  let border = 0;
  let inner = 0;
  let nb = 0;
  let ni = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const d = Math.abs(luma(x + 1, y) - luma(x, y));
      if ((x + 1) % 8 === 0) {
        border += d;
        nb++;
      } else {
        inner += d;
        ni++;
      }
    }
  }
  return border / nb / (inner / ni);
}

/** Mean luma gradient magnitude: higher is sharper. */
function edgeEnergy(image: RgbaImage): number {
  const { width, height, data } = image;
  const luma = (i: number) => 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
  let sum = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      sum += Math.abs(luma(i + 4) - luma(i)) + Math.abs(luma(i + width * 4) - luma(i));
    }
  }
  return sum / ((width - 1) * (height - 1));
}

describe('AI upscale (Real-ESRGAN general x4v3, real model)', () => {
  it('produces sharper edges than a filter upscale', async () => {
    // A GAN upscaler does not reproduce the exact ground truth (it smooths
    // texture it treats as noise), so compare edge sharpness instead of SSIM.
    const { image: astronaut } = await decodeImage(fixture('astronaut.png'));
    const original = cropImage(astronaut, { x: 150, y: 40, width: 128, height: 128 }); // face: clear contours
    const small = await resample(original, 32, 32, { filter: 'lanczos3', premultiply: true, linearRGB: true });
    const ai = await aiUpscale(small, spec, runner);
    const filter = await resample(small, 128, 128, { filter: 'catrom', premultiply: true, linearRGB: true });
    expect([ai.width, ai.height]).toEqual([128, 128]);
    const [gAi, gFilter, gOriginal] = [ai, filter, original].map(edgeEnergy);
    console.log(`edge energy: AI ${gAi!.toFixed(2)}, Catmull-Rom ${gFilter!.toFixed(2)}, original ${gOriginal!.toFixed(2)}`);
    expect(gAi!).toBeGreaterThan(gFilter! * 1.3);
    // Similar overall: no colour shift or garbage.
    expect(compareImages(original, ai).psnr).toBeGreaterThan(22);
  });

  it('tiles join without visible seams', async () => {
    const image = await resample(await cat(160), 72, 56, { filter: 'lanczos3', premultiply: true, linearRGB: true });
    const whole = await aiUpscale(image, { ...spec, tile: 1024 }, runner);
    const tiled = await aiUpscale(image, { ...spec, tile: 24, tilePad: 16 }, runner);
    let max = 0;
    let sum = 0;
    for (let i = 0; i < whole.data.length; i++) {
      const d = Math.abs(whole.data[i]! - tiled.data[i]!);
      max = Math.max(max, d);
      sum += d;
    }
    console.log(`tiled vs whole: mean |Δ| ${(sum / whole.data.length).toFixed(3)}, max ${max}`);
    expect(sum / whole.data.length).toBeLessThan(0.5);
    expect(max).toBeLessThanOrEqual(12);
  });

  it('keeps transparency (alpha is resized separately)', async () => {
    const image = transparentIllustration(40, 30);
    const out = await aiUpscale(image, spec, runner);
    expect([out.width, out.height]).toEqual([160, 120]);
    expect(out.data[3]).toBe(0); // transparent corner stays transparent
    const centre = ((60 * 160 + 80) * 4) + 3;
    expect(out.data[centre]).toBe(255);
  });

  it('pipeline: a small crop is AI-upscaled and fitted into the Resize box', async () => {
    const bytes = await encodePng(await cat(100));
    const result = await processImage(
      bytes,
      options({ enhance: { enabled: true }, resize: { enabled: true, maxWidth: 256, maxHeight: 256 }, compression: { format: 'png', preset: 'balanced' } }),
      { enhancer: runner },
    );
    expect(result.enhanced).toBe(true);
    expect([result.width, result.height]).toEqual([256, 256]);
    // Placement stays in source pixels for the before/after overlay.
    expect(result.placement).toMatchObject({ sourceWidth: 100, sourceHeight: 100, width: 100, height: 100 });
    expect(modelLoads).toBe(1); // one session for every tile and test (photo model)
  });

  it('keep-size mode: same dimensions, JPEG blocking removed', async () => {
    const { image: astronaut } = await decodeImage(fixture('astronaut.png'));
    const clean = cropImage(astronaut, { x: 130, y: 32, width: 96, height: 96 });
    const jpeg = await encodeJpeg(clean, { quality: 12 }); // heavily compressed
    const input = (await decodeImage(jpeg)).image;
    const result = await processImage(
      jpeg,
      options({ enhance: { enabled: true, keepSize: true }, compression: { format: 'png', preset: 'maximum' } }),
      { enhancer: runner },
    );
    expect(result.enhanced).toBe(true);
    expect([result.width, result.height]).toEqual([96, 96]);
    expect(result.placement).toMatchObject({ sourceWidth: 96, sourceHeight: 96, width: 96, height: 96 });
    const out = (await decodeImage(result.data)).image;
    console.log(`keep-size blockiness: JPEG ${blockiness(input).toFixed(2)}, enhanced ${blockiness(out).toFixed(2)}, clean ${blockiness(clean).toFixed(2)}`);
    expect(blockiness(out)).toBeLessThan(blockiness(input) * 0.6);
  });
});

describe('graphics model (Real-ESRGAN x4plus anime 6B, real model)', () => {
  it('restores flat graphics closer to the sharp original than a filter', async () => {
    const original = flatGraphic(128, 96);
    const small = await resample(original, 32, 24, { filter: 'lanczos3', premultiply: true, linearRGB: true });
    const ai = await aiUpscale(small, getEnhanceModelSpec('realesrgan-x4plus-anime-6b'), runner);
    const filter = await resample(small, 128, 96, { filter: 'catrom', premultiply: true, linearRGB: true });
    expect([ai.width, ai.height]).toEqual([128, 96]);
    const [mAi, mFilter] = [compareImages(original, ai), compareImages(original, filter)];
    console.log(`anime 6B vs truth: AI ssim ${mAi.ssim.toFixed(4)} psnr ${mAi.psnr.toFixed(2)}, filter ssim ${mFilter.ssim.toFixed(4)} psnr ${mFilter.psnr.toFixed(2)}`);
    expect(mAi.ssim).toBeGreaterThan(mFilter.ssim);
  });
});

describe('soft images', () => {
  const o = { premultiply: true, linearRGB: true } as const;
  const soften = async (image: RgbaImage, d: number) =>
    resample(await resample(image, Math.round(image.width / d), Math.round(image.height / d), { filter: 'lanczos3', ...o }), image.width, image.height, {
      filter: 'catrom',
      ...o,
    });

  it('sharp images keep their size; upscaled-before images are detected', async () => {
    for (const name of ['chelsea.png', 'astronaut.png', 'logo.png', 'text.png']) {
      const { image } = await decodeImage(fixture(name));
      expect(await detailFactor(image, 4), name).toBe(1);
    }
    const { image } = await decodeImage(fixture('astronaut.png'));
    expect(await detailFactor(await soften(image, 2), 4)).toBe(2);
    // Detection is conservative (a false positive would destroy real detail).
    expect(await detailFactor(await soften(image, 4), 4)).toBeGreaterThanOrEqual(2);
    expect(await detailFactor(await soften(image, 4), 2)).toBe(2); // limited by the Resize box
  });

  it('pipeline starts the AI upscale from the real detail level', async () => {
    const { image } = await decodeImage(fixture('astronaut.png'));
    const soft = await soften(cropImage(image, { x: 128, y: 32, width: 192, height: 192 }), 2);
    const result = await processImage(
      await encodePng(soft),
      options({ enhance: { enabled: true, keepSize: true }, compression: { format: 'png', preset: 'balanced' } }),
      { enhancer: runner },
    );
    expect([result.width, result.height]).toEqual([192, 192]);
    expect(result.warnings.join(' ')).toMatch(/holds about 96×96 px of detail/);
    const out = (await decodeImage(result.data)).image;
    console.log(`soft keep-size edge energy: input ${edgeEnergy(soft).toFixed(2)}, enhanced ${edgeEnergy(out).toFixed(2)}`);
    expect(edgeEnergy(out)).toBeGreaterThan(edgeEnergy(soft) * 1.2);
  });

  it('fills colour under transparency from nearby visible pixels', () => {
    const image = blank(8, 8, [0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) image.data.set([0, 120, 255, 255], (3 * 8 + 3 + (i % 2) + (i > 1 ? 8 : 0)) * 4);
    const filled = bleedColours(image);
    // A transparent corner now carries the visible blue instead of black...
    expect(Array.from(filled.data.subarray(0, 4))).toEqual([0, 120, 255, 0]);
    // ...and visible pixels are unchanged.
    expect(Array.from(filled.data.subarray((3 * 8 + 3) * 4, (3 * 8 + 3) * 4 + 4))).toEqual([0, 120, 255, 255]);
  });
});

describe('when AI upscaling runs', () => {
  const opts = (onlyWhenSmaller: boolean, resize = true) =>
    options({ enhance: { enabled: true, onlyWhenSmaller }, resize: { enabled: resize, maxWidth: 512, maxHeight: 512 } });

  it('only for images smaller than the Resize box (by more than 10%)', () => {
    expect(enhanceDecision(blank(300, 200), opts(true)).run).toBe(true);
    expect(enhanceDecision(blank(480, 300), opts(true)).run).toBe(false);
    expect(enhanceDecision(blank(2000, 2000), opts(true)).run).toBe(false);
    expect(enhanceDecision(blank(600, 400), opts(false)).run).toBe(true);
    expect(enhanceDecision(blank(600, 400), opts(true, false)).run).toBe(true);
    // Keep-size mode runs regardless of the Resize box.
    const keep = options({ enhance: { enabled: true, keepSize: true }, resize: { enabled: true, maxWidth: 512, maxHeight: 512 } });
    expect(enhanceDecision(blank(2000, 400), keep).run).toBe(true);
  });

  it('never on inputs over 1 MP', () => {
    const decision = enhanceDecision(blank(1200, 1000), opts(false));
    expect(decision.run).toBe(false);
    expect(decision.reason).toMatch(/AI upscale skipped/);
    // The slower graphics model has a lower limit.
    const anime = options({ enhance: { enabled: true, onlyWhenSmaller: false, model: 'realesrgan-x4plus-anime-6b' } });
    expect(enhanceDecision(blank(512, 512), anime).run).toBe(true);
    expect(enhanceDecision(blank(600, 600), anime).run).toBe(false);
  });

  it('failures do not fail the image', async () => {
    const bytes = await encodePng(blank(40, 40, [200, 100, 50, 255]));
    const result = await processImage(bytes, options({ enhance: { enabled: true }, resize: { enabled: true, maxWidth: 128, maxHeight: 128 } }), {
      enhancer: { enhance: async () => Promise.reject(new Error('boom')) },
    });
    expect(result.enhanced).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/AI upscale failed and was skipped: boom/);
  });
});
