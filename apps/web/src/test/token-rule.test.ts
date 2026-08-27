import { describe, expect, it } from 'vitest';

/**
 * No-raw-palette / no-hard-coded-literal rule (WP-1, DESIGN.md §4.4,
 * rebuild-stack token-bridge contract). Component markup must reference the
 * bridge-produced semantic utilities only — never a raw Spectrum global token
 * (`--spectrum-*`), a hard-coded hex color, or a Tailwind arbitrary color/radius
 * literal. This test both proves the scanner catches violations (fixtures) and
 * asserts the component tiers are clean.
 *
 * Scope note: the scan covers the primitive, screen, and app-shell tiers — every
 * layer that emits component markup. Layout dimensions (`w-[264px]`,
 * `max-w-[760px]`, `size-[22px]`, the 800x600 floor) are structural constants
 * from DESIGN.md §3/§12, not palette/type/spacing-scale values, so they are not
 * flagged; padding/margin/gap use the Tailwind 4-based scale (= the §6 ramp).
 */

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'raw Spectrum global token', re: /--spectrum-[\w-]+/ },
  { name: 'hard-coded hex color', re: /#[0-9a-fA-F]{3,8}\b/ },
  {
    name: 'Tailwind arbitrary color literal',
    re: /\b(?:bg|text|border|fill|stroke|ring|shadow|from|to|via)-\[#/,
  },
  { name: 'ad-hoc radius literal', re: /\brounded(?:-[a-z]+)?-\[/ },
  // Type ramp (DESIGN.md §5): font-size/tracking/leading come from bridge tokens.
  // `text-[color:var(--…)]` is a semantic color reference and stays allowed.
  { name: 'ad-hoc font-size literal', re: /\btext-\[(?!color:)/ },
  { name: 'ad-hoc tracking literal', re: /\btracking-\[/ },
  { name: 'ad-hoc leading literal', re: /\bleading-\[/ },
  // Spacing scale (DESIGN.md §4.4, §6): padding/margin/gap use the ramp utilities.
  {
    name: 'ad-hoc spacing literal',
    re: /\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-\[/,
  },
];

/** Strip block and line comments so token names documented in prose are not flagged. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Return every forbidden-pattern hit in the (comment-stripped) source. */
function scanForbidden(source: string): string[] {
  const code = stripComments(source);
  const hits: string[] = [];
  for (const line of code.split('\n')) {
    for (const { name, re } of FORBIDDEN) {
      if (re.test(line)) hits.push(`${name}: ${line.trim()}`);
    }
  }
  return hits;
}

describe('token rule — scanner catches violations', () => {
  it('flags raw Spectrum tokens, hex, and arbitrary color/radius/type/spacing classes', () => {
    const dirty = [
      'const a = "#0265dc";',
      'const b = "color: var(--spectrum-blue-100)";',
      '<div className="bg-[#fff] rounded-[7px]" />;',
      '<h1 className="text-[26px] tracking-[0.06em] leading-[1.2]" />;',
      '<div className="p-[13px] gap-[27px]" />;',
    ].join('\n');
    const hits = scanForbidden(dirty);
    for (const name of [
      'hard-coded hex color',
      'raw Spectrum global token',
      'Tailwind arbitrary color literal',
      'ad-hoc radius literal',
      'ad-hoc font-size literal',
      'ad-hoc tracking literal',
      'ad-hoc leading literal',
      'ad-hoc spacing literal',
    ]) {
      expect(
        hits.some((h) => h.startsWith(name)),
        `expected a ${name} hit`
      ).toBe(true);
    }
  });

  it('passes clean markup that references only semantic utilities', () => {
    const clean = [
      '/* accent is #0265dc in the Spectrum theme — documented, not markup */',
      '<h1 className="text-title font-extrabold text-fg-strong" />;',
      '<p className="text-eyebrow uppercase tracking-eyebrow text-fg-muted" />;',
      '<div className="bg-canvas text-fg rounded-ok shadow-ok-card p-4 gap-3 max-w-[760px]" />;',
      '<span className="bg-[color:var(--overlay-hover)] text-worker-scout-fg size-[22px]" />;',
    ].join('\n');
    expect(scanForbidden(clean)).toEqual([]);
  });
});

describe('token rule — component tiers are clean', () => {
  const modules = import.meta.glob('../{primitives,screens,app}/**/*.{ts,tsx}', {
    query: '?raw',
    eager: true,
    import: 'default',
  }) as Record<string, string>;

  const componentFiles = Object.entries(modules).filter(([path]) => !path.includes('.test.'));

  it('scans at least the seed primitive', () => {
    expect(componentFiles.length).toBeGreaterThan(0);
  });

  for (const [path, source] of componentFiles) {
    it(`${path} references only semantic tokens`, () => {
      expect(scanForbidden(source)).toEqual([]);
    });
  }
});
