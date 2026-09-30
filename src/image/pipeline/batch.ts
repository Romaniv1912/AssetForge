import { CancelledError, type CancellationToken, type ProcessedImage, type ProcessingOptions, type StageProgress } from '../types';
import { processImage, type PipelineContext } from './process-image';

export interface BatchInput {
  id: string;
  /** Loaded lazily so only `concurrency` sources are in memory at once. */
  load: () => Promise<Uint8Array>;
}

export type BatchItemResult =
  | { id: string; status: 'completed'; result: ProcessedImage }
  | { id: string; status: 'failed'; error: string }
  | { id: string; status: 'cancelled' };

export interface BatchOptions {
  concurrency?: number;
  cancel?: CancellationToken;
  onProgress?: (id: string, progress: StageProgress) => void;
  onItem?: (item: BatchItemResult) => void;
}

/**
 * Figma-independent batch runner (CLI, services, tests). Items are processed
 * with bounded concurrency; a failure is recorded and the batch continues.
 * The Figma UI uses the same policy in `useBatch`, with Figma I/O in between.
 */
export async function processBatch(
  inputs: BatchInput[],
  options: ProcessingOptions,
  ctx: Omit<PipelineContext, 'cancel' | 'onProgress'> = {},
  batch: BatchOptions = {},
): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = new Array(inputs.length);
  const concurrency = Math.max(1, batch.concurrency ?? 2);
  let next = 0;

  const lane = async () => {
    while (next < inputs.length) {
      const index = next++;
      const input = inputs[index]!;
      let outcome: BatchItemResult;
      if (batch.cancel?.cancelled) {
        outcome = { id: input.id, status: 'cancelled' };
      } else {
        try {
          const bytes = await input.load();
          const result = await processImage(bytes, options, {
            ...ctx,
            cancel: batch.cancel,
            onProgress: (p) => batch.onProgress?.(input.id, p),
          });
          outcome = { id: input.id, status: 'completed', result };
        } catch (error) {
          outcome =
            error instanceof CancelledError
              ? { id: input.id, status: 'cancelled' }
              : { id: input.id, status: 'failed', error: error instanceof Error ? error.message : String(error) };
        }
      }
      results[index] = outcome;
      batch.onItem?.(outcome);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, lane));
  return results;
}
