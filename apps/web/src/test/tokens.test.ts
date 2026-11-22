import { describe, expect, it } from 'vitest';
import generatedCss from '../styles/spectrum.generated.css?raw';
import tokensCss from '../styles/tokens.css?raw';

/**
 * Token bridge (DESIGN.md §4, rebuild-stack token-bridge contract, WEB-UX A1).
 * Values come only from `@adobe/spectrum-tokens` through spectrum.generated.css
 * (staleness: apps/web/test/spectrum-tokens.test.ts). These checks assert that every semantic
 * role maps onto a generated Spectrum token, that no hand-made theme remains, and
 * that text roles keep WCAG AA contrast in both color schemes.
 */

/** Declarations of the first `:root { ... }` block in a stylesheet. */
function rootDeclarations(css: string): Map<string, string> {
  const body = /(?:^|\n):root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const declarations = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1]!, match[2]!.replace(/\s+/g, ' ').trim());
  }
  return declarations;
}

const spectrum = rootDeclarations(generatedCss);
const roles = rootDeclarations(tokensCss);

type Scheme = 'light' | 'dark';

/** Declarations of the block that opens with `selector {`. */
function blockDeclarations(css: string, selector: RegExp): Map<string, string> {
  const body = new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  return new Map(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1]!,
      match[2]!.replace(/\s+/g, ' ').trim(),
    ])
  );
}

/** Classic (Paper / Noir) overrides and the Spectrum preview pin (A3b). */
const classicOverrides = blockDeclarations(
  tokensCss,
  /:root\[data-style="classic"\],\s*\.ok-style-classic/
);
const spectrumPin = blockDeclarations(tokensCss, /\n\.ok-style-spectrum/);
const classicRoles = new Map([...roles, ...classicOverrides]);

/** Resolves a semantic role to its literal value in one scheme. */
function resolveRole(role: string, scheme: Scheme, map: Map<string, string> = roles): string {
  const value = map.get(role);
  if (!value) throw new Error(`Missing role ${role}`);
  const reference = /^var\((--s2-[\w-]+)\)$/.exec(value)?.[1];
  if (!reference) throw new Error(`${role} is not a direct Spectrum reference: ${value}`);
  const literal = spectrum.get(reference);
  if (!literal) throw new Error(`${role} references missing ${reference}`);
  const pair = /^light-dark\(([^,]+), ([^)]+)\)$/.exec(literal);
  return pair ? (scheme === 'light' ? pair[1]! : pair[2]!) : literal;
}

/** WCAG relative luminance of a `#rrggbb` color. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** WCAG contrast ratio between two `#rrggbb` colors. */
function contrast(foreground: string, background: string): number {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (high! + 0.05) / (low! + 0.05);
}

/** Semantic roles every component may use; each must resolve in both schemes. */
const SEMANTIC_ROLES = [
  '--accent-background-color-default',
  '--accent-background-color-hover',
  '--accent-background-color-down',
  '--accent-content-color-default',
  '--text-color-on-accent',
  '--text-color-on-negative',
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
  '--disabled-background-color',
  '--disabled-content-color',
  '--disabled-border-color',
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
  '--negative-background-color-default',
  '--negative-background-color-hover',
  '--ok-diff-add',
  '--ok-diff-del',
  '--ok-toast-bg',
  '--ok-toast-fg',
  '--ok-voice-fact',
  '--ok-voice-generated',
  '--ok-attention-dot',
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
];

/** Text-on-surface pairs that must reach 4.5:1 in both schemes (WCAG AA body text). */
const TEXT_PAIRS: [string, string][] = [
  ['--text-color-default', '--surface-page'],
  ['--text-color-default', '--surface-card'],
  ['--text-color-default', '--surface-sunken'],
  ['--text-color-primary', '--surface-page'],
  ['--text-color-secondary', '--surface-page'],
  ['--text-color-secondary', '--surface-sunken'],
  ['--accent-content-color-default', '--surface-page'],
  ['--text-color-on-accent', '--accent-background-color-default'],
  ['--text-color-on-accent', '--accent-background-color-hover'],
  ['--text-color-on-negative', '--negative-background-color-default'],
  ['--text-color-on-negative', '--negative-background-color-hover'],
  ['--text-color-on-primary', '--primary-background-color-default'],
  ['--text-color-on-primary', '--primary-background-color-hover'],
  ['--text-color-default', '--secondary-background-color-default'],
  ['--text-color-default', '--secondary-background-color-hover'],
  ['--ok-negative-fg', '--surface-page'],
  ['--ok-informative-fg', '--ok-informative-bg'],
  ['--ok-notice-fg', '--ok-notice-bg'],
  ['--ok-positive-fg', '--ok-positive-bg'],
  ['--ok-negative-fg', '--ok-negative-bg'],
  ['--ok-neutral-fg', '--ok-neutral-bg'],
  ['--ok-diff-add', '--surface-page'],
  ['--ok-diff-del', '--surface-page'],
  ['--ok-toast-fg', '--ok-toast-bg'],
  ['--ok-voice-fact', '--surface-page'],
  ['--ok-voice-generated', '--surface-page'],
  ['--ok-worker-scout-fg', '--ok-worker-scout-bg'],
  ['--ok-worker-quill-fg', '--ok-worker-quill-bg'],
  ['--ok-worker-ledger-fg', '--ok-worker-ledger-bg'],
  ['--ok-worker-pixel-fg', '--ok-worker-pixel-bg'],
  ['--ok-worker-you-fg', '--ok-worker-you-bg'],
];

