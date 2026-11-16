import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { candidateJobs } from '../scripts/release-publication-check.mjs';
import {
  collectRegistryEvidence,
  producerCandidate,
  readRegistryEvidence,
  validateRegistryEvidence,
} from '../scripts/release-registry-evidence.mjs';

test('same-run dependency admission requires every exact job including both installer runners', () => {
  const repository = 'example/openkit',
    source = 'a'.repeat(40),
    runId = 41,
    attempt = 2,
    images = [{ id: 'app' }, { id: 'worker-common' }, { id: 'worker-runtimes' }];
  const required = [...candidateJobs, ...images.map((image) => `Candidate index (${image.id})`)];
  const metadata = {
    head_sha: source,
    run_attempt: attempt,
    path: '.github/workflows/ci.yml',
    repository: { full_name: repository },
    event: 'workflow_dispatch',
    head_branch: 'main',
    status: 'in_progress',
  };
  const jobs = required.map((name, i) => ({
    id: i + 1,
    name,
    run_attempt: attempt,
    status: 'completed',
    conclusion: 'success',
  }));
  const invoke = (observations = jobs, run = metadata, total = observations.length) =>
    producerCandidate(repository, source, runId, runId, attempt, images, {
      read(endpoint, options) {
        if (endpoint === `repos/${repository}/actions/runs/${runId}`) return run;
        assert.equal(
          endpoint,
          `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`
        );
        assert.equal(options.paginate, true);
        return [{ total_count: total, jobs: observations }];
      },
    });
  assert.deepEqual(invoke(), { runId, attempt, jobs });
  for (const name of required) {
    assert.throws(
      () => invoke(jobs.filter((job) => job.name !== name)),
      /Complete current candidate dependencies required/,
      `missing ${name}`
    );
    assert.throws(
      () =>
        invoke(jobs.map((job) => (job.name === name ? { ...job, conclusion: 'failure' } : job))),
      /Complete current candidate dependencies required/,
      `failed ${name}`
    );
  }
  for (const patch of [
    { run_attempt: 1 },
    { status: 'in_progress', conclusion: null },
    { conclusion: 'skipped' },
  ])
    assert.throws(() => invoke([{ ...jobs[0], ...patch }, ...jobs.slice(1)]));
  assert.throws(() => invoke([...jobs, jobs[0]]));
  assert.throws(() => invoke(jobs, metadata, jobs.length + 1));
  for (const patch of [
    { head_sha: 'b'.repeat(40) },
    { run_attempt: 1 },
    { path: '.github/workflows/other.yml' },
    { repository: { full_name: 'outside/openkit' } },
    { event: 'pull_request' },
    { event: 'push', head_branch: 'other' },
  ])
    assert.throws(() => invoke(jobs, { ...metadata, ...patch }));
});

/** A registry read is separate from the original build, and both current attempts must agree. */
function fixture() {
  const image = {
    id: 'app',
    repository: 'openkit-app',
    kind: 'app',
    platforms: ['linux/amd64', 'linux/arm64'],
  };
  const context = {
    repository: 'example/openkit',
    source: 'a'.repeat(40),
    tag: 'v0.1.0-rc.99',
    inputs: 'b'.repeat(64),
    candidate: { runId: 41, attempt: 2, jobs: [{ id: 81, name: 'Candidate index (app)' }] },
    registry: { runId: 42, attempt: 3, jobs: [{ id: 82, name: 'Prerelease registry admission' }] },
    images: [image],
    notBefore: '2026-10-15T00:00:00Z',
    validUntil: '2026-10-15T01:00:00Z',
    now: new Date('2026-10-15T00:30:00Z'),
  };
  const candidate = {
    schemaVersion: 1,
    repository: context.repository,
    sha: context.source,
    tag: context.tag,
    inputs: context.inputs,
    provenance: { runId: 41, attempt: 2 },
    id: 'app',
    image: 'ghcr.io/example/openkit-app',
    digest: `sha256:${'c'.repeat(64)}`,
    platforms: image.platforms.map((platform, i) => ({
      platform,
      digest: `sha256:${String(i + 1).repeat(64)}`,
      labels: {
        'org.opencontainers.image.source': 'https://github.com/example/openkit',
        'org.opencontainers.image.revision': context.source,
        'org.opencontainers.image.version': context.tag.slice(1),
      },
      smoke: {
        sha: context.source,
        digest: `sha256:${String(i + 1).repeat(64)}`,
        conclusion: 'success',
      },
      appIdentity: { releaseTag: context.tag, sourceCommit: context.source },
    })),
  };
  const index = {
    manifests: candidate.platforms.map((p) => ({
      digest: p.digest,
      platform: { os: 'linux', architecture: p.platform.split('/')[1] },
    })),
  };
  const record = {
    schemaVersion: 1,
    repository: context.repository,
    sha: context.source,
    tag: context.tag,
    inputs: context.inputs,
    provenance: { runId: 42, attempt: 3 },
    candidate: { runId: 41, attempt: 2 },
    inspectionStartedAt: '2026-10-15T00:14:00Z',
    checkedAt: '2026-10-15T00:15:00Z',
    images: [
      {
        candidate,
        index,
        inspectedDigest: candidate.digest,
        state: { present: false, digest: '', latestBefore: '' },
      },
    ],
  };
  return { context, record };
}

