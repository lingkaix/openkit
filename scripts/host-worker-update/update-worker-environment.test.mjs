// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  AppUpdatePreflightResponseSchema,
  WORKER_ENVIRONMENT_OPERATION_DEFINITIONS,
  workerEnvironmentActivationConfirmation,
} from '../../packages/app-api-schemas/dist/index.js';
import { createReleaseManifest } from '../release-record.mjs';

const target = 'https://staging.example.invalid';
const sourceCommit = 'a'.repeat(40);
const indexDigest = `sha256:${'b'.repeat(64)}`;
const children = {
  'linux/amd64': `sha256:${'c'.repeat(64)}`,
  'linux/arm64': `sha256:${'d'.repeat(64)}`,
};
const revision = `sha256:${'e'.repeat(64)}`;
const previousPhysicalEpoch = '1'.repeat(64);
const currentPhysicalEpoch = '2'.repeat(64);
const replacementReference = 'preceding-nanohost-stage';
const tag = 'v0.1.0-rc.8';
const deployment = {
  reference: 'retained-staging-binding',
  sshAlias: 'a1',
  origin: target,
  machineIdentityDigest: '3'.repeat(64),
  container: 'openkit-app',
};

/** Builds publication facts through the existing manifest producer, with distinct index and child identities. */
function parameters(platform = 'linux/arm64') {
  const manifest = createReleaseManifest({
    repository: 'lingkaix/openkit',
    tag,
    sha: sourceCommit,
    images: ['app', 'worker-common', 'worker-runtimes'].map((id) => ({
      id,
      image: `ghcr.io/lingkaix/openkit/${id}`,
      digest: indexDigest,
      prerelease: true,
      tags: [tag, tag.slice(1), `sha-${sourceCommit.slice(0, 12)}`],
      platforms: Object.entries(children).map(([platform, digest]) => ({ platform, digest })),
    })),
    checksums: [
      `openkit-ops-skill-${tag}.tar.gz`,
      ...['amd64', 'arm64'].map(
        (architecture) => `openkit-nanohost-${tag}-linux-${architecture}.tar.gz`
      ),
    ]
      .map((name) => `${'f'.repeat(64)}  ${name}`)
      .join('\n'),
    assertions: {
      sourceCommit,
      appDigest: indexDigest,
      previousAppImageId: revision,
      migrationFree: true,
      configurationCompatible: true,
      retainedDataCompatible: true,
      recovery: 'previous-image-compatible',
      provenance: 'synthetic-reviewed-assessment',
    },
  });
  return {
    manifest,
    platform,
    previousPhysicalEpoch,
    nanoHostReplacementReference: replacementReference,
    prepare: {
      administrationThreadId: 'private-administration-thread',
      requestId: '11111111-1111-4111-8111-111111111111',
      configuration: { expectedRevision: revision, fileId: 'agents/worker.agent.jsonc' },
      target: { kind: 'agent', agentId: 'worker' },
      replaceNow: null,
    },
    activationRequestId: '22222222-2222-4222-8222-222222222222',
    grant: {
      reference: 'standing-staging-grant',
      target,
      environment: 'staging-test',
      revoked: false,
      operations: ['worker-environment'],
      maintenance: 'idle-only',
      deploymentReference: deployment.reference,
    },
  };
}

