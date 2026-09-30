import type { SegmentationRequest, SegmentationResponse } from '../../shared/messages/worker';
import { createBrowserSegmentationRunner } from './ml-runtime';
import { workerScope } from './scope';

/**
 * Dedicated ML worker: owns the only ONNX Runtime session. Each processing
 * worker connects through its own MessagePort; requests are serialised by the
 * runner so a single model instance serves the whole batch.
 */
const scope = workerScope<{ type: 'CONNECT'; port: MessagePort }, never>();

const runner = createBrowserSegmentationRunner();

function serve(port: MessagePort): void {
  port.onmessage = async (event: MessageEvent<SegmentationRequest>) => {
    const request = event.data;
    if (request.type !== 'SEGMENT') return;
    const reply = (message: SegmentationResponse, transfer: Transferable[] = []) => port.postMessage(message, transfer);
    try {
      const mask = await runner.run(request.modelId, request.tensor, request.width, request.height, (progress) =>
        reply({ type: 'SEGMENT_PROGRESS', requestId: request.requestId, progress }),
      );
      reply(
        {
          type: 'SEGMENT_RESULT',
          requestId: request.requestId,
          mask: mask.data,
          width: mask.width,
          height: mask.height,
          backend: (await runner.backend) ?? 'unknown',
        },
        [mask.data.buffer],
      );
    } catch (error) {
      reply({ type: 'SEGMENT_ERROR', requestId: request.requestId, error: error instanceof Error ? error.message : String(error) });
    }
  };
  port.start();
}

scope.onmessage = (event) => {
  if (event.data?.type === 'CONNECT') serve(event.data.port);
};
