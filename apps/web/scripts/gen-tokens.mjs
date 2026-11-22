/**
 * Spectrum 2 token generator (WEB-UX A1, DESIGN.md §4).
 *
 * Reads the resolved Spectrum 2 data from `@adobe/spectrum-tokens` and writes
 * `src/styles/spectrum.generated.css`: one `--s2-<name>` custom property per
 * allowlisted color token, as `light-dark(<light>, <dark>)` when the two schemes
 * differ, and one per allowlisted size token: desktop values at `:root`, mobile
 * values under `(pointer: coarse)`, and both again as `.ok-scale-desktop` /
 * `.ok-scale-touch` for preview-only gallery pins.
 * `src/styles/tokens.css` maps OpenKit semantic roles onto these properties; markup
 * never reads `--s2-*` directly. `--check` exits non-zero when the committed file
 * differs from this output (run by `test/spectrum-tokens.test.ts`), so a package
 * bump is: bump, run `pnpm tokens:generate`, review the gallery.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Spectrum 2 color tokens OpenKit uses, grouped as tokens.css consumes them. */
export const SPECTRUM_COLOR_TOKENS = [
  // Accent and focus
  'accent-background-color-default',
  'accent-background-color-hover',
  'accent-background-color-down',
  'accent-content-color-default',
  'focus-indicator-color',
  'white',
  // Text
  'heading-color',
  'neutral-content-color-default',
  'neutral-subdued-content-color-default',
  'disabled-content-color',
  // Surfaces
  'background-base-color',
  'background-layer-1-color',
  'background-layer-2-color',
  'background-elevated-color',
  'disabled-background-color',
  'disabled-border-color',
  // Lines, overlays and secondary fills
  'gray-100',
  'gray-200',
  'gray-300',
  'gray-400',
  'gray-800',
  'transparent-black-75',
  'transparent-black-100',
  'transparent-white-75',
  'transparent-white-100',
  // Status families: subtle background + readable ink
  'informative-subtle-background-color-default',
  'blue-1100',
  'notice-subtle-background-color-default',
  'orange-1100',
  'positive-subtle-background-color-default',
  'green-1100',
  'negative-subtle-background-color-default',
  'red-1100',
  'negative-background-color-default',
  'negative-background-color-hover',
  'neutral-subtle-background-color-default',
  'yellow-visual-color',
  // Diff ink, toast, timeline voices
  'green-1000',
  'red-1000',
  'neutral-background-color-default',
  'neutral-background-color-hover',
  'purple-1000',
  // Worker identity hues (one hue per worker, scheme-adapted steps)
  'seafoam-400',
  'seafoam-1200',
  'purple-400',
  'purple-1100',
  'indigo-400',
  'indigo-1100',
  'orange-300',
  'orange-1200',
  'blue-200',
];

/** Spectrum 2 gray steps that get a warm twin for the Classic style. */
export const WARM_GRAY_STEPS = [25, 50, 75, 100, 200, 300, 400, 500, 600, 700, 800, 900];

/**
 * Warmth of the Classic neutrals (design-system.md, A3b): each warm gray keeps the
 * OKLCH lightness of its Spectrum gray step and takes the hue of the Spectrum brown
 * ramp (`brown-700`) at this OKLCH chroma. Paper (light) is a little warmer than Noir.
 */
export const WARM_GRAY_CHROMA = { light: 0.016, dark: 0.012 };

/**
 * Classic style (engineer decision 2026-11-18): Paper in light mode, Noir in dark mode.
 * Each entry is `[Paper source, Noir source]`; a source is a Spectrum token name or a
 * `warm-gray-<step>`. Emitted as `--s2-classic-<role>: light-dark(paper, noir)`.
 * Paper: warm paper page one step below white with lighter sheets, pine-green accent
 * from the Spectrum green ramp. Noir: warm near-black layers on the Spectrum dark
 * scale, gold accent from the Spectrum yellow ramp with dark text on it.
 */
