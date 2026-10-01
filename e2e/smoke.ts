/**
 * End-to-end smoke test of the *built* plugin UI in Chromium.
 *
 *   pnpm run build && pnpm run test:e2e
 *
 * A mock Figma host (e2e/harness.*) loads dist/index.html into an
 * opaque-origin sandboxed iframe — like Figma — and answers the plugin
 * protocol with fixture images. The test drives the real UI: selection
 * summary, batch processing in Web Workers with WASM codecs, a failing item,
 * preview, and "Replace in Figma". Screenshots go to e2e/screenshots/.
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Frame } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const shots = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(shots, { recursive: true });

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file: string;
  if (url.pathname === '/' || url.pathname === '/harness.html') file = `${root}e2e/harness.html`;
  else if (url.pathname === '/harness.js') file = `${root}e2e/harness.js`;
  else if (url.pathname === '/ui.html') file = `${root}dist/index.html`;
  else if (url.pathname.startsWith('/fixtures/')) file = `${root}fixtures/images/${url.pathname.slice('/fixtures/'.length)}`;
  else {
    res.writeHead(404).end();
    return;
  }
  try {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  // Show real scrollbars (headless hides them by default) so screenshots match Figma.
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    ignoreDefaultArgs: ['--hide-scrollbars'],
  });
  const page = await browser.newPage({ viewport: { width: 820, height: 720 } });
  const errors: string[] = [];
  lastErrors = errors;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`[${m.type()}] ${m.text()} ${m.location().url}`));

  // Background removal off: it needs to download the model, which CI may not allow.
  await page.addInitScript(() => {
    (window as unknown as { __initialOptions: unknown }).__initialOptions = {
      backgroundRemoval: { enabled: false, model: 'rmbg-1.4', skipIfTransparent: true, refineEdges: true, decontaminateColors: true },
      crop: { enabled: true, padding: 8, alphaThreshold: 0 },
      resize: { enabled: true, maxWidth: 1024, maxHeight: 1024, preserveAspectRatio: true, allowUpscale: false },
      compression: { format: 'original', preset: 'high', allowAvifInAuto: true, custom: { quality: 80, lossless: false } },
    };
  });
  // Offline stand-ins for the CDN downloads done by the ML worker: the real
  // ONNX Runtime binaries from node_modules and a tiny ONNX model with the
  // segmentation I/O contract (fixtures/models/tiny-segmentation.onnx).
  const hits = { runtime: 0, model: 0, enhance: 0 };
  await page.context().route('https://cdn.jsdelivr.net/npm/onnxruntime-web@*/dist/*', async (route) => {
    hits.runtime++;
    const file = new URL(route.request().url()).pathname.split('/').pop()!;
    await route.fulfill({ body: readFileSync(require.resolve(`onnxruntime-web/${file}`)), contentType: 'application/wasm' });
  });
  // The AI-upscale model is published with the hosted UI on GitHub Pages.
  await page.context().route('https://romaniv1912.github.io/**/models/*.onnx', async (route) => {
    hits.enhance++;
    await route.fulfill({ body: readFileSync(`${root}models/realesr-general-x4v3.onnx`), contentType: 'application/octet-stream' });
  });
  await page.context().route('https://huggingface.co/**', async (route) => {
    hits.model++;
    await route.fulfill({ body: readFileSync(`${root}fixtures/models/tiny-segmentation.onnx`), contentType: 'application/octet-stream' });
  });
  await page.goto(`http://localhost:${port}/`);
  const frame = await waitForFrame(page.frames.bind(page));

  await frame.getByText('Selected images').waitFor();
  assert((await frame.locator('.selection__value').first().textContent())?.trim() === '5', 'five images detected');
  await frame.getByText(/cropped\s+in Figma/).waitFor();
  // Originals are downloaded byte-for-byte (one per unique image hash).
  const [originals] = await Promise.all([page.waitForEvent('download'), frame.getByRole('button', { name: 'Download originals' }).click()]);
  assert(originals.suggestedFilename() === 'assetforge-originals.zip', 'originals downloaded as a ZIP');
  const { unzipSync } = await import('fflate');
  const zip = unzipSync(new Uint8Array(readFileSync((await originals.path())!)));
  const catFile = Object.entries(zip).find(([name]) => name.startsWith('cropped-cat') || name.startsWith('cat-photo'));
  assert(Object.keys(zip).length === 3, `three unique originals (missing one fails): ${Object.keys(zip).join(', ')}`);
  assert(catFile && Buffer.from(catFile[1]).equals(readFileSync(`${root}fixtures/images/chelsea.png`)), 'original bytes are unchanged');
  await frame.getByText('Unsupported nodes').click();
  await frame.getByText('Text without an image fill').waitFor();
  await page.screenshot({ path: `${shots}01-settings.png` });

  const processButton = frame.getByRole('button', { name: /Process 5 images/ });
  await processButton.waitFor();
  await frame.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.button--primary')?.disabled);
  const started = Date.now();
  await processButton.click();
  await frame.getByText(/Processing \d+ \/ 5/).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: `${shots}02-processing.png` });
  await frame.getByRole('button', { name: /Replace in Figma/ }).waitFor({ timeout: 300_000 });
  console.log(`Batch finished in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  if (process.env.E2E_DEBUG) await page.waitForTimeout(20_000);
  const statuses = await frame.locator('.status').allTextContents();
  console.log('Statuses:', statuses.join(', '));
  assert(statuses.filter((s) => s === 'Completed').length === 4, 'four images completed');
  assert(statuses.filter((s) => s === 'Failed').length === 1, 'the broken image failed without stopping the batch');
  await frame.getByText('Image not found in this file').waitFor();
  const saved = await frame.locator('.summary__grid dd').nth(2).textContent();
  console.log('Summary saved:', saved);
  assert(saved && parseFloat(saved) > 50, 'batch saved more than 50%');
  await page.screenshot({ path: `${shots}03-results.png` });

  await frame.locator('.result__thumb').first().click();
  await frame.locator('figcaption', { hasText: 'Optimized' }).waitFor();
  await frame.locator('.compare__stats strong').first().filter({ hasText: /KB|MB/ }).waitFor({ timeout: 30_000 });
  await frame.getByRole('button', { name: 'Details' }).click();
  await frame.getByText('Measured candidates').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}04-preview.png` });
  await frame.getByRole('button', { name: /Close/ }).or(frame.locator('button[title^="Close"]')).first().click();

  await frame.getByRole('button', { name: /Replace in Figma/ }).click();
  await frame.getByText('Replaced').first().waitFor({ timeout: 60_000 });
  const applied = (await page.evaluate(() => (window as unknown as { __applied: unknown[] }).__applied)) as Array<{ magic: number[]; mode: string }>;
  console.log('Applied:', JSON.stringify(applied));
  assert(applied.length === 4, 'four images applied');
  const cropped = (applied as unknown as Array<{ imageId: string; width: number; height: number }>).find((a) => a.imageId.startsWith('hash-chelsea@'));
  assert(cropped && cropped.width === 225 && cropped.height === 300, 'cropped fill is processed from its visible part');
  for (const item of applied) {
    const png = item.magic[0] === 0x89 && item.magic[1] === 0x50;
    const jpeg = item.magic[0] === 0xff && item.magic[1] === 0xd8;
    assert(png || jpeg, 'Figma receives PNG or JPEG only');
  }
  await page.screenshot({ path: `${shots}05-applied.png` });

  // Second batch with background removal: exercises the dedicated ML worker
  // (ONNX Runtime in a classic worker, model download + cache, MessagePort
  // bridge from the processing workers).
  await frame.getByRole('tab', { name: 'Settings' }).click();
  await frame.getByText('Remove background', { exact: true }).click();
  await frame.getByText(/Runs locally/).waitFor();
  await frame.getByLabel('Model').selectOption('rmbg-1.4-full');
  await frame.locator('.app__body').evaluate((el) => el.scrollTo(0, 200));
  await page.screenshot({ path: `${shots}00-settings-rmbg2.png` });
  await frame.getByRole('button', { name: /Process 5 images/ }).click();
  await frame.getByRole('button', { name: /Replace in Figma/ }).waitFor({ timeout: 300_000 });
  const statusesBg = await frame.locator('.status').allTextContents();
  console.log('Statuses (background removal):', statusesBg.join(', '), '| downloads:', JSON.stringify(hits));
  assert(statusesBg.filter((s) => s === 'Completed').length === 4, 'four images completed with background removal');
  assert(hits.model === 1, 'model downloaded exactly once for the whole batch');
  assert(hits.runtime >= 1, 'ONNX Runtime binary fetched');
  await frame.locator('.result__thumb').first().click();
  await frame.getByRole('button', { name: 'Details' }).click();
  await frame.getByText('Background removed: yes').waitFor();
  await page.screenshot({ path: `${shots}06-background-removed.png` });
  // Slider comparison works for cropped/resized results too.
  const sliderButton = frame.getByRole('button', { name: 'Slider' });
  await frame.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.segmented button:nth-child(2)')?.disabled);
  await sliderButton.click();
  const stack = frame.locator('.slider-view__stack');
  await stack.waitFor();
  const box = await stack.boundingBox();
  assert(box && box.width > 100 && box.height > 100, 'slider view is sized to the original');
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height / 2);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${shots}06b-slider.png` });

  // Figma dark theme: Figma injects its tokens and the figma-dark class into the iframe.
  await frame.evaluate(() => {
    const tokens: Record<string, string> = {
      '--figma-color-bg': '#2c2c2c',
      '--figma-color-bg-secondary': '#383838',
      '--figma-color-bg-tertiary': '#444444',
      '--figma-color-bg-hover': '#383838',
      '--figma-color-bg-pressed': '#444444',
      '--figma-color-bg-selected': '#4a5878',
      '--figma-color-text': '#ffffff',
      '--figma-color-text-secondary': 'rgba(255,255,255,0.7)',
      '--figma-color-text-tertiary': 'rgba(255,255,255,0.4)',
      '--figma-color-icon': '#ffffff',
      '--figma-color-icon-secondary': 'rgba(255,255,255,0.7)',
      '--figma-color-border': '#444444',
      '--figma-color-border-strong': '#ffffff',
      '--figma-color-text-brand': '#7cc4f8',
      '--figma-color-text-success': '#79d297',
      '--figma-color-bg-success-tertiary': '#0d3a24',
      '--figma-color-text-danger': '#fca397',
      '--figma-color-bg-danger-tertiary': '#4d1e14',
      '--figma-color-text-warning': '#f7d15f',
      '--figma-color-bg-warning-tertiary': '#4a3a0a',
    };
    document.documentElement.classList.add('figma-dark');
    for (const [k, v] of Object.entries(tokens)) document.documentElement.style.setProperty(k, v);
  });
  await frame.getByRole('button', { name: /Close/ }).or(frame.locator('button[title^="Close"]')).first().click();
  await page.screenshot({ path: `${shots}07-dark-results.png` });
  await frame.getByRole('tab', { name: 'Settings' }).click();
  await page.screenshot({ path: `${shots}08-dark-settings.png` });

  // Third batch: AI upscale (real Real-ESRGAN model through the ML worker).
  // With a 512 px box, the two small images (cropped cat 225×300 and the cat
  // photo 451×300) are upscaled; the others are already large enough.
  await frame.getByText('Remove background', { exact: true }).click();
  await frame.getByText('AI upscale (Real-ESRGAN)', { exact: true }).click();
  await frame.getByLabel('Max width').fill('512');
  await frame.getByLabel('Max height').fill('512');
  await page.screenshot({ path: `${shots}09-enhance-settings.png` });
  const enhanceStarted = Date.now();
  await frame.getByRole('button', { name: /Process 5 images/ }).click();
  await frame.getByRole('button', { name: /Replace in Figma/ }).waitFor({ timeout: 600_000 });
  console.log(`AI upscale batch finished in ${((Date.now() - enhanceStarted) / 1000).toFixed(1)} s`);
  const statusesEnhance = await frame.locator('.status').allTextContents();
  console.log('Statuses (AI upscale):', statusesEnhance.join(', '), '| downloads:', JSON.stringify(hits));
  assert(statusesEnhance.filter((s) => s === 'Completed').length === 4, 'four images completed with AI upscale');
  assert(hits.enhance === 1, 'upscale model downloaded once');
  await frame.locator('.result__thumb').first().click();
  await frame.getByRole('button', { name: 'Details' }).click();
  await frame.getByText('AI upscaled: yes').waitFor();
  const dims = await frame.locator('.compare__stats').nth(1).textContent();
  assert(dims?.includes('384×512'), `cropped cat upscaled into the 512 box: ${dims}`);
  await page.screenshot({ path: `${shots}10-enhanced.png` });
  await frame.getByRole('button', { name: /Close/ }).or(frame.locator('button[title^="Close"]')).first().click();

  const relevantErrors = errors.filter((e) => !/favicon|fonts\.g(oogleapis|static)\.com|WebGPU Context Provider/.test(e));
  if (errors.length) console.log('Console:', errors.join('\n'));
  assert(relevantErrors.length === 0, `no page errors: ${relevantErrors.join(' | ')}`);
  await browser.close();
  server.close();
  console.log('E2E smoke test passed. Screenshots in e2e/screenshots/.');
}

async function waitForFrame(frames: () => Frame[]): Promise<Frame> {
  for (let i = 0; i < 100; i++) {
    const frame = frames().find((f) => f.parentFrame() !== null);
    if (frame) {
      try {
        await frame.waitForSelector('#root > *', { timeout: 200 });
        return frame;
      } catch {
        // UI not rendered yet
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Plugin UI did not render');
}

let lastErrors: string[] = [];
main().catch(async (error) => {
  console.error(error);
  if (lastErrors.length) console.error('Page errors:\n' + lastErrors.join('\n'));
  server.close();
  process.exit(1);
});
