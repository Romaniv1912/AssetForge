import type { StageProgress } from '../types';

export interface SegmentationMask {
  /** Row-major values; usually in [0,1] but raw model output is accepted. */
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * Runs a segmentation model on a prepared NCHW float tensor.
 *
 * Implementations: ONNX Runtime Web (browser worker, Node), or a proxy that
 * forwards to a dedicated ML worker. A remote HTTP implementation could be
 * added behind the same interface without touching the pipeline.
 */
/**
 * The model cannot run in this environment (needs WebGPU, or the backend ran
 * out of memory). Callers may retry with the model's `fallback`.
 */
export class ModelUnavailableError extends Error {
  constructor(
    message: string,
    readonly modelId: string,
  ) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

/** ONNX Runtime / WebAssembly failures that mean "not enough memory". */
export function isOutOfMemory(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${error.stack ?? ''}` : String(error);
  return /bad_alloc|out of memory|Out of memory|Cannot enlarge memory|memory access out of bounds|ERROR_CODE: 6/i.test(text);
}

export interface SegmentationRunner {
  run(
    modelId: string,
    tensor: Float32Array,
    width: number,
    height: number,
    onProgress?: (progress: StageProgress) => void,
  ): Promise<SegmentationMask>;
}
