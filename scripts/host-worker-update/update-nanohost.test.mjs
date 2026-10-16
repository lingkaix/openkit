// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createReleaseManifest } from '../release-record.mjs';

const target = 'https://staging.example.invalid';
const tag = 'v0.1.0-rc.8';
const sourceCommit = 'a'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;
const childDigest = `sha256:${'c'.repeat(64)}`;
const binding = {
  reference: 'staging-binding',
  sshAlias: 'a1',
  origin: target,
  machineIdentityDigest: 'd'.repeat(64),
  container: 'openkit-app',
};
const processBefore = {
  bootId: '11111111-1111-4111-8111-111111111111',
  pid: 123,
  startTimeTicks: '1234',
};
const processAfter = { ...processBefore, pid: 223, startTimeTicks: '2234' };
const payloads = {
  nanohostSha256: '4'.repeat(64),
  gatewaySha256: '5'.repeat(64),
  unitFileSha256: '6'.repeat(64),
};
const finalDigest = '7'.repeat(64);
const controlledDigest = '8'.repeat(64);
const retainedDigest = '9'.repeat(64);
const actions = ['preflight', 'begin', 'vacate', 'install', 'start', 'finalize'];

/** Owner-derived synthetic publication and administrator evidence; this does not prove a real host. */
async function fixture(t, platform = 'linux/amd64') {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'nanohost-stage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = createReleaseManifest({
    repository: 'lingkaix/openkit',
    tag,
    sha: sourceCommit,
    images: ['app', 'worker-common', 'worker-runtimes'].map((id) => ({
      id,
      image: `ghcr.io/lingkaix/openkit/${id}`,
      digest: imageDigest,
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
      appDigest: imageDigest,
      previousAppImageId: imageDigest,
      migrationFree: true,
      configurationCompatible: true,
      retainedDataCompatible: true,
      recovery: 'previous-image-compatible',
      provenance: 'synthetic-reviewed-assessment',
    },
  });
  const old = {
    archiveSha256: '1'.repeat(64),
    tag: 'v0.1.0-rc.7',
    sourceCommit: '2'.repeat(40),
    platform,
    payloads: {
      nanohostSha256: '3'.repeat(64),
      gatewaySha256: '3'.repeat(64),
      unitFileSha256: '3'.repeat(64),
    },
  };
  const candidate = { archiveSha256: 'f'.repeat(64), tag, sourceCommit, platform, payloads };
  const assessment = {
    reference: 'protected-pair-review',
    order: 'app-first',
    previousNanoHostArchiveSha256: old.archiveSha256,
    targetNanoHostArchiveSha256: candidate.archiveSha256,
    appSourceCommit: sourceCommit,
    appDigest: imageDigest,
    admissionCompatible: true,
    readinessCompatible: true,
    commandCompatible: true,
    recoveryCompatible: true,
  };
  const grant = {
    reference: 'current-bounded-grant',
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
    platform,
    grant,
    replacementId: '22222222-2222-4222-8222-222222222222',
    reference: 'nanohost-this-invocation',
    appUpdateReference: 'app-this-invocation',
    invocationReference: 'current-update-invocation',
    previousEffectiveStateDigest: '0'.repeat(64),
  };
  const app = {
    reference: p.appUpdateReference,
    invocationReference: p.invocationReference,
    target,
    grantReference: grant.reference,
    deploymentReference: binding.reference,
    release: { tag, sourceCommit },
    transitionalPairAssessment: assessment,
    result: {
      domain: 'app',
      outcome: 'passed',
      tag,
      sourceCommit,
      requestId: '33333333-3333-4333-8333-333333333333',
      receipt: {
        requestId: '33333333-3333-4333-8333-333333333333',
        outcome: 'succeeded',
        source: { tag, sourceCommit, appDigest: imageDigest },
      },
      identities: { sourceCommit, appDigest: childDigest, webDigest: childDigest },
    },
  };
  let phase = 'old';
  let sampled;
  let read = 0;
  const calls = [];
  const samples = [];
  const controls = {
    binding: () => structuredClone(binding),
    grant: () => structuredClone(grant),
    archive: (kind) => structuredClone(kind === 'old' ? old : candidate),
    app: () => structuredClone(app),
    preflight: () => ({
      observedAt: '2026-10-16T00:00:00Z',
      workspaceCount: 1,
      state: 'idle',
      counts: {
        runningTurns: 0,
        pendingTurns: 0,
        queuedAdmissions: 0,
        openAttempts: 0,
        closingAttempts: 0,
        inFlightCommands: 0,
      },
    }),
    host: (host) => host,
    step: (_action, output) => output,
  };
  const host = () => {
    const isOld = phase === 'old';
    const process = structuredClone(isOld ? processBefore : processAfter);
    const archive = isOld ? old : candidate;
    const runtimeTarget = {
      identityId: 'configured-host',
      deploymentId: 'configured-deployment',
      connectionGeneration: isOld ? 7 : 8,
      physicalEpoch: (isOld ? 'a' : 'b').repeat(64),
      predecessorFenced: true,
      ready: true,
      freshEmpty: true,
      observedAt: '2026-10-16T00:00:00Z',
    };
    return controls.host({
      runtimeTarget,
      inspection: {
        nonce: 'e'.repeat(64),
        outcome: 'observed',
        machineIdentityDigest: binding.machineIdentityDigest,
        ...Object.fromEntries(
          ['identityId', 'deploymentId', 'connectionGeneration', 'physicalEpoch'].map((key) => [
            key,
            runtimeTarget[key],
          ])
        ),
        coordinator: process,
        executables: {
          nanohost: { process: structuredClone(process), sha256: archive.payloads.nanohostSha256 },
          gateway: {
            process: {
              ...process,
              pid: process.pid + 1,
              startTimeTicks: String(Number(process.startTimeTicks) + 1),
            },
            sha256: archive.payloads.gatewaySha256,
          },
        },
        unit: {
          fileSha256: archive.payloads.unitFileSha256,
          effectiveStateDigest: isOld
            ? p.previousEffectiveStateDigest
            : phase === 'controlled'
              ? controlledDigest
              : finalDigest,
          activeState: 'active',
          subState: 'running',
        },
        replacementDuringMeasurement: false,
      },
    });
  };
  const evidence = path.join(root, 'attempt');
  const io = {
    deploymentRecord: async () => controls.binding(),
    currentGrant: async () => controls.grant(),
    archiveAttribution: async (kind) => {
      calls.push(`archive:${kind}`);
      return controls.archive(kind);
    },
    appUpdateObservation: async (selected) => {
      assert.equal(selected, target);
      return controls.app();
    },
    call: async (operation) => {
      if (operation === 'app-update.preflight') return controls.preflight();
      assert.equal(operation, 'nanohost.runtime-target');
      if (read++ % 2 === 0) sampled = host();
      return structuredClone(sampled.runtimeTarget);
    },
    runOperator: async (selected, request) => {
      assert.equal(selected, target);
      const nonce = JSON.parse(request.stdin).nonce;
      samples.push({ phase, nonce });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stderr: '',
        stdout: JSON.stringify({ ...sampled.inspection, nonce }),
      };
    },
    runNanoHostStep: async (selected, request) => {
      assert.equal(selected, target);
      assert.deepEqual(
        Object.keys(request).sort(),
        [
          ...['action', 'replacementId', 'old', 'target'],
          ...(request.action === 'finalize' ? ['process'] : []),
        ].sort()
      );
      assert.deepEqual(request.old, old);
      assert.deepEqual(request.target, candidate);
      assert.equal(request.replacementId, p.replacementId);
      const intent = JSON.parse(
        await fs.readFile(path.join(evidence, `${request.action}-intent.json`), 'utf8')
      );
      assert.deepEqual(intent.input, request, 'the attempt must be retained before its effect');
      calls.push(request.action);
      let output = { action: request.action, outcome: 'passed' };
      switch (request.action) {
        case 'preflight':
          output = {
            ...output,
            posture: 'canonical-systemd',
            retainedInputsDigest: retainedDigest,
            stockEffectiveStateDigest: p.previousEffectiveStateDigest,
          };
          break;
        case 'begin':
          output = { ...output, fenced: true, inhibited: true };
          break;
        case 'vacate':
          output = { ...output, custodyVerified: true, fenced: true, inhibited: true };
          break;
        case 'install':
          output = {
            ...output,
            payloads,
            retainedInputsDigest: retainedDigest,
            fenced: true,
            inhibited: true,
          };
          break;
        case 'start':
          phase = 'controlled';
          output = {
            ...output,
            process: processAfter,
            controlledEffectiveStateDigest: controlledDigest,
          };
          break;
        case 'finalize':
          assert.deepEqual(request.process, processAfter);
          phase = 'final';
          output = {
            ...output,
            process: processAfter,
            payloads,
            retainedInputsDigest: retainedDigest,
            supervisionRestored: true,
            effectiveStateDigest: finalDigest,
          };
          break;
        default:
          assert.fail('unknown action');
      }
      return controls.step(request.action, structuredClone(output));
    },
  };
  return { p, io, controls, calls, evidence, samples, old, candidate, app, phase: () => phase };
}

