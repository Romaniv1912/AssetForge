import type { WasmBinaryName, WasmBinaryProvider } from '../wasm-provider';

/** Decodes codec binaries embedded as base64 strings (Figma UI bundle). */
export function base64WasmProvider(table: Record<WasmBinaryName, string>): WasmBinaryProvider {
  return {
    async load(name) {
      const encoded = table[name];
      if (!encoded) throw new Error(`Codec binary "${name}" is not bundled`);
      return base64ToBytes(encoded);
    },
  };
}

export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