/** Observes orchestration only; these fixtures cannot establish actual runtime fences or host qualification. */
async function fixture(t, platform) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'worker-update-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = parameters(platform);
  const calls = [];
  const host = {
    machineIdentityDigest: deployment.machineIdentityDigest,
    archiveAttribution: {
      sourceCommit,
      tag,
      platform: p.platform,
      archiveSha256: 'f'.repeat(64),
      payloads: {
        nanohostSha256: '4'.repeat(64),
        gatewaySha256: '5'.repeat(64),
        unitFileSha256: '6'.repeat(64),
      },
    },
    physicalEpoch: currentPhysicalEpoch,
    runtimeTarget: {
      physicalEpoch: currentPhysicalEpoch,
      identityId: 'configured-nanohost',
      deploymentId: 'configured-deployment',
      connectionGeneration: 8,
      predecessorFenced: true,
      ready: true,
      freshEmpty: true,
      observedAt: '2026-10-15T00:00:00Z',
    },
  };
  host.runtimeTargetBefore = structuredClone(host.runtimeTarget);
  const process = {
    bootId: '11111111-1111-4111-8111-111111111111',
    pid: 123,
    startTimeTicks: '12345',
  };
  host.inspection = {
    nonce: '7'.repeat(64),
    outcome: 'observed',
    machineIdentityDigest: host.machineIdentityDigest,
    physicalEpoch: host.physicalEpoch,
    identityId: host.runtimeTarget.identityId,
    deploymentId: host.runtimeTarget.deploymentId,
    connectionGeneration: 8,
    coordinator: process,
    executables: {
      nanohost: {
        process: structuredClone(process),
        sha256: host.archiveAttribution.payloads.nanohostSha256,
      },
      gateway: {
        process: { ...process, pid: 124, startTimeTicks: '12346' },
        sha256: host.archiveAttribution.payloads.gatewaySha256,
      },
    },
    unit: {
      fileSha256: host.archiveAttribution.payloads.unitFileSha256,
      effectiveStateDigest: '8'.repeat(64),
      activeState: 'active',
      subState: 'running',
    },
    replacementDuringMeasurement: false,
  };
  // This upstream observation is fixed independently of caller parameter assertions.
  const replacement = {
    reference: replacementReference,
    target,
    grantReference: 'standing-staging-grant',
    outcome: 'passed',
    release: { tag, sourceCommit },
    before: {
      ...structuredClone(host),
      physicalEpoch: previousPhysicalEpoch,
      runtimeTarget: {
        ...structuredClone(host.runtimeTarget),
        physicalEpoch: previousPhysicalEpoch,
        connectionGeneration: 7,
      },
      runtimeTargetBefore: {
        ...structuredClone(host.runtimeTarget),
        physicalEpoch: previousPhysicalEpoch,
        connectionGeneration: 7,
      },
      inspection: {
        ...structuredClone(host.inspection),
        physicalEpoch: previousPhysicalEpoch,
        connectionGeneration: 7,
      },
      archiveAttribution: {
        ...structuredClone(host.archiveAttribution),
        sourceCommit: '8'.repeat(40),
        archiveSha256: '9'.repeat(64),
      },
    },
    after: structuredClone(host),
  };
  const controls = {
    host: () => structuredClone(host),
    binding: () => structuredClone(deployment),
    grant: () => structuredClone(p.grant),
    replacement: () => structuredClone(replacement),
    preflight: () =>
      AppUpdatePreflightResponseSchema.parse({
        observedAt: '2026-10-15T00:00:00Z',
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
    prepared: (value) => value,
    activation: (value) => value,
  };
  let prepared;
  let sampled;
  let bracketRead = 0;
  const io = {
    deploymentRecord: async () => controls.binding(),
    currentGrant: async () => controls.grant(),
    replacementObservation: async (selected) => {
      assert.equal(selected, target);
      return controls.replacement();
    },
    archiveAttribution: async () => structuredClone(host.archiveAttribution),
    runOperator: async (selected, { stdin }) => {
      const { nonce } = JSON.parse(stdin);
      assert.equal(selected, target);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(
          JSON.stringify({
            ...structuredClone(sampled.inspection),
            nonce,
            physicalEpoch: sampled.physicalEpoch,
            machineIdentityDigest: sampled.machineIdentityDigest,
          })
        ),
      };
    },
    call: async (operation, input) => {
      calls.push({ operation, input: structuredClone(input) });
      if (operation === 'nanohost.runtime-target') {
        if (bracketRead++ % 2 === 0) sampled = controls.host();
        return { ...structuredClone(sampled.runtimeTarget), physicalEpoch: sampled.physicalEpoch };
      }
      if (operation === 'app-update.preflight') return controls.preflight();
      const definition = WORKER_ENVIRONMENT_OPERATION_DEFINITIONS[operation];
      assert.ok(definition, `Unexpected operation: ${operation}`);
      // The real schema consumes the script's serialized request at this boundary.
      const request = definition.inputSchema.parse(JSON.parse(JSON.stringify(input)));
      if (operation === 'worker-environment.prepare') {
        const body = {
          requestId: request.requestId,
          target: request.target,
          configuration: request.configuration,
          replaceNow: request.replaceNow ?? null,
          affectedStorage: request.replaceNow
            ? [{ storageRef: `wst_${'4'.repeat(32)}`, expectedRevision: 3 }]
            : [],
          authoredCandidate: {
            artifactId: 'artifact-authored',
            artifactVersion: 1,
            contentDigest: revision,
          },
          resolvedCandidate: {
            artifactId: 'artifact-resolved',
            artifactVersion: 1,
            contentDigest: indexDigest,
          },
          preparedAt: '2026-10-15T00:00:00Z',
          image: {
            digest: children[p.platform],
            platform: { os: 'linux', architecture: p.platform.split('/')[1] },
            environmentDefaults: {
              names: ['LANG'],
              defaultsDigest: revision,
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
        body.activationConfirmation = workerEnvironmentActivationConfirmation(body);
        prepared = definition.outputSchema.parse(JSON.parse(JSON.stringify(body)));
        return controls.prepared(structuredClone(prepared));
      }
      assert.equal(operation, 'worker-environment.activate');
      const result = definition.outputSchema.parse(
        JSON.parse(
          JSON.stringify({
            requestId: request.requestId,
            target: request.target,
            resolvedCandidate: request.resolvedCandidate,
            replaceNow: request.replaceNow,
            configuration: { fileId: request.configuration.fileId, revision: indexDigest },
            affected: request.affectedStorage.map((entry) => ({
              ...entry,
              disposition: 'reattached',
            })),
          })
        )
      );
      return controls.activation(result);
    },
  };
  return {
    p,
    calls,
    controls,
    host,
    io,
    evidence: path.join(root, 'attempt'),
    prepared: () => prepared,
  };
}

/** Loads the new public seam lazily so the initial red result names its absence rather than a collection failure. */
async function run(f) {
  const { updateWorkerEnvironment } = await import('./update-worker-environment.mjs');
  return updateWorkerEnvironment(target, f.p, f.evidence, f.io);
}
const effects = (f) =>
  f.calls.filter(({ operation }) => operation.startsWith('worker-environment.'));
const activations = (f) =>
  f.calls.filter(({ operation }) => operation === 'worker-environment.activate');

for (const platform of Object.keys(children)) {
  test(`prepares exact published registry index and activates the ${platform} child through real schemas`, async (t) => {
    const f = await fixture(t, platform);
    const result = await run(f);
    assert.equal(result.domain, 'worker');
    assert.equal(result.outcome, 'activated');
    assert.equal(result.freshEpochPreparation, true);
    assert.deepEqual(
      effects(f).map(({ operation }) => operation),
      ['worker-environment.prepare', 'worker-environment.activate']
    );
    assert.deepEqual(effects(f)[0].input.declaration, {
      kind: 'reference',
      ref: `ghcr.io/lingkaix/openkit/worker-runtimes@${indexDigest}`,
      pullPolicy: 'always',
    });
    const activation = activations(f)[0].input;
    assert.equal(activation.requestId, f.p.activationRequestId);
    assert.deepEqual(activation.resolvedCandidate, f.prepared().resolvedCandidate);
    assert.deepEqual(activation.configuration, f.p.prepare.configuration);
    assert.equal(activation.confirmation, f.prepared().activationConfirmation);
    assert.deepEqual(result.prepared, f.prepared());
    assert.equal(result.activation.configuration.revision, indexDigest);
    assert.deepEqual(result.activation.affected, []);
    assert.equal(
      result.runtimeReady,
      undefined,
      'config-only success cannot establish a running Worker'
    );
  });
}

test('passes the exact successor prompt and affected storage revisions to ordinary activation', async (t) => {
  const f = await fixture(t);
  f.p.prepare.replaceNow = {
    workspaceId: 'workspace-one',
    threadId: 'worker-thread',
    prompt: 'Continue the admitted task.',
  };
  const result = await run(f);
  assert.deepEqual(activations(f)[0].input.replaceNow, f.p.prepare.replaceNow);
  assert.deepEqual(activations(f)[0].input.affectedStorage, f.prepared().affectedStorage);
  assert.equal(result.activation.affected[0].disposition, 'reattached');
});

for (const [name, change] of [
  [
    'missing host observation',
    (f) => {
      f.io.runOperator = undefined;
    },
  ],
  [
    'missing retained deployment observation',
    (f) => {
      f.io.deploymentRecord = undefined;
    },
  ],
  [
    'missing independent current grant observation',
    (f) => {
      f.io.currentGrant = undefined;
    },
  ],
  [
    'stable production binding',
    (f) => {
      f.controls.binding = () => ({ ...deployment, sshAlias: 'a2' });
    },
  ],
  [
    'wrong retained origin',
    (f) => {
      f.controls.binding = () => ({ ...deployment, origin: 'https://other.example.invalid' });
    },
  ],
  [
    'wrong host machine',
    (f) => {
      f.host.machineIdentityDigest = '5'.repeat(64);
    },
  ],
  [
    'wrong running Gateway',
    (f) => {
      f.host.inspection.executables.gateway.sha256 = '6'.repeat(64);
    },
  ],
  [
    'wrong running NanoHost',
    (f) => {
      f.host.inspection.executables.nanohost.sha256 = '7'.repeat(64);
    },
  ],
  [
    'missing physical Epoch',
    (f) => {
      delete f.host.physicalEpoch;
    },
  ],
  [
    'same physical Epoch despite newer connection',
    (f) => {
      f.host.physicalEpoch = previousPhysicalEpoch;
      f.host.runtimeTarget.connectionGeneration = 999;
    },
  ],
  [
    'non-fresh runtime',
    (f) => {
      f.host.runtimeTarget.freshEmpty = false;
    },
  ],
  [
    'unready runtime',
    (f) => {
      f.host.runtimeTarget.ready = false;
    },
  ],
  [
    'unfenced predecessor',
    (f) => {
      f.host.runtimeTarget.predecessorFenced = false;
    },
  ],
  [
    'revoked current grant',
    (f) => {
      f.controls.grant = () => ({ ...f.p.grant, revoked: true });
    },
  ],
  [
    'different current grant reference',
    (f) => {
      f.controls.grant = () => ({ ...f.p.grant, reference: 'other-grant' });
    },
  ],
  [
    'wrong grant deployment',
    (f) => {
      f.p.grant.deploymentReference = 'other-deployment';
    },
  ],
  [
    'missing Worker operation grant',
    (f) => {
      f.p.grant.operations = ['app-update'];
    },
  ],
  [
    'unknown manifest core',
    (f) => {
      f.p.manifest.schemaVersion = 99;
    },
  ],
  [
    'missing selected platform',
    (f) => {
      f.p.manifest.images.find((image) => image.id === 'worker-runtimes').platforms.pop();
    },
  ],
  [
    'unassessed continuity',
    (f) => {
      f.p.manifest.assertions.retainedDataCompatible = false;
    },
  ],
]) {
  test(`refuses ${name} before Worker effects`, async (t) => {
    const f = await fixture(t);
    change(f);
    await assert.rejects(() => run(f));
    assert.deepEqual(effects(f), []);
  });
}

for (const [name, change] of [
  [
    'wrong child digest',
    (body) => {
      body.image.digest = indexDigest;
    },
  ],
  [
    'wrong child platform',
    (body) => {
      body.image.platform.architecture = 'amd64';
    },
  ],
  [
    'changed request id',
    (body) => {
      body.requestId = '33333333-3333-4333-8333-333333333333';
    },
  ],
  [
    'changed configuration baseline',
    (body) => {
      body.configuration.expectedRevision = indexDigest;
    },
  ],
  [
    'changed target',
    (body) => {
      body.target.agentId = 'other-agent';
    },
  ],
  [
    'invalid candidate version',
    (body) => {
      body.resolvedCandidate.artifactVersion = 2;
    },
  ],
  [
    'invalid confirmation',
    (body) => {
      body.activationConfirmation = 'unbound-confirmation';
    },
  ],
]) {
  test(`refuses prepared ${name} without activation or recovery`, async (t) => {
    const f = await fixture(t);
    f.controls.prepared = (body) => {
      change(body);
      if (name !== 'invalid confirmation')
        body.activationConfirmation = workerEnvironmentActivationConfirmation(body);
      return body;
    };
    await assert.rejects(() => run(f));
    assert.deepEqual(
      effects(f).map(({ operation }) => operation),
      ['worker-environment.prepare']
    );
  });
}

for (const [name, change] of [
  [
    'revoked grant',
    (f) => {
      f.controls.grant = () => ({ ...f.p.grant, revoked: true });
    },
  ],
  [
    'changed host',
    (f) => {
      f.host.physicalEpoch = '9'.repeat(64);
    },
  ],
  [
    'changed retained binding',
    (f) => {
      f.controls.binding = () => ({ ...deployment, container: 'other-app' });
    },
  ],
  [
    'busy maintenance state',
    (f) => {
      f.controls.preflight = () => ({
        observedAt: '2026-10-15T00:00:01Z',
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
    },
  ],
]) {
  test(`rechecks ${name} after preparation and before activation`, async (t) => {
    const f = await fixture(t);
    f.controls.prepared = (body) => {
      change(f);
      return body;
    };
    await assert.rejects(() => run(f));
    assert.deepEqual(
      effects(f).map(({ operation }) => operation),
      ['worker-environment.prepare']
    );
  });
}

for (const stage of ['prepared', 'activation']) {
  test(`stops on uncertain ${stage} handoff without retry or automatic recovery`, async (t) => {
    const f = await fixture(t);
    f.controls[stage] = () => {
      throw Error('Synthetic uncertain handoff Bearer syntheticcredentialvalue');
    };
    await assert.rejects(() => run(f));
    assert.equal(effects(f).length, stage === 'prepared' ? 1 : 2);
    assert.equal(
      f.calls.some(({ operation }) => /recover|rollback|purge/.test(operation)),
      false
    );
    const entries = await fs.readdir(f.evidence);
    assert.ok(entries.length > 0, 'an uncertain outcome must retain inspection evidence');
    for (const entry of entries) {
      const filename = path.join(f.evidence, entry);
      const stat = await fs.stat(filename);
      if (!stat.isFile()) continue;
      assert.equal(stat.mode & 0o077, 0);
      assert.equal(
        (await fs.readFile(filename, 'utf8')).includes('syntheticcredentialvalue'),
        false
      );
    }
    const beforeReplay = f.calls.length;
    await assert.rejects(() => run(f));
    assert.equal(f.calls.length, beforeReplay, 'existing evidence must block all replay calls');
  });
}

for (const [name, change] of [
  [
    'missing observed configuration',
    (body) => {
      body.configuration = null;
    },
  ],
  [
    'wrong activation candidate',
    (body) => {
      body.resolvedCandidate.contentDigest = revision;
    },
  ],
  [
    'wrong activation request',
    (body) => {
      body.requestId = '33333333-3333-4333-8333-333333333333';
    },
  ],
  [
    'unknown result field shape',
    (body) => {
      body.target = null;
    },
  ],
]) {
  test(`does not report success for ${name}`, async (t) => {
    const f = await fixture(t);
    f.controls.activation = (body) => {
      change(body);
      return body;
    };
    await assert.rejects(() => run(f));
    assert.equal(activations(f).length, 1);
  });
}

test('unknown per-storage activation disposition remains failure with no later effects', async (t) => {
  const f = await fixture(t);
  f.p.prepare.replaceNow = {
    workspaceId: 'workspace-one',
    threadId: 'worker-thread',
    prompt: 'Continue the admitted task.',
  };
  f.controls.activation = (body) => {
    body.affected[0].disposition = 'unknown';
    return body;
  };
  await assert.rejects(() => run(f));
  assert.equal(effects(f).length, 2);
});

/** Reads all retained evidence so unknown response content cannot hide in a secondary file. */
async function evidenceText(directory) {
  let text = '';
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) text += await evidenceText(filename);
    else if (entry.isFile()) text += await fs.readFile(filename, 'utf8');
  }
  return text;
}

for (const [name, change] of [
  [
    'physical Epoch',
    (host) => {
      host.physicalEpoch = '9'.repeat(64);
    },
  ],
  [
    'host machine',
    (host) => {
      host.machineIdentityDigest = '5'.repeat(64);
    },
  ],
  [
    'running Gateway',
    (host) => {
      host.inspection.executables.gateway.sha256 = '6'.repeat(64);
    },
  ],
  [
    'running NanoHost',
    (host) => {
      host.inspection.executables.nanohost.sha256 = '7'.repeat(64);
    },
  ],
  [
    'runtime identity',
    (host) => {
      host.runtimeTarget.identityId = 'other-nanohost';
    },
  ],
  [
    'runtime deployment',
    (host) => {
      host.runtimeTarget.deploymentId = 'other-deployment';
    },
  ],
  [
    'runtime readiness',
    (host) => {
      host.runtimeTarget.ready = false;
    },
  ],
  [
    'predecessor fence',
    (host) => {
      host.runtimeTarget.predecessorFenced = false;
    },
  ],
]) {
  test(`does not report success when ${name} changes during activation`, async (t) => {
    const f = await fixture(t);
    f.controls.activation = (body) => {
      change(f.host);
      return body;
    };
    await assert.rejects(() => run(f));
    assert.deepEqual(
      effects(f).map(({ operation }) => operation),
      ['worker-environment.prepare', 'worker-environment.activate']
    );
  });
}

const opaqueMarker = 'untrusted-response-annotation-must-not-survive';
/** Unknown descriptive content is outside the consumer's trust boundary even when its bytes resemble a credential. */
function addOpaqueAnnotation(body) {
  body.producerAnnotation = { opaqueMarker, privateValue: 'Bearer syntheticunknownresponsevalue' };
  return body;
}

for (const stage of ['prepared', 'activation', 'preflight', 'runtimeTarget']) {
  test(`ignores unknown descriptive ${stage} annotations without retaining or forwarding them`, async (t) => {
    const f = await fixture(t);
    if (stage === 'runtimeTarget') addOpaqueAnnotation(f.host.runtimeTarget);
    else {
      const original = f.controls[stage];
      f.controls[stage] = (...args) => addOpaqueAnnotation(original(...args));
    }
    const result = await run(f);
    assert.equal(result.outcome, 'activated');
    for (const text of [
      JSON.stringify(result),
      JSON.stringify(f.calls),
      await evidenceText(f.evidence),
    ]) {
      assert.equal(text.includes(opaqueMarker), false);
      assert.equal(text.includes('syntheticunknownresponsevalue'), false);
      assert.equal(text.includes('producerAnnotation'), false);
    }
  });
}

for (const stage of ['prepared', 'activation']) {
  test(`refuses unknown nested ${stage} authority fields without forwarding or retaining them`, async (t) => {
    const f = await fixture(t);
    f.controls[stage] = (body) => {
      body.target.additionalScope = 'all-agents';
      body.configuration.revisionPolicy = 'ignore-stale-baseline';
      body.resolvedCandidate.digestPolicy = 'use-latest';
      return body;
    };
    await assert.rejects(() => run(f));
    for (const text of [JSON.stringify(f.calls), await evidenceText(f.evidence)]) {
      assert.equal(text.includes('additionalScope'), false);
      assert.equal(text.includes('revisionPolicy'), false);
      assert.equal(text.includes('digestPolicy'), false);
    }
    assert.equal(effects(f).length, stage === 'prepared' ? 1 : 2);
  });

  test(`refuses invalid ${stage} core without persisting unknown response bytes`, async (t) => {
    const f = await fixture(t);
    f.controls[stage] = (body) => {
      addOpaqueAnnotation(body);
      if (stage === 'prepared') body.image.digest = 'invalid-core-digest';
      else body.target = null;
      return body;
    };
    await assert.rejects(() => run(f));
    const text = await evidenceText(f.evidence);
    assert.equal(text.includes(opaqueMarker), false);
    assert.equal(text.includes('syntheticunknownresponsevalue'), false);
    assert.equal(text.includes('producerAnnotation'), false);
    assert.equal(effects(f).length, stage === 'prepared' ? 1 : 2);
  });
}

test('refuses unknown preparation instruction fields before Worker effects', async (t) => {
  const f = await fixture(t);
  f.p.prepare.unownedInstruction = true;
  await assert.rejects(() => run(f));
  assert.deepEqual(effects(f), []);
});

test('reports distinct bounded refusal reasons for busy work and conflicting running Gateway', async (t) => {
  const busy = await fixture(t);
  const originalPreflight = busy.controls.preflight;
  busy.controls.preflight = () => {
    const body = originalPreflight();
    body.state = 'busy';
    body.counts.runningTurns = 1;
    return body;
  };
  const wrongSource = await fixture(t);
  wrongSource.host.inspection.executables.gateway.sha256 = '6'.repeat(64);
  let busyReason;
  let hostReason;
  await assert.rejects(
    () => run(busy),
    (error) => {
      busyReason = error.message;
      assert.equal(typeof busyReason, 'string');
      assert.ok(busyReason.length <= 256);
      assert.match(busyReason, /busy|idle|active work/i);
      return true;
    }
  );
  await assert.rejects(
    () => run(wrongSource),
    (error) => {
      hostReason = error.message;
      assert.equal(typeof hostReason, 'string');
      assert.ok(hostReason.length <= 256);
      assert.match(hostReason, /host|observation|identity/i);
      return true;
    }
  );
  assert.notEqual(busyReason, hostReason);
  assert.deepEqual(effects(busy), []);
  assert.deepEqual(effects(wrongSource), []);
});

test('refuses fabricated predecessor when independent stage observations show the same warm Epoch', async (t) => {
  const f = await fixture(t);
  f.io.replacementObservation = async () => ({
    reference: replacementReference,
    target,
    grantReference: 'standing-staging-grant',
    outcome: 'passed',
    release: { tag, sourceCommit },
    before: structuredClone(f.host),
    after: structuredClone(f.host),
  });
  await assert.rejects(() => run(f));
  assert.deepEqual(effects(f), []);
});

test('uses the independently observed preceding replacement for fresh preparation', async (t) => {
  const f = await fixture(t);
  let observed = 0;
  const reader = f.io.replacementObservation;
  f.io.replacementObservation = async (selected) => {
    observed += 1;
    return reader(selected);
  };
  const result = await run(f);
  assert.equal(result.outcome, 'activated');
  assert.equal(result.freshEpochPreparation, true);
  assert.ok(observed > 0);
});

for (const [name, change] of [
  [
    'missing replacement reader',
    (f) => {
      f.io.replacementObservation = undefined;
    },
  ],
  [
    'missing replacement evidence',
    (f) => {
      f.controls.replacement = () => null;
    },
  ],
  [
    'another replacement reference',
    (_f, record) => {
      record.reference = 'another-update-stage';
    },
  ],
  [
    'another target',
    (_f, record) => {
      record.target = 'https://other.example.invalid';
    },
  ],
  [
    'another grant',
    (_f, record) => {
      record.grantReference = 'another-grant';
    },
  ],
  [
    'another release tag',
    (_f, record) => {
      record.release.tag = 'v0.1.0-rc.7';
    },
  ],
  [
    'another release source',
    (_f, record) => {
      record.release.sourceCommit = '8'.repeat(40);
    },
  ],
  [
    'another predecessor deployment',
    (_f, record) => {
      record.before.runtimeTarget.deploymentId = 'another-deployment';
    },
  ],
  [
    'another predecessor machine',
    (_f, record) => {
      record.before.machineIdentityDigest = '5'.repeat(64);
    },
  ],
  [
    'another observed successor Epoch',
    (_f, record) => {
      record.after.physicalEpoch = '7'.repeat(64);
    },
  ],
  [
    'another successor distribution',
    (_f, record) => {
      record.after.archiveAttribution.archiveSha256 = '6'.repeat(64);
    },
  ],
  [
    'failed replacement',
    (_f, record) => {
      record.outcome = 'failed';
    },
  ],
  [
    'unknown replacement outcome',
    (_f, record) => {
      record.outcome = 'unknown';
    },
  ],
  [
    'stale asserted predecessor',
    (f) => {
      f.p.previousPhysicalEpoch = '4'.repeat(64);
    },
  ],
]) {
  test(`refuses ${name} before Worker preparation`, async (t) => {
    const f = await fixture(t);
    const record = f.controls.replacement();
    f.controls.replacement = () => structuredClone(record);
    change(f, record);
    await assert.rejects(() => run(f));
    assert.deepEqual(effects(f), []);
  });
}

test('compares activation authority against the original grant snapshot', async (t) => {
  const f = await fixture(t);
  const sharedGrant = structuredClone(f.p.grant);
  f.io.currentGrant = async () => sharedGrant;
  f.controls.prepared = (body) => {
    sharedGrant.reference = 'changed-after-preparation';
    return body;
  };
  await assert.rejects(() => run(f), /grant changed before activation/);
  assert.deepEqual(
    effects(f).map(({ operation }) => operation),
    ['worker-environment.prepare']
  );
});

test('refuses a changed physical witness within the predecessor connection generation', async (t) => {
  const f = await fixture(t);
  const record = f.controls.replacement();
  const generation = record.after.runtimeTarget.connectionGeneration;
  record.before.runtimeTarget.connectionGeneration = generation;
  record.before.runtimeTargetBefore.connectionGeneration = generation;
  record.before.inspection.connectionGeneration = generation;
  f.controls.replacement = () => record;
  await assert.rejects(
    () => run(f),
    /NanoHost replacement does not prove the selected predecessor and current fresh Epoch/
  );
  assert.deepEqual(effects(f), []);
});

for (const [name, change] of [
  [
    'same-Epoch reconnect',
    (host) => {
      host.runtimeTarget.connectionGeneration += 1;
      host.inspection.connectionGeneration += 1;
    },
  ],
  [
    'coordinator process replacement',
    (host) => {
      host.inspection.coordinator.startTimeTicks = '12399';
      host.inspection.executables.nanohost.process.startTimeTicks = '12399';
    },
  ],
  [
    'Gateway process replacement',
    (host) => {
      host.inspection.executables.gateway.process.startTimeTicks = '12399';
    },
  ],
]) {
  test(`stops ${name} after preparation even when the next individual join is consistent`, async (t) => {
    const f = await fixture(t);
    f.controls.prepared = (body) => {
      change(f.host);
      return body;
    };
    await assert.rejects(() => run(f), /host incarnation changed before activation/);
    assert.deepEqual(
      effects(f).map(({ operation }) => operation),
      ['worker-environment.prepare']
    );
    assert.equal(
      f.calls.filter(({ operation }) => operation === 'nanohost.runtime-target').length,
      4
    );
  });
}

for (const [field, value] of [
  ['archiveSha256', 'a'.repeat(64)],
  ['sourceCommit', 'b'.repeat(40)],
  ['tag', 'v0.1.0-rc.7'],
  ['platform', 'linux/amd64'],
]) {
  test(`requires independent archive ${field} to match the selected release before effects`, async (t) => {
    const f = await fixture(t);
    const baseline = f.io.archiveAttribution;
    f.io.archiveAttribution = async () => ({ ...(await baseline()), [field]: value });
    await assert.rejects(() => run(f));
    assert.deepEqual(effects(f), []);
  });
}

test('rejects a replayed successful inspection before activation without a second challenge', async (t) => {
  const f = await fixture(t);
  const inspect = f.io.runOperator;
  let retained;
  let attempts = 0;
  f.io.runOperator = async (...args) => {
    attempts += 1;
    if (retained) return structuredClone(retained);
    retained = await inspect(...args);
    return retained;
  };
  await assert.rejects(() => run(f));
  assert.equal(attempts, 2);
  assert.deepEqual(
    effects(f).map(({ operation }) => operation),
    ['worker-environment.prepare']
  );
});

for (const stage of ['before prepare', 'before activate']) {
  test(`stops an unknown live-inspection outcome ${stage} without retry or raw evidence`, async (t) => {
    const f = await fixture(t);
    const inspect = f.io.runOperator;
    let attempts = 0;
    f.io.runOperator = async (...args) => {
      attempts += 1;
      if (attempts === (stage === 'before prepare' ? 1 : 2))
        throw Error('Bearer syntheticunknownprobevalue');
      return inspect(...args);
    };
    await assert.rejects(() => run(f));
    assert.equal(attempts, stage === 'before prepare' ? 1 : 2);
    assert.equal(effects(f).length, stage === 'before prepare' ? 0 : 1);
    assert.equal((await evidenceText(f.evidence)).includes('syntheticunknownprobevalue'), false);
  });
}

test('retains digest and archive attribution without the provisional raw identifier/checksum fields', async (t) => {
  const f = await fixture(t);
  const result = await run(f);
  assert.equal(result.host.machineIdentityDigest, deployment.machineIdentityDigest);
  assert.equal(result.host.archiveAttribution.archiveSha256, 'f'.repeat(64));
  assert.equal(result.host.inspection.executables.nanohost.sha256, '4'.repeat(64));
  assert.notEqual(result.host.inspection.nonce, result.hostBeforeActivation.inspection.nonce);
  assert.notEqual(
    result.hostBeforeActivation.inspection.nonce,
    result.hostAfterActivation.inspection.nonce
  );
  assert.deepEqual(
    result.hostBeforeActivation.runtimeTargetBefore,
    result.hostBeforeActivation.runtimeTarget
  );
  assert.equal((await evidenceText(f.evidence)).includes('"machineId"'), false);
  assert.equal((await evidenceText(f.evidence)).includes('distributionSha256'), false);
});
