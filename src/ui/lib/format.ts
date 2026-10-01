import type { ProcessingStage } from '../../image/types';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

/** Signed percentage change, e.g. "-82.5%". */
export function formatChange(original: number, output: number): string {
  if (original <= 0) return '—';
  const change = (output / original - 1) * 100;
  return `${change > 0 ? '+' : ''}${change.toFixed(1)}%`;
}

export function formatSaved(original: number, output: number): string {
  if (original <= 0) return '—';
  return `${((1 - output / original) * 100).toFixed(1)}%`;
}

export function formatDimensions(width: number | null | undefined, height: number | null | undefined): string {
  return width && height ? `${width}×${height}` : '—';
}

export const STAGE_LABELS: Record<ProcessingStage, string> = {
  loading: 'Loading',
  analyzing: 'Analyzing',
  enhancing: 'Enhancing (AI upscale)',
  'removing-background': 'Removing background',
  cropping: 'Cropping',
  resizing: 'Resizing',
  compressing: 'Compressing',
  validating: 'Validating',
  complete: 'Complete',
};

/** Rough share of total work per stage, used for a smooth overall progress bar. */
export const STAGE_WEIGHTS: Record<ProcessingStage, [start: number, span: number]> = {
  loading: [0, 0.05],
  analyzing: [0.05, 0.03],
  enhancing: [0.08, 0.2],
  'removing-background': [0.28, 0.12],
  cropping: [0.4, 0.02],
  resizing: [0.42, 0.04],
  compressing: [0.46, 0.46],
  validating: [0.92, 0.08],
  complete: [1, 0],
};

export function formatMetric(value: number, digits = 4): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '∞';
}
