// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatGateSummary, gateSummary, main } from '../scripts/gate-summary.mjs';

const vitest = fileURLToPath(new URL('../packages/protocol/node_modules/vitest', import.meta.url));

/**
 * Runs real Vitest once over the given fixture files and returns its actual JSON report.
 *
 * @param {import('node:test').TestContext} t Owning test.
 * @param {Record<string, string>} files Fixture file names and bodies.
 * @returns {{ cwd: string, report: object, reportFile: string }} Fixture root and report.
 */
function vitestRun(t, files) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'gate-summary-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, 'node_modules'));
  symlinkSync(vitest, path.join(cwd, 'node_modules/vitest'));
  writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    path.join(cwd, 'vitest.config.js'),
    'export default {test:{globals:true,include:["*.test.js"]}};'
  );
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(cwd, name), body);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const reportFile = path.join(cwd, 'report.json');
  const run = spawnSync(
    process.execPath,
    [
      path.join(cwd, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--reporter=json',
      `--outputFile.json=${reportFile}`,
    ],
    { cwd, env, encoding: 'utf8' }
  );
  assert.equal(run.error, undefined);
  return { cwd, report: JSON.parse(readFileSync(reportFile, 'utf8')), reportFile };
}

/** Captures one CLI invocation without touching the outer test streams. */
function cli(argv) {
  let stdout = '';
  let stderr = '';
  const status = main(
    argv,
    { write: (text) => (stdout += text) },
    { write: (text) => (stderr += text) }
  );
  return { status, stdout, stderr };
}

test('an actual Vitest import failure is a gate failure with zero assertions', (t) => {
  const { cwd, report, reportFile } = vitestRun(t, {
    'passes.test.js': 'test("passes",()=>expect(1).toBe(1));',
    'import.test.js': 'import "./missing.js"; test("never",()=>{});',
  });
  const summary = gateSummary({
    root: cwd,
    selected: ['passes.test.js', 'import.test.js'],
    report,
  });
  assert.equal(summary.pass, false);
  assert.deepEqual(summary.failedAssertions, []);
  assert.deepEqual(summary.withResult, [path.join(cwd, 'passes.test.js')]);
  assert.deepEqual(
    summary.noResult.map((entry) => entry.file),
    [path.join(cwd, 'import.test.js')]
  );
  assert.match(summary.noResult[0].cause, /Cannot find module/u);
  const printed = cli(['--report', reportFile, '--root', cwd, 'passes.test.js', 'import.test.js']);
  assert.equal(printed.status, 1, printed.stderr);
  for (const heading of [
    'Files selected (2)',
    'Files with a result (1)',
    'Failed assertions (0)',
    'Groups not run (no coverage credit) (0)',
    'Gate: FAIL (1)',
  ])
    assert.ok(printed.stdout.includes(heading), `${heading}\n${printed.stdout}`);
  assert.match(printed.stdout, /selected file has no result: .*import\.test\.js/u);
});

test('a failed suite setup, an unreported selection and a failed case all fail the gate', (t) => {
  const { cwd, report } = vitestRun(t, {
    'setup.test.js': 'beforeAll(()=>{throw Error("setup")}); test("a",()=>{}); test("b",()=>{});',
    'fails.test.js': 'test("fails",()=>expect(1).toBe(2));',
  });
  const summary = gateSummary({
    root: cwd,
    selected: ['setup.test.js', 'fails.test.js', 'absent.test.js'],
    report,
  });
  assert.equal(summary.pass, false);
  assert.deepEqual(
    summary.noResult.map((entry) => [path.basename(entry.file), entry.cause]),
    [
      ['absent.test.js', 'not in the report'],
      ['setup.test.js', 'setup'],
    ]
  );
  assert.deepEqual(summary.failedAssertions, [
    { file: path.join(cwd, 'fails.test.js'), name: 'fails' },
  ]);
});

test('a group that was not run shows its issue, last SHA and result and gets no credit', (t) => {
  const { cwd, report } = vitestRun(t, { 'passes.test.js': 'test("passes",()=>{});' });
  const group = {
    group: 'Login composition',
    issue: '#604',
    lastMeasuredSha: 'cf5adb5d9',
    lastResult: '30 failed of 32',
  };
  const summary = gateSummary({ root: cwd, selected: ['passes.test.js'], report, notRun: [group] });
  assert.equal(summary.pass, true);
  assert.deepEqual(summary.notRun, [{ ...group, credit: 'none' }]);
  assert.match(
    formatGateSummary(summary),
    /Groups not run \(no coverage credit\) \(1\)\n {2}Login composition: #604, last measured cf5adb5d9 = 30 failed of 32\nGate: PASS/u
  );
  const unmeasured = gateSummary({
    root: cwd,
    selected: ['passes.test.js'],
    report,
    notRun: [{ group: 'Login composition', issue: '#604' }],
  });
  assert.equal(unmeasured.pass, false);
  assert.match(unmeasured.failures[0], /lacks issue, last measured SHA or result/u);
});