/** Load the production entry only after the regression's input and expected effects exist. */
async function run(f) {
  const { updateNanoHost } = await import('./update-nanohost.mjs');
  return updateNanoHost(target, f.p, f.evidence, f.io);
}

for (const platform of ['linux/amd64', 'linux/arm64']) {
  test(`replaces the exact ${platform} archive and accepts only the restored same incarnation`, async (t) => {
    const f = await fixture(t, platform);
    const result = await run(f);
    assert.deepEqual(
      f.calls.filter((call) => actions.includes(call)),
      actions
    );
    assert.deepEqual(
      f.calls.filter((call) => call.startsWith('archive:')),
      ['archive:old', 'archive:target']
    );
    assert.equal(result.outcome, 'passed');
    assert.equal(result.reference, f.p.reference);
    assert.equal(result.target, target);
    assert.equal(result.grantReference, f.p.grant.reference);
    assert.deepEqual(result.release, { tag, sourceCommit });
    assert.notEqual(result.before.physicalEpoch, result.after.physicalEpoch);
    assert.ok(
      result.after.runtimeTarget.connectionGeneration >
        result.before.runtimeTarget.connectionGeneration
    );
    assert.equal(result.after.inspection.unit.effectiveStateDigest, finalDigest);
    assert.notEqual(result.after.inspection.unit.effectiveStateDigest, controlledDigest);
    assert.ok(f.samples.find(({ phase }) => phase === 'controlled'));
    assert.equal(f.samples.at(-1).phase, 'final');
    assert.equal(new Set(f.samples.map(({ nonce }) => nonce)).size, f.samples.length);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(f.evidence, 'nanohost-result.json'), 'utf8')),
      result
    );
  });
}

