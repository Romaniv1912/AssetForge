import type * as Ort from 'onnxruntime-web';
import type { StageProgress } from '../types';
import { getModelSpec } from './models';
import { isOutOfMemory, ModelUnavailableError, type ModelAccess, type SegmentationMask, type SegmentationRunner } from './runner';

type OrtModule = typeof Ort;

export interface OrtRuntime {
  ort: OrtModule;
  executionProviders: string[];
  label: string;
  /** Why WebGPU is or is not in use (shown when a WebGPU-only model cannot run). */
  webgpuStatus?: string;
}

export interface OnnxRunnerConfig {
  /**
   * Loads the ONNX Runtime module and configures its WebAssembly binary.
   * Browser and Node hosts differ (bundle vs. node_modules), so the host decides.
   */
  loadRuntime: (onProgress?: (p: StageProgress) => void) => Promise<OrtRuntime>;
  /** Downloads (or reads from cache) a model file. */
  loadModel: (url: string, approxBytes: number, onProgress?: (p: StageProgress) => void, access?: ModelAccess) => Promise<Uint8Array>;
}

/**
 * Background segmentation with ONNX Runtime. One session per model is created
 * lazily and reused for every image (the model is never reloaded per image).
 */
export class OnnxSegmentationRunner implements SegmentationRunner {
  private runtime: Promise<OrtRuntime> | undefined;
  private readonly sessions = new Map<string, Promise<Ort.InferenceSession>>();
  /** Models that proved unusable in this runtime (reported once, then skipped). */
  private readonly unavailable = new Map<string, string>();
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
    access?: ModelAccess,
  ): Promise<SegmentationMask> {
    const task = this.queue.then(async () => {
      const known = this.unavailable.get(modelId);
      if (known) throw new ModelUnavailableError(known, modelId);
      const session = await this.session(modelId, onProgress, access);
      const { ort } = await this.runtime!;
      onProgress?.({ stage: 'removing-background', detail: 'Segmenting' });
      const input = new ort.Tensor('float32', tensor, [1, 3, height, width]);
      const feeds: Record<string, Ort.Tensor> = { [session.inputNames[0]!]: input };
      let results: Ort.InferenceSession.OnnxValueMapType;
      try {
        results = await session.run(feeds);
      } catch (error) {
        if (!isOutOfMemory(error)) throw error;
        // std::bad_alloc: the WASM heap (max 4 GB) cannot hold this model's activations.
        input.dispose();
        await this.releaseSession(modelId);
        const message = `${getModelSpec(modelId).label} needs more memory than the CPU backend can provide.`;
        this.unavailable.set(modelId, message);
        throw new ModelUnavailableError(message, modelId);
      }
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

  private session(modelId: string, onProgress?: (p: StageProgress) => void, access?: ModelAccess): Promise<Ort.InferenceSession> {
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
        const options = { graphOptimizationLevel: 'all' } as const;
        const gpu = runtime.executionProviders.includes('webgpu');
        if (!gpu && spec.requiresWebGpu) {
          const message = `${spec.label} needs WebGPU. ${runtime.webgpuStatus ?? 'WebGPU is not available here.'}`;
          this.unavailable.set(modelId, message);
          throw new ModelUnavailableError(message, modelId);
        }
        const cpuModel = () => this.config.loadModel(spec.url, spec.approxBytes, onProgress, access);
        if (gpu) {
          // GPU-specific variant (e.g. fp16) when the model provides one.
          const variant = spec.webgpu ?? { url: spec.url, approxBytes: spec.approxBytes };
          // Download errors (network, gated access) are reported as they are —
          // only a failure to *start* the model means it cannot run here.
          const model = await this.config.loadModel(variant.url, variant.approxBytes, onProgress, access);
          try {
            onProgress?.({ stage: 'removing-background', detail: 'Initialising model (WebGPU)' });
            return await runtime.ort.InferenceSession.create(model, { ...options, executionProviders: runtime.executionProviders });
          } catch (error) {
            if (spec.requiresWebGpu || isOutOfMemory(error)) {
              const message = `${spec.label} could not start on WebGPU: ${error instanceof Error ? error.message : String(error)}. ${runtime.webgpuStatus ?? ''}`.trim();
              this.unavailable.set(modelId, message);
              throw new ModelUnavailableError(message, modelId);
            }
            if (!runtime.executionProviders.includes('wasm')) throw error;
            // WebGPU unusable for this model (adapter limits, missing fp16, unsupported op): use the CPU.
            console.warn('[AssetForge] WebGPU session failed, falling back to CPU:', error);
          }
        }
        const model = await cpuModel();
        onProgress?.({ stage: 'removing-background', detail: 'Initialising model' });
        return runtime.ort.InferenceSession.create(model, { ...options, executionProviders: ['wasm'] });
      })();
      pending.catch(() => this.sessions.delete(modelId));
      this.sessions.set(modelId, pending);
    }
    return pending;
  }

  private async releaseSession(modelId: string): Promise<void> {
    const pending = this.sessions.get(modelId);
    this.sessions.delete(modelId);
    try {
      await (await pending)?.release();
    } catch {
      // Already broken; nothing else to free.
    }
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
  access?: ModelAccess,
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
    const headers: Record<string, string> = {};
    // Tokens are only ever sent to Hugging Face itself (gated model downloads).
    if (access?.huggingFaceToken && /(^|\.)huggingface\.co$/.test(new URL(url).hostname)) {
      headers.Authorization = `Bearer ${access.huggingFaceToken.trim()}`;
    }
    response = await fetch(url, { mode: 'cors', credentials: 'omit', headers });
  } catch (error) {
    throw new Error(
      `Could not download ${label}. Check your internet connection (and that ${new URL(url).host} is allowed). ${String(error)}`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Downloading ${label} was refused (HTTP ${response.status}). This model is gated: accept its licence on huggingface.co while signed in, then enter a Hugging Face access token (read) in the Background settings.`,
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
