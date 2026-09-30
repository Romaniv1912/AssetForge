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
  /** Model used on the CPU (WASM) backend. */
  url: string;
  /** Approximate download size, for progress display before Content-Length is known. */
  approxBytes: number;
  /**
   * Optional variant for the WebGPU backend (typically fp16: half the download,
   * much faster on GPU, but not supported by the CPU backend).
   */
  webgpu?: { url: string; approxBytes: number };
  /** Short note shown in the UI about speed/size trade-offs. */
  performanceNote?: string;
  license: string;
  licenseUrl: string;
  commercialUse: 'allowed' | 'requires-agreement';
  input: ModelInputSpec;
  /** Per-channel normalisation applied to [0,1] RGB: (x - mean) / std. */
  mean: [number, number, number];
  std: [number, number, number];
  /**
   * How to map the raw output to [0,1]: `sigmoid` for logit outputs,
   * `minmax` to rescale by the output's range, `none` when already a matte.
   */
  outputNormalization: 'none' | 'minmax' | 'sigmoid' | 'auto';
  /**
   * The model only runs with WebGPU. The CPU (WASM) backend is limited to
   * 4 GB of memory, which large 1024² transformers exceed (std::bad_alloc).
   */
  requiresWebGpu?: boolean;
  /** Model used instead when this one cannot run (no WebGPU, out of memory). */
  fallback?: string;
  /** Download needs a Hugging Face token (gated repository). */
  gated?: { acceptUrl: string };
}

const registry: SegmentationModelSpec[] = [
  {
    id: 'rmbg-1.4',
    label: 'RMBG-1.4 (recommended)',
    description: 'BRIA RMBG-1.4 (IS-Net architecture). Good general-purpose quality, small (8-bit) and fast on any machine.',
    url: 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx',
    approxBytes: 44_403_226,
    license: 'bria-rmbg-1.4 (free for non-commercial use)',
    licenseUrl: 'https://huggingface.co/briaai/RMBG-1.4',
    commercialUse: 'requires-agreement',
    input: { kind: 'fixed', width: 1024, height: 1024 },
    mean: [0.5, 0.5, 0.5],
    std: [1, 1, 1],
    outputNormalization: 'minmax',
    performanceNote: '≈44 MB download, a few seconds per image, works without a GPU.',
  },
  {
    id: 'rmbg-1.4-full',
    label: 'RMBG-1.4 full precision (sharper)',
    description: 'The same RMBG-1.4 model without 8-bit quantisation: cleaner edges and fewer mistakes, works without a GPU.',
    url: 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx',
    approxBytes: 176_000_000,
    license: 'bria-rmbg-1.4 (free for non-commercial use)',
    licenseUrl: 'https://huggingface.co/briaai/RMBG-1.4',
    commercialUse: 'requires-agreement',
    input: { kind: 'fixed', width: 1024, height: 1024 },
    mean: [0.5, 0.5, 0.5],
    std: [1, 1, 1],
    outputNormalization: 'minmax',
    performanceNote: '≈176 MB download (cached), about twice as slow as the 8-bit version, works without a GPU.',
    fallback: 'rmbg-1.4',
  },
  {
    id: 'rmbg-2.0',
    label: 'RMBG-2.0 (best quality, WebGPU)',
    description:
      'BRIA RMBG-2.0: BiRefNet architecture trained on BRIA\'s licensed data — the strongest open model for hair, fur and fine edges.',
    url: 'https://huggingface.co/briaai/RMBG-2.0/resolve/main/onnx/model_fp16.onnx',
    approxBytes: 514_000_000,
    performanceNote:
      'Needs WebGPU and ≈514 MB download (cached). Gated on Hugging Face: accept the licence and add a read token below.',
    license: 'CC BY-NC 4.0 (non-commercial)',
    licenseUrl: 'https://huggingface.co/briaai/RMBG-2.0',
    commercialUse: 'requires-agreement',
    input: { kind: 'fixed', width: 1024, height: 1024 },
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    outputNormalization: 'auto',
    requiresWebGpu: true,
    fallback: 'rmbg-1.4',
    gated: { acceptUrl: 'https://huggingface.co/briaai/RMBG-2.0' },
  },
  {
    id: 'birefnet-lite',
    label: 'BiRefNet lite (WebGPU)',
    description:
      'BiRefNet lite (Swin-T, 1024²): very clean edges and fine detail (hair, fur, thin structures). MIT licensed.',
    url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx',
    approxBytes: 115_000_000,
    performanceNote: 'Needs WebGPU, ≈115 MB download (cached).',
    license: 'MIT',
    licenseUrl: 'https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE',
    commercialUse: 'allowed',
    input: { kind: 'fixed', width: 1024, height: 1024 },
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    outputNormalization: 'sigmoid',
    requiresWebGpu: true,
    fallback: 'rmbg-1.4',
  },
  {
    id: 'modnet',
    label: 'MODNet (portraits, fastest)',
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
    performanceNote: '≈7 MB download, the fastest option.',
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