for (const [label, mutate] of [
  [
    'missing App result',
    (f) => {
      f.controls.app = () => null;
    },
  ],
  [
    'another invocation',
    (f) => {
      f.app.invocationReference = 'earlier-invocation';
    },
  ],
  [
    'another grant',
    (f) => {
      f.app.grantReference = 'other-grant';
    },
  ],
  [
    'another App receipt',
    (f) => {
      f.app.result.receipt.requestId = '44444444-4444-4444-8444-444444444444';
    },
  ],
  [
    'failed preceding App',
    (f) => {
      f.app.result.outcome = 'unknown';
    },
  ],
  [
    'unassessed App-first pair',
    (f) => {
      f.p.grant.transitionalPairAssessment.readinessCompatible = false;
    },
  ],
  [
    'unknown authority instruction',
    (f) => {
      f.p.command = 'invented-command';
    },
  ],
  [
    'wrong selected archive',
    (f) => {
      f.candidate.archiveSha256 = 'e'.repeat(64);
    },
  ],
  [
    'wrong old verified bytes',
    (f) => {
      f.old.payloads.nanohostSha256 = 'e'.repeat(64);
      f.controls.host = (host) => {
        host.inspection.executables.nanohost.sha256 = '3'.repeat(64);
        return host;
      };
    },
  ],
]) {
  test(`refuses ${label} before maintenance begins`, async (t) => {
    const f = await fixture(t);
    mutate(f);
    await assert.rejects(run(f), /NanoHost update:/);
    assert.ok(!f.calls.includes('begin'));
  });
}

