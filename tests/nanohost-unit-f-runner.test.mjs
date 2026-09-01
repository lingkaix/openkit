// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  adjudicateNanoHostF1Continuation,
  adjudicateNanoHostUnitFResult,
  adjudicateNanoHostUnitFScenario,
  collectNanoHostNetworkObservations,
  collectPrivateNamespaceNetworkObservations,
  completeNanoHostFirstFenceRecovery,
  createDefaultDriver,
  createNanoCoreTunnel,
  epochEffectsAreAbsent,
  executeNanoHostUnitFCoordinator,
  normalizeNanoCoreRestartBaseline,
  readTurnRuntimeEvidence,
  readWorkspaceRuntimeEvidence,
  requestJson,
  runCommand,
  runNanoHostUnitF,
  sequenceNanoHostBlockedCreate,
  sequenceNanoHostF1,
  sequenceNanoHostNormalLifecycle,
  waitForObservation,
} from './support/host/nanohost-unit-f-runner.mjs';

const scenarioIds = ['F1', 'F2', 'F4'];
const contracts = {
  F1: {
    action: 'successor-transport-fenced-and-reconnected',
    barrier: 'post-launch-worker-sequence-durable',
    checkout: 'real-worker-public-git-checkout-complete',
    cleanup: 'same-lineage-finalized-without-replay',
    fault: 'nanocore-only-restarted',
  },
  F2: {
    action: 'supervised-effect-domain-terminated',
    barrier: 'sandbox-create-accepted-and-blocked',
    buildNetwork: 'system-docker-build-network-smoke-complete',
    cleanup: 'no-late-residue-and-fresh-empty-ready',
    fault: 'nanohost-sigkill-delivered',
  },
  F4: {
    action: 'epoch-invalidated-siblings-terminated-without-member-restart',
    barrier: 'sandbox-operation-accepted',
    buildNetwork: 'system-docker-build-network-smoke-complete',
    cleanup: 'sessions-interrupted-routes-capacity-fenced-and-fresh-epoch-ready',
    fault: 'effect-capable-member-killed',
  },
};
const normalLifecycleContract = {
  buildNetwork: 'system-docker-build-network-smoke-complete',
  finalFreshStart: 'final-fresh-start-all-three-ready',
  ordinaryStart: 'ordinary-start-all-three-ready',
  ordinaryStop: 'ordinary-stop-cgroup-and-private-network-namespace-absent',
  stoppedBaseline: 'service-stopped-baseline',
  systemDocker: 'system-docker-baseline-exact-equal',
};
const networkConformanceContract = {
  businessContainerAttachments: 'business-container-attachments-preserved',
  defaultRoute: 'private-default-route-ready',
  dockerdDns: 'dockerd-fixed-dns-projected',
  namespaceTopology: 'host-private-namespace-topology-exact',
  privateNamespaceReachability: 'host-nanocore-and-loopback-sentinel-unreachable',
  realWorkerCheckout: 'real-worker-public-git-checkout-complete',
  serviceRoot: 'system-docker-socket-inaccessible',
  slirp: 'exact-host-slirp-ready',
  systemDockerBaseline: 'system-docker-baseline-preserved',
  systemDockerBuildSmoke: 'system-docker-build-network-smoke-complete',
  tap: 'private-tap-ready',
};

const publicIdentity = {
  hostManifestDigest: 'a'.repeat(64),
  productCommit: 'b'.repeat(40),
  sshAlias: 'a1',
  workerImageRef: `sha256:${'c'.repeat(64)}`,
};
const privateAttemptId = 'attempt-0198-full-unique-id';
const instrumentDigest = digest('unit-f-runner-instrument');
const privateLineage = Object.freeze({
  agentSessionId: 'agent-session-full-unique-id',
  backendSessionId: 'backend-session-full-unique-id',
  leaseId: 'lease-full-unique-id',
  turnId: 'turn-full-unique-id',
});
const secretCanary = 'raw-secret-token-canary';
const rawErrorCanary = 'raw internal error with private paths';

test('exposes only the accepted non-host-reboot scenarios', async () => {
  const executed = [];
  await executeNanoHostUnitFCoordinator({
    captureBaseline: async () => ({}),
    captureNetworkConformance: async () => ({}),
    executeScenarioEffect: async ({ scenarioId }) => executed.push(scenarioId),
    verifyNormalLifecycleEffect: async () => {},
  });
  assert.deepEqual(executed, ['F1', 'F2', 'F4']);
  await assert.rejects(
    sequenceNanoHostBlockedCreate(
      'F3',
      new Proxy({}, { get: () => assert.fail('F3 reached an effect port') })
    ),
    /scenario identity is invalid/u
  );
});

