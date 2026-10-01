import { SEGMENTATION_MODELS } from '../../image/background-removal/models';
import { ENHANCE_MODELS, getEnhanceModelSpec } from '../../image/enhance/models';
import { PRESET_DESCRIPTIONS, PRESET_LABELS } from '../../image/compression/presets';
import type { CompressionPreset, OutputFormat, ProcessingOptions } from '../../image/types';
import { hostedUiStatus } from '../lib/hosted';
import { Checkbox, NumberField, Section, SelectField, Slider } from './Controls';

type Update = (updater: (options: ProcessingOptions) => ProcessingOptions) => void;

const FORMAT_OPTIONS: { value: OutputFormat; label: string; hint: string }[] = [
  {
    value: 'original',
    label: 'Same as original',
    hint: 'Like TinyPNG: PNG stays PNG, JPEG stays JPEG — smaller, visually identical, same dimensions',
  },
  { value: 'auto', label: 'Smallest (Auto)', hint: 'Measure every suitable encoder and keep the smallest file that meets the quality target' },
  { value: 'webp', label: 'WebP', hint: 'libwebp — lossy or lossless, with alpha' },
  { value: 'avif', label: 'AVIF', hint: 'libavif/aom — smallest files, slowest encoder' },
  { value: 'png', label: 'PNG', hint: 'Palette quantisation + oxipng, or lossless' },
  { value: 'jpeg', label: 'JPEG', hint: 'MozJPEG progressive (no transparency)' },
];

const PRESETS: CompressionPreset[] = ['maximum', 'high', 'balanced', 'small', 'custom'];

export function SettingsPanel({ options, update, disabled }: { options: ProcessingOptions; update: Update; disabled: boolean }) {
  const enhance = options.enhance;
  const enhanceModel = getEnhanceModelSpec(enhance.model);
  const bg = options.backgroundRemoval;
  const crop = options.crop;
  const resize = options.resize;
  const compression = options.compression;
  const model = SEGMENTATION_MODELS.find((m) => m.id === bg.model) ?? SEGMENTATION_MODELS[0]!;
  // The hosted-UI check finishes before React renders, so this is final.
  const cacheStatus = hostedUiStatus();

  const set = <K extends keyof ProcessingOptions>(key: K, value: Partial<ProcessingOptions[K]>) =>
    update((o) => ({ ...o, [key]: { ...o[key], ...value } }));

  return (
    <fieldset className="settings" disabled={disabled}>
      <Section title="Enhance">
        <Checkbox
          label="AI upscale (Real-ESRGAN)"
          hint="Restore detail in small or blurry images, or sharpen and clean them at the same size"
          checked={enhance.enabled}
          onChange={(enabled) => set('enhance', { enabled })}
        />
        {enhance.enabled && (
          <div className="indent">
            {ENHANCE_MODELS.length > 1 && (
              <SelectField
                label="Model"
                value={enhanceModel.id}
                options={ENHANCE_MODELS.map((m) => ({ value: m.id, label: m.label, hint: m.description }))}
                onChange={(model) => set('enhance', { model })}
              />
            )}
            <SelectField
              label="Mode"
              value={enhance.keepSize ? 'keep-size' : enhance.onlyWhenSmaller ? 'upscale-small' : 'upscale-all'}
              options={[
                {
                  value: 'upscale-small',
                  label: 'Upscale small images',
                  hint: 'Only images smaller than the Resize limits: ×4, then fitted to the limits',
                },
                { value: 'upscale-all', label: 'Upscale all images', hint: 'Every image: ×4, then fitted to the Resize limits' },
                {
                  value: 'keep-size',
                  label: 'Enhance, keep size',
                  hint: 'Same dimensions: removes JPEG artifacts and noise (does not make a blurry photo much sharper)',
                },
              ]}
              onChange={(mode) =>
                set('enhance', { keepSize: mode === 'keep-size', onlyWhenSmaller: mode === 'upscale-small' })
              }
            />
            <Checkbox
              label="Recover detail in soft images"
              hint="Images that were upscaled before (or are blurry) are first reduced to their real detail level, so the model sharpens instead of keeping the blur. Also faster."
              checked={enhance.detectSoftness !== false}
              onChange={(detectSoftness) => set('enhance', { detectSoftness })}
            />
            <p className="hint">
              {enhanceModel.label}: runs locally. {enhanceModel.performanceNote}{' '}
              {cacheStatus.hosted ? '' : `The model is downloaded once per plugin launch: ${cacheStatus.reason}. `}
              Images larger than about {Math.round(Math.sqrt(enhanceModel.maxInputPixels))}×
              {Math.round(Math.sqrt(enhanceModel.maxInputPixels))} px are skipped. AI upscaling invents plausible detail; check
              text and logos. Licence:{' '}
              {enhanceModel.license}.
            </p>
          </div>
        )}
      </Section>
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
            <p className="hint" title={cacheStatus.hosted ? undefined : cacheStatus.reason}>
              Runs locally — images never leave your computer. {model.performanceNote ?? ''}{' '}
              {cacheStatus.hosted
                ? 'The model is downloaded once and cached between launches.'
                : `The model is downloaded once per plugin launch: ${cacheStatus.reason}.`}{' '}
              Licence: {model.license}
              {model.commercialUse === 'requires-agreement' && (
                <>
                  {' '}
                  — <strong>commercial use needs an agreement with the model owner</strong>
                </>
              )}
              .
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
        {compression.format === 'original' && (
          <p className="hint">
            Works like TinyPNG: PNG stays PNG (smart colour reduction), JPEG stays JPEG (MozJPEG), dimensions unchanged,
            metadata removed. Results replace Figma layers without any conversion.
          </p>
        )}
        {compression.format !== 'jpeg' && compression.format !== 'avif' && compression.preset !== 'custom' && (
          <Checkbox
            label="Keep 256 colours"
            hint="Palette images use a full 256-colour palette instead of the smallest one that passes — like sharp/pngquant defaults. Slightly larger, safest for gradients."
            checked={compression.fullPalette ?? false}
            onChange={(fullPalette) => set('compression', { fullPalette })}
          />
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
