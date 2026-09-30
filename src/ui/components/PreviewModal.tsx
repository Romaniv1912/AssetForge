import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { MIME_TYPES, sniffFormat } from '../../image/decode/sniff';
import { UI_SIZE, UI_SIZE_EXPANDED } from '../../shared/constants';
import type { BatchItem } from '../hooks/useBatch';
import { postToPlugin, requestImageBytes } from '../lib/bridge';
import { formatBytes, formatChange, formatDimensions, formatMetric } from '../lib/format';
import { IconArrowLeft, IconArrowRight, IconClose, IconDownload } from './Icons';

type Zoom = 'fit' | 0.5 | 1 | 2 | 4;
type Backdrop = 'checker' | 'light' | 'dark';
type Mode = 'side' | 'slider';

interface Original {
  url: string;
  bytes: number;
  format: string;
  width: number;
  height: number;
}

export function PreviewModal(props: {
  items: BatchItem[];
  index: number;
  onNavigate: (index: number) => void;
  onClose: () => void;
  onDownload: (item: BatchItem) => void;
}) {
  const item = props.items[props.index]!;
  const result = item.result!;
  const [original, setOriginal] = useState<Original | null>(null);
  const [originalError, setOriginalError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [backdrop, setBackdrop] = useState<Backdrop>('checker');
  const [mode, setMode] = useState<Mode>('side');
  const [split, setSplit] = useState(0.5);
  const [showDetails, setShowDetails] = useState(false);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);

  // Widen the plugin window while comparing.
  useEffect(() => {
    postToPlugin({ type: 'RESIZE_UI', ...UI_SIZE_EXPANDED });
    return () => postToPlugin({ type: 'RESIZE_UI', ...UI_SIZE });
  }, []);

  // Load the full-resolution original on demand; release it when leaving.
  useEffect(() => {
    let url: string | undefined;
    let cancelled = false;
    setOriginal(null);
    setOriginalError(null);
    requestImageBytes(item.id)
      .then(async (bytes) => {
        if (cancelled) return;
        const format = sniffFormat(bytes);
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME_TYPES[format] }));
        const size = await imageSize(url);
        if (cancelled) return URL.revokeObjectURL(url);
        setOriginal({ url, bytes: bytes.length, format, ...size });
      })
      .catch((error: unknown) => !cancelled && setOriginalError(error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [item.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
      if (e.key === 'ArrowLeft' && props.index > 0) props.onNavigate(props.index - 1);
      if (e.key === 'ArrowRight' && props.index < props.items.length - 1) props.onNavigate(props.index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  const sameSize = original !== null && original.width === result.width && original.height === result.height;
  const effectiveMode: Mode = mode === 'slider' && sameSize ? 'slider' : 'side';

  // Keep both panes scrolled to the same spot when the images line up.
  const syncScroll = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to || !sameSize) return;
    to.scrollLeft = from.scrollLeft;
    to.scrollTop = from.scrollTop;
  };

  // Ctrl/⌘ + wheel zooms. Registered natively: React's wheel listeners are passive.
  const compareRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = compareRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const steps: Zoom[] = ['fit', 0.5, 1, 2, 4];
      setZoom((current) => {
        const index = steps.indexOf(current);
        return steps[Math.max(0, Math.min(steps.length - 1, index + (e.deltaY < 0 ? 1 : -1)))]!;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const imageStyle = (w: number, h: number): CSSProperties =>
    zoom === 'fit' ? { maxWidth: '100%', maxHeight: '100%' } : { width: w * zoom, height: h * zoom, maxWidth: 'none' };

  const navigable = props.items.map((it, i) => ({ it, i })).filter(({ it }) => it.result);
  const position = navigable.findIndex(({ i }) => i === props.index);
  const go = (delta: number) => {
    const target = navigable[position + delta];
    if (target) props.onNavigate(target.i);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Preview ${item.name}`}>
      <header className="modal__header">
        <div className="modal__nav">
          <button type="button" className="icon-button" disabled={position <= 0} onClick={() => go(-1)} title="Previous (←)">
            <IconArrowLeft />
          </button>
          <span className="modal__title" title={item.name}>
            {item.name}
          </span>
          <button type="button" className="icon-button" disabled={position >= navigable.length - 1} onClick={() => go(1)} title="Next (→)">
            <IconArrowRight />
          </button>
        </div>
        <div className="modal__tools">
          <div className="segmented" role="group" aria-label="Comparison mode">
            <button type="button" className={effectiveMode === 'side' ? 'is-active' : ''} onClick={() => setMode('side')}>
              Side by side
            </button>
            <button
              type="button"
              className={effectiveMode === 'slider' ? 'is-active' : ''}
              disabled={!sameSize}
              title={sameSize ? 'Drag to compare' : 'Available when dimensions are unchanged'}
              onClick={() => setMode('slider')}
            >
              Slider
            </button>
          </div>
          <select className="mini-select" value={String(zoom)} onChange={(e) => setZoom(e.target.value === 'fit' ? 'fit' : (Number(e.target.value) as Zoom))} aria-label="Zoom">
            <option value="fit">Fit</option>
            <option value="0.5">50%</option>
            <option value="1">100%</option>
            <option value="2">200%</option>
            <option value="4">400%</option>
          </select>
          <select className="mini-select" value={backdrop} onChange={(e) => setBackdrop(e.target.value as Backdrop)} aria-label="Background">
            <option value="checker">Checkerboard</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          <button type="button" className="icon-button" onClick={props.onClose} title="Close (Esc)">
            <IconClose />
          </button>
        </div>
      </header>

      {effectiveMode === 'side' ? (
        <div className="compare" ref={compareRef}>
          <figure className="compare__pane">
            <figcaption>Original</figcaption>
            <div className={`compare__view backdrop--${backdrop}`} ref={leftRef} onScroll={() => syncScroll(leftRef.current, rightRef.current)}>
              {original ? (
                <img src={original.url} alt="Original" style={imageStyle(original.width, original.height)} />
              ) : (
                <span className="compare__placeholder">{originalError ?? 'Loading original…'}</span>
              )}
            </div>
            <div className="compare__stats">
              <strong>{original ? formatBytes(original.bytes) : '—'}</strong>
              <span>
                {original ? `${original.format.toUpperCase()} · ${formatDimensions(original.width, original.height)}` : ''}
              </span>
            </div>
          </figure>
          <figure className="compare__pane">
            <figcaption>Optimized</figcaption>
            <div className={`compare__view backdrop--${backdrop}`} ref={rightRef} onScroll={() => syncScroll(rightRef.current, leftRef.current)}>
              <img src={item.outputUrl} alt="Optimized" style={imageStyle(result.width, result.height)} />
            </div>
            <div className="compare__stats">
              <strong>{formatBytes(result.outputBytes)}</strong>
              <span className={result.outputBytes <= result.originalBytes ? 'positive' : 'negative'}>
                {formatChange(result.originalBytes, result.outputBytes)}
              </span>
              <span>
                {result.format.toUpperCase()} · {formatDimensions(result.width, result.height)}
              </span>
            </div>
          </figure>
        </div>
      ) : (
        <div className="compare compare--slider" ref={compareRef}>
          <div
            className={`slider-view backdrop--${backdrop}`}
            onPointerMove={(e) => {
              if (e.buttons !== 1) return;
              const rect = e.currentTarget.getBoundingClientRect();
              setSplit(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
            }}
            onPointerDown={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setSplit(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
            }}
          >
            <div className="slider-view__stack" style={zoom === 'fit' ? undefined : { width: result.width * zoom, height: result.height * zoom }}>
              <img src={item.outputUrl} alt="Optimized" className="slider-view__img" />
              <img
                src={original!.url}
                alt="Original"
                className="slider-view__img slider-view__img--top"
                style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}
              />
              <div className="slider-view__handle" style={{ left: `${split * 100}%` }} />
            </div>
            <span className="slider-view__label slider-view__label--left">Original · {formatBytes(original!.bytes)}</span>
            <span className="slider-view__label slider-view__label--right">
              Optimized · {formatBytes(result.outputBytes)} ({formatChange(result.originalBytes, result.outputBytes)})
            </span>
          </div>
        </div>
      )}

      <footer className="modal__footer">
        <div className="metrics">
          <span title="Weighted Y/Cb/Cr SSIM; 1.0 = identical">SSIM {formatMetric(result.metrics.ssim)}</span>
          <span title="1st percentile of local SSIM — catches localised artefacts">Worst block {formatMetric(result.metrics.worstBlockSsim, 3)}</span>
          <span>PSNR {formatMetric(result.metrics.psnr, 1)} dB</span>
          <span className="metrics__encoder" title={result.encoderSettings}>
            {result.encoderSettings}
          </span>
          <button type="button" className="link" onClick={() => setShowDetails(!showDetails)}>
            {showDetails ? 'Hide details' : 'Details'}
          </button>
        </div>
        <button type="button" className="button button--secondary" onClick={() => props.onDownload(item)}>
          <IconDownload /> Download
        </button>
      </footer>

      {showDetails && (
        <div className="details">
          <div className="details__col">
            <h4>Pipeline</h4>
            <ul>
              <li>Content: {result.analysis.contentType}{result.analysis.hasAlpha ? `, alpha (${result.analysis.alphaKind})` : ', opaque'}</li>
              <li>Background removed: {result.backgroundRemoved ? 'yes' : 'no'}</li>
              <li>Cropped: {result.cropped ? 'yes' : 'no'} · Resized: {result.resized ? 'yes' : 'no'}</li>
              <li>
                Time:{' '}
                {Object.entries(result.timings)
                  .map(([k, v]) => `${k} ${v} ms`)
                  .join(', ')}
              </li>
            </ul>
            {result.warnings.length > 0 && (
              <>
                <h4>Notes</h4>
                <ul className="warnings">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <div className="details__col">
            <h4>Measured candidates</h4>
            <table className="candidates">
              <thead>
                <tr>
                  <th>Encoder</th>
                  <th>Size</th>
                  <th>SSIM</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...result.candidates]
                  .sort((a, b) => a.bytes - b.bytes)
                  .map((c) => (
                    <tr key={c.variant} className={c.settings === result.encoderSettings ? 'is-chosen' : ''}>
                      <td title={c.settings}>{c.variant}</td>
                      <td>{formatBytes(c.bytes)}</td>
                      <td>{formatMetric(c.metrics.ssim)}</td>
                      <td title={c.pruned ? 'Stopped early: could not beat the smallest result' : c.passed ? 'Meets the quality target' : 'Below the quality target'}>
                        {c.pruned ? 'pruned' : c.passed ? '✓' : '✗'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function imageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('The original image could not be displayed'));
    img.src = url;
  });
}
