import { describe, expect, it } from 'vitest';

/**
 * WEB-UX A5 ratchets (DESIGN.md §5, §7, §9.5; principles P8, P9). Headings at a heading
 * size use the S2 heading weight; S2 has no semibold and the heading weight is a token,
 * not a literal; cards carry no resting shadow (only the B3 composer box keeps one until
 * its own slice); every modal is the `Modal` primitive (the phone drawer is a sheet of
 * the shell, not a dialog).
 */
const sources = import.meta.glob<string>(
  ['../**/*.tsx', '!../**/*.test.tsx', '!../**/__fixtures__/**'],
  { query: '?raw', import: 'default', eager: true }
);

function offenders(pattern: RegExp, allow: Set<string> = new Set()): string[] {
  return Object.entries(sources).flatMap(([file, text]) =>
    allow.has(file)
      ? []
      : text
          .split('\n')
          .flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}`] : []))
  );
}

describe('Spectrum 2 surface guard (WEB-UX A5)', () => {
  it('gives every heading-sized heading the S2 heading weight', () => {
    const misses = Object.entries(sources).flatMap(([file, text]) =>
      [...text.matchAll(/<(?:h[1-6]|Heading)\b[^>]*?className=["`]([^"`]*)["`]/gs)]
        .filter(
          ([, cls]) =>
            /\btext-(?:lg|xl|title|display)\b/.test(cls ?? '') &&
            !/\bfont-heading\b/.test(cls ?? '')
        )
        .map(([tag]) => `${file}: ${tag.slice(0, 80)}`)
    );
    expect(misses).toEqual([]);
  });

  it('uses only S2 weights: no semibold, and the heading weight only by its token', () => {
    expect(offenders(/\bfont-(?:semibold|extrabold)\b/)).toEqual([]);
  });

  it('draws cards without a resting shadow outside the B3 composer', () => {
    expect(offenders(/\bshadow-ok-card\b/, new Set(['../primitives/Composer.tsx']))).toEqual([]);
  });

  it('builds every modal dialog on the Modal primitive', () => {
    // The phone drawer (AppShell) and the Search palette, which sits at a fixed top offset so
    // its input does not move while results change, use the same ok-dialog sizes directly.
    const own = new Set([
      '../primitives/Dialog.tsx',
      '../app/AppShell.tsx',
      '../app/search/SearchPalette.tsx',
    ]);
    expect(offenders(/\bModalOverlay\b/, own)).toEqual([]);
  });
});
