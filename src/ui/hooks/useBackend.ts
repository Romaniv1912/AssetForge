import { useEffect, useState } from 'react';
import { createProcessingBackend, type ProcessingBackend } from '../processing/backend';

export function useBackend(): { backend: ProcessingBackend | null; error: string | null } {
  const [backend, setBackend] = useState<ProcessingBackend | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let created: ProcessingBackend | null = null;
    createProcessingBackend()
      .then((b) => {
        created = b;
        if (disposed) b.dispose();
        else setBackend(b);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      disposed = true;
      created?.dispose();
    };
  }, []);
  return { backend, error };
}
