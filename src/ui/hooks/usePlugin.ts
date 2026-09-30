import { useEffect, useRef, useState } from 'react';
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
        if (message.options) setOptions(message.options);
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
