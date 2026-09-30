# AssetForge

AssetForge is a Figma plugin that turns selected images into production-ready
assets: **background removal → smart crop → resize → perceptual compression →
validation → preview → replace in Figma / export**. It processes one image or a
whole batch, runs entirely on the user's machine, and aims for TinyPNG/TinyJPG
class size reductions without visible quality loss.

```text
Select images in Figma ─▶ Analyze ─▶ Remove background ─▶ Crop transparent bounds
   ─▶ Resize ─▶ Optimize (measured, perceptual) ─▶ Validate ─▶ Preview ─▶ Replace / Export
```

- [Quick start](#quick-start)
- [Phase 1 — Figma runtime investigation and architecture decision](#phase-1--figma-runtime-investigation-and-architecture-decision)
- [Architecture](#architecture)
- [Processing engine API](#processing-engine-api)
- [Background removal](#background-removal)
- [Compression](#compression)
- [Benchmark and preset tuning](#benchmark-and-preset-tuning)
- [TinyPNG comparison](#tinypng-comparison)
- [Testing](#testing)
- [Memory and performance](#memory-and-performance)
- [Limitations](#limitations)
- [Extending AssetForge](#extending-assetforge)
- [Licences](#licences)

## Quick start

Requirements: Node.js ≥ 20, [pnpm](https://pnpm.io) ≥ 10 (`corepack enable` picks the pinned version) and the Figma desktop app.

```bash
pnpm install
pnpm run build          # typecheck + dist/index.html (UI) + dist/code.js (sandbox)
```

In Figma: **Plugins → Development → Import plugin from manifest…** and pick
`manifest.json`. Select layers with image fills (or frames/groups that contain
them) and run **AssetForge**.

> `manifest.json` contains a placeholder `id`. Figma assigns the real id when you
> create the plugin in your account — replace it before publishing.

| Script | Purpose |
| --- | --- |
| `pnpm run build` | Typecheck all three TS projects, build UI and sandbox bundles |
| `pnpm run dev` | Rebuild UI and sandbox on change |
| `pnpm test` | Unit + integration tests (Vitest, real WASM codecs, real ONNX Runtime) |
| `pnpm run test:e2e` | Drives the **built** plugin UI in Chromium inside a Figma-like sandboxed iframe (run `pnpm run build` first) |
| `pnpm run benchmark` | Compression benchmark (`--presets=all`, `--formats=png,webp`, `--images=logo,…`) |
| `pnpm run benchmark:compare` | AssetForge vs TinyPNG comparison (needs `TINIFY_API_KEY` or cached TinyPNG files) |

## Phase 1 — Figma runtime investigation and architecture decision

A Figma plugin has two execution contexts. Every decision below follows from
their constraints — several of them verified empirically in Chromium with the
e2e harness (`e2e/`), which hosts the UI exactly like Figma does (an iframe with
an opaque `null` origin).

| Question | Main thread (`code.js`) | UI iframe (`index.html`) |
| --- | --- | --- |
| What is it? | Figma's JS sandbox, shares the thread with the editor | A browser document (Chromium in the desktop app) with an **opaque origin** |
| Figma document API | ✅ | ❌ (only via `postMessage` to the main thread) |
| DOM / canvas / `OffscreenCanvas` | ❌ | ✅ |
| WebAssembly (incl. SIMD) | not relied upon; any heavy work here freezes Figma | ✅ |
| Web Workers | ❌ | ✅ **classic** workers from `blob:` URLs. **Module** workers from `blob:` URLs are rejected in opaque-origin frames (measured) → workers are built as IIFE scripts |
| WASM threads / `SharedArrayBuffer` | ❌ | ❌ — the iframe is not cross-origin isolated (COOP/COEP cannot be set), so all codecs and ONNX Runtime run single-threaded per worker; parallelism comes from multiple workers |
| WebGPU / WebGL | ❌ | WebGL ✅; WebGPU is feature-detected (`navigator.gpu.requestAdapter()`), with automatic CPU fallback |
| Relative file fetches | — | ❌ (opaque origin) → the UI must be **one HTML file**; codec binaries are embedded |
| Network | — | Only hosts listed in `manifest.json → networkAccess.allowedDomains` |
| Persistent storage | `figma.clientStorage` (small; used for settings) | IndexedDB/Cache Storage are unreliable in opaque origins → model/runtime downloads rely on the browser HTTP cache (Cache Storage is used when available) |
| Native Node modules (Sharp, libvips) | ❌ not Node | ❌ a browser |
| Image API | `figma.createImage` accepts **PNG, JPEG, GIF** only; `image.getBytesAsync()` returns the original file bytes | — |

### Options considered

| Option | Verdict |
| --- | --- |
| **A. Everything inside the plugin (WASM codecs in workers)** | ✅ **Chosen.** The best-in-class encoders exist as WebAssembly builds of the very same C/Rust libraries that native tools wrap (MozJPEG, libwebp, libavif/aom, oxipng, Squoosh's resize). No install, no server, images never leave the machine. |
| B. Local companion process (Node + Sharp/libvips) | Technically possible (`networkAccess` can allow `http://localhost:<port>`), but every user would have to install and keep a daemon running; failure modes (port in use, not started, updates) make it fragile. Sharp's AVIF/WebP/JPEG encoders are the same libraries used here, so it would mainly buy speed (native threads), not smaller files. |
| C. External image service | Uploads user images to a server (privacy), needs hosting and auth, and does not beat the same codecs run locally. |

**Sharp cannot run in a Figma plugin**: it is a native Node addon around
libvips; neither plugin context is Node. It is therefore not used. The engine is
Figma-independent (see below), so B or C can be added later as a
`ProcessingBackend` without touching the pipeline.

### Library evaluation

| Library | Runs in the plugin? | Used? |
| --- | --- | --- |
| Sharp / libvips | ❌ native Node addon | No (see above) |
| MozJPEG | ✅ WASM (`@jsquash/jpeg`, Squoosh build) | ✅ JPEG encoder/decoder |
| libjpeg-turbo | ✅ (MozJPEG is built on it) | via MozJPEG |
| libwebp | ✅ WASM + SIMD (`@jsquash/webp`) | ✅ lossy/lossless WebP |
| libavif (+ aom) | ✅ WASM, single-threaded build (`@jsquash/avif`) | ✅ AVIF |
| oxipng | ✅ WASM (`@jsquash/oxipng`) | ✅ PNG optimisation (filters, DEFLATE, colour-type/bit-depth reduction, alpha cleanup) |
| zopflipng | no maintained WASM build | No — oxipng's libdeflate levels get most of the gain at a fraction of the time |
| pngquant / libimagequant | WASM ports exist, but libimagequant is **GPL-3.0** | Not bundled (licence). The `Quantizer` interface allows swapping it in |
| image-q (MIT) | ✅ pure TS | ✅ Wu colour quantiser (palette seed) |
| Squoosh resize | ✅ WASM (`@jsquash/resize`) | ✅ Lanczos3 / Catmull-Rom, premultiplied, linear-light |
| ONNX Runtime Web | ✅ WASM (+ WebGPU EP) | ✅ background-removal inference |

## Architecture

```text
┌──────────── Figma main thread (src/plugin) ────────────┐
│ selection scan · image bytes · replace/insert fills    │
│ settings (clientStorage)                               │
└───────────────▲─────────────────────────┬──────────────┘
                │ typed messages          │ (src/shared/messages)
┌───────────────┴─────────────────────────▼──────────────┐
│ UI thread (src/ui, React)                              │
│ settings · batch queue (bounded concurrency) · preview │
│ owns the embedded codec binaries                       │
└──────┬───────────────────────────────┬─────────────────┘
       │ ProcessingRequest/Response    │
┌──────▼──────────────┐  ×N (2–3)      │
│ processing worker   │────────────────┘
│ decode · crop ·     │  MessagePort   ┌────────────────────────┐
│ resize · codecs ·   │───────────────▶│ ML worker ×1           │
│ perceptual search · │  segmentation  │ ONNX Runtime session   │
│ validation          │◀───────────────│ (one model in memory)  │
└─────────────────────┘                └────────────────────────┘
```

- **Figma runtime** (`src/plugin`) only touches the document. It scans the
  selection (image fills on any node type, recursively inside frames, groups,
  components and instances, deduplicated by image hash), reports every
  unsupported node with a reason (no image fill, mixed text fills, video fills,
  image still loading…), reads image bytes on demand and writes results.
- **UI** (`src/ui`) is a React app. Batches are processed with bounded
  concurrency: an image's bytes are only requested from Figma when a worker is
  free, so memory does not grow with batch size. Failed items keep their reason
  and can be retried; the rest of the batch continues.
- **Workers** (`src/ui/workers`) run the Figma-independent engine. If a host ever
  blocks workers, the same code runs on the UI thread (`InlineBackend`).
- **Engine** (`src/image`) knows nothing about Figma or the DOM: it works on
  `Uint8Array` files and RGBA buffers, and runs identically in workers, Node
  (tests, benchmark) or a future CLI/service.

All messages are discriminated unions (`src/shared/messages/index.ts` for
Figma ⇄ UI, `src/shared/messages/worker.ts` for UI ⇄ workers).

```text
src/
├── plugin/            Figma sandbox: code.ts, figma/{selection,apply}.ts, messaging/
├── ui/                React app: App.tsx, components/, hooks/, processing/, workers/, outputs/, styles/
├── image/             Processing engine (Figma-independent)
│   ├── pipeline/          processImage(), processBatch()
│   ├── background-removal/ model registry, ONNX runner, guided-filter refinement, colour decontamination
│   ├── crop/              alpha bounding box, padding
│   ├── resize/            target size maths, resampling
│   ├── compression/       presets, candidates, perceptual search, palette quantiser
│   ├── codecs/            WASM codec wrappers + binary providers (inline/Node)
│   ├── metrics/           SSIM / worst-block SSIM / PSNR
│   ├── decode/            format sniffing, EXIF orientation, metadata stripping
│   ├── analysis/          content classification
│   └── validation/        decode-and-verify of every output
├── shared/            types, message protocols, constants
build/                 Vite plugins (codec embedding, import.meta.url handling)
tests/                 Vitest suites     e2e/  Chromium smoke test     benchmark/  benchmark + TinyPNG comparison
fixtures/              sample images (see fixtures/README.md) and a tiny ONNX test model
```

## Processing engine API

```ts
import { processImage, setWasmBinaryProvider } from './src/image';
import { nodeWasmProvider } from './src/image/codecs/providers/node';

setWasmBinaryProvider(nodeWasmProvider); // browser builds embed the binaries instead

const result = await processImage(bytes, {
  backgroundRemoval: { enabled: true, model: 'rmbg-1.4', skipIfTransparent: true, refineEdges: true, decontaminateColors: true },
  crop: { enabled: true, padding: 8, alphaThreshold: 0 },
  resize: { enabled: true, maxWidth: 1024, maxHeight: 1024, preserveAspectRatio: true, allowUpscale: false },
  compression: { format: 'auto', preset: 'high', allowAvifInAuto: true, custom: { quality: 80, lossless: false } },
}, { segmentation: runner /* SegmentationRunner, needed when backgroundRemoval.enabled */ });

result.data;             // Uint8Array — the optimised file
result.format;           // 'png' | 'jpeg' | 'webp' | 'avif'
result.width; result.height;
result.originalBytes; result.outputBytes;
result.compressionRatio; // originalBytes / outputBytes
result.metrics;          // { ssim, worstBlockSsim, psnr, maxAlphaError } of the decoded output
result.candidates;       // every encoder that was measured
result.warnings;         // e.g. "JPEG does not support transparency: flattened onto white"
```

`processBatch(inputs, options, ctx, { concurrency })` adds lazy loading,
bounded concurrency, per-item failure isolation and cancellation.

## Background removal

Background removal is **real, local ML inference** with ONNX Runtime Web in a
dedicated worker. Nothing is uploaded.

| Model | Best for | Download | Licence |
| --- | --- | --- | --- |
| `rmbg-1.4` (default) — BRIA RMBG-1.4, IS-Net architecture, 8-bit quantised | products, people, animals, general objects | ≈ 44 MB | **bria-rmbg-1.4: free for non-commercial use; commercial use requires an agreement with BRIA** |
| `modnet` — MODNet, quantised | portraits / avatars only | ≈ 7 MB | Apache-2.0 |

> ⚠️ Check the model licence against your use. For commercial distribution
> either license RMBG-1.4 from BRIA, use `modnet` (portraits), or register your
> own model (below).

How it works:

1. **Lazy, cached loading.** On first use the worker downloads the ONNX Runtime
   WebAssembly binary from jsDelivr (pinned to the installed
   `onnxruntime-web` version; 14 MB CPU build, or 28 MB when WebGPU is available)
   and the model from Hugging Face, with byte-level progress in the UI. One
   session serves the entire batch; the model is never reloaded per image.
   Downloads are served from the HTTP cache afterwards (and from Cache Storage
   where the browser allows it).
2. **Inference** at the model's native resolution (1024² for RMBG, short side
   512 for MODNet), WebGPU when an adapter exists, WASM SIMD otherwise.
3. **Edge refinement** — a colour *Fast Guided Filter* (He & Sun, 2015): the
   linear model is solved at model resolution and applied at full resolution,
   so the matte snaps to real edges (hair, fur, outlines) instead of being a
   blurry upscale. Semi-transparent pixels are kept, never binarised.
4. **Colour decontamination** — blur-fusion foreground estimation (Forte &
   Pitié, 2021): the true foreground colour of soft edge pixels is re-estimated,
   removing the background-coloured halo you otherwise see on a new backdrop.
5. Existing transparency is preserved (multiplied with the matte); images whose
   border is already transparent are skipped (configurable).

To self-host or add a model, call `registerSegmentationModel({...})`
(`src/image/background-removal/models.ts`) and add its host to
`manifest.json → networkAccess.allowedDomains`.

## Compression

Compression never means "call an encoder with quality 80". For each image
AssetForge:

```text
analyse ─▶ pick candidate encoders ─▶ for each: binary-search the lowest setting
           whose decoded output meets the perceptual target ─▶ keep the smallest
           passing file ─▶ decode it again with an independent decoder (validation)
```

**Metric.** SSIM on Y, Cb, Cr (weights 0.8/0.1/0.1, 8×8 windows, stride 4).
Chroma is compared at half resolution (human colour acuity), so invisible 4:2:0
subsampling is not penalised but colour shifts/bleeding are. Images with alpha
are composited over black *and* white and the worse score counts, so alpha
errors and halos cannot hide. Besides the mean, the **1st-percentile local
SSIM** ("worst block") must pass too — a good average cannot hide a blocky or
banded region. For dithered palette images the score blends pixel-exact and
eye-integrated (low-passed) SSIM, the same reasoning that makes pngquant score
palette error rather than dither grain. PSNR is reported for reference.

**Presets** (thresholds tuned with the benchmark, `src/image/compression/presets.ts`):

| Preset | Min SSIM | Min worst-block SSIM | Intent |
| --- | ---: | ---: | --- |
| Maximum | 0.993 | 0.965 | visually lossless |
| High | 0.985 | 0.930 | very high quality, meaningful compression |
| Balanced | 0.975 | 0.890 | good quality, aggressive compression |
| Small | 0.960 | 0.830 | smallest files that remain visually usable |
| Custom | — | — | fixed encoder quality / lossless, no search |

**Encoders and strategies**

- **PNG** — lossy palette path (TinyPNG-style): Wu palette (image-q) refined by
  k-means with farthest-point seeding, remapped with serpentine
  Floyd–Steinberg dithering whose strength fades on edges and noise and is
  never diffused across fully transparent pixels. The palette size is searched
  (256 → 8) against the target. Output goes through **oxipng**, which picks
  filters, recompresses DEFLATE and reduces colour type/bit depth (indexed +
  `tRNS` for palettes, RGB/grey when alpha is unused), clears the colour of
  fully transparent pixels, and writes no metadata. Exact-colour assets
  (≤ 256 colours, pixel art, UI) stay lossless. When nothing passes, lossless
  oxipng is the fallback.
- **JPEG** — MozJPEG, progressive, optimised Huffman, trellis quantisation,
  ImageMagick quant tables. 4:2:0 and 4:4:4 are both measured when chroma detail
  may matter; greyscale images use a single-channel JPEG. EXIF orientation is
  applied on decode. A JPEG source is only re-encoded if that saves ≥ 5 %,
  otherwise the original is kept (metadata stripped, orientation-safe).
- **WebP** — libwebp lossy (method 6 for the final encode, sharp-YUV, lossless
  alpha plane) or lossless for graphics.
- **AVIF** — libavif/aom; 4:2:0 + sharp-YUV for photos, 4:4:4 for graphics,
  4:0:0 for greyscale; alpha plane encoded at higher quality than colour.
- **Auto** — candidates depend on content (photo / illustration / flat graphic /
  exact colour) and alpha; the **smallest file that passes wins**. Candidates
  that provably cannot beat the current best are pruned early. An untouched
  image is never made bigger: if the original is already smaller than every
  candidate it is kept.

**Figma output.** `figma.createImage` only accepts PNG/JPEG/GIF. When a result
is WebP/AVIF, "Replace in Figma" / "Insert copies" decode it and store the exact
same pixels as lossless PNG (if transparent) or JPEG q95 4:4:4 (if opaque).
Downloads keep the chosen format. Replacements keep the paint's other
properties, can resize the layer to the new aspect ratio, and record the
original image hash in plugin data.

## Benchmark and preset tuning

`pnpm run benchmark` runs the production engine (same WASM codecs) over real
photos, an avatar, a transparent avatar cut-out, illustrations, flat graphics,
gradients, a very detailed image, greyscale text and pixel art (see
`benchmark/images.ts`, `fixtures/README.md`) and writes Markdown/JSON reports to
`benchmark/results/`. Reduction is measured against the source file; synthetic
images are measured against a standard lossless PNG.

<!-- BENCHMARK:START -->
Per-image results, **High** preset (reduction vs. the source file; `auto` picks the smallest file that passes the target):

| Image | Kind | Dimensions | Original | Auto → format | SSIM (auto) | PNG | WebP | AVIF | JPEG |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| astronaut | avatar | 512×512 | 773.0 KB | 44.9 KB (−94%) AVIF | 0.9864 | 115.6 KB (−85%) | 49.9 KB (−94%) | 44.9 KB (−94%) | 60.8 KB (−92%) |
| chelsea | photo | 451×300 | 234.9 KB | 20.8 KB (−91%) AVIF | 0.9865 | 67.4 KB (−71%) | 26.9 KB (−89%) | 20.8 KB (−91%) | 37.3 KB (−84%) |
| coffee | photo | 600×400 | 455.8 KB | 56.7 KB (−88%) AVIF | 0.9865 | 136.1 KB (−70%) | 69.5 KB (−85%) | 56.7 KB (−88%) | 98.8 KB (−78%) |
| rocket | photo | 640×427 | 109.9 KB | 34.2 KB (−69%) WEBP | 0.9862 | 104.2 KB (−5%) | 34.2 KB (−69%) | 49.3 KB (−55%) | 47.2 KB (−57%) |
| hubble | detailed | 1000×872 | 515.6 KB | 313.1 KB (−39%) AVIF | 0.9881 | 369.3 KB (−28%) | 380.0 KB (−26%) | 313.1 KB (−39%) | 392.1 KB (−24%) |
| logo | illustration | 500×500 | 175.5 KB | 13.9 KB (−92%) AVIF | 0.9905 | 45.2 KB (−74%) | 18.4 KB (−90%) | 13.9 KB (−92%) | 27.6 KB (−84%) |
| text | text | 448×172 | 41.7 KB | 16.2 KB (−61%) AVIF | 0.9863 | 29.1 KB (−30%) | 16.7 KB (−60%) | 16.2 KB (−61%) | 25.1 KB (−40%) |
| avatar-cutout | avatar | 512×512 | 223.8 KB | 23.4 KB (−90%) AVIF | 0.9927 | 57.7 KB (−74%) | 26.0 KB (−88%) | 23.4 KB (−90%) | n/a (alpha) |
| illustration | transparent-illustration | 640×480 | 10.5 KB | 4.5 KB (−57%) PNG | 0.9996 | 4.5 KB (−57%) | 6.6 KB (−37%) | 5.0 KB (−52%) | n/a (alpha) |
| flat | flat-graphic | 800×520 | 3.5 KB | 2.4 KB (−31%) WEBP | 1.0000 | 3.4 KB (−4%) | 2.4 KB (−31%) | 2.5 KB (−30%) | 8.4 KB (+137%) |
| gradient | gradient | 800×400 | 1.9 KB | 1.3 KB (−32%) AVIF | 0.9962 | 1.7 KB (−8%) | 2.6 KB (+40%) | 1.3 KB (−32%) | 4.0 KB (+112%) |
| pixel-art | pixel-art | 128×128 | 0.4 KB | 0.3 KB (−27%) WEBP | 1.0000 | 0.4 KB (−5%) | 0.3 KB (−27%) | 6.1 KB (+1368%) | n/a (alpha) |

Preset summary over all 12 images (totals are dominated by the real photos; per-format rows force that format even where it is a poor fit, e.g. AVIF for 0.4 KB pixel art):

| Preset | Format | Total original | Total output | Saved | Min SSIM | Mean time / image |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| maximum | auto | 2.49 MB | 790.1 KB | 69.0% | 0.9930 | 3.6 s |
| maximum | png | 2.49 MB | 2.23 MB | 10.2% | 0.9937 | 1.5 s |
| maximum | webp | 2.49 MB | 920.1 KB | 63.9% | 0.9928 | 1.5 s |
| maximum | avif | 2.49 MB | 820.0 KB | 67.8% | 0.9934 | 1.3 s |
| maximum | jpeg (opaque only) | 2.26 MB | 1.04 MB | 53.8% | 0.9940 | 1.3 s |
| high | auto | 2.49 MB | 531.8 KB | 79.1% | 0.9862 | 3.6 s |
| high | png | 2.49 MB | 934.6 KB | 63.3% | 0.9857 | 1.7 s |
| high | webp | 2.49 MB | 633.6 KB | 75.1% | 0.9850 | 1.6 s |
| high | avif | 2.49 MB | 553.2 KB | 78.3% | 0.9863 | 1.4 s |
| high | jpeg (opaque only) | 2.26 MB | 701.2 KB | 69.7% | 0.9854 | 1.1 s |
| balanced | auto | 2.49 MB | 434.2 KB | 82.9% | 0.9778 | 3.6 s |
| balanced | png | 2.49 MB | 737.3 KB | 71.0% | 0.9754 | 2.1 s |
| balanced | webp | 2.49 MB | 504.4 KB | 80.2% | 0.9754 | 1.5 s |
| balanced | avif | 2.49 MB | 452.0 KB | 82.2% | 0.9778 | 1.3 s |
| balanced | jpeg (opaque only) | 2.26 MB | 623.0 KB | 73.0% | 0.9759 | 0.9 s |
| small | auto | 2.49 MB | 334.7 KB | 86.9% | 0.9636 | 3.5 s |
| small | png | 2.49 MB | 562.9 KB | 77.9% | 0.9625 | 2.3 s |
| small | webp | 2.49 MB | 368.8 KB | 85.5% | 0.9607 | 1.4 s |
| small | avif | 2.49 MB | 344.8 KB | 86.5% | 0.9636 | 1.3 s |
| small | jpeg (opaque only) | 2.26 MB | 554.5 KB | 76.0% | 0.9613 | 1.0 s |

Measured on a cloud container CPU in Node (single-threaded WASM, same binaries as the plugin). Full per-row reports (encoder settings, worst-block SSIM, PSNR) are written by `pnpm run benchmark`.
<!-- BENCHMARK:END -->

## TinyPNG comparison

```bash
TINIFY_API_KEY=… pnpm run benchmark:compare            # uses the official Tinify API
pnpm run benchmark:compare --preset=balanced        # compare another preset
```

Outputs from TinyPNG are cached in `benchmark/tinypng/` (you can also drop files
downloaded from tinypng.com there). The report compares size, dimensions,
transparency and SSIM/worst-block SSIM against the original for AssetForge and
TinyPNG, keeping the source format on both sides. AssetForge does not use or
imitate TinyPNG's proprietary implementation; only outputs are compared.

> The comparison could not be run while building this version (no TinyPNG API
> key and no network access to tinypng.com in the build environment); run it
> locally with your key.

## Testing

`pnpm test` (Vitest, Node) exercises the real WASM codecs and ONNX Runtime:

| Suite | Covers |
| --- | --- |
| `codecs` | PNG/oxipng/WebP/AVIF/MozJPEG round trips, alpha preservation, indexed PNG reduction, EXIF orientation, real fixtures |
| `formats` | magic-byte sniffing, corrupt/unknown input errors, metadata stripping (PNG chunks, JPEG EXIF), colour-profile detection |
| `crop-resize` | exact alpha bounds with faint anti-aliased pixels, no visible pixel lost, padding, aspect/upscale/independent-axis maths, premultiplied resampling without dark fringes |
| `metrics` | SSIM monotonicity, alpha-only differences, localised damage caught by worst-block SSIM |
| `compression` | palette budget & transparency, dithering vs banding, every format meets the target and keeps alpha, JPEG flattening, photo/illustration reductions, exact-colour stays lossless, measured candidate selection, preset ordering, custom preset |
| `background-removal` | model registry, tensor/normalisation, guided-filter refinement vs plain upscale, halo removal, existing alpha preserved, pipeline integration, skip-if-transparent, "no foreground" error, optional real RMBG test |
| `onnx-runner` | real ONNX Runtime inference with a tiny ONNX model (`fixtures/models/`), session reuse across a batch |
| `pipeline` | transparent/opaque PNG, JPEG, WebP inputs, gradients, fine detail, very large (6 MP) and very small (1×1) images, keep-original, clear errors, cancellation |
| `batch` | failure isolation, bounded concurrency, cancellation, memory growth over a batch of large images |

The segmentation network itself is replaced by a deterministic ground-truth
matte in `background-removal` tests (everything around it is production code),
and exercised for real by `onnx-runner`. To run the test against the actual
RMBG-1.4 model:

```bash
curl -L -o rmbg.onnx https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx
ASSETFORGE_MODEL_PATH=$PWD/rmbg.onnx pnpm test background-removal
```

`pnpm run test:e2e` (after `pnpm run build`) loads `dist/index.html` into an
opaque-origin sandboxed iframe in Chromium with a mock of the Figma main
thread, then processes a 4-image batch (one intentionally broken), opens the
preview, replaces images in "Figma" (asserting only PNG/JPEG reach
`createImage`), and runs a second batch with background removal through the ML
worker (CDN downloads are routed to local files). Screenshots are saved to
`e2e/screenshots/`.

## Memory and performance

- Source bytes are transferred (not copied) to workers; the UI keeps only the
  optimised file and a small WebP thumbnail per image. Full-resolution originals
  for the preview are re-read from Figma on demand and released on close.
  Object URLs are revoked when results are cleared or replaced.
- Controlled concurrency: `min(3, cores / 2)` workers (1 on low-memory
  devices), one image per worker, one shared ML worker so the model exists once.
- Emscripten codec heaps only grow; codec instances are recycled after a pixel
  budget and released at the end of every batch (compiled modules are cached,
  so re-instantiation is cheap).
- Intermediate buffers are dropped stage by stage; the palette quantiser caches
  per-image statistics so the palette-size search does not repeat the Wu pass.
- Typical times on a laptop (single-threaded WASM per worker): 0.3–2 s per
  sub-megapixel image for a fixed format, 2–10 s for `auto` with AVIF enabled
  (AVIF's encoder dominates — disable "Consider AVIF" for faster batches).

## Limitations

- **Real-model verification:** background removal was verified end-to-end with
  a tiny ONNX model and ground-truth mattes; the RMBG-1.4/MODNet downloads could
  not be exercised in the build environment (no access to Hugging Face). Run the
  optional integration test above to validate your model choice.
- AVIF encoding is single-threaded (no `SharedArrayBuffer` in the Figma iframe)
  and therefore the slowest step.
- GIF: only the first frame is processed. HEIC and other inputs Figma may store
  are rejected with a clear message.
- Embedded colour profiles are not converted; pixels are treated as sRGB (a
  warning is shown for non-sRGB profiles).
- The UI bundle is ≈ 10 MB because the codec binaries are embedded (so
  compression works offline); the ML runtime and model are downloaded on
  first use instead.
- WebGPU availability depends on the Figma client; the CPU path is always
  available.

## Extending AssetForge

The following are intentionally **not implemented**, but have explicit seams:

| Future feature | Extension point |
| --- | --- |
| S3 / Garage S3 / CDN upload, upload progress | `OutputSink` (`src/ui/outputs/sinks.ts`) — `deliver(assets, onProgress)` |
| Custom asset naming, versioning, hashing | `AssetNamer` (`src/ui/lib/naming.ts`); results carry bytes + format for hashing |
| Duplicate detection | selection is already deduplicated by Figma image hash |
| Multiple output formats per asset | `compress()` measures and returns all `candidates` |
| Asset presets / GramZone presets | `ProcessingOptions` + `QUALITY_TARGETS` are plain data |
| Sprite atlases, CLI, backend service | `processImage` / `processBatch` are Figma- and DOM-independent |
| Native/remote processing (companion, server) | `ProcessingBackend` (`src/ui/processing/backend.ts`), `SegmentationRunner` |
| Other quantisers (e.g. libimagequant) | `Quantizer` (`src/image/compression/quantize.ts`) |
| Other/self-hosted models | `registerSegmentationModel()` |

## Licences

AssetForge's own licence is up to the repository owner (`package.json` is
marked `UNLICENSED` until one is chosen). Bundled/used components: jSquash codecs
(Apache-2.0; MozJPEG BSD-style/IJG, libwebp BSD, libavif BSD-2, aom BSD-2,
oxipng MIT), image-q (MIT), ONNX Runtime Web (MIT), fflate (MIT), React (MIT).
Model licences are listed in [Background removal](#background-removal).
