import { describe, expect, it } from 'vitest';
import tokensCss from '../styles/tokens.css?raw';

/**
 * Token-bridge parity + completeness (WP-1, DESIGN.md §4, rebuild-stack
 * token-bridge contract). The bridge is the single source that backs both the
 * Claude Design (Spectrum) side and the compiled Tailwind theme. These checks
 * assert that every semantic role resolves in every theme scope, that anchor
 * values match the Spectrum source, and that a deliberate drift is observable.
 */

type Scopes = Record<string, Record<string, string>>;

/** Parse the flat token stylesheet into `{ selector: { '--var': 'value' } }`. */
function parseScopes(css: string): Scopes {
  const scopes: Scopes = {};
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = block[1].trim().split('\n').pop()?.trim() ?? '';
    const vars: Record<string, string> = {};
    for (const v of block[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      vars[v[1]] = v[2].trim();
    }
    if (selector && Object.keys(vars).length > 0) {
      scopes[selector] = { ...scopes[selector], ...vars };
    }
  }
  return scopes;
}

const scopes = parseScopes(tokensCss);

/** Semantic roles that every theme retints (surfaces, text, accent, lines). */
const THEME_OVERRIDE_ROLES = [
  '--accent-background-color-default',
  '--accent-background-color-hover',
  '--accent-background-color-down',
  '--accent-content-color-default',
  '--text-color-on-accent',
  '--focus-indicator-color',
  '--text-color-primary',
  '--text-color-default',
  '--text-color-secondary',
  '--text-color-disabled',
  '--surface-page',
  '--surface-card',
  '--surface-sunken',
  '--background-elevated-color',
  '--background-layer-1-color',
  '--background-layer-2-color',
  '--surface-skeleton',
  '--separator-color',
  '--border-color-default',
  '--border-color-hover',
  '--border-color-strong',
  '--highlight-selected',
  '--highlight-selected-hover',
  '--overlay-hover',
  '--overlay-down',
  '--disabled-background-color',
  '--disabled-content-color',
  '--disabled-border-color',
];

/** Status + diff + toast: defined at :root, retuned for the dark (Noir) theme. */
const DARK_RETUNED_ROLES = [
  '--ok-informative-bg',
  '--ok-informative-fg',
  '--ok-notice-bg',
  '--ok-notice-fg',
  '--ok-positive-bg',
  '--ok-positive-fg',
  '--ok-negative-bg',
  '--ok-negative-fg',
  '--ok-neutral-bg',
  '--ok-neutral-fg',
  '--ok-diff-add',
  '--ok-diff-del',
  '--ok-toast-bg',
  '--ok-toast-fg',
];

/** Theme-invariant roles: declared once at :root, never overridden. */
const INVARIANT_ROLES = [
  '--ok-worker-scout-bg',
  '--ok-worker-scout-fg',
  '--ok-worker-quill-bg',
  '--ok-worker-quill-fg',
  '--ok-worker-ledger-bg',
  '--ok-worker-ledger-fg',
  '--ok-worker-pixel-bg',
  '--ok-worker-pixel-fg',
  '--ok-worker-you-bg',
  '--ok-worker-you-fg',
  '--ok-brand-1',
  '--ok-brand-2',
  '--ok-brand-3',
  '--ok-brand-4',
  '--ok-shadow-card',
  '--ok-shadow-menu',
  '--ok-shadow-modal',
  '--ok-ease',
];

describe('token bridge — scopes present', () => {
  it('defines the three themes plus the Spectrum reset', () => {
    expect(Object.keys(scopes)).toEqual(
      expect.arrayContaining([':root', '.ok-theme-spectrum', '.ok-theme-paper', '.ok-theme-noir'])
    );
  });
});

describe('token bridge — completeness', () => {
  it(':root defines every semantic, status, and theme-invariant role', () => {
    for (const role of [...THEME_OVERRIDE_ROLES, ...DARK_RETUNED_ROLES, ...INVARIANT_ROLES]) {
      expect(scopes[':root'], `:root missing ${role}`).toHaveProperty(role);
    }
  });

  it('Paper and Noir retint every theme-override role', () => {
    for (const theme of ['.ok-theme-paper', '.ok-theme-noir']) {
      for (const role of THEME_OVERRIDE_ROLES) {
        expect(scopes[theme], `${theme} missing ${role}`).toHaveProperty(role);
      }
    }
  });

  it('Noir retunes every status / diff / toast role for dark', () => {
    for (const role of DARK_RETUNED_ROLES) {
      expect(scopes['.ok-theme-noir'], `noir missing ${role}`).toHaveProperty(role);
    }
  });

  it('Paper inherits status + diff + toast from :root (not re-declared)', () => {
    for (const role of DARK_RETUNED_ROLES) {
      expect(scopes['.ok-theme-paper']).not.toHaveProperty(role);
    }
  });

  it('worker hues and the brand quad are theme-invariant (only at :root)', () => {
    for (const theme of ['.ok-theme-paper', '.ok-theme-noir']) {
      for (const role of INVARIANT_ROLES) {
        expect(scopes[theme], `${theme} must not override ${role}`).not.toHaveProperty(role);
      }
    }
  });
});

describe('token bridge — anchor values match the Spectrum source', () => {
  const anchors: [string, string, string][] = [
    // Spectrum (default light)
    [':root', '--accent-background-color-default', '#0265dc'],
    [':root', '--surface-page', '#ffffff'],
    [':root', '--text-color-default', '#222222'],
    [':root', '--ok-informative-fg', '#0054b6'],
    [':root', '--ok-positive-fg', '#00653e'],
    [':root', '--ok-negative-fg', '#b40000'],
    [':root', '--ok-worker-scout-bg', '#65dad2'],
    [':root', '--ok-worker-ledger-fg', '#4046ca'],
    [':root', '--ok-brand-1', '#0265dc'],
    // Paper
    ['.ok-theme-paper', '--accent-background-color-default', '#2e5d45'],
    ['.ok-theme-paper', '--surface-page', '#e6ddc7'],
    ['.ok-theme-paper', '--text-color-default', '#322f1e'],
    // Noir
    ['.ok-theme-noir', '--accent-background-color-default', '#c6a24c'],
    ['.ok-theme-noir', '--surface-page', '#1e1b14'],
    ['.ok-theme-noir', '--text-color-on-accent', '#1e1b14'],
    ['.ok-theme-noir', '--ok-informative-fg', '#93aac0'],
    ['.ok-theme-noir', '--ok-positive-fg', '#aec163'],
  ];

  for (const [scope, role, value] of anchors) {
    it(`${scope} ${role} = ${value}`, () => {
      expect(scopes[scope][role]).toBe(value);
    });
  }

  it('the Spectrum reset mirrors :root accent + canvas + a status anchor', () => {
    const reset = scopes['.ok-theme-spectrum'];
    expect(reset['--accent-background-color-default']).toBe('#0265dc');
    expect(reset['--surface-page']).toBe('#ffffff');
    expect(reset['--ok-positive-fg']).toBe('#00653e');
  });
});

describe('token bridge — drift is observable', () => {
  it('a deliberately drifted value fails parity', () => {
    const drifted = parseScopes(
      tokensCss.replace('--surface-page: #ffffff;', '--surface-page: #123456;')
    );
    expect(drifted[':root']['--surface-page']).not.toBe('#ffffff');
    expect(drifted[':root']['--surface-page']).toBe('#123456');
  });
});
