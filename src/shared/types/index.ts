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
 * One unique image in the selection. The same image (hash) may be used by
 * several fills; it is processed once and applied to every target.
 */
export interface SelectedImage {
  /** Figma image hash — also the processing id. */
  id: string;
  name: string;
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
  /** Hash of the original image; every target fill must still reference it. */
  imageId: string;
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
