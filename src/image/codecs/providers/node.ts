import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { WASM_FILES } from '../wasm-files';
import type { WasmBinaryProvider } from '../wasm-provider';

const require = createRequire(import.meta.url);

/** Reads codec binaries straight from node_modules (tests, benchmark, CLI). */
export const nodeWasmProvider: WasmBinaryProvider = {
  async load(name) {
    return new Uint8Array(await readFile(require.resolve(WASM_FILES[name])));
  },
};
