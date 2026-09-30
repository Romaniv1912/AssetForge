import type { RgbaImage } from '../types';

/**
 * Mask post-processing for background removal.
 *
 * 1. `guidedUpsample` — Fast Guided Filter (He & Sun, 2015) with a colour
 *    guide: the linear coefficients are solved at the model's resolution and
 *    applied at full resolution, so the soft mask snaps to real image edges
 *    (hair, fur, fine outlines) instead of being a blurry bilinear upscale.
 * 2. `estimateForeground` — "Approximate Fast Foreground Colour Estimation"
 *    (Forte & Pitié, 2021, blur-fusion, two passes). Semi-transparent edge
 *    pixels still contain background colour; re-estimating the pure
 *    foreground colour removes the halo you otherwise see when the cut-out is
 *    placed on a different background.
 */

export interface Plane {
  data: Float32Array;
  width: number;
  height: number;
}

/** Separable box filter (mean over a (2r+1)² window, clipped at borders). */
export function boxBlur(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius <= 0) return src.slice();
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const r = Math.max(1, Math.round(radius));
  // Horizontal
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    let count = 0;
    for (let x = 0; x <= Math.min(r, width - 1); x++) {
      sum += src[row + x]!;
      count++;
    }
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / count;
      const add = x + r + 1;
      const remove = x - r;
      if (add < width) {
        sum += src[row + add]!;
        count++;
      }
      if (remove >= 0) {
        sum -= src[row + remove]!;
        count--;
      }
    }
  }
  // Vertical
  for (let x = 0; x < width; x++) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y <= Math.min(r, height - 1); y++) {
      sum += tmp[y * width + x]!;
      count++;
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / count;
      const add = y + r + 1;
      const remove = y - r;
      if (add < height) {
        sum += tmp[add * width + x]!;
        count++;
      }
      if (remove >= 0) {
        sum -= tmp[remove * width + x]!;
        count--;
      }
    }
  }
  return out;
}

/** Precomputed bilinear sampling positions (pixel-centre aligned). */
interface Axis {
  i0: Int32Array;
  i1: Int32Array;
  t: Float32Array;
}

function axis(src: number, dst: number): Axis {
  const i0 = new Int32Array(dst);
  const i1 = new Int32Array(dst);
  const t = new Float32Array(dst);
  const scale = src / dst;
  for (let i = 0; i < dst; i++) {
    const pos = Math.min(src - 1, Math.max(0, (i + 0.5) * scale - 0.5));
    const lo = Math.floor(pos);
    i0[i] = lo;
    i1[i] = Math.min(src - 1, lo + 1);
    t[i] = pos - lo;
  }
  return { i0, i1, t };
}

export function bilinearResize(src: Plane, width: number, height: number): Plane {
  const out = new Float32Array(width * height);
  const ax = axis(src.width, width);
  const ay = axis(src.height, height);
  const s = src.data;
  for (let y = 0; y < height; y++) {
    const r0 = ay.i0[y]! * src.width;
    const r1 = ay.i1[y]! * src.width;
    const ty = ay.t[y]!;
    for (let x = 0; x < width; x++) {
      const x0 = ax.i0[x]!;
      const x1 = ax.i1[x]!;
      const tx = ax.t[x]!;
      const top = s[r0 + x0]! + (s[r0 + x1]! - s[r0 + x0]!) * tx;
      const bottom = s[r1 + x0]! + (s[r1 + x1]! - s[r1 + x0]!) * tx;
      out[y * width + x] = top + (bottom - top) * ty;
    }
  }
  return { data: out, width, height };
}

/** Splits an RGBA image into three [0,1] colour planes. */
export function colorPlanes(image: RgbaImage): [Float32Array, Float32Array, Float32Array] {
  const n = image.width * image.height;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  const d = image.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    r[i] = d[p]! / 255;
    g[i] = d[p + 1]! / 255;
    b[i] = d[p + 2]! / 255;
  }
  return [r, g, b];
}

export interface GuidedFilterOptions {
  radius: number;
  epsilon: number;
}

/**
 * Colour guided filter solved on `guide` (low resolution, same size as
 * `mask`), evaluated on `full` (the full-resolution image).
 */
