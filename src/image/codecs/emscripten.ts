import { getWasmModule, type WasmBinaryName } from './wasm-provider';

type EmscriptenFactory<T> = (overrides?: Record<string, unknown>) => Promise<T>;

/**
 * Holds one instance of an Emscripten codec module.
 *
 * Emscripten heaps only grow. After a very large image has been encoded the
 * instance may hold hundreds of megabytes, so the slot can be released and a
 * fresh (small) instance is created lazily on next use. The compiled
 * WebAssembly.Module is cached separately, so re-instantiation is cheap.
 */
export class EmscriptenSlot<T> {
  private instance: Promise<T> | undefined;
  private workSinceCreate = 0;

  constructor(
    private readonly wasmName: WasmBinaryName,
    private readonly loadFactory: () => Promise<EmscriptenFactory<T>>,
    /** Release the instance after this many processed pixels (heap growth guard). */
    private readonly recyclePixelBudget = 48_000_000,
  ) {}

  get(): Promise<T> {
    if (!this.instance) {
      const pending = (async () => {
        const [factory, wasmModule] = await Promise.all([
          this.loadFactory(),
          getWasmModule(this.wasmName),
        ]);
        return factory({
          noInitialRun: true,
          instantiateWasm: (
            imports: WebAssembly.Imports,
            callback: (instance: WebAssembly.Instance) => void,
          ) => {
            const instance = new WebAssembly.Instance(wasmModule, imports);
            callback(instance);
            return instance.exports;
          },
        });
      })();
      pending.catch(() => {
        if (this.instance === pending) this.instance = undefined;
      });
      this.instance = pending;
      this.workSinceCreate = 0;
    }
    return this.instance;
  }

  /** Records work done; drops the instance once the heap is likely to be large. */
  recordWork(pixels: number): void {
    this.workSinceCreate += pixels;
    if (this.workSinceCreate >= this.recyclePixelBudget) this.release();
  }

  release(): void {
    this.instance = undefined;
    this.workSinceCreate = 0;
  }
}
