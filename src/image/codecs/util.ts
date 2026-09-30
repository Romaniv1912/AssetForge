import type { RgbaImage } from '../types';

/** Returns a Uint8Array that owns its whole buffer (never a view into WASM memory). */
export function ownedBytes(view: Uint8Array | ArrayBuffer): Uint8Array {
  if (view instanceof ArrayBuffer) return new Uint8Array(view);
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength && !isWasmMemory(view.buffer)) {
    return view;
  }
  return view.slice();
}

function isWasmMemory(buffer: ArrayBufferLike): boolean {
  // WebAssembly memories are always a multiple of 64 KiB; freshly allocated
  // result buffers produced by the glue code are exact-sized copies.
  return buffer.byteLength % 65536 === 0 && buffer.byteLength >= 65536;
}

/** Normalises an ImageData-like object into an RgbaImage that owns its pixels. */
export function toRgbaImage(source: { width: number; height: number; data: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number } }): RgbaImage {
  const expected = source.width * source.height * 4;
  if (source.data.byteLength !== expected) {
    throw new Error(`Decoder returned ${source.data.byteLength} bytes for a ${source.width}×${source.height} image`);
  }
  const owned =
    source.data instanceof Uint8ClampedArray && !isWasmMemory(source.data.buffer)
      ? source.data
      : new Uint8ClampedArray(source.data.buffer.slice(source.data.byteOffset, source.data.byteOffset + expected));
  return { width: source.width, height: source.height, data: owned };
}
