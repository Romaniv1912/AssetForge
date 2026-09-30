import { useState } from 'react';
import type { SelectionSnapshot } from '../../shared/types';
import { postToPlugin } from '../lib/bridge';
import { IconAlert, IconChevron } from './Icons';

export function SelectionSummary({ selection }: { selection: SelectionSnapshot }) {
  const [showUnsupported, setShowUnsupported] = useState(false);
  const images = selection.images.length;
  const fills = selection.images.reduce((n, i) => n + i.targets.length, 0);
  const unsupported = selection.unsupported.length;

  return (
    <div className="selection">
      <div className="selection__row">
        <span className="selection__label">Selected images</span>
        <span className="selection__value">{images}</span>
      </div>
      {fills > images && (
        <div className="selection__note">
          {fills} image fills share {images} unique image{images === 1 ? '' : 's'} — each is processed once.
        </div>
      )}
      {unsupported > 0 && (
        <>
          <button type="button" className="selection__row selection__row--warn" onClick={() => setShowUnsupported(!showUnsupported)}>
            <span className="selection__label">
              <IconAlert /> Unsupported nodes
            </span>
            <span className="selection__value">
              {unsupported}
              <IconChevron className={showUnsupported ? 'chevron chevron--open' : 'chevron'} />
            </span>
          </button>
          {showUnsupported && (
            <ul className="unsupported">
              {selection.unsupported.map((node) => (
                <li key={node.nodeId}>
                  <button type="button" className="link" onClick={() => postToPlugin({ type: 'SELECT_NODES', nodeIds: [node.nodeId] })}>
                    {node.nodeName}
                  </button>
                  <span className="unsupported__reason">{node.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {selection.truncated && (
        <div className="selection__note selection__note--warn">
          Selection is very large: only the first {selection.scannedNodes.toLocaleString()} layers were scanned.
        </div>
      )}
      {images === 0 && unsupported === 0 && (
        <div className="selection__empty">Select layers with image fills, or frames and groups that contain images.</div>
      )}
    </div>
  );
}
