/**
 * AssetForge compression benchmark.
 *
 *   pnpm run benchmark                         # all images, preset "high", all formats
 *   pnpm run benchmark --presets=all        # tuning sweep over every preset
 *   pnpm run benchmark --formats=png,webp --images=logo,astronaut
 *
 * For each image, format and preset it runs the production compression engine
 * (same WASM codecs and perceptual search as the plugin) and records size,
 * reduction, dimensions, SSIM / worst-block SSIM / PSNR and encode time.
 * Results are printed and written to benchmark/results/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeImage } from '../src/image/analysis/analyze';
import { optimisePngRaw, setWasmBinaryProvider } from '../src/image/codecs';
import { nodeWasmProvider } from '../src/image/codecs/providers/node';
import { compress } from '../src/image/compression/compress';
import { decodeImage } from '../src/image/decode/decode';
import type { CompressionPreset, ImageFormat, OutputFormat, RgbaImage } from '../src/image/types';
import { loadBenchmarkImages } from './images';

setWasmBinaryProvider(nodeWasmProvider);

interface Row {
  image: string;
  kind: string;
  preset: CompressionPreset;
  requested: OutputFormat;
  format: string;
  originalBytes: number;
  outputBytes: number;
  reduction: number;
  width: number;
  height: number;
  ssim: number;
  worstBlockSsim: number;
  psnr: number;
  ms: number;
  settings: string;
  passed: boolean;
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k!, v ?? 'true'];
  }),
);

const presets: CompressionPreset[] =
  args.presets === 'all' ? ['maximum', 'high', 'balanced', 'small'] : ((args.presets ?? 'high').split(',') as CompressionPreset[]);
const formats: OutputFormat[] = (args.formats ?? 'original,auto,png,webp,avif,jpeg').split(',') as OutputFormat[];
const only = args.images ? new Set(args.images.split(',')) : undefined;

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

async function main() {
  const images = (await loadBenchmarkImages()).filter((img) => !only || only.has(img.name));
  const rows: Row[] = [];

  for (const entry of images) {
    let image: RgbaImage;
    let originalBytes: number;
    let sourceFormat: ImageFormat;
    if (entry.bytes) {
      const decoded = await decodeImage(entry.bytes);
      image = decoded.image;
      originalBytes = entry.bytes.length;
      sourceFormat = decoded.format;
    } else {
      image = entry.image!;
      // Synthetic images: the reference "original" is a standard lossless PNG.
      originalBytes = (await optimisePngRaw(image, { level: 2 })).length;
      sourceFormat = 'png';
    }
    const analysis = analyzeImage(image, sourceFormat);
    console.log(`\n▶ ${entry.name} (${entry.kind}) ${image.width}×${image.height}, ${kb(originalBytes)}, content=${analysis.contentType}, alpha=${analysis.alphaKind}`);

    for (const preset of presets) {
      for (const format of formats) {
        if (format === 'jpeg' && analysis.hasAlpha) continue;
        const start = performance.now();
        const out = await compress({
          image,
          analysis,
          options: { format, preset, allowAvifInAuto: true, custom: { quality: 80, lossless: false } },
        });
        const ms = performance.now() - start;
        const row: Row = {
          image: entry.name,
          kind: entry.kind,
          preset,
          requested: format,
          format: out.format,
          originalBytes,
          outputBytes: out.bytes.length,
          reduction: 1 - out.bytes.length / originalBytes,
          width: image.width,
          height: image.height,
          ssim: out.metrics.ssim,
          worstBlockSsim: out.metrics.worstBlockSsim,
          psnr: out.metrics.psnr,
          ms,
          settings: out.settings,
          passed: out.candidates.some((c) => c.passed),
        };
        rows.push(row);
        console.log(
          `  ${pad(preset, 9)} ${pad(format === 'auto' ? `auto→${out.format}` : out.format, 11)} ${lpad(kb(originalBytes), 10)} → ${lpad(kb(row.outputBytes), 10)} ${lpad(`${(row.reduction * 100).toFixed(1)}%`, 7)}  SSIM ${row.ssim.toFixed(4)} worst ${row.worstBlockSsim.toFixed(3)} PSNR ${Number.isFinite(row.psnr) ? row.psnr.toFixed(1) : '∞'}  ${lpad(`${Math.round(ms)} ms`, 8)}  ${row.settings}`,
        );
      }
    }
  }

  const markdown = toMarkdown(rows);
  console.log(`\n${summary(rows)}`);
  const dir = fileURLToPath(new URL('./results/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`${dir}benchmark-${stamp}.md`, `${markdown}\n\n${summary(rows)}\n`);
  writeFileSync(`${dir}benchmark-${stamp}.json`, JSON.stringify(rows, null, 2));
  console.log(`Results written to benchmark/results/benchmark-${stamp}.{md,json}`);
}

function toMarkdown(rows: Row[]): string {
  const header =
    '| Image | Kind | Preset | Format | Original | Output | Reduction | Dimensions | SSIM | Worst block | PSNR | Time | Encoder |\n' +
    '| --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |';
  const lines = rows.map(
    (r) =>
      `| ${r.image} | ${r.kind} | ${r.preset} | ${r.requested === 'auto' ? `auto→${r.format}` : r.format} | ${kb(r.originalBytes)} | ${kb(r.outputBytes)} | ${(r.reduction * 100).toFixed(1)}% | ${r.width}×${r.height} | ${r.ssim.toFixed(4)} | ${r.worstBlockSsim.toFixed(3)} | ${Number.isFinite(r.psnr) ? r.psnr.toFixed(1) : '∞'} | ${Math.round(r.ms)} ms | ${r.settings} |`,
  );
  return [header, ...lines].join('\n');
}

function summary(rows: Row[]): string {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.preset} / ${r.requested}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const lines = ['| Preset / format | Images | Mean reduction | Total original | Total output | Min SSIM | Mean time |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const [key, list] of groups) {
    const original = list.reduce((n, r) => n + r.originalBytes, 0);
    const output = list.reduce((n, r) => n + r.outputBytes, 0);
    const mean = list.reduce((n, r) => n + r.reduction, 0) / list.length;
    const minSsim = Math.min(...list.map((r) => r.ssim));
    const time = list.reduce((n, r) => n + r.ms, 0) / list.length;
    lines.push(`| ${key} | ${list.length} | ${(mean * 100).toFixed(1)}% | ${kb(original)} | ${kb(output)} | ${minSsim.toFixed(4)} | ${Math.round(time)} ms |`);
  }
  return lines.join('\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
