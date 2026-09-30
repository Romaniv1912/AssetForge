import type { BatchItem } from '../hooks/useBatch';
import { formatBytes, formatChange, formatDimensions, formatSaved, STAGE_LABELS } from '../lib/format';
import { IconAlert, IconCheck, IconDownload, IconEye, IconRetry } from './Icons';

export function BatchSummary({ items }: { items: BatchItem[] }) {
  const completed = items.filter((i) => i.status === 'completed' && i.result);
  const failed = items.filter((i) => i.status === 'failed').length;
  const original = completed.reduce((n, i) => n + i.result!.originalBytes, 0);
  const output = completed.reduce((n, i) => n + i.result!.outputBytes, 0);
  return (
    <div className="summary">
      <div className="summary__title">
        {items.length} image{items.length === 1 ? '' : 's'}
        {failed > 0 && <span className="badge badge--error">{failed} failed</span>}
      </div>
      <dl className="summary__grid">
        <dt>Original</dt>
        <dd>{completed.length ? formatBytes(original) : '—'}</dd>
        <dt>Optimized</dt>
        <dd>{completed.length ? formatBytes(output) : '—'}</dd>
        <dt>Saved</dt>
        <dd className={output <= original ? 'positive' : 'negative'}>{completed.length ? formatSaved(original, output) : '—'}</dd>
      </dl>
    </div>
  );
}

export function ResultRow(props: {
  item: BatchItem;
  onPreview: () => void;
  onDownload: () => void;
  onRetry: () => void;
}) {
  const { item } = props;
  const r = item.result;
  return (
    <li className={`result result--${item.status}`}>
      <button type="button" className="result__thumb checker" onClick={props.onPreview} disabled={!r} aria-label={`Preview ${item.name}`}>
        {item.outputUrl ? <img src={item.outputUrl} alt="" /> : item.sourcePreviewUrl ? <img src={item.sourcePreviewUrl} alt="" /> : null}
      </button>
      <div className="result__body">
        <div className="result__name" title={item.name}>
          {item.name}
        </div>
        {r ? (
          <>
            <div className="result__sizes">
              {formatBytes(r.originalBytes)} → <strong>{formatBytes(r.outputBytes)}</strong>
              <span className={`result__delta ${r.outputBytes <= r.originalBytes ? 'positive' : 'negative'}`}>
                {formatChange(r.originalBytes, r.outputBytes)}
              </span>
            </div>
            <div className="result__meta">
              <span className="badge">{r.format.toUpperCase()}</span>
              <span>{formatDimensions(r.width, r.height)}</span>
              <span title="Structural similarity to the processed source">SSIM {r.metrics.ssim.toFixed(3)}</span>
              {item.applied && (
                <span className="badge badge--ok">
                  <IconCheck /> {item.applied === 'replace' ? 'Replaced' : 'Inserted'}
                </span>
              )}
            </div>
            {r.warnings.length > 0 && (
              <div className="result__note" title={r.warnings.join('\n')}>
                <IconAlert /> {r.warnings[0]}
                {r.warnings.length > 1 ? ` (+${r.warnings.length - 1})` : ''}
              </div>
            )}
            {item.applyError && <div className="result__error">{item.applyError}</div>}
          </>
        ) : item.status === 'failed' ? (
          <div className="result__error">
            <IconAlert /> {item.error}
          </div>
        ) : (
          <div className="result__status">
            {item.status === 'processing'
              ? `${item.stage ? STAGE_LABELS[item.stage] : 'Starting'}${item.stageDetail ? ` — ${item.stageDetail}` : ''}`
              : item.status === 'cancelled'
                ? 'Cancelled'
                : 'Pending'}
          </div>
        )}
      </div>
      <div className="result__actions">
        <StatusBadge item={item} />
        {r && (
          <>
            <button type="button" className="icon-button" onClick={props.onPreview} title="Preview">
              <IconEye />
            </button>
            <button type="button" className="icon-button" onClick={props.onDownload} title="Download">
              <IconDownload />
            </button>
          </>
        )}
        {(item.status === 'failed' || item.status === 'cancelled') && (
          <button type="button" className="icon-button" onClick={props.onRetry} title="Retry">
            <IconRetry />
          </button>
        )}
      </div>
    </li>
  );
}

function StatusBadge({ item }: { item: BatchItem }) {
  const labels = { pending: 'Pending', processing: 'Processing', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };
  return <span className={`status status--${item.status}`}>{labels[item.status]}</span>;
}
