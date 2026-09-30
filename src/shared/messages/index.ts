import type { ProcessingOptions } from '../../image/types';
import type { ApplyItem, ApplyMode, ApplyOutcome, SelectionSnapshot } from '../types';

/**
 * Typed protocol between the Figma main thread (sandbox, `src/plugin`) and the
 * plugin UI iframe (`src/ui`). Image processing itself never runs in the
 * sandbox: it has no WebAssembly-capable workers, no canvas and a single
 * thread shared with Figma's editor.
 */

/** UI → plugin */
export type UiToPluginMessage =
  | { type: 'UI_READY' }
  | { type: 'REQUEST_SELECTION' }
  | { type: 'REQUEST_IMAGE_BYTES'; requestId: string; imageId: string }
  | {
      type: 'APPLY_RESULTS';
      requestId: string;
      mode: ApplyMode;
      /** Resize replaced nodes so the new image keeps its aspect ratio. */
      matchAspectRatio: boolean;
      items: ApplyItem[];
    }
  | { type: 'SELECT_NODES'; nodeIds: string[] }
  | { type: 'SAVE_SETTINGS'; options: ProcessingOptions }
  | { type: 'NOTIFY'; message: string; error?: boolean }
  | { type: 'RESIZE_UI'; width: number; height: number }
  | { type: 'CLOSE' };

/** plugin → UI */
export type PluginToUiMessage =
  | { type: 'INIT'; options: ProcessingOptions | null; editorType: string }
  | { type: 'SELECTION_CHANGED'; selection: SelectionSnapshot }
  | { type: 'IMAGE_BYTES'; requestId: string; imageId: string; bytes: Uint8Array }
  | { type: 'IMAGE_BYTES_ERROR'; requestId: string; imageId: string; error: string }
  | { type: 'APPLY_DONE'; requestId: string; outcomes: ApplyOutcome[] };

export function isPluginToUiMessage(value: unknown): value is PluginToUiMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

export function isUiToPluginMessage(value: unknown): value is UiToPluginMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}
