import { describe, expect, it } from 'vitest';
import './helpers/setup';
import { analyzeImage } from '../src/image/analysis/analyze';
import { optimisePngRaw } from '../src/image/codecs';
import { compress } from '../src/image/compression/compress';
import { QUALITY_TARGETS } from '../src/image/compression/presets';
import { wuQuantizer } from '../src/image/compression/quantize';
import { decodeImage } from '../src/image/decode/decode';
import { sniffFormat } from '../src/image/decode/sniff';
import { compareImages } from '../src/image/metrics/ssim';
import type { CompressionOptions, CompressionPreset, OutputFormat, RgbaImage } from '../src/image/types';
import { validateOutput } from '../src/image/validation/validate';
import { fixture } from './helpers/setup';
import { flatGraphic, gradient, pixelArt, transparentIllustration } from './helpers/synthetic';

const opts = (format: OutputFormat, preset: CompressionPreset = 'high', extra: Partial<CompressionOptions> = {}): CompressionOptions => ({
  format,
  preset,
  allowAvifInAuto: false,
  custom: { quality: 75, lossless: false },
  ...extra,
});

async function run(image: RgbaImage, options: CompressionOptions) {
  const analysis = analyzeImage(image, 'png');
  const out = await compress({ image, analysis, options });
  const validation = await validateOutput(out.bytes, out.format, out.encodedFrom, { expectAlpha: analysis.hasAlpha });
  return { out, analysis, validation };
}

describe('palette quantisation', () => {
  it('respects the colour budget and keeps transparency', () => {
    const image = transparentIllustration(200, 150);
    const q = wuQuantizer.quantize(image, 32, { dithering: 1 });
    const colors = new Set<number>();
    for (let p = 0; p < q.data.length; p += 4) colors.add((q.data[p]! << 24) | (q.data[p + 1]! << 16) | (q.data[p + 2]! << 8) | q.data[p + 3]!);
    expect(colors.size).toBeLessThanOrEqual(32);
    for (let p = 3; p < q.data.length; p += 4) if (image.data[p] === 0) expect(q.data[p]).toBe(0);
  });

  it('dithers smooth gradients instead of banding', () => {
    const image = gradient(256, 64);
    const q = wuQuantizer.quantize(image, 16, { dithering: 1 });
    const flat = wuQuantizer.quantize(image, 16, { dithering: 0 });
    const dithered = compareImages(image, q, { ditherTolerant: true });
    const banded = compareImages(image, flat, { ditherTolerant: true });
    expect(dithered.ssim).toBeGreaterThan(banded.ssim);
  });
});

describe('perceptual compression', () => {
  it.each(['png', 'webp', 'avif'] as const)('%s keeps alpha, decodes and meets the "high" target', async (format) => {
    const image = transparentIllustration(320, 240);
    const { out, validation } = await run(image, opts(format));
    expect(out.format).toBe(format);
    expect(sniffFormat(out.bytes)).toBe(format);
    expect(validation.metrics.ssim).toBeGreaterThanOrEqual(QUALITY_TARGETS.high.minSsim - 0.003);
    expect(validation.decoded.data.some((v, i) => i % 4 === 3 && v < 255)).toBe(true);
  });

  it('JPEG output flattens transparency onto white and says so', async () => {
    const image = transparentIllustration(160, 120);
    const { out, validation } = await run(image, opts('jpeg'));
    expect(out.format).toBe('jpeg');
    expect(out.warnings.join(' ')).toMatch(/flattened onto white/);
    expect(validation.decoded.data[3]).toBe(255);
    // Top-left pixel was transparent → white.
    expect(validation.decoded.data[0]).toBeGreaterThan(245);
  });

  it('beats a lossless PNG of a real photo by a wide margin at "high" quality', async () => {
    const { image } = await decodeImage(fixture('chelsea.png'));
    const lossless = await optimisePngRaw(image, { level: 2 });
    const { out, validation } = await run(image, opts('auto'));
    expect(out.bytes.length).toBeLessThan(lossless.length * 0.25);
    expect(validation.metrics.ssim).toBeGreaterThanOrEqual(QUALITY_TARGETS.high.minSsim - 0.003);
    expect(['webp', 'jpeg']).toContain(out.format);
  });

  it('lossy PNG (palette) shrinks a transparent illustration like pngquant/TinyPNG', async () => {
    const { image } = await decodeImage(fixture('logo.png'));
    const lossless = await optimisePngRaw(image, { level: 2 });
    const { out } = await run(image, opts('png'));
    expect(out.settings).toMatch(/Quantised PNG/);
    expect(out.bytes.length).toBeLessThan(lossless.length * 0.5);
    expect(out.bytes[25]).toBe(3); // indexed colour
  });

  it('keeps exact-colour assets lossless in auto mode', async () => {
    const image = pixelArt(96);
    const { out, validation } = await run(image, opts('auto'));
    expect(['png', 'webp']).toContain(out.format);
    expect(validation.metrics.psnr).toBe(Infinity);
  });

  it('measures candidates instead of assuming a format', async () => {
    const { out } = await run(flatGraphic(320, 200), opts('auto'));
    expect(out.candidates.length).toBeGreaterThanOrEqual(2);
    const smallestPassing = Math.min(...out.candidates.filter((c) => c.passed).map((c) => c.bytes));
    expect(out.bytes.length).toBe(smallestPassing);
  });

  it('presets are ordered: smaller presets never produce larger files', async () => {
    const { image } = await decodeImage(fixture('astronaut.png'));
    const sizes: number[] = [];
    for (const preset of ['maximum', 'high', 'balanced', 'small'] as const) {
      const { out } = await run(image, opts('webp', preset));
      sizes.push(out.bytes.length);
    }
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeLessThanOrEqual(sizes[i - 1]!);
    expect(sizes[3]!).toBeLessThan(sizes[0]! * 0.6);
  });

  it('custom preset encodes at a fixed quality without searching', async () => {
    const image = gradient(200, 100);
    const { out } = await run(image, opts('webp', 'custom', { custom: { quality: 55, lossless: false } }));
    expect(out.settings).toMatch(/q55/);
    const lossless = await run(image, opts('webp', 'custom', { custom: { quality: 55, lossless: true } }));
    expect(lossless.out.settings).toMatch(/lossless/);
    expect(lossless.validation.metrics.psnr).toBe(Infinity);
  });
});