test('CI evidence binds exact source, intended tag, both attempts, complete indexes and admission window', () => {
  const { context, record } = fixture();
  assert.equal(validateRegistryEvidence(record, context), record);
  const mutations = [
    (r) => delete r.schemaVersion,
    (r) => (r.repository = 'outside/openkit'),
    (r) => (r.sha = 'd'.repeat(40)),
    (r) => (r.tag = 'v0.1.0-rc.98'),
    (r) => (r.inputs = 'd'.repeat(64)),
    (r) => r.provenance.attempt--,
    (r) => r.provenance.runId++,
    (r) => r.candidate.attempt--,
    (r) => r.candidate.runId++,
    (r) => (r.checkedAt = '2026-10-14T23:59:59Z'),
    (r) => (r.checkedAt = '2026-10-15T00:31:00Z'),
    (r) => (r.checkedAt = 'invalid'),
    (r) => delete r.inspectionStartedAt,
    (r) => (r.inspectionStartedAt = '2026-10-14T23:59:59Z'),
    (r) => (r.images = []),
    (r) => r.images.push(r.images[0]),
    (r) => (r.images[0].candidate.sha = 'd'.repeat(40)),
    (r) => r.images[0].candidate.platforms.pop(),
    (r) => (r.images[0].candidate.platforms[0].smoke.conclusion = 'failure'),
    (r) => r.images[0].index.manifests.pop(),
    (r) => (r.images[0].inspectedDigest = `sha256:${'d'.repeat(64)}`),
    (r) => (r.images[0].state.present = 'false'),
    (r) => (r.images[0].state.digest = `sha256:${'d'.repeat(64)}`),
    (r) => delete r.images[0].state.latestBefore,
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(record);
    mutate(bad);
    assert.throws(() => validateRegistryEvidence(bad, context));
  }
  for (const patch of [
    { validUntil: '2026-10-15T00:30:00Z' },
    { notBefore: 'invalid' },
    { validUntil: 'invalid' },
    { images: [] },
  ])
    assert.throws(() => validateRegistryEvidence(record, { ...context, ...patch }));
  const retry = structuredClone(record);
  retry.images[0].state = {
    present: true,
    digest: retry.images[0].candidate.digest,
    latestBefore: '',
  };
  assert.doesNotThrow(() => validateRegistryEvidence(retry, context));
  retry.images[0].state.digest = `sha256:${'d'.repeat(64)}`;
  assert.throws(() => validateRegistryEvidence(retry, context));
});

test('local observation downloads only repository artifacts and rechecks the current attempt', () => {
  for (const outcome of [
    'passed',
    'missing',
    'mismatch',
    'rerun',
    'expired',
    'duplicate',
    'foreign-artifact',
    'replaced-artifact',
  ]) {
    const { context, record } = fixture(),
      root = mkdtempSync(join(tmpdir(), 'registry-evidence-driver-')),
      calls = [];
    let reads = 0;
    const run = (exe, args) => {
      calls.push([exe, ...args]);
      assert.equal(exe, 'gh');
      assert.equal(args[args.indexOf('--name') + 1], 'registry-admission-3');
      if (outcome === 'missing') throw Error('missing artifact');
      const data = structuredClone(record);
      if (outcome === 'mismatch') data.sha = 'd'.repeat(40);
      writeFileSync(
        join(args[args.indexOf('--dir') + 1], 'registry-admission.json'),
        JSON.stringify(data)
      );
      return '';
    };
    const observe = () => ({
      ...context.registry,
      sha: context.source,
      attempt: ++reads === 2 && outcome === 'rerun' ? 4 : 3,
    });
    try {
      let artifactReads = 0;
      const read = () => {
        const artifact = {
          id: ++artifactReads === 2 && outcome === 'replaced-artifact' ? 92 : 91,
          name: 'registry-admission-3',
          expired: outcome === 'expired',
          workflow_run: {
            id: 42,
            head_sha: outcome === 'foreign-artifact' ? 'd'.repeat(40) : context.source,
          },
        };
        const artifacts = outcome === 'duplicate' ? [artifact, artifact] : [artifact];
        return [{ total_count: artifacts.length, artifacts }];
      };
      const invoke = () =>
        readRegistryEvidence(
          { ...context, registryRunId: 42 },
          { run, observe, read, directory: join(root, 'download'), now: context.now }
        );
      if (outcome === 'passed') {
        const proof = invoke();
        assert.equal(proof.sha, context.source);
        assert.match(proof.recordSha256, /^[a-f0-9]{64}$/);
        assert.equal(reads, 2);
      } else assert.throws(invoke);
      assert.ok(calls.every((c) => c[0] === 'gh'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('registry producer refuses use outside its exact-source CI job before any registry command', () => {
  assert.throws(
    () =>
      collectRegistryEvidence({
        repository: 'example/openkit',
        source: 'a'.repeat(40),
        tag: 'v0.1.0-rc.99',
        directory: 'unused',
      }),
    /exact-source CI job/
  );
});