test('scopes network namespace residue to one host boot', () => {
  const numericMatch = { netnsStillReferenced: true, socketsAbsent: true };
  assert.equal(
    epochEffectsAreAbsent({ ...numericMatch, bootId: 'boot-after' }, 'boot-before'),
    true
  );
  assert.equal(
    epochEffectsAreAbsent({ ...numericMatch, bootId: 'boot-before' }, 'boot-before'),
    false
  );
  assert.equal(
    epochEffectsAreAbsent(
      { ...numericMatch, bootId: 'boot-after', socketsAbsent: false },
      'boot-before'
    ),
    false
  );
});

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('kills a real verification child when its bounded command deadline expires', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-unit-f-command-'));
  const pidPath = join(fixtureRoot, 'pid');
  try {
    await assert.rejects(
      runCommand(
        process.execPath,
        [
          '-e',
          "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);",
          pidPath,
        ],
        { timeoutMs: 500 }
      ),
      /command deadline expired/u
    );
    const pid = Number(readFileSync(pidPath, 'utf8'));

    await waitForObservation(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error?.code === 'ESRCH';
      }
    }, 1_000);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test('does not settle a timed-out command before the killed child close event', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-unit-f-command-close-'));
  const survivorPidPath = join(fixtureRoot, 'survivor-pid');
  let survivorPid = null;
  let settled = false;
  let outcome = null;
  const command = runCommand(
    process.execPath,
    [
      '-e',
      "const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setTimeout(()=>{},800)'],{stdio:['ignore','inherit','inherit']});writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);",
      survivorPidPath,
    ],
    { timeoutMs: 250 }
  ).then(
    () => {
      settled = true;
    },
    (error) => {
      outcome = error;
      settled = true;
    }
  );
  try {
    await waitForObservation(() => {
      survivorPid = Number(readFileSync(survivorPidPath, 'utf8'));
      return Number.isSafeInteger(survivorPid) && survivorPid > 0;
    }, 1_000);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    assert.equal(settled, false);
    await Promise.race([
      command,
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error('command close observation was unbounded')),
          1_500
        ).unref();
      }),
    ]);
    assert.match(outcome?.message ?? '', /command deadline expired/u);
  } finally {
    if (survivorPid) {
      try {
        process.kill(survivorPid, 'SIGKILL');
      } catch {}
    }
    await command;
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test('fails closed within a second bound when timed-out command cleanup cannot be proved', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-unit-f-command-unproved-'));
  const survivorPidPath = join(fixtureRoot, 'survivor-pid');
  let survivorPid = null;
  let outcome = null;
  const command = runCommand(
    process.execPath,
    [
      '-e',
      "const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);",
      survivorPidPath,
    ],
    { timeoutMs: 250 }
  ).catch((error) => {
    outcome = error;
  });
  try {
    await waitForObservation(() => {
      survivorPid = Number(readFileSync(survivorPidPath, 'utf8'));
      return Number.isSafeInteger(survivorPid) && survivorPid > 0;
    }, 1_000);
    await Promise.race([
      command,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('command cleanup proof was unbounded')), 6_000).unref();
      }),
    ]);
    assert.match(outcome?.message ?? '', /cleanup.*unproved/u);
  } finally {
    if (survivorPid) {
      try {
        process.kill(survivorPid, 'SIGKILL');
      } catch {}
    }
    await command;
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

class TunnelChild extends EventEmitter {
  constructor({ closeAfterKill }) {
    super();
    this.closeAfterKill = closeAfterKill;
    this.exitCode = null;
    this.signalCode = null;
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    if (signal === 'SIGKILL' && this.closeAfterKill !== null) {
      this.emit('sigkill');
      setTimeout(() => {
        this.signalCode = 'SIGKILL';
        this.emit('close', null, 'SIGKILL');
      }, this.closeAfterKill).unref();
    }
    return true;
  }
}

function tunnelConfig() {
  return {
    localPort: 17_892,
    remoteNanoCorePort: 3_001,
    request: async () => ({ ready: true }),
    sessionCookie: 'session-canary',
    sshAlias: 'a1',
    waitFor: async (observe) => observe(),
  };
}

test('tunnel stop waits for the exact SIGKILLed child close', async () => {
  const child = new TunnelChild({ closeAfterKill: 100 });
  const tunnel = createNanoCoreTunnel(tunnelConfig(), () => child);
  await tunnel.start();
  let settled = false;
  const sigkilled = once(child, 'sigkill');
  const stopping = tunnel.stop().then(() => {
    settled = true;
  });

  await sigkilled;
  assert.equal(settled, false);
  await stopping;
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('tunnel stop fails closed when the exact child close remains unproved', async () => {
  const child = new TunnelChild({ closeAfterKill: null });
  const tunnel = createNanoCoreTunnel(tunnelConfig(), () => child);
  await tunnel.start();

  await assert.rejects(tunnel.stop(), /SSH forward cleanup is unproved/u);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('destroys a never-ending HTTP/1.1 App request at the deadline', async () => {
  let responseClosed = false;
  const server = createHttpServer((_request, response) => {
    response.once('close', () => {
      responseClosed = true;
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');
  try {
    await assert.rejects(
      requestJson(
        { localPort: address.port, requestTimeoutMs: 50, sessionCookie: 'session-canary' },
        'GET',
        '/never-ends',
        undefined,
        'product'
      ),
      /deadline expired/u
    );
    await waitForObservation(() => responseClosed, 1_000);
  } finally {
    server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('bounds an observation callback that never settles', async () => {
  const startedAt = Date.now();
  let calls = 0;

  await assert.rejects(
    waitForObservation(() => {
      calls += 1;
      return new Promise(() => {});
    }, 25),
    /observation deadline expired/u
  );

  assert.equal(calls, 1);
  assert.ok(Date.now() - startedAt < 1_000);
});

function blockedCreateObservation() {
  const nanohost = {
    args: ['/usr/lib/openkit/nanohost'],
    exe: '/usr/lib/openkit/nanohost',
    netns: 'net:[101]',
    pid: 101,
    starttime: '1001',
    state: 'S',
  };
  const gateway = {
    args: ['gateway', '--config=/run/openkit/nanohost/epoch-1/gateway.toml'],
    exe: '/usr/lib/openkit/openshell-gateway',
    netns: 'net:[101]',
    pid: 102,
    starttime: '1002',
    state: 'S',
  };
  const dockerd = {
    args: ['--pidfile=/run/openkit-nanohost/dockerd.pid'],
    exe: '/usr/bin/dockerd',
    netns: 'net:[101]',
    pid: 103,
    starttime: '1003',
    state: 'T',
  };
  return {
    current: {
      bootId: 'boot-unit-f',
      invocationId: 'invocation-unit-f',
      members: [nanohost, gateway, dockerd],
    },
    entries: [
      {
        _COMM: 'nanohost',
        _EXE: '/usr/lib/openkit/nanohost',
        _PID: '777',
        _SYSTEMD_INVOCATION_ID: 'invocation-unit-f',
        _SYSTEMD_UNIT: 'openkit-nanohost.service',
        MESSAGE: 'nanohost effect accepted: operation=CreateSandbox',
      },
      {
        _COMM: 'openshell-gateway',
        _EXE: '/usr/lib/openkit/openshell-gateway',
        _PID: '102',
        _SYSTEMD_INVOCATION_ID: 'invocation-unit-f',
        _SYSTEMD_UNIT: 'openkit-nanohost.service',
        MESSAGE: 'nanohost effect accepted: operation=CreateSandbox',
      },
    ],
    fixture: {
      backendSessionId: 'sandbox-unit-f',
      dockerd: { ...dockerd, args: [...dockerd.args] },
      epoch: { bootId: 'boot-unit-f', invocationId: 'invocation-unit-f' },
      gateway: { ...gateway, args: [...gateway.args] },
      nanohost: { ...nanohost, args: [...nanohost.args] },
      lineage: {
        requestId: 'task-request-unit-f',
      },
      target: { connectionGeneration: 7 },
    },
    target: {
      connectionGeneration: 7,
      freshEmpty: true,
      predecessorFenced: true,
      ready: true,
    },
  };
}

function sequencedF1Fixture() {
  const evidence = f1ContinuationEvidence();
  for (const snapshot of [evidence.before, evidence.adopted]) {
    snapshot.projectionOwners.capabilityCalls[0].status = 'succeeded';
    snapshot.projectionOwners.capabilityCalls[0].completedAt = '2026-08-23T00:00:01.000Z';
    snapshot.projectionOwners.capabilityCalls.push({
      completedAt: null,
      errorCode: null,
      family: 'runtime',
      fingerprint: 'capability-checkpoint',
      id: 'capability-checkpoint',
      serviceRef: 'worker-checkpoint',
      status: 'running',
    });
  }
  evidence.final.projectionOwners.capabilityCalls.splice(2, 0, {
    completedAt: '2026-08-23T00:00:02.000Z',
    errorCode: null,
    family: 'runtime',
    fingerprint: 'capability-checkpoint',
    id: 'capability-checkpoint',
    serviceRef: 'worker-checkpoint',
    status: 'failed',
  });
  const lineage = {
    ...evidence.lineage,
    threadId: 'thread-f1',
    turnId: 'turn-f1',
    workspaceId: 'workspace-f1',
  };
  const runtimeTargets = [
    {
      connectionGeneration: evidence.priorGeneration,
      freshEmpty: true,
      predecessorFenced: true,
      ready: true,
    },
    evidence.successorTarget,
    {
      ...evidence.successorTarget,
      freshEmpty: true,
    },
  ];
  evidence.before.runtimeTarget = structuredClone(runtimeTargets[0]);
  const epochs = [evidence.epochBefore, evidence.epochAfter];
  const cleanupSnapshot = structuredClone(evidence.final);
  cleanupSnapshot.backends[0].state = 'cleaned';
  cleanupSnapshot.backends[0].physicalCleanedAt = '2026-08-23T00:00:04.000Z';
  cleanupSnapshot.leases[0].status = 'released';
  cleanupSnapshot.turn = { id: lineage.turnId, status: 'completed' };
  const snapshots = [evidence.before, evidence.adopted, evidence.final];
  const actions = [];
  const state = { cleanup: false, stopped: false };
  const reads = { epoch: 0, owner: 0, target: 0, turn: 0 };
  const ports = {
    instrumentDigest,
    nanoCoreContainer: 'openkit-nanocore-unit-f',
    nanoCoreImageId: `sha256:${'e'.repeat(64)}`,
    nanoCoreImageRef: 'openkit/app:unit-f',
    async interruptTurn() {
      actions.push('interruptTurn');
      state.cleanup = true;
    },
    async killNanoCore() {
      actions.push('killNanoCore');
    },
    async pause() {},
    async readEpoch() {
      if (state.stopped) {
        return {
          activeState: 'inactive',
          bootId: evidence.epochBefore.bootId,
          invocationId: null,
          members: [],
        };
      }
      const value = epochs[Math.min(reads.epoch, epochs.length - 1)];
      reads.epoch += 1;
      return structuredClone(value);
    },
    async readEpochEffects() {
      return { absent: true };
    },
    async readJournal() {
      return { entries: [], text: evidence.journal };
    },
    async readJournalCursor() {
      return 'cursor-f1';
    },
    async readOwnerSnapshot() {
      if (state.cleanup) return structuredClone(cleanupSnapshot);
      const value = snapshots[Math.min(reads.owner, snapshots.length - 1)];
      reads.owner += 1;
      return structuredClone(value);
    },
    async readPriorRoots() {
      return { absent: true };
    },
    async readRuntimeTarget() {
      if (state.cleanup) {
        return {
          ...structuredClone(evidence.successorTarget),
          freshEmpty: true,
        };
      }
      const value = runtimeTargets[Math.min(reads.target, runtimeTargets.length - 1)];
      reads.target += 1;
      return structuredClone(value);
    },
    async readTurn() {
      reads.turn += 1;
      return { id: lineage.turnId, status: 'completed' };
    },
    async resolveLineage() {
      actions.push('resolveLineage');
      return structuredClone(lineage);
    },
    async startNanoCore() {
      actions.push('startNanoCore');
    },
    async startNanoHost() {
      actions.push('startNanoHost');
      state.stopped = false;
    },
    async startTask() {
      actions.push('startTask');
      return { id: 'task-f1' };
    },
    async startTunnel() {
      actions.push('startTunnel');
    },
    async stopNanoHost() {
      actions.push('stopNanoHost');
      state.stopped = true;
    },
    async waitFor(observe) {
      const observed = await observe();
      if (!observed) throw new Error('fixture observation remained incomplete');
      return observed;
    },
  };
  return { actions, evidence, epochs, lineage, ports, reads, runtimeTargets, snapshots, state };
}

test('sequences one complete F1 restart and derives lineage and proof from owner facts', async () => {
  const fixture = sequencedF1Fixture();
  const result = await sequenceNanoHostF1(fixture.ports);

  assert.deepEqual(result.lineage, {
    agentSessionId: fixture.lineage.agentSessionId,
    backendSessionId: 'backend-f1',
    leaseId: 'lease-f1',
    turnId: fixture.lineage.turnId,
  });
  assert.equal(result.proof.instrument, instrumentDigest);
  assert.equal(result.proof.priorGeneration, 7);
  assert.equal(result.proof.successorGeneration, 8);
  assert.ok(fixture.actions.indexOf('killNanoCore') < fixture.actions.indexOf('startNanoCore'));
  assert.ok(fixture.actions.indexOf('startNanoCore') < fixture.actions.indexOf('startTunnel'));
  assert.equal(fixture.actions.includes('interruptTurn'), false);
  assert.equal(fixture.actions.filter((action) => action === 'startNanoHost').length, 1);
  assert.equal(fixture.actions.at(-1), 'startNanoHost');
});

for (const intervention of [
  {
    mutate(fixture) {
      fixture.snapshots[0].projectionOwners.inference = [];
    },
    name: 'only workspace materialization completed',
    stopped(fixture) {
      assert.equal(fixture.actions.includes('killNanoCore'), false);
    },
  },
  {
    mutate(fixture) {
      fixture.snapshots[0].projectionOwners.capabilityCalls[0].status = 'running';
      fixture.snapshots[0].projectionOwners.capabilityCalls[0].completedAt = null;
    },
    name: 'an in-flight capability call',
    stopped(fixture) {
      assert.equal(fixture.actions.includes('killNanoCore'), false);
    },
  },
  {
    mutate(fixture) {
      fixture.snapshots[0].finalStatus = { sequence: 1, status: 'completed' };
    },
    name: 'an incomplete post-launch barrier',
    stopped(fixture) {
      assert.equal(fixture.actions.includes('killNanoCore'), false);
    },
  },
  {
    mutate(fixture) {
      fixture.snapshots[0].runtimeTarget = null;
      fixture.runtimeTargets.splice(1, 0, {
        ...fixture.runtimeTargets[0],
        freshEmpty: false,
        ready: false,
      });
    },
    name: 'an unbound backend whose RuntimeTarget fails before the post-launch barrier',
    stopped(fixture) {
      assert.equal(fixture.reads.owner, 1);
      assert.equal(fixture.reads.target, 2);
      assert.equal(fixture.actions.includes('killNanoCore'), false);
    },
  },
  {
    mutate(fixture) {
      fixture.runtimeTargets[1].connectionGeneration = 9;
    },
    name: 'a skipped successor generation',
    stopped(fixture) {
      assert.equal(fixture.reads.owner, 1);
    },
  },
  {
    mutate(fixture) {
      fixture.snapshots[1].events[1].sequence = 3;
    },
    name: 'an adopted transcript gap',
    stopped(fixture) {
      assert.equal(fixture.reads.owner, 3);
    },
  },
  {
    mutate(fixture) {
      fixture.runtimeTargets[2].freshEmpty = false;
    },
    name: 'a nonempty final target',
    stopped(fixture) {
      assert.equal(fixture.reads.target, 3);
    },
  },
]) {
  test(`F1 fails closed after ${intervention.name} and still enters lineage cleanup`, async () => {
    const fixture = sequencedF1Fixture();
    intervention.mutate(fixture);

    await assert.rejects(sequenceNanoHostF1(fixture.ports));
    intervention.stopped(fixture);
    assert.equal(fixture.actions.includes('interruptTurn'), true);
  });
}

test('F1 without resolved lineage fences the whole epoch before starting NanoHost', async () => {
  const fixture = sequencedF1Fixture();
  fixture.ports.resolveLineage = async () => {
    fixture.actions.push('resolveLineage');
    return null;
  };

  await assert.rejects(sequenceNanoHostF1(fixture.ports));
  assert.equal(fixture.actions.includes('killNanoCore'), false);
  assert.ok(fixture.actions.indexOf('stopNanoHost') < fixture.actions.indexOf('startNanoHost'));
  assert.equal(fixture.actions.includes('interruptTurn'), false);
});

function sequencedBlockedFixture(scenarioId) {
  const observation = blockedCreateObservation();
  const backendSessionId = 'sandbox-unit-f';
  const runtimeTarget = {
    deploymentId: 'deployment-unit-f',
    identityId: 'identity-unit-f',
    observedAt: '2026-08-23T00:00:00.000Z',
    slotCount: 1,
    targetId: 'runtime-target-unit-f',
  };
  const lineage = {
    agentSessionId: 'agent-session-blocked',
    packageSnapshotId: 'snapshot-blocked',
    requestId: 'task-request-unit-f',
    threadId: 'thread-blocked',
    turnId: 'turn-blocked',
    workspaceId: 'workspace-blocked',
  };
  const nanohost = observation.fixture.nanohost;
  const initialEpoch = {
    activeState: 'active',
    bootId: observation.current.bootId,
    invocationId: observation.current.invocationId,
    members: observation.current.members,
  };
  const firstEpoch = {
    activeState: 'active',
    bootId: initialEpoch.bootId,
    invocationId: 'invocation-unit-f-first-recovery',
    members: [
      { ...nanohost, pid: 201, starttime: '2001' },
      ...observation.current.members.map((member) => ({
        ...member,
        args: [...member.args],
        pid: member.pid + 100,
        starttime: String(Number(member.starttime) + 1_000),
      })),
    ],
  };
  const successorEpoch = {
    ...firstEpoch,
    invocationId: 'invocation-unit-f-successor',
    members: firstEpoch.members.map((member) => ({
      ...member,
      args: [...member.args],
      pid: member.pid + 100,
      starttime: String(Number(member.starttime) + 1_000),
    })),
  };
  const finalEpoch = {
    ...successorEpoch,
    invocationId: 'invocation-unit-f-final-successor',
  };
  const ownerBefore = {
    backends: [
      {
        agentSessionId: lineage.agentSessionId,
        backendSessionId,
        packageSnapshotId: lineage.packageSnapshotId,
        runtimeTargetId: runtimeTarget.targetId,
        state: 'launching',
      },
    ],
    leases: [
      {
        agentSessionId: lineage.agentSessionId,
        leaseId: 'lease-blocked',
        packageSnapshotId: lineage.packageSnapshotId,
        status: 'releasing',
      },
    ],
    runtimeTarget: {
      ...runtimeTarget,
      connectionGeneration: 7,
      freshEmpty: true,
      predecessorFenced: true,
      ready: true,
    },
  };
  const fencedOwner = structuredClone(ownerBefore);
  fencedOwner.backends[0].state = 'cleaned';
  fencedOwner.backends[0].physicalCleanedAt = '2026-08-23T00:00:05.000Z';
  fencedOwner.leases[0].status = 'released';
  fencedOwner.runtimeEvidence = [{ phase: 'teardown' }];
  fencedOwner.turn = { id: lineage.turnId, status: 'failed' };
  const capacityReleasedOwner = structuredClone(fencedOwner);
  capacityReleasedOwner.turn = { id: lineage.turnId, status: 'running' };
  const cleanedOwner = structuredClone(fencedOwner);
  const state = {
    faultDelivered: false,
    firstEpochReads: 0,
    hostStarts: 0,
    interrupted: false,
    stopped: false,
    successorFailed: false,
    successorEpochReads: 0,
  };
  const actions = [];
  const barrierJournalPids = [];
  const journalEntries = structuredClone(observation.entries);
  const ports = {
    instrumentDigest,
    nanoCoreContainer: 'openkit-nanocore-unit-f',
    nanoCoreImageId: `sha256:${'e'.repeat(64)}`,
    nanoCoreImageRef: 'openkit/app:unit-f',
    async interruptTurn() {
      actions.push('interruptTurn');
      state.interrupted = true;
    },
    async pause() {},
    async readEpoch() {
      if (state.stopped) {
        return {
          activeState: 'inactive',
          bootId: initialEpoch.bootId,
          invocationId: null,
          members: [],
        };
      }
      if (!state.faultDelivered && !state.stopped) return structuredClone(initialEpoch);
      if (state.hostStarts === 0) {
        return {
          activeState: 'inactive',
          bootId: initialEpoch.bootId,
          invocationId: null,
          members: [],
        };
      }
      if (state.hostStarts === 1) {
        state.firstEpochReads += 1;
        return state.firstEpochReads === 1
          ? structuredClone(firstEpoch)
          : { ...structuredClone(firstEpoch), activeState: 'inactive', members: [] };
      }
      if (state.hostStarts === 2 && !state.successorFailed) {
        state.successorEpochReads += 1;
        if (state.successorEpochReads === 1) {
          return { ...structuredClone(successorEpoch), members: [successorEpoch.members[0]] };
        }
      }
      if (state.hostStarts === 2 && state.successorFailed) {
        return { ...structuredClone(successorEpoch), activeState: 'inactive', members: [] };
      }
      return structuredClone(state.hostStarts > 2 ? finalEpoch : successorEpoch);
    },
    async readEpochEffects(epoch) {
      if (!epoch.members.some((member) => member.exe.endsWith('/openshell-gateway'))) {
        throw new Error('fixture proof epoch is incomplete');
      }
      return { absent: true };
    },
    async readJournal({ invocationId, pid } = {}) {
      if (
        invocationId === firstEpoch.invocationId ||
        invocationId === successorEpoch.invocationId
      ) {
        return {
          entries: [
            {
              MESSAGE:
                'nanohost outer session failure: disposition=terminal stage=poll operation=sandbox.create status=409',
            },
          ],
          text: 'nanohost outer session failure: disposition=terminal stage=poll operation=sandbox.create status=409',
        };
      }
      barrierJournalPids.push(pid);
      return {
        entries: structuredClone(
          pid === undefined
            ? journalEntries
            : journalEntries.filter((entry) => String(entry._PID) === String(pid))
        ),
        text: '',
      };
    },
    async readJournalCursor() {
      return 'cursor-blocked';
    },
    async readOwnerSnapshot() {
      actions.push('readOwnerSnapshot');
      if (state.interrupted) return structuredClone(cleanedOwner);
      if (state.successorFailed) {
        return structuredClone(scenarioId === 'F4' ? fencedOwner : capacityReleasedOwner);
      }
      if (scenarioId === 'F4' && state.faultDelivered) return structuredClone(ownerBefore);
      return structuredClone(ownerBefore);
    },
    async readPriorRoots() {
      return { absent: true };
    },
    async readRuntimeTarget() {
      if (!state.faultDelivered && !state.stopped) {
        return {
          ...runtimeTarget,
          connectionGeneration: 7,
          freshEmpty: true,
          predecessorFenced: true,
          ready: true,
        };
      }
      if (state.hostStarts < 2) {
        const firstRecoveryReadiness = state.hostStarts === 1 && state.firstEpochReads === 1;
        return {
          ...runtimeTarget,
          connectionGeneration: 8,
          freshEmpty: firstRecoveryReadiness,
          predecessorFenced: true,
          ready: firstRecoveryReadiness,
        };
      }
      if (state.hostStarts === 2) {
        state.successorFailed = true;
        return {
          ...runtimeTarget,
          connectionGeneration: 9,
          freshEmpty: false,
          predecessorFenced: true,
          ready: false,
        };
      }
      return {
        ...runtimeTarget,
        connectionGeneration: state.hostStarts > 2 ? 10 : 9,
        freshEmpty: true,
        predecessorFenced: true,
        ready: true,
      };
    },
    async readTurn() {
      return { id: lineage.turnId, status: 'failed' };
    },
    async resolveLineage() {
      actions.push('resolveLineage');
      return structuredClone(lineage);
    },
    async runDockerSmoke() {
      actions.push('runDockerSmoke');
    },
    async signalMember(member, signal) {
      actions.push(`signal:${member.pid}:${signal}`);
      state.faultDelivered = true;
      return { signalled: true };
    },
    async startNanoHost() {
      actions.push('startNanoHost');
      state.hostStarts += 1;
      state.stopped = false;
    },
    async startTask() {
      actions.push('startTask');
      return { id: `task-${scenarioId}` };
    },
    async startTunnel() {
      actions.push('startTunnel');
    },
    async stopNanoHost() {
      actions.push('stopNanoHost');
      state.stopped = true;
    },
    async stopTunnel() {
      actions.push('stopTunnel');
    },
    async waitFor(observe) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const observed = await observe();
        if (observed) return observed;
      }
      throw new Error('fixture observation remained incomplete');
    },
  };
  return {
    actions,
    backendSessionId,
    barrierJournalPids,
    cleanedOwner,
    fencedOwner,
    firstEpoch,
    initialEpoch,
    journalEntries,
    lineage,
    ownerBefore,
    ports,
    runtimeTarget,
    state,
  };
}

for (const scenarioId of ['F2', 'F4']) {
  test(`sequences one complete ${scenarioId} blocked-create fault before recovery`, async () => {
    const fixture = sequencedBlockedFixture(scenarioId);
    const result = await sequenceNanoHostBlockedCreate(scenarioId, fixture.ports);
    const faultAction = fixture.actions.find((action) => action.startsWith('signal:'));

    assert.deepEqual(result.lineage, {
      agentSessionId: fixture.lineage.agentSessionId,
      backendSessionId: fixture.backendSessionId,
      leaseId: 'lease-blocked',
      turnId: fixture.lineage.turnId,
    });
    assert.equal(result.proof.instrument, instrumentDigest);
    assert.equal(result.proof.priorGeneration, 7);
    assert.equal(result.proof.fenceGeneration, 8);
    assert.equal(result.proof.successorGeneration, 10);
    assert.equal(
      result.proof.effectRequest,
      digest(`${fixture.lineage.requestId}\0sandbox.create`)
    );
    assert.equal(result.proof.sandbox, digest(fixture.backendSessionId));
    assert.ok(fixture.actions.indexOf('startTask') < fixture.actions.indexOf('resolveLineage'));
    assert.ok(fixture.actions.indexOf('resolveLineage') < fixture.actions.indexOf(faultAction));
    assert.ok(fixture.actions.indexOf(faultAction) < fixture.actions.indexOf('startNanoHost'));
    assert.equal(fixture.actions.filter((action) => action === 'startNanoHost').length, 3);
    assert.ok(
      fixture.actions.lastIndexOf('startNanoHost') < fixture.actions.indexOf('interruptTurn')
    );
    assert.deepEqual(fixture.barrierJournalPids, [undefined, undefined]);
  });
}

test('blocked-create sequencing rechecks the exact owner before dispatching a fault', async () => {
  const fixture = sequencedBlockedFixture('F2');
  let ownerReads = 0;
  fixture.ports.readOwnerSnapshot = async () => {
    ownerReads += 1;
    return structuredClone(ownerReads === 1 ? fixture.ownerBefore : fixture.fencedOwner);
  };

  await assert.rejects(sequenceNanoHostBlockedCreate('F2', fixture.ports));
  assert.equal(ownerReads, 2);
  assert.equal(
    fixture.actions.some((action) => action.startsWith('signal:')),
    false
  );
  assert.equal(fixture.actions.includes('stopNanoHost'), true);
});

test('blocked-create sequencing rejects unrelated Gateway JWT metadata before fault delivery', async () => {
  const fixture = sequencedBlockedFixture('F2');
  fixture.journalEntries[0].MESSAGE = 'Minted sandbox JWT gateway_id=gateway-unit-f ttl_secs=300';

  await assert.rejects(sequenceNanoHostBlockedCreate('F2', fixture.ports));
  assert.equal(
    fixture.actions.some((action) => action.startsWith('signal:')),
    false
  );
});

test('F2 stops before recovery when the exact NanoHost signal is not delivered', async () => {
  const fixture = sequencedBlockedFixture('F2');
  fixture.ports.signalMember = async (member, signal) => {
    fixture.actions.push(`signal:${member.pid}:${signal}`);
    return { signalled: false };
  };

  await assert.rejects(sequenceNanoHostBlockedCreate('F2', fixture.ports));
  assert.equal(fixture.actions.includes('runDockerSmoke'), false);
});

test('F4 recovers the fenced epoch before its pending Turn cleanup settles', async () => {
  const fixture = sequencedBlockedFixture('F4');
  fixture.ports.readTurn = async () => ({ id: fixture.lineage.turnId, status: 'running' });

  await sequenceNanoHostBlockedCreate('F4', fixture.ports);
  assert.ok(fixture.actions.indexOf('startNanoHost') < fixture.actions.indexOf('interruptTurn'));
});

test('F4 starts the fresh successor before waiting for cleanup that successor owns', async () => {
  const fixture = sequencedBlockedFixture('F4');
  fixture.ports.readOwnerSnapshot = async () => {
    fixture.actions.push(`readOwnerSnapshot:${fixture.state.hostStarts}`);
    if (fixture.state.interrupted) return structuredClone(fixture.cleanedOwner);
    return structuredClone(
      fixture.state.hostStarts > 2 ? fixture.fencedOwner : fixture.ownerBefore
    );
  };

  await sequenceNanoHostBlockedCreate('F4', fixture.ports);
  const thirdStart = fixture.actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action === 'startNanoHost')[2]?.index;

  assert.ok(thirdStart < fixture.actions.indexOf('readOwnerSnapshot:3'));
});

function sequencedNormalLifecycleFixture() {
  const baseline = { digest: digest('normal-lifecycle-baseline') };
  const baselines = [baseline, baseline, baseline, baseline];
  const actions = [];
  const state = { baselineReads: 0, generation: 7, running: true };
  const epoch = () => ({
    activeState: state.running ? 'active' : 'inactive',
    bootId: 'boot-normal',
    invocationId: state.running ? `invocation-normal-${state.generation}` : null,
    members: state.running
      ? [
          {
            args: ['/usr/lib/openkit/nanohost'],
            exe: '/usr/lib/openkit/nanohost',
            netns: `net:[${state.generation}]`,
            pid: state.generation * 10,
            starttime: String(state.generation * 100),
          },
        ]
      : [],
  });
  const ports = {
    instrumentDigest,
    nanoCoreContainer: 'openkit-nanocore-unit-f',
    nanoCoreImageId: `sha256:${'e'.repeat(64)}`,
    nanoCoreImageRef: 'openkit/app:unit-f',
    async pause() {},
    async readBaseline() {
      const value = baselines[Math.min(state.baselineReads, baselines.length - 1)];
      state.baselineReads += 1;
      return structuredClone(value);
    },
    async readEpoch() {
      return epoch();
    },
    async readEpochEffects() {
      return { absent: true };
    },
    async readPriorRoots() {
      return { absent: true };
    },
    async readRuntimeTarget() {
      return {
        connectionGeneration: state.generation,
        freshEmpty: true,
        predecessorFenced: true,
        ready: state.running,
      };
    },
    async runDockerSmoke() {
      actions.push('runDockerSmoke');
    },
    async startNanoHost() {
      actions.push('startNanoHost');
      state.generation += 1;
      state.running = true;
    },
    async stopNanoHost() {
      actions.push('stopNanoHost');
      state.running = false;
    },
    async waitFor(observe) {
      const observed = await observe();
      if (!observed) throw new Error('fixture observation remained incomplete');
      return observed;
    },
  };
  return { actions, baselines, ports, state };
}

test('sequences ordinary stop, fresh recovery, second stop, and final fresh start', async () => {
  const fixture = sequencedNormalLifecycleFixture();

  assert.equal(await sequenceNanoHostNormalLifecycle(fixture.ports), true);
  assert.deepEqual(fixture.actions, [
    'runDockerSmoke',
    'stopNanoHost',
    'startNanoHost',
    'stopNanoHost',
    'startNanoHost',
    'runDockerSmoke',
    'startNanoHost',
  ]);
});

for (const intervention of [
  {
    baselineIndex: 1,
    name: 'the first stopped baseline changes',
    startCalls: 1,
  },
  {
    baselineIndex: 2,
    name: 'the second stopped baseline changes',
    startCalls: 2,
  },
  {
    baselineIndex: 3,
    name: 'the final baseline changes',
    startCalls: 3,
  },
]) {
  test(`normal lifecycle fails closed when ${intervention.name}`, async () => {
    const fixture = sequencedNormalLifecycleFixture();
    fixture.baselines[intervention.baselineIndex] = {
      digest: digest(`changed:${intervention.baselineIndex}`),
    };

    await assert.rejects(sequenceNanoHostNormalLifecycle(fixture.ports));
    assert.equal(
      fixture.actions.filter((action) => action === 'startNanoHost').length,
      intervention.startCalls
    );
    assert.equal(fixture.actions.at(-1), 'startNanoHost');
  });
}

test('normal lifecycle rejects a nonready final target and still restores the service', async () => {
  const fixture = sequencedNormalLifecycleFixture();
  const readRuntimeTarget = fixture.ports.readRuntimeTarget;
  fixture.ports.readRuntimeTarget = async () => {
    const target = await readRuntimeTarget();
    return fixture.state.generation === 9 ? { ...target, ready: false } : target;
  };

  await assert.rejects(sequenceNanoHostNormalLifecycle(fixture.ports));
  assert.equal(fixture.actions.at(-1), 'startNanoHost');
});

for (const missing of ['action', 'cleanup']) {
  test(`single-scenario adjudication fails after fault when ${missing} evidence is absent`, () => {
    const evidence = {
      action: { code: contracts.F2.action, observed: true },
      barrier: { code: contracts.F2.barrier, observed: true },
      cleanup: { code: contracts.F2.cleanup, observed: true },
      fault: { code: contracts.F2.fault, observed: true },
      lineage: privateLineage,
    };
    delete evidence[missing];
    const baseline = { digest: digest('unit-f-baseline') };

    assert.equal(
      adjudicateNanoHostUnitFScenario('F2', evidence, baseline, baseline).status,
      'FAIL'
    );
  });
}

test('cleans the first fenced epoch before starting exactly one successor', async () => {
  const calls = [];
  const firstEpoch = { invocationId: 'first-fence-invocation' };
  const target = { connectionGeneration: 9, freshEmpty: true, ready: true };

  const recovered = await completeNanoHostFirstFenceRecovery({
    fenceGeneration: 8,
    firstEpoch,
    priorGeneration: 7,
    proveEffectsAbsent: async (received) => calls.push(['effects-absent', received]),
    proveEpochEmpty: async (received) => calls.push(['epoch-empty', received]),
    provePriorRootsRemoved: async (received) => calls.push(['roots-removed', received]),
    startSuccessor: async () => calls.push('start-successor'),
    waitForFreshTarget: async (generation) => {
      calls.push(['fresh-target', generation]);
      return target;
    },
  });

  assert.equal(recovered, target);
  assert.deepEqual(calls, [
    ['epoch-empty', firstEpoch],
    ['effects-absent', firstEpoch],
    'start-successor',
    ['fresh-target', 8],
    ['roots-removed', firstEpoch],
  ]);
});

test('rejects a first-fence generation that skips the direct predecessor', async () => {
  let startCalls = 0;

  await assert.rejects(
    completeNanoHostFirstFenceRecovery({
      fenceGeneration: 9,
      firstEpoch: { invocationId: 'first-fence-invocation' },
      priorGeneration: 7,
      proveEffectsAbsent: async () => {},
      proveEpochEmpty: async () => {},
      provePriorRootsRemoved: async () => {},
      startSuccessor: async () => {
        startCalls += 1;
      },
      waitForFreshTarget: async () => ({ connectionGeneration: 10 }),
    }),
    /first-fence generation/u
  );
  assert.equal(startCalls, 0);
});

test('rejects a first-fence successor generation that skips the fence', async () => {
  let startCalls = 0;

  await assert.rejects(
    completeNanoHostFirstFenceRecovery({
      fenceGeneration: 8,
      firstEpoch: { invocationId: 'first-fence-invocation' },
      priorGeneration: 7,
      proveEffectsAbsent: async () => {},
      proveEpochEmpty: async () => {},
      provePriorRootsRemoved: async () => {},
      startSuccessor: async () => {
        startCalls += 1;
      },
      waitForFreshTarget: async () => ({ connectionGeneration: 10 }),
    }),
    /successor generation/u
  );
  assert.equal(startCalls, 1);
});

test('does not start a first-fence successor when cleanup proof fails', async () => {
  let startCalls = 0;

  await assert.rejects(
    completeNanoHostFirstFenceRecovery({
      fenceGeneration: 8,
      firstEpoch: { invocationId: 'first-fence-invocation' },
      proveEffectsAbsent: async () => {
        throw new Error('effects remain');
      },
      proveEpochEmpty: async () => {},
      provePriorRootsRemoved: async () => {},
      startSuccessor: async () => {
        startCalls += 1;
      },
      waitForFreshTarget: async () => null,
    }),
    /effects remain/u
  );
  assert.equal(startCalls, 0);
});

function f1ContinuationEvidence() {
  const lineage = {
    agentSessionId: 'agent-session-f1',
    packageSnapshotId: 'snapshot-f1',
    requestId: 'request-f1',
  };
  const originalOwners = {
    artifacts: [{ fingerprint: 'artifact-original', id: 'artifact-original' }],
    capabilityCalls: [
      {
        completedAt: null,
        errorCode: null,
        family: 'llm',
        fingerprint: 'capability-original',
        id: 'capability-original',
        serviceRef: 'worker-inference-gateway',
        status: 'running',
      },
      {
        completedAt: '2026-08-23T00:00:00.000Z',
        errorCode: null,
        family: 'llm',
        fingerprint: 'capability-terminal',
        id: 'capability-terminal',
        serviceRef: 'worker-inference-gateway',
        status: 'succeeded',
      },
    ],
    inference: [
      {
        capabilityCallId: 'capability-original',
        fingerprint: 'inference-original',
        id: 'inference-original',
      },
    ],
    items: [{ fingerprint: 'item-original', id: 'item-original', type: 'user-message' }],
  };
  const snapshot = (sequences, leaseSequence, projectionOwners, overrides = {}) => ({
    backends: [
      {
        agentSessionId: lineage.agentSessionId,
        backendSessionId: 'backend-f1',
        packageSnapshotId: lineage.packageSnapshotId,
      },
    ],
    events: sequences.map((sequence) => ({ event: { type: 'worker.output' }, sequence })),
    finalStatus: null,
    leases: [
      {
        agentSessionId: lineage.agentSessionId,
        lastWorkerSequence: leaseSequence,
        leaseId: 'lease-f1',
        packageSnapshotId: lineage.packageSnapshotId,
        workerProcessKeyHash: 'process-key-f1',
      },
    ],
    projectionCounts: {
      activeBackend: 1,
      activeLease: 1,
      workerReady: 1,
    },
    projectionOwners,
    runtimeEvidence: [],
    ...overrides,
  });
  const before = snapshot([1], 0, structuredClone(originalOwners));
  const adopted = snapshot([1, 2], 1, structuredClone(originalOwners));
  const finalOwners = structuredClone(originalOwners);
  finalOwners.capabilityCalls[0].status = 'succeeded';
  finalOwners.capabilityCalls[0].completedAt = '2026-08-23T00:00:01.000Z';
  finalOwners.capabilityCalls.push({
    completedAt: '2026-08-23T00:00:02.000Z',
    errorCode: null,
    family: 'llm',
    fingerprint: 'capability-final',
    id: 'capability-final',
    serviceRef: 'worker-inference-gateway',
    status: 'succeeded',
  });
  finalOwners.inference.push({
    capabilityCallId: 'capability-final',
    fingerprint: 'inference-final',
    id: 'inference-final',
  });
  finalOwners.items.push(
    {
      fingerprint: 'item-final',
      id: 'it_worker_turn-f1_3',
      transcriptSequence: 3,
      type: 'assistant-message',
    },
    {
      artifactId: 'worker-artifact-snapshot-f1-4',
      fingerprint: 'artifact-reference-final',
      id: 'item-artifact-reference-final',
      type: 'artifact-reference',
    }
  );
  finalOwners.artifacts.push({
    fingerprint: 'artifact-final',
    id: 'worker-artifact-snapshot-f1-4',
    requestId: lineage.requestId,
    transcriptSequence: 4,
  });
  const final = snapshot([1, 2, 5], 1, finalOwners, {
    finalStatus: { sequence: 5, status: 'completed' },
    leases: [
      {
        agentSessionId: lineage.agentSessionId,
        lastWorkerSequence: 1,
        leaseId: 'lease-f1',
        packageSnapshotId: lineage.packageSnapshotId,
        workerProcessKeyHash: 'process-key-f1',
      },
    ],
    projectionCounts: {
      activeBackend: 0,
      activeLease: 0,
      workerReady: 1,
    },
    runtimeEvidence: [{ phase: 'teardown' }],
  });
  const member = {
    exe: '/usr/lib/openkit/nanohost',
    netns: 'net:[1]',
    pid: 101,
    starttime: '1001',
  };
  return {
    adopted,
    before,
    epochAfter: {
      bootId: 'boot-f1',
      invocationId: 'invocation-f1',
      members: [{ ...member }],
    },
    epochBefore: {
      bootId: 'boot-f1',
      invocationId: 'invocation-f1',
      members: [{ ...member }],
    },
    final,
    journal: '',
    lineage,
    priorGeneration: 7,
    successorTarget: {
      connectionGeneration: 8,
      predecessorFenced: true,
      ready: true,
    },
  };
}

test('accepts one exact F1 successor continuation', () => {
  assert.equal(adjudicateNanoHostF1Continuation(f1ContinuationEvidence()), true);
});

test('accepts batched monotonic F1 successor progress', () => {
  const evidence = f1ContinuationEvidence();
  const resumedCapability = {
    completedAt: '2026-08-23T00:00:01.500Z',
    errorCode: null,
    family: 'llm',
    fingerprint: 'capability-resumed',
    id: 'capability-resumed',
    serviceRef: 'worker-inference-gateway',
    status: 'succeeded',
  };
  const resumedInference = {
    capabilityCallId: resumedCapability.id,
    fingerprint: 'inference-resumed',
    id: 'inference-resumed',
  };
  evidence.adopted.projectionOwners.capabilityCalls.push(resumedCapability);
  evidence.adopted.projectionOwners.inference.push(resumedInference);
  evidence.final.projectionOwners.capabilityCalls.splice(2, 0, resumedCapability);
  evidence.final.projectionOwners.inference.splice(1, 0, resumedInference);
  evidence.adopted.events.push({ event: { type: 'worker.output' }, sequence: 3 });
  evidence.adopted.leases[0].lastWorkerSequence = 2;
  evidence.final.events = [
    ...structuredClone(evidence.adopted.events),
    { event: { type: 'turn.completed' }, sequence: 6 },
  ];
  evidence.final.finalStatus.sequence = 6;
  evidence.final.leases[0].lastWorkerSequence = 2;
  evidence.final.projectionOwners.items[1].id = 'it_worker_turn-f1_4';
  evidence.final.projectionOwners.items[1].transcriptSequence = 4;
  evidence.final.projectionOwners.items[2].artifactId = 'worker-artifact-snapshot-f1-5';
  evidence.final.projectionOwners.artifacts[1].id = 'worker-artifact-snapshot-f1-5';
  evidence.final.projectionOwners.artifacts[1].transcriptSequence = 5;

  assert.equal(adjudicateNanoHostF1Continuation(evidence), true);
});

test('accepts final status batched into the first successor observation', () => {
  const evidence = f1ContinuationEvidence();
  evidence.adopted.events.push({ event: { type: 'turn.completed' }, sequence: 3 });
  evidence.adopted.finalStatus = { sequence: 3, status: 'completed' };
  evidence.final.events = structuredClone(evidence.adopted.events);
  evidence.final.finalStatus = structuredClone(evidence.adopted.finalStatus);
  evidence.final.projectionOwners = structuredClone(evidence.adopted.projectionOwners);

  assert.equal(adjudicateNanoHostF1Continuation(evidence), true);
});

test('accepts mutable sandbox descendants within one stable F1 epoch', () => {
  const evidence = f1ContinuationEvidence();
  evidence.epochAfter.members.push({
    args: ['/usr/bin/openshell-supervisor'],
    exe: '/usr/bin/openshell-supervisor',
    netns: 'net:[3]',
    pid: 104,
    starttime: '1004',
  });

  assert.equal(adjudicateNanoHostF1Continuation(evidence), true);
});

for (const intervention of [
  {
    mutate(evidence) {
      evidence.epochAfter.members = [];
    },
    name: 'baseline epoch member loss',
  },
  {
    mutate(evidence) {
      evidence.successorTarget.connectionGeneration = 9;
    },
    name: 'successor generation skip',
  },
  {
    mutate(evidence) {
      evidence.adopted.events[1].sequence = 3;
    },
    name: 'transcript sequence gap',
  },
  {
    mutate(evidence) {
      evidence.adopted.leases[0].lastWorkerSequence = 0;
    },
    name: 'heartbeat lease sequence did not advance',
  },
  {
    mutate(evidence) {
      evidence.adopted.projectionCounts.workerReady = 2;
    },
    name: 'duplicate worker ready',
  },
  {
    mutate(evidence) {
      evidence.adopted.projectionOwners.capabilityCalls.push({
        fingerprint: 'capability-replay',
        id: 'capability-replay',
        status: 'succeeded',
      });
    },
    name: 'capability replay',
  },
  {
    mutate(evidence) {
      evidence.adopted.projectionOwners.items.push({
        fingerprint: 'item-replay',
        id: 'item-replay',
        type: 'assistant-message',
      });
    },
    name: 'item replay',
  },
  {
    mutate(evidence) {
      evidence.adopted.projectionOwners.artifacts.push({
        fingerprint: 'artifact-replay',
        id: 'artifact-replay',
      });
    },
    name: 'artifact replay',
  },
  {
    mutate(evidence) {
      evidence.final.projectionOwners.capabilityCalls[0].fingerprint = 'capability-replayed';
    },
    name: 'final capability replay',
  },
  {
    mutate(evidence) {
      evidence.final.projectionOwners.capabilityCalls[1].completedAt = '2026-08-23T00:00:03.000Z';
    },
    name: 'terminal capability completion mutation',
  },
  {
    mutate(evidence) {
      evidence.final.projectionOwners.items[0].fingerprint = 'item-replayed';
    },
    name: 'final item replay',
  },
  {
    mutate(evidence) {
      evidence.final.projectionOwners.artifacts[0].fingerprint = 'artifact-replayed';
    },
    name: 'final artifact replay',
  },
]) {
  test(`rejects F1 continuation with ${intervention.name}`, () => {
    const evidence = f1ContinuationEvidence();
    intervention.mutate(evidence);

    assert.throws(
      () => adjudicateNanoHostF1Continuation(evidence),
      /F1 continuation proof failed/u
    );
  });
}

function completeScenarioEvidence() {
  return scenarioIds.map((id, index) => {
    const baseline = {
      digest: digest(`baseline:${id}`),
      ...(id === 'F1'
        ? { nanoCoreRestartInvariantDigest: digest(`baseline:${id}:nanocore-restart-invariant`) }
        : {}),
    };
    return {
      evidence: {
        action: { code: contracts[id].action, observed: true },
        barrier: { code: contracts[id].barrier, observed: true },
        ...(id === 'F1' ? { checkout: { code: contracts[id].checkout, observed: true } } : {}),
        ...(['F2', 'F4'].includes(id)
          ? { buildNetwork: { code: contracts[id].buildNetwork, observed: true } }
          : {}),
        cleanup: { code: contracts[id].cleanup, observed: true },
        credential: secretCanary,
        fault: { code: contracts[id].fault, observed: true },
        lineage: privateLineage,
        proof: scenarioProof(id, index),
        rawError: rawErrorCanary,
        verdict: 'PASS',
      },
      id,
      postBaseline: { ...baseline },
      preBaseline: { ...baseline },
    };
  });
}

function scenarioProof(id, index = scenarioIds.indexOf(id)) {
  const priorGeneration = 10 + index * 3;
  const fenceGeneration = id === 'F1' ? null : priorGeneration + 1;
  return {
    boot: digest(`${id}:boot`),
    faultTarget: digest(`${id}:fault-target`),
    fenceGeneration,
    effectRequest: id === 'F1' ? null : digest(`${id}:effect-request`),
    instrument: instrumentDigest,
    invocation: digest(`${id}:invocation`),
    members: digest(`${id}:members`),
    priorGeneration,
    sandbox: id === 'F1' ? null : digest(`${id}:sandbox`),
    successorGeneration: (fenceGeneration ?? priorGeneration) + (id === 'F1' ? 1 : 2),
  };
}

function completeNormalLifecycleEvidence() {
  return Object.fromEntries(
    Object.entries(normalLifecycleContract).map(([name, code]) => [name, { code, observed: true }])
  );
}

function completeFreshReadyNetworkEvidence() {
  const collectorHostNamespace = digest('unit-f-collector-host-network-namespace');
  const privateNamespace = digest('unit-f-private-network-namespace');
  return {
    defaultRoute: { device: 'tap0', gateway: '10.0.2.2', present: true },
    dockerdDns: {
      arguments: ['--dns', '1.1.1.1', '--dns', '8.8.8.8'],
      resolvers: ['1.1.1.1', '8.8.8.8'],
    },
    namespaceTopology: {
      collectorHost: collectorHostNamespace,
      members: {
        containerd: privateNamespace,
        dockerd: privateNamespace,
        gateway: privateNamespace,
        nanohost: collectorHostNamespace,
        slirp: collectorHostNamespace,
      },
      private: privateNamespace,
    },
    privateNamespaceReachability: {
      privateLoopback: {
        hostNanoCore: false,
        sentinel: false,
      },
      defaultRouteGateway: {
        hostNanoCore: false,
        sentinel: false,
      },
    },
    serviceRoot: { systemDockerSocketOpen: false },
    slirp: {
      arguments: [
        '--configure',
        '--disable-host-loopback',
        '--disable-dns',
        '--enable-sandbox',
        '--enable-seccomp',
        '--ready-fd=3',
        '--netns-type=path',
        '/proc/self/fd/4',
        'tap0',
      ],
      executable: '/usr/bin/slirp4netns',
      namespace: collectorHostNamespace,
      readyFdObserved: true,
    },
    tap: { name: 'tap0', present: true },
  };
}

function createNetworkCollectorFixture(
  childOutcome = 'success',
  mutateAfterOpenRole = null,
  serviceRootOutcome = 'error'
) {
  const collectorHost = 'unit-f-collector-host-network-namespace';
  const privateNamespace = 'unit-f-private-network-namespace';
  const events = [];
  const networkDescriptor = 41;
  const serviceRootDescriptor = 42;
  const roles = Object.fromEntries(
    [
      ['nanohost', 1101, '/usr/local/bin/nanohost', ['/usr/local/bin/nanohost'], collectorHost],
      [
        'slirp',
        1102,
        '/usr/bin/slirp4netns',
        ['/usr/bin/slirp4netns', ...completeFreshReadyNetworkEvidence().slirp.arguments],
        collectorHost,
      ],
      [
        'containerd',
        1103,
        '/usr/bin/containerd',
        ['/usr/bin/containerd', '--address', '/run/openkit/nanohost/containerd.sock'],
        privateNamespace,
      ],
      [
        'dockerd',
        1104,
        '/usr/bin/dockerd',
        ['/usr/bin/dockerd', '--dns', '1.1.1.1', '--dns', '8.8.8.8'],
        privateNamespace,
      ],
      [
        'gateway',
        1105,
        '/usr/bin/openshell-gateway',
        ['/usr/bin/openshell-gateway'],
        privateNamespace,
      ],
    ].map(([role, pid, exe, args, netns]) => [
      role,
      { args, exe, netns, pid, starttime: String(pid * 10) },
    ])
  );
  const membersByPid = new Map(Object.values(roles).map((member) => [member.pid, member]));
  let expireNamespaceProbe;
  let namespaceChild;
  let resolveChildErrored;
  let resolveServiceRootClosed;
  let resolveSpawned;
  const childErrored = new Promise((resolvePromise) => {
    resolveChildErrored = resolvePromise;
  });
  const spawned = new Promise((resolvePromise) => {
    resolveSpawned = resolvePromise;
  });
  const serviceRootClosed = new Promise((resolvePromise) => {
    resolveServiceRootClosed = resolvePromise;
  });
  const descriptorWasOpened = (member) =>
    events.includes(
      `descriptor:open:/proc/${member.pid}/${member === roles.nanohost ? 'root' : 'ns/net'}`
    );
  const controls = {
    clearTimer() {
      events.push('timer:clear');
    },
    closeDescriptor(descriptor) {
      events.push(`descriptor:close:${descriptor}`);
    },
    connectSocket(target) {
      events.push(`socket:connect:${target.path}`);
      const socket = new EventEmitter();
      socket.destroy = () => {
        events.push('socket:destroy');
        if (serviceRootOutcome === 'timeout-close') {
          queueMicrotask(() => {
            events.push('socket:close');
            socket.emit('close');
            resolveServiceRootClosed();
          });
        }
      };
      socket.setTimeout = (_milliseconds, callback) => {
        if (serviceRootOutcome === 'timeout-close') queueMicrotask(callback);
      };
      if (serviceRootOutcome === 'error') {
        queueMicrotask(() => {
          const error = new Error('socket unavailable');
          error.code = 'EACCES';
          socket.emit('error', error);
        });
      }
      return socket;
    },
    createSentinel() {
      const sentinel = new EventEmitter();
      sentinel.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 32123 });
      sentinel.close = (callback) => {
        events.push('sentinel:close');
        callback();
      };
      sentinel.listen = (_port, _host, callback) => {
        events.push('sentinel:listen');
        callback();
      };
      return sentinel;
    },
    digest,
    openDescriptor(path) {
      events.push(`descriptor:open:${path}`);
      if (path === `/proc/${roles.gateway.pid}/ns/net`) return networkDescriptor;
      if (path === `/proc/${roles.nanohost.pid}/root`) return serviceRootDescriptor;
      throw new Error(`unexpected descriptor path: ${path}`);
    },
    readFile(path) {
      events.push(`read:file:${path}`);
      if (path === '/run/systemd/resolve/resolv.conf') {
        return 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n';
      }
      const match = /^\/proc\/(\d+)\/(cmdline|stat)$/u.exec(path);
      if (!match) throw new Error(`unexpected read path: ${path}`);
      const member = membersByPid.get(Number(match[1]));
      if (!member) throw new Error(`unexpected member path: ${path}`);
      if (match[2] === 'cmdline') return `${member.args.join('\0')}\0`;
      const fields = Array.from({ length: 22 }, () => '0');
      fields[2] = 'S';
      fields[21] =
        mutateAfterOpenRole && member === roles[mutateAfterOpenRole] && descriptorWasOpened(member)
          ? `${member.starttime}-changed`
          : member.starttime;
      return fields.join(' ');
    },
    readLink(path) {
      events.push(`read:link:${path}`);
      if (path === '/proc/self/ns/net') return collectorHost;
      if (path === `/proc/self/fd/${networkDescriptor}`) return privateNamespace;
      const match = /^\/proc\/(\d+)\/(exe|ns\/net)$/u.exec(path);
      if (!match) throw new Error(`unexpected link path: ${path}`);
      const member = membersByPid.get(Number(match[1]));
      if (!member) throw new Error(`unexpected member link: ${path}`);
      return match[2] === 'exe' ? member.exe : member.netns;
    },
    setTimer(callback) {
      events.push('timer:set');
      expireNamespaceProbe = callback;
      return Symbol('namespace-probe-timer');
    },
    spawnChild(file, args, options) {
      events.push('child:spawn');
      namespaceChild = new EventEmitter();
      namespaceChild.stdout = new EventEmitter();
      namespaceChild.kill = (signal) => events.push(`child:kill:${signal}`);
      namespaceChild.spawnCall = { args, file, options };
      resolveSpawned();
      if (childOutcome !== 'timeout') {
        queueMicrotask(() => {
          if (childOutcome === 'error') {
            events.push('child:error');
            namespaceChild.emit('error', new Error('namespace probe spawn failed'));
            resolveChildErrored();
            return;
          }
          if (childOutcome === 'abnormal-close') {
            events.push('child:close:7');
            namespaceChild.emit('close', 7);
            return;
          }
          namespaceChild.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                defaultRoute: { gateway: '10.0.2.2', present: true },
                reachability: {
                  defaultRouteGateway: { hostNanoCore: false, sentinel: false },
                  privateLoopback: { hostNanoCore: false, sentinel: false },
                },
                tap: true,
              })
            )
          );
          events.push('child:close:0');
          namespaceChild.emit('close', 0);
        });
      }
      return namespaceChild;
    },
  };
  return {
    closeNamespaceChild(status) {
      events.push(`child:close:${status}`);
      namespaceChild.emit('close', status);
    },
    childErrored,
    controls,
    events,
    expireNamespaceProbe: () => expireNamespaceProbe(),
    input: { nanoCorePort: 32100, probe: 'raw namespace probe', roles },
    networkDescriptor,
    roles,
    serviceRootDescriptor,
    serviceRootClosed,
    spawned,
    spawnCall: () => namespaceChild.spawnCall,
  };
}

function assertCollectorResourcesClosed(fixture) {
  assert.ok(fixture.events.includes(`descriptor:close:${fixture.networkDescriptor}`));
  assert.ok(fixture.events.includes(`descriptor:close:${fixture.serviceRootDescriptor}`));
  assert.ok(fixture.events.includes('sentinel:close'));
}

test('collects one valid observation through pinned namespace and service-root descriptors', async () => {
  const fixture = createNetworkCollectorFixture();
  const observation = await collectNanoHostNetworkObservations(fixture.input, fixture.controls);
  const expected = completeFreshReadyNetworkEvidence();
  delete expected.slirp.readyFdObserved;

  assert.deepEqual(observation, expected);
  const networkOpen = fixture.events.indexOf(
    `descriptor:open:/proc/${fixture.roles.gateway.pid}/ns/net`
  );
  const rootOpen = fixture.events.indexOf(
    `descriptor:open:/proc/${fixture.roles.nanohost.pid}/root`
  );
  assert.notEqual(networkOpen, -1, 'target namespace descriptor was not opened');
  assert.notEqual(rootOpen, -1, 'NanoHost service-root descriptor was not opened');
  for (const [openIndex, member, effectEvent] of [
    [networkOpen, fixture.roles.gateway, 'child:spawn'],
    [
      rootOpen,
      fixture.roles.nanohost,
      `socket:connect:/proc/self/fd/${fixture.serviceRootDescriptor}/run/docker.sock`,
    ],
  ]) {
    const effectIndex = fixture.events.indexOf(effectEvent);
    for (const suffix of ['stat', 'cmdline']) {
      const readIndex = fixture.events.indexOf(
        `read:file:/proc/${member.pid}/${suffix}`,
        openIndex + 1
      );
      assert.ok(readIndex > openIndex && readIndex < effectIndex);
    }
    for (const suffix of ['exe', 'ns/net']) {
      const readIndex = fixture.events.indexOf(
        `read:link:/proc/${member.pid}/${suffix}`,
        openIndex + 1
      );
      assert.ok(readIndex > openIndex && readIndex < effectIndex);
    }
  }
  assert.ok(
    fixture.events.includes(
      `socket:connect:/proc/self/fd/${fixture.serviceRootDescriptor}/run/docker.sock`
    )
  );
  const spawnCall = fixture.spawnCall();
  assert.ok(
    spawnCall.options.stdio.includes(fixture.networkDescriptor),
    'namespace descriptor was not inherited by the probe child'
  );
  assertCollectorResourcesClosed(fixture);
});

test('rejects a post-open identity change before any network effect', async () => {
  const fixture = createNetworkCollectorFixture('success', 'nanohost');

  await assert.rejects(
    collectNanoHostNetworkObservations(fixture.input, fixture.controls),
    /epoch member identity changed/u
  );
  assert.equal(
    fixture.events.some((event) => event.startsWith('socket:connect:')),
    false
  );
  assert.equal(fixture.events.includes('child:spawn'), false);
  assertCollectorResourcesClosed(fixture);
});

test('rejects a close-only service-root socket timeout before spawning the namespace child', async () => {
  const fixture = createNetworkCollectorFixture('success', null, 'timeout-close');
  let outcome = { status: 'pending' };
  void collectNanoHostNetworkObservations(fixture.input, fixture.controls).then(
    () => {
      outcome = { status: 'resolved' };
    },
    (error) => {
      outcome = { error, status: 'rejected' };
    }
  );

  await fixture.serviceRootClosed;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fixture.events.includes('child:spawn'), false);
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.error.message, /service-root probe deadline expired/u);
  assertCollectorResourcesClosed(fixture);
});

test('waits for a killed namespace probe to close before rejecting its timeout', async () => {
  const fixture = createNetworkCollectorFixture('timeout');
  let settled = false;
  const collection = collectNanoHostNetworkObservations(fixture.input, fixture.controls);
  void collection.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await fixture.spawned;

  fixture.expireNamespaceProbe();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.ok(fixture.events.includes('child:kill:SIGKILL'));
  fixture.closeNamespaceChild(null);
  await assert.rejects(collection, /namespace probe deadline expired/u);
  assertCollectorResourcesClosed(fixture);
  assert.ok(
    fixture.events.indexOf(`descriptor:close:${fixture.networkDescriptor}`) >
      fixture.events.indexOf('child:close:null')
  );
  assert.ok(fixture.events.indexOf('sentinel:close') > fixture.events.indexOf('child:close:null'));
});

test('waits for namespace child close after spawn error before cleanup and rejection', async () => {
  const fixture = createNetworkCollectorFixture('error');
  let settled = false;
  const collection = collectNanoHostNetworkObservations(fixture.input, fixture.controls);
  void collection.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await fixture.childErrored;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(settled, false);
  assert.equal(
    fixture.events.some((event) => event.startsWith('descriptor:close:')),
    false
  );
  assert.equal(fixture.events.includes('sentinel:close'), false);
  fixture.closeNamespaceChild(null);
  await assert.rejects(collection, /namespace probe spawn failed/u);
  assertCollectorResourcesClosed(fixture);
  assert.ok(
    fixture.events.indexOf(`descriptor:close:${fixture.networkDescriptor}`) >
      fixture.events.indexOf('child:close:null')
  );
  assert.ok(fixture.events.indexOf('sentinel:close') > fixture.events.indexOf('child:close:null'));
});

test('releases collector resources after namespace child abnormal-close', async () => {
  const fixture = createNetworkCollectorFixture('abnormal-close');

  await assert.rejects(
    collectNanoHostNetworkObservations(fixture.input, fixture.controls),
    /namespace probe failed/u
  );
  assertCollectorResourcesClosed(fixture);
  assert.ok(
    fixture.events.indexOf(`descriptor:close:${fixture.networkDescriptor}`) >
      fixture.events.indexOf('child:close:7')
  );
  assert.ok(fixture.events.indexOf('sentinel:close') > fixture.events.indexOf('child:close:7'));
});

function createPrivateNamespaceCollectorFixture({
  gatewayBytes = '0202000A',
  outcomes = [],
  routeFlags = '0003',
} = {}) {
  const events = [];
  const targets = [];
  let resolveSocketClosed;
  const socketClosed = new Promise((resolvePromise) => {
    resolveSocketClosed = resolvePromise;
  });
  const controls = {
    connectSocket(target) {
      const outcome = outcomes[targets.length] ?? 'error';
      targets.push(target);
      events.push(`socket:${outcome}`);
      const socket = new EventEmitter();
      let destroyed = false;
      socket.destroy = () => {
        if (destroyed) return;
        destroyed = true;
        events.push('socket:destroy');
        if (outcome === 'timeout') {
          queueMicrotask(() => {
            const error = new Error('timed out socket closed');
            error.code = 'ECONNREFUSED';
            socket.emit('error', error);
          });
        }
        if (outcome === 'timeout-close') {
          queueMicrotask(() => {
            events.push('socket:close');
            socket.emit('close');
            resolveSocketClosed();
          });
        }
      };
      socket.setTimeout = (_milliseconds, callback) => {
        if (outcome === 'timeout' || outcome === 'timeout-close') queueMicrotask(callback);
      };
      if (outcome === 'connect') queueMicrotask(() => socket.emit('connect'));
      if (outcome === 'error') {
        queueMicrotask(() => {
          const error = new Error('target unreachable');
          error.code = 'ECONNREFUSED';
          socket.emit('error', error);
        });
      }
      return socket;
    },
    readFile(path) {
      events.push(`read:${path}`);
      if (path === '/proc/net/dev') {
        return [
          'Inter-|   Receive                                                |  Transmit',
          ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed',
          '    lo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
          '  tap0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
          '',
        ].join('\n');
      }
      if (path === '/proc/net/route') {
        return [
          'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
          `tap0\t00000000\t${gatewayBytes}\t${routeFlags}\t0\t0\t0\t00000000\t0\t0\t0`,
          '',
        ].join('\n');
      }
      throw new Error(`unexpected private namespace read: ${path}`);
    },
  };
  return {
    controls,
    events,
    input: { nanoCorePort: 32100, sentinelPort: 32123 },
    socketClosed,
    targets,
  };
}

function completeNetworkAttemptEvidence() {
  return {
    networkConformanceEvidence: completeFreshReadyNetworkEvidence(),
    normalLifecycleEvidence: completeNormalLifecycleEvidence(),
    scenarioEvidence: completeScenarioEvidence(),
  };
}

function adjudicateNetworkAttempt(evidence) {
  return adjudicateNanoHostUnitFResult({
    attemptId: privateAttemptId,
    identity: publicIdentity,
    instrumentDigest,
    ...evidence,
  });
}

test('collects the raw private namespace route and four ordered negative reachability rows', async () => {
  const fixture = createPrivateNamespaceCollectorFixture();

  assert.deepEqual(
    await collectPrivateNamespaceNetworkObservations(fixture.input, fixture.controls),
    {
      defaultRoute: { gateway: '10.0.2.2', present: true },
      reachability: {
        defaultRouteGateway: { hostNanoCore: false, sentinel: false },
        privateLoopback: { hostNanoCore: false, sentinel: false },
      },
      tap: true,
    }
  );
  assert.deepEqual(fixture.targets, [
    { host: '127.0.0.1', port: fixture.input.nanoCorePort },
    { host: '127.0.0.1', port: fixture.input.sentinelPort },
    { host: '10.0.2.2', port: fixture.input.nanoCorePort },
    { host: '10.0.2.2', port: fixture.input.sentinelPort },
  ]);
});

for (const intervention of [
  {
    error: /private default route unavailable/u,
    name: 'a default route without RTF_GATEWAY',
    options: { routeFlags: '0001' },
  },
  {
    error: /private default route gateway invalid/u,
    name: 'a non-unicast default-route gateway',
    options: { gatewayBytes: '00000000' },
  },
  {
    error: /private default route unavailable/u,
    name: 'malformed default-route gateway bytes',
    options: { gatewayBytes: '0202000' },
  },
]) {
  test(`rejects ${intervention.name} before private reachability effects`, async () => {
    const fixture = createPrivateNamespaceCollectorFixture(intervention.options);

    await assert.rejects(
      collectPrivateNamespaceNetworkObservations(fixture.input, fixture.controls),
      intervention.error
    );
    assert.deepEqual(fixture.targets, []);
  });
}

test('rejects a timed-out private namespace reachability branch', async () => {
  const fixture = createPrivateNamespaceCollectorFixture({ outcomes: ['timeout'] });

  await assert.rejects(
    collectPrivateNamespaceNetworkObservations(fixture.input, fixture.controls),
    /private namespace probe deadline expired/u
  );
  assert.deepEqual(fixture.targets, [{ host: '127.0.0.1', port: fixture.input.nanoCorePort }]);
});

test('rejects a close-only private namespace socket timeout instead of remaining pending', async () => {
  const fixture = createPrivateNamespaceCollectorFixture({ outcomes: ['timeout-close'] });
  let outcome = { status: 'pending' };
  void collectPrivateNamespaceNetworkObservations(fixture.input, fixture.controls).then(
    () => {
      outcome = { status: 'resolved' };
    },
    (error) => {
      outcome = { error, status: 'rejected' };
    }
  );

  await fixture.socketClosed;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.error.message, /private namespace probe deadline expired/u);
  assert.deepEqual(fixture.targets, [{ host: '127.0.0.1', port: fixture.input.nanoCorePort }]);
});

