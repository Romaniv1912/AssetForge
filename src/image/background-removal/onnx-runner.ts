import type * as Ort from 'onnxruntime-web';
import type { StageProgress } from '../types';
import { getModelSpec } from './models';
import type { SegmentationMask, SegmentationRunner } from './runner';

type OrtModule = typeof Ort;

export interface OrtRuntime {
  ort: OrtModule;
  executionProviders: string[];
  label: string;
}

export interface OnnxRunnerConfig {
  /**
   * Loads the ONNX Runtime module and configures its WebAssembly binary.
   * Browser and Node hosts differ (bundle vs. node_modules), so the host decides.
   */
  loadRuntime: (onProgress?: (p: StageProgress) => void) => Promise<OrtRuntime>;
  /** Downloads (or reads from cache) a model file. */
  loadModel: (url: string, approxBytes: number, onProgress?: (p: StageProgress) => void) => Promise<Uint8Array>;
}

/**
 * Background segmentation with ONNX Runtime. One session per model is created
 * lazily and reused for every image (the model is never reloaded per image).
 */
export class OnnxSegmentationRunner implements SegmentationRunner {
  private runtime: Promise<OrtRuntime> | undefined;
  private readonly sessions = new Map<string, Promise<Ort.InferenceSession>>();
  /** Serialises inference: a session runs one image at a time, avoiding duplicate activation memory. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: OnnxRunnerConfig) {}

  get backend(): Promise<string> | undefined {
    return this.runtime?.then((r) => r.label);
  }

  async run(
    modelId: string,
    tensor: Float32Array,
    width: number,
    height: number,
    onProgress?: (p: StageProgress) => void,
  ): Promise<SegmentationMask> {
    const task = this.queue.then(async () => {
      const session = await this.session(modelId, onProgress);
      const { ort } = await this.runtime!;
      onProgress?.({ stage: 'removing-background', detail: 'Segmenting' });
      const input = new ort.Tensor('float32', tensor, [1, 3, height, width]);
      const feeds: Record<string, Ort.Tensor> = { [session.inputNames[0]!]: input };
      const results = await session.run(feeds);
      const output = results[session.outputNames[0]!]!;
      try {
        const dims = output.dims;
        const outH = Number(dims[dims.length - 2]);
        const outW = Number(dims[dims.length - 1]);
        const raw = (await output.getData()) as Float32Array;
        // The first channel is the matte for single- and multi-output models alike.
        const data = new Float32Array(raw.subarray(0, outW * outH));
        return { data, width: outW, height: outH };
      } finally {
        input.dispose();
        for (const tensorOut of Object.values(results)) tensorOut.dispose();
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private session(modelId: string, onProgress?: (p: StageProgress) => void): Promise<Ort.InferenceSession> {
    let pending = this.sessions.get(modelId);
    if (!pending) {
      pending = (async () => {
        this.runtime ??= this.config.loadRuntime(onProgress);
        let runtime: OrtRuntime;
        try {
          runtime = await this.runtime;
        } catch (error) {
          this.runtime = undefined;
          throw error;
        }
        const spec = getModelSpec(modelId);
        const model = await this.config.loadModel(spec.url, spec.approxBytes, onProgress);
        onProgress?.({ stage: 'removing-background', detail: 'Initialising model' });
        try {
          return await runtime.ort.InferenceSession.create(model, {
            executionProviders: runtime.executionProviders,
            graphOptimizationLevel: 'all',
          });
        } catch (error) {
          if (runtime.executionProviders.includes('wasm') && runtime.executionProviders.length > 1) {
            // e.g. WebGPU adapter present but an operator is unsupported: fall back to CPU.
            return runtime.ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
          }
          throw error;
        }
      })();
      pending.catch(() => this.sessions.delete(modelId));
      this.sessions.set(modelId, pending);
    }
    return pending;
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const s of sessions) {
      try {
        await (await s).release();
      } catch {
        // Session failed to initialise; nothing to release.
      }
    }
  }
}

/**
 * Fetches a URL with byte-level progress. Uses the Cache Storage API when the
 * environment allows it (it is unavailable in opaque-origin frames such as the
 * Figma plugin iframe; there the browser HTTP cache still applies).
 */
export async function fetchWithCache(
  url: string,
  approxBytes: number,
  label: string,
  onProgress?: (p: StageProgress) => void,
  stage: StageProgress['stage'] = 'removing-background',
): Promise<Uint8Array> {
  const cache = await openCache();
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) return new Uint8Array(await hit.arrayBuffer());
    } catch {
      // Ignore cache read failures and download instead.
    }
  }

  let response: Response;
  try {
    response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  } catch (error) {
    throw new Error(
      `Could not download ${label}. Check your internet connection (and that ${new URL(url).host} is allowed). ${String(error)}`,
    );
  }
  if (!response.ok) throw new Error(`Downloading ${label} failed: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || approxBytes;
  const reader = response.body?.getReader();
  let bytes: Uint8Array;
  if (!reader) {
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    const chunks: Uint8Array[] = [];
    let received = 0;
    let lastReport = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (received - lastReport > 256 * 1024) {
        lastReport = received;
        onProgress?.({
          stage,
          fraction: Math.min(1, received / total),
          detail: `Downloading ${label} ${formatMb(received)} / ${formatMb(total)}`,
        });
      }
    }
    bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  }
  if (cache) {
    try {
      await cache.put(url, new Response(bytes as BodyInit, { headers: { 'content-type': 'application/octet-stream' } }));
    } catch {
      // Quota exceeded or storage disabled: the download still succeeded.
    }
  }
  return bytes;
}

async function openCache(): Promise<Cache | undefined> {
  try {
    if (typeof caches === 'undefined') return undefined;
    return await caches.open('assetforge-models-v1');
  } catch {
    return undefined;
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
