import { describe, expect, it } from 'vitest';

/**
 * WEB-UX A4 ratchets (DESIGN.md §6, §9.3; principles P7). Sizes come from the S2 scale and
 * the 44px touch target from the coarse-pointer hit area, never a 44px override on a
 * control; focus is the S2 outline (2px, 2px gap) that survives forced colors. The composer
 * action row keeps its 44px controls until its own slice (B3), listed here by file.
 */
const sources = import.meta.glob<string>(
  ['../**/*.tsx', '!../**/*.test.tsx', '!../**/__fixtures__/**'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  }
);

/** Files allowed to keep 44px control overrides until B3 (composer layout). */
const B3_COMPOSER = new Set(['../primitives/Composer.tsx', '../primitives/voice-input.tsx']);

function offenders(pattern: RegExp, allow: Set<string> = new Set()): string[] {
  return Object.entries(sources).flatMap(([file, text]) =>
    allow.has(file)
      ? []
      : text
          .split('\n')
          .flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}`] : []))
  );
}

describe('Spectrum 2 scale guard (WEB-UX A4)', () => {
  it('has no 44px height or size overrides outside the B3 composer', () => {
    expect(offenders(/(?<![\w-])(?:min-)?(?:h|w|size)-11(?![\w-])|min-w-11/, B3_COMPOSER)).toEqual(
      []
    );
  });

  it('draws focus as an outline, never a box-shadow ring', () => {
    expect(offenders(/(?:focus|focus-visible|focus-within):ring-/)).toEqual([]);
  });

  it('keeps the retired primitive names out of the tree', () => {
    expect(offenders(/\b(?:StatusChip|ErrorBanner|ContextChip)\b/)).toEqual([]);
  });
});
