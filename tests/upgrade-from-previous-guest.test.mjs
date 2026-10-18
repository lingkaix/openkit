import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('prepared guest upgrade lifecycle has offline boundary regressions', () => {
  const result = spawnSync('python3', ['-B', 'scripts/upgrade-from-previous-guest.test.py'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
