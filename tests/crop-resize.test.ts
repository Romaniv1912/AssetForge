import { describe, expect, it } from 'vitest';
import './helpers/setup';
import { cropImage, findContentBounds, padImage } from '../src/image/crop/smart-crop';
import { computeTargetSize, resizeImage } from '../src/image/resize/resize';
import type { ResizeOptions } from '../src/image/types';
import { blank, transparentIllustration } from './helpers/synthetic';

describe('smart crop', () => {
  it('finds the exact bounds, keeping faint anti-aliased pixels', () => {
    const image = blank(50, 40);
    // Solid block 10..19 × 5..14 plus a single alpha=1 pixel at (30, 35).
    for (let y = 5; y < 15; y++) for (let x = 10; x < 20; x++) image.data.set([200, 0, 0, 255], (y * 50 + x) * 4);
    image.data.set([200, 0, 0, 1], (35 * 50 + 30) * 4);
    expect(findContentBounds(image)).toEqual({ x: 10, y: 5, width: 21, height: 31 });
    // A higher threshold ignores the near-invisible pixel.
    expect(findContentBounds(image, 8)).toEqual({ x: 10, y: 5, width: 10, height: 10 });
  });

  it('never cuts visible pixels of a soft-edged object', () => {
    const image = transparentIllustration(300, 200);
    const bounds = findContentBounds(image)!;
    const cropped = cropImage(image, bounds);
    let visibleBefore = 0;
    let visibleAfter = 0;
    let alphaSumBefore = 0;
    let alphaSumAfter = 0;
    for (let p = 3; p < image.data.length; p += 4) {
      if (image.data[p]! > 0) visibleBefore++;
      alphaSumBefore += image.data[p]!;
    }
    for (let p = 3; p < cropped.data.length; p += 4) {
      if (cropped.data[p]! > 0) visibleAfter++;
      alphaSumAfter += cropped.data[p]!;
    }
    expect(visibleAfter).toBe(visibleBefore);
    expect(alphaSumAfter).toBe(alphaSumBefore);
    expect(cropped.width).toBeLessThan(image.width);
  });

  it('returns null for fully transparent images and pads with transparency', () => {
    expect(findContentBounds(blank(10, 10))).toBeNull();
    const padded = padImage(blank(4, 3, [1, 2, 3, 255]), 8);
    expect([padded.width, padded.height]).toEqual([20, 19]);
    expect(padded.data[3]).toBe(0);
    expect(padded.data[(8 * 20 + 8) * 4 + 3]).toBe(255);
  });
});

describe('resize', () => {
  const base: ResizeOptions = { enabled: true, maxWidth: 1024, maxHeight: 1024, preserveAspectRatio: true, allowUpscale: false };

  it('fits within the maximum, preserving aspect ratio', () => {
    expect(computeTargetSize({ width: 4000, height: 3000 }, base)).toEqual({ width: 1024, height: 768 });
    expect(computeTargetSize({ width: 3000, height: 4000 }, base)).toEqual({ width: 768, height: 1024 });
  });

  it('never upscales by default, but can when allowed', () => {
    expect(computeTargetSize({ width: 300, height: 200 }, base)).toEqual({ width: 300, height: 200 });
    expect(computeTargetSize({ width: 300, height: 200 }, { ...base, allowUpscale: true })).toEqual({ width: 1024, height: 683 });
  });

  it('handles independent axes and reserved padding', () => {
    expect(computeTargetSize({ width: 2000, height: 500 }, { ...base, preserveAspectRatio: false })).toEqual({ width: 1024, height: 500 });
    expect(computeTargetSize({ width: 2000, height: 1000 }, base, 16)).toEqual({ width: 1008, height: 504 });
    expect(computeTargetSize({ width: 2000, height: 1000 }, { ...base, enabled: false })).toEqual({ width: 2000, height: 1000 });
  });

  it('resamples to the exact size without dark fringes on transparent edges', async () => {
    // Opaque red square on a transparent canvas whose hidden colour is black.
    const image = blank(64, 64);
    for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) image.data.set([255, 0, 0, 255], (y * 64 + x) * 4);
    const small = await resizeImage(image, { width: 21, height: 21 });
    expect([small.width, small.height]).toEqual([21, 21]);
    for (let p = 0; p < small.data.length; p += 4) {
      if (small.data[p + 3]! >= 32) {
        // Premultiplied resampling: edge pixels stay red instead of darkening.
        expect(small.data[p]!).toBeGreaterThan(200);
      }
    }
  });
});
