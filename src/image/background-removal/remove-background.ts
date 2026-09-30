import { resample } from '../codecs';
import { flattenOnto } from '../compression/compress';
import { throwIfCancelled, type BackgroundRemovalOptions, type CancellationToken, type ProgressCallback, type RgbaImage } from '../types';
import { getModelSpec, modelInputSize, type SegmentationModelSpec } from './models';
import { bilinearResize, estimateForeground, guidedUpsample, type Plane } from './refine';
import type { SegmentationRunner } from './runner';

export interface RemoveBackgroundContext {
  runner: SegmentationRunner;
  cancel?: CancellationToken;
  onProgress?: ProgressCallback;
}

/** Alpha below this is treated as background noise; above the upper bound as solid. */
const ALPHA_FLOOR = 3 / 255;
const ALPHA_CEIL = 252 / 255;

/**
 * Removes the background of an image with a segmentation model, refines the
 * matte to image edges and decontaminates edge colours. The result keeps
 * every semi-transparent edge pixel (no binarisation).
 */
export async function removeBackground(
  image: RgbaImage,
  options: Pick<BackgroundRemovalOptions, 'model' | 'refineEdges' | 'decontaminateColors'>,
  ctx: RemoveBackgroundContext,
): Promise<RgbaImage> {
  const spec = getModelSpec(options.model);
  const { width: W, height: H } = image;

  // Models expect opaque RGB; existing transparency is re-applied at the end.
  const hasSourceAlpha = hasTransparency(image);
  const opaque = hasSourceAlpha ? flattenOnto(image, 255) : image;

  const inputSize = modelInputSize(spec, W, H);
  const modelInput = await resample(opaque, inputSize.width, inputSize.height, {
    filter: 'triangle',
    premultiply: false,
    linearRGB: false,
  });
  const tensor = toTensor(modelInput, spec);
  throwIfCancelled(ctx.cancel);

  const raw = await ctx.runner.run(spec.id, tensor, inputSize.width, inputSize.height, ctx.onProgress);
  throwIfCancelled(ctx.cancel);
  ctx.onProgress?.({ stage: 'removing-background', detail: 'Refining edges' });

  const mask: Plane = { data: normalizeMask(raw.data, spec), width: raw.width, height: raw.height };

  let alpha: Float32Array;
  if (options.refineEdges) {
    const guide =
      mask.width === modelInput.width && mask.height === modelInput.height
        ? modelInput
        : await resample(opaque, mask.width, mask.height, { filter: 'triangle', premultiply: false, linearRGB: false });
    const side = Math.max(mask.width, mask.height);
    alpha = guidedUpsample(guide, mask, opaque, {
      radius: Math.max(2, Math.round(side / 256)),
      epsilon: 1e-4,
    });
  } else {
    alpha = bilinearResize(mask, W, H).data;
  }

  const out: RgbaImage = { width: W, height: H, data: new Uint8ClampedArray(image.data) };
  const d = out.data;
  for (let i = 0, p = 3; i < alpha.length; i++, p += 4) {
    let a = alpha[i]!;
    if (a < ALPHA_FLOOR) a = 0;
    else if (a > ALPHA_CEIL) a = 1;
    if (hasSourceAlpha) a *= image.data[p]! / 255;
    alpha[i] = a;
    d[p] = Math.round(a * 255);
  }

  if (options.decontaminateColors) {
    throwIfCancelled(ctx.cancel);
    ctx.onProgress?.({ stage: 'removing-background', detail: 'Cleaning edge colours' });
    estimateForeground(out, alpha);
  }
  // Fully transparent pixels carry no colour: zero them (smaller files, no leaks).
  for (let p = 0; p < d.length; p += 4) {
    if (d[p + 3] === 0) {
      d[p] = 0;
      d[p + 1] = 0;
      d[p + 2] = 0;
    }
  }
  return out;
}

/** NCHW float32 tensor with the model's normalisation. */
export function toTensor(image: RgbaImage, spec: Pick<SegmentationModelSpec, 'mean' | 'std'>): Float32Array {
  const n = image.width * image.height;
  const tensor = new Float32Array(n * 3);
  const d = image.data;
  const [mr, mg, mb] = spec.mean;
  const [sr, sg, sb] = spec.std;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    tensor[i] = (d[p]! / 255 - mr) / sr;
    tensor[n + i] = (d[p + 1]! / 255 - mg) / sg;
    tensor[2 * n + i] = (d[p + 2]! / 255 - mb) / sb;
  }
  return tensor;
}

export function normalizeMask(data: Float32Array, spec: Pick<SegmentationModelSpec, 'outputNormalization'>): Float32Array {
  const out = new Float32Array(data.length);
  if (spec.outputNormalization === 'sigmoid') {
    for (let i = 0; i < data.length; i++) out[i] = 1 / (1 + Math.exp(-data[i]!));
    return out;
  }
  if (spec.outputNormalization === 'minmax') {
    let min = Infinity;
    let max = -Infinity;
    for (const v of data) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min;
    if (range < 1e-6) {
      // Degenerate output: the model found nothing (or everything).
      out.fill(min > 0.5 ? 1 : 0);
      return out;
    }
    for (let i = 0; i < data.length; i++) out[i] = (data[i]! - min) / range;
    return out;
  }
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

function hasTransparency(image: RgbaImage): boolean {
  const d = image.data;
  for (let p = 3; p < d.length; p += 4) if (d[p] !== 255) return true;
  return false;
}
