import { compareImages } from '../metrics/ssim';
import {
  throwIfCancelled,
  type CancellationToken,
  type CandidateResult,
  type CompressionOptions,
  type EncodableFormat,
  type EncodeAttempt,
  type OutputFormat,
  type ImageAnalysis,
  type ProgressCallback,
  type QualityMetrics,
  type RgbaImage,
} from '../types';
import { createCandidate, type CandidateEncoder, type CandidateId } from './candidates';
import { meetsTarget, QUALITY_TARGETS, type QualityTarget } from './presets';
import type { Quantizer } from './quantize';

export interface CompressInput {
  image: RgbaImage;
  analysis: ImageAnalysis;
  options: CompressionOptions;
  cancel?: CancellationToken;
  onProgress?: ProgressCallback;
  quantizer?: Quantizer;
}

export interface CompressOutput {
  bytes: Uint8Array;
  format: EncodableFormat;
  metrics: QualityMetrics;
  settings: string;
  candidates: CandidateResult[];
  attempts: EncodeAttempt[];
  warnings: string[];
  /** The pixels that were encoded (differs from input only when JPEG flattened alpha). */
  encodedFrom: RgbaImage;
}

const PALETTE_STEPS = [256, 192, 128, 96, 64, 48, 32, 24, 16, 8];
/** A candidate that is already this much larger than the current best cannot win. */
const PRUNE_MARGIN = 1.12;

/**
 * Perceptual compression.
 *
 * For every candidate encoder the lowest setting that still meets the
 * preset's perceptual target is found by binary search
 * (encode → decode → SSIM → adjust). The smallest passing file across all
 * candidates wins. `custom` bypasses the search and encodes at a fixed quality.
 */
export async function compress(input: CompressInput): Promise<CompressOutput> {
  const { analysis, cancel, onProgress } = input;
  const options = { ...input.options, format: resolveOutputFormat(input.options.format, analysis) };
  const warnings: string[] = [];
  let image = input.image;

  const target: QualityTarget =
    options.preset === 'custom' ? QUALITY_TARGETS.high : QUALITY_TARGETS[options.preset];

  const ids = chooseCandidates(options, analysis, image);
  let hasAlpha = analysis.hasAlpha;
  if (options.format === 'jpeg' && hasAlpha) {
    image = flattenOnto(image, 255);
    hasAlpha = false;
    warnings.push('JPEG does not support transparency: the image was flattened onto white.');
  }

  const ctx = { image, analysis, target, quantizer: input.quantizer };
  const attempts: EncodeAttempt[] = [];
  const results: Array<CandidateResult & { data: Uint8Array }> = [];
  let best: (CandidateResult & { data: Uint8Array }) | undefined;

  const evaluate = async (candidate: CandidateEncoder, level: number, phase: 'search' | 'final') => {
    throwIfCancelled(cancel);
    const encoded = await candidate.encode(level, phase);
    const decoded = encoded.decoded ?? (await candidate.decode(encoded.bytes));
    const metrics = compareImages(image, decoded, { hasAlpha, ditherTolerant: candidate.kind === 'palette' });
    const passed = options.preset === 'custom' || meetsTarget(metrics, target);
    attempts.push({
      codec: candidate.id,
      settings: candidate.describe(level, phase),
      bytes: encoded.bytes.length,
      metrics,
      accepted: passed,
    });
    return { bytes: encoded.bytes, metrics, passed, level };
  };

  const runCandidate = async (id: CandidateId, index: number, total: number) => {
    const candidate = createCandidate(id, ctx);
    onProgress?.({ stage: 'compressing', fraction: index / total, detail: `Trying ${label(id)}` });
    const outcome =
      options.preset === 'custom'
        ? await runFixed(candidate, options, evaluate)
        : await runSearch(candidate, target, evaluate, best?.bytes, analysis.uniqueColors, options.fullPalette ?? false);
    if (!outcome) return;
    if (outcome.pruned) {
      onProgress?.({ stage: 'compressing', fraction: (index + 1) / total, detail: `${label(id)} cannot beat the current best` });
    }
    const result = {
      format: candidate.format,
      variant: id,
      bytes: outcome.bytes.length,
      metrics: outcome.metrics,
      passed: outcome.passed && !outcome.pruned,
      pruned: outcome.pruned,
      settings: candidate.describe(outcome.level, outcome.pruned ? 'search' : 'final'),
      data: outcome.bytes,
    };
    results.push(result);
    if (!outcome.pruned && isBetter(result, best, options.preset === 'custom')) best = result;
  };

  for (let i = 0; i < ids.primary.length; i++) await runCandidate(ids.primary[i]!, i, ids.primary.length);

  if (!best?.passed && ids.fallback.length > 0) {
    for (let i = 0; i < ids.fallback.length; i++) await runCandidate(ids.fallback[i]!, i, ids.fallback.length);
  }
  if (!best) throw new Error('No encoder produced a result');
  if (!best.passed) {
    warnings.push(
      `The ${options.preset} quality target could not be reached with ${best.format.toUpperCase()}; the highest-quality attempt was kept.`,
    );
  }

  return {
    bytes: best.data,
    format: best.format,
    metrics: best.metrics,
    settings: best.settings,
    candidates: results.map(({ data: _data, ...rest }) => rest),
    attempts,
    warnings,
    encodedFrom: image,
  };
}

