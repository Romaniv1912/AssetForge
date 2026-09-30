import { buildPaletteSync, utils } from 'image-q';
import type { RgbaImage } from '../types';

/**
 * Palette quantisation for lossy PNG / palette WebP.
 *
 * The default quantiser is libimagequant (see `libimagequant.ts`). This file
 * holds the `Quantizer` interface and the built-in fallback used when the
 * libimagequant WASM cannot be loaded: image-q's Xiaolin Wu palette refined by
 * k-means, with a fast remapper that implements
 *  - nearest-colour search in premultiplied RGBA with BT.709-like weights,
 *  - serpentine Floyd–Steinberg error diffusion,
 *  - an edge map that fades dithering out on edges/noise and keeps it in
 *    smooth gradients (where it prevents banding),
 *  - no diffusion into or out of fully transparent pixels.
 */
export interface Quantizer {
  /** Asynchronous initialisation (e.g. loading WebAssembly); called before `quantize`. */
  ready?(): Promise<void>;
  quantize(image: RgbaImage, maxColors: number, options?: QuantizeOptions): RgbaImage;
}

export interface QuantizeOptions {
  /** 0 disables dithering, 1 is full Floyd–Steinberg. */
  dithering?: number;
}

const MAX_PALETTE_SAMPLES = 180_000;
// Channel weights for the distance (sum ≈ 1): green dominates perceived luminance.
const WR = 0.2126 * 3;
const WG = 0.7152 * 3;
const WB = 0.0722 * 3;
const WA = 1.5;

export const wuQuantizer: Quantizer = {
  quantize(image, maxColors, options = {}) {
    const palette = buildPalette(image, Math.max(2, Math.min(256, maxColors)));
    return remap(image, palette, options.dithering ?? 1);
  },
};

interface Palette {
  /** Straight (non-premultiplied) RGBA entries. */
  rgba: Uint8Array;
  /** Premultiplied, weighted coordinates used for distance computations. */
  coords: Float32Array;
  size: number;
  /** Entry order sorted by the green coordinate, for pruned nearest search. */
  byG: Int32Array;
  sortedG: Float32Array;
}

interface PreparedImage {
  /** Premultiplied, weighted coordinates of sampled non-transparent pixels. */
  samples: Float32Array;
  count: number;
  hasTransparent: boolean;
  /** Wu palette at the maximum budget, computed once per image. */
  wu: Float32Array[];
  /** How many samples fall on each Wu entry (drives palette reduction). */
  population: Uint32Array;
}

// Keyed by the pixel buffer: the perceptual search quantises the same image
// several times with different palette sizes.
const prepared = new WeakMap<Uint8ClampedArray, PreparedImage>();

function prepare(image: RgbaImage): PreparedImage {
  const cached = prepared.get(image.data);
  if (cached) return cached;
  const { data } = image;
  const n = image.width * image.height;
  const step = Math.max(1, Math.floor(n / MAX_PALETTE_SAMPLES));
  const capacity = Math.ceil(n / step);
  const sampleRgba = new Uint8Array(capacity * 4);
  let count = 0;
  let hasTransparent = false;
  // Deterministic jittered sampling keeps the palette stable between runs.
  let seed = 0x9e3779b9;
  for (let i = 0; i < n; i += step) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const index = Math.min(n - 1, i + (step > 1 ? seed % step : 0));
    const p = index * 4;
    if (data[p + 3] === 0) {
      hasTransparent = true;
      continue; // transparent pixels share one dedicated entry
    }
    sampleRgba.set(data.subarray(p, p + 4), count * 4);
    count++;
  }
  if (!hasTransparent) {
    for (let p = 3; p < data.length; p += 4) {
      if (data[p] === 0) {
        hasTransparent = true;
        break;
      }
    }
  }

  const samples = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    samples.set(toCoords([sampleRgba[i * 4]!, sampleRgba[i * 4 + 1]!, sampleRgba[i * 4 + 2]!, sampleRgba[i * 4 + 3]!]), i * 4);
  }

  const wu: Float32Array[] = [];
  if (count > 0) {
    const container = utils.PointContainer.fromUint8Array(sampleRgba.subarray(0, count * 4), count, 1);
    const built = buildPaletteSync([container], {
      colors: hasTransparent ? 255 : 256,
      paletteQuantization: 'wuquant',
      colorDistanceFormula: 'euclidean-bt709',
    });
    for (const point of built.getPointContainer().getPointArray()) {
      if (point.a > 0) wu.push(toCoords([point.r, point.g, point.b, point.a]));
    }
  }
  const population = new Uint32Array(wu.length);
  if (wu.length > 0) {
    const palette = paletteFromCenters(wu);
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      population[nearest(palette, samples[o]!, samples[o + 1]!, samples[o + 2]!, samples[o + 3]!)]!++;
    }
  }
  const result = { samples, count, hasTransparent, wu, population };
  prepared.set(image.data, result);
  return result;
}