export const CLASSIC_ROLES = {
  'accent-background-color-default': ['green-1000', 'yellow-1100'],
  'accent-background-color-hover': ['green-1100', 'yellow-1200'],
  'accent-background-color-down': ['green-1200', 'yellow-1000'],
  'accent-content-color-default': ['green-1000', 'yellow-1200'],
  'text-color-on-accent': ['gray-25', 'warm-gray-25'],
  'focus-indicator-color': ['green-900', 'yellow-1200'],
  'heading-color': ['warm-gray-900', 'warm-gray-900'],
  'content-color-default': ['warm-gray-800', 'warm-gray-800'],
  'subdued-content-color-default': ['warm-gray-700', 'warm-gray-700'],
  'disabled-content-color': ['warm-gray-400', 'warm-gray-400'],
  'background-base-color': ['warm-gray-100', 'warm-gray-25'],
  'background-layer-1-color': ['warm-gray-200', 'warm-gray-50'],
  'background-layer-2-color': ['warm-gray-50', 'warm-gray-75'],
  'background-elevated-color': ['warm-gray-50', 'warm-gray-75'],
  'disabled-background-color': ['warm-gray-200', 'warm-gray-100'],
  'disabled-border-color': ['warm-gray-300', 'warm-gray-300'],
  'skeleton-color': ['warm-gray-200', 'warm-gray-200'],
  'separator-color': ['warm-gray-300', 'warm-gray-200'],
  'border-color-default': ['warm-gray-300', 'warm-gray-300'],
  'border-color-hover': ['warm-gray-400', 'warm-gray-400'],
  'border-color-strong': ['warm-gray-800', 'warm-gray-800'],
  'primary-background-color-default': ['warm-gray-800', 'warm-gray-800'],
  'primary-background-color-hover': ['warm-gray-900', 'warm-gray-900'],
  'secondary-background-color-default': ['warm-gray-200', 'warm-gray-100'],
  'secondary-background-color-hover': ['warm-gray-300', 'warm-gray-200'],
};

/** Spectrum 2 size tokens OpenKit uses (desktop / mobile scale sets). */
export const SPECTRUM_SIZE_TOKENS = [
  'component-height-75',
  'component-height-100',
  'component-height-200',
  'component-edge-to-text-75',
  'component-edge-to-text-100',
  'component-edge-to-text-200',
  'component-pill-edge-to-text-75',
  'component-pill-edge-to-text-100',
  'component-pill-edge-to-text-200',
  'font-size-75',
  'font-size-100',
  'font-size-200',
  'font-size-300',
  'font-size-500',
  'font-size-700',
  // A4: workflow icons, field and status controls, tooltip
  'workflow-icon-size-75',
  'workflow-icon-size-100',
  'workflow-icon-size-200',
  'text-to-visual-100',
  'switch-control-width-medium',
  'switch-control-height-medium',
  'switch-handle-size-medium',
  'switch-handle-selected-size-medium',
  'radio-button-control-size-medium',
  'checkbox-control-size-medium',
  'status-light-dot-size-small',
  'status-light-dot-size-medium',
  'status-light-text-to-visual-100',
  'component-height-50',
  'tooltip-maximum-width',
  'field-width',
  // A5: headings, dialog, table, tabs, progress and meter
  'heading-size-xs',
  'heading-size-m',
  'heading-size-l',
  'standard-dialog-minimum-width',
  'standard-dialog-maximum-width-small',
  'standard-dialog-maximum-width-medium',
  'standard-dialog-maximum-width-large',
  'table-row-height-medium',
  'table-edge-to-content',
  'table-item-padding-regular',
  'tab-item-compact-height-medium',
  'tab-item-to-tab-item-horizontal-medium',
  'tab-selection-indicator-thickness',
  'progress-bar-thickness-small',
  'progress-bar-thickness-medium',
  'meter-thickness-small',
  'meter-thickness-medium',
  'popover-edge-to-content-area',
];

