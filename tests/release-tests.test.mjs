// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareInventory, coveredSuite, testOwners } from '../scripts/release-tests.mjs';
import { runTestSuite } from '../scripts/validate-test-governance.mjs';

const inventory = [{ name: 'case', file: '/example/case.test.ts' }];
test('inventory equality preserves duplicate counts and refuses lost cases', () => {
  assert.equal(compareInventory(inventory, inventory), 1);
  assert.throws(() => compareInventory([...inventory, ...inventory], inventory), /different/);
  assert.throws(() => compareInventory([], []), /missing/);
});
test('covered suite collects both variants and executes once with coverage and TAP', () => {
  const calls = [];
  const result = coveredSuite(
    { name: 'synthetic', cwd: '/example' },
    {
      spawn: (_exe, args) => {
        calls.push(args);
        return { status: 0, stdout: JSON.stringify(inventory) };
      },
      run: ({ command }) => {
        calls.push(command);
        return [];
      },
    }
  );
  assert.equal(calls.length, 3);
  assert(!calls[0].includes('--coverage'));
  assert(calls[1].includes('--coverage'));
  assert(
    calls[2].includes('run') &&
      calls[2].includes('--coverage') &&
      calls[2].includes('--reporter=tap-flat')
  );
  assert.equal(result.execution, 'coverage passed');
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
  assert.equal(
    coveredSuite(vitestFixture(t, 'test("success",()=>expect(value).toBe(1));')).execution,
    'coverage passed'
  );
});
test('actual single coverage execution propagates a deliberate Vitest assertion failure', (t) => {
  assert.throws(
    () => coveredSuite(vitestFixture(t, 'test("failure",()=>expect(value).toBe(2));')),
    /Guarded test execution failed/
  );
});
test('actual single coverage execution refuses a deliberate undeclared Vitest skip', (t) => {
  assert.throws(
    () =>
      coveredSuite(
        vitestFixture(
          t,
          'test("success",()=>expect(value).toBe(1)); test.skip("undeclared",()=>{});'
        )
      ),
    /Guarded test execution failed/
  );
});
