import type { NormalizedRect } from '../../image/types';

type Row = readonly [number, number, number];

/** The parts of a Figma `ImagePaint` that decide which part of the image is visible. */
export interface CropPaint {
  scaleMode: string;
  imageTransform?: readonly [Row, Row];
  rotation?: number;
}

interface Size {
  width: number;
  height: number;
}

/** Visible fractions this close to 1 are treated as "not cropped". */
const WHOLE = 0.998;

/**
 * The part of the image a fill actually shows, in fractions of the image, or
 * null when the whole image is visible (or the fill is rotated/flipped/tiled,
 * which is processed as the whole image).
 *
 * - `CROP`: from `imageTransform`. It maps the layer's unit square into the
 *   image's unit square, so the visible region is (tx, ty, a, d). A zoomed-in
 *   crop therefore has a, d < 1; a matrix with a or d > 1 can only be the
 *   inverse mapping (image → layer) and is inverted.
 * - `FILL`: the image covers the layer and is centred, so a layer whose
 *   proportions differ from the image's shows a centred slice of it.
 */
export function visibleRegion(paint: CropPaint, layer?: Size, image?: Size): NormalizedRect | null {
  if (paint.scaleMode === 'CROP') return fromTransform(paint.imageTransform);
  if (paint.scaleMode === 'FILL') return fromFill(paint, layer, image);
  return null;
}

function fromTransform(transform: CropPaint['imageTransform']): NormalizedRect | null {
  if (!transform) return null;
  let [[a, b, tx], [c, d, ty]] = transform;
  if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6 || a <= 0 || d <= 0) return null;
  if (a > 1 + 1e-3 || d > 1 + 1e-3) {
    // Inverse convention: invert the (axis-aligned) scale + translate.
    tx = -tx / a;
    ty = -ty / d;
    a = 1 / a;
    d = 1 / d;
  }
  return clampToImage(tx, ty, a, d);
}

function fromFill(paint: CropPaint, layer?: Size, image?: Size): NormalizedRect | null {
  if (!layer || !image || layer.width <= 0 || layer.height <= 0 || image.width <= 0 || image.height <= 0) return null;
  if (paint.rotation && paint.rotation % 360 !== 0) return null;
  const scale = Math.max(layer.width / image.width, layer.height / image.height);
  const width = layer.width / scale / image.width;
  const height = layer.height / scale / image.height;
  return clampToImage((1 - width) / 2, (1 - height) / 2, width, height);
}

function clampToImage(x: number, y: number, width: number, height: number): NormalizedRect | null {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(1, x + width);
  const y1 = Math.min(1, y + height);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  return rect.width >= WHOLE && rect.height >= WHOLE ? null : rect;
}
