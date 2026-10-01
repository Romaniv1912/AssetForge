/**
 * AI upscaling (super-resolution) models. Like the segmentation models they
 * are ONNX files fetched on first use and cached; every host in `url` must be
 * listed in manifest.json → networkAccess.allowedDomains.
 */
export interface EnhanceModelSpec {
  id: string;
  label: string;
  description: string;
  url: string;
  approxBytes: number;
  /** Output size = input size × scale. */
  scale: number;
  /** Input tile size and overlap (pixels) for tiled inference. */
  tile: number;
  tilePad: number;
  /** Larger inputs are skipped (CPU time and the ×scale² output memory). */
  maxInputPixels: number;
  license: string;
  licenseUrl: string;
  performanceNote: string;
}

const registry: EnhanceModelSpec[] = [
  {
    id: 'realesr-general-x4v3',
    label: 'Real-ESRGAN general x4v3 (photos)',
    description:
      'Real-ESRGAN compact model (SRVGGNet, 1.2 M parameters) for real-world photos and graphics: restores detail and removes blur, noise and JPEG artifacts while upscaling ×4.',
    // Converted from the official PyTorch weights by models/convert-realesrgan.py and
    // published with the hosted UI (GitHub Pages).
    url: 'https://romaniv1912.github.io/AssetForge/models/realesr-general-x4v3.onnx',
    approxBytes: 4_859_132,
    scale: 4,
    tile: 192,
    tilePad: 16,
    maxInputPixels: 1024 * 1024,
    license: 'BSD-3-Clause',
    licenseUrl: 'https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE',
    performanceNote: '≈5 MB download (cached). On the CPU: ≈2 s for a 128×128 input, ≈9 s for 256×256, ≈40 s for 512×512; faster with WebGPU.',
  },
  {
    id: 'realesrgan-x4plus-anime-6b',
    label: 'Real-ESRGAN x4plus anime 6B (graphics)',
    description:
      'Real-ESRGAN RRDBNet with 6 blocks, trained for illustrations: very clean outlines and flat colours for emoji, icons, stickers, UI and cartoon art. Not for photos.',
    url: 'https://romaniv1912.github.io/AssetForge/models/realesrgan-x4plus-anime-6b.onnx',
    approxBytes: 17_893_122,
    scale: 4,
    // Activations of the ×4 upsampling stages are large: smaller tiles keep memory bounded.
    tile: 128,
    tilePad: 16,
    // ≈5× slower than the compact model: 512×512 is already ≈2–5 minutes on the CPU.
    maxInputPixels: 512 * 512,
    license: 'BSD-3-Clause',
    licenseUrl: 'https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE',
    performanceNote:
      '≈18 MB download (cached). About 5× slower than the photo model: on the CPU ≈9 s for a 128×128 input, ≈45 s for 256×256 (twice that with transparency); much faster with WebGPU.',
  },
];

export const ENHANCE_MODELS: readonly EnhanceModelSpec[] = registry;
export const DEFAULT_ENHANCE_MODEL = 'realesr-general-x4v3';

export function getEnhanceModelSpec(id: string): EnhanceModelSpec {
  return registry.find((m) => m.id === id) ?? registry[0]!;
}

/** Adds or replaces a model (e.g. a self-hosted copy) at runtime. */
export function registerEnhanceModel(spec: EnhanceModelSpec): void {
  const index = registry.findIndex((m) => m.id === spec.id);
  if (index >= 0) registry[index] = spec;
  else registry.push(spec);
}
