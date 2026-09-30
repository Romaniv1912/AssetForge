import { analyzeImage } from '../analysis/analyze';
import { removeBackground } from '../background-removal/remove-background';
import type { SegmentationRunner } from '../background-removal/runner';
import { optimisePngFile, optimisePngRaw } from '../codecs';
import { compress } from '../compression/compress';
import type { Quantizer } from '../compression/quantize';
import { cropImage, findContentBounds, padImage } from '../crop/smart-crop';
import { decodeImage, type FallbackDecoder } from '../decode/decode';
import { detectColorProfile, stripJpegMetadata, stripPngMetadata } from '../decode/metadata';
import { MIME_TYPES } from '../decode/sniff';
import { computeTargetSize, resizeImage } from '../resize/resize';
import {
  throwIfCancelled,
  type CancellationToken,
  type EncodableFormat,
  type ProcessedImage,
  type ProcessingOptions,
  type ProcessingStage,
  type ProgressCallback,
  type QualityMetrics,
  type RgbaImage,
  type StageTimings,
} from '../types';
import { validateOutput, ValidationError } from '../validation/validate';

export interface PipelineContext {
  /** Required when background removal is enabled. */
  segmentation?: SegmentationRunner;
  fallbackDecoder?: FallbackDecoder;
  quantizer?: Quantizer;
  cancel?: CancellationToken;
  onProgress?: ProgressCallback;
  /** Receives the decoded source pixels (e.g. to render a thumbnail). */
  onDecoded?: (image: RgbaImage) => void | Promise<void>;
  /** Receives the final pixels (e.g. to render a preview) before they are released. */
  onFinalPixels?: (image: RgbaImage) => void | Promise<void>;
}

const PERFECT: QualityMetrics = { ssim: 1, worstBlockSsim: 1, psnr: Infinity, maxAlphaError: 0 };

/**
 * The AssetForge pipeline:
 * load → analyse → remove background → crop → resize → compress → validate.
 *
 * Independent of Figma and the DOM; runs in a Web Worker, the UI thread or Node.
 */
