import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setWasmBinaryProvider } from '../../src/image/codecs';
import { nodeWasmProvider } from '../../src/image/codecs/providers/node';
import { DEFAULT_OPTIONS } from '../../src/shared/constants';
import type { ProcessingOptions } from '../../src/image/types';

setWasmBinaryProvider(nodeWasmProvider);

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url))));
}

/** Default options with background removal off (no model in CI) and resize off. */
export function options(overrides: {
  enhance?: Partial<ProcessingOptions['enhance']>;
  backgroundRemoval?: Partial<ProcessingOptions['backgroundRemoval']>;
  crop?: Partial<ProcessingOptions['crop']>;
  resize?: Partial<ProcessingOptions['resize']>;
  compression?: Partial<ProcessingOptions['compression']>;
} = {}): ProcessingOptions {
  return {
    enhance: { ...DEFAULT_OPTIONS.enhance, ...overrides.enhance },
    backgroundRemoval: { ...DEFAULT_OPTIONS.backgroundRemoval, enabled: false, ...overrides.backgroundRemoval },
    crop: { ...DEFAULT_OPTIONS.crop, ...overrides.crop },
    resize: { ...DEFAULT_OPTIONS.resize, enabled: false, ...overrides.resize },
    compression: { ...DEFAULT_OPTIONS.compression, allowAvifInAuto: false, ...overrides.compression },
  };
}
