/**
 * AssetForge vs TinyPNG/TinyJPG comparison.
 *
 *   TINIFY_API_KEY=xxxx npm run benchmark:compare    # fetch TinyPNG results via the official API
 *   npm run benchmark:compare                        # use files already in benchmark/tinypng/
 *
 * TinyPNG results are cached in benchmark/tinypng/<name>.<ext>. You can also
 * drop files there manually after compressing the fixtures on tinypng.com.
 * Both outputs keep the source format (PNG → PNG, JPEG → JPEG) so the
 * comparison is like-for-like. No TinyPNG implementation details are used;
 * this only measures outputs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setWasmBinaryProvider } from '../src/image/codecs';
import { nodeWasmProvider } from '../src/image/codecs/providers/node';
import { decodeImage } from '../src/image/decode/decode';
import { FILE_EXTENSIONS } from '../src/image/decode/sniff';
import { compareImages, imageHasAlpha } from '../src/image/metrics/ssim';
import { processImage } from '../src/image/pipeline/process-image';
import type { CompressionPreset, EncodableFormat, ProcessingOptions } from '../src/image/types';

setWasmBinaryProvider(nodeWasmProvider);

const FIXTURES = ['astronaut.png', 'chelsea.png', 'coffee.png', 'logo.png', 'text.png', 'rocket.jpg', 'hubble_deep_field.jpg'];
const tinyDir = fileURLToPath(new URL('./tinypng/', import.meta.url));
const preset = (process.argv.find((a) => a.startsWith('--preset='))?.split('=')[1] ?? 'high') as CompressionPreset;

async function tinify(name: string, source: Uint8Array, format: string): Promise<Uint8Array | null> {
  const cached = `${tinyDir}${name.replace(/\.\w+$/, '')}.${FILE_EXTENSIONS[format as EncodableFormat]}`;
  if (existsSync(cached)) return new Uint8Array(readFileSync(cached));
  const key = process.env.TINIFY_API_KEY;
  if (!key) return null;
  const auth = `Basic ${Buffer.from(`api:${key}`).toString('base64')}`;
  const shrink = await fetch('https://api.tinify.com/shrink', { method: 'POST', headers: { Authorization: auth }, body: source as BodyInit });
  if (!shrink.ok) throw new Error(`TinyPNG API error ${shrink.status}: ${await shrink.text()}`);
  const location = shrink.headers.get('location');
  if (!location) throw new Error('TinyPNG API returned no output location');
  const output = await fetch(location, { headers: { Authorization: auth } });
  const bytes = new Uint8Array(await output.arrayBuffer());
  mkdirSync(tinyDir, { recursive: true });
  writeFileSync(cached, bytes);
  return bytes;
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

async function main() {
  const rows: string[] = [
    `| Image | Original | AssetForge (${preset}) | TinyPNG | AF SSIM / worst | TinyPNG SSIM / worst | Dimensions | Alpha preserved (AF / Tiny) |`,
    '| --- | ---: | ---: | ---: | --- | --- | --- | --- |',
  ];
  for (const name of FIXTURES) {
    const source = new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/images/${name}`, import.meta.url))));
    const original = await decodeImage(source);
    const format = original.format as EncodableFormat;
    const options: ProcessingOptions = {
      backgroundRemoval: { enabled: false, model: 'rmbg-1.4', skipIfTransparent: true, refineEdges: true, decontaminateColors: true },
      crop: { enabled: false, padding: 0, alphaThreshold: 0 },
      resize: { enabled: false, maxWidth: 0, maxHeight: 0, preserveAspectRatio: true, allowUpscale: false },
      compression: { format, preset, allowAvifInAuto: false, custom: { quality: 80, lossless: false } },
    };
    const ours = await processImage(source, options);
    const oursDecoded = await decodeImage(ours.data);
    const oursMetrics = compareImages(original.image, oursDecoded.image);

    let tinyCell = 'n/a';
    let tinyMetrics = 'n/a';
    let tinyAlpha = 'n/a';
    try {
      const tiny = await tinify(name, source, format);
      if (tiny) {
        const decoded = await decodeImage(tiny);
        const m = compareImages(original.image, decoded.image);
        tinyCell = `${kb(tiny.length)} (${((1 - tiny.length / source.length) * 100).toFixed(1)}%)`;
        tinyMetrics = `${m.ssim.toFixed(4)} / ${m.worstBlockSsim.toFixed(3)}`;
        tinyAlpha = String(imageHasAlpha(decoded.image) === imageHasAlpha(original.image));
      }
    } catch (error) {
      tinyCell = `error: ${(error as Error).message}`;
    }

    rows.push(
      `| ${name} | ${kb(source.length)} | ${kb(ours.outputBytes)} (${(ours.savings * 100).toFixed(1)}%) | ${tinyCell} | ${oursMetrics.ssim.toFixed(4)} / ${oursMetrics.worstBlockSsim.toFixed(3)} | ${tinyMetrics} | ${ours.width}×${ours.height} | ${imageHasAlpha(oursDecoded.image) === imageHasAlpha(original.image)} / ${tinyAlpha} |`,
    );
    console.log(rows[rows.length - 1]);
  }
  const table = rows.join('\n');
  console.log(`\n${table}`);
  if (!process.env.TINIFY_API_KEY && !existsSync(tinyDir)) {
    console.log('\nTinyPNG columns are empty: set TINIFY_API_KEY or place TinyPNG outputs in benchmark/tinypng/.');
  }
  const out = fileURLToPath(new URL('./results/', import.meta.url));
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}tinypng-comparison.md`, `${table}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
