// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  WORKER_ENVIRONMENT_OPERATION_DEFINITIONS,
  workerEnvironmentActivationConfirmation,
} from '@openkit/app-api-schemas';
import { createReleaseManifest } from '../release-record.mjs';

const target = 'https://staging.example.invalid';
const tag = 'v0.1.0-rc.8';
const sourceCommit = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const childDigest = `sha256:${'c'.repeat(64)}`;
const appRequestId = '11111111-1111-4111-8111-111111111111';
const processStamp = {
  bootId: '22222222-2222-4222-8222-222222222222',
  pid: 123,
  startTimeTicks: '12345',
};
const predicates = Object.fromEntries(
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
  ].map((key) => [key, true])
);

/** Compose actual stages with public-schema responses and synthetic external-host facts. */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'component-update-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const evidence = path.join(root, 'attempt');
  const binding = {
    reference: 'staging-binding',
    sshAlias: 'a1',
    origin: target,
    machineId: 'd'.repeat(32),
    machineIdentityDigest: 'e'.repeat(64),
    container: 'openkit-app',
  };
  const manifest = createReleaseManifest({
    repository: 'lingkaix/openkit',
    tag,
    sha: sourceCommit,
    images: ['app', 'worker-common', 'worker-runtimes'].map((id) => ({
      id,
      image: `ghcr.io/lingkaix/openkit/${id}`,
      digest,
      prerelease: true,
      tags: [tag, tag.slice(1), `sha-${sourceCommit.slice(0, 12)}`],
      platforms: ['linux/amd64', 'linux/arm64'].map((platform) => ({
        platform,
        digest: childDigest,
      })),
    })),
    checksums: [
      `openkit-ops-skill-${tag}.tar.gz`,
      ...['amd64', 'arm64'].map((arch) => `openkit-nanohost-${tag}-linux-${arch}.tar.gz`),
    ]
      .map((name) => `${'f'.repeat(64)}  ${name}`)
      .join('\n'),
    assertions: {
      sourceCommit,
      appDigest: digest,
      previousAppImageId: digest,
      migrationFree: true,
      configurationCompatible: true,
      retainedDataCompatible: true,
      recovery: 'previous-image-compatible',
      provenance: 'synthetic-pair-assessment',
    },
  });
  const old = {
    archiveSha256: '1'.repeat(64),
    tag: 'v0.1.0-rc.7',
    sourceCommit: '2'.repeat(40),
    platform: 'linux/amd64',
    payloads: {
      nanohostSha256: '3'.repeat(64),
      gatewaySha256: '3'.repeat(64),
      unitFileSha256: '3'.repeat(64),
    },
  };
  const candidate = {
    archiveSha256: 'f'.repeat(64),
    tag,
    sourceCommit,
    platform: 'linux/amd64',
    payloads: {
      nanohostSha256: '4'.repeat(64),
      gatewaySha256: '5'.repeat(64),
      unitFileSha256: '6'.repeat(64),
    },
  };
  const assessment = {
    reference: 'protected-review',
    order: 'app-first',
    previousNanoHostArchiveSha256: old.archiveSha256,
    targetNanoHostArchiveSha256: candidate.archiveSha256,
    appSourceCommit: sourceCommit,
    appDigest: digest,
    admissionCompatible: true,
    readinessCompatible: true,
    commandCompatible: true,
    recoveryCompatible: true,
  };
  const grant = {
    reference: 'bounded-grant',
    target,
    environment: 'staging-test',
    revoked: false,
    operations: ['app-update', 'nanohost', 'worker-environment'],
    maintenance: 'idle-only',
    deploymentReference: binding.reference,
    transitionalPairAssessment: assessment,
  };
  const p = {
    manifest,
    platform: 'linux/amd64',
    grant,
    invocationReference: 'one-invocation',
    app: {
      expectedCurrentImageId: digest,
      helperSha256: '7'.repeat(64),
      retainedReads: [
        {
          operation: 'thread.read',
          input: {
            workspaceId: 'ws_0190f4c8-0000-7000-8000-000000000007',
            threadId: 'th_0190f4c8-0000-7000-8000-000000000008',
          },
        },
      ],
      pollAttempts: 1,
      pollMs: 1,
    },
    nanoHost: {
      replacementId: '33333333-3333-4333-8333-333333333333',
      previousEffectiveStateDigest: '8'.repeat(64),
    },
    worker: {
      prepare: {
        administrationThreadId: 'th_0190f4c8-0000-7000-8000-00000000000a',
        requestId: '44444444-4444-4444-8444-444444444444',
        configuration: { expectedRevision: digest, fileId: 'agents/worker.agent.jsonc' },
        target: { kind: 'agent', agentId: 'worker' },
        replaceNow: null,
      },
      activationRequestId: '55555555-5555-4555-8555-555555555555',
    },
  };
  const calls = [];
  let phase = 'old';
  const source = { tag, sourceCommit, appDigest: digest };
  const idle = () => ({
    observedAt: '2026-10-16T00:00:00Z',
    workspaceCount: 1,
    state: 'idle',
    counts: Object.fromEntries(
      [
        'runningTurns',
        'pendingTurns',
        'queuedAdmissions',
        'openAttempts',
        'closingAttempts',
        'inFlightCommands',
      ].map((key) => [key, 0])
    ),
  });
  const controls = {
    grant: () => structuredClone(grant),
    call: (_operation, out) => out,
    step: (_action, out) => out,
    archive: (kind) => structuredClone(kind === 'old' ? old : candidate),
  };
  const runtimeTarget = () => ({
    identityId: 'configured-host',
    deploymentId: 'dep_0190f4c8-0000-7000-8000-000000000001',
    connectionGeneration: phase === 'old' ? 7 : 8,
    physicalEpoch: (phase === 'old' ? 'a' : 'b').repeat(64),
    predecessorFenced: true,
    ready: true,
    freshEmpty: true,
    observedAt: '2026-10-16T00:00:00Z',
  });
  const io = {
    deploymentRecord: async () => structuredClone(binding),
    currentGrant: async () => controls.grant(),
    archiveAttribution: async (kind) => {
      calls.push(`archive:${kind}`);
      return controls.archive(kind);
    },
    identities: async () => ({
      ...binding,
      sourceCommit,
      appDigest: childDigest,
      webDigest: childDigest,
    }),
    sleep: async () => {},
    // A composition must replace these readers with the actual preceding stage results.
    appUpdateObservation: async () => assert.fail('caller App success reader must not run'),
    replacementObservation: async () => assert.fail('caller NanoHost success reader must not run'),
    runOperator: async (_target, { stdin }) => {
      const current = runtimeTarget();
      const process = {
        ...processStamp,
        pid: phase === 'old' ? 123 : 223,
        startTimeTicks: phase === 'old' ? '12345' : '22345',
      };
      const archive = phase === 'old' ? old : candidate;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stderr: '',
        stdout: JSON.stringify({
          nonce: JSON.parse(stdin).nonce,
          outcome: 'observed',
          machineIdentityDigest: binding.machineIdentityDigest,
          physicalEpoch: current.physicalEpoch,
          identityId: current.identityId,
          deploymentId: current.deploymentId,
          connectionGeneration: current.connectionGeneration,
          coordinator: process,
          executables: {
            nanohost: { process, sha256: archive.payloads.nanohostSha256 },
            gateway: {
              process: { ...process, pid: process.pid + 1 },
              sha256: archive.payloads.gatewaySha256,
            },
          },
          unit: {
            fileSha256: archive.payloads.unitFileSha256,
            effectiveStateDigest: (phase === 'old'
              ? '8'
              : phase === 'controlled'
                ? '9'
                : '0'
            ).repeat(64),
            activeState: 'active',
            subState: 'running',
          },
          replacementDuringMeasurement: false,
        }),
      };
    },
    runNanoHostStep: async (_target, request) => {
      const { action } = request;
      calls.push(`nanohost:${action}`);
      let out = { action, outcome: 'passed' };
      if (action === 'preflight')
        out = {
          ...out,
          posture: 'canonical-systemd',
          retainedInputsDigest: 'e'.repeat(64),
          stockEffectiveStateDigest: '8'.repeat(64),
        };
      if (action === 'begin' || action === 'vacate' || action === 'install')
        out = { ...out, fenced: true, inhibited: true };
      if (action === 'vacate') out.custodyVerified = true;
      if (action === 'install' || action === 'finalize')
        out = { ...out, payloads: candidate.payloads, retainedInputsDigest: 'e'.repeat(64) };
      if (action === 'start') {
        phase = 'controlled';
        out = {
          ...out,
          process: { ...processStamp, pid: 223, startTimeTicks: '22345' },
          controlledEffectiveStateDigest: '9'.repeat(64),
        };
      }
      if (action === 'finalize') {
        phase = 'final';
        out = {
          ...out,
          process: { ...processStamp, pid: 223, startTimeTicks: '22345' },
          supervisionRestored: true,
          effectiveStateDigest: '0'.repeat(64),
        };
      }
      return controls.step(action, structuredClone(out));
    },
    call: async (operation, input) => {
      calls.push(operation);
      let out;
      if (operation === 'nanohost.runtime-target') out = runtimeTarget();
      else if (operation === 'app-update.preflight') out = idle();
      else if (operation === 'thread.read')
        out = { thread: { id: 'retained-thread', content: 'unchanged retained bytes' } };
      else if (operation === 'app-update.prepare')
        out = {
          requestId: appRequestId,
          source,
          expectedCurrentImageId: digest,
          helperSha256: p.app.helperSha256,
          preparedHelperSha256: p.app.helperSha256,
          approvalSummary: {
            targetRelease: source,
            expectedCurrentImageId: digest,
            observedCurrentImageId: digest,
            interruptionScope: 'App restart',
            recoveryLimitations: ['Assessed previous image only'],
            safetyEvidence: { deploymentBindings: true, preflight: idle() },
          },
        };
      else if (operation === 'app-update.start') out = {};
      else if (operation === 'app-update.status')
        out = {
          requestId: appRequestId,
          source,
          outcome: 'succeeded',
          helperSha256: p.app.helperSha256,
          preparedHelperSha256: p.app.helperSha256,
          predicates,
        };
      else if (operation === 'worker-environment.prepare') {
        const definition = WORKER_ENVIRONMENT_OPERATION_DEFINITIONS[operation];
        const request = definition.inputSchema.parse(input);
        out = {
          requestId: request.requestId,
          target: request.target,
          configuration: request.configuration,
          replaceNow: request.replaceNow ?? null,
          affectedStorage: [],
          authoredCandidate: {
            artifactId: 'ar_0190f4c8-0000-7000-8000-000000000005',
            artifactVersion: 1,
            contentDigest: digest,
          },
          resolvedCandidate: {
            artifactId: 'ar_0190f4c8-0000-7000-8000-000000000006',
            artifactVersion: 1,
            contentDigest: digest,
          },
          preparedAt: '2026-10-16T00:00:00Z',
          image: {
            digest: childDigest,
            platform: { os: 'linux', architecture: 'amd64' },
            environmentDefaults: {
              names: ['LANG'],
              defaultsDigest: digest,
              classification: 'unadmitted',
            },
            storageLayout: {
              family: 'openkit-worker',
              version: '1',
              uid: 1000,
              gid: 1000,
              workingDirectory: '/workspace',
              targets: [{ target: '/workspace' }],
            },
          },
        };
        out.activationConfirmation = workerEnvironmentActivationConfirmation(out);
        out = definition.outputSchema.parse(out);
      } else if (operation === 'worker-environment.activate') {
        const definition = WORKER_ENVIRONMENT_OPERATION_DEFINITIONS[operation];
        const request = definition.inputSchema.parse(input);
        out = definition.outputSchema.parse({
          requestId: request.requestId,
          target: request.target,
          resolvedCandidate: request.resolvedCandidate,
          replaceNow: request.replaceNow,
          configuration: { fileId: request.configuration.fileId, revision: digest },
          affected: [],
        });
      } else assert.fail(`unexpected operation ${operation}`);
      return controls.call(operation, structuredClone(out));
    },
  };
  return { p, io, evidence, calls, controls, old, candidate };
}

