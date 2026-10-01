import { useEffect, useRef, useState } from 'react';
import { SEGMENTATION_MODELS } from '../../image/background-removal/models';
import { DEFAULT_OPTIONS } from '../../shared/constants';
import type { ProcessingOptions, SelectionSnapshot } from '../../shared/types';
import { onPluginMessage, postToPlugin } from '../lib/bridge';

const EMPTY_SELECTION: SelectionSnapshot = { images: [], unsupported: [], truncated: false, scannedNodes: 0 };

/** Selection + persisted settings, kept in sync with the Figma main thread. */
export function usePlugin() {
  const [selection, setSelection] = useState<SelectionSnapshot>(EMPTY_SELECTION);
  const [options, setOptions] = useState<ProcessingOptions>(DEFAULT_OPTIONS);
  const [ready, setReady] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    const unsubscribe = onPluginMessage((message) => {
      if (message.type === 'INIT') {
        if (message.options) {
          // The hosted UI can be newer than the installed main thread: fill in
          // sections that older settings (or an older plugin) do not have.
          const raw = message.options as Partial<ProcessingOptions>;
          const stored: ProcessingOptions = {
            enhance: { ...DEFAULT_OPTIONS.enhance, ...raw.enhance },
            backgroundRemoval: { ...DEFAULT_OPTIONS.backgroundRemoval, ...raw.backgroundRemoval },
            crop: { ...DEFAULT_OPTIONS.crop, ...raw.crop },
            resize: { ...DEFAULT_OPTIONS.resize, ...raw.resize },
            compression: {
              ...DEFAULT_OPTIONS.compression,
              ...raw.compression,
              custom: { ...DEFAULT_OPTIONS.compression.custom, ...raw.compression?.custom },
            },
          };
          // Settings saved by older versions may reference a model that was removed.
          const modelExists = SEGMENTATION_MODELS.some((m) => m.id === stored.backgroundRemoval.model);
          if (!modelExists) stored.backgroundRemoval.model = DEFAULT_OPTIONS.backgroundRemoval.model;
          setOptions(stored);
        }
        loaded.current = true;
        setReady(true);
      } else if (message.type === 'SELECTION_CHANGED') {
        setSelection(message.selection);
      }
    });
    postToPlugin({ type: 'UI_READY' });
    return unsubscribe;
  }, []);

  // Persist settings (debounced) once the stored ones have been loaded.
  useEffect(() => {
    if (!loaded.current) return;
    const timer = setTimeout(() => postToPlugin({ type: 'SAVE_SETTINGS', options }), 400);
    return () => clearTimeout(timer);
  }, [options]);

  return { selection, options, setOptions, ready };
}
