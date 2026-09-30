import { isUiToPluginMessage, type PluginToUiMessage, type UiToPluginMessage } from '../../shared/messages';

export function postToUi(message: PluginToUiMessage): void {
  // origin '*': the UI may have navigated to the hosted (GitHub Pages) copy.
  figma.ui.postMessage(message, { origin: '*' });
}

type Handlers = {
  [K in UiToPluginMessage['type']]: (message: Extract<UiToPluginMessage, { type: K }>) => void | Promise<void>;
};

/** Routes typed UI messages to handlers; unknown messages are rejected loudly. */
export function listenToUi(handlers: Handlers): void {
  figma.ui.onmessage = (raw: unknown) => {
    if (!isUiToPluginMessage(raw) || !(raw.type in handlers)) {
      console.error('[AssetForge] Ignoring malformed UI message', raw);
      return;
    }
    const handler = handlers[raw.type] as (m: UiToPluginMessage) => void | Promise<void>;
    Promise.resolve(handler(raw)).catch((error: unknown) => {
      console.error('[AssetForge] Handler failed', raw.type, error);
      figma.notify(`AssetForge: ${error instanceof Error ? error.message : String(error)}`, { error: true });
    });
  };
}
