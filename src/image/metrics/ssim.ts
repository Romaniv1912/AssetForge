import type { QualityMetrics, RgbaImage } from '../types';

/**
 * Perceptual comparison of a reference image and a decoded candidate.
 *
 * - SSIM is computed on Y, Cb and Cr planes (weights 0.8/0.1/0.1) with 8×8
 *   windows at a stride of 4 pixels. Chroma is compared at half resolution:
 *   human colour acuity is roughly half that of luminance, so 4:2:0 chroma
 *   subsampling is not penalised, while colour shifts and bleeding across
 *   edges still are.
 * - Images with transparency are composited over black AND over white and the
 *   worse score is kept, so errors in the alpha channel or in the colour of
 *   semi-transparent pixels are always visible to the metric.
 * - Besides the mean, the 1st percentile of local luma SSIM is reported:
 *   a mean of 0.99 can hide a badly blocky or banded region.
 */

const WINDOW = 8;
const STRIDE = 4;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
const WEIGHTS = [0.8, 0.1, 0.1] as const;
const HISTOGRAM_BINS = 2000;

export interface CompareOptions {
  /** Skip compositing over two backgrounds when both images are opaque (auto-detected when omitted). */
  hasAlpha?: boolean;
  /**
   * Low-pass both images (3×3 binomial) before SSIM. Used for dithered palette
   * images: dithering trades per-pixel error for correct local average colour,
   * which the eye integrates (the same reason pngquant scores palette error
   * rather than dither noise). Banding and colour shifts remain visible.
   */
  ditherTolerant?: boolean;
}

/**
 * Above this size both images are box-downscaled before comparison, bounding
 * the metric's memory (six float planes) to ~400 MB in the worst case.
 */
const MAX_COMPARE_PIXELS = 16_000_000;

export function compareImages(reference: RgbaImage, candidate: RgbaImage, options: CompareOptions = {}): QualityMetrics {
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new Error(
      `Cannot compare images of different size (${reference.width}×${reference.height} vs ${candidate.width}×${candidate.height})`,
    );
  }
  const alphaError = maxAlphaError(reference, candidate);
  if (reference.width * reference.height > MAX_COMPARE_PIXELS) {
    const factor = Math.ceil(Math.sqrt((reference.width * reference.height) / MAX_COMPARE_PIXELS));
    const metrics = compareImages(boxDownscale(reference, factor), boxDownscale(candidate, factor), options);
    return { ...metrics, maxAlphaError: alphaError };
  }
  const hasAlpha = options.hasAlpha ?? (imageHasAlpha(reference) || imageHasAlpha(candidate));
  const backgrounds = hasAlpha ? [0, 255] : [-1];

  let ssim = 1;
  let worstBlockSsim = 1;
  let psnr = Infinity;
  for (const background of backgrounds) {
    const a = toYCbCrPlanes(reference, background);
    const b = toYCbCrPlanes(candidate, background);
    const { width, height } = reference;
    let weighted = 0;
    for (let c = 0; c < 3; c++) {
      const collectWorst = c === 0;
      const raw = channelSsim(a[c]!, b[c]!, width, height, c > 0, false, collectWorst);
      let mean = raw.mean;
      let p01 = raw.p01;
      if (options.ditherTolerant) {
        // Blend of pixel-exact and eye-integrated similarity: dither grain still
        // costs something, but far less than a genuine colour or detail error.
        const smooth = channelSsim(a[c]!, b[c]!, width, height, c > 0, true, collectWorst);
        mean = (mean + smooth.mean) / 2;
        p01 = (p01 + smooth.p01) / 2;
      }
      weighted += WEIGHTS[c]! * mean;
      if (collectWorst) worstBlockSsim = Math.min(worstBlockSsim, p01);
    }
    ssim = Math.min(ssim, weighted);
    psnr = Math.min(psnr, compositedPsnr(reference, candidate, background));
  }

  return { ssim, worstBlockSsim, psnr, maxAlphaError: alphaError };
}

/** Premultiplied box downscale by an integer factor (used only for huge images). */
function boxDownscale(image: RgbaImage, factor: number): RgbaImage {
  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const out = new Uint8ClampedArray(width * height * 4);
  const d = image.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < factor; dy++) {
        let p = ((y * factor + dy) * image.width + x * factor) * 4;
        for (let dx = 0; dx < factor; dx++, p += 4) {
          const alpha = d[p + 3]!;
          r += d[p]! * alpha;
          g += d[p + 1]! * alpha;
          b += d[p + 2]! * alpha;
          a += alpha;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
      }
      out[o + 3] = a / (factor * factor);
    }
  }
  return { width, height, data: out };
}

