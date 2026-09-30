import type { NormalizedRect } from '../../image/types';

export type {
  RgbaImage,
  ImageFormat,
  EncodableFormat,
  OutputFormat,
  CompressionPreset,
  ProcessingStage,
  ProcessingOptions,
  BackgroundRemovalOptions,
  CropOptions,
  ResizeOptions,
  CompressionOptions,
  CustomCompressionSettings,
  QualityMetrics,
  CandidateResult,
  ImageAnalysis,
  ProcessedImage,
  StageProgress,
  NormalizedRect,
} from '../../image/types';

/** A node/fill pair that displays a given image. */
export interface ImageTarget {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  /** Index into `node.fills`. */
  fillIndex: number;
  /** Rendered node size (for thumbnails/aspect decisions). */
  nodeWidth: number;
  nodeHeight: number;
}

/**
 * One unique image in the selection. The same image (hash) with the same
 * visible region may be used by several fills; it is processed once and
 * applied to every target.
 */
export interface SelectedImage {
  /** Processing id: the hash, plus the crop region for cropped fills. */
  id: string;
  /** Figma image hash of the original file. */
  hash: string;
  /** Visible region of a fill in crop mode; only this part is processed. */
  crop: NormalizedRect | null;
  name: string;
  /** Pixel size of the processed region (the crop, or the whole image). */
  width: number | null;
  height: number | null;
  targets: ImageTarget[];
}

export interface UnsupportedNode {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  reason: string;
}

export interface SelectionSnapshot {
  images: SelectedImage[];
  unsupported: UnsupportedNode[];
  /** True when the scan stopped at MAX_SCANNED_NODES. */
  truncated: boolean;
  scannedNodes: number;
}

export type ApplyMode = 'replace' | 'insert';

export interface ApplyItem {
  /** Processing id (see SelectedImage.id), echoed back in the outcome. */
  imageId: string;
  /** Hash of the original image; every target fill must still reference it. */
  imageHash: string;
  /** The fills were cropped: reset them to Fill so the new image shows whole. */
  cropped: boolean;
  name: string;
  /** Must be PNG, JPEG or GIF (figma.createImage constraint). */
  bytes: Uint8Array;
  width: number;
  height: number;
  sourceWidth: number | null;
  sourceHeight: number | null;
  /** Fills captured when the image was processed. */
  targets: ImageTarget[];
  /** Name suffix/format info for inserted layers. */
  label: string;
}

export interface ApplyOutcome {
  imageId: string;
  ok: boolean;
  updatedNodes: number;
  error?: string;
  warnings: string[];
}
