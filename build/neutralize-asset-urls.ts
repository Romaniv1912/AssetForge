import type { Plugin } from 'vite';

const ASSET_PATTERN = /new (\w+)\((["'])([\w.-]+\.(?:wasm|mjs|js))\2,\s*import\.meta\.url\)/g;
const PACKAGES = /[\\/]node_modules[\\/](@jsquash|onnxruntime-web)[\\/]/;

/**
 * Prepares codec glue (jSquash/Emscripten/wasm-bindgen) and ONNX Runtime for
 * AssetForge's single-file, classic-worker build:
 *
 * 1. `new URL('x.wasm', import.meta.url)` default locations are rewritten to
 *    an inert base URL. Vite would otherwise inline every referenced binary
 *    (tens of MB). AssetForge always passes these libraries their binaries
 *    explicitly, so the defaults are never fetched.
 * 2. Remaining `import.meta.url` reads are replaced by the worker's own
 *    location. Workers are emitted as classic scripts because Chromium refuses
 *    module workers created from blob: URLs in opaque-origin frames — which is
 *    exactly how Figma hosts plugin UIs.
 */
export function neutralizeAssetUrls(): Plugin {
  return {
    name: 'assetforge-neutralize-asset-urls',
    enforce: 'pre',
    transform(code, id) {
      if (!PACKAGES.test(id) || !code.includes('import.meta.url')) return undefined;
      let out = code.replace(
        ASSET_PATTERN,
        (_m, ctor: string, quote: string, file: string) => `new ${ctor}(${quote}${file}${quote}, "https://assetforge.invalid/")`,
      );
      if (out.includes('import.meta.url')) {
        out =
          'var __afMetaUrl = typeof self !== "undefined" && self.location ? String(self.location.href) : "https://assetforge.invalid/";\n' +
          out.replace(/import\.meta\.url/g, '__afMetaUrl');
      }
      return { code: out, map: null };
    },
  };
}
