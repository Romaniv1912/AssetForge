import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { WASM_FILES } from '../src/image/codecs/wasm-files';

const VIRTUAL_ID = 'virtual:assetforge-codec-wasm';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const require = createRequire(import.meta.url);

/**
 * Embeds the codec WebAssembly binaries as base64 into the UI bundle.
 *
 * The Figma plugin UI is a single HTML document loaded with an opaque origin:
 * it cannot fetch sibling files, so every binary the plugin needs offline
 * must be inside `ui.html`.
 */
export function codecWasmPlugin(): Plugin {
  return {
    name: 'assetforge-codec-wasm',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined;
      const entries = await Promise.all(
        Object.entries(WASM_FILES).map(async ([name, [pkg, file]]) => {
          const root = dirname(require.resolve(`${pkg}/package.json`));
          const path = join(root, file);
          this.addWatchFile(path);
          const bytes = await readFile(path);
          return `  ${JSON.stringify(name)}: ${JSON.stringify(bytes.toString('base64'))}`;
        }),
      );
      return `export const CODEC_WASM_BASE64 = {\n${entries.join(',\n')}\n};\n`;
    },
  };
}