type Evaluate = (
  candidate: CandidateEncoder,
  level: number,
  phase: 'search' | 'final',
) => Promise<{ bytes: Uint8Array; metrics: QualityMetrics; passed: boolean; level: number }>;

type Outcome = Awaited<ReturnType<Evaluate>> & { pruned?: boolean };

async function runFixed(candidate: CandidateEncoder, options: CompressionOptions, evaluate: Evaluate): Promise<Outcome> {
  const quality = clampQuality(options.custom.quality);
  if (candidate.kind === 'palette') {
    // Map 0–100 onto 2…256 colours on a log scale.
    const colors = Math.max(2, Math.min(256, Math.round(2 ** (1 + (quality / 100) * 7))));
    return evaluate(candidate, colors, 'final');
  }
  return evaluate(candidate, quality, 'final');
}

async function runSearch(
  candidate: CandidateEncoder,
  target: QualityTarget,
  evaluate: Evaluate,
  bestBytes: number | undefined,
  uniqueColors: number,
  fullPalette: boolean,
): Promise<Outcome | undefined> {
  const pruneAt = bestBytes ? bestBytes * PRUNE_MARGIN : Infinity;

  if (candidate.kind === 'lossless') {
    return evaluate(candidate, 100, 'final');
  }

  if (candidate.kind === 'palette') {
    // Fewer colours → smaller file. Walk down until the target fails.
    let passing: Outcome | undefined;
    // "Keep 256 colours": one full palette, like sharp's png({ palette: true }).
    for (const colors of fullPalette ? [256] : PALETTE_STEPS) {
      if (colors < target.minPaletteColors) break;
      // Reducing an image that already has ≤256 colours only makes sense below its count.
      if (colors >= uniqueColors) continue;
      const attempt = await evaluate(candidate, colors, 'search');
      if (!attempt.passed) {
        if (attempt.bytes.length > pruneAt) return { ...attempt, pruned: true };
        break;
      }
      passing = attempt;
    }
    if (!passing) return undefined;
    const final = await evaluate(candidate, passing.level, 'final');
    return final.passed && final.bytes.length <= passing.bytes.length ? final : passing;
  }

  // Lossy: binary search for the lowest quality that passes.
  const [min, max] = rangeFor(candidate, target);
  const maxIterations = candidate.format === 'avif' ? 5 : 7;
  const tolerance = candidate.format === 'avif' ? 3 : 2;
  let lo = min;
  let hi = max;
  let passing: Outcome | undefined;
  let highestTried: Outcome | undefined;
  for (let i = 0; i < maxIterations && hi - lo >= tolerance; i++) {
    const mid = Math.round((lo + hi) / 2);
    const attempt = await evaluate(candidate, mid, 'search');
    if (!highestTried || attempt.level > highestTried.level) highestTried = attempt;
    if (attempt.passed) {
      if (!passing || attempt.bytes.length < passing.bytes.length) passing = attempt;
      hi = mid - 1;
    } else {
      // Anything that passes needs a higher quality and therefore more bytes.
      if (attempt.bytes.length > pruneAt) return { ...attempt, pruned: true };
      lo = mid + 1;
    }
  }
  if (!passing) {
    const top = await evaluate(candidate, max, 'search');
    if (!top.passed) {
      if (top.bytes.length > pruneAt) return { ...top, pruned: true };
      const final = await evaluate(candidate, max, 'final');
      // At the encoder's ceiling a hair below the target is still an excellent
      // result; it is preferred over a lossless fallback several times larger.
      if (nearMiss(final.metrics, target)) final.passed = true;
      return final;
    }
    passing = top;
  }

  // Final encode with the slower, stronger settings at the chosen quality.
  let final = await evaluate(candidate, passing.level, 'final');
  if (!final.passed && passing.level < max) {
    final = await evaluate(candidate, Math.min(max, passing.level + tolerance + 1), 'final');
  }
  if (final.passed && final.bytes.length <= passing.bytes.length) return final;
  return passing;
}

