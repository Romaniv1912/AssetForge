import { describe, expect, it } from 'vitest';
import './helpers/setup';
import { encodePng, releaseCodecMemory } from '../src/image/codecs';
import { processBatch } from '../src/image/pipeline/batch';
import { fixture, options } from './helpers/setup';
import { photoLike, transparentIllustration } from './helpers/synthetic';

describe('batch processing', () => {
  it('processes many images; one failure does not stop the batch', async () => {
    const good = await encodePng(transparentIllustration(160, 120));
    const inputs = [
      { id: 'a', load: async () => good.slice() },
      { id: 'broken', load: async () => new Uint8Array([0, 1, 2, 3]) },
      { id: 'missing', load: async () => Promise.reject(new Error('Image not found in this file')) },
      { id: 'b', load: async () => fixture('logo.png') },
      { id: 'c', load: async () => encodePng(photoLike(200, 150)) },
    ];
    const seen: string[] = [];
    const results = await processBatch(inputs, options({ compression: { format: 'webp', preset: 'balanced' } }), {}, {
      concurrency: 2,
      onItem: (item) => seen.push(item.id),
    });
    expect(results.map((r) => r.status)).toEqual(['completed', 'failed', 'failed', 'completed', 'completed']);
    expect(results[1]).toMatchObject({ status: 'failed', error: expect.stringMatching(/Unrecognised/) });
    expect(results[2]).toMatchObject({ status: 'failed', error: 'Image not found in this file' });
    expect(seen.sort()).toEqual(['a', 'b', 'broken', 'c', 'missing']);
  });

  it('honours concurrency limits (bounded memory)', async () => {
    let active = 0;
    let peak = 0;
    const inputs = Array.from({ length: 6 }, (_, i) => ({
      id: String(i),
      load: async () => {
        active++;
        peak = Math.max(peak, active);
        return encodePng(photoLike(96, 64, i + 1));
      },
    }));
    await processBatch(inputs, options({ compression: { format: 'jpeg', preset: 'small' } }), {}, {
      concurrency: 2,
      onItem: () => active--,
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('cancels remaining items', async () => {
    const token = { cancelled: false };
    const inputs = Array.from({ length: 4 }, (_, i) => ({ id: String(i), load: () => encodePng(photoLike(64, 64, i + 1)) }));
    const results = await processBatch(inputs, options(), {}, {
      concurrency: 1,
      cancel: token,
      onItem: () => {
        token.cancelled = true;
      },
    });
    expect(results[0]!.status).toBe('completed');
    expect(results.slice(1).every((r) => r.status === 'cancelled')).toBe(true);
  });

  it('memory stays bounded across a long batch of large images', async () => {
    const source = await encodePng(photoLike(2000, 1500, 9));
    const inputs = Array.from({ length: 8 }, (_, i) => ({ id: String(i), load: async () => source.slice() }));
    const opts = options({ resize: { enabled: true, maxWidth: 800, maxHeight: 800 }, compression: { format: 'webp', preset: 'balanced' } });
    // Warm-up grows WASM heaps to their working size.
    await processBatch(inputs.slice(0, 2), opts, {}, { concurrency: 2 });
    global.gc?.();
    const before = process.memoryUsage().rss;
    const results = await processBatch(inputs, opts, {}, { concurrency: 2 });
    releaseCodecMemory();
    global.gc?.();
    const growth = process.memoryUsage().rss - before;
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    // Eight 3 MP sources must not accumulate: allow generous slack for allocator behaviour.
    expect(growth).toBeLessThan(400 * 1024 * 1024);
  });
});
