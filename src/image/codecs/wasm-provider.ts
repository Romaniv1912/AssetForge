/**
 * Environment-agnostic access to the WebAssembly binaries of the codecs.
 *
 * The processing engine never fetches `.wasm` files by URL. Instead, the host
 * environment registers a provider:
 *
 *  - Figma plugin UI / Web Worker: binaries are inlined into the bundle at build
 *    time (the Figma UI is a single HTML document with an opaque origin, so
 *    relative URLs cannot be fetched) — see `providers/inline.ts`.
 *  - Node (tests, benchmark, future CLI): binaries are read from node_modules —
 *    see `providers/node.ts`.
 */

export type WasmBinaryName =
  | 'mozjpeg_enc'
  | 'mozjpeg_dec'
  | 'webp_enc'
  | 'webp_enc_simd'
  | 'webp_dec'
  | 'avif_enc'
  | 'avif_dec'
  | 'png'
  | 'oxipng'
  | 'resize'
  | 'imagequant';

export interface WasmBinaryProvider {
  load(name: WasmBinaryName): Promise<Uint8Array>;
}

let provider: WasmBinaryProvider | undefined;
const compiled = new Map<WasmBinaryName, Promise<WebAssembly.Module>>();

export function setWasmBinaryProvider(next: WasmBinaryProvider): void {
  provider = next;
  compiled.clear();
}

export function hasWasmBinaryProvider(): boolean {
  return provider !== undefined;
}

/**
 * Returns a compiled module. Compilation is cached: instantiating a codec a
 * second time (e.g. after its memory was released) does not recompile.
 */
export function getWasmModule(name: WasmBinaryName): Promise<WebAssembly.Module> {
  let pending = compiled.get(name);
  if (!pending) {
    if (!provider) {
      throw new Error(
        'No WebAssembly binary provider registered. Call setWasmBinaryProvider() before using codecs.',
      );
    }
    const source = provider;
    pending = source.load(name).then((bytes) => WebAssembly.compile(bytes as BufferSource));
    pending.catch(() => compiled.delete(name));
    compiled.set(name, pending);
  }
  return pending;
}
