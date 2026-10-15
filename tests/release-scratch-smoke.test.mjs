import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { commitAt } from '../scripts/release-observe.mjs';
import { verifyLocalBinding } from '../scripts/release-post-smoke.mjs';
import { canonical, sha } from '../scripts/release-safety.mjs';
import {
  artifactFile,
  cleanupFixture,
  fixture,
  fixtureEnvironment,
  observeSmoke,
  resources,
  validateDispatch,
  validateResult,
  validateSubject,
  verify,
  waitReady,
} from '../scripts/release-scratch-smoke.mjs';

/** One selected read and a real process transition; no product result comes from this stand-in. */
function sample() {
  const d = (n) => `sha256:${String(n).repeat(64)}`;
  const subject = {
    repository: 'notrucked/openkit',
    tag: 'v0.0.0-cadence.1',
    sha: 'a'.repeat(40),
    runId: 11,
    attempt: 1,
    releaseId: 31,
    image: { digest: d(1) },
    manifestDigest: d(2),
    cli: { id: 41, name: 'skill.tar.gz', digest: d(3) },
    checksums: { id: 42, name: 'SHA256SUMS', digest: d(4) },
  };
  const smoke = {
    runId: 12,
    attempt: 2,
    jobId: 51,
    startedAt: '2026-10-16T00:00:00Z',
    completedAt: '2026-10-16T00:10:00Z',
  };
  const context = {
    subject,
    smoke,
    control: 'b'.repeat(40),
    notBefore: smoke.startedAt,
    validUntil: '2026-10-16T01:00:00Z',
    now: new Date('2026-10-16T00:15:00Z'),
  };
  const state = {
    containerId: 'c'.repeat(64),
    imageId: d(5),
    dataRoot: 'openkit-cadence-12-2-data',
    running: true,
    processId: 81,
    startedAt: '2026-10-16T00:01:00Z',
    finishedAt: '0001-01-01T00:00:00Z',
  };
  const record = {
    schemaVersion: 1,
    repository: subject.repository,
    tag: subject.tag,
    sha: subject.sha,
    control: context.control,
    publication: { runId: 11, attempt: 1, releaseId: 31 },
    smoke,
    cli: subject.cli,
    checksums: subject.checksums,
    image: {
      indexDigest: d(1),
      manifestDigest: d(2),
      imageId: d(5),
      configDigest: d(5),
      platform: 'linux/amd64',
      reportedSource: subject.sha,
      reportedTag: subject.tag,
    },
    prepareStartedAt: '2026-10-16T00:00:01Z',
    preparedAt: '2026-10-16T00:01:00Z',
    startedAt: '2026-10-16T00:01:01Z',
    outcome: 'passed',
    read: {
      operation: 'workspace.read',
      input: { workspaceId: 'synthetic' },
      fixtureName: 'Cadence scratch 12-2',
      canonicalization: 'canonical-json-v1',
      beforeSha256: 'd'.repeat(64),
      afterSha256: 'd'.repeat(64),
      beforeReadAt: '2026-10-16T00:02:00Z',
      afterReadAt: '2026-10-16T00:04:00Z',
    },
    restart: {
      before: state,
      stopped: { ...state, running: false, processId: 0, finishedAt: '2026-10-16T00:03:00Z' },
      after: { ...state, processId: 82, startedAt: '2026-10-16T00:03:10Z' },
      stoppedAt: '2026-10-16T00:03:01Z',
      restartedAt: '2026-10-16T00:03:11Z',
    },
    cleanup: {
      initial: {
        startedAt: '2026-10-16T00:04:01Z',
        endedAt: '2026-10-16T00:04:10Z',
        success: true,
        containerRemoved: true,
        volumeRemoved: true,
        temporaryRemoved: true,
        errors: [],
      },
      final: {
        startedAt: '2026-10-16T00:04:11Z',
        endedAt: '2026-10-16T00:04:20Z',
        success: true,
        containerRemoved: true,
        volumeRemoved: true,
        temporaryRemoved: true,
        errors: [],
      },
    },
    endedAt: '2026-10-16T00:05:00Z',
  };
  return { context, record };
}

