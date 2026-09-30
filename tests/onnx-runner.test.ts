import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import './helpers/setup';
import { registerSegmentationModel } from '../src/image/background-removal/models';
import { OnnxSegmentationRunner } from '../src/image/background-removal/onnx-runner';
import { decodeImage } from '../src/image/decode/decode';
import { processImage } from '../src/image/pipeline/process-image';
import { fixture, options } from './helpers/setup';

/**
 * Runs the production ONNX Runtime path (onnxruntime-web, WASM backend) with
 * a tiny real ONNX graph that has the same I/O contract as the segmentation
 * models (see fixtures/models/make-tiny-model.py).
 */
const require = createRequire(import.meta.url);
const modelPath = fileURLToPath(new URL('../fixtures/models/tiny-segmentation.onnx', import.meta.url));

registerSegmentationModel({
  id: 'tiny-test',
  label: 'Tiny test model',
  description: 'max(RGB) - min(RGB)',
  url: 'https://example.invalid/tiny-segmentation.onnx',
  approxBytes: 276,
  license: 'MIT',
  licenseUrl: 'https://example.invalid',
  commercialUse: 'allowed',
  input: { kind: 'shortest-edge', size: 256, multiple: 32, maxEdge: 512 },
  mean: [0, 0, 0],
  std: [1, 1, 1],
  outputNormalization: 'minmax',
});

function createRunner() {
  let modelLoads = 0;
  const runner = new OnnxSegmentationRunner({
    loadRuntime: async () => {
      const ort = await import('onnxruntime-web/wasm');
      ort.env.wasm.wasmBinary = readFileSync(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
      ort.env.wasm.numThreads = 1;
      return { ort: ort as never, executionProviders: ['wasm'], label: 'WebAssembly (CPU)' };
    },
    loadModel: async () => {
      modelLoads++;
      return new Uint8Array(readFileSync(modelPath));
    },
  });
  return { runner, loads: () => modelLoads };
}

describe('ONNX Runtime segmentation runner', () => {
  it('runs inference and returns a mask of the model output size', async () => {
    const { runner } = createRunner();
    const w = 64;
    const h = 32;
    const tensor = new Float32Array(3 * w * h);
    // Left half grey (R=G=B), right half saturated red.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        tensor[i] = x < 32 ? 0.5 : 1;
        tensor[w * h + i] = x < 32 ? 0.5 : 0;
        tensor[2 * w * h + i] = x < 32 ? 0.5 : 0;
      }
    }
    const mask = await runner.run('tiny-test', tensor, w, h);
    expect([mask.width, mask.height]).toEqual([64, 32]);
    expect(mask.data[0]).toBeCloseTo(0, 5);
    expect(mask.data[63]).toBeCloseTo(1, 5);
    await runner.dispose();
  });

  it('removes a white background end-to-end and reuses the session for a batch', async () => {
    const { runner, loads } = createRunner();
    const opts = options({
      backgroundRemoval: { enabled: true, model: 'tiny-test', skipIfTransparent: false },
      crop: { enabled: true, padding: 0 },
      compression: { format: 'png', preset: 'high' },
    });
    const first = await processImage(fixture('logo.png'), opts, { segmentation: runner });
    const second = await processImage(fixture('logo.png'), opts, { segmentation: runner });
    expect(loads()).toBe(1); // model loaded once, session cached
    expect(first.backgroundRemoved).toBe(true);
    expect(second.outputBytes).toBe(first.outputBytes);
    const { image } = await decodeImage(first.data);
    const alphaAt = (x: number, y: number) => image.data[(y * image.width + x) * 4 + 3]!;
    // The white corners outside the circular logo are removed…
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(image.width - 1, image.height - 1)).toBe(0);
    // …while the colourful centre is kept (the toy model's matte is graded, not binary).
    expect(alphaAt(Math.round(image.width * 0.3), Math.round(image.height * 0.3))).toBeGreaterThan(64);
    await runner.dispose();
  });
});
