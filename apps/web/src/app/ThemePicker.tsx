import type { ReactNode } from 'react';
import { RadioGroup } from '../primitives';
import { type StyleChoice, type ThemeChoice, useThemeStore } from './theme-store';

interface Option<T> {
  id: T;
  label: string;
  description: string;
}

const MODE_OPTIONS: Option<ThemeChoice>[] = [
  { id: 'system', label: 'System', description: 'Follows your device' },
  { id: 'light', label: 'Light', description: 'Always light' },
  { id: 'dark', label: 'Dark', description: 'Always dark' },
];

const STYLE_OPTIONS: Option<StyleChoice>[] = [
  { id: 'spectrum', label: 'Spectrum', description: 'Neutral grays, blue accent' },
  { id: 'classic', label: 'Classic', description: 'Paper when light, Noir when dark' },
];

/**
 * A compact sample of one scheme in one style: canvas, accent and status inks. Half-width
 * samples show two dots so they stay round on a phone.
 */
function SchemeSample({
  scheme,
  style,
  compact,
}: {
  scheme: 'light' | 'dark';
  style: StyleChoice;
  compact: boolean;
}) {
  return (
    <div
      className={`ok-scheme-${scheme} ok-style-${style} flex min-w-0 flex-col gap-1.5 bg-canvas p-2`}
      aria-hidden="true"
    >
      <div className="flex items-center gap-1.5">
        <span className={`h-4 shrink-0 rounded-full bg-accent ${compact ? 'w-5' : 'w-8'}`} />
        <span className="h-3 min-w-0 flex-1 rounded bg-sunken" />
      </div>
      <div className="flex gap-1">
        <span className="size-2.5 shrink-0 rounded-full bg-info-fg" />
        {compact ? null : <span className="size-2.5 shrink-0 rounded-full bg-notice-fg" />}
        <span className="size-2.5 shrink-0 rounded-full bg-positive-fg" />
        {compact ? null : <span className="size-2.5 shrink-0 rounded-full bg-negative-fg" />}
      </div>
    </div>
  );
}

/** One sample frame: the listed schemes side by side in one style. */
function Sample({ schemes, style }: { schemes: ('light' | 'dark')[]; style: StyleChoice }) {
  return (
    <div className="grid overflow-hidden rounded-ok border border-border [grid-template-columns:repeat(auto-fit,minmax(0,1fr))]">
      {schemes.map((scheme) => (
        <SchemeSample key={scheme} scheme={scheme} style={style} compact={schemes.length > 1} />
      ))}
    </div>
  );
}

function schemesFor(mode: ThemeChoice): ('light' | 'dark')[] {
  return mode === 'system' ? ['light', 'dark'] : [mode];
}

function cards<T extends string>(options: Option<T>[], sample: (id: T) => ReactNode) {
  return options.map((option) => ({
    id: option.id,
    label: option.label,
    content: (
      <>
        {sample(option.id)}
        <div>
          <p className="text-sm font-bold text-fg-strong">{option.label}</p>
          <p className="text-xs text-fg-muted">{option.description}</p>
        </div>
      </>
    ),
  }));
}

/**
 * Appearance control for Settings → Appearance (DESIGN.md §4.5): Mode (System, Light,
 * Dark) × Style (Spectrum, Classic = Paper in light and Noir in dark), shown as compact
 * sample cards. Mode samples show the current style; Style samples show the schemes the
 * current mode can show. The choice persists locally and restores on reload (see
 * `theme-store`). Each sample pins its own scheme and style, so it stays accurate
 * whatever the page currently shows.
 */
export function ThemePicker() {
  const theme = useThemeStore((s) => s.theme);
  const style = useThemeStore((s) => s.style);
  const setTheme = useThemeStore((s) => s.setTheme);
  const setStyle = useThemeStore((s) => s.setStyle);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h3 id="appearance-mode" className="text-sm font-bold text-fg-strong">
          Mode
        </h3>
        <RadioGroup
          aria-labelledby="appearance-mode"
          value={theme}
          onChange={(value) => setTheme(value as ThemeChoice)}
          look="cards"
          className="grid grid-cols-3 gap-3"
          items={cards(MODE_OPTIONS, (mode) => <Sample schemes={schemesFor(mode)} style={style} />)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <h3 id="appearance-style" className="text-sm font-bold text-fg-strong">
          Style
        </h3>
        <RadioGroup
          aria-labelledby="appearance-style"
          value={style}
          onChange={(value) => setStyle(value as StyleChoice)}
          look="cards"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3"
          items={cards(STYLE_OPTIONS, (id) => <Sample schemes={schemesFor(theme)} style={id} />)}
        />
      </div>
    </div>
  );
}
