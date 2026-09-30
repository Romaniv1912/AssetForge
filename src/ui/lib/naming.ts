import { FILE_EXTENSIONS } from '../../image/decode/sniff';
import type { EncodableFormat } from '../../image/types';

/**
 * Produces file names for exported assets. Kept behind an interface so custom
 * naming schemes (content hashes, versioning, project presets) can be plugged
 * in without touching export code.
 */
export interface AssetNamer {
  name(input: { baseName: string; format: EncodableFormat; width: number; height: number }): string;
}

export const defaultNamer: AssetNamer = {
  name({ baseName, format }) {
    return `${sanitize(baseName)}.${FILE_EXTENSIONS[format]}`;
  },
};

export function sanitize(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._ -]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase();
  return cleaned.slice(0, 80) || 'image';
}

/** Makes names unique within one export ("logo.png", "logo-2.png", …). */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count === 1) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)}-${count}${name.slice(dot)}` : `${name}-${count}`;
  });
}