for (const branch of [
  { index: 0, path: ['privateLoopback', 'hostNanoCore'] },
  { index: 1, path: ['privateLoopback', 'sentinel'] },
  { index: 2, path: ['defaultRouteGateway', 'hostNanoCore'] },
  { index: 3, path: ['defaultRouteGateway', 'sentinel'] },
]) {
  test(`maps reachable branch ${branch.path.join('.')} and fails aggregate conformance`, async () => {
    const outcomes = Array.from({ length: 4 }, () => 'error');
    outcomes[branch.index] = 'connect';
    const fixture = createPrivateNamespaceCollectorFixture({ outcomes });
    const observation = await collectPrivateNamespaceNetworkObservations(
      fixture.input,
      fixture.controls
    );
    const expectedReachability = {
      defaultRouteGateway: { hostNanoCore: false, sentinel: false },
      privateLoopback: { hostNanoCore: false, sentinel: false },
    };
    expectedReachability[branch.path[0]][branch.path[1]] = true;

    assert.deepEqual(observation.reachability, expectedReachability);
    const evidence = completeNetworkAttemptEvidence();
    evidence.networkConformanceEvidence.defaultRoute = {
      device: 'tap0',
      ...observation.defaultRoute,
    };
    evidence.networkConformanceEvidence.privateNamespaceReachability = observation.reachability;
    evidence.networkConformanceEvidence.tap = { name: 'tap0', present: observation.tap };
    assert.equal(adjudicateNetworkAttempt(evidence).aggregate.status, 'FAIL');
  });
}

