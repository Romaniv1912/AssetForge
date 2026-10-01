import { resample } from '../codecs';
import { compareImages } from '../metrics/ssim';
import type { RgbaImage } from '../types';

/**
 * Down-and-up SSIM at or above this means the image holds no detail beyond
 * 1/d of its size (it was upscaled or is blurred). Measured: sharp photos and
 * illustrations score 0.91–0.98 at d = 2; an emoji sheet upscaled from 256 px
 * scores 0.990.
 */
const SOFT_THRESHOLD = 0.985;

const OPTS = { premultiply: true, linearRGB: true } as const;

/**
 * How much smaller the image can be made without losing detail: 4, 2 or 1.
 * AI upscaling then starts from that size, so the model sees real pixels
 * instead of blur it would otherwise preserve as "content".
 */
export async function detailFactor(image: RgbaImage, maxFactor: number): Promise<number> {
  for (const d of [4, 2]) {
    if (d > maxFactor || image.width < d * 32 || image.height < d * 32) continue;
    const small = await resample(image, Math.round(image.width / d), Math.round(image.height / d), { filter: 'lanczos3', ...OPTS });
    const back = await resample(small, image.width, image.height, { filter: 'lanczos3', ...OPTS });
    if (compareImages(image, back).ssim >= SOFT_THRESHOLD) return d;
  }
  return 1;
}

export async function shrink(image: RgbaImage, factor: number): Promise<RgbaImage> {
  if (factor === 1) return image;
  return resample(image, Math.round(image.width / factor), Math.round(image.height / factor), { filter: 'lanczos3', ...OPTS });
}
