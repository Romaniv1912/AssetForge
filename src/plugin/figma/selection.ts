import { MAX_SCANNED_NODES } from '../../shared/constants';
import { visibleRegion } from '../../shared/figma/crop';
import type { ImageTarget, NormalizedRect, SelectedImage, SelectionSnapshot, UnsupportedNode } from '../../shared/types';

type FillableNode = SceneNode & MinimalFillsMixin;

function hasFills(node: SceneNode): node is FillableNode {
  return 'fills' in node;
}

function hasChildren(node: BaseNode): node is BaseNode & ChildrenMixin {
  return 'children' in node;
}

interface FoundFill {
  hash: string;
  paint: ImagePaint;
  target: ImageTarget;
}

interface ScanState {
  found: FoundFill[];
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
  const state: ScanState = { found: [], images: new Map(), unsupported: [], scanned: 0, truncated: false };

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

  // Pixel sizes are needed to show sizes and to find the visible part of Fill-mode fills.
  const sizes = new Map<string, { width: number; height: number } | null>();
  await Promise.all(
    [...new Set(state.found.map((f) => f.hash))].map(async (hash) => {
      const handle = figma.getImageByHash(hash);
      try {
        sizes.set(hash, handle ? await handle.getSizeAsync() : null);
      } catch {
        sizes.set(hash, null); // not loaded yet; shown as unknown
      }
    }),
  );
  for (const { hash, paint, target } of state.found) {
    const size = sizes.get(hash) ?? null;
    const crop = visibleRegion(paint, { width: target.nodeWidth, height: target.nodeHeight }, size ?? undefined);
    addTarget(state, hash, crop, size, target);
  }

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
          state.found.push({
            hash: paint.imageHash,
            paint,
            target: {
              nodeId: node.id,
              nodeName: node.name,
              nodeType: node.type,
              fillIndex,
              nodeWidth: 'width' in node ? node.width : 0,
              nodeHeight: 'height' in node ? node.height : 0,
            },
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

function addTarget(
  state: ScanState,
  hash: string,
  crop: NormalizedRect | null,
  size: { width: number; height: number } | null,
  target: ImageTarget,
): void {
  const id = cropKey(hash, crop);
  const existing = state.images.get(id);
  if (existing) {
    existing.targets.push(target);
    return;
  }
  state.images.set(id, {
    id,
    hash,
    crop,
    name: target.nodeName,
    width: size ? (crop ? Math.max(1, Math.round(size.width * crop.width)) : size.width) : null,
    height: size ? (crop ? Math.max(1, Math.round(size.height * crop.height)) : size.height) : null,
    fullWidth: size?.width ?? null,
    fullHeight: size?.height ?? null,
    targets: [target],
  });
}

function countTargets(state: ScanState): number {
  return state.found.length;
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
