import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { codecWasmPlugin } from './build/codec-wasm-plugin';
import { neutralizeAssetUrls } from './build/neutralize-asset-urls';

const ortVersion = JSON.parse(readFileSync(new URL('./node_modules/onnxruntime-web/package.json', import.meta.url), 'utf8')).version as string;
const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

/** Builds the plugin UI (React app + inline workers) into a single dist/ui.html. */
export default defineConfig({
  root: fileURLToPath(new URL('./src/ui', import.meta.url)),
  plugins: [neutralizeAssetUrls(), react(), codecWasmPlugin(), viteSingleFile({ removeViteModuleLoader: true })],
  define: {
    __ORT_VERSION__: JSON.stringify(ortVersion),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  worker: {
    // Classic workers: module workers from blob: URLs are rejected in the
    // opaque-origin iframe Figma uses for plugin UIs.
    format: 'iife',
    plugins: () => [neutralizeAssetUrls()],
    // Inline workers are a single blob: every dynamic import must be bundled in.
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: false,
    target: 'es2022',
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    chunkSizeWarningLimit: 20_000,
    reportCompressedSize: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/ui/index.html', import.meta.url)),
    },
  },
});
