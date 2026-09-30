import { decodeAvif, decodeJpeg, decodePng, decodeWebp } from '../codecs';
import type { ImageFormat, RgbaImage } from '../types';
import { sniffFormat } from './sniff';

/**
 * Optional platform decoder for formats without a bundled WASM decoder (GIF,
 * BMP). In a browser/worker this uses createImageBitmap + OffscreenCanvas.
 */
export type FallbackDecoder = (bytes: Uint8Array, format: ImageFormat) => Promise<RgbaImage>;

export interface DecodedImage {
  image: RgbaImage;
  format: ImageFormat;
  warnings: string[];
}

/** Largest image the engine accepts (pixels). ~100 MP ≈ 400 MB of RGBA. */
export const MAX_PIXELS = 100_000_000;

export async function decodeImage(bytes: Uint8Array, fallback?: FallbackDecoder): Promise<DecodedImage> {
  const format = sniffFormat(bytes);
  const warnings: string[] = [];
  let image: RgbaImage;
  switch (format) {
    case 'png':
      image = await decodePng(bytes);
      break;
    case 'jpeg':
      image = await decodeJpeg(bytes);
      break;
    case 'webp':
      image = await decodeWebp(bytes);
      break;
    case 'avif':
      image = await decodeAvif(bytes);
      break;
    case 'gif':
    case 'bmp':
      if (!fallback) throw new Error(`${format.toUpperCase()} images cannot be decoded in this environment`);
      image = await fallback(bytes, format);
      if (format === 'gif') warnings.push('GIF: only the first frame is processed; animation is not preserved.');
      break;
    default:
      throw new Error('Unrecognised image format. Supported inputs: PNG, JPEG, WebP, AVIF, GIF.');
  }
  if (image.width < 1 || image.height < 1) throw new Error('The image has no pixels');
  if (image.width * image.height > MAX_PIXELS) {
    throw new Error(`Image is too large (${image.width}×${image.height}); the limit is ${MAX_PIXELS / 1e6} megapixels`);
  }
  return { image, format, warnings };
}

/** Decoder based on browser primitives; available in windows and workers. */
export const browserFallbackDecoder: FallbackDecoder = async (bytes, format) => {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    throw new Error(`${format.toUpperCase()} decoding needs createImageBitmap/OffscreenCanvas support`);
  }
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas is unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: data.width, height: data.height, data: data.data };
  } finally {
    bitmap.close();
  }
};
