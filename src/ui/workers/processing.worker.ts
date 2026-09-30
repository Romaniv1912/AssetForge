import { setWasmBinaryProvider, type WasmBinaryName } from '../../image/codecs/wasm-provider';
import { CancelledError } from '../../image/types';
import type { ProcessingRequest, ProcessingResponse } from '../../shared/messages/worker';
import { encodeForFigma, executeJob, releaseCodecMemory } from '../processing/executor';
import { RemoteSegmentationRunner } from './remote-segmentation';
import { workerScope } from './scope';

/**
 * Processing worker: runs the full pipeline (decode, crop, resize, codecs,
 * perceptual search, validation) off the UI thread.
 */
const scope = workerScope<ProcessingRequest, ProcessingResponse>();
const post = (message: ProcessingResponse, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

// Codec binaries are embedded once in the UI bundle and requested on demand,
// rather than being duplicated inside every worker bundle.
const wasmRequests = new Map<WasmBinaryName, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();
setWasmBinaryProvider({
  load: (name) =>
    new Promise<Uint8Array>((resolve, reject) => {
      wasmRequests.set(name, { resolve, reject });
      post({ type: 'WASM_REQUEST', name });
    }),
});

let segmentation: RemoteSegmentationRunner | undefined;
const tokens = new Map<string, { cancelled: boolean }>();

scope.onmessage = async (event) => {
  const message = event.data;
  switch (message.type) {
    case 'INIT':
      segmentation = message.mlPort ? new RemoteSegmentationRunner(message.mlPort) : undefined;
      post({ type: 'READY' });
      break;

    case 'WASM_BINARY': {
      const pending = wasmRequests.get(message.name);
      wasmRequests.delete(message.name);
      if (!pending) break;
      if (message.bytes) pending.resolve(message.bytes);
      else pending.reject(new Error(message.error ?? `Codec ${message.name} unavailable`));
      break;
    }

    case 'PROCESS': {
      const token = { cancelled: false };
      tokens.set(message.jobId, token);
      try {
        const payload = await executeJob(message.bytes, message.options, message.previewSize, segmentation, token, (progress) =>
          post({ type: 'PROGRESS', jobId: message.jobId, progress }),
        );
        const transfer: Transferable[] = [payload.result.data.buffer as ArrayBuffer];
        if (payload.sourcePreview) transfer.push(payload.sourcePreview.buffer as ArrayBuffer);
        post({ type: 'RESULT', jobId: message.jobId, payload }, transfer);
      } catch (error) {
        post({
          type: 'ERROR',
          jobId: message.jobId,
          error: error instanceof Error ? error.message : String(error),
          cancelled: error instanceof CancelledError,
        });
      } finally {
        tokens.delete(message.jobId);
      }
      break;
    }

    case 'CANCEL': {
      const token = tokens.get(message.jobId);
      if (token) token.cancelled = true;
      break;
    }

    case 'ENCODE_FOR_FIGMA':
      try {
        const out = await encodeForFigma(message.bytes);
        post({ type: 'FIGMA_BYTES', jobId: message.jobId, ...out }, [out.bytes.buffer as ArrayBuffer]);
      } catch (error) {
        post({ type: 'ERROR', jobId: message.jobId, error: error instanceof Error ? error.message : String(error), cancelled: false });
      }
      break;

    case 'RELEASE_MEMORY':
      releaseCodecMemory();
      break;
  }
};