/** Exercise the actual composition, with no replaceable stage functions. */
async function run(f) {
  const { updateComponents } = await import('./update-components.mjs');
  return updateComponents(target, f.p, f.evidence, f.io);
}

test('shared parameter admission is effect-free and rejects unknown instructions', async (t) => {
  const f = await fixture(t);
  const { admitComponentParameters } = await import('./update-components.mjs');
  const admitted = admitComponentParameters(f.p);
  assert.deepEqual(admitted, f.p);
  assert.notEqual(admitted, f.p);
  assert.throws(
    () => admitComponentParameters({ ...f.p, restore: true }),
    /closed release and component inputs/
  );
  assert.deepEqual(f.calls, []);
});

test('runs actual App, restored NanoHost and Worker stages in their mandatory order', async (t) => {
  const f = await fixture(t);
  const out = await run(f);
  assert.equal(out.outcome, 'passed');
  assert.equal(out.components.app.outcome, 'passed');
  assert.equal(out.components.nanohost.outcome, 'passed');
  assert.equal(out.components.worker.outcome, 'activated');
  assert.ok(f.calls.indexOf('app-update.status') < f.calls.indexOf('nanohost:preflight'));
  assert.ok(f.calls.indexOf('nanohost:finalize') < f.calls.indexOf('worker-environment.prepare'));
  assert.equal(f.calls.filter((op) => op === 'app-update.start').length, 1);
  assert.equal(f.calls.filter((op) => op === 'nanohost:start').length, 1);
  assert.equal(f.calls.filter((op) => op === 'worker-environment.activate').length, 1);
  const retained = JSON.parse(
    await fs.readFile(path.join(f.evidence, 'components-result.json'), 'utf8')
  );
  assert.equal(retained.schemaVersion, 1);
  assert.deepEqual(retained, { ...out, schemaVersion: 1 });
  assert.equal(out.components.app.reference, `${f.p.invocationReference}:app`);
  assert.equal(out.components.nanohost.reference, `${f.p.invocationReference}:nanohost`);
  for (const name of [
    'app/app-result.json',
    'nanohost/nanohost-result.json',
    'worker/worker-result.json',
    'components-result.json',
  ])
    await fs.access(path.join(f.evidence, name));
});

