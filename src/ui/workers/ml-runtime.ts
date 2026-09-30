import * as ortWebGpu from 'onnxruntime-web';
import * as ortWasm from 'onnxruntime-web/wasm';
import { fetchWithCache, OnnxSegmentationRunner, type OrtRuntime } from '../../image/background-removal/onnx-runner';
import type { StageProgress } from '../../image/types';

/**
 * ONNX Runtime for the browser.
 *
 * The runtime's WebAssembly binary (14–28 MB) is not inlined in the plugin: it
 * is fetched once from jsDelivr, pinned to the exact installed version, and
 * then served from the HTTP cache. WebGPU is used when the frame exposes an
 * adapter; otherwise the CPU (WASM SIMD) backend runs single-threaded — the
 * Figma iframe is not cross-origin isolated, so WASM threads are unavailable.
 */
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${__ORT_VERSION__}/dist`;

async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

export async function loadBrowserOrtRuntime(onProgress?: (p: StageProgress) => void): Promise<OrtRuntime> {
  const gpu = await hasWebGpu();
  const ort = (gpu ? ortWebGpu : ortWasm) as unknown as typeof ortWebGpu;
  const file = gpu ? 'ort-wasm-simd-threaded.jsep.wasm' : 'ort-wasm-simd-threaded.wasm';
  const binary = await fetchWithCache(`${ORT_CDN}/${file}`, gpu ? 28_312_028 : 14_239_897, 'ML runtime', onProgress);
  ort.env.wasm.wasmBinary = binary;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  return {
    ort,
    executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'],
    label: gpu ? 'WebGPU' : 'WebAssembly (CPU)',
  };
}

export function createBrowserSegmentationRunner(): OnnxSegmentationRunner {
  return new OnnxSegmentationRunner({
    loadRuntime: loadBrowserOrtRuntime,
    loadModel: (url, approxBytes, onProgress, access) =>
      fetchWithCache(url, approxBytes, 'background model', onProgress, 'removing-background', access),
  });
}
