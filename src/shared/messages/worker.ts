import type { WasmBinaryName } from '../../image/codecs/wasm-provider';
import type { ProcessedImage, ProcessingOptions, StageProgress } from '../../image/types';

/**
 * Protocol between the UI thread and the processing workers.
 *
 * Topology:
 *   UI thread ──(ProcessingRequest)──▶ processing worker ×N (codecs, pipeline)
 *   processing worker ──(SegmentationRequest via MessagePort)──▶ ML worker ×1 (ONNX Runtime)
 * A single ML worker keeps exactly one copy of the model in memory.
 */

export type ProcessingRequest =
  | { type: 'INIT'; mlPort: MessagePort | null }
  | { type: 'PROCESS'; jobId: string; name: string; bytes: Uint8Array; options: ProcessingOptions; previewSize: number }
  | { type: 'CANCEL'; jobId: string }
  | { type: 'ENCODE_FOR_FIGMA'; jobId: string; bytes: Uint8Array }
  | { type: 'WASM_BINARY'; name: WasmBinaryName; bytes: Uint8Array | null; error?: string }
  | { type: 'RELEASE_MEMORY' };

export interface ProcessingResultPayload {
  result: ProcessedImage;
  /** Small WebP thumbnail of the source for list views. */
  sourcePreview: Uint8Array | null;
}

export type ProcessingResponse =
  | { type: 'READY' }
  | { type: 'PROGRESS'; jobId: string; progress: StageProgress }
  | { type: 'RESULT'; jobId: string; payload: ProcessingResultPayload }
  | { type: 'ERROR'; jobId: string; error: string; cancelled: boolean }
  | { type: 'FIGMA_BYTES'; jobId: string; bytes: Uint8Array; format: 'png' | 'jpeg'; width: number; height: number }
  | { type: 'WASM_REQUEST'; name: WasmBinaryName };

export type SegmentationRequest = {
  type: 'SEGMENT';
  requestId: string;
  modelId: string;
  tensor: Float32Array;
  width: number;
  height: number;
};

export type SegmentationResponse =
  | { type: 'SEGMENT_PROGRESS'; requestId: string; progress: StageProgress }
  | { type: 'SEGMENT_RESULT'; requestId: string; mask: Float32Array; width: number; height: number; backend: string }
  | { type: 'SEGMENT_ERROR'; requestId: string; error: string; unavailableModel?: string };