describe('token bridge — one theme, two schemes', () => {
  it('follows the OS by default and honours the stored Light or Dark override', () => {
    expect(tokensCss).toMatch(/:root\s*\{\s*color-scheme: light dark;/);
    expect(tokensCss).toMatch(/:root\[data-color-scheme="light"\]\s*\{\s*color-scheme: light;/);
    expect(tokensCss).toMatch(/:root\[data-color-scheme="dark"\]\s*\{\s*color-scheme: dark;/);
  });

  it('keeps no hand-made theme scope', () => {
    expect(tokensCss).not.toMatch(/\.ok-theme-/);
  });
});

describe('token bridge — every role comes from the Spectrum package', () => {
  for (const role of SEMANTIC_ROLES) {
    it(`${role} maps to a generated Spectrum token`, () => {
      for (const scheme of ['light', 'dark'] as const) {
        expect(resolveRole(role, scheme)).toMatch(/^#[0-9a-f]{6}$/);
      }
    });
  }

  it('declares no color literal in the semantic layer', () => {
    const body = /(?:^|\n):root\s*\{([^}]*)\}/.exec(tokensCss)?.[1] ?? '';
    const colorDeclarations = body
      .split(';')
      .filter((line) => /--(?!ok-shadow)[\w-]+\s*:/.test(line));
    for (const declaration of colorDeclarations) {
      expect(declaration, declaration.trim()).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });

  it('anchors the Spectrum 2 accent and canvas in both schemes', () => {
    expect(resolveRole('--accent-background-color-default', 'light')).toBe('#3b63fb');
    expect(resolveRole('--accent-background-color-default', 'dark')).toBe('#4069fd');
    expect(resolveRole('--surface-page', 'light')).toBe('#ffffff');
    expect(resolveRole('--surface-page', 'dark')).toBe('#111111');
  });
});

describe('token bridge — text contrast (WCAG AA) in both schemes', () => {
  for (const scheme of ['light', 'dark'] as const) {
    for (const [foreground, background] of TEXT_PAIRS) {
      it(`${scheme}: ${foreground} on ${background} >= 4.5:1`, () => {
        const ratio = contrast(resolveRole(foreground, scheme), resolveRole(background, scheme));
        expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

/** UI pairs that must reach 3:1 (WCAG 1.4.11): focus ring, accent fill, status dots. */
const UI_PAIRS: [string, string][] = [
  ['--focus-indicator-color', '--surface-page'],
  ['--focus-indicator-color', '--surface-card'],
  ['--focus-indicator-color', '--surface-sunken'],
  ['--accent-background-color-default', '--surface-page'],
  ['--accent-background-color-default', '--surface-card'],
  ['--ok-informative-fg', '--surface-page'],
  ['--ok-notice-fg', '--surface-page'],
  ['--ok-positive-fg', '--surface-page'],
  ['--ok-negative-fg', '--surface-page'],
  ['--ok-informative-fg', '--surface-card'],
  ['--ok-notice-fg', '--surface-card'],
  ['--ok-positive-fg', '--surface-card'],
  ['--ok-negative-fg', '--surface-card'],
];

const LOOKS = [
  ['Spectrum light', roles, 'light'],
  ['Spectrum dark', roles, 'dark'],
  ['Paper', classicRoles, 'light'],
  ['Noir', classicRoles, 'dark'],
] as const;

describe('Classic style: Paper and Noir from Spectrum 2 tokens (A3b)', () => {
  it('maps every Classic override onto a generated Classic token', () => {
    expect(classicOverrides.size).toBeGreaterThan(20);
    for (const [role, value] of classicOverrides) {
      expect(value, role).toMatch(/var\(--s2-classic-[\w-]+\)/);
      expect(value, role).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });

  it('pins Spectrum back on every role Classic overrides', () => {
    expect([...spectrumPin.keys()].sort()).toEqual([...classicOverrides.keys()].sort());
    for (const [role, value] of spectrumPin) {
      const tidy = (css: string) => css.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
      if (roles.has(role)) expect(tidy(value), role).toBe(tidy(roles.get(role)!));
    }
  });

  it('anchors the Paper and Noir canvas and accents', () => {
    expect(resolveRole('--surface-page', 'light', classicRoles)).toBe('#efe8de');
    expect(resolveRole('--surface-page', 'dark', classicRoles)).toBe('#14100b');
    // Spectrum green-1000 (light) and yellow-1100 (dark).
    expect(resolveRole('--accent-background-color-default', 'light', classicRoles)).toBe('#036e45');
    expect(resolveRole('--accent-background-color-default', 'dark', classicRoles)).toBe('#da9f00');
  });

  for (const [look, map, scheme] of LOOKS) {
    for (const [foreground, background] of TEXT_PAIRS) {
      it(`${look}: ${foreground} on ${background} >= 4.5:1`, () => {
        const ratio = contrast(
          resolveRole(foreground, scheme, map),
          resolveRole(background, scheme, map)
        );
        expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const [foreground, background] of UI_PAIRS) {
      it(`${look}: ${foreground} against ${background} >= 3:1`, () => {
        const ratio = contrast(
          resolveRole(foreground, scheme, map),
          resolveRole(background, scheme, map)
        );
        expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      });
    }
  }
});
