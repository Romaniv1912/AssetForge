import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import './helpers/setup';
import { getModelSpec as getModelSpecForTest, registerSegmentationModel } from '../src/image/background-removal/models';
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

  it('uses the WebGPU model variant and falls back to the CPU model when WebGPU fails', async () => {
    registerSegmentationModel({
      id: 'tiny-gpu-test',
      label: 'Tiny GPU test model',
      description: 'variant selection',
      url: 'https://example.invalid/cpu.onnx',
      approxBytes: 276,
      webgpu: { url: 'https://example.invalid/gpu-fp16.onnx', approxBytes: 138 },
      license: 'MIT',
      licenseUrl: 'https://example.invalid',
      commercialUse: 'allowed',
      input: { kind: 'fixed', width: 32, height: 32 },
      mean: [0, 0, 0],
      std: [1, 1, 1],
      outputNormalization: 'sigmoid',
    });
    const requested: string[] = [];
    const providers: string[][] = [];
    const ort = await import('onnxruntime-web/wasm');
    ort.env.wasm.wasmBinary = readFileSync(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
    ort.env.wasm.numThreads = 1;
    // Wrap the real runtime: pretend WebGPU exists but cannot create the session.
    const fakeOrt = {
      ...ort,
      InferenceSession: {
        create: async (model: Uint8Array, options: { executionProviders: string[] }) => {
          providers.push(options.executionProviders);
          if (options.executionProviders.includes('webgpu')) throw new Error('no shader-f16');
          return ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
        },
      },
    };
    const runner = new OnnxSegmentationRunner({
      loadRuntime: async () => ({ ort: fakeOrt as never, executionProviders: ['webgpu', 'wasm'], label: 'WebGPU' }),
      loadModel: async (url) => {
        requested.push(url);
        return new Uint8Array(readFileSync(modelPath));
      },
    });
    const mask = await runner.run('tiny-gpu-test', new Float32Array(3 * 32 * 32), 32, 32);
    expect(mask.width).toBe(32);
    expect(requested).toEqual(['https://example.invalid/gpu-fp16.onnx', 'https://example.invalid/cpu.onnx']);
    expect(providers).toEqual([['webgpu', 'wasm'], ['wasm']]);
    await runner.dispose();
  });

  it('reports WebGPU-only models as unavailable on the CPU backend without downloading them', async () => {
    const { ModelUnavailableError } = await import('../src/image/background-removal/runner');
    let downloads = 0;
    const runner = new OnnxSegmentationRunner({
      loadRuntime: async () => ({ ort: {} as never, executionProviders: ['wasm'], label: 'WebAssembly (CPU)' }),
      loadModel: async () => {
        downloads++;
        return new Uint8Array();
      },
    });
    registerSegmentationModel({ ...getModelSpecForTest('rmbg-1.4'), id: 'gpu-only-runner-test', requiresWebGpu: true });
    await expect(runner.run('gpu-only-runner-test', new Float32Array(3), 1, 1)).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(downloads).toBe(0);
  });

  it('turns std::bad_alloc into ModelUnavailableError, releases the session and fails fast afterwards', async () => {
    const { ModelUnavailableError } = await import('../src/image/background-removal/runner');
    let released = 0;
    let runs = 0;
    const fakeOrt = {
      Tensor: class {
        constructor(..._args: unknown[]) {}
        dispose() {}
      },
      InferenceSession: {
        create: async () => ({
          inputNames: ['input'],
          outputNames: ['output'],
          run: async () => {
            runs++;
            throw new Error('failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: std::bad_alloc');
          },
          release: async () => {
            released++;
          },
        }),
      },
    };
    const runner = new OnnxSegmentationRunner({
      loadRuntime: async () => ({ ort: fakeOrt as never, executionProviders: ['wasm'], label: 'cpu' }),
      loadModel: async () => new Uint8Array(),
    });
    await expect(runner.run('tiny-test', new Float32Array(3), 1, 1)).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(released).toBe(1);
    await expect(runner.run('tiny-test', new Float32Array(3), 1, 1)).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(runs).toBe(1);
  });

});