function buildPalette(image: RgbaImage, colors: number): Palette {
  const prep = prepare(image);
  const budget = Math.max(1, prep.hasTransparent ? colors - 1 : colors);
  let centers: Float32Array[] = [];
  if (prep.count > 0) {
    centers =
      prep.wu.length > budget
        ? selectRepresentatives(prep.wu, prep.population, budget)
        : seedFarthest(prep.samples, prep.count, prep.wu, budget);
    centers = lloyd(prep.samples, prep.count, centers, KMEANS_ITERATIONS);
  }
  const entries = centers.map(fromCoords);
  if (prep.hasTransparent || entries.length === 0) entries.push([0, 0, 0, 0]);
  return makePalette(entries);
}

/**
 * Picks `budget` of the Wu entries as k-means seeds: start from the most
 * populous colour, then repeatedly take the entry farthest from the chosen
 * ones, weighted by how many pixels it represents.
 */
function selectRepresentatives(entries: Float32Array[], population: Uint32Array, budget: number): Float32Array[] {
  const chosen: Float32Array[] = [];
  const distance = new Float64Array(entries.length).fill(Infinity);
  let next = 0;
  for (let i = 1; i < entries.length; i++) if (population[i]! > population[next]!) next = i;
  while (chosen.length < budget) {
    const c = entries[next]!;
    chosen.push(c);
    distance[next] = -1;
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < entries.length; i++) {
      if (distance[i]! < 0) continue;
      const e = entries[i]!;
      const d = (e[0]! - c[0]!) ** 2 + (e[1]! - c[1]!) ** 2 + (e[2]! - c[2]!) ** 2 + (e[3]! - c[3]!) ** 2;
      if (d < distance[i]!) distance[i] = d;
      const score = distance[i]! * Math.sqrt(population[i]! + 1);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break;
    next = best;
  }
  return chosen;
}

const KMEANS_ITERATIONS = 3;

function toCoords(e: number[]): Float32Array {
  const a = e[3]! / 255;
  return Float32Array.of(e[0]! * a * WR, e[1]! * a * WG, e[2]! * a * WB, e[3]! * WA);
}

function fromCoords(c: Float32Array): number[] {
  const alpha = Math.max(0, Math.min(255, Math.round(c[3]! / WA)));
  if (alpha === 0) return [0, 0, 0, 0];
  const a = alpha / 255;
  const channel = (v: number, w: number) => Math.max(0, Math.min(255, Math.round(v / (a * w))));
  return [channel(c[0]!, WR), channel(c[1]!, WG), channel(c[2]!, WB), alpha];
}

function makePalette(entries: number[][]): Palette {
  const size = entries.length;
  const rgba = new Uint8Array(size * 4);
  const coords = new Float32Array(size * 4);
  entries.forEach((e, i) => {
    rgba.set(e.map((v) => Math.max(0, Math.min(255, Math.round(v)))), i * 4);
    coords.set(toCoords(Array.from(rgba.subarray(i * 4, i * 4 + 4))), i * 4);
  });
  const byG = Int32Array.from({ length: size }, (_, i) => i).sort((x, y) => coords[x * 4 + 1]! - coords[y * 4 + 1]!);
  const sortedG = Float32Array.from(byG, (i) => coords[i * 4 + 1]!);
  return { rgba, coords, size, byG, sortedG };
}

function paletteFromCenters(centers: Float32Array[]): Palette {
  const size = centers.length;
  const coords = new Float32Array(size * 4);
  centers.forEach((c, i) => coords.set(c, i * 4));
  const byG = Int32Array.from({ length: size }, (_, i) => i).sort((x, y) => coords[x * 4 + 1]! - coords[y * 4 + 1]!);
  const sortedG = Float32Array.from(byG, (i) => coords[i * 4 + 1]!);
  return { rgba: new Uint8Array(size * 4), coords, size, byG, sortedG };
}

