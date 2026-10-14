import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createReleaseManifest } from '../scripts/release-notes.mjs';
import { updateApp, validateUpdate } from '../scripts/release-update-app.mjs';

const target = 'https://staging.example.invalid',
  sha = 'a'.repeat(40),
  digest = `sha256:${'b'.repeat(64)}`,
  previous = `sha256:${'c'.repeat(64)}`,
  tag = 'v0.1.0-rc.6',
  requestId = '12345678-1234-1234-1234-123456789abc';
/** Synthetic admitted inputs with exact reviewed assessment and public retained-record selector. */
function params() {
  const manifest = createReleaseManifest({
    repository: 'lingkaix/openkit',
    tag,
    sha,
    images: ['app', 'worker-common', 'worker-runtimes'].map((id) => ({
      id,
      image: `ghcr.io/example/${id}`,
      digest,
      prerelease: true,
      tags: [tag, tag.slice(1), `sha-${sha.slice(0, 12)}`],
      platforms: ['linux/amd64', 'linux/arm64'].map((platform) => ({ platform, digest })),
    })),
    checksums: [
      `openkit-ops-skill-${tag}.tar.gz`,
      ...['amd64', 'arm64'].map((a) => `openkit-nanohost-${tag}-linux-${a}.tar.gz`),
    ]
      .map((n) => `${'d'.repeat(64)}  ${n}`)
      .join('\n'),
    assertions: {
      sourceCommit: sha,
      appDigest: digest,
      previousAppImageId: previous,
      migrationFree: true,
      configurationCompatible: true,
      retainedDataCompatible: true,
      recovery: 'previous-image-compatible',
      provenance: 'synthetic-assessment',
    },
  });
  return {
    manifest,
    expectedCurrentImageId: previous,
    platform: 'linux/arm64',
    pollAttempts: 2,
    pollMs: 1,
    retainedReads: [
      {
        operation: 'thread.read',
        input: { workspaceId: 'example-workspace', threadId: 'example-retained-thread' },
      },
    ],
    grant: {
      target,
      environment: 'staging-test',
      reference: 'synthetic-standing-grant',
      revoked: false,
      operations: ['app-update'],
      maintenance: 'idle-only',
    },
  };
}
async function setup(t, change = () => {}) {
  const dir = path.join(await fs.mkdtemp(path.join(tmpdir(), 'release-update-test-')), 'attempt');
  t.after(() => fs.rm(path.dirname(dir), { recursive: true, force: true }));
  const p = params(),
    calls = [],
    source = { tag, sourceCommit: sha, appDigest: digest };
  const status = {
    requestId,
    source,
    outcome: 'succeeded',
    predicates: Object.fromEntries(
      [
        'imageMatch',
        'sourceMatch',
        'acceptingProductWork',
        'noBlockingReadiness',
        'newBoot',
        'retainedAuthRead',
        'nanohostReady',
        'helperReachable',
        'webAssets',
      ].map((k) => [k, true])
    ),
  };
  const io = {
    sleep: async () => {},
    identities: async () => ({ sourceCommit: sha, appDigest: digest, webDigest: digest }),
    call: async (op, input) => {
      calls.push(op);
      const data =
        op === 'app-update.preflight'
          ? {
              state: 'idle',
              observedAt: '2026-10-14T00:00:00Z',
              counts: Object.fromEntries(
                [
                  'runningTurns',
                  'pendingTurns',
                  'queuedAdmissions',
                  'openAttempts',
                  'closingAttempts',
                  'inFlightCommands',
                ].map((k) => [k, 0])
              ),
            }
          : op === 'thread.read'
            ? { thread: { id: input.threadId, name: 'retained content' } }
            : op === 'app-update.prepare'
              ? { requestId, source, expectedCurrentImageId: previous }
              : structuredClone(status);
      change(op, data, calls);
      return data;
    },
  };
  return { p, calls, dir, io };
}
test('App procedure preserves operation order and verifies retained Workspace reads separately', async (t) => {
  const { p, calls, dir, io } = await setup(t);
  const r = await updateApp(target, p, dir, io);
  assert.equal(r.outcome, 'passed');
  assert.deepEqual(calls, [
    'app-update.preflight',
    'thread.read',
    'app-update.prepare',
    'app-update.preflight',
    'app-update.start',
    'app-update.status',
    'thread.read',
  ]);
  assert.equal(r.downstream, 'NanoHost and Worker effects not run');
});
for (const [name, change] of [
  [
    'busy preflight',
    (op, d) => {
      if (op === 'app-update.preflight') d.counts.runningTurns = 1;
    },
  ],
  [
    'unknown receipt',
    (op, d) => {
      if (op === 'app-update.status') d.outcome = 'unknown';
    },
  ],
  [
    'failed readiness',
    (op, d) => {
      if (op === 'app-update.status') d.predicates.noBlockingReadiness = false;
    },
  ],
  [
    'stale receipt identity',
    (op, d) => {
      if (op === 'app-update.status') d.source.sourceCommit = 'f'.repeat(40);
    },
  ],
  [
    'changed retained content',
    (op, d, calls) => {
      if (op === 'thread.read' && calls.includes('app-update.start')) d.thread.name = 'changed';
    },
  ],
])
  test(`App procedure refuses ${name} and retains separate result`, async (t) => {
    const { p, dir, io } = await setup(t, change);
    await assert.rejects(updateApp(target, p, dir, io));
    const r = JSON.parse(await fs.readFile(path.join(dir, 'app-result.json'), 'utf8'));
    assert.equal(r.outcome, 'unknown');
    assert(r.reason);
  });
test('lost start response is retained and never resubmitted', async (t) => {
  const { p, calls, dir, io } = await setup(t);
  const original = io.call;
  io.call = async (op, input) => {
    if (op === 'app-update.start') {
      calls.push(op);
      throw Error('lost response');
    }
    return original(op, input);
  };
  await assert.rejects(updateApp(target, p, dir, io), /lost response/);
  assert.equal(calls.filter((op) => op === 'app-update.start').length, 1);
  await assert.rejects(updateApp(target, p, dir, io), /EEXIST/);
});
test('missing target, production and unassessed compatibility refuse before effects', () => {
  assert.throws(() => validateUpdate(undefined, params()));
  const p = params();
  p.grant.target = 'https://a2';
  assert.throws(() => validateUpdate('https://a2', p));
  p.manifest.assertions.migrationFree = false;
  assert.throws(() => validateUpdate(target, p));
});
