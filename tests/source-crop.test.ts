import { describe, expect, it } from 'vitest';
import './helpers/setup';
import { encodePng } from '../src/image/codecs';
import { decodeImage } from '../src/image/decode/decode';
import { pixelRect, processImage } from '../src/image/pipeline/process-image';
import { cropOf } from '../src/shared/figma/crop';
import { options } from './helpers/setup';
import { photoLike } from './helpers/synthetic';

describe('Figma crop detection', () => {
  it('reads the visible region from an axis-aligned crop transform', () => {
    const crop = cropOf({ scaleMode: 'CROP', imageTransform: [[0.5, 0, 0.25], [0, 0.4, 0.1]] });
    expect(crop).toEqual({ x: 0.25, y: 0.1, width: 0.5, height: 0.4 });
  });

  it('ignores uncropped, non-crop, rotated and flipped fills', () => {
    expect(cropOf({ scaleMode: 'CROP', imageTransform: [[1, 0, 0], [0, 1, 0]] })).toBeNull();
    expect(cropOf({ scaleMode: 'FILL', imageTransform: [[0.5, 0, 0], [0, 0.5, 0]] })).toBeNull();
    expect(cropOf({ scaleMode: 'CROP', imageTransform: [[0.4, 0.3, 0.1], [-0.3, 0.4, 0.3]] })).toBeNull();
    expect(cropOf({ scaleMode: 'CROP', imageTransform: [[-0.5, 0, 0.5], [0, 0.5, 0]] })).toBeNull();
    expect(cropOf({ scaleMode: 'CROP' })).toBeNull();
  });

  it('clamps regions that extend past the image', () => {
    expect(cropOf({ scaleMode: 'CROP', imageTransform: [[0.6, 0, 0.6], [0, 0.5, -0.1]] })).toEqual({ x: 0.6, y: 0, width: 0.4, height: 0.4 });
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
});
