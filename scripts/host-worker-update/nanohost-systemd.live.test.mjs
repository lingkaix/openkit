// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Explicit host opt-in; once selected, missing tools or delegation fail the gate.
test('nanohost-systemd.live.test.mjs private systemd preserves maintenance inhibition', {
  skip: process.env.OPENKIT_TEST_NANOHOST_SYSTEMD_LIVE !== '1',
}, () => {
  assert.equal(process.platform, 'linux', 'The selected live fixture requires Linux.');
  const result = spawnSync('/usr/bin/python3', [
    '-I', '-B', fileURLToPath(new URL('./nanohost-systemd.live.test.py', import.meta.url)),
  ], { env: process.env, encoding: 'utf8', timeout: 360_000, maxBuffer: 1024 * 1024 });
  process.stdout.write(result.stdout ?? '');
  assert.equal(result.error, undefined, 'The selected live fixture did not return a bounded result.');
  assert.equal(result.signal, null, 'The selected live fixture was interrupted.');
  assert.equal(result.status, 0, 'The selected live fixture failed; inspect its fixed state facts.');
  const cases = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(cases.map(value => value.case), ['finalize', 'second-activation', 'failed-start', 'unknown-finalize']);
  for (const value of cases) {
    assert.equal(value.outcome, 'passed');
    assert.equal(value.facts.ownedCgroupRemoved, true);
    assert.equal(value.facts.privateRootsRemoved, true);
  }
});
