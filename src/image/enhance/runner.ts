import type { StageProgress } from '../types';

export interface EnhanceOutput {
  /** NCHW RGB, nominally [0,1]. */
  data: Float32Array;
  width: number;
  height: number;
}

/** Runs a super-resolution model on one 1×3×H×W RGB tile. */
export interface EnhanceRunner {
  enhance(modelId: string, tensor: Float32Array, width: number, height: number, onProgress?: (p: StageProgress) => void): Promise<EnhanceOutput>;
}
