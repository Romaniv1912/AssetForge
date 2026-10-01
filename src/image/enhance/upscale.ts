import { resizeImage } from '../resize/resize';
import { throwIfCancelled, type CancellationToken, type ProgressCallback, type RgbaImage } from '../types';
import type { EnhanceModelSpec } from './models';
import type { EnhanceRunner } from './runner';

/**
 * Tiled super-resolution. The image is split into `tile`² blocks; each block
 * is inferred with `tilePad` pixels of context on every side and only its
 * centre is kept, so tiles join without seams while memory stays bounded
 * regardless of image size. Alpha is not seen by the model: it is resized
 * separately (Catmull-Rom) and recombined.
 */
export async function aiUpscale(
  image: RgbaImage,
  model: EnhanceModelSpec,
  runner: EnhanceRunner,
  opts: { cancel?: CancellationToken; onProgress?: ProgressCallback } = {},
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
      opts.onProgress?.({ stage: 'enhancing', fraction: done / total, detail: `AI upscale ×${s}: tile ${done}/${total}` });
    }
  }

  if (hasTransparency(image)) {
    const alpha = await resizeImage(image, { width: outW, height: outH });
    for (let i = 3; i < out.length; i += 4) out[i] = alpha.data[i]!;
  }
  return { width: outW, height: outH, data: out };
}

function hasTransparency(image: RgbaImage): boolean {
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i]! < 255) return true;
  return false;
}
