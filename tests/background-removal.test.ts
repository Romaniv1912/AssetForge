import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import './helpers/setup';
import { DEFAULT_SEGMENTATION_MODEL, getModelSpec, modelInputSize, registerSegmentationModel, SEGMENTATION_MODELS } from '../src/image/background-removal/models';
import { normalizeMask, removeBackground, toTensor } from '../src/image/background-removal/remove-background';
import { bilinearResize, boxBlur } from '../src/image/background-removal/refine';
import { ModelUnavailableError, type SegmentationRunner } from '../src/image/background-removal/runner';
import { processImage } from '../src/image/pipeline/process-image';
import { encodePng } from '../src/image/codecs';
import { fixture, options } from './helpers/setup';
import { blank, objectOnBackground, transparentIllustration } from './helpers/synthetic';

/**
 * Test double for the neural network: returns the ground-truth matte
 * degraded exactly like a real model output (downsampled to the model
 * resolution and slightly blurred). Everything around it — pre-processing,
 * edge refinement, colour decontamination, alpha composition, cropping — is
 * the production code.
 */
function groundTruthRunner(alpha: Float32Array, width: number, height: number, blur = 1): SegmentationRunner & { calls: number } {
  return {
    calls: 0,
    async run(_model, tensor, w, h) {
      this.calls++;
      expect(tensor.length).toBe(w * h * 3);
      const low = bilinearResize({ data: alpha, width, height }, w, h);
      return { data: boxBlur(low.data, w, h, blur), width: w, height: h };
    },
  };
}

function meanAbsError(a: Float32Array, b: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i * 4 + 3]! / 255);
  return sum / a.length;
}