/**
 * Adds centres at the samples farthest from the current palette until the
 * budget is used. Wu's quantiser works on a 5-bit histogram and can return
 * fewer colours than requested (notably for greyscale images).
 */
function seedFarthest(samples: Float32Array, count: number, centers: Float32Array[], budget: number): Float32Array[] {
  if (centers.length >= budget) return centers;
  const out = [...centers];
  const distance = new Float32Array(count).fill(Infinity);
  const update = (c: Float32Array) => {
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      const d0 = samples[o]! - c[0]!;
      const d1 = samples[o + 1]! - c[1]!;
      const d2 = samples[o + 2]! - c[2]!;
      const d3 = samples[o + 3]! - c[3]!;
      const d = d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
      if (d < distance[i]!) distance[i] = d;
    }
  };
  for (const c of out) update(c);
  if (out.length === 0) {
    const first = samples.slice(0, 4);
    out.push(first);
    update(first);
  }
  while (out.length < budget) {
    let best = -1;
    let bestDistance = 0.5; // below this every sample already has an exact centre
    for (let i = 0; i < count; i++) {
      if (distance[i]! > bestDistance) {
        bestDistance = distance[i]!;
        best = i;
      }
    }
    if (best < 0) break;
    const c = samples.slice(best * 4, best * 4 + 4);
    out.push(c);
    update(c);
  }
  return out;
}

/** Lloyd (k-means) iterations: move each centre to the mean of its samples. */
function lloyd(samples: Float32Array, count: number, centers: Float32Array[], iterations: number): Float32Array[] {
  let current = centers;
  for (let it = 0; it < iterations; it++) {
    const palette = paletteFromCenters(current);
    const sums = new Float64Array(current.length * 4);
    const counts = new Uint32Array(current.length);
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      const k = nearest(palette, samples[o]!, samples[o + 1]!, samples[o + 2]!, samples[o + 3]!);
      sums[k * 4]! += samples[o]!;
      sums[k * 4 + 1]! += samples[o + 1]!;
      sums[k * 4 + 2]! += samples[o + 2]!;
      sums[k * 4 + 3]! += samples[o + 3]!;
      counts[k]!++;
    }
    current = current.map((c, k) =>
      counts[k]! > 0
        ? Float32Array.of(sums[k * 4]! / counts[k]!, sums[k * 4 + 1]! / counts[k]!, sums[k * 4 + 2]! / counts[k]!, sums[k * 4 + 3]! / counts[k]!)
        : c,
    );
  }
  return current;
}

function nearest(palette: Palette, r: number, g: number, b: number, a: number): number {
  const { coords, byG, sortedG, size } = palette;
  // Binary search the start position on the green axis.
  let lo = 0;
  let hi = size - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedG[mid]! < g) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  let bestDistance = Infinity;
  let up = lo;
  let down = lo - 1;
  while (up < size || down >= 0) {
    if (up < size) {
      const dg = sortedG[up]! - g;
      if (dg * dg >= bestDistance) up = size;
      else {
        const i = byG[up]! * 4;
        const dr = coords[i]! - r;
        const db = coords[i + 2]! - b;
        const da = coords[i + 3]! - a;
        const d = dr * dr + dg * dg + db * db + da * da;
        if (d < bestDistance) {
          bestDistance = d;
          best = byG[up]!;
        }
        up++;
      }
    }
    if (down >= 0) {
      const dg = sortedG[down]! - g;
      if (dg * dg >= bestDistance) down = -1;
      else {
        const i = byG[down]! * 4;
        const dr = coords[i]! - r;
        const db = coords[i + 2]! - b;
        const da = coords[i + 3]! - a;
        const d = dr * dr + dg * dg + db * db + da * da;
        if (d < bestDistance) {
          bestDistance = d;
          best = byG[down]!;
        }
        down--;
      }
    }
  }
  return best;
}