test('scratch dispatch refuses unreviewed source, repository, forks and other triggers', () => {
  const context = {
    repository: 'notrucked/openkit',
    event: 'workflow_dispatch',
    fork: false,
    control: 'a'.repeat(40),
    source: 'a'.repeat(40),
    workflowSource: 'a'.repeat(40),
    ref: `refs/heads/scratch/cadence-smoke/${'a'.repeat(40)}`,
    runId: 1,
    attempt: 1,
  };
  assert.equal(validateDispatch(context), context);
  for (const change of [
    { repository: 'lingkaix/openkit' },
    { fork: true },
    { event: 'pull_request' },
    { event: 'pull_request_target' },
    { event: 'push' },
    { source: 'b'.repeat(40) },
    { workflowSource: 'b'.repeat(40) },
    { ref: 'refs/heads/main' },
    { attempt: 0 },
  ])
    assert.throws(() => validateDispatch({ ...context, ...change }));
  const { context: c } = sample();
  assert.equal(validateSubject(c.subject), c.subject);
  for (const change of [
    { repository: 'another/openkit' },
    { tag: 'v0.1.0' },
    { tag: 'https://example.invalid/script' },
    { runId: 0 },
  ])
    assert.throws(() => validateSubject({ ...c.subject, ...change }));
});

test('selected result refuses wrong identities, reads, absent restart, cleanup and time evidence', () => {
  const { context, record } = sample();
  assert.equal(validateResult(record, context), record);
  const mutations = [
    (r) => {
      r.repository = 'lingkaix/openkit';
    },
    (r) => {
      r.sha = 'f'.repeat(40);
    },
    (r) => {
      r.control = 'f'.repeat(40);
    },
    (r) => {
      r.tag = 'v0.1.0';
    },
    (r) => {
      r.publication.attempt++;
    },
    (r) => {
      r.smoke.attempt++;
    },
    (r) => {
      r.smoke.jobId++;
    },
    (r) => {
      r.cli.digest = `sha256:${'f'.repeat(64)}`;
    },
    (r) => {
      r.image.indexDigest = `sha256:${'f'.repeat(64)}`;
    },
    (r) => {
      r.image.platform = 'linux/arm64';
    },
    (r) => {
      r.image.configDigest = `sha256:${'f'.repeat(64)}`;
    },
    (r) => {
      r.read.operation = 'workspace.list';
    },
    (r) => {
      r.read.input.extra = true;
    },
    (r) => {
      r.read.afterSha256 = 'e'.repeat(64);
    },
    (r) => {
      r.read.fixtureName = 'another';
    },
    (r) => {
      delete r.restart;
    },
    (r) => {
      r.restart.after.startedAt = r.restart.before.startedAt;
    },
    (r) => {
      r.restart.after.processId = r.restart.before.processId;
    },
    (r) => {
      r.restart.stopped.running = true;
    },
    (r) => {
      r.restart.after.dataRoot = 'another';
    },
    (r) => {
      r.restart.after.imageId = `sha256:${'f'.repeat(64)}`;
    },
    (r) => {
      r.cleanup.initial.success = false;
    },
    (r) => {
      r.cleanup.final.volumeRemoved = false;
    },
    (r) => {
      r.cleanup.final.errors.push('failed');
    },
    (r) => {
      r.prepareStartedAt = '2026-10-15T23:59:59Z';
    },
    (r) => {
      r.endedAt = '2026-10-16T00:20:00Z';
    },
    (r) => {
      r.read.beforeReadAt = r.read.afterReadAt;
    },
    (r) => {
      r.rawOutput = 'not selected';
    },
    (r) => {
      r.outcome = 'failed';
    },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(record);
    mutate(copy);
    assert.throws(() => validateResult(copy, context));
  }
  assert.throws(() => validateResult(record, { ...context, validUntil: '2026-10-16T00:14:00Z' }));
});

