import type { ImageAnalysis, ImageFormat, RgbaImage } from '../types';

/** Colour counting stops here; above it the exact number does not change any decision. */
export const UNIQUE_COLORS_CAP = 65_536;

/**
 * Measures the image characteristics that drive format selection and
 * background-removal decisions. Heuristics only choose which candidates to
 * *try*; the final choice is always made by measuring encoded results.
 */
export function analyzeImage(image: RgbaImage, sourceFormat: ImageFormat): ImageAnalysis {
  const { width, height, data } = image;
  const n = width * height;

  let transparent = 0;
  let partial = 0;
  let grayscale = true;
  let flatNeighbours = 0;
  const colors = new Set<number>();
  let colorsSaturated = false;

  for (let y = 0; y < height; y++) {
    let prev = -1;
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const r = data[p]!;
      const g = data[p + 1]!;
      const b = data[p + 2]!;
      const a = data[p + 3]!;
      if (a === 0) transparent++;
      else if (a !== 255) partial++;
      if (grayscale && a !== 0 && (r !== g || g !== b)) grayscale = false;
      // Fully transparent pixels are all equivalent, whatever their RGB.
      const key = a === 0 ? 0 : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      if (key === prev) flatNeighbours++;
      prev = key;
      if (!colorsSaturated) {
        colors.add(key);
        if (colors.size > UNIQUE_COLORS_CAP) colorsSaturated = true;
      }
    }
  }

  const hasAlpha = transparent + partial > 0;
  const alphaKind: ImageAnalysis['alphaKind'] = !hasAlpha ? 'opaque' : partial === 0 ? 'binary' : 'soft';
  const uniqueColors = colors.size;
  const flatRatio = flatNeighbours / Math.max(1, n - height);

  let contentType: ImageAnalysis['contentType'];
  // ≤256 colours is "exact-colour" (icons, pixel art, UI) — but a greyscale
  // photo or scan also has ≤256 levels and should be treated as continuous tone.
  const continuousGray = grayscale && uniqueColors > 64 && flatRatio < 0.9;
  if (uniqueColors <= 256 && !continuousGray) contentType = 'exact-color';
  else if (flatRatio > 0.75 && uniqueColors < 8_192) contentType = 'flat-graphic';
  else if (flatRatio > 0.35 || (hasAlpha && transparent / n > 0.2 && flatRatio > 0.2)) contentType = 'illustration';
  else contentType = 'photo';

  return {
    width,
    height,
    sourceFormat,
    hasAlpha,
    alphaKind,
    transparentBorderRatio: transparentBorderRatio(image),
    uniqueColors,
    isGrayscale: grayscale,
    contentType,
  };
}

/** Fraction of border pixels that are fully transparent — a strong "already cut out" signal. */
export function transparentBorderRatio(image: RgbaImage): number {
  const { width, height, data } = image;
  let total = 0;
  let clear = 0;
  const visit = (x: number, y: number) => {
    total++;
    if (data[(y * width + x) * 4 + 3]! === 0) clear++;
  };
  for (let x = 0; x < width; x++) {
    visit(x, 0);
    if (height > 1) visit(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    visit(0, y);
    if (width > 1) visit(width - 1, y);
  }
  return total === 0 ? 0 : clear / total;
}
