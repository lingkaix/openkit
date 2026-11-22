// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '../scripts/gen-tokens.mjs');
const generated = resolve(import.meta.dirname, '../src/styles/spectrum.generated.css');

/** Runs the generator in check mode against `target` and returns its exit status. */
function check(target: string): number {
  try {
    execFileSync(process.execPath, [script, '--check', target], { stdio: 'pipe' });
    return 0;
  } catch (error) {
    return (error as { status: number }).status;
  }
}

it('keeps spectrum.generated.css identical to the pinned @adobe/spectrum-tokens output', () => {
  expect(check(generated)).toBe(0);
});

it('fails the check when the generated file drifts', () => {
  const drifted = join(mkdtempSync(join(tmpdir(), 'ok-tokens-')), 'spectrum.generated.css');
  writeFileSync(drifted, readFileSync(generated, 'utf8').replace('#3b63fb', '#123456'));
  expect(check(drifted)).toBe(1);
});

it('maps the S2 heading weight token (extra-bold) to 800 in the theme', () => {
  const require = createRequire(import.meta.url);
  const variables = require('@adobe/spectrum-tokens/dist/json/variables.json') as Record<
    string,
    { value?: string }
  >;
  expect(variables['heading-sans-serif-font-weight']?.value).toBe('extra-bold');
  const theme = readFileSync(resolve(import.meta.dirname, '../src/styles/theme.css'), 'utf8');
  expect(theme).toMatch(/--font-weight-heading:\s*800;/);
});