export function guidedUpsample(
  guide: RgbaImage,
  mask: Plane,
  full: RgbaImage,
  options: GuidedFilterOptions,
): Float32Array {
  const { width: w, height: h } = mask;
  if (guide.width !== w || guide.height !== h) throw new Error('Guide and mask must have the same size');
  const n = w * h;
  const r = options.radius;
  const eps = options.epsilon;
  const [Ir, Ig, Ib] = colorPlanes(guide);
  const p = mask.data;

  const mul = (a: Float32Array, b: Float32Array) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = a[i]! * b[i]!;
    return out;
  };
  const box = (a: Float32Array) => boxBlur(a, w, h, r);

  const mR = box(Ir);
  const mG = box(Ig);
  const mB = box(Ib);
  const mP = box(p);
  const mRP = box(mul(Ir, p));
  const mGP = box(mul(Ig, p));
  const mBP = box(mul(Ib, p));
  const vRR = box(mul(Ir, Ir));
  const vRG = box(mul(Ir, Ig));
  const vRB = box(mul(Ir, Ib));
  const vGG = box(mul(Ig, Ig));
  const vGB = box(mul(Ig, Ib));
  const vBB = box(mul(Ib, Ib));

  const aR = new Float32Array(n);
  const aG = new Float32Array(n);
  const aB = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const mr = mR[i]!;
    const mg = mG[i]!;
    const mb = mB[i]!;
    const mp = mP[i]!;
    const cr = mRP[i]! - mr * mp;
    const cg = mGP[i]! - mg * mp;
    const cb = mBP[i]! - mb * mp;
    // Covariance of the guide + eps·I, inverted analytically (symmetric 3×3).
    const rr = vRR[i]! - mr * mr + eps;
    const rg = vRG[i]! - mr * mg;
    const rb = vRB[i]! - mr * mb;
    const gg = vGG[i]! - mg * mg + eps;
    const gb = vGB[i]! - mg * mb;
    const bb = vBB[i]! - mb * mb + eps;
    const i00 = gg * bb - gb * gb;
    const i01 = gb * rb - rg * bb;
    const i02 = rg * gb - gg * rb;
    const i11 = rr * bb - rb * rb;
    const i12 = rb * rg - rr * gb;
    const i22 = rr * gg - rg * rg;
    const det = rr * i00 + rg * i01 + rb * i02;
    if (Math.abs(det) < 1e-12) {
      aR[i] = 0;
      aG[i] = 0;
      aB[i] = 0;
      b[i] = mp;
      continue;
    }
    const ar = (i00 * cr + i01 * cg + i02 * cb) / det;
    const ag = (i01 * cr + i11 * cg + i12 * cb) / det;
    const ab = (i02 * cr + i12 * cg + i22 * cb) / det;
    aR[i] = ar;
    aG[i] = ag;
    aB[i] = ab;
    b[i] = mp - ar * mr - ag * mg - ab * mb;
  }

  const planes = [box(aR), box(aG), box(aB), box(b)];

  // Evaluate q = a·I + b at full resolution with bilinearly interpolated coefficients.
  const W = full.width;
  const H = full.height;
  const out = new Float32Array(W * H);
  const ax = axis(w, W);
  const ay = axis(h, H);
  const d = full.data;
  const sample = (plane: Float32Array, r0: number, r1: number, x0: number, x1: number, tx: number, ty: number) => {
    const top = plane[r0 + x0]! + (plane[r0 + x1]! - plane[r0 + x0]!) * tx;
    const bottom = plane[r1 + x0]! + (plane[r1 + x1]! - plane[r1 + x0]!) * tx;
    return top + (bottom - top) * ty;
  };
  const [pa, pg, pb, pbias] = planes as [Float32Array, Float32Array, Float32Array, Float32Array];
  for (let y = 0; y < H; y++) {
    const r0 = ay.i0[y]! * w;
    const r1 = ay.i1[y]! * w;
    const ty = ay.t[y]!;
    for (let x = 0; x < W; x++) {
      const x0 = ax.i0[x]!;
      const x1 = ax.i1[x]!;
      const tx = ax.t[x]!;
      const q = (y * W + x) * 4;
      const value =
        sample(pa, r0, r1, x0, x1, tx, ty) * (d[q]! / 255) +
        sample(pg, r0, r1, x0, x1, tx, ty) * (d[q + 1]! / 255) +
        sample(pb, r0, r1, x0, x1, tx, ty) * (d[q + 2]! / 255) +
        sample(pbias, r0, r1, x0, x1, tx, ty);
      out[y * W + x] = value < 0 ? 0 : value > 1 ? 1 : value;
    }
  }
  return out;
}

