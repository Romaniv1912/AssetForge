import { MAX_SCANNED_NODES } from '../../shared/constants';
import { cropOf } from '../../shared/figma/crop';
import type { ImageTarget, NormalizedRect, SelectedImage, SelectionSnapshot, UnsupportedNode } from '../../shared/types';

type FillableNode = SceneNode & MinimalFillsMixin;

function hasFills(node: SceneNode): node is FillableNode {
  return 'fills' in node;
}

function hasChildren(node: BaseNode): node is BaseNode & ChildrenMixin {
  return 'children' in node;
}

interface ScanState {
  images: Map<string, SelectedImage>;
  unsupported: UnsupportedNode[];
  scanned: number;
  truncated: boolean;
}

/**
 * Collects every image fill in the selection (including inside frames,
 * groups, components and instances) and explains everything it cannot use.
 */
export async function scanSelection(selection: readonly SceneNode[]): Promise<SelectionSnapshot> {
  const state: ScanState = { images: new Map(), unsupported: [], scanned: 0, truncated: false };

  for (const node of selection) {
    const before = countTargets(state);
    const problems: string[] = [];
    visit(node, state, problems, true);
    if (countTargets(state) === before) {
      state.unsupported.push({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        reason: problems[0] ?? (hasChildren(node) ? 'Contains no image fills' : describeNoImage(node)),
      });
    }
  }

  // Resolve pixel sizes (needed for display and for aspect-ratio decisions).
  await Promise.all(
    [...state.images.values()].map(async (image) => {
      const handle = figma.getImageByHash(image.hash);
      if (!handle) return;
      try {
        const size = await handle.getSizeAsync();
        image.width = image.crop ? Math.max(1, Math.round(size.width * image.crop.width)) : size.width;
        image.height = image.crop ? Math.max(1, Math.round(size.height * image.crop.height)) : size.height;
      } catch {
        // Size unavailable (image not yet loaded); shown as unknown.
      }
    }),
  );

  return {
    images: [...state.images.values()],
    unsupported: state.unsupported,
    truncated: state.truncated,
    scannedNodes: state.scanned,
  };
}

function visit(node: SceneNode, state: ScanState, problems: string[], isRoot: boolean): void {
  if (state.scanned >= MAX_SCANNED_NODES) {
    state.truncated = true;
    return;
  }
  state.scanned++;

  if (hasFills(node)) {
    const fills = node.fills;
    if (fills === figma.mixed) {
      problems.push('Mixed fills (text with several styles) cannot be processed');
    } else {
      fills.forEach((paint, fillIndex) => {
        if (paint.type === 'IMAGE') {
          if (!paint.imageHash) {
            problems.push('The image fill has no image data (still loading or missing)');
            return;
          }
          addTarget(state, paint.imageHash, cropOf(paint), {
            nodeId: node.id,
            nodeName: node.name,
            nodeType: node.type,
            fillIndex,
            nodeWidth: 'width' in node ? node.width : 0,
            nodeHeight: 'height' in node ? node.height : 0,
          });
        } else if (paint.type === 'VIDEO') {
          problems.push('Video fills are not supported');
        }
      });
    }
  } else if (isRoot && !hasChildren(node)) {
    problems.push(describeNoImage(node));
  }

  if (hasChildren(node)) {
    for (const child of node.children) {
      if (state.truncated) break;
      visit(child as SceneNode, state, problems, false);
    }
  }
}

function cropKey(hash: string, crop: NormalizedRect | null): string {
  if (!crop) return hash;
  return `${hash}@${[crop.x, crop.y, crop.width, crop.height].map((v) => v.toFixed(4)).join(',')}`;
}

function addTarget(state: ScanState, hash: string, crop: NormalizedRect | null, target: ImageTarget): void {
  const id = cropKey(hash, crop);
  const existing = state.images.get(id);
  if (existing) {
    existing.targets.push(target);
    return;
  }
  state.images.set(id, { id, hash, crop, name: target.nodeName, width: null, height: null, targets: [target] });
}

function countTargets(state: ScanState): number {
  let n = 0;
  for (const image of state.images.values()) n += image.targets.length;
  return n;
}

function describeNoImage(node: SceneNode): string {
  switch (node.type) {
    case 'SLICE':
      return 'Slices cannot contain images';
    case 'CONNECTOR':
    case 'LINE':
      return `${label(node.type)} layers cannot contain images`;
    case 'TEXT':
      return 'Text without an image fill';
    default:
      return 'No image fill';
  }
}

function label(type: string): string {
  return type.charAt(0) + type.slice(1).toLowerCase();
}