test('admits one complete finite network-conformance evidence input', () => {
  const result = adjudicateNetworkAttempt(completeNetworkAttemptEvidence());

  assert.deepEqual(result.aggregate.networkConformance, {
    observations: networkConformanceContract,
    status: 'PASS',
  });
  assert.equal(result.aggregate.status, 'PASS');
});

for (const intervention of [
  {
    mutate(evidence) {
      evidence.namespaceTopology.collectorHost = evidence.namespaceTopology.private;
    },
    name: 'a collector reported inside the private namespace',
  },
  {
    mutate(evidence) {
      evidence.namespaceTopology.members.gateway = evidence.namespaceTopology.collectorHost;
    },
    name: 'a private runtime member in the host namespace',
  },
  {
    mutate(evidence) {
      evidence.slirp.namespace = evidence.namespaceTopology.private;
    },
    name: 'slirp outside the host namespace',
  },
  {
    mutate(evidence) {
      evidence.slirp.executable = '/usr/local/bin/slirp4netns';
    },
    name: 'a different slirp executable',
  },
  {
    mutate(evidence) {
      evidence.slirp.arguments.splice(
        evidence.slirp.arguments.indexOf('--disable-host-loopback'),
        1
      );
    },
    name: 'an incomplete fixed slirp argument set',
  },
  {
    mutate(evidence) {
      evidence.slirp.readyFdObserved = false;
    },
    name: 'a missing slirp ready-fd observation',
  },
  {
    mutate(evidence) {
      evidence.tap.present = false;
    },
    name: 'a missing TAP interface',
  },
  {
    mutate(evidence) {
      evidence.defaultRoute.present = false;
    },
    name: 'a missing private default route',
  },
  {
    mutate(evidence) {
      delete evidence.defaultRoute.gateway;
    },
    name: 'a tap0 default route without an observed slirp host alias',
  },
  ...[
    ['0.0.0.0', 'an unspecified default-route gateway'],
    ['127.0.0.1', 'a loopback default-route gateway'],
    ['224.0.0.1', 'a multicast default-route gateway'],
    ['255.255.255.255', 'a limited-broadcast default-route gateway'],
  ].map(([gateway, name]) => ({
    mutate(evidence) {
      evidence.defaultRoute.gateway = gateway;
    },
    name,
  })),
  {
    mutate(evidence) {
      evidence.dockerdDns.arguments[evidence.dockerdDns.arguments.length - 1] = '9.9.9.9';
    },
    name: 'dockerd DNS arguments that differ from the accepted resolvers',
  },
  {
    mutate(evidence) {
      evidence.privateNamespaceReachability.privateLoopback.hostNanoCore = true;
    },
    name: 'private-loopback reachability to host NanoCore',
  },
  {
    mutate(evidence) {
      evidence.privateNamespaceReachability.privateLoopback.sentinel = true;
    },
    name: 'private-loopback reachability to the attempt-local sentinel',
  },
  {
    mutate(evidence) {
      evidence.privateNamespaceReachability.defaultRouteGateway.hostNanoCore = true;
    },
    name: 'tap0-default-route slirp-host-alias reachability to host NanoCore',
  },
  {
    mutate(evidence) {
      evidence.privateNamespaceReachability.defaultRouteGateway.sentinel = true;
    },
    name: 'tap0-default-route slirp-host-alias reachability to the attempt-local sentinel',
  },
  {
    mutate(evidence) {
      evidence.serviceRoot.systemDockerSocketOpen = true;
    },
    name: 'NanoHost service-root access to the system Docker socket',
  },
]) {
  test(`rejects network-conformance evidence with ${intervention.name}`, () => {
    const evidence = completeNetworkAttemptEvidence();
    intervention.mutate(evidence.networkConformanceEvidence);

    const result = adjudicateNetworkAttempt(evidence);
    assert.equal(result.aggregate.status, 'FAIL');
    assert.deepEqual(result.aggregate.networkConformance, {
      observations: networkConformanceContract,
      status: 'FAIL',
    });
  });
}

