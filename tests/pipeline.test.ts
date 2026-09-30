import { describe, expect, it } from 'vitest';
import './helpers/setup';
import { encodeJpeg, encodePng, encodeWebp, optimisePngRaw } from '../src/image/codecs';
import { decodeImage } from '../src/image/decode/decode';
import { processImage } from '../src/image/pipeline/process-image';
import { CancelledError, type ProcessingStage } from '../src/image/types';
import { fixture, options } from './helpers/setup';
import { blank, gradient, photoLike, transparentIllustration } from './helpers/synthetic';

describe('processImage pipeline', () => {
  it('transparent PNG: crops to content, pads, keeps alpha, reports stages', async () => {
    const bytes = await encodePng(transparentIllustration(400, 300));
    const stages: ProcessingStage[] = [];
    const result = await processImage(bytes, options({ crop: { enabled: true, padding: 8 } }), {
      onProgress: (p) => {
        if (stages[stages.length - 1] !== p.stage) stages.push(p.stage);
      },
    });
    expect(result.cropped).toBe(true);
    expect(result.width).toBeLessThan(400);
    expect(result.analysis.hasAlpha).toBe(true);
    expect(result.outputBytes).toBeLessThan(result.originalBytes);
    expect(stages).toEqual(['loading', 'analyzing', 'cropping', 'resizing', 'compressing', 'validating', 'complete']);
    const decoded = await decodeImage(result.data);
    // Padding is transparent.
    expect(decoded.image.data[3]).toBe(0);
    expect([decoded.image.width, decoded.image.height]).toEqual([result.width, result.height]);
  });

  it('opaque PNG photo: no padding is added, format chosen by measurement', async () => {
    const result = await processImage(fixture('coffee.png'), options({ crop: { enabled: true, padding: 8 } }));
    expect(result.cropped).toBe(false);
    expect([result.width, result.height]).toEqual([600, 400]);
    expect(result.analysis.hasAlpha).toBe(false);
    expect(result.savings).toBeGreaterThan(0.7);
    expect(result.candidates.length).toBeGreaterThan(1);
  });

  it('JPEG input: never recompresses into a bigger or barely smaller file', async () => {
    const original = fixture('rocket.jpg');
    const result = await processImage(original, options({ compression: { format: 'jpeg', preset: 'maximum' } }));
    expect(result.outputBytes).toBeLessThanOrEqual(original.length);
    expect(result.format).toBe('jpeg');
  });

  it('WebP input is decoded and re-optimised', async () => {
    const webp = await encodeWebp(photoLike(300, 200), { quality: 100, method: 0 });
    const result = await processImage(webp, options({ compression: { format: 'webp', preset: 'balanced' } }));
    expect(result.format).toBe('webp');
    expect(result.outputBytes).toBeLessThan(webp.length);
  });

  it('gradients stay smooth (worst-block SSIM guards against banding)', async () => {
    const bytes = await optimisePngRaw(gradient(512, 256), { level: 1 });
    const result = await processImage(bytes, options({ compression: { format: 'png', preset: 'high' } }));
    expect(result.metrics.worstBlockSsim).toBeGreaterThan(0.9);
  });

  it('fine detail (Hubble deep field) keeps high fidelity', async () => {
    const result = await processImage(fixture('hubble_deep_field.jpg'), options({ compression: { format: 'webp', preset: 'high' } }));
    expect(result.metrics.ssim).toBeGreaterThan(0.98);
  });

  it('resizes large images with the aspect ratio preserved and no upscaling', async () => {
    const big = await encodeJpeg(photoLike(3000, 2000, 3), { quality: 90 });
    const result = await processImage(
      big,
      options({ resize: { enabled: true, maxWidth: 1024, maxHeight: 1024 }, compression: { format: 'jpeg', preset: 'balanced' } }),
    );
    expect([result.width, result.height]).toEqual([1024, 683]);
    expect(result.resized).toBe(true);

    const small = await encodePng(photoLike(64, 48));
    const kept = await processImage(small, options({ resize: { enabled: true, maxWidth: 1024, maxHeight: 1024 } }));
    expect([kept.width, kept.height]).toEqual([64, 48]);
    expect(kept.resized).toBe(false);
  });

  it('handles very small images (1×1 and 3×2)', async () => {
    for (const [w, h] of [
      [1, 1],
      [3, 2],
    ] as const) {
      const img = blank(w, h, [200, 50, 20, 255]);
      const result = await processImage(await encodePng(img), options());
      expect([result.width, result.height]).toEqual([w, h]);
      const decoded = await decodeImage(result.data);
      expect(decoded.image.data[0]).toBeGreaterThan(180);
    }
  });

  it('keeps the original when it is already optimal', async () => {
    const tiny = await optimisePngRaw(blank(16, 16, [10, 20, 30, 255]), { level: 6 });
    const result = await processImage(tiny, options({ crop: { enabled: false } }));
    expect(result.outputBytes).toBeLessThanOrEqual(tiny.length);
  });

  it('fails with a clear reason for unusable input', async () => {
    await expect(processImage(new Uint8Array([1, 2, 3, 4]), options())).rejects.toThrow(/Unrecognised image format/);
    const empty = await encodePng(blank(20, 20));
    await expect(processImage(empty, options({ crop: { enabled: true } }))).rejects.toThrow(/fully transparent/);
    await expect(
      processImage(await encodePng(photoLike(32, 32)), options({ backgroundRemoval: { enabled: true, skipIfTransparent: false } })),
    ).rejects.toThrow(/not available/);
  });

  it('supports cooperative cancellation', async () => {
    const token = { cancelled: false };
    const promise = processImage(fixture('astronaut.png'), options(), {
      cancel: token,
      onProgress: (p) => {
        if (p.stage === 'compressing') token.cancelled = true;
      },
    });
    await expect(promise).rejects.toBeInstanceOf(CancelledError);
  });
});
