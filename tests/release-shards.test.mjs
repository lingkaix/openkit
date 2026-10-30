// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
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

test('the sixteen-job plan preserves every owner and all four static tasks', () => {
  const owners = testOwners(process.cwd());
  const plan = shardPlan();
  assert.equal(plan.length, 16);
  assert.equal(new Set(plan.map((s) => s.id)).size, plan.length);
  assert.equal(plan.filter((s) => s.kind === 'root').length, 1);
  const statics = plan.filter((s) => s.kind === 'static');
  assert.deepEqual(
    statics.map((s) => s.id),
    ['static']
  );
  assert.deepEqual(statics.flatMap((s) => s.tasks).sort(), [
    'build',
    'check:repo',
    'lint',
    'typecheck',
  ]);
  for (const owner of owners) {
    const matches = plan.filter((s) => s.owners.includes(owner.name));
    const count =
      owner.name === '@openkit/nanocore' ? 8 : owner.name === '@openkit/worker-shim' ? 2 : 1;
    assert.equal(matches.length, count);
    for (const shard of matches) assert.equal(shard.kind, owner.vitest ? 'coverage' : 'native');
    if (count > 1) {
      assert.ok(matches.every((s) => s.owners.length === 1));
      assert.deepEqual(
        matches.map((s) => s.partition),
        Array.from({ length: count }, (_, index) => ({ index: index + 1, count }))
      );
      assert.deepEqual(
        matches.map((s) => s.id),
        Array.from(
          { length: count },
          (_, index) => `${owner.name.replace('@openkit/', '')}-${index + 1}`
        )
      );
    } else assert.equal(matches[0].partition, undefined);
  }
  assert.deepEqual(plan.find((s) => s.id === 'web').owners, ['@openkit/web']);
  assert.deepEqual(
    plan
      .find((s) => s.id === 'coverage-packages')
      .owners.slice()
      .sort(),
    owners
      .filter(
        (o) =>
          o.vitest &&
          !['@openkit/nanocore', '@openkit/worker-shim', '@openkit/web'].includes(o.name)
      )
      .map((o) => o.name)
      .sort()
  );
  assert.deepEqual(plan.find((s) => s.id === 'native-nanohost').owners, ['@openkit/nanohost']);
  assert.deepEqual(
    plan
      .find((s) => s.id === 'native-other')
      .owners.slice()
      .sort(),
    owners
      .filter((o) => !o.vitest && o.name !== '@openkit/nanohost')
      .map((o) => o.name)
      .sort()
  );
});

test('default aggregate requires split-owner coverage and the exact root inventory', () => {
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
    { id: 'nanocore', owners: ['@openkit/nanocore'], count: 8 },
    { id: 'worker-shim', owners: ['@openkit/worker-shim'], count: 2 },
  ]);
});

test('native groups preserve guarded owners and prepare Core only for NanoHost', () => {
  for (const shard of shardPlan().filter((s) => s.kind === 'native')) {
    const commands = [],
      packages = [];
    runShard(shard.id, {
      execute: (args) => commands.push(args),
      runPackage: (selected) => packages.push(selected.name),
    });
    assert.deepEqual(packages, shard.owners);
    assert.deepEqual(
      commands,
      shard.id === 'native-nanohost'
        ? [['pnpm', 'exec', 'turbo', 'run', 'build', '--filter=@openkit/nanocore...']]
        : []
    );
    for (const failed of shard.owners)
      assert.throws(
        () =>
          runShard(shard.id, {
            execute: () => {},
            runPackage: (selected) => {
              if (selected.name === failed) throw Error('guarded failure');
            },
          }),
        /guarded failure/
      );
    assert.throws(() => runShard(shard.id, { inventoryOnly: true }), /coverage shards only/);
  }
});