for (const intervention of [
  {
    mutate(evidence) {
      delete evidence.scenarioEvidence[0].evidence.checkout;
    },
    name: 'no observed real Worker checkout',
  },
  {
    mutate(evidence) {
      evidence.scenarioEvidence[1].postBaseline.digest = digest('changed:F2');
    },
    name: 'no preserved system-Docker and business-container baseline',
  },
  {
    mutate(evidence) {
      delete evidence.scenarioEvidence[1].evidence.buildNetwork;
    },
    name: 'no post-NanoHost-SIGKILL system-Docker build-network smoke',
  },
  {
    mutate(evidence) {
      delete evidence.scenarioEvidence.find(({ id }) => id === 'F4').evidence.buildNetwork;
    },
    name: 'no post-member-failure system-Docker build-network smoke',
  },
  {
    mutate(evidence) {
      delete evidence.normalLifecycleEvidence.buildNetwork;
    },
    name: 'no normal-lifecycle system-Docker build-network smoke',
  },
]) {
  test(`rejects aggregate network conformance with ${intervention.name}`, () => {
    const evidence = completeNetworkAttemptEvidence();
    intervention.mutate(evidence);

    const result = adjudicateNetworkAttempt(evidence);
    assert.equal(result.aggregate.status, 'FAIL');
    assert.equal(result.aggregate.networkConformance?.status, 'FAIL');
  });
}

function adjudicateAttempt(overrides = {}) {
  const scenarioEvidence = completeScenarioEvidence();
  const invalid = overrides.invalid;
  if (invalid) {
    const evidence = scenarioEvidence.find(({ id }) => id === invalid.scenarioId).evidence;
    if (invalid.kind === 'missing') delete evidence[invalid.field];
    if (invalid.kind === 'wrong-code') evidence[invalid.field].code = 'proxy-supplied-decoy';
    if (invalid.kind === 'not-observed') evidence[invalid.field].observed = false;
  }
  if (overrides.baselineMismatch) {
    scenarioEvidence.find(({ id }) => id === overrides.baselineMismatch).postBaseline.digest =
      digest(`changed:${overrides.baselineMismatch}`);
  }
  if (overrides.invariantBaselineMismatch) {
    scenarioEvidence.find(
      ({ id }) => id === overrides.invariantBaselineMismatch
    ).postBaseline.nanoCoreRestartInvariantDigest = digest(
      `changed:${overrides.invariantBaselineMismatch}:nanocore-restart-invariant`
    );
  }
  const normalLifecycleEvidence = completeNormalLifecycleEvidence();
  if (overrides.invalidNormalLifecycle) {
    delete normalLifecycleEvidence[overrides.invalidNormalLifecycle];
  }
  return adjudicateNanoHostUnitFResult({
    attemptId: privateAttemptId,
    identity: publicIdentity,
    instrumentDigest,
    networkConformanceEvidence: completeFreshReadyNetworkEvidence(),
    normalLifecycleEvidence,
    scenarioEvidence,
  });
}

test('adjudicates the exact three Unit F scenarios and one aggregate from complete evidence', () => {
  const result = adjudicateAttempt();

  assert.deepEqual(result.identity, publicIdentity);
  assert.equal(result.attemptLineageHash, digest(privateAttemptId));
  assert.deepEqual(
    result.scenarios.map(({ id, status }) => ({ id, status })),
    scenarioIds.map((id) => ({ id, status: 'PASS' }))
  );
  for (const scenario of result.scenarios) {
    assert.deepEqual(scenario.observations, contracts[scenario.id]);
    assert.equal(scenario.baseline.pre, scenario.baseline.post);
    assert.equal(scenario.lineage.agentSession, digest(privateLineage.agentSessionId));
    assert.equal(scenario.lineage.backendSession, digest(privateLineage.backendSessionId));
    assert.equal(scenario.lineage.lease, digest(privateLineage.leaseId));
    assert.equal(scenario.lineage.turn, digest(privateLineage.turnId));
  }
  assert.deepEqual(result.aggregate, {
    id: 'Aggregate',
    networkConformance: {
      observations: networkConformanceContract,
      status: 'PASS',
    },
    normalLifecycle: {
      observations: normalLifecycleContract,
      status: 'PASS',
    },
    scenarioIds,
    status: 'PASS',
  });
  const serialized = JSON.stringify(result);
  for (const prohibited of [
    privateAttemptId,
    ...Object.values(privateLineage),
    secretCanary,
    rawErrorCanary,
  ]) {
    assert.doesNotMatch(serialized, new RegExp(prohibited, 'u'));
  }
});

test('accepts only an exact NanoCore restart delta in the F1 raw baseline', () => {
  const result = adjudicateAttempt({ baselineMismatch: 'F1' });
  const scenario = result.scenarios.find(({ id }) => id === 'F1');

  assert.equal(scenario.baseline.pre, scenario.baseline.post);
  assert.notEqual(scenario.baseline.rawPre, scenario.baseline.rawPost);
  assert.equal(scenario.status, 'PASS');
  assert.equal(result.aggregate.status, 'PASS');
  assert.deepEqual(JSON.parse(JSON.stringify(scenario)).baseline, scenario.baseline);
});

test('rejects an unrelated F1 baseline mutation', () => {
  const result = adjudicateAttempt({ invariantBaselineMismatch: 'F1' });
  const scenario = result.scenarios.find(({ id }) => id === 'F1');

  assert.notEqual(scenario.baseline.pre, scenario.baseline.post);
  assert.equal(scenario.status, 'FAIL');
  assert.equal(result.aggregate.status, 'FAIL');
});

