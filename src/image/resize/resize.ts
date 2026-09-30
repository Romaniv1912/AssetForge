import { resample } from '../codecs';
import type { ResizeOptions, RgbaImage } from '../types';

export interface Size {
  width: number;
  height: number;
}

/**
 * Computes the output size for the resize options.
 *
 * `reserved` pixels (e.g. crop padding added afterwards) are subtracted from
 * the maximum so that the *final* asset respects maxWidth/maxHeight.
 */
export function computeTargetSize(source: Size, options: ResizeOptions, reserved = 0): Size {
  if (!options.enabled) return { ...source };
  const maxW = options.maxWidth > 0 ? Math.max(1, options.maxWidth - reserved) : Infinity;
  const maxH = options.maxHeight > 0 ? Math.max(1, options.maxHeight - reserved) : Infinity;

  if (options.preserveAspectRatio) {
    let scale = Math.min(maxW / source.width, maxH / source.height);
    if (!Number.isFinite(scale)) return { ...source };
    if (!options.allowUpscale) scale = Math.min(scale, 1);
    if (scale === 1) return { ...source };
    return {
      width: Math.max(1, Math.round(source.width * scale)),
      height: Math.max(1, Math.round(source.height * scale)),
    };
  }

  // Independent axes: each dimension is clamped (or stretched when upscaling).
  const fit = (value: number, max: number) => {
    if (!Number.isFinite(max)) return value;
    return options.allowUpscale ? max : Math.min(value, max);
  };
  return { width: Math.round(fit(source.width, maxW)), height: Math.round(fit(source.height, maxH)) };
}

/**
 * Lanczos3 for downscaling (sharpest without ringing artefacts in practice) and
 * Catmull-Rom for upscaling (less ringing on enlarged edges). Both run on
 * premultiplied, linear-light values so transparent pixels never bleed dark
 * fringes into edges and averaging is gamma-correct.
 */
export async function resizeImage(image: RgbaImage, target: Size): Promise<RgbaImage> {
  if (target.width === image.width && target.height === image.height) return image;
  const upscaling = target.width > image.width || target.height > image.height;
  return resample(image, target.width, target.height, {
    filter: upscaling ? 'catrom' : 'lanczos3',
    premultiply: true,
    linearRGB: true,
  });
}
