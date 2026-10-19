// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Run explicitly with node --test; missing tools or delegation fail this gate.
test('private systemd preserves maintenance inhibition', () => {
  runFixture([], ['finalize', 'second-activation', 'failed-start', 'unknown-finalize']);
});

test('private systemd increases stock restart delay and preserves refusal and stop controls', () => {
  const [result] = runFixture(['--backoff'], ['restart-backoff']);
  const facts = result.facts;
  assert.equal(facts.restartSec, '5s');
  assert.equal(facts.restartSteps, '5');
  assert.equal(facts.restartMaxDelay, '5min');
  assert.equal(facts.restartIntervalsSeconds.length, 2);
  assert.ok(facts.restartIntervalsSeconds[0] >= 4);
  assert.ok(facts.restartIntervalsSeconds[1] >= 1.5 * facts.restartIntervalsSeconds[0]);
  assert.equal(facts.exit78NotRestarted, true);
  assert.equal(facts.stopCancelsRestart, true);
  assert.equal(facts.wholeSliceStopped, true);
  assert.equal(facts.oracleSuccessFailureTimeout, true);
});

/** Runs the existing contained fixture and requires its exact finite case set and cleanup facts. */
function runFixture(args, expectedCases) {
  assert.equal(process.platform, 'linux', 'The selected live fixture requires Linux.');
  const result = spawnSync(
    '/usr/bin/python3',
    [
      '-I',
      '-B',
      fileURLToPath(new URL('./nanohost-systemd.live.test.py', import.meta.url)),
      ...args,
    ],
    { env: process.env, encoding: 'utf8', timeout: 360_000, maxBuffer: 1024 * 1024 }
  );
  process.stdout.write(result.stdout ?? '');
  assert.equal(
    result.error,
    undefined,
    'The selected live fixture did not return a bounded result.'
  );
  assert.equal(result.signal, null, 'The selected live fixture was interrupted.');
  assert.equal(
    result.status,
    0,
    'The selected live fixture failed; inspect its fixed state facts.'
  );
  const cases = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    cases.map((value) => value.case),
    expectedCases
  );
  for (const value of cases) {
    assert.equal(value.outcome, 'passed');
    assert.equal(value.facts.ownedCgroupRemoved, true);
    assert.equal(value.facts.privateRootsRemoved, true);
  }
  return cases;
}