for (const [label, change] of [
  [
    'revoked grant',
    (f) => {
      f.controls.grant = () => ({ ...f.p.grant, revoked: true });
    },
  ],
  [
    'wrong old release pair',
    (f) => {
      f.p.grant.transitionalPairAssessment.previousNanoHostArchiveSha256 = 'f'.repeat(64);
    },
  ],
  [
    'wrong target archive',
    (f) => {
      f.candidate.archiveSha256 = '0'.repeat(64);
    },
  ],
  [
    'NanoHost-first assessment',
    (f) => {
      f.p.grant.transitionalPairAssessment.order = 'nanohost-first';
    },
  ],
  [
    'unknown component',
    (f) => {
      f.p.reset = true;
    },
  ],
  [
    'conflicting nested manifest',
    (f) => {
      f.p.app.manifest = f.p.manifest;
    },
  ],
  [
    'caller-supplied prior result',
    (f) => {
      f.p.nanoHost.appUpdateReference = 'asserted-success';
    },
  ],
  [
    'caller-supplied predecessor',
    (f) => {
      f.p.worker.previousPhysicalEpoch = 'a'.repeat(64);
    },
  ],
  [
    'unknown Worker preparation authority',
    (f) => {
      f.p.worker.prepare.command = 'invented-command';
    },
  ],
  [
    'missing Worker grant',
    (f) => {
      f.p.grant.operations = ['app-update', 'nanohost'];
    },
  ],
]) {
  test(`refuses ${label} before App effects`, async (t) => {
    const f = await fixture(t);
    change(f);
    await assert.rejects(run(f), /Component update:/);
    assert.ok(!f.calls.includes('app-update.prepare'));
    assert.ok(!f.calls.includes('app-update.start'));
    assert.ok(!f.calls.some((op) => op.startsWith('nanohost:')));
  });
}

