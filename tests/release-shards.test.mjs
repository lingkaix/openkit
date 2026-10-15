// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { requireShardResults, shardPlan } from '../scripts/ci-l0-l2.mjs';
import {
  rootNodeInventory,
  rootSuite,
  testOwners,
  verifyExecutionInventory,
} from '../scripts/release-tests.mjs';

test('execution inventory refuses missing and repeated files or cases', () => {
  const expected = [{ file: '/example/subject.test.ts', name: 'suite > case' }];
  const result = {
    name: expected[0].file,
    assertionResults: [{ ancestorTitles: ['suite'], title: 'case' }],
  };
  assert.equal(verifyExecutionInventory(expected, { success: true, testResults: [result] }), 1);
  for (const testResults of [
    [],
    [result, result],
    [{ ...result, assertionResults: [] }],
    [{ ...result, assertionResults: [...result.assertionResults, ...result.assertionResults] }],
  ])
    assert.throws(() => verifyExecutionInventory(expected, { success: true, testResults }));
  assert.throws(() =>
    verifyExecutionInventory(expected, { success: false, testResults: [result] })
  );
});

test('every deterministic package belongs to exactly one complete-suite shard', () => {
  const owners = testOwners(process.cwd());
  const plan = shardPlan();
  assert.equal(new Set(plan.map((s) => s.id)).size, plan.length);
  assert.deepEqual(plan.flatMap((s) => s.owners).sort(), owners.map((o) => o.name).sort());
  assert.equal(plan.filter((s) => s.kind === 'root').length, 1);
  assert.equal(plan.filter((s) => s.kind === 'static').length, 1);
  for (const owner of owners.filter((o) => o.vitest)) {
    const matches = plan.filter((s) => s.owners.includes(owner.name));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].kind, 'coverage');
    assert.deepEqual(matches[0].owners, [owner.name]);
  }
});

test('aggregate refuses every missing, duplicate, failed, cancelled and skipped shard', () => {
  const names = shardPlan().map((s) => s.id);
  const results = names.map((id) => ({
    id,
    conclusion: 'success',
    ...(id === 'root' ? { files: rootNodeInventory().files } : {}),
  }));
  assert.doesNotThrow(() => requireShardResults(results, names));
  for (const name of names) {
    assert.throws(() =>
      requireShardResults(
        results.filter((r) => r.id !== name),
        names
      )
    );
    assert.throws(() =>
      requireShardResults([...results, results.find((r) => r.id === name)], names)
    );
    for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', undefined])
      assert.throws(() =>
        requireShardResults(
          results.map((r) => (r.id === name ? { ...r, conclusion } : r)),
          names
        )
      );
  }
});

test('workflow matrix derives its complete membership and aggregate fails closed', () => {
  const { jobs } = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  assert.equal(jobs['l0-l2-shards'].strategy['fail-fast'], false);
  assert.equal(
    jobs['l0-l2-shards'].strategy.matrix,
    '$' + '{{ fromJSON(needs.l0-l2-plan.outputs.matrix) }}'
  );
  assert.ok(jobs['l0-l2'].needs.includes('l0-l2-shards'));
  assert.match(jobs['l0-l2'].if, /always\(\)/);
  assert.ok(
    jobs['l0-l2'].steps.some(
      (s) =>
        /needs\.l0-l2-shards\.result/.test(s.env?.SHARDS_RESULT ?? '') &&
        /success/.test(s.run ?? '')
    )
  );
});