for (const action of actions) {
  test(`a lost ${action} reply stops once and retains a fixed unknown diagnostic`, async (t) => {
    const f = await fixture(t);
    f.controls.step = (current, result) => {
      if (current === action) throw Error('invented-private-marker');
      return result;
    };
    await assert.rejects(run(f), /NanoHost update:/);
    assert.deepEqual(
      f.calls.filter((call) => actions.includes(call)),
      actions.slice(0, actions.indexOf(action) + 1)
    );
    const raw = await fs.readFile(path.join(f.evidence, 'nanohost-result.json'), 'utf8');
    assert.equal(JSON.parse(raw).outcome, 'unknown');
    for (const file of await fs.readdir(f.evidence))
      assert.ok(
        !(await fs.readFile(path.join(f.evidence, file), 'utf8')).includes(
          'invented-private-marker'
        )
      );
  });
}

for (const action of actions.slice(1)) {
  for (const change of ['grant', 'binding', 'idle', 'app']) {
    test(`rereads ${change} before ${action}`, async (t) => {
      const f = await fixture(t);
      const previous = actions[actions.indexOf(action) - 1];
      f.controls.step = (current, result) => {
        if (current === previous) {
          if (change === 'grant') f.controls.grant = () => ({ ...f.p.grant, revoked: true });
          if (change === 'binding')
            f.controls.binding = () => ({ ...binding, container: 'other-container' });
          if (change === 'idle')
            f.controls.preflight = () => ({
              observedAt: '2026-10-16T00:00:00Z',
              workspaceCount: 1,
              state: 'busy',
              counts: {
                runningTurns: 1,
                pendingTurns: 0,
                queuedAdmissions: 0,
                openAttempts: 0,
                closingAttempts: 0,
                inFlightCommands: 0,
              },
            });
          if (change === 'app')
            f.controls.app = () => ({ ...f.app, invocationReference: 'earlier' });
        }
        return result;
      };
      await assert.rejects(run(f), /NanoHost update:/);
      assert.ok(!f.calls.includes(action));
    });
  }
}

for (const [label, action, mutate] of [
  [
    'unsupported posture',
    'preflight',
    (out) => {
      out.posture = 'other';
    },
  ],
  [
    'unproved fencing',
    'begin',
    (out) => {
      out.fenced = false;
    },
  ],
  [
    'unproved custody',
    'vacate',
    (out) => {
      out.custodyVerified = false;
    },
  ],
  [
    'partial target install',
    'install',
    (out) => {
      delete out.payloads.gatewaySha256;
    },
  ],
  [
    'changed retained inputs',
    'install',
    (out) => {
      out.retainedInputsDigest = 'e'.repeat(64);
    },
  ],
  [
    'different started process',
    'start',
    (out) => {
      out.process.pid++;
    },
  ],
  [
    'failed stock restoration',
    'finalize',
    (out) => {
      out.supervisionRestored = false;
    },
  ],
  [
    'changed final process',
    'finalize',
    (out) => {
      out.process.startTimeTicks = '9988';
    },
  ],
  [
    'temporary final digest',
    'finalize',
    (out) => {
      out.effectiveStateDigest = controlledDigest;
    },
  ],
]) {
  test(`stops on ${label}`, async (t) => {
    const f = await fixture(t);
    f.controls.step = (current, out) => {
      if (current === action) mutate(out);
      return out;
    };
    await assert.rejects(run(f), /NanoHost update:/);
    assert.ok(!f.calls.includes(actions[actions.indexOf(action) + 1]));
    assert.notEqual(
      JSON.parse(await fs.readFile(path.join(f.evidence, 'nanohost-result.json'), 'utf8')).outcome,
      'passed'
    );
  });
}

for (const [label, mutate] of [
  [
    'same physical Epoch',
    (host) => {
      host.runtimeTarget.physicalEpoch = 'a'.repeat(64);
      host.inspection.physicalEpoch = 'a'.repeat(64);
    },
  ],
  [
    'same generation',
    (host) => {
      host.runtimeTarget.connectionGeneration = 7;
      host.inspection.connectionGeneration = 7;
    },
  ],
  [
    'changed deployment',
    (host) => {
      host.runtimeTarget.deploymentId = 'other';
      host.inspection.deploymentId = 'other';
    },
  ],
  [
    'process replacement after restoration',
    (host) => {
      host.inspection.coordinator.pid += 10;
      host.inspection.executables.nanohost.process.pid = host.inspection.coordinator.pid;
    },
  ],
]) {
  test(`rejects successor ${label}`, async (t) => {
    const f = await fixture(t);
    f.controls.host = (host) => {
      if (f.phase() === (label.startsWith('process') ? 'final' : 'controlled')) mutate(host);
      return host;
    };
    await assert.rejects(run(f), /NanoHost update:/);
  });
}

