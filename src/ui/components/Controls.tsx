import { useId, useState, type ReactNode } from 'react';
import { IconChevron } from './Icons';

export function Section(props: { title: string; children: ReactNode; aside?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <section className="section">
      <header className="section__header">
        <button type="button" className="section__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <IconChevron className={open ? 'chevron chevron--open' : 'chevron'} />
          <span className="section__title">{props.title}</span>
        </button>
        {props.aside}
      </header>
      {open && <div className="section__body">{props.children}</div>}
    </section>
  );
}

export function Checkbox(props: { label: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; hint?: string }) {
  const id = useId();
  return (
    <label className={`checkbox${props.disabled ? ' is-disabled' : ''}`} htmlFor={id} title={props.hint}>
      <input
        id={id}
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="checkbox__box" aria-hidden="true" />
      <span className="checkbox__label">{props.label}</span>
    </label>
  );
}

export function NumberField(props: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    setDraft(null);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, Math.round(parsed)));
    props.onChange(clamped);
  };
  return (
    <div className={`field${props.disabled ? ' is-disabled' : ''}`}>
      <label htmlFor={id} className="field__label">
        {props.label}
      </label>
      <div className="field__control">
        <input
          id={id}
          className="input"
          type="number"
          inputMode="numeric"
          value={draft ?? String(props.value)}
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          disabled={props.disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
          }}
        />
        {props.suffix && <span className="field__suffix">{props.suffix}</span>}
      </div>
    </div>
  );
}

export function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={`field${props.disabled ? ' is-disabled' : ''}`}>
      <label htmlFor={id} className="field__label">
        {props.label}
      </label>
      <div className="field__control select">
        <select id={id} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value as T)}>
          {props.options.map((o) => (
            <option key={o.value} value={o.value} title={o.hint}>
              {o.label}
            </option>
          ))}
        </select>
        <IconChevron className="select__chevron" />
      </div>
    </div>
  );
}

export function Slider(props: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className={`field${props.disabled ? ' is-disabled' : ''}`}>
      <label htmlFor={id} className="field__label">
        {props.label}
      </label>
      <div className="field__control slider">
        <input
          id={id}
          type="range"
          min={props.min}
          max={props.max}
          value={props.value}
          disabled={props.disabled}
          onChange={(e) => props.onChange(Number(e.target.value))}
        />
        <span className="slider__value">{props.value}</span>
      </div>
    </div>
  );
}