test('normalizes only the exact NanoCore host-network endpoint across its restart', () => {
  const baseline = {
    bridge: [{ name: 'bridge' }],
    containers: [
      {
        id: 'nanocore-container',
        image: 'nanocore-image',
        name: '/openkit-nanocore-unit-f',
        networks: {
          host: {
            endpointId: 'a'.repeat(64),
            gateway: '',
            ipAddress: '',
            macAddress: '',
            networkId: 'host-network',
          },
        },
      },
      {
        id: 'business-container',
        image: 'business-image',
        name: '/business',
        networks: {
          bridge: {
            endpointId: 'b'.repeat(64),
            gateway: '172.17.0.1',
            ipAddress: '172.17.0.2',
            macAddress: '02:42:ac:11:00:02',
            networkId: 'bridge-network',
          },
        },
      },
    ],
    docker0: { address: [{ ifname: 'docker0' }], route: [{ dev: 'docker0' }] },
    nft: { nftables: [{ table: { family: 'ip', name: 'filter' } }] },
  };
  const normalized = (value) =>
    digest(
      JSON.stringify(
        normalizeNanoCoreRestartBaseline(structuredClone(value), 'openkit-nanocore-unit-f')
      )
    );
  const expected = normalized(baseline);
  const endpointRestart = structuredClone(baseline);
  endpointRestart.containers[0].networks.host.endpointId = 'c'.repeat(64);
  assert.equal(normalized(endpointRestart), expected);

  for (const mutate of [
    (value) => {
      value.bridge[0].name = 'changed';
    },
    (value) => {
      value.containers[0].id = 'changed';
    },
    (value) => {
      value.containers[0].networks.host.networkId = 'changed';
    },
    (value) => {
      value.containers[1].id = 'changed';
    },
    (value) => {
      value.containers[1].networks.bridge.endpointId = 'd'.repeat(64);
    },
    (value) => {
      value.docker0.route[0].dev = 'changed';
    },
    (value) => {
      value.nft.nftables[0].table.name = 'changed';
    },
  ]) {
    const changed = structuredClone(baseline);
    mutate(changed);
    assert.notEqual(normalized(changed), expected);
  }
});

test('fails closed when the exact NanoCore baseline row is missing or ambiguous', () => {
  const row = {
    name: '/openkit-nanocore-unit-f',
    networks: { host: { endpointId: 'a'.repeat(64) } },
  };
  assert.throws(
    () => normalizeNanoCoreRestartBaseline({ containers: [] }, 'openkit-nanocore-unit-f'),
    /exact NanoCore container/u
  );
  assert.throws(
    () =>
      normalizeNanoCoreRestartBaseline(
        { containers: [structuredClone(row), structuredClone(row)] },
        'openkit-nanocore-unit-f'
      ),
    /exact NanoCore container/u
  );
  assert.throws(
    () =>
      normalizeNanoCoreRestartBaseline(
        { containers: [{ ...row, networks: { bridge: row.networks.host } }] },
        'openkit-nanocore-unit-f'
      ),
    /exact NanoCore host-network endpoint/u
  );
});

test('requires exactly one evidence row for each accepted scenario and rejects F3', () => {
  const scenarioEvidence = completeScenarioEvidence();
  for (const missingId of scenarioIds) {
    assert.throws(
      () =>
        adjudicateNanoHostUnitFResult({
          attemptId: privateAttemptId,
          identity: publicIdentity,
          instrumentDigest,
          networkConformanceEvidence: completeFreshReadyNetworkEvidence(),
          normalLifecycleEvidence: completeNormalLifecycleEvidence(),
          scenarioEvidence: scenarioEvidence.filter(({ id }) => id !== missingId),
        }),
      /one exact evidence row per scenario/u
    );
  }
  assert.throws(
    () =>
      adjudicateNanoHostUnitFResult({
        attemptId: privateAttemptId,
        identity: publicIdentity,
        instrumentDigest,
        networkConformanceEvidence: completeFreshReadyNetworkEvidence(),
        normalLifecycleEvidence: completeNormalLifecycleEvidence(),
        scenarioEvidence: [
          ...scenarioEvidence,
          { ...structuredClone(scenarioEvidence[0]), id: 'F3' },
        ],
      }),
    /one exact evidence row per scenario/u
  );
});

test('rejects retained evidence whose scenario instrument differs from the actual runner', () => {
  const scenarioEvidence = completeScenarioEvidence();
  scenarioEvidence[2].evidence.proof.instrument = digest('foreign-unit-f-instrument');

  const result = adjudicateNanoHostUnitFResult({
    attemptId: privateAttemptId,
    identity: publicIdentity,
    instrumentDigest,
    networkConformanceEvidence: completeFreshReadyNetworkEvidence(),
    normalLifecycleEvidence: completeNormalLifecycleEvidence(),
    scenarioEvidence,
  });

  assert.equal(result.scenarios[2].status, 'FAIL');
  assert.equal(result.aggregate.status, 'FAIL');
});

for (const incomplete of [
  { field: 'barrier', kind: 'missing', scenarioId: 'F1' },
  { field: 'fault', kind: 'wrong-code', scenarioId: 'F2' },
  { field: 'action', kind: 'not-observed', scenarioId: 'F4' },
  { field: 'cleanup', kind: 'missing', scenarioId: 'F4' },
  { baselineMismatch: 'F2', scenarioId: 'F2' },
]) {
  const label = incomplete.field ? `${incomplete.kind} ${incomplete.field}` : 'baseline equality';
  test(`fails closed when ${incomplete.scenarioId} lacks ${label} despite a proxy PASS`, () => {
    const result = adjudicateAttempt(
      incomplete.field
        ? {
            invalid: {
              field: incomplete.field,
              kind: incomplete.kind,
              scenarioId: incomplete.scenarioId,
            },
          }
        : { baselineMismatch: incomplete.baselineMismatch }
    );

    assert.equal(result.scenarios.find(({ id }) => id === incomplete.scenarioId)?.status, 'FAIL');
    assert.deepEqual(result.aggregate, {
      id: 'Aggregate',
      networkConformance: {
        observations: networkConformanceContract,
        status: incomplete.baselineMismatch === 'F2' ? 'FAIL' : 'PASS',
      },
      normalLifecycle: {
        observations: normalLifecycleContract,
        status: 'PASS',
      },
      scenarioIds,
      status: 'FAIL',
    });
  });
}

test('fails the aggregate when its normal lifecycle gate is incomplete despite a proxy PASS', () => {
  const result = adjudicateAttempt({ invalidNormalLifecycle: 'ordinaryStop' });

  assert.deepEqual(
    result.scenarios.map(({ id, status }) => ({ id, status })),
    scenarioIds.map((id) => ({ id, status: 'PASS' }))
  );
  assert.equal(result.aggregate.id, 'Aggregate');
  assert.equal(result.aggregate.normalLifecycle.status, 'FAIL');
  assert.equal(result.aggregate.status, 'FAIL');
});

test('coordinates exact F1, F2, and F4 order before the normal lifecycle without trusting effects', async () => {
  const calls = [];
  const coordinated = await executeNanoHostUnitFCoordinator({
    captureBaseline: async () => {
      calls.push('baseline');
      return {
        digest: digest('coordinator-baseline'),
        nanoCoreRestartInvariantDigest: digest('coordinator-nanocore-restart-invariant'),
      };
    },
    captureNetworkConformance: async () => {
      calls.push('network');
      return completeFreshReadyNetworkEvidence();
    },
    executeScenarioEffect: async ({ scenarioId }) => {
      calls.push(`effect:${scenarioId}`);
      return {
        action: { code: 'effect-supplied-action', observed: false },
        barrier: { code: 'effect-supplied-barrier', observed: false },
        buildNetwork: { code: 'effect-supplied-build-network', observed: false },
        checkout: { code: 'effect-supplied-checkout', observed: false },
        cleanup: { code: 'effect-supplied-cleanup', observed: false },
        fault: { code: 'effect-supplied-fault', observed: false },
        lineage: privateLineage,
        proof: scenarioProof(scenarioId),
        verdict: 'PASS',
      };
    },
    verifyNormalLifecycleEffect: async () => {
      calls.push('normal');
    },
  });

  assert.deepEqual(calls, [
    'baseline',
    'network',
    'effect:F1',
    'baseline',
    'baseline',
    'effect:F2',
    'baseline',
    'baseline',
    'effect:F4',
    'baseline',
    'normal',
  ]);
  assert.deepEqual(coordinated.networkConformanceEvidence, completeFreshReadyNetworkEvidence());
  assert.deepEqual(
    coordinated.scenarioEvidence.map(({ evidence, id }) => ({ evidence, id })),
    scenarioIds.map((id) => ({
      evidence: {
        action: { code: contracts[id].action, observed: true },
        barrier: { code: contracts[id].barrier, observed: true },
        ...(id === 'F1' ? { checkout: { code: contracts[id].checkout, observed: true } } : {}),
        ...(['F2', 'F4'].includes(id)
          ? { buildNetwork: { code: contracts[id].buildNetwork, observed: true } }
          : {}),
        cleanup: { code: contracts[id].cleanup, observed: true },
        fault: { code: contracts[id].fault, observed: true },
        lineage: privateLineage,
        proof: scenarioProof(id),
      },
      id,
    }))
  );
  assert.equal(
    adjudicateNanoHostUnitFResult({
      attemptId: privateAttemptId,
      identity: publicIdentity,
      instrumentDigest,
      ...coordinated,
    }).aggregate.status,
    'PASS'
  );
});

test('stops Unit F before later scenarios and normal lifecycle when F2 effect fails', async () => {
  const calls = [];
  await assert.rejects(
    executeNanoHostUnitFCoordinator({
      captureBaseline: async () => {
        calls.push('baseline');
        return { digest: digest('coordinator-baseline') };
      },
      captureNetworkConformance: async () => {
        calls.push('network');
        return completeFreshReadyNetworkEvidence();
      },
      executeScenarioEffect: async ({ scenarioId }) => {
        calls.push(`effect:${scenarioId}`);
        if (scenarioId === 'F2') throw new Error('F2 effect failed');
        return { lineage: privateLineage, proof: scenarioProof(scenarioId) };
      },
      verifyNormalLifecycleEffect: async () => {
        calls.push('normal');
      },
    }),
    /F2 effect failed/u
  );
  assert.deepEqual(calls, [
    'baseline',
    'network',
    'effect:F1',
    'baseline',
    'baseline',
    'effect:F2',
  ]);
});

function defaultDriverOptions(overrides = {}) {
  return {
    attemptId: privateAttemptId,
    gitCommit: 'd'.repeat(40),
    gitUrl: 'https://github.com/openkit/openkit.git',
    hostManifestDigest: digest(readFileSync(join('tests', 'support', 'host', 'manifest.json'))),
    instrumentDigest,
    localPort: 17_893,
    nanoCoreContainer: 'openkit-nanocore-unit-f',
    nanoCoreImageId: `sha256:${'e'.repeat(64)}`,
    nanoCoreImageRef: 'openkit/app:unit-f',
    nanoHostDeploymentId: 'deployment-unit-f',
    nanoHostExecutableSha256: 'f'.repeat(64),
    nanoHostIdentityId: 'identity-unit-f',
    productCommit: publicIdentity.productCommit,
    remoteNanoCorePort: 3_001,
    sessionCookie: 'session-unit-f',
    sshAlias: 'a1',
    token: 'admin-token-unit-f',
    workerImageRef: publicIdentity.workerImageRef,
    ...overrides,
  };
}

async function runTerminalUnitFAttempt(options, controls) {
  const runner = await import('./support/host/nanohost-unit-f-runner.mjs');
  return runner.runNanoHostUnitFAttempt(options, controls);
}

function terminalAttemptOptions(overrides = {}) {
  return defaultDriverOptions({
    outputPath: '/tmp/openkit-r001-unit-f-result.json',
    ownerTimeoutMs: 7_200_000,
    ...overrides,
  });
}

function expectedTerminalPublicIdentity(options) {
  return {
    gitCommit: options.gitCommit,
    hostManifestDigest: options.hostManifestDigest,
    nanoCoreImageId: options.nanoCoreImageId,
    nanoCoreImageRef: options.nanoCoreImageRef,
    nanoHostDeploymentHash: digest(options.nanoHostDeploymentId),
    nanoHostExecutableSha256: options.nanoHostExecutableSha256,
    nanoHostIdentityHash: digest(options.nanoHostIdentityId),
    productCommit: options.productCommit,
    sshAlias: options.sshAlias,
    workerImageRef: options.workerImageRef,
  };
}

function assertTerminalPublicIdentity(result, options) {
  assert.deepEqual(result.identity, expectedTerminalPublicIdentity(options));
  assert.equal(Object.hasOwn(result.identity, 'nanoHostIdentityId'), false);
  assert.equal(Object.hasOwn(result.identity, 'nanoHostDeploymentId'), false);
}

const terminalEpochRoot = 'epoch-terminal-unit-f';
const terminalEpochRoots = [
  `/var/lib/openkit/nanohost/${terminalEpochRoot}`,
  `/run/openkit/nanohost/${terminalEpochRoot}`,
];

function createTerminalAttemptFixture({
  baselineDigests = [
    digest('pre-attempt'),
    digest('terminal-reference'),
    digest('terminal-reference'),
  ],
  cleanupFailure = null,
  decommissionIdentityId = 'identity-unit-f',
  gate = 'pass',
  gateIdentityMutation = null,
  interruptAfter = null,
  interruptBeforeStart = false,
  interruptDuringStart = false,
  outputState = 'absent',
  outputWriteFailure = false,
  startFailure = false,
  terminalEpochOwner = 'available',
  residue = {
    cgroupAbsent: true,
    netnsAbsent: true,
    socketsAbsent: true,
  },
} = {}) {
  const events = [];
  const terminalEpoch = Object.freeze({
    members: terminalEpochRoots.map((root) => ({ args: [`${root}/member`] })),
    opaqueEpoch: 'terminal-epoch-unit-f',
  });
  let baselineIndex = interruptBeforeStart || interruptDuringStart || startFailure ? 1 : 0;
  let interruptPending = interruptBeforeStart;
  let rejectGate;
  let releaseStart;
  let residueEpoch;
  let resolveStartEntered;
  let resolveTimerExpired;
  const removedRoots = [];
  let rootObservation = 0;
  let writtenResult;
  const startEntered = new Promise((resolvePromise) => {
    resolveStartEntered = resolvePromise;
  });
  const startRelease = new Promise((resolvePromise) => {
    releaseStart = resolvePromise;
  });
  const timerExpired = new Promise((resolvePromise) => {
    resolveTimerExpired = resolvePromise;
  });
  const controls = {
    captureBaseline: async () => {
      const label = ['pre', 'reference', 'post'][baselineIndex];
      events.push(`baseline:${label}`);
      return { digest: baselineDigests[baselineIndex++] };
    },
    captureTerminalEpoch: async () => {
      events.push('cleanup:capture-epoch');
      return terminalEpoch;
    },
    clearTimer() {
      events.push('timer:clear');
    },
    decommissionNanoHost: async () => {
      events.push('cleanup:decommission');
      if (cleanupFailure === 'decommissionNanoHost') {
        throw new Error('raw decommission failure with secret host state');
      }
      return {
        identityId: decommissionIdentityId,
        revokedTokenCount: 2,
        status: 'decommissioned',
      };
    },
    outputExists: async () => {
      events.push('output:check');
      return outputState === 'exists';
    },
    observeTerminalEpochRoots: async () => {
      events.push('cleanup:roots-observe');
      rootObservation += 1;
      if (cleanupFailure === 'rootReobservation' && rootObservation > 1) {
        throw new Error('raw epoch root reobservation failure with secret host state');
      }
      return rootObservation === 1 ? [...terminalEpochRoots] : [];
    },
    proveEpochResidueAbsent: async (epoch) => {
      events.push('cleanup:residue');
      residueEpoch = epoch;
      return { ...residue };
    },
    proveServiceInactive: async () => {
      events.push('cleanup:inactive');
      return true;
    },
    removeTerminalEpochRoots: async (roots) => {
      events.push('cleanup:roots-remove');
      removedRoots.push(...roots);
      if (cleanupFailure === 'rootRemoval') {
        throw new Error('raw epoch root removal failure with secret host state');
      }
    },
    readInterrupt: () =>
      interruptPending || (interruptAfter && events.includes(`gate:${interruptAfter}`))
        ? 'SIGINT'
        : null,
    runDockerSmoke: async () => {
      events.push(events.includes('baseline:post') ? 'cleanup:build-smoke' : 'attempt:build-smoke');
      return true;
    },
    runGate: async ({ beforePhase }) => {
      events.push('gate:start');
      if (gate === 'timeout') {
        return new Promise((_resolve, reject) => {
          rejectGate = reject;
        });
      }
      for (const phase of [...scenarioIds, 'normal-lifecycle']) {
        await beforePhase(phase);
        events.push(`gate:${phase}`);
        if (gate === 'scenario-failure' && phase === 'F2') {
          throw new Error('raw scenario failure with secret host state');
        }
      }
      const result = adjudicateNetworkAttempt(completeNetworkAttemptEvidence());
      result.identity = expectedTerminalPublicIdentity(terminalAttemptOptions());
      gateIdentityMutation?.(result.identity);
      return result;
    },
    setTimer(callback) {
      events.push('timer:set');
      if (gate === 'timeout') {
        queueMicrotask(() => {
          callback();
          resolveTimerExpired();
        });
      }
      return Symbol('terminal-attempt-owner-timer');
    },
    startNanoHost: async () => {
      events.push('attempt:start-nanohost');
      if (startFailure) throw new Error('raw initial start failure with secret host state');
      if (interruptDuringStart) {
        resolveStartEntered();
        await startRelease;
        events.push('attempt:start-settled');
      }
    },
    stopNanoHost: async () => {
      events.push('cleanup:stop-nanohost');
      if (cleanupFailure === 'stopNanoHost') {
        throw new Error('raw stop failure with secret host state');
      }
    },
    stopTunnel: async () => {
      events.push('cleanup:stop-tunnel');
    },
    writeOutput: async (_path, bytes, options) => {
      events.push('output:write');
      if (outputWriteFailure) throw new Error('raw output failure with secret path');
      assert.deepEqual(options, { flag: 'wx', mode: 0o600 });
      writtenResult = JSON.parse(String(bytes));
    },
  };
  if (terminalEpochOwner === 'missing') delete controls.captureTerminalEpoch;
  return {
    controls,
    events,
    interruptStart() {
      interruptPending = true;
      events.push('attempt:interrupt-pending');
      releaseStart();
    },
    rejectGate(error) {
      rejectGate(error);
    },
    removedRoots,
    residueEpoch: () => residueEpoch,
    terminalEpoch,
    timerExpired,
    startEntered,
    writtenResult: () => writtenResult,
  };
}