test('a different actually running old archive cannot qualify the transitional pair before App', async (t) => {
  const f = await fixture(t);
  const inspect = f.io.runOperator;
  f.io.runOperator = async (...args) => {
    const reply = await inspect(...args);
    const observation = JSON.parse(reply.stdout);
    observation.executables.nanohost.sha256 = '0'.repeat(64);
    return { ...reply, stdout: JSON.stringify(observation) };
  };
  await assert.rejects(run(f), /Component update:/);
  assert.ok(!f.calls.includes('app-update.prepare'));
});

test('a changed protected assessment during App preparation stops before App start', async (t) => {
  const f = await fixture(t);
  f.controls.call = (operation, out) => {
    if (operation === 'app-update.prepare') {
      f.controls.grant = () => ({
        ...f.p.grant,
        transitionalPairAssessment: {
          ...f.p.grant.transitionalPairAssessment,
          reference: 'other-assessment',
        },
      });
    }
    return out;
  };
  await assert.rejects(run(f), /Component update:/);
  assert.ok(!f.calls.includes('app-update.start'));
  assert.ok(!f.calls.includes('nanohost:preflight'));
});

test('a grant revoked during the App identity read stops before preparation', async (t) => {
  const f = await fixture(t);
  const identities = f.io.identities;
  f.io.identities = async (...args) => {
    const actual = await identities(...args);
    f.controls.grant = () => ({ ...f.p.grant, revoked: true });
    return actual;
  };
  await assert.rejects(run(f), /Component update:/);
  assert.ok(!f.calls.includes('app-update.prepare'));
});

