import type { SegmentationMask, SegmentationRunner } from '../../image/background-removal/runner';
import type { StageProgress } from '../../image/types';
import type { SegmentationRequest, SegmentationResponse } from '../../shared/messages/worker';

/** Forwards segmentation requests to the shared ML worker over a MessagePort. */
export class RemoteSegmentationRunner implements SegmentationRunner {
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
        case 'SEGMENT_ERROR':
          this.pending.delete(message.requestId);
          entry.reject(new Error(message.error));
          break;
      }
    };
    port.start();
  }

  run(
    modelId: string,
    tensor: Float32Array,
    width: number,
    height: number,
    onProgress?: (p: StageProgress) => void,
  ): Promise<SegmentationMask> {
    const requestId = `seg-${++this.next}`;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, onProgress });
      const request: SegmentationRequest = { type: 'SEGMENT', requestId, modelId, tensor, width, height };
      this.port.postMessage(request, [tensor.buffer]);
    });
  }
}
