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
export interface SegmentationRunner {
  run(
    modelId: string,
    tensor: Float32Array,
    width: number,
    height: number,
    onProgress?: (progress: StageProgress) => void,
  ): Promise<SegmentationMask>;
}
