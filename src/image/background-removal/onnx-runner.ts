import type * as Ort from 'onnxruntime-web';
import type { StageProgress } from '../types';
import { getEnhanceModelSpec } from '../enhance/models';
import type { EnhanceOutput, EnhanceRunner } from '../enhance/runner';
import { getModelSpec } from './models';
import { isOutOfMemory, ModelUnavailableError, type SegmentationMask, type SegmentationRunner } from './runner';

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
  /** Downloads (or reads from cache) a model file. `label` names it in progress messages. */
  loadModel: (url: string, approxBytes: number, onProgress?: (p: StageProgress) => void, label?: string) => Promise<Uint8Array>;
}

/** What a session needs to know about a model (segmentation or enhance). */
interface SessionSource {
  id: string;
  label: string;
  url: string;
  approxBytes: number;
  requiresWebGpu?: boolean;
  webgpu?: { url: string; approxBytes: number };
}

/**
 * ONNX Runtime host for background segmentation and AI upscaling. One session
 * per model is created lazily and reused for every image (the model is never
 * reloaded per image); inference is serialised across both tasks.
 */
export class OnnxSegmentationRunner implements SegmentationRunner, EnhanceRunner {
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
  ): Promise<SegmentationMask> {
    const task = this.queue.then(async () => {
      const known = this.unavailable.get(modelId);
      if (known) throw new ModelUnavailableError(known, modelId);
      const session = await this.session(getModelSpec(modelId), onProgress, 'background model', 'removing-background');
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

  /** Runs one 1×3×H×W tile through a super-resolution model. */
  async enhance(
    modelId: string,
    tensor: Float32Array,
    width: number,
    height: number,
    onProgress?: (p: StageProgress) => void,
  ): Promise<EnhanceOutput> {
    const task = this.queue.then(async () => {
      const spec = getEnhanceModelSpec(modelId);
      const session = await this.session(spec, onProgress, 'AI upscale model', 'enhancing');
      const { ort } = await this.runtime!;
      const input = new ort.Tensor('float32', tensor, [1, 3, height, width]);
      let results: Ort.InferenceSession.OnnxValueMapType | undefined;
      try {
        results = await session.run({ [session.inputNames[0]!]: input });
        const output = results[session.outputNames[0]!]!;
        const dims = output.dims;
        const data = new Float32Array((await output.getData()) as Float32Array);
        return { data, width: Number(dims[dims.length - 1]), height: Number(dims[dims.length - 2]) };
      } finally {
        input.dispose();
        for (const t of Object.values(results ?? {})) t.dispose();
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private session(
    spec: SessionSource,
    onProgress: ((p: StageProgress) => void) | undefined,
    label: string,
    stage: StageProgress['stage'],
  ): Promise<Ort.InferenceSession> {
    const modelId = spec.id;
    // Downloads and initialisation are reported under the caller's stage.
    const report = onProgress && ((p: StageProgress) => onProgress({ ...p, stage }));
    let pending = this.sessions.get(modelId);
    if (!pending) {
      pending = (async () => {
        this.runtime ??= this.config.loadRuntime(report);
        let runtime: OrtRuntime;
        try {
          runtime = await this.runtime;
        } catch (error) {
          this.runtime = undefined;
          throw error;
        }
        const options = { graphOptimizationLevel: 'all' } as const;
        const gpu = runtime.executionProviders.includes('webgpu');
        if (!gpu && spec.requiresWebGpu) {
          const message = `${spec.label} needs WebGPU. ${runtime.webgpuStatus ?? 'WebGPU is not available here.'}`;
          this.unavailable.set(modelId, message);
          throw new ModelUnavailableError(message, modelId);
        }
        const cpuModel = () => this.config.loadModel(spec.url, spec.approxBytes, report, label);
        if (gpu) {
          // GPU-specific variant (e.g. fp16) when the model provides one.
          const variant = spec.webgpu ?? { url: spec.url, approxBytes: spec.approxBytes };
          // Download errors (network, access) are reported as they are —
          // only a failure to *start* the model means it cannot run here.
          const model = await this.config.loadModel(variant.url, variant.approxBytes, report, label);
          try {
            report?.({ stage, detail: 'Initialising model (WebGPU)' });
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
        report?.({ stage, detail: 'Initialising model' });
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
