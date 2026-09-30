import type { NormalizedRect } from '../../image/types';

/** The parts of a Figma `ImagePaint` that describe a crop. */
export interface CropPaint {
  scaleMode: string;
  imageTransform?: readonly [readonly [number, number, number], readonly [number, number, number]];
}

/**
 * The part of the image a fill in crop mode shows. `imageTransform` maps the
 * layer's unit square into the image's unit square, so for an axis-aligned
 * crop the visible region is (tx, ty, a, d). Rotated or flipped crops are
 * treated as uncropped (the whole image is processed).
 */
export function cropOf(paint: CropPaint): NormalizedRect | null {
  if (paint.scaleMode !== 'CROP' || !paint.imageTransform) return null;
  const [[a, b, tx], [c, d, ty]] = paint.imageTransform;
  if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6 || a <= 0 || d <= 0) return null;
  const x0 = Math.max(0, tx);
  const y0 = Math.max(0, ty);
  const x1 = Math.min(1, tx + a);
  const y1 = Math.min(1, ty + d);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const whole = rect.x < 1e-4 && rect.y < 1e-4 && rect.width > 1 - 1e-4 && rect.height > 1 - 1e-4;
  return whole ? null : rect;
}