test('a prior evidence directory prevents every read and effect', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.evidence);
  await assert.rejects(run(f), { code: 'EEXIST' });
  assert.deepEqual(f.calls, []);
});

test('a valid same-Epoch reconnect before begin cannot refresh the admitted predecessor', async (t) => {
  const f = await fixture(t);
  f.controls.step = (action, out) => {
    if (action === 'preflight') {
      f.controls.host = (host) => {
        host.runtimeTarget.connectionGeneration++;
        host.inspection.connectionGeneration++;
        return host;
      };
    }
    return out;
  };
  await assert.rejects(run(f), /predecessor changed/);
  assert.ok(!f.calls.includes('begin'));
});

test('a valid same-Epoch reconnect after finalize cannot refresh the ready successor', async (t) => {
  const f = await fixture(t);
  f.controls.host = (host) => {
    if (f.phase() === 'final') {
      host.runtimeTarget.connectionGeneration++;
      host.inspection.connectionGeneration++;
    }
    return host;
  };
  await assert.rejects(run(f), /incarnation changed/);
});

test('the actual Worker stage accepts this separate restored replacement evidence', async (t) => {
  const f = await fixture(t);
  const result = await run(f);
  const { updateWorkerEnvironment } = await import('./update-worker-environment.mjs');
  let preparations = 0;
  const io = {
    ...f.io,
    replacementObservation: async () => result,
    call: async (operation, input) => {
      if (operation === 'worker-environment.prepare') {
        preparations++;
        throw Error('synthetic-prepare-stop');
      }
      return f.io.call(operation, input);
    },
  };
  await assert.rejects(
    updateWorkerEnvironment(
      target,
      {
        manifest: f.p.manifest,
        platform: f.p.platform,
        grant: f.p.grant,
        previousPhysicalEpoch: result.before.physicalEpoch,
        nanoHostReplacementReference: result.reference,
        prepare: {
          administrationThreadId: 'private-administration-thread',
          requestId: '55555555-5555-4555-8555-555555555555',
          configuration: { expectedRevision: imageDigest, fileId: 'agents/worker.agent.jsonc' },
          target: { kind: 'agent', agentId: 'worker' },
          replaceNow: null,
        },
        activationRequestId: '66666666-6666-4666-8666-666666666666',
      },
      path.join(path.dirname(f.evidence), 'worker'),
      io
    ),
    /operation outcome unknown/
  );
  assert.equal(
    preparations,
    1,
    'the existing consumer must admit the actual stage evidence before dispatch'
  );
});

test('strips inert annotations before retaining component or private host evidence', async (t) => {
  const f = await fixture(t);
  f.app.result.identities.rawMachineIdentifier = 'invented-private-marker';
  f.controls.step = (_action, out) => ({ ...out, explanation: 'invented-private-marker' });
  f.controls.host = (host) => {
    host.inspection.annotation = 'invented-private-marker';
    return host;
  };
  await run(f);
  for (const file of await fs.readdir(f.evidence)) {
    assert.ok(
      !(await fs.readFile(path.join(f.evidence, file), 'utf8')).includes('invented-private-marker')
    );
  }
});

for (const reason of ['canonical-systemd-posture', 'invented-private-marker']) {
  test(`operator prerequisite retains only a known closed reason: ${reason === 'canonical-systemd-posture'}`, async (t) => {
    const f = await fixture(t);
    f.controls.step = () => {
      const error = Error('invented-private-marker');
      error.code = 'operator-step-unavailable';
      error.operatorReason = reason;
      throw error;
    };
    await assert.rejects(run(f), /NanoHost update:/);
    const retained = await fs.readFile(path.join(f.evidence, 'nanohost-result.json'), 'utf8');
    assert.equal(retained.includes('invented-private-marker'), false);
    assert.equal(
      retained.includes('canonical-systemd-posture'),
      reason === 'canonical-systemd-posture'
    );
    assert.deepEqual(
      f.calls.filter((call) => actions.includes(call)),
      ['preflight']
    );
  });
}
