import { getWasmModule, type WasmBinaryName } from './wasm-provider';

type BindgenInit = (input: { module_or_path: WebAssembly.Module } | WebAssembly.Module) => Promise<unknown>;

/**
 * wasm-bindgen generated glue keeps a module-level singleton, so these codecs
 * (png, oxipng, resize) are initialised exactly once per realm.
 */
export function initBindgenOnce(
  name: WasmBinaryName,
  loadInit: () => Promise<BindgenInit>,
): () => Promise<void> {
  let ready: Promise<void> | undefined;
  return () => {
    if (!ready) {
      ready = (async () => {
        const [init, wasmModule] = await Promise.all([loadInit(), getWasmModule(name)]);
        await init(wasmModule);
      })();
      ready.catch(() => {
        ready = undefined;
      });
    }
    return ready;
  };
}