/**
 * Resolves one token for a color scheme or platform scale. The package nests `sets` per scheme and
 * per alias (`{ref, sets: {light, dark, wireframe}}`); a scheme-less token is a value.
 *
 * @param {Record<string, unknown>} token Token node from `dist/json/variables.json`.
 * @param {'light' | 'dark' | 'desktop' | 'mobile'} scheme Color scheme or scale to resolve.
 * @returns {string} The CSS value.
 */
export function resolveToken(token, scheme) {
  if (typeof token.value === 'string') return token.value;
  const sets = /** @type {Record<string, Record<string, unknown>>} */ (token.sets);
  if (!sets) throw new Error('Spectrum token has neither value nor sets.');
  return resolveToken(sets[scheme] ?? sets.light ?? sets.desktop, scheme);
}

/**
 * Resolves every allowlisted size token for both platform scales.
 *
 * @param {Record<string, Record<string, unknown>>} variables Package `variables.json`.
 * @returns {Map<string, {desktop: string, mobile: string}>} Values by token name.
 */
export function resolveSpectrumSizes(variables) {
  const resolved = new Map();
  for (const name of SPECTRUM_SIZE_TOKENS) {
    const token = variables[name];
    if (!token) throw new Error(`Spectrum token ${name} is missing from the package.`);
    resolved.set(name, {
      desktop: resolveToken(token, 'desktop'),
      mobile: resolveToken(token, 'mobile'),
    });
  }
  return resolved;
}

/**
 * Writes `rgb(r, g, b)` as lowercase hex; other values (rgba, px) are kept.
 *
 * @param {string} value Resolved CSS value.
 * @returns {string} The compact CSS value.
 */
