import { useCallback, useMemo, useState } from 'react';
import type { ProcessingOptions } from '../image/types';
import { PLUGIN_NAME } from '../shared/constants';
import type { ApplyMode } from '../shared/types';
import { Checkbox } from './components/Controls';
import { IconLogo } from './components/Icons';
import { PreviewModal } from './components/PreviewModal';
import { ProgressPanel } from './components/ProgressPanel';
import { BatchSummary, ResultRow } from './components/ResultsPanel';
import { SelectionSummary } from './components/SelectionSummary';
import { SettingsPanel } from './components/SettingsPanel';
import { useBackend } from './hooks/useBackend';
import { useBatch, type BatchItem } from './hooks/useBatch';
import { usePlugin } from './hooks/usePlugin';
import { postToPlugin } from './lib/bridge';
import { downloadOriginals } from './outputs/originals';
import { DownloadSink, ZipDownloadSink, type OutputAsset } from './outputs/sinks';

type Tab = 'settings' | 'results';

function toAsset(item: BatchItem): OutputAsset {
  const r = item.result!;
  return { id: item.id, baseName: item.name, data: r.data, format: r.format, mimeType: r.mimeType, width: r.width, height: r.height };
}

export function App() {
  const { selection, options, setOptions, ready } = usePlugin();
  const { backend, error: backendError } = useBackend();
  const { state, start, retry, cancel, clear, apply } = useBatch(backend);
  const [tab, setTab] = useState<Tab>('settings');
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [matchAspect, setMatchAspect] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const update = useCallback((updater: (o: ProcessingOptions) => ProcessingOptions) => setOptions(updater), [setOptions]);

  const completed = useMemo(() => state.items.filter((i) => i.status === 'completed' && i.result), [state.items]);
  const failed = useMemo(() => state.items.filter((i) => i.status === 'failed' || i.status === 'cancelled'), [state.items]);
  const imageCount = selection.images.length;

  const process = () => {
    start(selection.images, options);
    setTab('results');
  };

  const download = (items: BatchItem[]) => {
    if (items.length === 0) return;
    const assets = items.map(toAsset);
    const sink = assets.length === 1 ? new DownloadSink() : new ZipDownloadSink();
    void sink.deliver(assets).catch((e: unknown) => postToPlugin({ type: 'NOTIFY', message: `Download failed: ${String(e)}`, error: true }));
  };

  const [downloadingOriginals, setDownloadingOriginals] = useState(false);
  const saveOriginals = async () => {
    setDownloadingOriginals(true);
    setBusy('Reading original files from Figma…');
    try {
      const { failed } = await downloadOriginals(selection.images, (done, total) =>
        setBusy(`Reading original files from Figma… ${done}/${total}`),
      );
      if (failed.length) postToPlugin({ type: 'NOTIFY', message: `Skipped ${failed.length}: ${failed.join('; ')}`, error: true });
    } catch (e: unknown) {
      postToPlugin({ type: 'NOTIFY', message: `Download failed: ${e instanceof Error ? e.message : String(e)}`, error: true });
    } finally {
      setBusy(null);
      setDownloadingOriginals(false);
    }
  };

  const applyAll = async (mode: ApplyMode) => {
    setBusy(mode === 'replace' ? 'Replacing images in Figma…' : 'Inserting optimized layers…');
    try {
      await apply(mode, matchAspect);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="app">
      <header className="app__header">
        <div className="brand">
          <IconLogo />
          <span>{PLUGIN_NAME}</span>
        </div>
        <nav className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'is-active' : ''} onClick={() => setTab('settings')}>
            Settings
          </button>
          <button type="button" role="tab" aria-selected={tab === 'results'} className={tab === 'results' ? 'is-active' : ''} onClick={() => setTab('results')}>
            Results{state.items.length ? ` (${state.items.length})` : ''}
          </button>
        </nav>
      </header>

      <main className="app__body">
        {tab === 'settings' ? (
          <>
            <SelectionSummary selection={selection} onDownloadOriginals={() => void saveOriginals()} downloading={downloadingOriginals} />
            <SettingsPanel options={options} update={update} disabled={state.running || !ready} />
          </>
        ) : state.items.length === 0 ? (
          <div className="empty">
            <p>No results yet.</p>
            <p className="hint">Select images in Figma and press “Process images”.</p>
          </div>
        ) : (
          <>
            {state.running && <ProgressPanel items={state.items} />}
            <BatchSummary items={state.items} />
            <ul className="results">
              {state.items.map((item, index) => (
                <ResultRow
                  key={item.id}
                  item={item}
                  onPreview={() => item.result && setPreviewIndex(index)}
                  onDownload={() => download([item])}
                  onRetry={() => retry([item.id])}
                />
              ))}
            </ul>
          </>
        )}
        {backendError && <div className="banner banner--error">Processing engine failed to start: {backendError}</div>}
        {backend?.kind === 'inline' && (
          <div className="banner">Background workers are unavailable here; processing runs on the UI thread and may be slower.</div>
        )}
      </main>

      <footer className="app__footer">
        {busy && <div className="footer__busy">{busy}</div>}
        {tab === 'results' && completed.length > 0 && !state.running && (
          <div className="footer__secondary">
            <Checkbox label="Match layer aspect ratio" checked={matchAspect} onChange={setMatchAspect} hint="Resize replaced layers when cropping/resizing changed the image proportions" />
            <div className="button-row">
              <button type="button" className="button button--secondary" disabled={!!busy} onClick={() => void applyAll('replace')} title="Swap the original image fills for the optimized images">
                Replace in Figma
              </button>
              <button type="button" className="button button--secondary" disabled={!!busy} onClick={() => void applyAll('insert')} title="Add the optimized images as new layers next to the originals">
                Insert copies
              </button>
              <button type="button" className="button button--secondary" onClick={() => download(completed)}>
                {completed.length === 1 ? 'Download' : 'Download ZIP'}
              </button>
            </div>
          </div>
        )}
        <div className="footer__primary">
          {state.running ? (
            <button type="button" className="button button--danger button--wide" onClick={cancel}>
              Cancel
            </button>
          ) : (
            <>
              {tab === 'results' && failed.length > 0 && (
                <button type="button" className="button button--secondary" onClick={() => retry(failed.map((f) => f.id))}>
                  Retry failed ({failed.length})
                </button>
              )}
              {tab === 'results' && state.items.length > 0 && (
                <button type="button" className="button button--ghost" onClick={clear}>
                  Clear
                </button>
              )}
              <button type="button" className="button button--primary button--wide" disabled={!backend || imageCount === 0 || !ready} onClick={process}>
                {!backend ? 'Starting engine…' : imageCount === 0 ? 'Select images to process' : `Process ${imageCount} image${imageCount === 1 ? '' : 's'}`}
              </button>
            </>
          )}
        </div>
      </footer>

      {previewIndex !== null && state.items[previewIndex]?.result && (
        <PreviewModal
          items={state.items}
          index={previewIndex}
          onNavigate={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
          onDownload={(item) => download([item])}
        />
      )}
    </div>
  );
}
