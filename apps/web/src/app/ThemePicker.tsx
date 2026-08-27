import { Page, PageHeader, RadioGroup } from '../primitives';
import { type ThemeName, useThemeStore } from './theme-store';

interface ThemeOption {
  id: ThemeName;
  label: string;
  description: string;
  /** Scoping class so each card previews its own look, even inside another theme. */
  previewClass: string;
}

const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'spectrum',
    label: 'Spectrum',
    description: 'Light · Spectrum blue',
    previewClass: 'ok-theme-spectrum',
  },
  {
    id: 'paper',
    label: 'Paper',
    description: 'Warm light · pine green',
    previewClass: 'ok-theme-paper',
  },
  { id: 'noir', label: 'Noir', description: 'Dark · gold', previewClass: 'ok-theme-noir' },
];

/** A compact preview: base surface + accent + a couple of status samples. */
function Preview({ previewClass }: { previewClass: string }) {
  return (
    <div
      className={`${previewClass} flex flex-col gap-1.5 rounded-ok border border-border bg-canvas p-2`}
    >
      <div className="flex items-center gap-1.5">
        <span className="h-4 w-8 rounded-full bg-accent" />
        <span className="h-3 flex-1 rounded bg-sunken" />
      </div>
      <div className="flex gap-1">
        <span className="h-2.5 w-2.5 rounded-full bg-info-fg" />
        <span className="h-2.5 w-2.5 rounded-full bg-notice-fg" />
        <span className="h-2.5 w-2.5 rounded-full bg-positive-fg" />
        <span className="h-2.5 w-2.5 rounded-full bg-negative-fg" />
      </div>
    </div>
  );
}

/**
 * Appearance — the theme picker (DESIGN.md §4.5).
 *
 * Theme choice lives here in Settings, shown as compact preview cards, never in a
 * global header. The selection persists locally and restores on reload (see
 * `theme-store`). Each card scopes its own theme class so its preview is accurate
 * even while the surrounding app is on another theme.
 */
export function ThemePicker() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <Page>
      <PageHeader
        eyebrow="Settings"
        title="Appearance"
        subtitle="Choose a color theme for OpenKit."
      />
      <RadioGroup
        aria-label="Color theme"
        value={theme}
        onChange={(value) => setTheme(value as ThemeName)}
        className="grid grid-cols-3 gap-3"
        items={THEME_OPTIONS.map((option) => ({
          id: option.id,
          label: option.label,
          content: (
            <>
              <Preview previewClass={option.previewClass} />
              <div>
                <p className="text-sm font-bold text-fg-strong">{option.label}</p>
                <p className="text-xs text-fg-muted">{option.description}</p>
              </div>
            </>
          ),
        }))}
      />
    </Page>
  );
}