function compact(value) {
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value);
  if (!rgb) return value;
  return `#${rgb
    .slice(1)
    .map((channel) => Number(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * Resolves every allowlisted token to its light and dark CSS values.
 *
 * @param {Record<string, Record<string, unknown>>} variables Package `variables.json`.
 * @returns {Map<string, {light: string, dark: string}>} Values by token name.
 */
export function resolveSpectrumColors(variables) {
  const resolved = new Map();
  for (const name of SPECTRUM_COLOR_TOKENS) {
    const token = variables[name];
    if (!token) throw new Error(`Spectrum token ${name} is missing from the package.`);
    resolved.set(name, {
      light: compact(resolveToken(token, 'light')),
      dark: compact(resolveToken(token, 'dark')),
    });
  }
  return resolved;
}

/** sRGB `#rrggbb` to OKLab. */
function hexToOklab(hex) {
  const lin = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab to sRGB `#rrggbb` (clamped). */
function oklabToHex([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${lin
    .map((c) => {
      const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
}

/**
 * Warm twin of a Spectrum gray: same OKLCH lightness, Spectrum brown hue, fixed chroma.
 *
 * @param {string} gray `#rrggbb` gray value.
 * @param {string} brown `#rrggbb` brown reference for the hue.
 * @param {number} chroma OKLCH chroma.
 * @returns {string} `#rrggbb`.
 */
export function warmGray(gray, brown, chroma) {
  const [L] = hexToOklab(gray);
  const [, ba, bb] = hexToOklab(brown);
  const hue = Math.atan2(bb, ba);
  // Pure white and black stay neutral: no chroma fits at the ends of the lightness axis.
  const c = L > 0.995 || L < 0.005 ? 0 : chroma;
  return oklabToHex([L, c * Math.cos(hue), c * Math.sin(hue)]);
}

/**
 * Resolves the warm grays and the Classic role tokens.
 *
 * @param {Record<string, Record<string, unknown>>} variables Package `variables.json`.
 * @returns {{warm: Map<string, {light: string, dark: string}>, classic: Map<string, {light: string, dark: string}>}}
 */
export function resolveClassic(variables) {
  /** @param {string} name @param {'light' | 'dark'} scheme */
  const token = (name, scheme) => {
    const node = variables[name];
    if (!node) throw new Error(`Spectrum token ${name} is missing from the package.`);
    return compact(resolveToken(node, scheme));
  };
  const warm = new Map();
  for (const step of WARM_GRAY_STEPS) {
    const value = {};
    for (const scheme of /** @type {const} */ (['light', 'dark'])) {
      value[scheme] = warmGray(
        token(`gray-${step}`, scheme),
        token('brown-700', scheme),
        WARM_GRAY_CHROMA[scheme]
      );
    }
    warm.set(`warm-gray-${step}`, value);
  }
  /** @param {string} name @param {'light' | 'dark'} scheme */
  const source = (name, scheme) => warm.get(name)?.[scheme] ?? token(name, scheme);
  const classic = new Map();
  for (const [role, [paper, noir]] of Object.entries(CLASSIC_ROLES)) {
    classic.set(role, { light: source(paper, 'light'), dark: source(noir, 'dark') });
  }
  return { warm, classic };
}

/**
 * Renders the generated stylesheet.
 *
 * @param {Record<string, Record<string, unknown>>} variables Package `variables.json`.
 * @param {string} version Package version, recorded in the header.
 * @returns {string} CSS text.
 */
export function renderSpectrumCss(variables, version) {
  const lines = [...resolveSpectrumColors(variables)].map(([name, { light, dark }]) => {
    const value = light === dark ? light : `light-dark(${light}, ${dark})`;
    return `  --s2-${name}: ${value};`;
  });
  const { warm, classic } = resolveClassic(variables);
  /** @param {string} prefix @param {Map<string, {light: string, dark: string}>} map */
  const pairs = (prefix, map) =>
    [...map].map(
      ([name, { light, dark }]) => `  --s2-${prefix}${name}: light-dark(${light}, ${dark});`
    );
  lines.push(...pairs('', warm), ...pairs('classic-', classic));
  const sizes = [...resolveSpectrumSizes(variables)];
  /** @param {'desktop' | 'mobile'} scale @param {string} indent */
  const sizeLines = (scale, indent) =>
    sizes.map(([name, values]) => `${indent}--s2-${name}: ${values[scale]};`);
  return [
    `/* Generated by scripts/gen-tokens.mjs from @adobe/spectrum-tokens ${version}. Do not edit. */`,
    ':root {',
    ...lines,
    ...sizeLines('desktop', '  '),
    '}',
    '@media (pointer: coarse) {',
    '  :root {',
    ...sizeLines('mobile', '    '),
    '  }',
    '}',
    '.ok-scale-desktop {',
    ...sizeLines('desktop', '  '),
    '}',
    '.ok-scale-touch {',
    ...sizeLines('mobile', '  '),
    '}',
    '',
  ].join('\n');
}

/**
 * Loads the installed package data.
 *
 * @returns {{variables: Record<string, Record<string, unknown>>, version: string}}
 */
export function loadSpectrumPackage() {
  const require = createRequire(import.meta.url);
  const variablesPath = require.resolve('@adobe/spectrum-tokens/dist/json/variables.json');
  const root = join(dirname(variablesPath), '../..');
  return {
    variables: JSON.parse(readFileSync(variablesPath, 'utf8')),
    version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  };
}

export const GENERATED_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../src/styles/spectrum.generated.css'
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { variables, version } = loadSpectrumPackage();
  const css = renderSpectrumCss(variables, version);
  const checkAt = process.argv.indexOf('--check');
  if (checkAt !== -1) {
    // An optional path after --check compares another copy (used by the drift test).
    const target = process.argv[checkAt + 1] ?? GENERATED_PATH;
    if (readFileSync(target, 'utf8') !== css) {
      console.error(`${target} is stale. Run pnpm --filter @openkit/web tokens:generate.`);
      process.exit(1);
    }
  } else {
    writeFileSync(GENERATED_PATH, css);
    console.log(`Wrote ${GENERATED_PATH}`);
  }
}
