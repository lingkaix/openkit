// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  compareInventory,
  coveredSuite,
  mergeCoveredSuite,
  testOwners,
  verifyCoveragePartitions,
} from '../scripts/release-tests.mjs';
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
      `import { coveredSuite, mergeCoveredSuite, packageSuite, releaseTests } from ${JSON.stringify(moduleUrl)};\n${call}`,
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
    environments = [],
    owner = { name: 'synthetic', cwd: '/example' };
  const seams = {
    spawn: (_exe, args, options) => {
      calls.push(args);
      environments.push(options.env);
      return { status: 0, stdout: JSON.stringify(inventory) };
    },
    run: ({ command, env }) => {
      calls.push(command);
      environments.push(env);
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
  for (const args of calls.slice(0, 2)) assert(args.includes('--maxWorkers=4'));
  assert(!calls[2].some((arg) => arg.startsWith('--maxWorkers')));
  for (const env of environments)
    assert.equal(
      (env ?? process.env).VITEST_MAX_WORKERS,
      process.env.VITEST_MAX_WORKERS,
      'other owners preserve inherited worker settings'
    );
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
  assert.equal(owners.filter((o) => o.vitest).length, 11);
  assert(owners.some((o) => o.name === '@openkit/storage' && o.vitest));
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

/** A partition receipt preserves repeated case names while files remain disjoint. */
function partitionReceipt(index, file, names = ['case', 'case']) {
  return {
    partition: { index, count: 4 },
    expected: names.map((name) => ({ file, name })),
    report: {
      success: true,
      testResults: [
        {
          name: file,
          status: 'passed',
          assertionResults: names.map((title) => ({ ancestorTitles: [], title, status: 'passed' })),
        },
      ],
    },
  };
}
test('coverage partition union rejects every missing, overlapping, extra and non-passing member', () => {
  const a = partitionReceipt(1, '/one.test.js'),
    b = partitionReceipt(2, '/two.test.js'),
    c = partitionReceipt(3, '/three.test.js'),
    d = partitionReceipt(4, '/four.test.js');
  const files = ['one', 'two', 'three', 'four'].map((name) => ({ file: `/${name}.test.js` }));
  assert.equal(verifyCoveragePartitions([a, b, c, d], files, 4).length, 8);
  for (const members of [
    [a, b, c],
    [a, b, c, d, d],
    [a, b, c, c],
    [a, { ...b, partition: { index: 2, count: 3 } }, c, d],
    [a, partitionReceipt(2, '/one.test.js'), c, d],
    [a, partitionReceipt(2, '/extra.test.js'), c, d],
    [a, { ...b, expected: b.expected.slice(1) }, c, d],
    [a, { ...b, expected: [] }, c, d],
    [a, { ...b, report: { ...b.report, success: false } }, c, d],
    [
      a,
      {
        ...b,
        report: {
          success: true,
          testResults: [
            {
              ...b.report.testResults[0],
              assertionResults: [
                { ancestorTitles: [], title: 'case', status: 'pending' },
                { ancestorTitles: [], title: 'case', status: 'passed' },
              ],
            },
          ],
        },
      },
      c,
      d,
    ],
  ])
    assert.throws(() => verifyCoveragePartitions(members, files, 4));
});
test('NanoCore partition admission caps collection and execution at two workers and defers only partial thresholds', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-partition-command-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reportFile = path.join(dir, 'one-execution.report'),
    blobFile = path.join(dir, 'blobs/one.json');
  const calls = [],
    environments = [];
  const expected = [{ file: '/subject.test.js', name: 'case' }];
  const result = coveredSuite(
    { name: '@openkit/nanocore', cwd: dir },
    {
      partition: { index: 1, count: 4 },
      reportFile,
      blobFile,
      spawn: (_exe, args, options) => {
        calls.push(args);
        environments.push(options.env);
        return { status: 0, stdout: JSON.stringify(expected) };
      },
      run: ({ command, env }) => {
        calls.push(command);
        environments.push(env);
        writeFileSync(
          reportFile,
          JSON.stringify({
            success: true,
            testResults: [
              { name: expected[0].file, assertionResults: [{ ancestorTitles: [], title: 'case' }] },
            ],
          })
        );
        return [];
      },
    }
  );
  assert.equal(result.cases, 1);
  assert.equal(calls.length, 3);
  for (const args of calls) {
    assert(args.includes('--shard=1/4'));
    assert(args.includes('--maxWorkers=2'));
  }
  // Vitest's inherited environment overrides its CLI worker flag. Both must agree.
  for (const env of environments) assert.equal(env?.VITEST_MAX_WORKERS, '2');
  for (const args of calls.slice(0, 2)) assert(!args.includes('--filesOnly'));
  assert(!calls[0].includes('--coverage'));
  assert(calls[1].includes('--coverage'));
  assert(calls[2].includes('--reporter=blob'));
  assert(calls[2].includes('--coverage.thresholds.lines=0'));
  assert.deepEqual(JSON.parse(readFileSync(`${reportFile}.inventory`)), {
    partition: { index: 1, count: 4 },
    expected,
  });
  assert.throws(
    () =>
      coveredSuite(
        { name: 'fixture', cwd: dir },
        { partition: { index: 0, count: 2 }, reportFile, blobFile }
      ),
    /invalid coverage partition/
  );
});
test('merged coverage preserves original thresholds and propagates the deciding command failure', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-merge-command-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'blobs'));
  for (const [index, name] of [
    [1, 'one'],
    [2, 'two'],
    [3, 'three'],
    [4, 'four'],
  ]) {
    const entry = partitionReceipt(index, `/${name}.test.js`);
    writeFileSync(
      path.join(dir, `${name}-execution.report.inventory`),
      JSON.stringify({ partition: entry.partition, expected: entry.expected })
    );
    writeFileSync(path.join(dir, `${name}-execution.report`), JSON.stringify(entry.report));
    writeFileSync(path.join(dir, 'blobs', `${name}.json`), '{}');
  }
  let command, collectionCommand;
  const environments = [];
  assert.throws(
    () =>
      mergeCoveredSuite(
        { name: '@openkit/nanocore', cwd: dir },
        {
          directory: dir,
          count: 4,
          reportFile: path.join(dir, 'merged.report'),
          spawn: (_exe, args, options) => {
            collectionCommand = args;
            environments.push(options.env);
            return {
              status: 0,
              stdout: JSON.stringify(
                ['one', 'two', 'three', 'four'].map((name) => ({ file: `/${name}.test.js` }))
              ),
            };
          },
          run: ({ command: args, env }) => {
            command = args;
            environments.push(env);
            return ['original threshold failed'];
          },
        }
      ),
    /original threshold failed/
  );
  assert(command.includes('--coverage'));
  assert(collectionCommand.includes('--maxWorkers=2'));
  assert(command.includes('--maxWorkers=2'));
  for (const env of environments) assert.equal(env?.VITEST_MAX_WORKERS, '2');
  assert(command.some((arg) => arg.startsWith('--merge-reports=')));
  assert(!command.some((arg) => arg.startsWith('--coverage.thresholds')));
});
test('four actual partition blobs merge to original coverage and unchanged thresholds refuse lost coverage', (t) => {
  const owner = vitestFixture(
    t,
    'test("first branch",()=>{ expect(process.env.VITEST_MAX_WORKERS).toBe("2"); expect(value(1)).toBe(1); });'
  );
  owner.name = '@openkit/nanocore';
  const directory = path.join(owner.cwd, 'receipts');
  mkdirSync(directory);
  writeFileSync(
    path.join(owner.cwd, 'subject.js'),
    'export function value(input) { if (input === 1) return 1; if (input === 2) return 2; if (input === 3) return 3; return 4; }'
  );
  for (const [file, input] of [
    ['other', 2],
    ['third', 3],
    ['fourth', 4],
  ])
    writeFileSync(
      path.join(owner.cwd, `${file}.test.js`),
      `import {value} from './subject.js'; test('branch ${input}',()=>expect(value(${input})).toBe(${input}));`
    );
  const config = (threshold) =>
    `export default {test:{globals:true,maxWorkers:1,pool:"threads",include:["*.test.js"],coverage:{provider:"v8",reporter:["text"],include:["subject.js"],thresholds:{lines:${threshold},branches:${threshold},functions:${threshold},statements:${threshold}}}}};`;
  writeFileSync(path.join(owner.cwd, 'vitest.config.js'), config(100));
  for (const index of [1, 2, 3, 4]) {
    const prefix = `part-${index}`;
    const result = runAdmissionFixture(
      `coveredSuite(${JSON.stringify(owner)},${JSON.stringify({ partition: { index, count: 4 }, reportFile: path.join(directory, `${prefix}-execution.report`), blobFile: path.join(directory, 'blobs', `${prefix}.json`) })});`
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const call = `mergeCoveredSuite(${JSON.stringify(owner)},${JSON.stringify({ directory, count: 4, reportFile: path.join(directory, 'merged.report') })});`;
  const complete = runAdmissionFixture(call);
  assert.equal(complete.status, 0, complete.stdout + complete.stderr);
  const report = JSON.parse(readFileSync(path.join(directory, 'merged.report')));
  assert.equal(report.numPassedTests, 4);
  assert.equal(report.testResults.length, 4);
  // Keep the original 100% thresholds and four passing tests, but leave the final branch uncovered.
  writeFileSync(
    path.join(owner.cwd, 'fourth.test.js'),
    'import {value} from "./subject.js"; test("branch 4",()=>expect(value(1)).toBe(1));'
  );
  for (const index of [1, 2, 3, 4]) {
    const prefix = `part-${index}`;
    const result = runAdmissionFixture(
      `coveredSuite(${JSON.stringify(owner)},${JSON.stringify({ partition: { index, count: 4 }, reportFile: path.join(directory, `${prefix}-execution.report`), blobFile: path.join(directory, 'blobs', `${prefix}.json`) })});`
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const belowThreshold = runAdmissionFixture(call);
  assert.equal(belowThreshold.status, 1, belowThreshold.stdout + belowThreshold.stderr);
  assert.match(belowThreshold.stderr, /merged coverage failed/);
});
