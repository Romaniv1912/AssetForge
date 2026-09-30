import type { RgbaImage } from '../../src/image/types';

/** Deterministic synthetic test images. */

export function blank(width: number, height: number, rgba: [number, number, number, number] = [0, 0, 0, 0]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < data.length; p += 4) data.set(rgba, p);
  return { width, height, data };
}

/** Smooth two-axis colour gradient (banding-prone). */
export function gradient(width = 512, height = 256): RgbaImage {
  const img = blank(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      img.data[p] = (x / (width - 1)) * 255;
      img.data[p + 1] = (y / (height - 1)) * 200 + 30;
      img.data[p + 2] = 255 - (x / (width - 1)) * 180;
      img.data[p + 3] = 255;
    }
  }
  return img;
}

/** Anti-aliased disc coverage for a pixel (4×4 supersampling). */
function discCoverage(x: number, y: number, cx: number, cy: number, r: number): number {
  let inside = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const dx = x + (sx + 0.5) / 4 - cx;
      const dy = y + (sy + 0.5) / 4 - cy;
      if (dx * dx + dy * dy <= r * r) inside++;
    }
  }
  return inside / 16;
}

/**
 * Transparent illustration: an anti-aliased disc with a stroke and a soft
 * semi-transparent shadow, placed off-centre on a transparent canvas.
 */
export function transparentIllustration(width = 400, height = 300): RgbaImage {
  const img = blank(width, height);
  const cx = width * 0.45;
  const cy = height * 0.5;
  const r = Math.min(width, height) * 0.25;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      // Soft shadow (semi-transparent, 30% max).
      const d = Math.hypot(x + 0.5 - (cx + 12), y + 0.5 - (cy + 14));
      const shadow = Math.max(0, Math.min(1, (r + 10 - d) / 20)) * 0.3;
      const cov = discCoverage(x, y, cx, cy, r);
      const inner = discCoverage(x, y, cx, cy, r - 6);
      // Fill colour: orange ring (stroke) with a teal centre.
      const fr = inner * 20 + (1 - inner) * 240;
      const fg = inner * 170 + (1 - inner) * 120;
      const fb = inner * 160 + (1 - inner) * 30;
      const a = cov + shadow * (1 - cov);
      if (a <= 0) continue;
      img.data[p] = (fr * cov) / a;
      img.data[p + 1] = (fg * cov) / a;
      img.data[p + 2] = (fb * cov) / a;
      img.data[p + 3] = Math.round(a * 255);
    }
  }
  return img;
}

/** Flat graphic: few solid colours with anti-aliased edges (like UI illustrations). */
export function flatGraphic(width = 480, height = 320): RgbaImage {
  const img = blank(width, height, [248, 246, 240, 255]);
  const shapes: Array<[number, number, number, [number, number, number]]> = [
    [0.3, 0.45, 0.22, [52, 101, 164]],
    [0.62, 0.55, 0.18, [237, 94, 72]],
    [0.8, 0.3, 0.1, [250, 196, 55]],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      for (const [fx, fy, fr, color] of shapes) {
        const cov = discCoverage(x, y, fx * width, fy * height, fr * height);
        if (cov === 0) continue;
        for (let c = 0; c < 3; c++) img.data[p + c] = img.data[p + c]! * (1 - cov) + color[c]! * cov;
      }
    }
  }
  return img;
}

/** Pixel art: 16 exact colours, hard edges. */
export function pixelArt(size = 64): RgbaImage {
  const palette = Array.from({ length: 16 }, (_, i) => [(i * 53) % 256, (i * 97) % 256, (i * 151) % 256, i === 0 ? 0 : 255]);
  const img = blank(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = ((x >> 3) * 7 + (y >> 3) * 3 + ((x ^ y) & 1)) % 16;
      img.data.set(palette[index]!, (y * size + x) * 4);
    }
  }
  return img;
}

/** Photo-like texture: smooth structure + deterministic noise. */
export function photoLike(width = 640, height = 480, seed = 1): RgbaImage {
  const img = blank(width, height);
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const base = 128 + 60 * Math.sin(x / 37) * Math.cos(y / 23) + 40 * Math.sin((x + y) / 71);
      img.data[p] = base + 30 * Math.sin(y / 13) + rand() * 18;
      img.data[p + 1] = base * 0.9 + 20 * Math.cos(x / 19) + rand() * 18;
      img.data[p + 2] = base * 0.7 + 50 + rand() * 18;
      img.data[p + 3] = 255;
    }
  }
  return img;
}

/**
 * Object on a textured background plus its exact ground-truth alpha: used to
 * test background-removal post-processing with a deterministic "model".
 */
export function objectOnBackground(width = 320, height = 240): { image: RgbaImage; alpha: Float32Array } {
  const image = blank(width, height);
  const alpha = new Float32Array(width * height);
  const cx = width * 0.5;
  const cy = height * 0.55;
  const r = height * 0.3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      const a = discCoverage(x, y, cx, cy, r);
      alpha[i] = a;
      // Background: saturated green with a stripe texture; foreground: red.
      const bg = [30, 190 + 30 * Math.sin(x / 5), 60];
      const fg = [220, 40, 50];
      for (let c = 0; c < 3; c++) image.data[p + c] = fg[c]! * a + bg[c]! * (1 - a);
      image.data[p + 3] = 255;
    }
  }
  return { image, alpha };
}
