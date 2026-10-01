import { ModelUnavailableError, type SegmentationMask, type SegmentationRunner } from '../../image/background-removal/runner';
import type { EnhanceOutput, EnhanceRunner } from '../../image/enhance/runner';
import type { StageProgress } from '../../image/types';
import type { SegmentationRequest, SegmentationResponse } from '../../shared/messages/worker';

/** Forwards segmentation and AI-upscale requests to the shared ML worker over a MessagePort. */
export class RemoteSegmentationRunner implements SegmentationRunner, EnhanceRunner {
  private next = 0;
  private readonly pending = new Map<
    string,
    { resolve: (mask: SegmentationMask) => void; reject: (error: Error) => void; onProgress?: (p: StageProgress) => void }
  >();

  constructor(private readonly port: MessagePort) {
    port.onmessage = (event: MessageEvent<SegmentationResponse>) => {
      const message = event.data;
      const entry = this.pending.get(message.requestId);
      if (!entry) return;
      switch (message.type) {
        case 'SEGMENT_PROGRESS':
          entry.onProgress?.(message.progress);
          break;
        case 'SEGMENT_RESULT':
          this.pending.delete(message.requestId);
          entry.resolve({ data: message.mask, width: message.width, height: message.height });
          break;
        case 'ENHANCE_RESULT':
          this.pending.delete(message.requestId);
          entry.resolve({ data: message.data, width: message.width, height: message.height });
          break;
        case 'SEGMENT_ERROR':
          this.pending.delete(message.requestId);
          entry.reject(message.unavailableModel ? new ModelUnavailableError(message.error, message.unavailableModel) : new Error(message.error));
          break;
      }
    };
    port.start();
  }

  enhance(modelId: string, tensor: Float32Array, width: number, height: number, onProgress?: (p: StageProgress) => void): Promise<EnhanceOutput> {
    return this.send('ENHANCE', modelId, tensor, width, height, onProgress);
  }

  run(
    modelId: string,
    tensor: Float32Array,
    width: number,
    height: number,
    onProgress?: (p: StageProgress) => void,
  ): Promise<SegmentationMask> {
    return this.send('SEGMENT', modelId, tensor, width, height, onProgress);
  }

  private send(
    type: SegmentationRequest['type'],
    modelId: string,
    tensor: Float32Array,
    width: number,
    height: number,
    onProgress?: (p: StageProgress) => void,
  ): Promise<SegmentationMask> {
    const requestId = `ml-${++this.next}`;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, onProgress });
      const request: SegmentationRequest = { type, requestId, modelId, tensor, width, height };
      this.port.postMessage(request, [tensor.buffer]);
    });
  }
}