/**
 * Replaces the RGB of partially transparent pixels (in place) with an
 * estimate of the pure foreground colour. Fully opaque pixels are unchanged.
 */
export function estimateForeground(image: RgbaImage, alpha: Float32Array, maxWorkSide = 1024): void {
  const W = image.width;
  const H = image.height;
  const scale = Math.min(1, maxWorkSide / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const n = w * h;

  // Area-downsample colour and alpha to the working resolution.
  const I = [new Float32Array(n), new Float32Array(n), new Float32Array(n)] as const;
  const A = new Float32Array(n);
  {
    const counts = new Float32Array(n);
    const d = image.data;
    for (let y = 0; y < H; y++) {
      const wy = Math.min(h - 1, Math.floor((y * h) / H));
      for (let x = 0; x < W; x++) {
        const wx = Math.min(w - 1, Math.floor((x * w) / W));
        const i = wy * w + wx;
        const p = (y * W + x) * 4;
        I[0][i]! += d[p]! / 255;
        I[1][i]! += d[p + 1]! / 255;
        I[2][i]! += d[p + 2]! / 255;
        A[i]! += alpha[y * W + x]!;
        counts[i]!++;
      }
    }
    for (let i = 0; i < n; i++) {
      const c = counts[i]! || 1;
      I[0][i]! /= c;
      I[1][i]! /= c;
      I[2][i]! /= c;
      A[i]! /= c;
    }
  }

  const side = Math.max(w, h);
  const r1 = Math.max(2, Math.round(side * 0.045));
  const r2 = Math.max(1, Math.round(side * 0.003));
  const EPS = 1e-5;

  const fusion = (F: readonly Float32Array[], B: readonly Float32Array[], radius: number) => {
    const blurA = boxBlur(A, w, h, radius);
    const blurF: Float32Array[] = [];
    const blurB: Float32Array[] = [];
    for (let c = 0; c < 3; c++) {
      const fa = new Float32Array(n);
      const ba = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        fa[i] = F[c]![i]! * A[i]!;
        ba[i] = B[c]![i]! * (1 - A[i]!);
      }
      const bf = boxBlur(fa, w, h, radius);
      const bb = boxBlur(ba, w, h, radius);
      for (let i = 0; i < n; i++) {
        bf[i] = bf[i]! / (blurA[i]! + EPS);
        bb[i] = bb[i]! / (1 - blurA[i]! + EPS);
      }
      blurF.push(bf);
      blurB.push(bb);
    }
    return { blurF, blurB };
  };

  // Pass 1 (large radius) at working resolution.
  const pass1 = fusion(I, I, r1);
  const F1: Float32Array[] = [];
  for (let c = 0; c < 3; c++) {
    const f = new Float32Array(n);
    const bf = pass1.blurF[c]!;
    const bb = pass1.blurB[c]!;
    for (let i = 0; i < n; i++) {
      const a = A[i]!;
      const v = bf[i]! + a * (I[c]![i]! - a * bf[i]! - (1 - a) * bb[i]!);
      f[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    F1.push(f);
  }
  // Pass 2 (small radius) refines F using the smooth background estimate.
  const pass2 = fusion(F1, pass1.blurB, r2);

  // Apply at full resolution to partially transparent pixels only.
  const ax = axis(w, W);
  const ay = axis(h, H);
  const d = image.data;
  for (let y = 0; y < H; y++) {
    const r0 = ay.i0[y]! * w;
    const r1b = ay.i1[y]! * w;
    const ty = ay.t[y]!;
    for (let x = 0; x < W; x++) {
      const a = alpha[y * W + x]!;
      // Near-zero alpha is invisible: re-colouring it would only create coloured specks.
      if (a < 0.03 || a >= 0.998) continue;
      const x0 = ax.i0[x]!;
      const x1 = ax.i1[x]!;
      const tx = ax.t[x]!;
      const p = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const bf = pass2.blurF[c]!;
        const bb = pass2.blurB[c]!;
        const f0 = bf[r0 + x0]! + (bf[r0 + x1]! - bf[r0 + x0]!) * tx;
        const f1 = bf[r1b + x0]! + (bf[r1b + x1]! - bf[r1b + x0]!) * tx;
        const b0 = bb[r0 + x0]! + (bb[r0 + x1]! - bb[r0 + x0]!) * tx;
        const b1 = bb[r1b + x0]! + (bb[r1b + x1]! - bb[r1b + x0]!) * tx;
        const fBlur = f0 + (f1 - f0) * ty;
        const bBlur = b0 + (b1 - b0) * ty;
        const pixel = d[p + c]! / 255;
        const v = fBlur + a * (pixel - a * fBlur - (1 - a) * bBlur);
        d[p + c] = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
      }
    }
  }
}

export interface CleanMatteOptions {
  /** Alpha at or above this is "confident foreground". */
  coreThreshold?: number;
  /** How far (px) soft/semi-transparent alpha may extend beyond the confident core. */
  haloRadius?: number;
  /** Confident blobs smaller than this fraction of the largest one are treated as noise. */
  minComponentRatio?: number;
}

/**
 * Removes background noise from a soft matte, in place.
 *
 * Segmentation models leave weak, speckled responses in the background (a few
 * percent alpha). Invisible on their own, they show up as coloured specks once
 * edge colours are decontaminated, and they defeat cropping. Semi-transparent
 * alpha is therefore only kept within `haloRadius` of the confident
 * foreground — hair, fur and soft shadows next to the object survive, isolated
 * specks elsewhere are cleared. Tiny isolated confident blobs are dropped too.
 */
export function cleanMatte(alpha: Float32Array, width: number, height: number, options: CleanMatteOptions = {}): void {
  const n = width * height;
  const coreThreshold = options.coreThreshold ?? 0.5;
  const radius = Math.max(1, Math.round(options.haloRadius ?? Math.max(8, Math.max(width, height) * 0.02)));
  const minRatio = options.minComponentRatio ?? 0.002;

  // 1. Label confident regions (4-connected) and measure them.
  const labels = new Int32Array(n);
  const sizes: number[] = [0];
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (labels[start] !== 0 || alpha[start]! < coreThreshold) continue;
    const label = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % width;
      const visit = (j: number) => {
        if (labels[j] === 0 && alpha[j]! >= coreThreshold) {
          labels[j] = label;
          queue[tail++] = j;
        }
      };
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (i >= width) visit(i - width);
      if (i < n - width) visit(i + width);
    }
    sizes.push(tail);
  }
  const largest = Math.max(0, ...sizes);
  // No confident foreground at all: leave the matte untouched rather than erase it.
  if (largest === 0) return;

  const keep = new Uint8Array(n);
  const minSize = largest * minRatio;
  for (let i = 0; i < n; i++) {
    const label = labels[i]!;
    if (label !== 0 && sizes[label]! >= minSize) keep[i] = 1;
  }

  // 2. Square dilation of the kept core by `radius` (separable, prefix sums).
  const horizontal = new Uint8Array(n);
  const prefix = new Int32Array(Math.max(width, height) + 1);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) prefix[x + 1] = prefix[x]! + keep[row + x]!;
    for (let x = 0; x < width; x++) {
      const a = Math.max(0, x - radius);
      const b = Math.min(width, x + radius + 1);
      horizontal[row + x] = prefix[b]! - prefix[a]! > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) prefix[y + 1] = prefix[y]! + horizontal[y * width + x]!;
    for (let y = 0; y < height; y++) {
      const a = Math.max(0, y - radius);
      const b = Math.min(height, y + radius + 1);
      const i = y * width + x;
      const nearCore = prefix[b]! - prefix[a]! > 0;
      // 3. Outside the zone: background. Dropped noise blobs: background.
      if (!nearCore || (labels[i] !== 0 && keep[i] === 0)) alpha[i] = 0;
    }
  }
}