test('artifact acceptance hashes the API ZIP and rejects duplicate, expired, replaced or foreign evidence', () => {
  const bytes = Buffer.from('controlled ZIP transport'),
    source = 'b'.repeat(40);
  const metadata = {
    id: 21,
    name: 'scratch-post-smoke-2',
    digest: `sha256:${sha(bytes)}`,
    expired: false,
    created_at: '2026-10-16T00:01:00Z',
    workflow_run: { id: 12, head_sha: source },
  };
  function readArtifact(change = {}) {
    const item = { ...metadata, ...change };
    return artifactFile(
      {
        runId: 12,
        source,
        name: metadata.name,
        filename: 'result.json',
        attemptStartedAt: '2026-10-16T00:00:00Z',
      },
      {
        read: (endpoint) =>
          endpoint.includes('?')
            ? [
                {
                  total_count: change.duplicate ? 2 : 1,
                  artifacts: change.duplicate ? [item, item] : [item],
                },
              ]
            : { ...item, ...(change.replaced ? { digest: `sha256:${'f'.repeat(64)}` } : {}) },
        download: (_id, file) => writeFileSync(file, change.corrupt ? 'wrong' : bytes),
        run: (_exe, args) =>
          args[0] === '-Z1'
            ? change.extra
              ? 'result.json\nprivate.bin'
              : 'result.json'
            : '{"fixture":"metadata only"}',
      }
    );
  }
  assert.equal(readArtifact().artifact.id, 21);
  for (const change of [
    { duplicate: true },
    { expired: true },
    { replaced: true },
    { corrupt: true },
    { extra: true },
    { created_at: '2026-10-15T23:59:59Z' },
    { workflow_run: { id: 13, head_sha: source } },
    { workflow_run: { id: 12, head_sha: 'a'.repeat(40) } },
  ])
    assert.throws(() => readArtifact(change));
});

test('local acceptance rechecks API attempts and never calls a registry', () => {
  const { context, record } = sample();
  // Use the actual current time only for this orchestration test's validity window.
  const start = new Date(Date.now() - 60000).toISOString(),
    end = new Date(Date.now() + 60000).toISOString();
  for (const key of ['prepareStartedAt', 'preparedAt', 'startedAt', 'endedAt']) record[key] = start;
  for (const key of ['beforeReadAt', 'afterReadAt']) record.read[key] = start;
  record.restart.stoppedAt = start;
  record.restart.restartedAt = start;
  for (const cleanup of Object.values(record.cleanup)) {
    cleanup.startedAt = start;
    cleanup.endedAt = start;
  }
  const smoke = {
    ...context.smoke,
    startedAt: start,
    completedAt: new Date().toISOString(),
    attemptStartedAt: start,
  };
  function run(changed) {
    let calls = 0;
    return verify(
      {
        subject: context.subject,
        control: context.control,
        runId: smoke.runId,
        notBefore: start,
        validUntil: end,
      },
      {
        commit: () => context.control,
        published: () => context.subject,
        observe: () => ({ ...smoke, attempt: ++calls > 1 && changed ? 3 : 2 }),
        artifact: () => ({ record, artifact: { id: 21, digest: `sha256:${'e'.repeat(64)}` } }),
      }
    );
  }
  assert.equal(run(false).outcome, 'passed');
  assert.throws(() => run(true));
});