function remap(image: RgbaImage, palette: Palette, dithering: number): RgbaImage {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);
  const edge = dithering > 0 ? edgeMap(image) : undefined;
  // Error rows (current and next), 4 channels, with one pixel of padding each side.
  const rowLen = (width + 2) * 4;
  let errCur = new Float32Array(rowLen);
  let errNext = new Float32Array(rowLen);
  const cache = new Map<number, number>();
  const maxError = 48;
  const clearIndex = transparentIndex(palette);
  const clearColor = palette.rgba.slice(clearIndex * 4, clearIndex * 4 + 4);

  for (let y = 0; y < height; y++) {
    const leftToRight = (y & 1) === 0;
    for (let k = 0; k < width; k++) {
      const x = leftToRight ? k : width - 1 - k;
      const p = (y * width + x) * 4;
      const alpha = data[p + 3]!;
      if (alpha === 0) {
        out.set(clearColor, p);
        continue;
      }
      const e = (x + 1) * 4;
      const strength = edge ? dithering * edge[y * width + x]! : 0;
      const af = alpha / 255;
      // Work in premultiplied, weighted space.
      let r = data[p]! * af * WR;
      let g = data[p + 1]! * af * WG;
      let b = data[p + 2]! * af * WB;
      let a = alpha * WA;
      if (strength > 0) {
        r += clamp(errCur[e]!, maxError * WR) * strength;
        g += clamp(errCur[e + 1]!, maxError * WG) * strength;
        b += clamp(errCur[e + 2]!, maxError * WB) * strength;
        a += clamp(errCur[e + 3]!, maxError * WA) * strength;
      }

      let index: number;
      if (strength === 0) {
        const key = ((data[p]! << 24) | (data[p + 1]! << 16) | (data[p + 2]! << 8) | alpha) >>> 0;
        const cached = cache.get(key);
        if (cached === undefined) {
          index = nearest(palette, r, g, b, a);
          if (cache.size < 1 << 18) cache.set(key, index);
        } else index = cached;
      } else {
        index = nearest(palette, r, g, b, a);
      }
      const q = index * 4;
      out[p] = palette.rgba[q]!;
      out[p + 1] = palette.rgba[q + 1]!;
      out[p + 2] = palette.rgba[q + 2]!;
      out[p + 3] = palette.rgba[q + 3]!;

      if (edge) {
        const c = palette.coords;
        const er = r - c[q]!;
        const eg = g - c[q + 1]!;
        const eb = b - c[q + 2]!;
        const ea = a - c[q + 3]!;
        // Floyd–Steinberg weights, mirrored on right-to-left rows.
        const fwd = leftToRight ? 4 : -4;
        distribute(errCur, e + fwd, er, eg, eb, ea, 7 / 16);
        distribute(errNext, e - fwd, er, eg, eb, ea, 3 / 16);
        distribute(errNext, e, er, eg, eb, ea, 5 / 16);
        distribute(errNext, e + fwd, er, eg, eb, ea, 1 / 16);
      }
    }
    const swap = errCur;
    errCur = errNext;
    errNext = swap;
    errNext.fill(0);
  }
  return { width, height, data: out };
}

function transparentIndex(palette: Palette): number {
  let best = 0;
  for (let i = 0; i < palette.size; i++) if (palette.rgba[i * 4 + 3]! < palette.rgba[best * 4 + 3]!) best = i;
  return best;
}

function distribute(row: Float32Array, i: number, r: number, g: number, b: number, a: number, w: number): void {
  row[i]! += r * w;
  row[i + 1]! += g * w;
  row[i + 2]! += b * w;
  row[i + 3]! += a * w;
}

function clamp(value: number, limit: number): number {
  return value > limit ? limit : value < -limit ? -limit : value;
}

/**
 * Per-pixel dithering weight in [0.15, 1]: 1 in smooth areas, fading out where
 * the local contrast is high. Transparent neighbourhoods get no dithering.
 */
function edgeMap(image: RgbaImage): Float32Array {
  const { width, height, data } = image;
  const out = new Float32Array(width * height);
  const luma = (i: number) => {
    const p = i * 4;
    return ((data[p]! * 54 + data[p + 1]! * 183 + data[p + 2]! * 19) >> 8) * (data[p + 3]! / 255);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const c = luma(i);
      let maxDiff = 0;
      if (x > 0) maxDiff = Math.max(maxDiff, Math.abs(c - luma(i - 1)));
      if (x < width - 1) maxDiff = Math.max(maxDiff, Math.abs(c - luma(i + 1)));
      if (y > 0) maxDiff = Math.max(maxDiff, Math.abs(c - luma(i - width)));
      if (y < height - 1) maxDiff = Math.max(maxDiff, Math.abs(c - luma(i + width)));
      out[i] = Math.max(0.15, 1 - maxDiff / 40);
    }
  }
  return out;
}
