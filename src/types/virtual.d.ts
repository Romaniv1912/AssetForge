declare module 'virtual:assetforge-codec-wasm' {
  import type { WasmBinaryName } from '../image/codecs/wasm-provider';
  /** Base64-encoded codec binaries, embedded at build time. */
  export const CODEC_WASM_BASE64: Record<WasmBinaryName, string>;
}

/** onnxruntime-web version, injected at build time (pins the CDN runtime binary). */
declare const __ORT_VERSION__: string;
declare const __APP_VERSION__: string;
/** Where the hosted UI lives (GitHub Pages); empty when the build disables it. */
declare const __REMOTE_UI_URL__: string;
