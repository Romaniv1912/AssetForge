import { analyzeImage } from '../analysis/analyze';
import { removeBackground } from '../background-removal/remove-background';
import type { SegmentationRunner } from '../background-removal/runner';
import { optimisePngFile, optimisePngRaw } from '../codecs';
import { compress } from '../compression/compress';
import type { Quantizer } from '../compression/quantize';
import { cropImage, findContentBounds, padImage, pixelRect } from '../crop/smart-crop';
import { decodeImage, type FallbackDecoder } from '../decode/decode';
import { getEnhanceModelSpec } from '../enhance/models';
import type { EnhanceRunner } from '../enhance/runner';
import { aiUpscale } from '../enhance/upscale';
import { detectColorProfile, stripJpegMetadata, stripPngMetadata } from '../decode/metadata';
import { MIME_TYPES } from '../decode/sniff';
import { computeTargetSize, resizeImage } from '../resize/resize';
import {
  CancelledError,
  throwIfCancelled,
  type CancellationToken,
  type EncodableFormat,
  type NormalizedRect,
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
  /** Required when AI upscaling is enabled. */
  enhancer?: EnhanceRunner;
  fallbackDecoder?: FallbackDecoder;
  quantizer?: Quantizer;
  /** Process only this region of the source (e.g. the visible part of a cropped Figma fill). */
  sourceCrop?: NormalizedRect | null;
  cancel?: CancellationToken;
  onProgress?: ProgressCallback;
  /** Receives the decoded source pixels (e.g. to render a thumbnail). */
  onDecoded?: (image: RgbaImage) => void | Promise<void>;
  /** Receives the final pixels (e.g. to render a preview) before they are released. */
  onFinalPixels?: (image: RgbaImage) => void | Promise<void>;
}

/**
 * Largest input AI upscaling accepts (output is 16× the pixels): beyond this
 * the CPU backend takes minutes and the ×4 image needs hundreds of MB.
 */
export const MAX_ENHANCE_INPUT_PIXELS = 1024 * 1024;

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
    warnings.push(
      `Colour profile "${profile.description ?? 'unknown'}" is not sRGB; pixels are treated as sRGB, so colours may look slightly different.`,
    );
  }
  let image: RgbaImage = decoded.image;
  const sourceRegion = ctx.sourceCrop ? pixelRect(ctx.sourceCrop, image.width, image.height) : null;
  const sourceCropped = sourceRegion !== null && (sourceRegion.width !== image.width || sourceRegion.height !== image.height);
  if (sourceCropped) image = cropImage(image, sourceRegion!);
  if (ctx.onDecoded) await ctx.onDecoded(image);
  leave('loading');

  // 1b. AI upscale (before background removal, so the matte is refined on
  // the sharper image and every later stage works at the higher resolution).
  let enhanced = false;
  let enhanceScale = 1;
  if (options.enhance.enabled) {
    const decision = enhanceDecision(image, options);
    if (decision.run) {
      enter('enhancing', 'AI upscale');
      if (!ctx.enhancer) throw new Error('AI upscaling is not available in this environment');
      const spec = getEnhanceModelSpec(options.enhance.model);
      try {
        const before = { width: image.width, height: image.height };
        image = await aiUpscale(image, spec, ctx.enhancer, { cancel: ctx.cancel, onProgress: ctx.onProgress });
        enhanced = true;
        if (options.enhance.keepSize) {
          // Supersampled back to the original size: sharper, cleaner, same dimensions.
          image = await resizeImage(image, before);
        } else {
          enhanceScale = spec.scale;
        }
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        warnings.push(`AI upscale failed and was skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
      leave('enhancing');
    } else if (decision.reason) {
      warnings.push(decision.reason);
    }
  }

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
        onWarning: (message) => warnings.push(message),
      });
      backgroundRemoved = true;
    }
    leave('removing-background');
  }

  // Geometry of the output inside the source, for exact before/after overlays.
  const sourceWidth = image.width;
  const sourceHeight = image.height;
  let region = { x: 0, y: 0, width: image.width, height: image.height };

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
      region = { ...bounds };
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
    if (applyPadding) {
      // Padding is added in output pixels; convert it back to source pixels.
      const scaleX = image.width / region.width;
      const scaleY = image.height / region.height;
      region = {
        x: region.x - padding / scaleX,
        y: region.y - padding / scaleY,
        width: region.width + (2 * padding) / scaleX,
        height: region.height + (2 * padding) / scaleY,
      };
      image = padImage(image, padding);
    }
    leave('resizing');
  }

  const pixelsChanged = sourceCropped || enhanced || backgroundRemoved || cropped || resized || applyPadding;
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
  const sameFormat =
    options.compression.format === 'auto' ||
    options.compression.format === 'original' ||
    options.compression.format === decoded.format;
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
    enhanced,
    backgroundRemoved,
    cropped,
    resized,
    // In source pixels: undo the AI upscale factor.
    placement: {
      sourceWidth: sourceWidth / enhanceScale,
      sourceHeight: sourceHeight / enhanceScale,
      x: region.x / enhanceScale,
      y: region.y / enhanceScale,
      width: region.width / enhanceScale,
      height: region.height / enhanceScale,
    },
    timings,
    warnings,
  };
}

/**
 * Whether to AI-upscale. With "only when smaller", that is when the image is
 * smaller than the Resize box on both sides (a plain resize would leave it
 * smaller or upscale it with a filter); without Resize limits it always runs.
 */
export function enhanceDecision(image: RgbaImage, options: ProcessingOptions): { run: boolean; reason?: string } {
  const pixels = image.width * image.height;
  if (pixels > MAX_ENHANCE_INPUT_PIXELS) {
    return {
      run: false,
      reason: `AI upscale skipped: ${image.width}×${image.height} is larger than the ${Math.round(MAX_ENHANCE_INPUT_PIXELS / 1e6 * 10) / 10} MP it handles.`,
    };
  }
  if (options.enhance.keepSize || !options.enhance.onlyWhenSmaller) return { run: true };
  const { resize } = options;
  if (!resize.enabled || (!resize.maxWidth && !resize.maxHeight)) return { run: true };
  const fit = Math.min(resize.maxWidth ? resize.maxWidth / image.width : Infinity, resize.maxHeight ? resize.maxHeight / image.height : Infinity);
  // Less than 10% smaller: a filter resize is indistinguishable.
  return fit > 1.1 ? { run: true } : { run: false };
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
