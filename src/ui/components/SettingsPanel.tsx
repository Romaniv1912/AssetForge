import { SEGMENTATION_MODELS } from '../../image/background-removal/models';
import { PRESET_DESCRIPTIONS, PRESET_LABELS } from '../../image/compression/presets';
import type { CompressionPreset, OutputFormat, ProcessingOptions } from '../../image/types';
import { Checkbox, NumberField, Section, SelectField, Slider } from './Controls';

type Update = (updater: (options: ProcessingOptions) => ProcessingOptions) => void;

const FORMAT_OPTIONS: { value: OutputFormat; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Measure every suitable encoder and keep the smallest file that meets the quality target' },
  { value: 'webp', label: 'WebP', hint: 'libwebp — lossy or lossless, with alpha' },
  { value: 'avif', label: 'AVIF', hint: 'libavif/aom — smallest files, slowest encoder' },
  { value: 'png', label: 'PNG', hint: 'Palette quantisation + oxipng, or lossless' },
  { value: 'jpeg', label: 'JPEG', hint: 'MozJPEG progressive (no transparency)' },
];

const PRESETS: CompressionPreset[] = ['maximum', 'high', 'balanced', 'small', 'custom'];

export function SettingsPanel({ options, update, disabled }: { options: ProcessingOptions; update: Update; disabled: boolean }) {
  const bg = options.backgroundRemoval;
  const crop = options.crop;
  const resize = options.resize;
  const compression = options.compression;
  const model = SEGMENTATION_MODELS.find((m) => m.id === bg.model) ?? SEGMENTATION_MODELS[0]!;

  const set = <K extends keyof ProcessingOptions>(key: K, value: Partial<ProcessingOptions[K]>) =>
    update((o) => ({ ...o, [key]: { ...o[key], ...value } }));

  return (
    <fieldset className="settings" disabled={disabled}>
      <Section title="Background">
        <Checkbox label="Remove background" checked={bg.enabled} onChange={(enabled) => set('backgroundRemoval', { enabled })} />
        {bg.enabled && (
          <div className="indent">
            <SelectField
              label="Model"
              value={bg.model}
              options={SEGMENTATION_MODELS.map((m) => ({ value: m.id, label: m.label, hint: m.description }))}
              onChange={(value) => set('backgroundRemoval', { model: value })}
            />
            <p className="hint">
              Runs locally — images never leave your computer. First use downloads the model (~
              {Math.round(model.approxBytes / 1e6)} MB) and ML runtime, then caches them.
              {model.commercialUse === 'requires-agreement' && (
                <>
                  {' '}
                  <strong>Licence:</strong> {model.license}; commercial use needs an agreement with the model owner.
                </>
              )}
            </p>
            <Checkbox
              label="Refine edges"
              hint="Snap the mask to real image edges (hair, fur, outlines)"
              checked={bg.refineEdges}
              onChange={(refineEdges) => set('backgroundRemoval', { refineEdges })}
            />
            <Checkbox
              label="Remove colour halos"
              hint="Re-estimate the true colour of semi-transparent edge pixels"
              checked={bg.decontaminateColors}
              onChange={(decontaminateColors) => set('backgroundRemoval', { decontaminateColors })}
            />
            <Checkbox
              label="Skip images that are already transparent"
              checked={bg.skipIfTransparent}
              onChange={(skipIfTransparent) => set('backgroundRemoval', { skipIfTransparent })}
            />
          </div>
        )}
      </Section>

      <Section title="Crop">
        <Checkbox label="Crop transparent bounds" checked={crop.enabled} onChange={(enabled) => set('crop', { enabled })} />
        {crop.enabled && (
          <div className="indent row">
            <NumberField label="Padding" suffix="px" min={0} max={512} value={crop.padding} onChange={(padding) => set('crop', { padding })} />
          </div>
        )}
      </Section>

      <Section title="Resize">
        <Checkbox label="Limit dimensions" checked={resize.enabled} onChange={(enabled) => set('resize', { enabled })} />
        {resize.enabled && (
          <div className="indent">
            <div className="row">
              <NumberField label="Max width" suffix="px" min={1} max={16384} value={resize.maxWidth} onChange={(maxWidth) => set('resize', { maxWidth })} />
              <NumberField label="Max height" suffix="px" min={1} max={16384} value={resize.maxHeight} onChange={(maxHeight) => set('resize', { maxHeight })} />
            </div>
            <Checkbox
              label="Preserve aspect ratio"
              checked={resize.preserveAspectRatio}
              onChange={(preserveAspectRatio) => set('resize', { preserveAspectRatio })}
            />
            <Checkbox label="Allow upscaling" checked={resize.allowUpscale} onChange={(allowUpscale) => set('resize', { allowUpscale })} />
          </div>
        )}
      </Section>

      <Section title="Compression">
        <div className="row">
          <SelectField label="Format" value={compression.format} options={FORMAT_OPTIONS} onChange={(format) => set('compression', { format })} />
          <SelectField
            label="Quality"
            value={compression.preset}
            options={PRESETS.map((p) => ({ value: p, label: PRESET_LABELS[p], hint: PRESET_DESCRIPTIONS[p] }))}
            onChange={(preset) => set('compression', { preset })}
          />
        </div>
        <p className="hint">{PRESET_DESCRIPTIONS[compression.preset]}</p>
        {compression.preset === 'custom' && (
          <div className="indent">
            <Checkbox
              label="Lossless"
              checked={compression.custom.lossless}
              onChange={(lossless) => set('compression', { custom: { ...compression.custom, lossless } })}
            />
            <Slider
              label="Encoder quality"
              min={1}
              max={100}
              value={compression.custom.quality}
              disabled={compression.custom.lossless}
              onChange={(quality) => set('compression', { custom: { ...compression.custom, quality } })}
            />
          </div>
        )}
        {compression.format === 'auto' && (
          <Checkbox
            label="Consider AVIF"
            hint="Often the smallest result, but encoding is several times slower"
            checked={compression.allowAvifInAuto}
            onChange={(allowAvifInAuto) => set('compression', { allowAvifInAuto })}
          />
        )}
        {(compression.format === 'webp' || compression.format === 'avif' || compression.format === 'auto') && (
          <p className="hint">
            Figma layers accept PNG/JPEG only: when applying WebP/AVIF results to the canvas, the exact optimised pixels are
            stored as PNG/JPEG. Downloads keep the chosen format.
          </p>
        )}
      </Section>
    </fieldset>
  );
}
