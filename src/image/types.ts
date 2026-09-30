/**
 * Core types of the AssetForge processing engine.
 *
 * The engine is deliberately independent from Figma and from the DOM: it works
 * on raw RGBA buffers and encoded byte arrays, so it can be reused by a CLI,
 * a backend service or an asset pipeline.
 */

/** Non-premultiplied, 8-bit sRGB RGBA pixels, row-major, no padding. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'avif' | 'gif' | 'bmp' | 'unknown';

/** Formats the engine can write. */
export type EncodableFormat = 'png' | 'jpeg' | 'webp' | 'avif';

/**
 * `original` keeps the source format (TinyPNG behaviour: PNG → PNG, JPEG → JPEG,
 * WebP → WebP, AVIF → AVIF). `auto` picks whichever format is smallest.
 */
export type OutputFormat = 'original' | 'auto' | EncodableFormat;

export type CompressionPreset = 'maximum' | 'high' | 'balanced' | 'small' | 'custom';

export type ProcessingStage =
  | 'loading'
  | 'analyzing'
  | 'removing-background'
  | 'cropping'
  | 'resizing'
  | 'compressing'
  | 'validating'
  | 'complete';

export interface BackgroundRemovalOptions {
  enabled: boolean;
  /** Id of a model from the model registry. */
  model: string;
  /** Skip the model when the image already has a transparent background. */
  skipIfTransparent: boolean;
  /** Snap the low-resolution mask to image edges (fast guided filter). */
  refineEdges: boolean;
  /** Re-estimate foreground colours in soft edges to avoid halos. */
  decontaminateColors: boolean;
  /**
   * Hugging Face access token (read scope) for gated models such as RMBG-2.0.
   * Only sent to huggingface.co when downloading such a model.
   */
  huggingFaceToken?: string;
}

export interface CropOptions {
  enabled: boolean;
  /** Transparent padding (output pixels) around the cropped content. */
  padding: number;
  /**
   * Pixels with alpha <= threshold are treated as empty. 0 keeps every pixel
   * that has any coverage at all, so anti-aliased edges are never cut off.
   */
  alphaThreshold: number;
}

export interface ResizeOptions {
  enabled: boolean;
  maxWidth: number;
  maxHeight: number;
  preserveAspectRatio: boolean;
  allowUpscale: boolean;
}

export interface CustomCompressionSettings {
  /** Encoder quality 0–100 (ignored for lossless). */
  quality: number;
  lossless: boolean;
}

export interface CompressionOptions {
  format: OutputFormat;
  preset: CompressionPreset;
  /** Consider AVIF when `format` is `auto` (best ratio, slowest encoder). */
  allowAvifInAuto: boolean;
  /** Settings used when `preset` is `custom`. */
  custom: CustomCompressionSettings;
}

export interface ProcessingOptions {
  backgroundRemoval: BackgroundRemovalOptions;
  crop: CropOptions;
  resize: ResizeOptions;
  compression: CompressionOptions;
}

export interface QualityMetrics {
  /** Weighted SSIM (luma + chroma), composited over black and white for alpha images. */
  ssim: number;
  /** 1st-percentile local luma SSIM — catches localised artifacts that the mean hides. */
  worstBlockSsim: number;
  /** PSNR in dB over the composited RGB channels. */
  psnr: number;
  /** Largest absolute alpha difference (0–255). */
  maxAlphaError: number;
}

export interface EncodeAttempt {
  codec: string;
  settings: string;
  bytes: number;
  metrics?: QualityMetrics;
  accepted: boolean;
}

export interface CandidateResult {
  format: EncodableFormat;
  variant: string;
  bytes: number;
  metrics: QualityMetrics;
  passed: boolean;
  /** Abandoned during the search because it could not beat the current best. */
  pruned?: boolean;
  settings: string;
}

export interface ImageAnalysis {
  width: number;
  height: number;
  sourceFormat: ImageFormat;
  hasAlpha: boolean;
  /** opaque: no transparency; binary: alpha is 0 or 255 only; soft: partial transparency present. */
  alphaKind: 'opaque' | 'binary' | 'soft';
  /** Share of fully transparent pixels on the image border (0–1). */
  transparentBorderRatio: number;
  /** Distinct RGBA colours, capped at `uniqueColorsCap + 1`. */
  uniqueColors: number;
  isGrayscale: boolean;
  contentType: 'photo' | 'illustration' | 'flat-graphic' | 'exact-color';
}

export interface StageTimings {
  [stage: string]: number;
}

export interface ProcessedImage {
  data: Uint8Array;
  format: EncodableFormat;
  mimeType: string;
  width: number;
  height: number;
  originalBytes: number;
  outputBytes: number;
  /** originalBytes / outputBytes (> 1 means smaller). */
  compressionRatio: number;
  /** Relative size reduction, 0–1 (negative if larger). */
  savings: number;
  metrics: QualityMetrics;
  encoderSettings: string;
  analysis: ImageAnalysis;
  /** Every candidate the automatic selection measured. */
  candidates: CandidateResult[];
  backgroundRemoved: boolean;
  cropped: boolean;
  resized: boolean;
  timings: StageTimings;
  warnings: string[];
}

export interface StageProgress {
  stage: ProcessingStage;
  /** Optional 0–1 progress within the stage. */
  fraction?: number;
  detail?: string;
}

export type ProgressCallback = (progress: StageProgress) => void;

/** Thrown when processing is cancelled cooperatively. */
export class CancelledError extends Error {
  constructor() {
    super('Processing cancelled');
    this.name = 'CancelledError';
  }
}

export interface CancellationToken {
  readonly cancelled: boolean;
}

export function throwIfCancelled(token: CancellationToken | undefined): void {
  if (token?.cancelled) throw new CancelledError();
}