describe('background removal', () => {
  it('model registry entries are complete and licence-annotated', () => {
    for (const m of SEGMENTATION_MODELS) {
      expect(m.url).toMatch(/^https:\/\//);
      expect(m.license.length).toBeGreaterThan(0);
      expect(['allowed', 'requires-agreement']).toContain(m.commercialUse);
    }
    expect(modelInputSize(getModelSpec('rmbg-1.4'), 3000, 2000)).toEqual({ width: 1024, height: 1024 });
    const full = getModelSpec('rmbg-1.4-full');
    expect(full.url).toMatch(/onnx\/model\.onnx$/);
    expect(full.requiresWebGpu).toBeFalsy();
    expect(DEFAULT_SEGMENTATION_MODEL).toBe('rmbg-1.4');
    expect(SEGMENTATION_MODELS.map((m) => m.id)).toEqual(['rmbg-1.4', 'rmbg-1.4-full']);
  });

  it('normalises input tensors and model outputs', () => {
    const img = blank(2, 1, [255, 0, 128, 255]);
    const t = toTensor(img, { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] });
    expect(Array.from(t).map((v) => Number(v.toFixed(3)))).toEqual([1, 1, -1, -1, 0.004, 0.004]);
    expect(Array.from(normalizeMask(Float32Array.of(2, 4, 6), { outputNormalization: 'minmax' }))).toEqual([0, 0.5, 1]);
    expect(Array.from(normalizeMask(Float32Array.of(-1, 0.5, 3), { outputNormalization: 'none' }))).toEqual([0, 0.5, 1]);
    const sig = normalizeMask(Float32Array.of(-20, 0, 20), { outputNormalization: 'sigmoid' });
    expect(sig[0]).toBeLessThan(1e-6);
    expect(sig[1]).toBeCloseTo(0.5, 6);
    expect(sig[2]).toBeGreaterThan(1 - 1e-6);
    // auto: logits get a sigmoid, an already-activated matte is kept.
    expect(normalizeMask(Float32Array.of(-8, 8), { outputNormalization: 'auto' })[0]).toBeLessThan(0.001);
    expect(Array.from(normalizeMask(Float32Array.of(0, 0.25, 1), { outputNormalization: 'auto' }))).toEqual([0, 0.25, 1]);
  });

  it('produces a soft matte that follows the true object edge', async () => {
    const { image, alpha } = objectOnBackground(320, 240);
    const runner = groundTruthRunner(alpha, 320, 240, 2);
    const refined = await removeBackground(image, { model: 'rmbg-1.4', refineEdges: true, decontaminateColors: false }, { runner });
    const plain = await removeBackground(image, { model: 'rmbg-1.4', refineEdges: false, decontaminateColors: false }, { runner });
    const errRefined = meanAbsError(alpha, refined.data);
    const errPlain = meanAbsError(alpha, plain.data);
    expect(errRefined).toBeLessThan(0.02);
    expect(errRefined).toBeLessThanOrEqual(errPlain);
    // Semi-transparent edge pixels are preserved, not binarised.
    let soft = 0;
    for (let p = 3; p < refined.data.length; p += 4) if (refined.data[p]! > 10 && refined.data[p]! < 245) soft++;
    expect(soft).toBeGreaterThan(50);
  });

  it('removes background colour from soft edges (no green halo)', async () => {
    const { image, alpha } = objectOnBackground(320, 240);
    const runner = groundTruthRunner(alpha, 320, 240, 1);
    const clean = await removeBackground(image, { model: 'rmbg-1.4', refineEdges: true, decontaminateColors: true }, { runner });
    const dirty = await removeBackground(image, { model: 'rmbg-1.4', refineEdges: true, decontaminateColors: false }, { runner });
    // Foreground is red (220,40,50); background green. Measure green excess on edge pixels.
    const greenExcess = (img: Uint8ClampedArray) => {
      let sum = 0;
      let n = 0;
      for (let p = 0; p < img.length; p += 4) {
        const a = img[p + 3]!;
        if (a > 25 && a < 230) {
          sum += Math.max(0, img[p + 1]! - img[p]!);
          n++;
        }
      }
      return sum / Math.max(1, n);
    };
    expect(greenExcess(clean.data)).toBeLessThan(greenExcess(dirty.data) * 0.5);
  });

  it('keeps existing transparency (multiplies with the model matte)', async () => {
    const image = transparentIllustration(200, 150);
    const ones = new Float32Array(200 * 150).fill(1);
    const out = await removeBackground(image, { model: 'rmbg-1.4', refineEdges: false, decontaminateColors: false }, { runner: groundTruthRunner(ones, 200, 150, 0) });
    for (let p = 3; p < image.data.length; p += 4) expect(out.data[p]!).toBeLessThanOrEqual(image.data[p]! + 1);
  });

  it('runs inside the pipeline: remove → crop → pad → compress', async () => {
    const { image, alpha } = objectOnBackground(320, 240);
    const bytes = await encodePng(image);
    const runner = groundTruthRunner(alpha, 320, 240, 1);
    const result = await processImage(
      bytes,
      options({ backgroundRemoval: { enabled: true, model: 'rmbg-1.4' }, crop: { enabled: true, padding: 8 }, compression: { format: 'png' } }),
      { segmentation: runner },
    );
    expect(runner.calls).toBe(1);
    expect(result.backgroundRemoved).toBe(true);
    expect(result.cropped).toBe(true);
    // Disc of radius 72 → ~145 px + 2×8 padding.
    expect(result.width).toBeGreaterThanOrEqual(143 + 16);
    expect(result.width).toBeLessThanOrEqual(150 + 16);
    expect(result.analysis.hasAlpha).toBe(true);
  });

  it('skips the model for images that are already cut out', async () => {
    const bytes = await encodePng(transparentIllustration(200, 150));
    const runner = groundTruthRunner(new Float32Array(200 * 150), 200, 150);
    const result = await processImage(bytes, options({ backgroundRemoval: { enabled: true, skipIfTransparent: true } }), { segmentation: runner });
    expect(runner.calls).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/already has a transparent background/);
  });

  it('reports a clear error when the model finds no foreground', async () => {
    const bytes = await encodePng(objectOnBackground(64, 64).image);
    const empty = groundTruthRunner(new Float32Array(64 * 64), 64, 64, 0);
    await expect(
      processImage(bytes, options({ backgroundRemoval: { enabled: true, model: 'rmbg-1.4' } }), { segmentation: empty }),
    ).rejects.toThrow(/no foreground object was detected/);
  });

  // Real-model integration test. Download a model (see README) and set
  // ASSETFORGE_MODEL_PATH=/path/to/model_quantized.onnx (RMBG-1.4) to run it.
  // ASSETFORGE_MODEL_ID selects the registry entry the file belongs to (default rmbg-1.4,
  // e.g. rmbg-1.4-full with the fp32 onnx/model.onnx file).
  const modelPath = process.env.ASSETFORGE_MODEL_PATH;
  const modelId = process.env.ASSETFORGE_MODEL_ID ?? 'rmbg-1.4';
  it.runIf(modelPath && existsSync(modelPath))('a real segmentation model separates a portrait from its background', async () => {
    const { OnnxSegmentationRunner } = await import('../src/image/background-removal/onnx-runner');
    const ort = await import('onnxruntime-web/wasm');
    ort.env.wasm.numThreads = 1;
    const runner = new OnnxSegmentationRunner({
      loadRuntime: async () => ({ ort: ort as never, executionProviders: ['wasm'], label: 'wasm' }),
      loadModel: async () => new Uint8Array(readFileSync(modelPath!)),
    });
    const result = await processImage(
      fixture('astronaut.png'),
      options({ backgroundRemoval: { enabled: true, model: modelId, skipIfTransparent: false }, compression: { format: 'png' } }),
      { segmentation: runner },
    );
    expect(result.backgroundRemoved).toBe(true);
    expect(result.analysis.alphaKind).toBe('soft');
    await runner.dispose();
  });

  it('falls back to RMBG-1.4 when a model cannot run (no WebGPU / out of memory) and remembers it', async () => {
    const { image, alpha } = objectOnBackground(160, 120);
    const bytes = await encodePng(image);
    const calls: string[] = [];
    const truth = groundTruthRunner(alpha, 160, 120, 1);
    const runner: SegmentationRunner = {
      async run(modelId, tensor, w, h) {
        calls.push(modelId);
        if (modelId === 'gpu-only-test') throw new ModelUnavailableError('GPU-only test model needs WebGPU', modelId);
        return truth.run(modelId, tensor, w, h);
      },
    };
    registerSegmentationModel({
      ...getModelSpec('rmbg-1.4'),
      id: 'gpu-only-test',
      label: 'GPU-only test model',
      requiresWebGpu: true,
      fallback: 'rmbg-1.4',
    });
    const opts = options({ backgroundRemoval: { enabled: true, model: 'gpu-only-test', skipIfTransparent: false }, compression: { format: 'png' } });
    const first = await processImage(bytes, opts, { segmentation: runner });
    const second = await processImage(bytes, opts, { segmentation: runner });
    expect(first.backgroundRemoved).toBe(true);
    expect(first.warnings.join(' ')).toMatch(/RMBG-1\.4 .* was used instead/);
    expect(second.backgroundRemoved).toBe(true);
    expect(calls).toEqual(['gpu-only-test', 'rmbg-1.4', 'rmbg-1.4']);
  });

  it('clears background specks left by the model but keeps soft edges (regression: blue specks)', async () => {
    const W = 320;
    const H = 240;
    const { image, alpha } = objectOnBackground(W, H);
    // Model output = true matte + weak speckle noise + one tiny confident blob far away.
    const noisy = alpha.slice();
    let seed = 42;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let k = 0; k < 400; k++) {
      const x = Math.floor(rand() * W);
      const y = Math.floor(rand() * H);
      for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
        const i = Math.min(H - 1, y + dy) * W + Math.min(W - 1, x + dx);
        if (alpha[i] === 0) noisy[i] = 0.05 + rand() * 0.35;
      }
    }
    for (let y = 5; y < 8; y++) for (let x = 5; x < 8; x++) noisy[y * W + x] = 0.95;
    const runner = groundTruthRunner(noisy, W, H, 0);

    const out = await removeBackground(image, { model: 'rmbg-1.4', refineEdges: true, decontaminateColors: true }, { runner });

    // Distance from each pixel to the object disc (centre 160,132, r 72).
    let farVisible = 0;
    let soft = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const a = out.data[(y * W + x) * 4 + 3]!;
        const d = Math.hypot(x + 0.5 - W * 0.5, y + 0.5 - H * 0.55) - H * 0.3;
        if (d > 12 && a > 0) farVisible++;
        if (d > -3 && d < 3 && a > 10 && a < 245) soft++;
      }
    }
    expect(farVisible).toBe(0);
    expect(soft).toBeGreaterThan(50);
    expect(meanAbsError(alpha, out.data)).toBeLessThan(0.02);
  });
});
