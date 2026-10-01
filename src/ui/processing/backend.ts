import { CODEC_WASM_BASE64 } from 'virtual:assetforge-codec-wasm';
import { base64ToBytes, base64WasmProvider } from '../../image/codecs/providers/base64';
import { setWasmBinaryProvider, type WasmBinaryName } from '../../image/codecs/wasm-provider';
import type { SegmentationRunner } from '../../image/background-removal/runner';
import { CancelledError, type NormalizedRect, type ProcessingOptions, type StageProgress } from '../../image/types';
import type { ProcessingRequest, ProcessingResponse, ProcessingResultPayload } from '../../shared/messages/worker';
import MlWorker from '../workers/ml.worker?worker&inline';
import ProcessingWorker from '../workers/processing.worker?worker&inline';

export interface FigmaEncoded {
  bytes: Uint8Array;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
}

/**
 * Where jobs run. The worker pool is preferred; if the host blocks workers
 * the same code runs on the UI thread (slower, but still fully functional).
 */
export interface ProcessingBackend {
  readonly kind: 'workers' | 'inline';
  readonly concurrency: number;
  process(
    jobId: string,
    bytes: Uint8Array,
    options: ProcessingOptions,
    onProgress: (p: StageProgress) => void,
    crop?: NormalizedRect | null,
  ): Promise<ProcessingResultPayload>;
  cancel(jobId: string): void;
  /** Stops everything immediately (workers are terminated and respawned). */
  cancelAll(): void;
  encodeForFigma(bytes: Uint8Array): Promise<FigmaEncoded>;
  releaseMemory(): void;
  dispose(): void;
}

export const PREVIEW_SIZE = 160;

export function defaultConcurrency(): number {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  if (memory <= 4) return 1;
  return Math.max(1, Math.min(3, Math.floor(cores / 2)));
}

const decodedBinaries = new Map<WasmBinaryName, Uint8Array>();
function binary(name: WasmBinaryName): Uint8Array {
  let bytes = decodedBinaries.get(name);
  if (!bytes) {
    const encoded = CODEC_WASM_BASE64[name];
    if (!encoded) throw new Error(`Codec binary "${name}" is not bundled`);
    bytes = base64ToBytes(encoded);
    decodedBinaries.set(name, bytes);
  }
  return bytes;
}

type Task =
  | {
      kind: 'process';
      jobId: string;
      bytes: Uint8Array;
      options: ProcessingOptions;
      crop: NormalizedRect | null;
      onProgress: (p: StageProgress) => void;
      resolve: (payload: ProcessingResultPayload) => void;
      reject: (error: Error) => void;
    }
  | {
      kind: 'figma';
      jobId: string;
      bytes: Uint8Array;
      resolve: (payload: FigmaEncoded) => void;
      reject: (error: Error) => void;
    };

interface Slot {
  worker: Worker;
  task: Task | null;
}

class WorkerBackend implements ProcessingBackend {
  readonly kind = 'workers' as const;
  private slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private mlWorker: Worker;
  private figmaCounter = 0;
  private disposed = false;

  constructor(readonly concurrency: number) {
    this.mlWorker = new MlWorker();
    for (let i = 0; i < concurrency; i++) this.slots.push(this.spawn());
  }