export function imageHasAlpha(image: RgbaImage): boolean {
  const d = image.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

/** background < 0 means "ignore alpha" (opaque images). */
function toYCbCrPlanes(image: RgbaImage, background: number): [Float32Array, Float32Array, Float32Array] {
  const n = image.width * image.height;
  const y = new Float32Array(n);
  const cb = new Float32Array(n);
  const cr = new Float32Array(n);
  const d = image.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let r = d[p]!;
    let g = d[p + 1]!;
    let b = d[p + 2]!;
    if (background >= 0) {
      const a = d[p + 3]! / 255;
      const inv = (1 - a) * background;
      r = r * a + inv;
      g = g * a + inv;
      b = b * a + inv;
    }
    y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  return [y, cb, cr];
}

function channelSsim(
  a: Float32Array,
  b: Float32Array,
  width: number,
  height: number,
  chroma: boolean,
  lowPass: boolean,
  collectWorst: boolean,
): PlaneResult {
  let pa = a;
  let pb = b;
  let w = width;
  let h = height;
  if (lowPass) {
    pa = binomialBlur(pa, w, h);
    pb = binomialBlur(pb, w, h);
  }
  if (chroma && w >= 16 && h >= 16) {
    pa = halve(pa, w, h);
    pb = halve(pb, w, h);
    w >>= 1;
    h >>= 1;
  }
  return planeSsim(pa, pb, w, h, collectWorst);
}

/** 2×2 box downsample (floor dimensions). */
function halve(src: Float32Array, width: number, height: number): Float32Array {
  const w = width >> 1;
  const h = height >> 1;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r0 = 2 * y * width;
    const r1 = r0 + width;
    for (let x = 0; x < w; x++) {
      const i = 2 * x;
      out[y * w + x] = (src[r0 + i]! + src[r0 + i + 1]! + src[r1 + i]! + src[r1 + i + 1]!) * 0.25;
    }
  }
  return out;
}

/** Separable [1 2 1]/4 blur with clamped edges. */
function binomialBlur(src: Float32Array, width: number, height: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const l = src[row + Math.max(0, x - 1)]!;
      const r = src[row + Math.min(width - 1, x + 1)]!;
      tmp[row + x] = (l + 2 * src[row + x]! + r) * 0.25;
    }
  }
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width;
    const down = Math.min(height - 1, y + 1) * width;
    const row = y * width;
    for (let x = 0; x < width; x++) out[row + x] = (tmp[up + x]! + 2 * tmp[row + x]! + tmp[down + x]!) * 0.25;
  }
  return out;
}

interface PlaneResult {
  mean: number;
  p01: number;
}

function planeSsim(a: Float32Array, b: Float32Array, width: number, height: number, collectWorst: boolean): PlaneResult {
  // Tiny images: a single window covering the whole image.
  const win = Math.min(WINDOW, width, height);
  const stride = win < WINDOW ? win : STRIDE;
  const histogram = collectWorst ? new Uint32Array(HISTOGRAM_BINS) : undefined;
  const count = win * win;
  let total = 0;
  let windows = 0;

  const xs: number[] = [];
  for (let x = 0; x + win <= width; x += stride) xs.push(x);
  if (xs[xs.length - 1]! + win < width) xs.push(width - win);
  const ys: number[] = [];
  for (let y = 0; y + win <= height; y += stride) ys.push(y);
  if (ys[ys.length - 1]! + win < height) ys.push(height - win);

  for (const y0 of ys) {
    for (const x0 of xs) {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let y = y0; y < y0 + win; y++) {
        let i = y * width + x0;
        const end = i + win;
        for (; i < end; i++) {
          const va = a[i]!;
          const vb = b[i]!;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const ma = sa / count;
      const mb = sb / count;
      const va = Math.max(0, saa / count - ma * ma);
      const vb = Math.max(0, sbb / count - mb * mb);
      const cov = sab / count - ma * mb;
      const s = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      total += s;
      windows++;
      if (histogram) {
        const bin = Math.min(HISTOGRAM_BINS - 1, Math.max(0, Math.floor(((s + 1) / 2) * HISTOGRAM_BINS)));
        histogram[bin]!++;
      }
    }
  }

  const mean = total / windows;
  let p01 = mean;
  if (histogram) {
    const target = Math.max(1, Math.floor(windows * 0.01));
    let seen = 0;
    for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
      seen += histogram[bin]!;
      if (seen >= target) {
        p01 = ((bin + 0.5) / HISTOGRAM_BINS) * 2 - 1;
        break;
      }
    }
    p01 = Math.min(p01, 1);
  }
  return { mean, p01 };
}

function compositedPsnr(a: RgbaImage, b: RgbaImage, background: number): number {
  const da = a.data;
  const db = b.data;
  let sum = 0;
  for (let p = 0; p < da.length; p += 4) {
    const aa = background >= 0 ? da[p + 3]! / 255 : 1;
    const ab = background >= 0 ? db[p + 3]! / 255 : 1;
    const bgA = (1 - aa) * background;
    const bgB = (1 - ab) * background;
    for (let c = 0; c < 3; c++) {
      const diff = da[p + c]! * aa + bgA - (db[p + c]! * ab + bgB);
      sum += diff * diff;
    }
  }
  const mse = sum / ((da.length / 4) * 3);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

function maxAlphaError(a: RgbaImage, b: RgbaImage): number {
  let max = 0;
  const da = a.data;
  const db = b.data;
  for (let p = 3; p < da.length; p += 4) {
    const diff = Math.abs(da[p]! - db[p]!);
    if (diff > max) max = diff;
  }
  return max;
}
