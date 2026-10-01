import { DEFAULT_OPTIONS, PLUGIN_NAME, SETTINGS_STORAGE_KEY, UI_SIZE } from '../shared/constants';
import type { ProcessingOptions } from '../shared/types';
import { applyResults } from './figma/apply';
import { scanSelection } from './figma/selection';
import { listenToUi, postToUi } from './messaging/bridge';

/**
 * Figma main-thread entry point.
 *
 * The sandbox only does document work (selection scanning, reading image
 * bytes, writing fills). All pixel work runs in the UI iframe's workers.
 */

figma.showUI(__html__, { width: UI_SIZE.width, height: UI_SIZE.height, themeColors: true, title: PLUGIN_NAME });

let scanToken = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;

async function publishSelection(): Promise<void> {
  const token = ++scanToken;
  const snapshot = await scanSelection(figma.currentPage.selection);
  if (token !== scanToken) return; // a newer selection superseded this scan
  postToUi({ type: 'SELECTION_CHANGED', selection: snapshot });
}

figma.on('selectionchange', () => {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => void publishSelection(), 120);
});
figma.on('currentpagechange', () => void publishSelection());

async function loadSettings(): Promise<ProcessingOptions | null> {
  try {
    const stored = (await figma.clientStorage.getAsync(SETTINGS_STORAGE_KEY)) as Partial<ProcessingOptions> | undefined;
    if (!stored) return null;
    // Merge so settings saved by older versions gain new fields.
    return {
      backgroundRemoval: { ...DEFAULT_OPTIONS.backgroundRemoval, ...stored.backgroundRemoval },
      crop: { ...DEFAULT_OPTIONS.crop, ...stored.crop },
      resize: { ...DEFAULT_OPTIONS.resize, ...stored.resize },
      compression: {
        ...DEFAULT_OPTIONS.compression,
        ...stored.compression,
        custom: { ...DEFAULT_OPTIONS.compression.custom, ...stored.compression?.custom },
      },
    };
  } catch {
    return null;
  }
}

listenToUi({
  UI_READY: async () => {
    postToUi({ type: 'INIT', options: await loadSettings(), editorType: figma.editorType });
    await publishSelection();
  },
  REQUEST_SELECTION: () => publishSelection(),
  REQUEST_IMAGE_BYTES: async ({ requestId, imageId }) => {
    try {
      const image = figma.getImageByHash(imageId);
      if (!image) throw new Error('Image not found in this file');
      const bytes = await image.getBytesAsync();
      postToUi({ type: 'IMAGE_BYTES', requestId, imageId, bytes });
    } catch (error) {
      postToUi({
        type: 'IMAGE_BYTES_ERROR',
        requestId,
        imageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  APPLY_RESULTS: async ({ requestId, mode, matchAspectRatio, items }) => {
    const outcomes = await applyResults(items, mode, matchAspectRatio);
    postToUi({ type: 'APPLY_DONE', requestId, outcomes });
    const ok = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.length - ok;
    figma.notify(
      failed === 0
        ? `${PLUGIN_NAME}: ${mode === 'replace' ? 'replaced' : 'inserted'} ${ok} image${ok === 1 ? '' : 's'}`
        : `${PLUGIN_NAME}: ${ok} applied, ${failed} failed`,
      { error: failed > 0 && ok === 0 },
    );
    if (mode === 'replace') await publishSelection();
  },
  SELECT_NODES: async ({ nodeIds }) => {
    const nodes: SceneNode[] = [];
    for (const id of nodeIds) {
      const node = await figma.getNodeByIdAsync(id);
      if (node && 'visible' in node) nodes.push(node as SceneNode);
    }
    if (nodes.length) {
      figma.currentPage.selection = nodes;
      figma.viewport.scrollAndZoomIntoView(nodes);
    }
  },
  SAVE_SETTINGS: async ({ options }) => {
    await figma.clientStorage.setAsync(SETTINGS_STORAGE_KEY, options);
  },
  NOTIFY: ({ message, error }) => {
    figma.notify(message, { error: Boolean(error) });
  },
  RESIZE_UI: ({ width, height }) => {
    figma.ui.resize(Math.round(width), Math.round(height));
  },
  CLOSE: () => figma.closePlugin(),
});
