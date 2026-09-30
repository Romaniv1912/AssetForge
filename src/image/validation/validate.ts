import { decodeAvif, decodeJpeg, decodePng, decodeWebp } from '../codecs';
import { sniffFormat } from '../decode/sniff';
import { compareImages } from '../metrics/ssim';
import type { EncodableFormat, QualityMetrics, RgbaImage } from '../types';

export interface ValidationResult {
  metrics: QualityMetrics;
  decoded: RgbaImage;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Decodes the produced file with an independent decoder and verifies it:
 * correct container, dimensions, alpha preserved, and the final perceptual
 * metrics against the reference pixels.
 */
export async function validateOutput(
  bytes: Uint8Array,
  format: EncodableFormat,
  reference: RgbaImage,
  options: { expectAlpha: boolean },
): Promise<ValidationResult> {
  if (bytes.length === 0) throw new ValidationError('Encoder produced an empty file');
  const sniffed = sniffFormat(bytes);
  if (sniffed !== format) throw new ValidationError(`Output is not a valid ${format.toUpperCase()} file (detected ${sniffed})`);

  let decoded: RgbaImage;
  try {
    decoded = await decodeFor(format)(bytes);
  } catch (error) {
    throw new ValidationError(`Output could not be decoded: ${(error as Error).message}`);
  }
  if (decoded.width !== reference.width || decoded.height !== reference.height) {
    throw new ValidationError(
      `Output size ${decoded.width}×${decoded.height} does not match expected ${reference.width}×${reference.height}`,
    );
  }
  if (options.expectAlpha && format !== 'jpeg') {
    let transparent = false;
    const d = decoded.data;
    for (let p = 3; p < d.length; p += 4) {
      if (d[p] !== 255) {
        transparent = true;
        break;
      }
    }
    if (!transparent) throw new ValidationError('Transparency was lost during encoding');
  }
  const metrics = compareImages(reference, decoded, { hasAlpha: options.expectAlpha && format !== 'jpeg' });
  return { metrics, decoded };
}

export function decodeFor(format: EncodableFormat): (bytes: Uint8Array) => Promise<RgbaImage> {
  switch (format) {
    case 'png':
      return decodePng;
    case 'jpeg':
      return decodeJpeg;
    case 'webp':
      return decodeWebp;
    case 'avif':
      return decodeAvif;
  }
}
