// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareInventory, coveredSuite, testOwners } from '../scripts/release-tests.mjs';
import { runTestSuite } from '../scripts/validate-test-governance.mjs';

const inventory = [{ name: 'case', file: '/example/case.test.ts' }];

/**
 * Captures the real admission path so deliberate fixture failures cannot become outer test results.
 *
 * @param {string} call Invocation of a production admission function.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} Private process result.
 */
function runAdmissionFixture(call) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const moduleUrl = new URL('../scripts/release-tests.mjs', import.meta.url).href;
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { coveredSuite, packageSuite, releaseTests } from ${JSON.stringify(moduleUrl)};\n${call}`,
    ],
    { encoding: 'utf8', env }
  );
}

test('inventory equality preserves duplicate counts and refuses lost cases', () => {
  assert.equal(compareInventory(inventory, inventory), 1);
  assert.throws(() => compareInventory([...inventory, ...inventory], inventory), /different/);
  assert.throws(() => compareInventory([], []), /missing/);
});
test('admission collects both variants and routine execution runs coverage once', () => {
  const calls = [],
    owner = { name: 'synthetic', cwd: '/example' };
  const seams = {
    spawn: (_exe, args) => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify(inventory) };
    },
    run: ({ command }) => {
      calls.push(command);
      return [];
    },
  };
  const proof = coveredSuite(owner, { ...seams, inventoryOnly: true });
  assert.equal(proof.inventory, 'equal');
  assert.equal(proof.execution, 'not run');
  assert.equal(calls.length, 2);
  const result = coveredSuite(owner, seams);
  assert.equal(calls.length, 3);
  assert(!calls[0].includes('--coverage'));
  assert(calls[1].includes('--coverage'));
  assert(
    calls[2].includes('run') &&
      calls[2].includes('--coverage') &&
      calls[2].includes('--reporter=tap-flat')
  );
  assert.equal(result.execution, 'coverage passed');
  assert.equal(result.inventory, 'not collected');
});
test('deduplicated command propagates execution failure', () => {
  assert.throws(
    () =>
      coveredSuite(
        { name: 'synthetic', cwd: '/example' },
        {
          spawn: () => ({ status: 0, stdout: JSON.stringify(inventory) }),
          run: () => ['injected failure'],
        }
      ),
    /injected failure/
  );
});
test('unchanged skip guard refuses an injected TAP skip and command failure', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-test-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'fixture.mjs');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  writeFileSync(fixture, 'console.log("ok 1 - fixture.test.ts > injected # SKIP");');
  assert(
    runTestSuite({ cwd: dir, env, command: [process.execPath, fixture] }).some((e) =>
      e.includes('undeclared skip')
    )
  );
  writeFileSync(fixture, 'process.exitCode=7;');
  assert(
    runTestSuite({ cwd: dir, env, command: [process.execPath, fixture] }).some((e) =>
      e.includes('status 7')
    )
  );
});
test('root and native suites remain distinct discovered owners', () => {
  const owners = testOwners(process.cwd());
  assert.equal(owners.filter((o) => o.vitest).length, 10);
  assert(owners.some((o) => o.name === '@openkit/nanohost' && !o.vitest));
  assert(owners.some((o) => o.name === '@openkit/models-dev-catalog' && !o.vitest));
});
for (const [name, subject, passes] of [
  ['success', 'console.log("ok 1 - fixture.native > success");', true],
  ['undeclared skip', 'console.log("ok 1 - fixture.native > skipped # SKIP");', false],
  ['failure', 'process.exitCode = 7;', false],
])
  test(`actual non-Vitest package execution enforces ${name}`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'release-package-admission-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, 'apps'));
    const pkg = path.join(root, 'packages/native');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    const { packageManager } = JSON.parse(readFileSync('package.json', 'utf8'));
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ private: true, packageManager })
    );
    writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: '@fixture/native', scripts: { test: 'node subject.mjs' } })
    );
    writeFileSync(path.join(pkg, 'subject.mjs'), subject);
    const result = runAdmissionFixture(
      `packageSuite({ name: '@fixture/native' }, ${JSON.stringify({ root })});`
    );
    assert.equal(result.status, passes ? 0 : 1, result.stdout + result.stderr);
    if (!passes) assert.match(result.stderr, /Guarded test execution failed/);
    if (name === 'undeclared skip') {
      assert.match(result.stdout, /fixture.native > skipped # SKIP/);
      assert.match(result.stderr, /Test suite reported undeclared skip: fixture.native > skipped/);
    }
    // The gate owns nonzero command rejection, independent of package-manager exit mapping.
    if (name === 'failure')
      assert.match(result.stderr, /Test command exited with status [1-9]\d*\./);
  });
test('routine test:ci refuses a non-Vitest skip before later build or root checks', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'release-routine-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'apps'));
  mkdirSync(path.join(root, 'packages/native'), { recursive: true });
  symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'));
  const { packageManager } = JSON.parse(readFileSync('package.json', 'utf8'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, packageManager }));
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  writeFileSync(
    path.join(root, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/native: {}\n"
  );
  writeFileSync(path.join(root, 'turbo.json'), JSON.stringify({ tasks: { build: {} } }));
  writeFileSync(
    path.join(root, 'packages/native/package.json'),
    JSON.stringify({ name: '@fixture/native', scripts: { test: 'node subject.mjs' } })
  );
  writeFileSync(
    path.join(root, 'packages/native/subject.mjs'),
    'console.log("ok 1 - fixture.native > injected # SKIP");'
  );
  const result = runAdmissionFixture(`releaseTests(${JSON.stringify({ root })});`);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /fixture.native > injected # SKIP/);
  assert.match(result.stderr, /@fixture\/native: Guarded test execution failed/);
});

/** The real coverage invocation sees a stable local success/failure/skip subject. */
function vitestFixture(t, body) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'release-vitest-admission-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, 'node_modules/@vitest'), { recursive: true });
  symlinkSync(
    path.resolve('packages/protocol/node_modules/vitest'),
    path.join(cwd, 'node_modules/vitest')
  );
  symlinkSync(
    path.resolve('packages/protocol/node_modules/@vitest/coverage-v8'),
    path.join(cwd, 'node_modules/@vitest/coverage-v8')
  );
  writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    path.join(cwd, 'vitest.config.js'),
    'export default {test:{globals:true,include:["subject.test.js"],coverage:{provider:"v8",reporter:["text"],include:["subject.js"]}}};'
  );
  writeFileSync(path.join(cwd, 'subject.js'), 'export const value=1;');
  writeFileSync(path.join(cwd, 'subject.test.js'), `import {value} from './subject.js';\n${body}`);
  return { name: 'offline-admission', cwd };
}
test('actual single coverage execution passes the deliberate success subject', (t) => {
  const fixture = vitestFixture(t, 'test("success",()=>expect(value).toBe(1));');
  const result = runAdmissionFixture(
    `console.log(JSON.stringify(coveredSuite(${JSON.stringify(fixture)})));`
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).execution, 'coverage passed');
});
test('actual single coverage execution propagates a deliberate Vitest assertion failure', (t) => {
  const fixture = vitestFixture(t, 'test("failure",()=>expect(value).toBe(2));');
  const result = runAdmissionFixture(`coveredSuite(${JSON.stringify(fixture)});`);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /not ok 1 - subject.test.js > failure/);
  assert.match(result.stderr, /Guarded test execution failed/);
});
test('actual single coverage execution refuses a deliberate undeclared Vitest skip', (t) => {
  const fixture = vitestFixture(
    t,
    'test("success",()=>expect(value).toBe(1)); test.skip("undeclared",()=>{});'
  );
  const result = runAdmissionFixture(`coveredSuite(${JSON.stringify(fixture)});`);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /subject.test.js > undeclared # SKIP/);
  assert.match(result.stderr, /Test suite reported undeclared skip: subject.test.js > undeclared/);
});
