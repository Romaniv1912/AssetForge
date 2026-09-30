import { batchProgress, type BatchItem } from '../hooks/useBatch';
import { STAGE_LABELS } from '../lib/format';

export function ProgressPanel({ items }: { items: BatchItem[] }) {
  const done = items.filter((i) => i.status === 'completed' || i.status === 'failed' || i.status === 'cancelled').length;
  const active = items.filter((i) => i.status === 'processing').sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const progress = batchProgress(items);
  const current = active[0];
  const position = Math.min(items.length, done + (active.length ? 1 : 0));

  return (
    <div className="progress" role="status" aria-live="polite">
      <div className="progress__head">
        <span>
          Processing {position} / {items.length}
        </span>
        <span className="progress__pct">{Math.round(progress * 100)}%</span>
      </div>
      <div className="progress__bar">
        <div className="progress__fill" style={{ width: `${progress * 100}%` }} />
      </div>
      {current && (
        <div className="progress__current">
          <span className="progress__name">{current.name}</span>
          <span className="progress__stage">
            {current.stage ? STAGE_LABELS[current.stage] : 'Waiting'}
            {current.stageDetail ? ` — ${current.stageDetail}` : '…'}
          </span>
          {active.length > 1 && <span className="progress__more">+{active.length - 1} more in parallel</span>}
        </div>
      )}
    </div>
  );
}