export async function processImage(
  bytes: Uint8Array,
  options: ProcessingOptions,
  ctx: PipelineContext = {},
): Promise<ProcessedImage> {
  const timings: StageTimings = {};
  const warnings: string[] = [];
  let stageStart = now();
  const enter = (stage: ProcessingStage, detail?: string) => {
    throwIfCancelled(ctx.cancel);
    stageStart = now();
    ctx.onProgress?.({ stage, detail });
  };
  const leave = (stage: ProcessingStage) => {
    timings[stage] = Math.round(now() - stageStart);
  };

  // 1. Load
  enter('loading');
  const decoded = await decodeImage(bytes, ctx.fallbackDecoder);
  warnings.push(...decoded.warnings);
  const profile = detectColorProfile(bytes);
  if (profile.present && !profile.looksLikeSrgb) {
    warnings.push('The source embeds a non-sRGB colour profile; pixels are processed as sRGB, so colours may shift slightly.');
  }
  let image: RgbaImage = decoded.image;
  if (ctx.onDecoded) await ctx.onDecoded(image);
  leave('loading');

  // 2. Analyse
  enter('analyzing');
  let analysis = analyzeImage(image, decoded.format);
  leave('analyzing');

  // 3. Background removal
  let backgroundRemoved = false;
  if (options.backgroundRemoval.enabled) {
    enter('removing-background');
    const alreadyCutOut = analysis.transparentBorderRatio >= 0.6;
    if (alreadyCutOut && options.backgroundRemoval.skipIfTransparent) {
      warnings.push('Background removal skipped: the image already has a transparent background.');
    } else {
      if (!ctx.segmentation) throw new Error('Background removal is not available in this environment');
      image = await removeBackground(image, options.backgroundRemoval, {
        runner: ctx.segmentation,
        cancel: ctx.cancel,
        onProgress: ctx.onProgress,
      });
      backgroundRemoved = true;
    }
    leave('removing-background');
  }

  // 4. Crop transparent bounds
  let cropped = false;
  const padding = options.crop.enabled ? Math.max(0, Math.round(options.crop.padding)) : 0;
  if (options.crop.enabled) {
    enter('cropping');
    const bounds = findContentBounds(image, options.crop.alphaThreshold);
    if (!bounds) {
      throw new Error(
        backgroundRemoved
          ? 'Nothing left after background removal: no foreground object was detected.'
          : 'The image is fully transparent.',
      );
    }
    if (bounds.width !== image.width || bounds.height !== image.height) {
      image = cropImage(image, bounds);
      cropped = true;
    }
    leave('cropping');
  }

  // 5. Resize. Padding only applies to cut-out content (never to an opaque
  // photo whose bounds did not change) and is reserved inside the maximum size.
  let resized = false;
  const applyPadding = options.crop.enabled && padding > 0 && (cropped || backgroundRemoved);
  const reserved = applyPadding ? padding * 2 : 0;
  if (options.resize.enabled || applyPadding) {
    enter('resizing');
    const target = computeTargetSize(image, options.resize, reserved);
    if (target.width !== image.width || target.height !== image.height) {
      image = await resizeImage(image, target);
      resized = true;
    }
    if (applyPadding) image = padImage(image, padding);
    leave('resizing');
  }

  const pixelsChanged = backgroundRemoved || cropped || resized || applyPadding;
  if (pixelsChanged) analysis = analyzeImage(image, decoded.format);

  // 6. Compress
  enter('compressing');
  const compressed = await compress({
    image,
    analysis,
    options: options.compression,
    cancel: ctx.cancel,
    onProgress: ctx.onProgress,
    quantizer: ctx.quantizer,
  });
  warnings.push(...compressed.warnings);
  let outBytes = compressed.bytes;
  let outFormat: EncodableFormat = compressed.format;
  let settings = compressed.settings;
  let metrics = compressed.metrics;
  leave('compressing');

  // 7. Validate — decode the file we are about to hand out.
  enter('validating');
  let keptOriginal = false;
  try {
    const validation = await validateOutput(outBytes, outFormat, compressed.encodedFrom, {
      expectAlpha: analysis.hasAlpha,
    });
    metrics = validation.metrics;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    // Safety net: fall back to a lossless PNG, which is always representable.
    warnings.push(`${error.message}. Fell back to lossless PNG.`);
    outBytes = await optimisePngRaw(image, { level: 2 });
    outFormat = 'png';
    settings = 'Lossless PNG (fallback), oxipng o2';
    metrics = PERFECT;
  }

  // Never make an untouched image bigger: keep the (metadata-stripped) original.
  const sameFormat = options.compression.format === 'auto' || options.compression.format === decoded.format;
  const originalEncodable = decoded.format === 'png' || decoded.format === 'jpeg' || decoded.format === 'webp' || decoded.format === 'avif';
  if (!pixelsChanged && sameFormat && originalEncodable && options.compression.preset !== 'custom') {
    const original = await passThrough(bytes, decoded.format as EncodableFormat);
    // Re-encoding a lossy source adds generation loss: require a real (5%) gain.
    const lossySource = decoded.format !== 'png';
    if (original.length <= outBytes.length * (lossySource ? 1.05 : 1)) {
      outBytes = original;
      outFormat = decoded.format as EncodableFormat;
      settings = 'Original kept (already smaller than any re-encode); metadata stripped';
      metrics = PERFECT;
      keptOriginal = true;
    }
  }
  if (keptOriginal) warnings.push('The original file was already smaller than every candidate encoding, so it was kept.');
  leave('validating');

  if (ctx.onFinalPixels) await ctx.onFinalPixels(image);

  ctx.onProgress?.({ stage: 'complete' });
  const originalBytes = bytes.length;
  return {
    data: outBytes,
    format: outFormat,
    mimeType: MIME_TYPES[outFormat],
    width: image.width,
    height: image.height,
    originalBytes,
    outputBytes: outBytes.length,
    compressionRatio: originalBytes / outBytes.length,
    savings: 1 - outBytes.length / originalBytes,
    metrics,
    encoderSettings: settings,
    analysis,
    candidates: compressed.candidates,
    backgroundRemoved,
    cropped,
    resized,
    timings,
    warnings,
  };
}

async function passThrough(bytes: Uint8Array, format: EncodableFormat): Promise<Uint8Array> {
  if (format === 'png') {
    const stripped = stripPngMetadata(bytes);
    try {
      // Lossless DEFLATE/filter re-optimisation of the untouched file.
      const optimised = await optimisePngFile(stripped, { level: 2, optimiseAlpha: false });
      return optimised.length < stripped.length ? optimised : stripped;
    } catch {
      return stripped;
    }
  }
  if (format === 'jpeg') return stripJpegMetadata(bytes);
  return bytes;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
