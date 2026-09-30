import type { CompressionPreset, QualityMetrics } from '../types';

/**
 * Perceptual acceptance thresholds per preset.
 *
 * The values were tuned with `npm run benchmark` (see README → "Tuning the
 * presets") on photos, avatars, transparent illustrations, flat graphics,
 * gradients and detailed images. SSIM here is the weighted Y/Cb/Cr SSIM of
 * `metrics/ssim.ts`; `worstBlockSsim` is its 1st-percentile local luma SSIM.
 *
 * Quality floors stop the search from choosing absurdly low encoder settings
 * on content where SSIM is forgiving (e.g. film grain or noise).
 */
export interface QualityTarget {
  minSsim: number;
  minWorstBlockSsim: number;
  /** Encoder quality search ranges (inclusive). */
  jpeg: [number, number];
  webp: [number, number];
  avif: [number, number];
  /** Smallest palette the lossy PNG path may use. */
  minPaletteColors: number;
  /** Allow the lossy (quantised) PNG path at all. */
  allowPngQuantization: boolean;
  /** Dithering strength for quantised PNG. */
  dithering: number;
  /** WebP alpha plane quality (100 = lossless alpha). */
  webpAlphaQuality: number;
}

export const QUALITY_TARGETS: Record<Exclude<CompressionPreset, 'custom'>, QualityTarget> = {
  maximum: {
    minSsim: 0.993,
    minWorstBlockSsim: 0.965,
    jpeg: [82, 99],
    webp: [82, 100],
    avif: [72, 99],
    minPaletteColors: 256,
    allowPngQuantization: true,
    dithering: 1,
    webpAlphaQuality: 100,
  },
  high: {
    minSsim: 0.985,
    minWorstBlockSsim: 0.93,
    jpeg: [70, 98],
    webp: [70, 100],
    avif: [60, 97],
    minPaletteColors: 64,
    allowPngQuantization: true,
    dithering: 1,
    webpAlphaQuality: 100,
  },
  balanced: {
    minSsim: 0.975,
    minWorstBlockSsim: 0.89,
    jpeg: [58, 97],
    webp: [58, 98],
    avif: [48, 95],
    minPaletteColors: 32,
    allowPngQuantization: true,
    dithering: 0.9,
    webpAlphaQuality: 100,
  },
  small: {
    minSsim: 0.96,
    minWorstBlockSsim: 0.83,
    jpeg: [45, 96],
    webp: [45, 97],
    avif: [36, 93],
    minPaletteColors: 16,
    allowPngQuantization: true,
    dithering: 0.8,
    webpAlphaQuality: 90,
  },
};

export function meetsTarget(metrics: QualityMetrics, target: Pick<QualityTarget, 'minSsim' | 'minWorstBlockSsim'>): boolean {
  return metrics.ssim >= target.minSsim && metrics.worstBlockSsim >= target.minWorstBlockSsim;
}

export const PRESET_LABELS: Record<CompressionPreset, string> = {
  maximum: 'Maximum',
  high: 'High',
  balanced: 'Balanced',
  small: 'Small',
  custom: 'Custom',
};

export const PRESET_DESCRIPTIONS: Record<CompressionPreset, string> = {
  maximum: 'Visually lossless. Prioritises quality over size.',
  high: 'Very high visual quality with meaningful compression.',
  balanced: 'Good visual quality, aggressive compression.',
  small: 'Minimum file size while remaining visually usable.',
  custom: 'Fixed encoder quality — no perceptual search.',
};
