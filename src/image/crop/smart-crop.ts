import type { NormalizedRect, RgbaImage } from '../types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Bounding box of all pixels whose alpha is above `alphaThreshold`.
 * With the default threshold of 0 every pixel with any coverage — including
 * the faintest anti-aliased edge pixel — is kept inside the box.
 * Returns null for a fully transparent image.
 */
export function findContentBounds(image: RgbaImage, alphaThreshold = 0): Rect | null {
  const { width, height, data } = image;
  const rowHasContent = (y: number) => {
    for (let x = 0, p = y * width * 4 + 3; x < width; x++, p += 4) if (data[p]! > alphaThreshold) return true;
    return false;
  };
  let top = 0;
  while (top < height && !rowHasContent(top)) top++;
  if (top === height) return null;
  let bottom = height - 1;
  while (bottom > top && !rowHasContent(bottom)) bottom--;

  let left = width;
  let right = -1;
  for (let y = top; y <= bottom; y++) {
    const row = y * width * 4 + 3;
    // Only scan the columns that could still extend the box.
    for (let x = 0; x < left; x++) {
      if (data[row + x * 4]! > alphaThreshold) {
        left = x;
        break;
      }
    }
    for (let x = width - 1; x > right; x--) {
      if (data[row + x * 4]! > alphaThreshold) {
        right = x;
        break;
      }
    }
  }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

export function cropImage(image: RgbaImage, rect: Rect): RgbaImage {
  if (rect.x === 0 && rect.y === 0 && rect.width === image.width && rect.height === image.height) return image;
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > image.width || rect.y + rect.height > image.height) {
    throw new Error('Crop rectangle is outside the image');
  }
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  const rowBytes = rect.width * 4;
  for (let y = 0; y < rect.height; y++) {
    const start = ((rect.y + y) * image.width + rect.x) * 4;
    out.set(image.data.subarray(start, start + rowBytes), y * rowBytes);
  }
  return { width: rect.width, height: rect.height, data: out };
}

/** Adds fully transparent padding on every side. */
export function padImage(image: RgbaImage, padding: number): RgbaImage {
  const p = Math.max(0, Math.round(padding));
  if (p === 0) return image;
  const width = image.width + p * 2;
  const height = image.height + p * 2;
  const out = new Uint8ClampedArray(width * height * 4);
  const rowBytes = image.width * 4;
  for (let y = 0; y < image.height; y++) {
    out.set(image.data.subarray(y * rowBytes, (y + 1) * rowBytes), ((y + p) * width + p) * 4);
  }
  return { width, height, data: out };
}

/** Converts a fractional region to whole pixels inside the image (at least 1×1). */
export function pixelRect(rect: NormalizedRect, width: number, height: number): Rect {
  const x0 = Math.min(width - 1, Math.max(0, Math.round(rect.x * width)));
  const y0 = Math.min(height - 1, Math.max(0, Math.round(rect.y * height)));
  const x1 = Math.min(width, Math.max(x0 + 1, Math.round((rect.x + rect.width) * width)));
  const y1 = Math.min(height, Math.max(y0 + 1, Math.round((rect.y + rect.height) * height)));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
