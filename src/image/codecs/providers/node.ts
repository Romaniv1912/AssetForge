import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { WASM_FILES } from '../wasm-files';
import type { WasmBinaryProvider } from '../wasm-provider';

const require = createRequire(import.meta.url);

/** Reads codec binaries straight from node_modules (tests, benchmark, CLI). */
export const nodeWasmProvider: WasmBinaryProvider = {
  async load(name) {
    const [pkg, file] = WASM_FILES[name];
    const root = dirname(require.resolve(`${pkg}/package.json`));
    return new Uint8Array(await readFile(join(root, file)));
  },
};
