import { describe, expect, it } from 'vitest';
import './helpers/setup';
import { encodePng } from '../src/image/codecs';
import { decodeImage } from '../src/image/decode/decode';
import { pixelRect, processImage } from '../src/image/pipeline/process-image';
import { visibleRegion } from '../src/shared/figma/crop';
import { options } from './helpers/setup';
import { photoLike } from './helpers/synthetic';

describe('Figma crop detection', () => {
  const crop = (t: [[number, number, number], [number, number, number]]) => visibleRegion({ scaleMode: 'CROP', imageTransform: t });

  it('reads the visible region from an axis-aligned crop transform', () => {
    expect(crop([[0.5, 0, 0.25], [0, 0.4, 0.1]])).toEqual({ x: 0.25, y: 0.1, width: 0.5, height: 0.4 });
  });

  it('understands the inverse (image → layer) convention', () => {
    // Same crop as above, expressed as the inverse matrix.
    const r = crop([[2, 0, -0.5], [0, 2.5, -0.25]])!;
    expect(r.x).toBeCloseTo(0.25);
    expect(r.y).toBeCloseTo(0.1);
    expect(r.width).toBeCloseTo(0.5);
    expect(r.height).toBeCloseTo(0.4);
  });

  it('ignores uncropped, rotated, flipped and tiled fills', () => {
    expect(crop([[1, 0, 0], [0, 1, 0]])).toBeNull();
    expect(crop([[0.4, 0.3, 0.1], [-0.3, 0.4, 0.3]])).toBeNull();
    expect(crop([[-0.5, 0, 0.5], [0, 0.5, 0]])).toBeNull();
    expect(visibleRegion({ scaleMode: 'CROP' })).toBeNull();
    expect(visibleRegion({ scaleMode: 'TILE' }, { width: 10, height: 10 }, { width: 100, height: 50 })).toBeNull();
  });

  it('clamps regions that extend past the image', () => {
    expect(crop([[0.6, 0, 0.6], [0, 0.5, -0.1]])).toEqual({ x: 0.6, y: 0, width: 0.4, height: 0.4 });
  });

  it('Fill mode shows a centred slice when the layer proportions differ', () => {
    const image = { width: 2000, height: 2000 };
    expect(visibleRegion({ scaleMode: 'FILL' }, { width: 400, height: 200 }, image)).toEqual({ x: 0, y: 0.25, width: 1, height: 0.5 });
    expect(visibleRegion({ scaleMode: 'FILL' }, { width: 300, height: 300 }, image)).toBeNull();
    expect(visibleRegion({ scaleMode: 'FILL', rotation: 90 }, { width: 400, height: 200 }, image)).toBeNull();
    expect(visibleRegion({ scaleMode: 'FIT' }, { width: 400, height: 200 }, image)).toBeNull();
  });

  it('converts to whole pixels inside the image', () => {
    expect(pixelRect({ x: 0.25, y: 0.1, width: 0.5, height: 0.4 }, 400, 300)).toEqual({ x: 100, y: 30, width: 200, height: 120 });
    expect(pixelRect({ x: 0.999, y: 0.999, width: 0.0001, height: 0.0001 }, 100, 100)).toEqual({ x: 99, y: 99, width: 1, height: 1 });
  });
});

describe('processing a cropped fill', () => {
  it('processes only the visible region and never keeps the uncropped original', async () => {
    const source = photoLike(400, 300);
    const bytes = await encodePng(source);
    const result = await processImage(bytes, options({ compression: { format: 'original', preset: 'maximum' } }), {
      sourceCrop: { x: 0.25, y: 0.1, width: 0.5, height: 0.4 },
    });
    expect([result.width, result.height]).toEqual([200, 120]);
    expect(result.placement).toMatchObject({ sourceWidth: 200, sourceHeight: 120, x: 0, y: 0, width: 200, height: 120 });
    const decoded = await decodeImage(result.data);
    expect([decoded.image.width, decoded.image.height]).toEqual([200, 120]);
    // Top-left output pixel is source pixel (100, 30), within lossy tolerance.
    const src = (30 * 400 + 100) * 4;
    for (let c = 0; c < 3; c++) expect(Math.abs(decoded.image.data[c]! - source.data[src + c]!)).toBeLessThan(24);
  });

  it('resizes the cropped region, not the whole image (2000² crop → 512)', async () => {
    const bytes = await encodePng(photoLike(2000, 2000));
    const result = await processImage(
      bytes,
      options({ resize: { enabled: true, maxWidth: 512, maxHeight: 512 }, compression: { format: 'png', preset: 'balanced' } }),
      { sourceCrop: { x: 0.25, y: 0.25, width: 0.5, height: 0.25 } },
    );
    // Visible part is 1000×500 → fits 512 wide.
    expect([result.width, result.height]).toEqual([512, 256]);
    expect(result.resized).toBe(true);
  });
});
