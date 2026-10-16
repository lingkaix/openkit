// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { coveragePlan, requireShardResults, runShard, shardPlan } from '../scripts/ci-l0-l2.mjs';
import {
  rootNodeInventory,
  rootNodeSuite,
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

test('the complete plan splits only the two slow coverage owners and separates other tasks', () => {
  const owners = testOwners(process.cwd());
  const plan = shardPlan();
  assert.equal(new Set(plan.map((s) => s.id)).size, plan.length);
  assert.equal(plan.filter((s) => s.kind === 'root').length, 1);
  assert.deepEqual(
    plan
      .filter((s) => s.kind === 'static')
      .map((s) => s.id)
      .sort(),
    ['static-build', 'static-check-repo', 'static-lint', 'static-typecheck']
  );
  for (const owner of owners) {
    const matches = plan.filter((s) => s.owners.includes(owner.name));
    const split = ['@openkit/nanocore', '@openkit/worker-shim'].includes(owner.name);
    assert.equal(matches.length, split ? 8 : 1);
    for (const shard of matches) {
      assert.equal(shard.kind, owner.vitest ? 'coverage' : 'native');
      assert.deepEqual(shard.owners, [owner.name]);
    }
    if (split) {
      assert.deepEqual(
        matches.map((s) => s.partition),
        Array.from({ length: 8 }, (_, index) => ({ index: index + 1, count: 8 }))
      );
      assert.deepEqual(
        matches.map((s) => s.id),
        Array.from(
          { length: 8 },
          (_, index) => `${owner.name.replace('@openkit/', '')}-${index + 1}`
        )
      );
    } else assert.equal(matches[0].partition, undefined);
  }
});

test('default aggregate requires both merged coverage observations and the exact root inventory', () => {
  const results = [
    ...shardPlan().map((s) => s.id),
    'nanocore-coverage',
    'worker-shim-coverage',
  ].map((id) => ({
    id,
    conclusion: 'success',
    ...(id === 'root' ? { files: rootNodeInventory().files } : {}),
  }));
  assert.doesNotThrow(() => requireShardResults(results));
  for (const id of ['nanocore-coverage', 'worker-shim-coverage']) {
    assert.throws(() => requireShardResults(results.filter((r) => r.id !== id)));
    assert.throws(() => requireShardResults([...results, { id, conclusion: 'success' }]));
    assert.throws(() =>
      requireShardResults(results.map((r) => (r.id === id ? { ...r, conclusion: 'failure' } : r)))
    );
  }
});

test('coverage merge matrix contains exactly the partitioned owners', () => {
  assert.deepEqual(coveragePlan(), [
    { id: 'nanocore', owners: ['@openkit/nanocore'] },
    { id: 'worker-shim', owners: ['@openkit/worker-shim'] },
  ]);
});

test('native shards prepare Core only for NanoHost and propagate test failures', () => {
  const owners = testOwners(process.cwd()).filter((owner) => !owner.vitest);
  for (const owner of owners) {
    const commands = [],
      packages = [];
    const id = `native-${owner.name.replace('@openkit/', '')}`;
    runShard(id, {
      execute: (args) => commands.push(args),
      runPackage: (selected) => packages.push(selected.name),
    });
    assert.deepEqual(packages, [owner.name]);
    assert.deepEqual(
      commands,
      owner.name === '@openkit/nanohost'
        ? [['pnpm', '--filter', '@openkit/nanocore...', 'build']]
        : []
    );
    assert.throws(
      () =>
        runShard(id, {
          execute: () => {},
          runPackage: () => {
            throw Error('guarded failure');
          },
        }),
      /guarded failure/
    );
    assert.throws(() => runShard(id, { inventoryOnly: true }), /coverage shards only/);
  }
});

test('each static shard runs exactly its selected task and propagates command failure', () => {
  for (const shard of shardPlan().filter((s) => s.kind === 'static')) {
    const commands = [];
    runShard(shard.id, { execute: (args) => commands.push(args) });
    assert.deepEqual(commands, [['pnpm', '-w', shard.task]]);
    assert.throws(
      () =>
        runShard(shard.id, {
          execute: () => {
            throw Error('command failure');
          },
        }),
      /command failure/
    );
  }
  assert.throws(() => runShard('unknown'), /Unknown/);
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

// The root gate's real P29 native fixture requires Linux before tests start.
if (process.platform === 'linux') {
  test('root shard executes nested script tests exactly once without taking the full host lane', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-root-inventory-'));
    const previousPath = process.env.PATH;
    const previousContext = process.env.NODE_TEST_CONTEXT;
    const previousProducer = process.env.P29_TEST_PRODUCER_ROOT;
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
        'apps/nanohost/src',
      ])
        mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{}');
      const observed = (name) =>
        `import {appendFileSync} from 'node:fs'; appendFileSync('executed', '${name}\\n');\n`;
      writeFileSync(join(root, 'tests/root.test.mjs'), observed('root'));
      for (const file of [
        'update-worker-environment',
        'host-observation',
        'archive-attribution',
        'operator-inspection',
        'native-inspection',
      ])
        writeFileSync(join(root, `scripts/host-worker-update/${file}.test.mjs`), observed(file));
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
      writeFileSync(
        join(root, 'apps/nanohost/src/live_inspection.rs'),
        '// exact producer stand-in\n'
      );
      writeFileSync(join(root, 'apps/nanohost/mise.toml'), readFileSync('apps/nanohost/mise.toml'));
      writeFileSync(
        join(root, 'apps/nanohost/Cargo.toml'),
        '[package]\nname="fixture"\nversion="0.0.0"\n'
      );
      const pin = readFileSync('apps/nanohost/mise.toml', 'utf8').match(/^rust = "([^"]+)"$/m)[1];
      writeFileSync(
        join(root, 'bin/rustc'),
        `#!/bin/sh\nprintf '%s\\n' 'rustc ${pin} (fixture)'\n`,
        { mode: 0o755 }
      );
      writeFileSync(
        join(root, 'bin/cargo'),
        '#!/bin/sh\nprintf \'%s\\n\' "$*" >> native-preparation\n',
        { mode: 0o755 }
      );
      process.env.PATH = `${join(root, 'bin')}:${previousPath}`;
      // This fixture launches a separate Node test runner; inherited worker metadata would suppress its execution.
      delete process.env.NODE_TEST_CONTEXT;
      rootSuite({ root });
      assert.deepEqual(readFileSync(join(root, 'executed'), 'utf8').trim().split('\n').sort(), [
        'archive-attribution',
        'future',
        'host-observation',
        'native-inspection',
        'operator-inspection',
        'root',
        'update-worker-environment',
      ]);
      assert.deepEqual(
        existsSync(join(root, 'native-preparation'))
          ? readFileSync(join(root, 'native-preparation'), 'utf8').trim().split('\n')
          : [],
        [`fetch --locked --manifest-path ${join(root, 'apps/nanohost/Cargo.toml')}`]
      );
      const execution = readFileSync(join(root, 'executed'), 'utf8');
      process.env.P29_TEST_PRODUCER_ROOT = join(root, 'foreign-producer');
      assert.throws(() => rootNodeSuite({ root }), /same-checkout.*override/);
      assert.equal(readFileSync(join(root, 'executed'), 'utf8'), execution);
      delete process.env.P29_TEST_PRODUCER_ROOT;
      unlinkSync(join(root, 'apps/nanohost/src/live_inspection.rs'));
      assert.throws(() => rootNodeSuite({ root }), /P02.*producer/);
      assert.equal(readFileSync(join(root, 'executed'), 'utf8'), execution);
      writeFileSync(join(root, 'apps/nanohost/src/live_inspection.rs'), '// producer stand-in\n');
      writeFileSync(join(root, 'bin/rustc'), '#!/bin/sh\necho "rustc 0.0.0 (wrong)"\n', {
        mode: 0o755,
      });
      assert.throws(() => rootNodeSuite({ root }), /pinned Rust/);
      writeFileSync(join(root, 'bin/rustc'), `#!/bin/sh\necho 'rustc ${pin} (fixture)'\n`, {
        mode: 0o755,
      });
      writeFileSync(join(root, 'bin/cargo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      assert.throws(() => rootNodeSuite({ root }), /locked Cargo/);
      assert.equal(readFileSync(join(root, 'executed'), 'utf8'), execution);
      writeFileSync(
        join(root, 'scripts/release-tests.mjs'),
        readFileSync('scripts/release-tests.mjs')
      );
      writeFileSync(
        join(root, 'scripts/release-ci-reuse.mjs'),
        "console.log('Reused run 10 attempt 2 job 20');\n"
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
      const outputs = readFileSync(join(root, 'outputs'), 'utf8').trim().split('\n');
      assert.ok(outputs.includes('reused=true'));
      assert.ok(outputs.includes('run_id=10'));
      assert.ok(outputs.includes('attempt=2'));
      assert.equal(existsSync(join(root, 'temp/ci-shards/root.json')), false);
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
      if (previousProducer === undefined) delete process.env.P29_TEST_PRODUCER_ROOT;
      else process.env.P29_TEST_PRODUCER_ROOT = previousProducer;
      if (previousContext === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = previousContext;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('the merged P29 gate freezes all five required script files exactly once', () => {
  const files = rootNodeInventory().files.filter((file) =>
    file.startsWith('scripts/host-worker-update/')
  );
  if (files.length === 0) {
    assert.equal(
      existsSync('scripts/host-worker-update'),
      false,
      'an incomplete P29 directory is not admitted'
    );
  } else {
    for (const name of [
      'archive-attribution',
      'host-observation',
      'update-worker-environment',
      'operator-inspection',
      'native-inspection',
    ])
      assert.equal(
        files.filter((file) => file === `scripts/host-worker-update/${name}.test.mjs`).length,
        1
      );
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
