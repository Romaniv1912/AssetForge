import { zipSync } from 'fflate';
import { FILE_EXTENSIONS, MIME_TYPES, sniffFormat } from '../../image/decode/sniff';
import type { SelectedImage } from '../../shared/types';
import { requestImageBytes } from '../lib/bridge';
import { sanitize, uniqueNames } from '../lib/naming';
import { triggerDownload } from './sinks';

/**
 * Downloads the image files exactly as Figma stores them: the bytes that were
 * uploaded, at full size, without crop, compression or re-encoding. An image
 * used by several layers (or with several crops) is downloaded once.
 */
export async function downloadOriginals(
  images: SelectedImage[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ downloaded: number; failed: string[] }> {
  const byHash = new Map<string, SelectedImage>();
  for (const image of images) if (!byHash.has(image.hash)) byHash.set(image.hash, image);
  const unique = [...byHash.values()];

  const files: { name: string; bytes: Uint8Array; mime: string }[] = [];
  const failed: string[] = [];
  for (const [index, image] of unique.entries()) {
    try {
      const bytes = await requestImageBytes(image.hash);
      const format = sniffFormat(bytes);
      files.push({ name: `${sanitize(image.name)}.${FILE_EXTENSIONS[format]}`, bytes, mime: MIME_TYPES[format] });
    } catch (error) {
      // One unreadable image must not cancel the others.
      failed.push(`${image.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    onProgress?.(index + 1, unique.length);
  }

  const names = uniqueNames(files.map((f) => f.name));
  if (files.length === 1) {
    triggerDownload(names[0]!, new Blob([files[0]!.bytes as BlobPart], { type: files[0]!.mime }));
  } else if (files.length > 1) {
    const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
    // Stored, not deflated: the files are already compressed and must stay byte-identical.
    files.forEach((file, i) => {
      entries[names[i]!] = [file.bytes, { level: 0 }];
    });
    triggerDownload('assetforge-originals.zip', new Blob([zipSync(entries) as BlobPart], { type: 'application/zip' }));
  }
  return { downloaded: files.length, failed };
}