test('root shard executes nested script tests exactly once without taking the full host lane', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-root-inventory-'));
  const previousPath = process.env.PATH;
  const previousContext = process.env.NODE_TEST_CONTEXT;
  const hostCondition = parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs[
    'app-image-admin-recovery'
  ].if;
  try {
    for (const directory of [
      'tests',
      'scripts/host-worker-update',
      'scripts/new/deeper',
      'scripts/docker',
      '.github/workflows',
      'bin',
    ])
      mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    const observed = (name) =>
      `import {appendFileSync} from 'node:fs'; appendFileSync('executed', '${name}\\n');\n`;
    writeFileSync(join(root, 'tests/root.test.mjs'), observed('root'));
    writeFileSync(
      join(root, 'scripts/host-worker-update/update-worker-environment.test.mjs'),
      observed('worker')
    );
    writeFileSync(join(root, 'scripts/new/deeper/future.test.mjs'), observed('future'));
    writeFileSync(
      join(root, 'scripts/docker/app-admin-recovery-smoke.test.mjs'),
      '// openkit-test-container-subject\nthrow Error("host test must not run in root");\n'
    );
    writeFileSync(join(root, 'scripts/check-openkit-cli.mjs'), '');
    writeFileSync(
      join(root, '.github/workflows/ci.yml'),
      `jobs:\n  app-image-admin-recovery:\n    if: ${hostCondition}\n    steps:\n      - run: bash scripts/test-env.sh host node --test scripts/docker/app-admin-recovery-smoke.test.mjs\n`
    );
    for (const name of ['pnpm', 'git'])
      writeFileSync(join(root, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${join(root, 'bin')}:${previousPath}`;
    // This fixture launches a separate Node test runner; inherited worker metadata would suppress its execution.
    delete process.env.NODE_TEST_CONTEXT;
    rootSuite({ root });
    assert.deepEqual(readFileSync(join(root, 'executed'), 'utf8').trim().split('\n').sort(), [
      'future',
      'root',
      'worker',
    ]);
    writeFileSync(
      join(root, 'scripts/release-tests.mjs'),
      readFileSync('scripts/release-tests.mjs')
    );
    writeFileSync(
      join(root, 'scripts/release-ci-reuse.mjs'),
      "console.log('Fixture exact-source execution citation');\n"
    );
    const reuse = parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs[
      'l0-l2-shards'
    ].steps.find((step) => step.id === 'reuse');
    const reused = spawnSync('bash', ['-e', '-c', reuse.run], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SHARD_ID: 'root',
        GITHUB_REPOSITORY: 'example/openkit',
        GITHUB_SHA: 'a'.repeat(40),
        GITHUB_OUTPUT: join(root, 'outputs'),
        GITHUB_STEP_SUMMARY: join(root, 'summary'),
      },
    });
    assert.equal(reused.status, 0, reused.stderr);
    const record = JSON.parse(readFileSync(join(root, 'temp/ci-shards/root.json'), 'utf8'));
    assert.deepEqual(record.files, rootNodeInventory(root).files);
    assert.equal(record.reuse, 'Fixture exact-source execution citation');
    const workflowPath = join(root, '.github/workflows/ci.yml');
    const workflow = readFileSync(workflowPath, 'utf8');
    writeFileSync(
      workflowPath,
      workflow.replace('app-image-admin-recovery:', 'duplicate-host:') +
        workflow.slice('jobs:\n'.length)
    );
    assert.throws(() => rootNodeInventory(root), /Missing or duplicate/);
    writeFileSync(
      workflowPath,
      workflow +
        '      - run: bash scripts/test-env.sh host node --test scripts/docker/app-admin-recovery-smoke.test.mjs\n'
    );
    assert.throws(() => rootNodeInventory(root), /Missing or duplicate/);
    writeFileSync(workflowPath, 'jobs:\n');
    assert.throws(() => rootNodeInventory(root), /Missing or duplicate/);
    writeFileSync(
      workflowPath,
      workflow.replace(
        hostCondition,
        "github.event_name == 'workflow_dispatch' && inputs.gate != 'full'"
      )
    );
    assert.throws(() => rootNodeInventory(root), /Missing or duplicate/);
  } finally {
    process.env.PATH = previousPath;
    if (previousContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousContext;
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate refuses missing, foreign and duplicate root/script execution files', () => {
  const names = shardPlan().map((s) => s.id);
  const files = rootNodeInventory().files;
  const results = names.map((id) => ({
    id,
    conclusion: 'success',
    ...(id === 'root' ? { files } : {}),
  }));
  assert.doesNotThrow(() => requireShardResults(results, names));
  for (const wrong of [
    undefined,
    files.slice(1),
    [...files, files[0]],
    [...files, 'scripts/missing.test.mjs'],
  ])
    assert.throws(() =>
      requireShardResults(
        results.map((r) => (r.id === 'root' ? { ...r, files: wrong } : r)),
        names
      )
    );
  const host = rootNodeInventory().host;
  assert.deepEqual(host, [
    { file: 'scripts/docker/app-admin-recovery-smoke.test.mjs', job: 'app-image-admin-recovery' },
  ]);
  assert.ok(!files.includes(host[0].file));
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.match(scripts['test:unit'], /node scripts\/release-tests\.mjs --root-node/);
});