for (const outcome of ['unknown', 'failed', 'recovery_required']) {
  test(`App ${outcome} stops NanoHost and Worker without orchestration restore`, async (t) => {
    const f = await fixture(t);
    f.controls.call = (op, out) =>
      op === 'app-update.status' ? { ...out, outcome, previousAppRestored: false } : out;
    await assert.rejects(run(f), /Component update:/);
    assert.ok(
      !f.calls.some((op) => op.startsWith('nanohost:') || op.startsWith('worker-environment.'))
    );
    const out = JSON.parse(
      await fs.readFile(path.join(f.evidence, 'components-result.json'), 'utf8')
    );
    assert.equal(out.components.app.outcome, 'unknown');
    assert.equal(out.components.nanohost.outcome, 'not-run');
    assert.equal(out.components.worker.outcome, 'not-run');
  });
}

for (const failedAction of ['start', 'finalize']) {
  test(`unknown NanoHost ${failedAction} preserves successful App and blocks Worker`, async (t) => {
    const f = await fixture(t);
    f.controls.step = (action, out) => {
      if (action === failedAction) throw Error('invented-private-marker');
      return out;
    };
    await assert.rejects(run(f), /Component update:/);
    if (failedAction === 'start') assert.ok(!f.calls.includes('nanohost:finalize'));
    assert.ok(!f.calls.includes('worker-environment.prepare'));
    const out = JSON.parse(
      await fs.readFile(path.join(f.evidence, 'components-result.json'), 'utf8')
    );
    assert.equal(out.components.app.outcome, 'passed');
    assert.equal(out.components.nanohost.outcome, 'unknown');
    assert.equal(out.components.worker.outcome, 'not-run');
  });
}

for (const boundary of ['app', 'nanohost']) {
  test(`grant revocation after ${boundary} success stops the next component`, async (t) => {
    const f = await fixture(t);
    if (boundary === 'app') {
      f.controls.call = (operation, out) => {
        if (operation === 'app-update.status')
          f.controls.grant = () => ({ ...f.p.grant, revoked: true });
        return out;
      };
    } else {
      f.controls.step = (action, out) => {
        if (action === 'finalize') f.controls.grant = () => ({ ...f.p.grant, revoked: true });
        return out;
      };
    }
    await assert.rejects(run(f), /Component update:/);
    assert.ok(
      !f.calls.includes(boundary === 'app' ? 'nanohost:preflight' : 'worker-environment.prepare')
    );
  });
}

test('an App transport error is replaced before the App owner retains its reason', async (t) => {
  const f = await fixture(t);
  f.controls.call = (op, out) => {
    if (op === 'app-update.start') throw Error('invented-private-marker');
    return out;
  };
  await assert.rejects(run(f), /Component update:/);
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name));
      else
        assert.ok(
          !(await fs.readFile(path.join(dir, entry.name), 'utf8')).includes(
            'invented-private-marker'
          )
        );
    }
  };
  await walk(f.evidence);
});

test('an unknown Worker activation keeps App and NanoHost outcomes separate', async (t) => {
  const f = await fixture(t);
  f.controls.call = (op, out) => {
    if (op === 'worker-environment.activate') throw Error('invented-private-marker');
    return out;
  };
  await assert.rejects(run(f), /Component update:/);
  const out = JSON.parse(
    await fs.readFile(path.join(f.evidence, 'components-result.json'), 'utf8')
  );
  assert.equal(out.components.app.outcome, 'passed');
  assert.equal(out.components.nanohost.outcome, 'passed');
  assert.equal(out.components.worker.outcome, 'unknown');
});

test('a used parent directory prevents all independent reads and component effects', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.evidence);
  await assert.rejects(run(f), { code: 'EEXIST' });
  assert.deepEqual(f.calls, []);
});

for (const reason of [
  'machine-binding',
  'app-helper-identity',
  'canonical-docker-posture',
  'app-web-attribution',
  'invented-private-marker',
]) {
  test(`App prerequisite retains only a closed identity reason: ${reason}`, async (t) => {
    const f = await fixture(t);
    f.io.identities = async () => {
      throw Object.assign(Error('invented-private-marker'), {
        code: 'operator-identity-unavailable',
        operatorReason: reason,
      });
    };
    await assert.rejects(run(f), (error) =>
      reason === 'invented-private-marker'
        ? error.message.includes('App observation or effect unavailable')
        : error.message.includes(`App prerequisite unavailable (${reason})`)
    );
    assert.ok(!f.calls.includes('app-update.prepare'));
    assert.ok(!f.calls.includes('app-update.start'));
    const saved = await fs.readFile(path.join(f.evidence, 'components-result.json'), 'utf8');
    assert.doesNotMatch(saved, /invented-private-marker/);
  });
}
