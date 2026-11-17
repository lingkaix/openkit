import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('check:repo runs exposure owner and switch coverage', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const script = pkg.scripts['check:repo'];
  const coverage =
    'pnpm --filter @openkit/nanocore exec vitest run src/policy/operation-exposure-coverage.test.ts';
  const kernel = script.indexOf('turbo run build --filter=@openkit/policy-kernel');
  assert.ok(kernel >= 0);
  assert.ok(script.indexOf(coverage) > kernel);
});
