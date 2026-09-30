/**
 * Public API of the AssetForge processing engine (Figma-independent).
 */
export * from './types';
export { processImage, type PipelineContext } from './pipeline/process-image';
export { analyzeImage } from './analysis/analyze';
export { decodeImage, browserFallbackDecoder, type FallbackDecoder } from './decode/decode';
export { sniffFormat, MIME_TYPES, FILE_EXTENSIONS } from './decode/sniff';
export { findContentBounds, cropImage, padImage, type Rect } from './crop/smart-crop';
export { computeTargetSize, resizeImage } from './resize/resize';
export { compress, chooseCandidates, flattenOnto } from './compression/compress';
export { QUALITY_TARGETS, PRESET_LABELS, PRESET_DESCRIPTIONS, meetsTarget } from './compression/presets';
export { wuQuantizer, type Quantizer } from './compression/quantize';
export { compareImages } from './metrics/ssim';
export { validateOutput } from './validation/validate';
export { removeBackground } from './background-removal/remove-background';
export { SEGMENTATION_MODELS, DEFAULT_SEGMENTATION_MODEL, getModelSpec } from './background-removal/models';
export type { SegmentationRunner, SegmentationMask } from './background-removal/runner';
export { setWasmBinaryProvider, releaseCodecMemory, type WasmBinaryProvider } from './codecs';
export { processBatch, type BatchInput, type BatchItemResult } from './pipeline/batch';