test('smoke provenance requires the exact dispatch and one complete current-attempt job', () => {
  const control = 'b'.repeat(40);
  const run = {
    id: 12,
    repository: { full_name: 'notrucked/openkit', fork: false },
    event: 'workflow_dispatch',
    head_sha: control,
    head_branch: `scratch/cadence-smoke/${control}`,
    run_attempt: 2,
    path: '.github/workflows/release-scratch-smoke.yml',
    status: 'completed',
    conclusion: 'success',
    run_started_at: '2026-10-16T00:00:00Z',
  };
  const job = {
    id: 51,
    name: 'Published scratch amd64 retained-read smoke',
    run_attempt: 2,
    status: 'completed',
    conclusion: 'success',
    started_at: run.run_started_at,
    completed_at: '2026-10-16T00:05:00Z',
    steps: [
      'Install locked subject verifier dependencies',
      'Prepare published inputs',
      'Run credential-isolated fixture',
      'Confirm attempt cleanup',
      'Upload selected result',
    ].map((name) => ({ name, conclusion: 'success' })),
  };
  const observe = (changedRun = run, jobs = [job], total = jobs.length) =>
    observeSmoke(control, 12, {
      read: (endpoint) =>
        endpoint.includes('/jobs?') ? [{ total_count: total, jobs }] : changedRun,
    });
  assert.equal(observe().jobId, 51);
  for (const change of [
    { head_sha: 'a'.repeat(40) },
    { event: 'pull_request' },
    { event: 'pull_request_target' },
    { repository: { full_name: 'notrucked/openkit', fork: true } },
    { repository: { full_name: 'lingkaix/openkit', fork: false } },
    { path: '.github/workflows/ci.yml' },
    { head_branch: 'main' },
    { run_attempt: 3 },
    { status: 'in_progress' },
    { conclusion: 'failure' },
  ])
    assert.throws(() => observe({ ...run, ...change }));
  for (const jobs of [
    [],
    [job, job],
    [{ ...job, run_attempt: 1 }],
    [{ ...job, conclusion: 'skipped' }],
    [{ ...job, conclusion: 'failure' }],
    [{ ...job, name: 'another job' }],
  ])
    assert.throws(() => observe(run, jobs));
  assert.throws(() => observe(run, [job], 2));
  for (const step of job.steps) {
    for (const conclusion of [undefined, 'skipped', 'failure'])
      assert.throws(() =>
        observe(run, [
          {
            ...job,
            steps: job.steps.map((s) => (s.name === step.name ? { ...s, conclusion } : s)),
          },
        ])
      );
    assert.throws(() => observe(run, [{ ...job, steps: job.steps.filter((s) => s !== step) }]));
  }
});

test('cleanup removes only labelled attempt resources and reports failures separately', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scratch-cleanup-')),
    owned = resources(directory, { runId: 12, attempt: 2 });
  writeFileSync(join(directory, 'fixture-owner.json'), JSON.stringify({ nonce: owned.nonce }));
  for (const foreign of [false, true]) {
    let container = true,
      volume = true;
    const deleted = [];
    const result = cleanupFixture(owned, (args) => {
      if (args[1] === 'ls')
        return args[0] === 'container'
          ? container
            ? owned.container
            : ''
          : volume
            ? owned.volume
            : '';
      if (args[1] === 'inspect') return foreign ? 'foreign' : owned.nonce;
      if (args[1] === 'rm') {
        deleted.push(args.at(-1));
        if (args[0] === 'container') container = false;
        else volume = false;
        return '';
      }
      throw Error('Unexpected cleanup command');
    });
    assert.equal(result.success, !foreign);
    assert.equal(deleted.length, foreign ? 0 : 2);
    if (foreign)
      assert.deepEqual(result.errors, ['container-cleanup-failed', 'volume-cleanup-failed']);
  }
});

test('readiness has observed success and timeout outcomes and environments contain no inherited credential', async () => {
  await waitReady('http://127.0.0.1:1', {
    fetcher: async () => ({ ok: true }),
    milliseconds: 10,
    interval: 1,
  });
  await assert.rejects(
    waitReady('http://127.0.0.1:1', {
      fetcher: async () => ({ ok: false }),
      milliseconds: 5,
      interval: 1,
    }),
    /timeout/
  );
  assert.deepEqual(
    Object.keys(fixtureEnvironment('/private/fixture', 'http://127.0.0.1:1')).sort(),
    ['HOME', 'LANG', 'OPENKIT_NANOCORE_URL', 'PATH', 'TMPDIR', 'XDG_CONFIG_HOME'].sort()
  );
});