function nearMiss(metrics: QualityMetrics, target: QualityTarget): boolean {
  return metrics.ssim >= target.minSsim - 0.003 && metrics.worstBlockSsim >= target.minWorstBlockSsim - 0.015;
}

function rangeFor(candidate: CandidateEncoder, target: QualityTarget): [number, number] {
  if (candidate.format === 'jpeg') return target.jpeg;
  if (candidate.format === 'webp') return target.webp;
  return target.avif;
}

function isBetter(
  result: { passed: boolean; bytes: number; metrics: QualityMetrics },
  best: { passed: boolean; bytes: number; metrics: QualityMetrics } | undefined,
  custom: boolean,
): boolean {
  if (!best) return true;
  if (custom) {
    // Fixed quality: prefer the smaller file unless it is visibly worse.
    if (result.metrics.ssim + 0.004 < best.metrics.ssim) return false;
    if (best.metrics.ssim + 0.004 < result.metrics.ssim) return true;
    return result.bytes < best.bytes;
  }
  if (result.passed !== best.passed) return result.passed;
  if (!result.passed) return result.metrics.ssim > best.metrics.ssim;
  return result.bytes < best.bytes;
}

function clampQuality(q: number): number {
  return Math.max(1, Math.min(100, Math.round(q)));
}

function label(id: CandidateId): string {
  return {
    'jpeg-420': 'JPEG 4:2:0',
    'jpeg-444': 'JPEG 4:4:4',
    'jpeg-gray': 'JPEG grayscale',
    webp: 'WebP',
    'webp-lossless': 'WebP lossless',
    avif: 'AVIF',
    'avif-lossless': 'AVIF lossless',
    'png-quant': 'PNG palette',
    'webp-palette': 'WebP palette',
    'png-lossless': 'PNG lossless',
  }[id];
}

/**
 * Resolves `original` to a concrete format: the source format when it can be
 * written, PNG for GIF/BMP sources, and PNG for a JPEG source that gained
 * transparency (e.g. after background removal) — JPEG cannot store it.
 */
export function resolveOutputFormat(
  format: OutputFormat,
  analysis: Pick<ImageAnalysis, 'sourceFormat' | 'hasAlpha'>,
): Exclude<OutputFormat, 'original'> {
  if (format !== 'original') return format;
  switch (analysis.sourceFormat) {
    case 'png':
    case 'webp':
    case 'avif':
      return analysis.sourceFormat;
    case 'jpeg':
      return analysis.hasAlpha ? 'png' : 'jpeg';
    default:
      return 'png';
  }
}

interface CandidatePlan {
  primary: CandidateId[];
  /** Tried only when no primary candidate meets the target. */
  fallback: CandidateId[];
}

/**
 * Which encoders to measure. Content heuristics only prune obviously hopeless
 * candidates; the winner is decided by measured size at equal perceptual quality.
 */
