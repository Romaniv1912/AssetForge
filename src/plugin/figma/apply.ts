import { PLUGIN_DATA_KEY } from '../../shared/constants';
import type { ApplyItem, ApplyMode, ApplyOutcome } from '../../shared/types';

const INSERT_GAP = 40;

/**
 * Writes processed images back into the document.
 *
 * - `replace`: every fill that showed the original image now references the
 *   new image. Other paint properties (filters, opacity, blend mode…) are kept.
 *   Cropped fills were processed from their visible region only, so their
 *   crop is reset and the new image fills the layer.
 * - `insert`: a new rectangle at the processed pixel size is placed next to
 *   the first node that used the image, leaving the original untouched.
 */
export async function applyResults(items: ApplyItem[], mode: ApplyMode, matchAspectRatio: boolean): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = [];
  const inserted: SceneNode[] = [];

  for (const item of items) {
    const warnings: string[] = [];
    try {
      if (item.targets.length === 0) throw new Error('No layers to update');
      const image = figma.createImage(item.bytes);

      if (mode === 'insert') {
        const node = await insertNode(image.hash, item);
        inserted.push(node);
        outcomes.push({ imageId: item.imageId, ok: true, updatedNodes: 1, warnings });
        continue;
      }

      let updated = 0;
      const errors: string[] = [];
      for (const target of item.targets) {
        try {
          const node = await figma.getNodeByIdAsync(target.nodeId);
          if (!node || !('fills' in node)) throw new Error('Layer was deleted');
          const fillable = node as SceneNode & MinimalFillsMixin;
          if (fillable.fills === figma.mixed) throw new Error('Layer has mixed fills');
          const fills = [...fillable.fills];
          const paint = fills[target.fillIndex];
          if (!paint || paint.type !== 'IMAGE' || paint.imageHash !== item.imageHash) {
            throw new Error('The image fill changed since it was processed');
          }
          const aspectChanged = aspectDiffers(item);
          let next: ImagePaint = { ...paint, imageHash: image.hash };
          if (item.cropped) {
            // The new image already is the visible part: drop the crop so it shows whole.
            const { imageTransform: _dropped, ...rest } = next;
            next = { ...rest, scaleMode: 'FILL' };
          } else if (paint.scaleMode === 'CROP' && aspectChanged) {
            // A crop transform is relative to the old image and would now show the wrong region.
            const { imageTransform: _dropped, ...rest } = next;
            next = { ...rest, scaleMode: 'FILL' };
            warnings.push(`${node.name}: crop mode reset to Fill because the image proportions changed`);
          }
          fills[target.fillIndex] = next;
          fillable.fills = fills;

          if (matchAspectRatio && aspectChanged && paint.scaleMode !== 'TILE' && 'resize' in node && node.type !== 'TEXT') {
            const resizable = node as SceneNode & LayoutMixin;
            const height = (resizable.width * item.height) / item.width;
            try {
              resizable.resize(resizable.width, Math.max(0.01, height));
            } catch {
              warnings.push(`${node.name}: layer could not be resized (constrained by its parent)`);
            }
          }
          updated++;
          try {
            node.setPluginData(
              PLUGIN_DATA_KEY,
              JSON.stringify({ originalImageHash: item.imageHash, processedImageHash: image.hash, processedAt: Date.now() }),
            );
          } catch {
            // Some layers (e.g. inside remote instances) refuse plugin data; the fill was still replaced.
          }
        } catch (error) {
          errors.push(`${target.nodeName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      outcomes.push({
        imageId: item.imageId,
        ok: updated > 0,
        updatedNodes: updated,
        error: errors.length ? errors.join('; ') : undefined,
        warnings,
      });
    } catch (error) {
      outcomes.push({
        imageId: item.imageId,
        ok: false,
        updatedNodes: 0,
        error: error instanceof Error ? error.message : String(error),
        warnings,
      });
    }
  }

  if (inserted.length > 0) {
    figma.currentPage.selection = inserted;
    figma.viewport.scrollAndZoomIntoView(inserted);
  }
  return outcomes;
}

function aspectDiffers(item: ApplyItem): boolean {
  if (!item.sourceWidth || !item.sourceHeight) return true;
  const before = item.sourceWidth / item.sourceHeight;
  const after = item.width / item.height;
  return Math.abs(before - after) / before > 0.005;
}

async function insertNode(hash: string, item: ApplyItem): Promise<SceneNode> {
  const rect = figma.createRectangle();
  rect.name = `${item.name} — ${item.label}`;
  rect.resize(item.width, item.height);
  rect.fills = [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' }];
  rect.setPluginData(
    PLUGIN_DATA_KEY,
    JSON.stringify({ originalImageHash: item.imageHash, processedImageHash: hash, processedAt: Date.now() }),
  );

  const first = item.targets[0];
  const source = first ? await figma.getNodeByIdAsync(first.nodeId) : null;
  const box = source && 'absoluteBoundingBox' in source ? (source as SceneNode).absoluteBoundingBox : null;
  figma.currentPage.appendChild(rect);
  if (box) {
    rect.x = box.x + box.width + INSERT_GAP;
    rect.y = box.y;
  } else {
    rect.x = figma.viewport.center.x - item.width / 2;
    rect.y = figma.viewport.center.y - item.height / 2;
  }
  return rect;
}