test('workflow freezes the separate scratch graph, exact control, token scopes and one selected upload', () => {
  const workflow = parse(readFileSync('.github/workflows/release-scratch-smoke.yml', 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ['scratch-smoke']);
  const job = workflow.jobs['scratch-smoke'];
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read', packages: 'read' });
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  for (const part of [
    "github.repository == 'notrucked/openkit'",
    'github.event.repository.fork == false',
    'github.sha == inputs.control_sha',
    'github.workflow_sha == inputs.control_sha',
    'scratch/cadence-smoke/{0}',
  ])
    assert.ok(job.if.includes(part));
  for (const step of job.steps) if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
  assert.equal(job.steps.filter((s) => s.env?.GH_TOKEN).length, 1);
  const prepare = job.steps.find((s) => s.name === 'Prepare published inputs');
  assert.equal(prepare.env.GH_TOKEN, '$' + '{{ github.token }}');
  const exercise = job.steps.find((s) => s.name === 'Run credential-isolated fixture');
  assert.match(exercise.run, /env -i /);
  assert.doesNotMatch(exercise.run, /TOKEN|DOCKER_CONFIG|\.config\/openkit-ops/);
  const upload = job.steps.find((s) => s.name === 'Upload selected result');
  assert.equal(upload.if, 'always()');
  assert.ok(upload.with.path.endsWith('-result/result.json'));
  assert.equal(upload.with.name, 'scratch-post-smoke-$' + '{{ github.run_attempt }}');
  assert.equal(job.steps.find((s) => s.name === 'Confirm attempt cleanup').if, 'always()');
  assert.equal(
    job.steps
      .filter((s) => s.uses?.startsWith('actions/checkout@'))
      .every((s) => s.with['persist-credentials'] === false),
    true
  );
  assert.equal(
    job.steps.find((s) => s.name === 'Install locked subject verifier dependencies')?.run,
    'pnpm install --frozen-lockfile --ignore-scripts'
  );
});

test('cleanup refuses an unowned temporary directory even if the resource names are absent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scratch-foreign-directory-'));
  try {
    writeFileSync(join(directory, 'unrelated'), 'retained');
    const result = cleanupFixture(resources(directory, { runId: 12, attempt: 2 }), () => '');
    assert.equal(result.success, false);
    assert.equal(result.temporaryRemoved, false);
    assert.equal(readFileSync(join(directory, 'unrelated'), 'utf8'), 'retained');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The actual fixture is admitted only on Linux amd64; other platforms retain the portable oracle tests.
if (process.platform === 'linux' && process.arch === 'x64') {
  test('the fixture driver admits restart and rejects command failure, timeout, changed reads and cleanup failure', async () => {
    // Controlled command observations admit the instrument. Only the hosted run proves product behavior.
    for (const fault of [undefined, 'create', 'timeout', 'read', 'restart', 'cleanup']) {
      const parent = mkdtempSync(join(tmpdir(), 'scratch-driver-'));
      const directory = join(parent, 'fixture');
      mkdirSync(directory);
      const { context } = sample();
      const source = commitAt('HEAD');
      const subject = {
        ...context.subject,
        sha: source,
        image: { ...context.subject.image, image: 'ghcr.io/notrucked/openkit-app' },
      };
      const owned = resources(directory, context.smoke);
      writeFileSync(join(directory, 'fixture-owner.json'), JSON.stringify({ nonce: owned.nonce }));
      writeFileSync(
        join(directory, 'prepared.json'),
        JSON.stringify({
          subject,
          control: source,
          smoke: context.smoke,
          imageId: `sha256:${'5'.repeat(64)}`,
          configDigest: `sha256:${'5'.repeat(64)}`,
          prepareStartedAt: new Date().toISOString(),
          preparedAt: new Date().toISOString(),
        })
      );
      let container = false,
        volume = false,
        running = true,
        restarted = false,
        readiness = 0;
      const calls = [];
      const workspace = { id: 'synthetic', name: `Cadence scratch ${owned.nonce}` };
      const state = () => [
        {
          Id: 'c'.repeat(64),
          Image: `sha256:${'5'.repeat(64)}`,
          Mounts: [{ Destination: '/data/openkit', Name: owned.volume, Type: 'volume' }],
          State: {
            Running: running,
            Pid: running ? (restarted ? 82 : 81) : 0,
            StartedAt:
              restarted && fault !== 'restart' ? '2026-10-16T00:03:10Z' : '2026-10-16T00:01:00Z',
            FinishedAt: '2026-10-16T00:03:00Z',
          },
          NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '12345' }] } },
        },
      ];
      const run = (program, args, options) => {
        calls.push([program, args]);
        assert.ok(options.env);
        for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'DOCKER_CONFIG', 'OPENKIT_NANOCORE_TOKEN'])
          assert.equal(options.env[key], undefined, key);
        assert.equal(options.env.HOME, join(directory, 'home'));
        if (program === 'docker') {
          assert.deepEqual(args.slice(0, 2), ['--host', 'unix:///var/run/docker.sock']);
          const a = args.slice(2);
          if (a[1] === 'ls')
            return a[0] === 'container'
              ? container
                ? owned.container
                : ''
              : volume
                ? owned.volume
                : '';
          if (a[0] === 'volume' && a[1] === 'create') {
            volume = true;
            return owned.volume;
          }
          if (a[0] === 'run') {
            assert.equal(a.includes('--env'), false);
            container = true;
            return 'c'.repeat(64);
          }
          if (a[1] === 'inspect')
            return a.includes('--format') ? owned.nonce : JSON.stringify(state());
          if (a[0] === 'stop') {
            assert.equal(
              JSON.parse(readFileSync(join(directory, 'prior-read.json'), 'utf8')).beforeSha256,
              sha(canonical(workspace))
            );
            running = false;
            return owned.container;
          }
          if (a[0] === 'start') {
            running = true;
            restarted = true;
            return owned.container;
          }
          if (a[1] === 'rm') {
            if (fault === 'cleanup') throw Error('Controlled cleanup failure');
            if (a[0] === 'container') container = false;
            else volume = false;
            return '';
          }
          throw Error('Unexpected fixture Docker command');
        }
        assert.equal(program, process.execPath);
        assert.equal(args[1], 'ops');
        if (args[3] === 'workspace.create' && fault === 'create')
          throw Error('Controlled operation failure');
        return JSON.stringify({ ok: true, operation: args[3], data: workspace });
      };
      try {
        const result = await fixture(
          { directory, subjectRoot: process.cwd() },
          {
            run,
            ready: async () => {
              if (++readiness === 2 && fault === 'timeout')
                throw Error('Fixture readiness timeout');
            },
            verifySkill: () => ({ cliPath: '/controlled/published-cli' }),
            load: async () => ({
              verifyLocalBinding,
              postPublicationSmoke: ({ params }, { run: execute }) => {
                assert.equal(restarted, true);
                assert.equal(params.reads[0].sha256, sha(canonical(workspace)));
                execute(
                  process.execPath,
                  ['/controlled/published-cli', 'ops', 'call', 'workspace.read'],
                  {}
                );
                if (fault === 'read') throw Error('Controlled retained read differs');
                return {
                  outcome: 'passed',
                  identities: { imageId: `sha256:${'5'.repeat(64)}` },
                  reads: [{ sha256: params.reads[0].sha256 }],
                  end: new Date().toISOString(),
                };
              },
            }),
          }
        );
        assert.equal(
          result.outcome,
          [undefined, 'cleanup'].includes(fault) ? 'passed' : 'failed',
          String(fault)
        );
        assert.equal(result.cleanup.initial.success, fault !== 'cleanup');
        assert.equal(existsSync(directory), false);
        assert.deepEqual(JSON.parse(readFileSync(owned.result, 'utf8')), result);
        if (!fault) {
          assert.equal(result.read.beforeSha256, result.read.afterSha256);
          assert.ok(calls.some(([, args]) => args.includes('stop')));
          assert.ok(calls.some(([, args]) => args.includes('start')));
        }
        if (fault === 'cleanup')
          assert.deepEqual(result.cleanup.initial.errors, [
            'container-cleanup-failed',
            'volume-cleanup-failed',
          ]);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  });
}
