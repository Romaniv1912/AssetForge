import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeImage } from '../src/image/decode/decode';
import type { RgbaImage } from '../src/image/types';
import { flatGraphic, gradient, pixelArt, transparentIllustration } from '../tests/helpers/synthetic';

export interface BenchmarkImage {
  name: string;
  kind: 'photo' | 'avatar' | 'illustration' | 'transparent-illustration' | 'flat-graphic' | 'gradient' | 'detailed' | 'pixel-art' | 'text';
  /** Real file bytes (reduction is measured against this size)… */
  bytes?: Uint8Array;
  /** …or synthetic pixels (measured against a standard lossless PNG). */
  image?: RgbaImage;
}

const read = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/images/${name}`, import.meta.url))));

/** Soft circular cut-out, like an avatar after background removal. */
async function transparentAvatar(): Promise<RgbaImage> {
  const { image } = await decodeImage(read('astronaut.png'));
  const { width, height, data } = image;
  const cx = width / 2;
  const cy = height * 0.42;
  const r = width * 0.36;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const a = Math.max(0, Math.min(1, (r - d) / 2 + 0.5));
      data[(y * width + x) * 4 + 3] = Math.round(a * 255);
      if (a === 0) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
  }
  return image;
}

export async function loadBenchmarkImages(): Promise<BenchmarkImage[]> {
  return [
    { name: 'astronaut', kind: 'avatar', bytes: read('astronaut.png') },
    { name: 'chelsea', kind: 'photo', bytes: read('chelsea.png') },
    { name: 'coffee', kind: 'photo', bytes: read('coffee.png') },
    { name: 'rocket', kind: 'photo', bytes: read('rocket.jpg') },
    { name: 'hubble', kind: 'detailed', bytes: read('hubble_deep_field.jpg') },
    { name: 'logo', kind: 'illustration', bytes: read('logo.png') },
    { name: 'text', kind: 'text', bytes: read('text.png') },
    { name: 'avatar-cutout', kind: 'avatar', image: await transparentAvatar() },
    { name: 'illustration', kind: 'transparent-illustration', image: transparentIllustration(640, 480) },
    { name: 'flat', kind: 'flat-graphic', image: flatGraphic(800, 520) },
    { name: 'gradient', kind: 'gradient', image: gradient(800, 400) },
    { name: 'pixel-art', kind: 'pixel-art', image: pixelArt(128) },
  ];
}
