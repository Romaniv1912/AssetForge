import type { ProcessingOptions } from '../../image/types';

export const PLUGIN_NAME = 'AssetForge';

export const UI_SIZE = { width: 380, height: 680 } as const;
export const UI_SIZE_EXPANDED = { width: 760, height: 680 } as const;

/** Stop scanning a selection after this many nodes (huge frames). */
export const MAX_SCANNED_NODES = 5_000;

// v2: default output format changed to `original` (TinyPNG behaviour).
export const SETTINGS_STORAGE_KEY = 'assetforge.settings.v2';
export const PLUGIN_DATA_KEY = 'assetforge';

export const DEFAULT_OPTIONS: ProcessingOptions = {
  backgroundRemoval: {
    enabled: true,
    model: 'rmbg-1.4',
    skipIfTransparent: true,
    refineEdges: true,
    decontaminateColors: true,
  },
  crop: { enabled: true, padding: 8, alphaThreshold: 0 },
  resize: { enabled: true, maxWidth: 1024, maxHeight: 1024, preserveAspectRatio: true, allowUpscale: false },
  compression: {
    format: 'original',
    preset: 'high',
    allowAvifInAuto: true,
    fullPalette: false,
    custom: { quality: 80, lossless: false },
  },
};

/** Largest image side `figma.createImage` accepts. */
export const FIGMA_MAX_IMAGE_SIDE = 4096;

/** Formats `figma.createImage` accepts. */
export const FIGMA_IMAGE_FORMATS = ['png', 'jpeg', 'gif'] as const;
