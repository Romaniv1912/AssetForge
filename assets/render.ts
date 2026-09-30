/**
 * Renders the plugin icon and Figma Community cover from assets/icon.svg.
 *   pnpm run assets
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const dir = fileURLToPath(new URL('.', import.meta.url));
const svg = readFileSync(`${dir}icon.svg`, 'utf8');

const cover = `
<div style="width:1920px;height:960px;display:flex;align-items:center;justify-content:center;gap:72px;
  background:radial-gradient(circle at 25% 30%,#2a2560 0,#14122b 60%);font-family:Inter,system-ui,sans-serif;color:#fff">
  <div style="width:360px;height:360px">${svg.replace('width="128" height="128"', 'width="360" height="360"')}</div>
  <div style="max-width:980px">
    <div style="font-size:120px;font-weight:700;letter-spacing:-2px">AssetForge</div>
    <div style="font-size:44px;line-height:1.35;opacity:.85;margin-top:24px">
      Remove backgrounds, crop, resize and compress images — locally, with TinyPNG-class results.
    </div>
    <div style="display:flex;gap:16px;margin-top:40px;font-size:30px">
      ${['PNG', 'WebP', 'AVIF', 'JPEG'].map((f) => `<span style="padding:10px 22px;border-radius:14px;background:rgba(255,255,255,.12)">${f}</span>`).join('')}
    </div>
  </div>
</div>`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
for (const size of [128, 512]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent">${svg.replace('width="128" height="128"', `width="${size}" height="${size}"`)}</body>`);
  await page.screenshot({ path: `${dir}icon-${size}.png`, omitBackground: true });
}
await page.setViewportSize({ width: 1920, height: 960 });
await page.setContent(`<body style="margin:0">${cover}</body>`);
await page.screenshot({ path: `${dir}cover.png` });
await browser.close();
console.log('Wrote assets/icon-128.png, assets/icon-512.png, assets/cover.png');