const terminalCleanupEvents = [
  'baseline:reference',
  'cleanup:capture-epoch',
  'cleanup:stop-nanohost',
  'cleanup:decommission',
  'cleanup:stop-tunnel',
  'cleanup:inactive',
  'cleanup:residue',
  'baseline:post',
  'cleanup:build-smoke',
];

function assertOneStoppedTerminalFinalizer(fixture, { terminalEpochCaptured = true } = {}) {
  const expectedEvents = terminalEpochCaptured
    ? terminalCleanupEvents
    : terminalCleanupEvents.filter((event) => event !== 'cleanup:capture-epoch');
  for (const event of expectedEvents) {
    assert.equal(
      fixture.events.filter((candidate) => candidate === event).length,
      1,
      `${event} did not run exactly once`
    );
  }
  assert.deepEqual(
    fixture.events.filter((event) => expectedEvents.includes(event)),
    expectedEvents
  );
}

test('warms the existing system Docker smoke before admitting the gate baseline', async () => {
  const fixture = createTerminalAttemptFixture();
  let smokeRuns = 0;
  fixture.controls.runDockerSmoke = async () => {
    smokeRuns += 1;
    fixture.events.push(`smoke:${smokeRuns}`);
    return true;
  };

  await runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls);

  assert.deepEqual(fixture.events.slice(0, 6), [
    'output:check',
    'attempt:start-nanohost',
    'smoke:1',
    'baseline:pre',
    'timer:set',
    'gate:start',
  ]);
  assert.equal(smokeRuns, 2);
});

test('finalizes one successful gate from terminal-reference facts before writing output', async () => {
  const fixture = createTerminalAttemptFixture();
  const options = terminalAttemptOptions();
  const result = await runTerminalUnitFAttempt(options, fixture.controls);

  assert.deepEqual(fixture.events.slice(0, 4), [
    'output:check',
    'attempt:start-nanohost',
    'attempt:build-smoke',
    'baseline:pre',
  ]);
  assert.equal(fixture.events.filter((event) => event === 'attempt:start-nanohost').length, 1);
  assert.equal(result.aggregate.status, 'PASS');
  assertTerminalPublicIdentity(result, options);
  assert.deepEqual(result.terminal, {
    baselinePreserved: true,
    buildNetworkSmoke: true,
    cleanupReasons: [],
    credentialsRemoved: true,
    decommissioned: true,
    epochResidueAbsent: true,
    primaryReason: null,
    serviceStopped: true,
  });
  assertOneStoppedTerminalFinalizer(fixture);
  assert.equal(
    fixture.events.indexOf('baseline:reference') + 1,
    fixture.events.indexOf('cleanup:capture-epoch')
  );
  assert.equal(
    fixture.events.indexOf('cleanup:capture-epoch') + 1,
    fixture.events.indexOf('cleanup:stop-nanohost')
  );
  assert.strictEqual(fixture.residueEpoch(), fixture.terminalEpoch);
  assert.ok(
    fixture.events.indexOf('baseline:pre') < fixture.events.indexOf('gate:start') &&
      fixture.events.indexOf('gate:normal-lifecycle') < fixture.events.indexOf('baseline:reference')
  );
  assert.ok(
    fixture.events.indexOf('baseline:post') < fixture.events.indexOf('cleanup:build-smoke') &&
      fixture.events.indexOf('cleanup:build-smoke') < fixture.events.indexOf('output:write')
  );
  assert.deepEqual(fixture.writtenResult(), result);
});

test('terminal epoch root removal accepts roots present before exact removal', async () => {
  const fixture = createTerminalAttemptFixture({
    residue: {
      cgroupAbsent: true,
      netnsAbsent: true,
      rootsAbsent: false,
      socketsAbsent: true,
    },
  });
  const result = await runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls);

  assert.equal(result.aggregate.status, 'PASS');
  assert.deepEqual(fixture.removedRoots, terminalEpochRoots);
  assert.deepEqual(
    fixture.events.filter((event) => event.startsWith('cleanup:roots-')),
    ['cleanup:roots-observe', 'cleanup:roots-remove', 'cleanup:roots-observe']
  );
  assert.ok(
    fixture.events.indexOf('cleanup:inactive') < fixture.events.indexOf('cleanup:roots-observe') &&
      fixture.events.indexOf('cleanup:residue') < fixture.events.indexOf('cleanup:roots-observe')
  );
  assert.ok(
    fixture.events.indexOf('cleanup:roots-observe') < fixture.events.indexOf('baseline:post') &&
      fixture.events.indexOf('baseline:post') < fixture.events.indexOf('cleanup:build-smoke') &&
      fixture.events.indexOf('cleanup:build-smoke') < fixture.events.indexOf('output:write')
  );
});

for (const cleanupCase of [
  {
    failure: 'rootRemoval',
    name: 'removal failure',
    reasons: ['terminal_epoch_root_removal_failed'],
  },
  {
    failure: 'rootReobservation',
    name: 'reobservation failure',
    reasons: ['terminal_epoch_root_reobservation_failed'],
  },
  {
    failure: 'decommissionNanoHost',
    name: 'decommission failure',
    reasons: ['decommission_failed'],
  },
]) {
  test(`terminal epoch root cleanup continues after ${cleanupCase.name}`, async () => {
    const fixture = createTerminalAttemptFixture({ cleanupFailure: cleanupCase.failure });
    const result = await runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls);

    assert.equal(result.aggregate.status, 'FAIL');
    assert.deepEqual(result.terminal.cleanupReasons, cleanupCase.reasons);
    assert.deepEqual(fixture.removedRoots, terminalEpochRoots);
    assert.ok(
      fixture.events.indexOf('cleanup:roots-remove') < fixture.events.indexOf('baseline:post') &&
        fixture.events.indexOf('baseline:post') < fixture.events.indexOf('cleanup:build-smoke') &&
        fixture.events.indexOf('cleanup:build-smoke') < fixture.events.indexOf('output:write')
    );
  });
}

test('interrupts before initial start without entering baseline or gate', async () => {
  const fixture = createTerminalAttemptFixture({ interruptBeforeStart: true });
  const result = await runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls);

  assert.equal(fixture.events.includes('attempt:start-nanohost'), false);
  assert.equal(fixture.events.filter((event) => event.startsWith('baseline:')).length, 2);
  assert.deepEqual(
    fixture.events.filter((event) => event.startsWith('gate:')),
    []
  );
  assert.equal(result.aggregate.status, 'FAIL');
  assert.equal(result.terminal.primaryReason, 'interrupted');
  assert.equal(result.terminal.serviceStopped, true);
  assert.equal(result.terminal.decommissioned, true);
  assert.equal(result.terminal.credentialsRemoved, true);
  assertOneStoppedTerminalFinalizer(fixture);
  assert.equal(fixture.events.at(-1), 'output:write');
});

test('interrupts after the in-flight initial start settles without entering baseline or gate', async () => {
  const fixture = createTerminalAttemptFixture({ interruptDuringStart: true });
  const attempt = runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls);

  await fixture.startEntered;
  fixture.interruptStart();
  const result = await attempt;

  assert.deepEqual(fixture.events.slice(0, 4), [
    'output:check',
    'attempt:start-nanohost',
    'attempt:interrupt-pending',
    'attempt:start-settled',
  ]);
  assert.equal(fixture.events.filter((event) => event.startsWith('baseline:')).length, 2);
  assert.deepEqual(
    fixture.events.filter((event) => event.startsWith('gate:')),
    []
  );
  assert.equal(result.aggregate.status, 'FAIL');
  assert.equal(result.terminal.primaryReason, 'interrupted');
  assert.equal(result.terminal.serviceStopped, true);
  assert.equal(result.terminal.decommissioned, true);
  assert.equal(result.terminal.credentialsRemoved, true);
  assertOneStoppedTerminalFinalizer(fixture);
  assert.equal(fixture.events.at(-1), 'output:write');
});

test('finalizes after initial start rejection without entering baseline or gate', async () => {
  const fixture = createTerminalAttemptFixture({ startFailure: true });
  const result = await runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls);

  assert.equal(fixture.events.filter((event) => event === 'attempt:start-nanohost').length, 1);
  assert.equal(fixture.events.filter((event) => event.startsWith('baseline:')).length, 2);
  assert.deepEqual(
    fixture.events.filter((event) => event.startsWith('gate:')),
    []
  );
  assert.equal(result.aggregate.status, 'FAIL');
  assert.equal(result.terminal.primaryReason, 'pre_attempt_start_failed');
  assert.equal(result.terminal.serviceStopped, true);
  assert.equal(result.terminal.decommissioned, true);
  assert.equal(result.terminal.credentialsRemoved, true);
  assert.doesNotMatch(JSON.stringify(result), /raw initial start failure|secret host state/u);
  assertOneStoppedTerminalFinalizer(fixture);
  assert.equal(fixture.events.at(-1), 'output:write');
});

for (const intervention of [
  { field: 'gitCommit', value: 'e'.repeat(40) },
  { field: 'nanoHostIdentityHash', value: digest('other-nanohost-identity') },
  { field: 'nanoHostDeploymentHash', value: digest('other-nanohost-deployment') },
]) {
  test(`fails closed after cleanup when the gate PASS mutates ${intervention.field}`, async () => {
    const fixture = createTerminalAttemptFixture({
      gateIdentityMutation(identity) {
        identity[intervention.field] = intervention.value;
      },
    });
    const result = await runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls);

    assert.equal(result.aggregate.status, 'FAIL');
    assert.equal(result.terminal.serviceStopped, true);
    assertOneStoppedTerminalFinalizer(fixture);
  });
}

test('fails closed when the terminal epoch owner is missing', async () => {
  const fixture = createTerminalAttemptFixture({ terminalEpochOwner: 'missing' });
  const result = await runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls);

  assert.equal(result.aggregate.status, 'FAIL');
  assert.equal(result.terminal.epochResidueAbsent, false);
  assert.ok(result.terminal.cleanupReasons.includes('terminal_epoch_capture_failed'));
  assert.equal(result.terminal.serviceStopped, true);
  assertOneStoppedTerminalFinalizer(fixture, { terminalEpochCaptured: false });
});

test('preserves a redacted scenario failure separately from successful terminal cleanup', async () => {
  const fixture = createTerminalAttemptFixture({ gate: 'scenario-failure' });
  const options = terminalAttemptOptions();
  const result = await runTerminalUnitFAttempt(options, fixture.controls);

  assert.equal(result.aggregate.status, 'FAIL');
  assertTerminalPublicIdentity(result, options);
  assert.equal(result.terminal.primaryReason, 'gate_failed');
  assert.deepEqual(result.terminal.cleanupReasons, []);
  assert.equal(result.terminal.serviceStopped, true);
  assert.doesNotMatch(JSON.stringify(result), /raw scenario failure|secret host state/u);
  assertOneStoppedTerminalFinalizer(fixture);
});

test('cooperatively interrupts at a phase boundary before starting later phases', async () => {
  const fixture = createTerminalAttemptFixture({ interruptAfter: 'F2' });
  const result = await runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls);

  assert.equal(result.aggregate.status, 'FAIL');
  assert.equal(result.terminal.primaryReason, 'interrupted');
  assert.deepEqual(
    fixture.events.filter((event) => event.startsWith('gate:')),
    ['gate:start', 'gate:F1', 'gate:F2']
  );
  assert.equal(result.terminal.serviceStopped, true);
  assertOneStoppedTerminalFinalizer(fixture);
});

test('observes interruption after the final phase operation settles', async () => {
  const fixture = createTerminalAttemptFixture({ interruptAfter: 'normal-lifecycle' });
  const result = await runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls);

  assert.equal(result.aggregate.status, 'FAIL');
  assert.equal(result.terminal.primaryReason, 'interrupted');
  assert.deepEqual(
    fixture.events.filter((event) => event.startsWith('gate:')),
    ['gate:start', 'gate:F1', 'gate:F2', 'gate:F4', 'gate:normal-lifecycle']
  );
  assert.equal(result.terminal.serviceStopped, true);
  assertOneStoppedTerminalFinalizer(fixture);
});

test('marks owner timeout but waits for the live gate to settle before finalizing', async () => {
  const fixture = createTerminalAttemptFixture({ gate: 'timeout' });
  const options = terminalAttemptOptions();
  const attempt = runTerminalUnitFAttempt(options, fixture.controls);

  await fixture.timerExpired;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const cleanupBeforeGateSettlement = fixture.events.filter((event) =>
    terminalCleanupEvents.includes(event)
  );
  fixture.rejectGate(new Error('raw late gate failure with secret host state'));
  const result = await attempt;

  assert.deepEqual(cleanupBeforeGateSettlement, []);
  assert.equal(result.aggregate.status, 'FAIL');
  assertTerminalPublicIdentity(result, options);
  assert.equal(result.terminal.primaryReason, 'owner_timeout');
  assert.equal(result.terminal.serviceStopped, true);
  assert.doesNotMatch(JSON.stringify(result), /raw late gate failure|secret host state/u);
  assertOneStoppedTerminalFinalizer(fixture);
});

test('continues independent terminal cleanup after stop failure and forces aggregate FAIL', async () => {
  const fixture = createTerminalAttemptFixture({ cleanupFailure: 'stopNanoHost' });
  const result = await runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls);

  assert.equal(result.aggregate.status, 'FAIL');
  assert.equal(result.terminal.primaryReason, null);
  assert.deepEqual(result.terminal.cleanupReasons, ['service_stop_failed']);
  assert.equal(result.terminal.serviceStopped, true);
  assert.doesNotMatch(JSON.stringify(result), /raw stop failure|secret host state/u);
  assertOneStoppedTerminalFinalizer(fixture);
});

test('derives credential removal only from the exact decommission identity response', async () => {
  const fixture = createTerminalAttemptFixture({ decommissionIdentityId: 'identity-other' });
  const result = await runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls);

  assert.equal(result.aggregate.status, 'FAIL');
  assert.equal(result.terminal.decommissioned, false);
  assert.equal(result.terminal.credentialsRemoved, false);
  assert.deepEqual(result.terminal.cleanupReasons, ['decommission_identity_mismatch']);
  assert.equal(result.terminal.serviceStopped, true);
  assertOneStoppedTerminalFinalizer(fixture);
});

for (const remainingResidue of ['cgroupAbsent', 'netnsAbsent', 'socketsAbsent']) {
  test(`fails terminal cleanup when final epoch ${remainingResidue} is false`, async () => {
    const residue = {
      cgroupAbsent: true,
      netnsAbsent: true,
      socketsAbsent: true,
    };
    residue[remainingResidue] = false;
    const fixture = createTerminalAttemptFixture({ residue });
    const result = await runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls);

    assert.equal(result.aggregate.status, 'FAIL');
    assert.equal(result.terminal.epochResidueAbsent, false);
    assert.deepEqual(result.terminal.cleanupReasons, ['epoch_residue_present']);
    assert.equal(result.terminal.serviceStopped, true);
    assertOneStoppedTerminalFinalizer(fixture);
  });
}

