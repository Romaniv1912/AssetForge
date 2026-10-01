import { throwIfCancelled, type CancellationToken, type ProgressCallback, type RgbaImage } from '../types';
import type { EnhanceModelSpec } from './models';
import type { EnhanceRunner } from './runner';

/**
 * Tiled super-resolution. The image is split into `tile`² blocks; each block
 * is inferred with `tilePad` pixels of context on every side and only its
 * centre is kept, so tiles join without seams while memory stays bounded
 * regardless of image size.
 *
 * Transparent images: the colour under transparent pixels is meaningless
 * (often black) and would be "enhanced" into halos, so it is first filled
 * with the colour of the nearest visible pixels. The alpha channel itself is
 * upscaled by the model too (as a grey image), which keeps cut-out edges as
 * crisp as the colours.
 */
export async function aiUpscale(
  image: RgbaImage,
  model: EnhanceModelSpec,
  runner: EnhanceRunner,
  opts: { cancel?: CancellationToken; onProgress?: ProgressCallback } = {},
): Promise<RgbaImage> {
  if (!hasTransparency(image)) return upscaleRgb(image, model, runner, opts, [0, 1]);
  const colour = await upscaleRgb(bleedColours(image), model, runner, opts, [0, 0.5]);
  const alpha = await upscaleRgb(alphaAsGrey(image), model, runner, opts, [0.5, 1]);
  for (let i = 0; i < colour.data.length; i += 4) {
    // Model output is a grey image: average the channels for the alpha value.
    colour.data[i + 3] = (alpha.data[i]! + alpha.data[i + 1]! + alpha.data[i + 2]!) / 3;
  }
  return colour;
}

async function upscaleRgb(
  image: RgbaImage,
  model: EnhanceModelSpec,
  runner: EnhanceRunner,
  opts: { cancel?: CancellationToken; onProgress?: ProgressCallback },
  span: [number, number],
): Promise<RgbaImage> {
  const { width, height, data } = image;
  const s = model.scale;
  const outW = width * s;
  const outH = height * s;
  const out = new Uint8ClampedArray(outW * outH * 4);

  const cols = Math.ceil(width / model.tile);
  const rows = Math.ceil(height / model.tile);
  const total = cols * rows;
  let done = 0;

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      throwIfCancelled(opts.cancel);
      // Kept region and its padded context, in input pixels.
      const x0 = tx * model.tile;
      const y0 = ty * model.tile;
      const x1 = Math.min(width, x0 + model.tile);
      const y1 = Math.min(height, y0 + model.tile);
      const px0 = Math.max(0, x0 - model.tilePad);
      const py0 = Math.max(0, y0 - model.tilePad);
      const px1 = Math.min(width, x1 + model.tilePad);
      const py1 = Math.min(height, y1 + model.tilePad);
      const tw = px1 - px0;
      const th = py1 - py0;

      const plane = tw * th;
      const tensor = new Float32Array(3 * plane);
      for (let y = 0; y < th; y++) {
        let src = ((py0 + y) * width + px0) * 4;
        const row = y * tw;
        for (let x = 0; x < tw; x++, src += 4) {
          tensor[row + x] = data[src]! / 255;
          tensor[plane + row + x] = data[src + 1]! / 255;
          tensor[2 * plane + row + x] = data[src + 2]! / 255;
        }
      }

      const result = await runner.enhance(model.id, tensor, tw, th);
      if (result.width !== tw * s || result.height !== th * s) {
        throw new Error(`Upscale model returned ${result.width}×${result.height} for a ${tw}×${th} tile (expected ×${s})`);
      }
      const rPlane = result.width * result.height;
      const offX = (x0 - px0) * s;
      const offY = (y0 - py0) * s;
      const keepW = (x1 - x0) * s;
      const keepH = (y1 - y0) * s;
      for (let y = 0; y < keepH; y++) {
        const srcRow = (offY + y) * result.width + offX;
        let dst = ((y0 * s + y) * outW + x0 * s) * 4;
        for (let x = 0; x < keepW; x++, dst += 4) {
          const i = srcRow + x;
          // Uint8ClampedArray rounds and clamps the model's [0,1] output.
          out[dst] = result.data[i]! * 255;
          out[dst + 1] = result.data[rPlane + i]! * 255;
          out[dst + 2] = result.data[2 * rPlane + i]! * 255;
          out[dst + 3] = 255;
        }
      }
      done++;
      const fraction = span[0] + ((span[1] - span[0]) * done) / total;
      opts.onProgress?.({ stage: 'enhancing', fraction, detail: `AI upscale ×${s}: ${Math.round(fraction * 100)}%` });
    }
  }
  return { width: outW, height: outH, data: out };
}

