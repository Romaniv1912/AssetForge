import { useCallback, useEffect, useRef, useState } from 'react';
import { CancelledError, type ProcessedImage, type ProcessingOptions, type ProcessingStage } from '../../image/types';
import { FIGMA_MAX_IMAGE_SIDE } from '../../shared/constants';
import type { ApplyMode, ApplyOutcome, SelectedImage } from '../../shared/types';
import { applyToFigma, requestImageBytes } from '../lib/bridge';
import { STAGE_WEIGHTS } from '../lib/format';
import type { ProcessingBackend } from '../processing/backend';

export type ItemStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface BatchItem {
  id: string;
  name: string;
  source: SelectedImage;
  status: ItemStatus;
  stage?: ProcessingStage;
  stageDetail?: string;
  stageFraction?: number;
  result?: ProcessedImage;
  outputUrl?: string;
  sourcePreviewUrl?: string;
  error?: string;
  applied?: ApplyMode;
  applyError?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface BatchState {
  items: BatchItem[];
  running: boolean;
  options: ProcessingOptions | null;
}

/**
 * Batch orchestration with controlled concurrency: at most `backend.concurrency`
 * images are read from Figma and processed at a time, so memory stays bounded
 * regardless of batch size. One failure never stops the batch.
 */
export function useBatch(backend: ProcessingBackend | null) {
  const [state, setState] = useState<BatchState>({ items: [], running: false, options: null });
  const itemsRef = useRef<BatchItem[]>([]);
  const cancelled = useRef(false);
  const generation = useRef(0);

  const commit = useCallback((updater: (items: BatchItem[]) => BatchItem[], extra?: Partial<BatchState>) => {
    itemsRef.current = updater(itemsRef.current);
    setState((prev) => ({ ...prev, ...extra, items: itemsRef.current }));
  }, []);

  const patch = useCallback(
    (id: string, update: Partial<BatchItem>) => commit((items) => items.map((it) => (it.id === id ? { ...it, ...update } : it))),
    [commit],
  );

  const revoke = (items: BatchItem[]) => {
    for (const item of items) {
      if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
      if (item.sourcePreviewUrl) URL.revokeObjectURL(item.sourcePreviewUrl);
    }
  };

  useEffect(() => () => revoke(itemsRef.current), []);

  const processOne = useCallback(
    async (item: BatchItem, options: ProcessingOptions, gen: number) => {
      if (!backend) return;
      patch(item.id, {
        status: 'processing',
        stage: 'loading',
        stageDetail: 'Reading image from Figma',
        stageFraction: undefined,
        error: undefined,
        startedAt: Date.now(),
      });
      try {
        const bytes = await requestImageBytes(item.source.hash);
        if (cancelled.current || gen !== generation.current) throw new CancelledError();
        const payload = await backend.process(
          item.id,
          bytes,
          options,
          (progress) => {
            if (gen !== generation.current) return;
            patch(item.id, { stage: progress.stage, stageDetail: progress.detail, stageFraction: progress.fraction });
          },
          item.source.crop,
        );
        if (gen !== generation.current) return;
        const { result, sourcePreview } = payload;
        const outputUrl = URL.createObjectURL(new Blob([result.data as BlobPart], { type: result.mimeType }));
        const sourcePreviewUrl = sourcePreview
          ? URL.createObjectURL(new Blob([sourcePreview as BlobPart], { type: 'image/webp' }))
          : undefined;
        patch(item.id, {
          status: 'completed',
          stage: 'complete',
          stageDetail: undefined,
          result,
          outputUrl,
          sourcePreviewUrl,
          finishedAt: Date.now(),
        });
      } catch (error) {
        if (gen !== generation.current) return;
        const wasCancelled = error instanceof CancelledError || cancelled.current;
        patch(item.id, {
          status: wasCancelled ? 'cancelled' : 'failed',
          error: wasCancelled ? 'Cancelled' : error instanceof Error ? error.message : String(error),
          finishedAt: Date.now(),
        });
      }
    },
    [backend, patch],
  );

  const runQueue = useCallback(
    async (ids: string[], options: ProcessingOptions, gen: number) => {
      if (!backend) return;
      let next = 0;
      const lane = async () => {
        while (next < ids.length && !cancelled.current && gen === generation.current) {
          const id = ids[next++];
          const item = itemsRef.current.find((it) => it.id === id);
          if (item) await processOne(item, options, gen);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, backend.concurrency) }, lane));
      if (gen !== generation.current) return;
      if (cancelled.current) {
        commit((items) => items.map((it) => (it.status === 'pending' ? { ...it, status: 'cancelled', error: 'Cancelled' } : it)));
      }
      commit((items) => items, { running: false });
      backend.releaseMemory();
    },
    [backend, commit, processOne],
  );

  const start = useCallback(
    (images: SelectedImage[], options: ProcessingOptions) => {
      if (!backend || images.length === 0) return;
      revoke(itemsRef.current);
      const gen = ++generation.current;
      cancelled.current = false;
      const items: BatchItem[] = images.map((image) => ({ id: image.id, name: image.name, source: image, status: 'pending' }));
      commit(() => items, { running: true, options });
      void runQueue(
        items.map((it) => it.id),
        options,
        gen,
      );
    },
    [backend, commit, runQueue],
  );

  const retry = useCallback(
    (ids: string[]) => {
      const options = state.options;
      if (!backend || !options || state.running) return;
      const gen = generation.current;
      cancelled.current = false;
      commit(
        (items) =>
          items.map((it) => {
            if (!ids.includes(it.id)) return it;
            if (it.outputUrl) URL.revokeObjectURL(it.outputUrl);
            if (it.sourcePreviewUrl) URL.revokeObjectURL(it.sourcePreviewUrl);
            return { id: it.id, name: it.name, source: it.source, status: 'pending' };
          }),
        { running: true },
      );
      void runQueue(ids, options, gen);
    },
    [backend, commit, runQueue, state.options, state.running],
  );

  const cancel = useCallback(() => {
    if (!backend) return;
    cancelled.current = true;
    backend.cancelAll();
  }, [backend]);

  const clear = useCallback(() => {
    if (state.running) return;
    revoke(itemsRef.current);
    generation.current++;
    commit(() => [], { running: false, options: null });
  }, [commit, state.running]);

  const apply = useCallback(
    async (mode: ApplyMode, matchAspectRatio: boolean): Promise<ApplyOutcome[]> => {
      if (!backend) return [];
      const ready = itemsRef.current.filter((it) => it.status === 'completed' && it.result);
      const payload = [];
      const failures: ApplyOutcome[] = [];
      for (const item of ready) {
        const result = item.result!;
        if (result.width > FIGMA_MAX_IMAGE_SIDE || result.height > FIGMA_MAX_IMAGE_SIDE) {
          failures.push({
            imageId: item.id,
            ok: false,
            updatedNodes: 0,
            warnings: [],
            error: `Figma accepts images up to ${FIGMA_MAX_IMAGE_SIDE}×${FIGMA_MAX_IMAGE_SIDE} px; enable Resize to fit (download is unaffected).`,
          });
          continue;
        }
        try {
          const figmaBytes =
            result.format === 'png' || result.format === 'jpeg'
              ? { bytes: result.data.slice(), width: result.width, height: result.height, format: result.format }
              : await backend.encodeForFigma(result.data);
          payload.push({
            imageId: item.id,
            imageHash: item.source.hash,
            cropped: item.source.crop !== null,
            name: item.name,
            bytes: figmaBytes.bytes,
            width: figmaBytes.width,
            height: figmaBytes.height,
            // Size of what was processed (the visible crop, if any).
            sourceWidth: result.placement.sourceWidth,
            sourceHeight: result.placement.sourceHeight,
            targets: item.source.targets,
            label: `${result.format.toUpperCase()} ${result.width}×${result.height}`,
          });
        } catch (error) {
          failures.push({ imageId: item.id, ok: false, updatedNodes: 0, warnings: [], error: String(error) });
        }
      }
      const outcomes = payload.length ? await applyToFigma(mode, matchAspectRatio, payload) : [];
      const all = [...outcomes, ...failures];
      commit((items) =>
        items.map((it) => {
          const outcome = all.find((o) => o.imageId === it.id);
          if (!outcome) return it;
          return outcome.ok
            ? { ...it, applied: mode, applyError: outcome.error }
            : { ...it, applyError: outcome.error ?? 'Could not update the layer' };
        }),
      );
      return all;
    },
    [backend, commit],
  );

  return { state, start, retry, cancel, clear, apply };
}

/** Overall progress in [0, 1] including partial progress of running items. */
export function batchProgress(items: BatchItem[]): number {
  if (items.length === 0) return 0;
  let total = 0;
  for (const item of items) {
    if (item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled') total += 1;
    else if (item.status === 'processing' && item.stage) {
      const [start, span] = STAGE_WEIGHTS[item.stage];
      total += start + span * (item.stageFraction ?? 0.3);
    }
  }
  return Math.min(1, total / items.length);
}
