import { describe, expect, it } from 'vitest';
import './helpers/setup';
import { compareImages } from '../src/image/metrics/ssim';
import { gradient, photoLike, transparentIllustration } from './helpers/synthetic';

describe('perceptual metrics', () => {
  it('reports perfect scores for identical images', () => {
    const image = photoLike(120, 80);
    const m = compareImages(image, { ...image, data: image.data.slice() });
    expect(m.ssim).toBeCloseTo(1, 6);
    expect(m.worstBlockSsim).toBeGreaterThan(0.999);
    expect(m.psnr).toBe(Infinity);
  });

  it('decreases monotonically with distortion', () => {
    const image = gradient(128, 128);
    const noisy = (amount: number) => {
      const data = image.data.slice();
      let s = 7;
      for (let p = 0; p < data.length; p += 4) {
        for (let c = 0; c < 3; c++) {
          s = (s * 1103515245 + 12345) >>> 0;
          data[p + c] = data[p + c]! + ((s / 2 ** 32) - 0.5) * amount;
        }
      }
      return { ...image, data };
    };
    const a = compareImages(image, noisy(10));
    const b = compareImages(image, noisy(40));
    expect(a.ssim).toBeGreaterThan(b.ssim);
    expect(a.psnr).toBeGreaterThan(b.psnr);
  });

  it('detects alpha-only differences (halos, lost transparency)', () => {
    const image = transparentIllustration(100, 80);
    const data = image.data.slice();
    for (let p = 3; p < data.length; p += 4) if (data[p]! > 0 && data[p]! < 255) data[p] = 255;
    const m = compareImages(image, { ...image, data });
    expect(m.maxAlphaError).toBeGreaterThan(100);
    expect(m.ssim).toBeLessThan(0.999);
  });

  it('localised damage lowers the worst-block score far more than the mean', () => {
    const image = photoLike(256, 256);
    const data = image.data.slice();
    for (let y = 100; y < 124; y++) for (let x = 100; x < 124; x++) data.set([0, 0, 0, 255], (y * 256 + x) * 4);
    const m = compareImages(image, { ...image, data });
    expect(m.ssim).toBeGreaterThan(0.97);
    expect(m.worstBlockSsim).toBeLessThan(0.5);
  });
});

describe('perceptual metrics on very large images', () => {
  it('bounds memory by comparing at reduced scale', () => {
    const width = 4200;
    const height = 4000;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < data.length; p += 4) {
      data[p] = (p >> 4) & 255;
      data[p + 1] = 128;
      data[p + 2] = 64;
      data[p + 3] = 255;
    }
    const image = { width, height, data };
    const m = compareImages(image, { width, height, data: data.slice() });
    expect(m.ssim).toBeCloseTo(1, 6);
    expect(m.maxAlphaError).toBe(0);
  });
});