function alphaAsGrey(image: RgbaImage): RgbaImage {
  const out = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = image.data[i + 3]!;
    out[i] = a;
    out[i + 1] = a;
    out[i + 2] = a;
    out[i + 3] = 255;
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * Fills the colour of fully transparent pixels with the alpha-weighted
 * average of nearby visible pixels ("push-pull" over an image pyramid), so
 * the model sees edges continue smoothly instead of a jump to black.
 */
export function bleedColours(image: RgbaImage): RgbaImage {
  const { width, height, data } = image;
  // Level 0: premultiplied colour sums and alpha weights.
  const levels: { w: number; h: number; rgb: Float32Array; a: Float32Array }[] = [];
  let w = width;
  let h = height;
  let rgb = new Float32Array(w * h * 3);
  let a = new Float32Array(w * h);
  for (let i = 0, p = 0; p < w * h; p++, i += 4) {
    const alpha = data[i + 3]! / 255;
    a[p] = alpha;
    rgb[p * 3] = data[i]! * alpha;
    rgb[p * 3 + 1] = data[i + 1]! * alpha;
    rgb[p * 3 + 2] = data[i + 2]! * alpha;
  }
  levels.push({ w, h, rgb, a });
  // Pull: 2×2 sums down to 1×1.
  while (w > 1 || h > 1) {
    const nw = Math.max(1, Math.ceil(w / 2));
    const nh = Math.max(1, Math.ceil(h / 2));
    const nrgb = new Float32Array(nw * nh * 3);
    const na = new Float32Array(nw * nh);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const q = (y >> 1) * nw + (x >> 1);
        na[q] = na[q]! + a[p]!;
        for (let k = 0; k < 3; k++) nrgb[q * 3 + k] = nrgb[q * 3 + k]! + rgb[p * 3 + k]!;
      }
    }
    w = nw;
    h = nh;
    rgb = nrgb;
    a = na;
    levels.push({ w, h, rgb, a });
  }
  // Push: each level's colour = its own average where it has coverage, else the coarser level's.
  const colour: Float32Array[] = new Array(levels.length);
  const top = levels[levels.length - 1]!;
  colour[levels.length - 1] = top.a[0]! > 0 ? top.rgb.map((v) => v / top.a[0]!) : new Float32Array(3);
  for (let l = levels.length - 2; l >= 0; l--) {
    const { w: lw, h: lh, rgb: lrgb, a: la } = levels[l]!;
    const coarse = colour[l + 1]!;
    const cw = levels[l + 1]!.w;
    const c = new Float32Array(lw * lh * 3);
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const p = y * lw + x;
        const q = (y >> 1) * cw + (x >> 1);
        const weight = Math.min(1, la[p]!);
        for (let k = 0; k < 3; k++) {
          const own = la[p]! > 0 ? lrgb[p * 3 + k]! / la[p]! : 0;
          c[p * 3 + k] = own * weight + coarse[q * 3 + k]! * (1 - weight);
        }
      }
    }
    colour[l] = c;
  }
  const out = new Uint8ClampedArray(data);
  const fill = colour[0]!;
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    if (data[i + 3] === 0) {
      out[i] = fill[p * 3]!;
      out[i + 1] = fill[p * 3 + 1]!;
      out[i + 2] = fill[p * 3 + 2]!;
    }
  }
  return { width, height, data: out };
}

function hasTransparency(image: RgbaImage): boolean {
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i]! < 255) return true;
  return false;
}