test('grouped coverage prepares once and writes a distinct original-owner execution report', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-coverage-group-'));
  try {
    for (const owner of testOwners(process.cwd())) {
      const directory = join(root, relative(process.cwd(), owner.cwd));
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name: owner.name,
          scripts: {
            test: owner.vitest ? 'vitest run --reporter=tap-flat' : 'fixture test',
            ...(owner.vitest ? { 'test:coverage': 'vitest run --coverage' } : {}),
          },
        })
      );
    }
    const prepared = [],
      executions = [];
    const details = runShard('coverage-packages', {
      root,
      prepare: (owners) => prepared.push(owners.map((owner) => owner.name)),
      runCoverage: (owner, options) => {
        executions.push({ owner: owner.name, options });
        return { name: owner.name, cases: 1 };
      },
    });
    const expected = shardPlan(root).find((shard) => shard.id === 'coverage-packages').owners;
    assert.equal(expected.length, 8);
    assert(expected.includes('@openkit/storage'));
    assert.deepEqual(prepared, [expected]);
    assert.deepEqual(
      executions.map((item) => item.owner),
      expected
    );
    assert.deepEqual(
      details.executions.map((item) => item.name),
      expected
    );
    assert.equal(new Set(executions.map((item) => item.options.reportFile)).size, expected.length);
    for (const { owner, options } of executions) {
      assert.equal(
        options.reportFile,
        join(root, 'temp/ci-shards', `${owner.replace('@openkit/', '')}-execution.report`)
      );
      assert.equal(options.partition, undefined);
      assert.equal(options.blobFile, undefined);
    }
    // Exercise the real shared-preparation CLI while observing, not bypassing, its build commands.
    mkdirSync(join(root, 'bin'));
    writeFileSync(
      join(root, 'bin/pnpm'),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> prepared-commands\n',
      { mode: 0o755 }
    );
    const preparation = spawnSync(
      process.execPath,
      [join(process.cwd(), 'scripts/ci-l0-l2.mjs'), '--prepare'],
      {
        cwd: root,
        env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
        encoding: 'utf8',
      }
    );
    assert.equal(preparation.status, 0, preparation.stdout + preparation.stderr);
    const commands = readFileSync(join(root, 'prepared-commands'), 'utf8').trim().split('\n');
    assert.equal(commands.length, 2);
    for (const owner of testOwners(root).filter((owner) => owner.vitest))
      assert.ok(
        commands[0].includes(
          `--filter=${owner.name}${owner.name === '@openkit/nanocore' ? '...' : '^...'}`
        )
      );
    assert.ok(commands[0].includes('--filter=@openkit/policy-kernel'));
    assert.ok(commands[0].includes('--filter=@openkit/storage'));
    assert.equal(commands[1], 'exec turbo run build --filter=@openkit/core-client...');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('each static group runs every selected task and propagates command failure', () => {
  for (const shard of shardPlan().filter((s) => s.kind === 'static')) {
    const commands = [];
    runShard(shard.id, { execute: (args) => commands.push(args) });
    assert.deepEqual(
      commands,
      shard.tasks.map((task) => ['pnpm', '-w', task])
    );
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

test('one exact-source build cache feeds every shard and worker probe without omitting prerequisites', () => {
  const { jobs } = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const build = jobs['l0-l2-build'];
  assert.ok(build.needs.includes('test-image'));
  assert.ok(
    build.steps.some((step) => /node scripts\/ci-l0-l2.mjs --prepare/.test(step.run ?? ''))
  );
  const uploaded = build.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(uploaded.with.path, '.turbo/cache');
  assert.equal(uploaded.with['include-hidden-files'], true);
  assert.equal(uploaded.with['if-no-files-found'], 'error');
  assert.match(uploaded.with.name, /github.sha/);
  assert.match(uploaded.with.name, /github.run_attempt/);
  assert.ok(!uploaded.with.name.startsWith('l0-l2-'), 'build cache is not a shard observation');
  for (const id of ['l0-l2-shards', 'l0-l2-worker-probes']) {
    assert.ok(jobs[id].needs.includes('l0-l2-build'));
    const downloaded = jobs[id].steps.find((step) => step.name === 'Restore shared build cache');
    assert.equal(downloaded.with.name, uploaded.with.name);
    assert.equal(downloaded.with.path, '.turbo/cache');
    assert.ok(!downloaded.with['run-id']);
    assert.ok(!downloaded['continue-on-error']);
    assert.ok(jobs[id].steps.some((step) => /pnpm install --frozen-lockfile/.test(step.run ?? '')));
  }
});

test('manual worker probes repeat exactly the Factory bin and never enter the coverage union', () => {
  const { jobs } = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const probe = jobs['l0-l2-worker-probes'];
  assert.equal(probe.if, "github.event_name == 'workflow_dispatch' && inputs.gate == 'l0-l2'");
  assert.deepEqual(probe.strategy.matrix, { workers: [3, 4] });
  assert.equal(probe.strategy['fail-fast'], false);
  assert.ok(!probe['continue-on-error']);
  const run = probe.steps.find((step) => step.env?.PROBE_WORKERS);
  assert.match(run.run, /--run nanocore-1 --workers/);
  assert.match(run.run, /nproc/);
  assert.match(run.run, /MemTotal/);
  const artifact = probe.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.match(artifact.with.name, /^ci-worker-probe-/);
  assert.ok(!artifact.with.name.startsWith('l0-l2-'));
  assert.ok(!jobs['l0-l2-shards'].steps.some((step) => /--workers/.test(step.run ?? '')));
  assert.ok(jobs['l0-l2-shards'].steps.some((step) => /nproc/.test(step.run ?? '')));
  assert.equal(shardPlan().length + probe.strategy.matrix.workers.length + 2, 20);
});

test('only NanoCore accepts bounded explicit worker probes, with two remaining the default', () => {
  for (const workers of [undefined, 2, 3, 4]) {
    const calls = [];
    const details = runShard('nanocore-1', {
      ...(workers === undefined ? {} : { workers }),
      prepare: () => {},
      runCoverage: (owner, options) => {
        calls.push(options);
        return { name: owner.name };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].workers, workers ?? 2);
    assert.equal(details.workers, workers ?? 2);
    assert.deepEqual(calls[0].partition, { index: 1, count: 8 });
  }
  for (const workers of [0, -1, 1.5, 5, NaN])
    assert.throws(
      () => runShard('nanocore-1', { workers, prepare: () => assert.fail() }),
      /workers/
    );
  assert.throws(() => runShard('root', { workers: 3 }), /workers/);
});

test('real Turbo cache restores removed outputs without rebuilding and rejects changed source', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-shared-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'packages/subject');
  mkdirSync(pkg, { recursive: true });
  const { packageManager } = JSON.parse(readFileSync('package.json', 'utf8'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, packageManager }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  writeFileSync(
    join(root, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/subject: {}\n"
  );
  writeFileSync(
    join(root, 'turbo.json'),
    JSON.stringify({
      tasks: {
        build: { inputs: ['package.json', 'build.mjs', 'value.txt'], outputs: ['dist/**'] },
      },
    })
  );
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@fixture/subject', scripts: { build: 'node build.mjs' } })
  );
  writeFileSync(join(pkg, 'value.txt'), 'original');
  writeFileSync(
    join(pkg, 'build.mjs'),
    "import{appendFileSync,mkdirSync,readFileSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/value.txt',readFileSync('value.txt'));appendFileSync('build-count','built\\n');"
  );
  const build = () => {
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/turbo/bin/turbo'),
        'run',
        'build',
        '--filter=@fixture/subject',
      ],
      { cwd: root, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  build();
  const snapshot = join(root, 'snapshot');
  cpSync(join(root, '.turbo/cache'), snapshot, { recursive: true });
  for (let consumer = 0; consumer < 2; consumer++) {
    rmSync(join(pkg, 'dist'), { recursive: true });
    rmSync(join(root, '.turbo/cache'), { recursive: true });
    cpSync(snapshot, join(root, '.turbo/cache'), { recursive: true });
    build();
    assert.equal(readFileSync(join(pkg, 'dist/value.txt'), 'utf8'), 'original');
    assert.equal(readFileSync(join(pkg, 'build-count'), 'utf8'), 'built\n');
  }
  writeFileSync(join(pkg, 'value.txt'), 'changed');
  rmSync(join(pkg, 'dist'), { recursive: true });
  build();
  assert.equal(readFileSync(join(pkg, 'dist/value.txt'), 'utf8'), 'changed');
  assert.equal(readFileSync(join(pkg, 'build-count'), 'utf8'), 'built\nbuilt\n');
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
