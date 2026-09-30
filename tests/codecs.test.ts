import { describe, expect, it } from 'vitest';
import './helpers/setup';
import {
  decodeAvif,
  decodeJpeg,
  decodePng,
  decodeWebp,
  encodeAvif,
  encodeJpeg,
  encodePng,
  encodeWebp,
  optimisePngRaw,
} from '../src/image/codecs';
import { compareImages } from '../src/image/metrics/ssim';
import { fixture } from './helpers/setup';
import { insertExifOrientation } from './helpers/exif';
import { photoLike, pixelArt, transparentIllustration } from './helpers/synthetic';

describe('codecs (WASM, same binaries as the plugin)', () => {
  it('round-trips PNG losslessly, including alpha', async () => {
    const image = transparentIllustration(120, 90);
    const decoded = await decodePng(await encodePng(image));
    expect(decoded.width).toBe(120);
    expect(Array.from(decoded.data)).toEqual(Array.from(image.data));
  });

  it('oxipng output is lossless and smaller than a plain PNG', async () => {
    const image = transparentIllustration(200, 150);
    const plain = await encodePng(image);
    const optimised = await optimisePngRaw(image, { level: 3 });
    expect(optimised.length).toBeLessThan(plain.length);
    const decoded = await decodePng(optimised);
    // optimiseAlpha may rewrite the colour of fully transparent pixels only.
    for (let p = 0; p < image.data.length; p += 4) {
      expect(decoded.data[p + 3]).toBe(image.data[p + 3]);
      if (image.data[p + 3]! > 0) expect(decoded.data[p]).toBe(image.data[p]);
    }
  });

  it('oxipng reduces a ≤256-colour image to an indexed PNG (colour type 3)', async () => {
    const png = await optimisePngRaw(pixelArt(64), { level: 2 });
    expect(png[25]).toBe(3);
  });

  it('WebP lossy keeps alpha and good quality', async () => {
    const image = transparentIllustration(200, 150);
    const decoded = await decodeWebp(await encodeWebp(image, { quality: 85, alpha_quality: 100 }));
    const metrics = compareImages(image, decoded);
    expect(metrics.ssim).toBeGreaterThan(0.97);
    expect(metrics.maxAlphaError).toBeLessThanOrEqual(2);
  });

  it('WebP lossless is exact on visible pixels', async () => {
    const image = transparentIllustration(160, 120);
    const decoded = await decodeWebp(await encodeWebp(image, { lossless: 1, quality: 75, method: 4, exact: 1 }));
    expect(Array.from(decoded.data)).toEqual(Array.from(image.data));
  });

  it('AVIF encodes and decodes with alpha', async () => {
    const image = transparentIllustration(160, 120);
    const decoded = await decodeAvif(await encodeAvif(image, { quality: 70, qualityAlpha: 90, speed: 8 }));
    expect(decoded.width).toBe(160);
    expect(decoded.height).toBe(120);
    expect(compareImages(image, decoded).ssim).toBeGreaterThan(0.95);
  });

  it('MozJPEG produces progressive JPEGs that decode at the right size', async () => {
    const image = photoLike(200, 100);
    const jpeg = await encodeJpeg(image, { quality: 92 });
    expect(jpeg[0]).toBe(0xff);
    // SOF2 marker = progressive DCT
    let progressive = false;
    for (let i = 2; i < jpeg.length - 1; i++) if (jpeg[i] === 0xff && jpeg[i + 1] === 0xc2) progressive = true;
    expect(progressive).toBe(true);
    const decoded = await decodeJpeg(jpeg);
    expect([decoded.width, decoded.height]).toEqual([200, 100]);
    expect(compareImages(image, decoded).ssim).toBeGreaterThan(0.9);
  });

  it('applies EXIF orientation when decoding JPEG', async () => {
    const jpeg = await encodeJpeg(photoLike(40, 20), { quality: 90 });
    const oriented = insertExifOrientation(jpeg, 6); // rotate 90° CW
    const decoded = await decodeJpeg(oriented);
    expect([decoded.width, decoded.height]).toEqual([20, 40]);
  });

  it('decodes real-world fixtures', async () => {
    const rocket = await decodeJpeg(fixture('rocket.jpg'));
    expect([rocket.width, rocket.height]).toEqual([640, 427]);
    const logo = await decodePng(fixture('logo.png'));
    expect([logo.width, logo.height]).toEqual([500, 500]);
  });
});