export function chooseCandidates(options: CompressionOptions, analysis: ImageAnalysis, image: RgbaImage): CandidatePlan {
  const format = resolveOutputFormat(options.format, analysis);
  const lossless = options.preset === 'custom' && options.custom.lossless;
  const mp = (image.width * image.height) / 1e6;
  const exact = analysis.contentType === 'exact-color';
  const photo = analysis.contentType === 'photo';
  const target = options.preset === 'custom' ? QUALITY_TARGETS.high : QUALITY_TARGETS[options.preset];
  // Palette reduction also helps ≤256-colour images with many colours (e.g. scans, anti-aliased icons).
  const pngQuant = target.allowPngQuantization && (!exact || (analysis.uniqueColors > 64 && options.preset !== 'maximum'));
  // Lossless WebP is only competitive on graphics; on continuous tone it is large and slow.
  const webpLossless = analysis.uniqueColors <= 4096 || analysis.contentType === 'flat-graphic';

  switch (format) {
    case 'png':
      if (lossless) return { primary: ['png-lossless'], fallback: [] };
      if (exact) return { primary: pngQuant ? ['png-quant', 'png-lossless'] : ['png-lossless'], fallback: [] };
      return { primary: pngQuant ? ['png-quant'] : [], fallback: ['png-lossless'] };
    case 'webp': {
      if (lossless) return { primary: ['webp-lossless'], fallback: [] };
      if (exact) return { primary: pngQuant ? ['webp-lossless', 'webp-palette'] : ['webp-lossless'], fallback: [] };
      const primary: CandidateId[] = ['webp'];
      if (pngQuant && (!photo || analysis.hasAlpha)) primary.push('webp-palette');
      if (webpLossless) primary.push('webp-lossless');
      return { primary, fallback: webpLossless ? [] : ['webp-lossless'] };
    }
    case 'avif':
      return lossless ? { primary: ['avif-lossless'], fallback: [] } : { primary: ['avif'], fallback: [] };
    case 'jpeg': {
      if (analysis.isGrayscale && !analysis.hasAlpha) return { primary: ['jpeg-gray'], fallback: [] };
      const primary: CandidateId[] = ['jpeg-420'];
      if (!photo || mp <= 1.5 || options.preset === 'maximum') primary.push('jpeg-444');
      return { primary, fallback: [] };
    }
    case 'auto': {
      if (lossless) return { primary: ['png-lossless', 'webp-lossless'], fallback: [] };
      if (exact) {
        return {
          primary: pngQuant ? ['png-quant', 'webp-palette', 'png-lossless', 'webp-lossless'] : ['png-lossless', 'webp-lossless'],
          fallback: [],
        };
      }
      const avif = options.allowAvifInAuto && mp <= 16;
      const primary: CandidateId[] = [];
      if (photo && !analysis.hasAlpha) {
        primary.push('webp');
        primary.push(analysis.isGrayscale ? 'jpeg-gray' : 'jpeg-420');
        if (avif) primary.push('avif');
      } else if (photo) {
        primary.push('webp');
        if (avif) primary.push('avif');
        if (pngQuant && mp <= 4) primary.push('png-quant', 'webp-palette');
      } else {
        if (pngQuant) primary.push('png-quant', 'webp-palette');
        primary.push('webp');
        if (webpLossless) primary.push('webp-lossless');
        if (avif) primary.push('avif');
      }
      return { primary, fallback: ['webp-lossless', 'png-lossless'].filter((id) => !primary.includes(id as CandidateId)) as CandidateId[] };
    }
  }
}

/** Composites an RGBA image onto a solid grey level (used for JPEG output). */
export function flattenOnto(image: RgbaImage, background: number): RgbaImage {
  const out = new Uint8ClampedArray(image.data.length);
  const d = image.data;
  for (let p = 0; p < d.length; p += 4) {
    const a = d[p + 3]! / 255;
    const bg = (1 - a) * background;
    out[p] = d[p]! * a + bg;
    out[p + 1] = d[p + 1]! * a + bg;
    out[p + 2] = d[p + 2]! * a + bg;
    out[p + 3] = 255;
  }
  return { width: image.width, height: image.height, data: out };
}
