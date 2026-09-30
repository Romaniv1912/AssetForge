import { zipSync } from 'fflate';
import type { EncodableFormat } from '../../image/types';
import { defaultNamer, uniqueNames, type AssetNamer } from '../lib/naming';

/** A processed asset ready to leave the plugin. */
export interface OutputAsset {
  id: string;
  baseName: string;
  data: Uint8Array;
  format: EncodableFormat;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Destination for processed assets. Download and ZIP are implemented; S3,
 * Garage, CDN or asset-registry uploads implement the same interface and can
 * report progress through `onProgress`.
 */
export interface OutputSink {
  readonly id: string;
  readonly label: string;
  deliver(assets: OutputAsset[], onProgress?: (done: number, total: number) => void): Promise<void>;
}

export function triggerDownload(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser time to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export class DownloadSink implements OutputSink {
  readonly id = 'download';
  readonly label = 'Download';
  constructor(private readonly namer: AssetNamer = defaultNamer) {}

  async deliver(assets: OutputAsset[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const names = uniqueNames(assets.map((a) => this.namer.name(a)));
    assets.forEach((asset, i) => {
      triggerDownload(names[i]!, new Blob([asset.data as BlobPart], { type: asset.mimeType }));
      onProgress?.(i + 1, assets.length);
    });
  }
}

export class ZipDownloadSink implements OutputSink {
  readonly id = 'zip';
  readonly label = 'Download ZIP';
  constructor(
    private readonly archiveName = 'assetforge-export.zip',
    private readonly namer: AssetNamer = defaultNamer,
  ) {}

  async deliver(assets: OutputAsset[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const names = uniqueNames(assets.map((a) => this.namer.name(a)));
    const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
    // Images are already compressed: store them without DEFLATE.
    assets.forEach((asset, i) => {
      entries[names[i]!] = [asset.data, { level: 0 }];
    });
    const zipped = zipSync(entries);
    triggerDownload(this.archiveName, new Blob([zipped as BlobPart], { type: 'application/zip' }));
    onProgress?.(assets.length, assets.length);
  }
}