  /** Resolves once a worker answered, proving that workers + WASM run in this host. */
  static async create(concurrency: number, timeoutMs = 4000): Promise<WorkerBackend> {
    const backend = new WorkerBackend(concurrency);
    const probe = backend.slots[0]!.worker;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker did not start')), timeoutMs);
      const listener = (event: MessageEvent<ProcessingResponse>) => {
        if (event.data.type === 'READY') {
          clearTimeout(timer);
          probe.removeEventListener('message', listener);
          resolve();
        }
      };
      probe.addEventListener('message', listener);
      probe.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Worker failed to start'));
      });
    }).catch((error) => {
      backend.dispose();
      throw error;
    });
    return backend;
  }

  private spawn(): Slot {
    const worker = new ProcessingWorker();
    const slot: Slot = { worker, task: null };
    const channel = new MessageChannel();
    this.mlWorker.postMessage({ type: 'CONNECT', port: channel.port2 }, [channel.port2]);
    worker.onmessage = (event: MessageEvent<ProcessingResponse>) => this.onMessage(slot, event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      const task = slot.task;
      slot.task = null;
      task?.reject(new Error(`Worker crashed: ${event.message || 'out of memory?'}`));
      this.replace(slot);
    };
    const init: ProcessingRequest = { type: 'INIT', mlPort: channel.port1 };
    worker.postMessage(init, [channel.port1]);
    return slot;
  }

  private replace(slot: Slot): void {
    slot.worker.terminate();
    if (this.disposed) return;
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots[index] = this.spawn();
    this.pump();
  }

  private onMessage(slot: Slot, message: ProcessingResponse): void {
    const task = slot.task;
    switch (message.type) {
      case 'WASM_REQUEST': {
        let reply: ProcessingRequest;
        try {
          reply = { type: 'WASM_BINARY', name: message.name, bytes: binary(message.name) };
        } catch (error) {
          reply = { type: 'WASM_BINARY', name: message.name, bytes: null, error: String(error) };
        }
        slot.worker.postMessage(reply);
        return;
      }
      case 'PROGRESS':
        if (task?.kind === 'process' && task.jobId === message.jobId) task.onProgress(message.progress);
        return;
      case 'RESULT':
        if (task?.kind === 'process' && task.jobId === message.jobId) {
          slot.task = null;
          task.resolve(message.payload);
          this.pump();
        }
        return;
      case 'FIGMA_BYTES':
        if (task?.kind === 'figma' && task.jobId === message.jobId) {
          slot.task = null;
          task.resolve({ bytes: message.bytes, format: message.format, width: message.width, height: message.height });
          this.pump();
        }
        return;
      case 'ERROR':
        if (task && task.jobId === message.jobId) {
          slot.task = null;
          task.reject(message.cancelled ? new CancelledError() : new Error(message.error));
          this.pump();
        }
        return;
      case 'READY':
        this.pump();
        return;
    }
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.task || this.queue.length === 0) continue;
      const task = this.queue.shift()!;
      slot.task = task;
      if (task.kind === 'process') {
        const request: ProcessingRequest = {
          type: 'PROCESS',
          jobId: task.jobId,
          name: task.jobId,
          bytes: task.bytes,
          options: task.options,
          previewSize: PREVIEW_SIZE,
          crop: task.crop,
        };
        // The source bytes are transferred: the UI thread keeps no copy.
        slot.worker.postMessage(request, [task.bytes.buffer as ArrayBuffer]);
      } else {
        slot.worker.postMessage({ type: 'ENCODE_FOR_FIGMA', jobId: task.jobId, bytes: task.bytes } satisfies ProcessingRequest);
      }
    }
  }

  process(jobId: string, bytes: Uint8Array, options: ProcessingOptions, onProgress: (p: StageProgress) => void, crop: NormalizedRect | null = null) {
    return new Promise<ProcessingResultPayload>((resolve, reject) => {
      this.queue.push({ kind: 'process', jobId, bytes, options, crop, onProgress, resolve, reject });
      this.pump();
    });
  }

  encodeForFigma(bytes: Uint8Array) {
    return new Promise<FigmaEncoded>((resolve, reject) => {
      this.queue.push({ kind: 'figma', jobId: `figma-${++this.figmaCounter}`, bytes: bytes.slice(), resolve, reject });
      this.pump();
    });
  }

  cancel(jobId: string): void {
    const queued = this.queue.findIndex((t) => t.jobId === jobId);
    if (queued >= 0) {
      const [task] = this.queue.splice(queued, 1);
      task!.reject(new CancelledError());
      return;
    }
    for (const slot of this.slots) {
      if (slot.task?.jobId === jobId) slot.worker.postMessage({ type: 'CANCEL', jobId } satisfies ProcessingRequest);
    }
  }

  cancelAll(): void {
    for (const task of this.queue.splice(0)) task.reject(new CancelledError());
    for (const slot of [...this.slots]) {
      if (!slot.task) continue;
      const task = slot.task;
      slot.task = null;
      task.reject(new CancelledError());
      this.replace(slot);
    }
  }

  releaseMemory(): void {
    for (const slot of this.slots) slot.worker.postMessage({ type: 'RELEASE_MEMORY' } satisfies ProcessingRequest);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAll();
    for (const slot of this.slots) slot.worker.terminate();
    this.slots = [];
    this.mlWorker.terminate();
  }
}

/** Fallback when the host does not allow Web Workers. */
class InlineBackend implements ProcessingBackend {
  readonly kind = 'inline' as const;
  readonly concurrency = 1;
  private readonly tokens = new Map<string, { cancelled: boolean }>();
  private chain: Promise<unknown> = Promise.resolve();
  private segmentation: Promise<SegmentationRunner> | undefined;

  constructor() {
    setWasmBinaryProvider(base64WasmProvider(CODEC_WASM_BASE64));
  }

  private runner(): Promise<SegmentationRunner> {
    this.segmentation ??= import('../workers/ml-runtime').then((m) => m.createBrowserSegmentationRunner());
    return this.segmentation;
  }

  process(jobId: string, bytes: Uint8Array, options: ProcessingOptions, onProgress: (p: StageProgress) => void, crop: NormalizedRect | null = null) {
    const token = { cancelled: false };
    this.tokens.set(jobId, token);
    const run = this.chain.then(async () => {
      const { executeJob } = await import('./executor');
      const segmentation = options.backgroundRemoval.enabled ? await this.runner() : undefined;
      try {
        return await executeJob(bytes, options, PREVIEW_SIZE, segmentation, token, onProgress, crop);
      } finally {
        this.tokens.delete(jobId);
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async encodeForFigma(bytes: Uint8Array) {
    const { encodeForFigma } = await import('./executor');
    return encodeForFigma(bytes);
  }

  cancel(jobId: string): void {
    const token = this.tokens.get(jobId);
    if (token) token.cancelled = true;
  }

  cancelAll(): void {
    for (const token of this.tokens.values()) token.cancelled = true;
  }

  releaseMemory(): void {
    void import('./executor').then((m) => m.releaseCodecMemory());
  }

  dispose(): void {
    this.cancelAll();
  }
}

export async function createProcessingBackend(): Promise<ProcessingBackend> {
  try {
    return await WorkerBackend.create(defaultConcurrency());
  } catch (error) {
    console.warn('[AssetForge] Web Workers unavailable, processing on the UI thread:', error);
    return new InlineBackend();
  }
}
