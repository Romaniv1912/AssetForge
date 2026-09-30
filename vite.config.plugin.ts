import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Builds the Figma main-thread code (sandbox) into dist/code.js.
 * The sandbox is not a browser: no DOM, no modules — a single classic script.
 */
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: false,
    target: 'es2017',
    minify: true,
    reportCompressedSize: false,
    lib: {
      entry: fileURLToPath(new URL('./src/plugin/code.ts', import.meta.url)),
      formats: ['iife'],
      name: 'AssetForge',
      fileName: () => 'code.js',
    },
  },
});
