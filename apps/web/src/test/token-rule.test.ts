import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Retained phone safe-area witness. The phone outcome is not retired with the
 * unrelated component-source scanner matrix. Token parity remains covered by
 * tokens.test.ts; phone behavior remains covered by the existing UI suites.
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

describe('phone safe-area guard', () => {
  it('keeps the phone sheet safe-area inset on the named spacing token', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const dialog = readFileSync(join(here, '../app/StartWorkDialogs.tsx'), 'utf8');
    const theme = readFileSync(join(here, '../styles/theme.css'), 'utf8');
    expect(dialog).toContain('max-[799px]:pb-safe-bottom');
    expect(dialog).not.toContain('pb-[env(safe-area-inset-bottom)]');
    expect(theme).toMatch(/--spacing-safe-bottom:\s*env\(safe-area-inset-bottom\);/);
    const literal = scanForbidden(
      '<AriaModal className="max-[799px]:pb-[env(safe-area-inset-bottom)]" />'
    );
    expect(literal.some((hit) => hit.startsWith('ad-hoc spacing literal'))).toBe(true);
    expect(scanForbidden(dialog)).toEqual([]);
  });
});
