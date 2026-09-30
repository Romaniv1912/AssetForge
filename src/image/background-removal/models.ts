/**
 * Segmentation model registry.
 *
 * Models are ONNX files fetched lazily on first use (never bundled: they are
 * tens of megabytes) and cached. Every host listed in `url` must also be listed
 * in manifest.json → networkAccess.allowedDomains.
 *
 * To add or self-host a model, add an entry here; nothing else needs changing.
 */
export type ModelInputSpec =
  | { kind: 'fixed'; width: number; height: number }
  /** Shortest edge scaled to `size`, both sides rounded to a multiple of `multiple`. */
  | { kind: 'shortest-edge'; size: number; multiple: number; maxEdge: number };

export interface SegmentationModelSpec {
  id: string;
  label: string;
  description: string;
  url: string;
  /** Approximate download size, for progress display before Content-Length is known. */
  approxBytes: number;
  license: string;
  licenseUrl: string;
  commercialUse: 'allowed' | 'requires-agreement';
  input: ModelInputSpec;
  /** Per-channel normalisation applied to [0,1] RGB: (x - mean) / std. */
  mean: [number, number, number];
  std: [number, number, number];
  /** Rescale the raw output to [0,1] by its min/max (models trained with un-normalised logits). */
  outputNormalization: 'none' | 'minmax';
}

const registry: SegmentationModelSpec[] = [
  {
    id: 'rmbg-1.4',
    label: 'RMBG-1.4 (general)',
    description: 'BRIA RMBG-1.4 (IS-Net architecture). Best general-purpose quality: products, people, animals, objects.',
    url: 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx',
    approxBytes: 44_403_226,
    license: 'bria-rmbg-1.4 (free for non-commercial use)',
    licenseUrl: 'https://huggingface.co/briaai/RMBG-1.4',
    commercialUse: 'requires-agreement',
    input: { kind: 'fixed', width: 1024, height: 1024 },
    mean: [0.5, 0.5, 0.5],
    std: [1, 1, 1],
    outputNormalization: 'minmax',
  },
  {
    id: 'modnet',
    label: 'MODNet (portraits)',
    description: 'MODNet portrait matting. Small and fast, Apache-2.0; designed for people/avatars only.',
    url: 'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model_quantized.onnx',
    approxBytes: 6_628_732,
    license: 'Apache-2.0',
    licenseUrl: 'https://github.com/ZHKKKe/MODNet/blob/master/LICENSE',
    commercialUse: 'allowed',
    input: { kind: 'shortest-edge', size: 512, multiple: 32, maxEdge: 1024 },
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
    outputNormalization: 'none',
  },
];

/** Live view of the registry (includes models added with `registerSegmentationModel`). */
export const SEGMENTATION_MODELS: readonly SegmentationModelSpec[] = registry;

export const DEFAULT_SEGMENTATION_MODEL = 'rmbg-1.4';

/**
 * Adds (or replaces) a model at runtime, e.g. a self-hosted copy or a custom
 * fine-tuned model. Its host must be allowed in manifest.json when used in Figma.
 */
export function registerSegmentationModel(spec: SegmentationModelSpec): void {
  const index = registry.findIndex((m) => m.id === spec.id);
  if (index >= 0) registry[index] = spec;
  else registry.push(spec);
}

export function getModelSpec(id: string): SegmentationModelSpec {
  const spec = registry.find((m) => m.id === id);
  if (!spec) throw new Error(`Unknown background removal model "${id}"`);
  return spec;
}

/** Model input size for an image of the given dimensions. */
export function modelInputSize(spec: SegmentationModelSpec, width: number, height: number): { width: number; height: number } {
  if (spec.input.kind === 'fixed') return { width: spec.input.width, height: spec.input.height };
  const { size, multiple, maxEdge } = spec.input;
  let scale = size / Math.min(width, height);
  scale = Math.min(scale, maxEdge / Math.max(width, height));
  const round = (v: number) => Math.max(multiple, Math.round(v / multiple) * multiple);
  return { width: round(width * scale), height: round(height * scale) };
}