test('compares only terminal-reference and post-cleanup baselines', async () => {
  const fixture = createTerminalAttemptFixture({
    baselineDigests: [
      digest('pre-attempt'),
      digest('terminal-reference'),
      digest('post-cleanup-drift'),
    ],
  });
  const result = await runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls);

  assert.equal(result.aggregate.status, 'FAIL');
  assert.equal(result.terminal.baselinePreserved, false);
  assert.deepEqual(result.terminal.cleanupReasons, ['terminal_baseline_changed']);
  assert.equal(result.terminal.serviceStopped, true);
  assertOneStoppedTerminalFinalizer(fixture);
});

test('attempts output only after cleanup and stays stopped when create-only write fails', async () => {
  const fixture = createTerminalAttemptFixture({ outputWriteFailure: true });

  await assert.rejects(
    runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls),
    (error) => {
      assert.match(error.message, /retained output write failed/u);
      assert.doesNotMatch(error.message, /raw output failure|secret path/u);
      return true;
    }
  );
  assertOneStoppedTerminalFinalizer(fixture);
  assert.equal(fixture.events.at(-1), 'output:write');
  assert.ok(fixture.events.indexOf('cleanup:inactive') < fixture.events.indexOf('output:write'));
});

test('rejects a pre-existing retained output before any attempt effect', async () => {
  const fixture = createTerminalAttemptFixture({ outputState: 'exists' });

  await assert.rejects(
    runTerminalUnitFAttempt(terminalAttemptOptions(), fixture.controls),
    /retained output already exists/u
  );
  assert.deepEqual(fixture.events, ['output:check']);
});

test('rejects an invalid retained output path before any attempt effect', async () => {
  const fixture = createTerminalAttemptFixture();

  await assert.rejects(
    runTerminalUnitFAttempt(
      terminalAttemptOptions({ outputPath: 'relative-result.json' }),
      fixture.controls
    ),
    /absolute retained output path/u
  );
  assert.deepEqual(fixture.events, []);
});

for (const invalidInput of [
  { name: 'non-a1 SSH alias', overrides: { sshAlias: 'a2' } },
  { name: 'near-value owner timeout', overrides: { ownerTimeoutMs: 7_199_999 } },
]) {
  test(`rejects ${invalidInput.name} before any attempt effect`, async () => {
    const fixture = createTerminalAttemptFixture();

    await assert.rejects(
      runTerminalUnitFAttempt(terminalAttemptOptions(invalidInput.overrides), fixture.controls)
    );
    assert.deepEqual(fixture.events, ['output:check']);
  });
}

for (const unsafeShape of [
  { name: 'symlinked fixed parent', parentKind: 'symlink' },
  { name: 'symlink epoch root', rootKind: 'symlink' },
  { name: 'non-directory epoch root', rootKind: 'file' },
  { extraName: 'epoch-additional-unit-f', name: 'additional epoch root' },
  { name: 'changed epoch pair', runtimeName: 'epoch-changed-unit-f' },
  { name: 'safe matching pair', safe: true },
]) {
  test(
    unsafeShape.safe
      ? 'terminal epoch root remote commands remove and reobserve one safe matching pair'
      : `terminal epoch root remote commands reject ${unsafeShape.name} without deletion`,
    async () => {
      const parents = ['/var/lib/openkit/nanohost', '/run/openkit/nanohost'];
      const entries = new Map([
        [parents[0], [{ kind: unsafeShape.rootKind ?? 'directory', name: terminalEpochRoot }]],
        [parents[1], [{ kind: 'directory', name: unsafeShape.runtimeName ?? terminalEpochRoot }]],
      ]);
      if (unsafeShape.extraName) {
        entries.get(parents[1]).push({ kind: 'directory', name: unsafeShape.extraName });
      }
      const removed = [];
      const shape = (kind) => ({
        isDirectory: () => kind === 'directory',
        isSymbolicLink: () => kind === 'symlink',
      });
      const execute = async (_command, args) => {
        const parsed = await runCommand('/usr/bin/bash', [
          '-c',
          'eval "set -- $1"; printf "%s\\0" "$@"',
          'parse-unit-f-command',
          args[1],
        ]);
        const remoteArgs = parsed.stdout.split('\0');
        remoteArgs.pop();
        const script = remoteArgs.at(-2);
        const payload = remoteArgs.at(-1);
        let stdout = '';
        try {
          runInNewContext(script, {
            Buffer,
            process: {
              argv: [process.execPath, payload],
              exit(status) {
                throw new Error(`remote Node command exited ${status}`);
              },
              stdout: { write: (value) => (stdout += value) },
            },
            require(specifier) {
              if (specifier !== 'node:fs') throw new Error(`unexpected module ${specifier}`);
              return {
                lstatSync(path) {
                  const parentIndex = parents.indexOf(path);
                  if (parentIndex !== -1) {
                    return shape(
                      parentIndex === 0 ? (unsafeShape.parentKind ?? 'directory') : 'directory'
                    );
                  }
                  const parent = parents.find((candidate) => path.startsWith(`${candidate}/`));
                  const entry = entries
                    .get(parent)
                    ?.find((candidate) => `${parent}/${candidate.name}` === path);
                  if (!entry) throw new Error(`missing path ${path}`);
                  return shape(entry.kind);
                },
                readdirSync(parent) {
                  return entries.get(parent).map((entry) => ({
                    isDirectory: () => entry.kind === 'directory',
                    isSymbolicLink: () => entry.kind === 'symlink',
                    name: entry.name,
                  }));
                },
                rmSync(path) {
                  removed.push(path);
                  const parent = parents.find((candidate) => path.startsWith(`${candidate}/`));
                  entries.set(
                    parent,
                    entries.get(parent).filter((entry) => `${parent}/${entry.name}` !== path)
                  );
                },
              };
            },
          });
        } catch (error) {
          throw new Error('remote Node command rejected unsafe roots', { cause: error });
        }
        return { stderr: '', stdout };
      };
      const driver = createDefaultDriver(defaultDriverOptions({ runCommand: execute }));
      if (unsafeShape.safe) {
        assert.deepEqual(
          await driver.observeTerminalEpochRoots(terminalEpochRoots),
          terminalEpochRoots
        );
        await driver.removeTerminalEpochRoots(terminalEpochRoots);
        assert.deepEqual(removed, terminalEpochRoots);
        assert.deepEqual(
          parents.map((parent) => entries.get(parent)),
          [[], []]
        );
        assert.deepEqual(await driver.observeTerminalEpochRoots(terminalEpochRoots), []);
        return;
      }
      const observationRejected = await driver.observeTerminalEpochRoots(terminalEpochRoots).then(
        () => false,
        () => true
      );
      const removalRejected = await driver.removeTerminalEpochRoots(terminalEpochRoots).then(
        () => false,
        () => true
      );

      assert.equal(observationRejected, true);
      assert.equal(removalRejected, true);
      assert.deepEqual(removed, []);
    }
  );
}

test('default driver initial start waits for every exact RuntimeTarget readiness predicate', async () => {
  const calls = [];
  const exactTarget = {
    connectionGeneration: 7,
    deploymentId: 'deployment-unit-f',
    freshEmpty: true,
    identityId: 'identity-unit-f',
    predecessorFenced: true,
    ready: true,
  };
  const targetObservations = [
    { ...exactTarget, predecessorFenced: false },
    { ...exactTarget, ready: false },
    { ...exactTarget, freshEmpty: false },
    exactTarget,
  ];
  let tunnelOpen = false;
  const driver = createDefaultDriver(
    defaultDriverOptions({
      requestJson: async (_config, method, path, _body, authority) => {
        assert.equal(tunnelOpen, true);
        assert.deepEqual(
          { authority, method, path },
          {
            authority: 'admin',
            method: 'GET',
            path: '/api/app/nanohost/runtime-target',
          }
        );
        const observation = targetObservations.shift();
        calls.push('target:observed');
        return observation;
      },
      runCommand: async () => {
        assert.equal(tunnelOpen, false);
        calls.push('systemctl:start');
        return { stderr: '', stdout: '' };
      },
      tunnel: {
        start: async () => {
          assert.equal(tunnelOpen, false);
          tunnelOpen = true;
          calls.push('tunnel:start');
        },
        stop: async () => {
          assert.equal(tunnelOpen, true);
          tunnelOpen = false;
          calls.push('tunnel:stop');
        },
      },
      waitForObservation: async (observe) => {
        calls.push('wait:start');
        assert.equal(await observe(), null);
        assert.equal(await observe(), null);
        assert.equal(await observe(), null);
        assert.ok(await observe());
        calls.push('wait:ready');
      },
    })
  );

  await driver.startNanoHost();

  assert.equal(tunnelOpen, false);
  assert.deepEqual(targetObservations, []);
  assert.deepEqual(calls, [
    'systemctl:start',
    'tunnel:start',
    'wait:start',
    'target:observed',
    'target:observed',
    'target:observed',
    'target:observed',
    'wait:ready',
    'tunnel:stop',
  ]);
});

test('default driver initial start closes its readiness tunnel when the wait owner rejects', async () => {
  const calls = [];
  const driver = createDefaultDriver(
    defaultDriverOptions({
      runCommand: async () => {
        calls.push('systemctl:start');
        return { stderr: '', stdout: '' };
      },
      tunnel: {
        start: async () => calls.push('tunnel:start'),
        stop: async () => calls.push('tunnel:stop'),
      },
      waitForObservation: async () => {
        calls.push('wait:start');
        throw new Error('RuntimeTarget readiness wait rejected');
      },
    })
  );

  await assert.rejects(driver.startNanoHost(), /RuntimeTarget readiness wait rejected/u);
  assert.deepEqual(calls, ['systemctl:start', 'tunnel:start', 'wait:start', 'tunnel:stop']);
});

test('default driver stop normalizes a failed systemd unit to inactive', async () => {
  const calls = [];
  const driver = createDefaultDriver(
    defaultDriverOptions({
      runCommand: async (command, args) => {
        calls.push({ args, command });
        return { stderr: '', stdout: '' };
      },
    })
  );

  await driver.stopNanoHost();

  assert.deepEqual(calls, [
    {
      args: ['a1', "'/usr/bin/sudo' '-n' '/usr/bin/systemctl' 'stop' 'openkit-nanohost.service'"],
      command: '/usr/bin/ssh',
    },
    {
      args: [
        'a1',
        "'/usr/bin/sudo' '-n' '/usr/bin/systemctl' 'reset-failed' 'openkit-nanohost.service'",
      ],
      command: '/usr/bin/ssh',
    },
  ]);
});

test('default driver accepts a reset-failed race only after proving the service inactive', async () => {
  const calls = [];
  const driver = createDefaultDriver(
    defaultDriverOptions({
      runCommand: async (command, args) => {
        calls.push({ args, command });
        if (args[1]?.includes("'reset-failed'")) {
          throw new Error('Unit openkit-nanohost.service not loaded.');
        }
        if (args[1]?.includes("'--property=ActiveState'")) {
          return { stderr: '', stdout: 'inactive\n' };
        }
        return { stderr: '', stdout: '' };
      },
    })
  );

  await driver.stopNanoHost();

  assert.equal(calls.length, 3);
  assert.match(calls[2].args[1], /'show'.*'--property=ActiveState'.*'--value'/u);
});

test('default driver preserves a reset-failed error while the service remains active', async () => {
  const resetError = new Error('reset-failed rejected');
  const driver = createDefaultDriver(
    defaultDriverOptions({
      runCommand: async (_command, args) => {
        if (args[1]?.includes("'reset-failed'")) throw resetError;
        if (args[1]?.includes("'--property=ActiveState'")) {
          return { stderr: '', stdout: 'active\n' };
        }
        return { stderr: '', stdout: '' };
      },
    })
  );

  await assert.rejects(driver.stopNanoHost(), (error) => error === resetError);
});

test('default driver admits only exact F1, F2, and F4 identities into their real executor boundary', async () => {
  const calls = [];
  const driver = createDefaultDriver(
    defaultDriverOptions({
      runCommand: async (command, args) => {
        calls.push({ args, command });
        throw new Error('unexpected command owner boundary');
      },
      requestJson: async (_config, method, path) => {
        calls.push({ method, path });
        throw new Error('default driver owner boundary reached');
      },
      tunnel: {
        start: async () => calls.push({ tunnel: 'start' }),
        stop: async () => calls.push({ tunnel: 'stop' }),
      },
      waitForObservation: async (observe) => observe(),
    })
  );

  await assert.rejects(
    driver.executeScenarioEffect({ scenarioId: 'unknown' }),
    /scenario identity is invalid/u
  );
  assert.deepEqual(calls, []);
  for (const scenarioId of scenarioIds) {
    await assert.rejects(
      driver.executeScenarioEffect({ scenarioId }),
      /default driver owner boundary reached/u
    );
    const entered = calls.splice(0);
    assert.deepEqual(entered[0], { tunnel: 'start' });
    assert.deepEqual(entered[1], {
      method: 'GET',
      path: '/api/app/nanohost/runtime-target',
    });
    assert.deepEqual(entered[2], { tunnel: 'stop' });
    assert.equal(entered.length, 3);
  }
});

test('default driver keeps its tunnel until the scenario effect settles', async () => {
  const calls = [];
  let rejectRequest;
  const driver = createDefaultDriver(
    defaultDriverOptions({
      requestJson: () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
      tunnel: {
        start: async () => calls.push('start'),
        stop: async () => calls.push('stop'),
      },
      waitForObservation: async (observe) => observe(),
    })
  );

  const scenario = driver.executeScenarioEffect({ scenarioId: 'F1' });
  await waitForObservation(() => (rejectRequest ? true : null), 1_000);
  assert.deepEqual(calls, ['start']);
  rejectRequest(new Error('scenario boundary reached'));
  await assert.rejects(scenario, /scenario boundary reached/u);
  assert.deepEqual(calls, ['start', 'stop']);
});

test('failure evidence reads one fresh Workspace and filters the exact Turn when available', async () => {
  const calls = [];
  const exact = { id: 'runtime-evidence-exact', turnId: 'turn-exact' };
  const config = {
    request: async (_config, method, path, body, authority) => {
      calls.push({ authority, body, method, path });
      return {
        runtimeEvidence: [{ id: 'runtime-evidence-other', turnId: 'turn-other' }, exact],
      };
    },
  };
  const runtimeEvidence = await readTurnRuntimeEvidence(config, {
    turnId: 'turn-exact',
    workspaceId: 'workspace-exact',
  });
  const workspaceEvidence = await readWorkspaceRuntimeEvidence(config, 'workspace-exact');

  assert.deepEqual(calls, [
    {
      authority: 'product',
      body: undefined,
      method: 'GET',
      path: '/api/app/workspaces/workspace-exact/runtime-evidence',
    },
    {
      authority: 'product',
      body: undefined,
      method: 'GET',
      path: '/api/app/workspaces/workspace-exact/runtime-evidence',
    },
  ]);
  assert.deepEqual(runtimeEvidence, [exact]);
  assert.deepEqual(workspaceEvidence, [
    { id: 'runtime-evidence-other', turnId: 'turn-other' },
    exact,
  ]);
});

test('top-level Unit F uses the same default-driver baseline boundary before scenario coordination', async () => {
  const directCalls = [];
  const topLevelCalls = [];
  const manifestDigest = digest(readFileSync(join('tests', 'support', 'host', 'manifest.json')));
  const stopAfterManifest = (calls, message) => async (command, args) => {
    calls.push({ args, command });
    if (calls.length === 1) {
      return { signal: null, status: 0, stderr: '', stdout: `manifestDigest=${manifestDigest}\n` };
    }
    throw new Error(message);
  };
  const direct = createDefaultDriver(
    defaultDriverOptions({
      runCommand: stopAfterManifest(directCalls, 'direct baseline owner boundary reached'),
      tunnel: { start: async () => {}, stop: async () => {} },
    })
  );
  await assert.rejects(direct.captureBaseline(), /direct baseline owner boundary reached/u);
  await assert.rejects(
    runNanoHostUnitF(
      defaultDriverOptions({
        runCommand: stopAfterManifest(topLevelCalls, 'top-level baseline owner boundary reached'),
        tunnel: {
          start: async () => {},
          stop: async () => {},
        },
      })
    ),
    /top-level baseline owner boundary reached/u
  );

  assert.deepEqual(topLevelCalls, directCalls);
  assert.equal(topLevelCalls[0]?.command, '/usr/bin/env');
  assert.equal(topLevelCalls[0]?.args[0], 'bash');
  assert.equal(topLevelCalls[0]?.args[2], 'a1');
  assert.deepEqual(topLevelCalls[1], {
    args: [
      'a1',
      "'/usr/bin/sudo' '-n' '/usr/bin/docker' 'inspect' '--format' '{\"imageId\":\"{{.Image}}\",\"imageRef\":\"{{.Config.Image}}\"}' 'openkit-nanocore-unit-f'",
    ],
    command: '/usr/bin/ssh',
  });
  assert.equal(topLevelCalls.length, 2);
});

test('rejects the retired high-level driver callback entry', async () => {
  await assert.rejects(
    runNanoHostUnitF({
      ...publicIdentity,
      attemptId: privateAttemptId,
      captureBaseline: async () => ({ digest: digest('decoy') }),
    }),
    /does not accept high-level driver callbacks/u
  );
});
