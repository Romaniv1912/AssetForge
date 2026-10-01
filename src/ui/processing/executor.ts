import type { SegmentationRunner } from '../../image/background-removal/runner';
import { decodeAvif, decodePng, decodeWebp, encodeJpeg, encodeWebp, optimisePngRaw, releaseCodecMemory, resample } from '../../image/codecs';
import { browserFallbackDecoder } from '../../image/decode/decode';
import { sniffFormat } from '../../image/decode/sniff';
import { processImage } from '../../image/pipeline/process-image';
import type { CancellationToken, NormalizedRect, ProcessingOptions, RgbaImage, StageProgress } from '../../image/types';
import type { ProcessingResultPayload } from '../../shared/messages/worker';

/**
 * Job execution shared by the worker and the in-thread fallback, so both paths
 * run identical code.
 */
export async function executeJob(
  bytes: Uint8Array,
  options: ProcessingOptions,
  previewSize: number,
  segmentation: SegmentationRunner | undefined,
  cancel: CancellationToken,
  onProgress: (progress: StageProgress) => void,
  sourceCrop: NormalizedRect | null = null,
): Promise<ProcessingResultPayload> {
  let sourcePreview: Uint8Array | null = null;
  const result = await processImage(bytes, options, {
    segmentation,
    sourceCrop,
    fallbackDecoder: browserFallbackDecoder,
    cancel,
    onProgress,
    onDecoded: async (image) => {
      sourcePreview = await makeThumbnail(image, previewSize);
    },
  });
  return { result, sourcePreview };
}

export async function makeThumbnail(image: RgbaImage, maxSide: number): Promise<Uint8Array | null> {
  try {
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const small = await resample(
      image,
      Math.max(1, Math.round(image.width * scale)),
      Math.max(1, Math.round(image.height * scale)),
      { filter: 'triangle', premultiply: true, linearRGB: false },
    );
    return await encodeWebp(small, { quality: 82, method: 2, alpha_quality: 90 });
  } catch {
    return null;
  }
}

/**
 * `figma.createImage` accepts PNG, JPEG and GIF only. WebP/AVIF results are
 * decoded and re-encoded (lossless PNG when transparent, high-quality JPEG
 * otherwise) so that Figma displays exactly the pixels of the optimised file.
 */
export async function encodeForFigma(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; format: 'png' | 'jpeg'; width: number; height: number }> {
  const format = sniffFormat(bytes);
  let image: RgbaImage;
  if (format === 'webp') image = await decodeWebp(bytes);
  else if (format === 'avif') image = await decodeAvif(bytes);
  else if (format === 'png') image = await decodePng(bytes);
  else throw new Error(`Cannot convert ${format.toUpperCase()} for Figma`);
  if (format === 'png') return { bytes, format, width: image.width, height: image.height };

  let transparent = false;
  for (let p = 3; p < image.data.length; p += 4) {
    if (image.data[p] !== 255) {
      transparent = true;
      break;
    }
  }
  const out = transparent
    ? await optimisePngRaw(image, { level: 2, optimiseAlpha: true })
    : await encodeJpeg(image, { quality: 95, chroma_subsample: 1 });
  return { bytes: out, format: transparent ? 'png' : 'jpeg', width: image.width, height: image.height };
}

export { releaseCodecMemory };
