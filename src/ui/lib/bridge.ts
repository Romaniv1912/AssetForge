import { isPluginToUiMessage, type PluginToUiMessage, type UiToPluginMessage } from '../../shared/messages';
import type { ApplyItem, ApplyMode, ApplyOutcome } from '../../shared/types';

/** Typed wrapper around the Figma UI ⇄ main-thread postMessage channel. */
export function postToPlugin(message: UiToPluginMessage, transfer?: Transferable[]): void {
  // `pluginId` is required once the UI runs from its hosted (non-null) origin.
  parent.postMessage({ pluginMessage: message, pluginId: '*' }, '*', transfer);
}

type Listener = (message: PluginToUiMessage) => void;
const listeners = new Set<Listener>();

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return;
  const message = (event.data as { pluginMessage?: unknown } | null)?.pluginMessage;
  if (!isPluginToUiMessage(message)) return;
  for (const listener of listeners) listener(message);
});

export function onPluginMessage(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let requestCounter = 0;
const nextId = () => `req-${Date.now().toString(36)}-${++requestCounter}`;

/** Reads the original bytes of an image from the Figma document. */
export function requestImageBytes(imageId: string, timeoutMs = 60_000): Promise<Uint8Array> {
  const requestId = nextId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out reading the image from Figma'));
    }, timeoutMs);
    const unsubscribe = onPluginMessage((message) => {
      if ((message.type === 'IMAGE_BYTES' || message.type === 'IMAGE_BYTES_ERROR') && message.requestId === requestId) {
        clearTimeout(timer);
        unsubscribe();
        if (message.type === 'IMAGE_BYTES') resolve(message.bytes);
        else reject(new Error(message.error));
      }
    });
    postToPlugin({ type: 'REQUEST_IMAGE_BYTES', requestId, imageId });
  });
}

export function applyToFigma(mode: ApplyMode, matchAspectRatio: boolean, items: ApplyItem[]): Promise<ApplyOutcome[]> {
  const requestId = nextId();
  return new Promise((resolve) => {
    const unsubscribe = onPluginMessage((message) => {
      if (message.type === 'APPLY_DONE' && message.requestId === requestId) {
        unsubscribe();
        resolve(message.outcomes);
      }
    });
    postToPlugin({ type: 'APPLY_RESULTS', requestId, mode, matchAspectRatio, items });
  });
}
