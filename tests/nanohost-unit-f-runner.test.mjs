// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  adjudicateNanoHostF1Continuation,
  adjudicateNanoHostUnitFResult,
  adjudicateNanoHostUnitFScenario,
  completeNanoHostFirstFenceRecovery,
  createDefaultDriver,
  createNanoCoreTunnel,
  epochEffectsAreAbsent,
  executeNanoHostUnitFCoordinator,
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

const scenarioIds = ['F1', 'F2', 'F3', 'F4'];
const contracts = {
  F1: {
    action: 'successor-transport-fenced-and-reconnected',
    barrier: 'post-launch-worker-sequence-durable',
    cleanup: 'same-lineage-finalized-without-replay',
    fault: 'nanocore-only-restarted',
  },
  F2: {
    action: 'supervised-effect-domain-terminated',
    barrier: 'sandbox-create-accepted-and-blocked',
    cleanup: 'no-late-residue-and-fresh-empty-ready',
    fault: 'nanohost-sigkill-delivered',
  },
  F3: {
    action: 'sessions-interrupted-or-unknown-and-epoch-nonready',
    barrier: 'nanohost-operation-live-or-in-flight',
    cleanup: 'fresh-members-empty-and-images-reverified',
    fault: 'execution-server-restarted',
  },
  F4: {
    action: 'epoch-invalidated-siblings-terminated-without-member-restart',
    barrier: 'sandbox-operation-accepted',
    cleanup: 'sessions-interrupted-routes-capacity-fenced-and-fresh-epoch-ready',
    fault: 'effect-capable-member-killed',
  },
};
const normalLifecycleContract = {
  finalFreshStart: 'final-fresh-start-all-three-ready',
  ordinaryStart: 'ordinary-start-all-three-ready',
  ordinaryStop: 'ordinary-stop-cgroup-and-private-network-namespace-absent',
  stoppedBaseline: 'service-stopped-baseline',
  systemDocker: 'system-docker-baseline-exact-equal',
};
const baselineComponentNames = ['bridge', 'containers', 'docker0', 'nft'];

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

function hostBaseline(label) {
  return {
    components: Object.fromEntries(
      baselineComponentNames.map((name) => [name, digest(`${label}:${name}`)])
    ),
    digest: digest(label),
  };
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
  const epochs = [evidence.epochBefore, evidence.epochBefore, evidence.epochAfter];
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

test('F1 captures restart continuity after replacing the prior Task sandbox', async () => {
  const fixture = sequencedF1Fixture();
  const initial = structuredClone(fixture.evidence.epochBefore);
  const priorShim = {
    exe: '/usr/bin/containerd-shim-runc-v2',
    netns: 'net:[unit-f]',
    pid: 201,
    starttime: '2001',
  };
  const currentShim = { ...priorShim, pid: 202, starttime: '2002' };
  initial.members.push(priorShim);
  fixture.epochs[0] = initial;
  fixture.evidence.epochBefore.members.push(currentShim);
  fixture.evidence.epochAfter.members.push(structuredClone(currentShim));
  const readEpoch = fixture.ports.readEpoch;
  fixture.ports.readEpoch = async () => {
    fixture.actions.push(`readEpoch:${fixture.reads.epoch}`);
    return readEpoch();
  };
  const readOwnerSnapshot = fixture.ports.readOwnerSnapshot;
  fixture.ports.readOwnerSnapshot = async () => {
    fixture.actions.push('readOwnerSnapshot');
    return readOwnerSnapshot();
  };

  await sequenceNanoHostF1(fixture.ports);

  const order = ['startTask', 'readOwnerSnapshot', 'readEpoch:1', 'killNanoCore'];
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(fixture.actions.indexOf(order[index - 1]) < fixture.actions.indexOf(order[index]));
  }
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
  const observedEpochs = [];
  fixture.ports.readEpochEffects = async (epoch) => {
    observedEpochs.push(epoch);
    return { absent: true };
  };
  fixture.ports.resolveLineage = async () => {
    fixture.actions.push('resolveLineage');
    return null;
  };

  await assert.rejects(sequenceNanoHostF1(fixture.ports));
  assert.equal(fixture.actions.includes('killNanoCore'), false);
  assert.ok(fixture.actions.indexOf('stopNanoHost') < fixture.actions.indexOf('startNanoHost'));
  assert.equal(fixture.actions.includes('interruptTurn'), false);
  assert.deepEqual(observedEpochs, [fixture.epochs[0]]);
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
  const initialEpoch = {
    activeState: 'active',
    bootId: observation.current.bootId,
    invocationId: observation.current.invocationId,
    members: observation.current.members,
    unitFileState: 'static',
  };
  const preparedEpoch = {
    ...initialEpoch,
    invocationId: 'invocation-unit-f-prepared',
    members: initialEpoch.members.map((member) => ({
      ...member,
      args: [...member.args],
      pid: member.pid + 50,
      starttime: String(Number(member.starttime) + 500),
    })),
  };
  const firstEpoch = {
    activeState: 'active',
    bootId: scenarioId === 'F3' ? 'boot-unit-f-rebooted' : initialEpoch.bootId,
    invocationId: 'invocation-unit-f-first-recovery',
    members: preparedEpoch.members.map((member) => ({
      ...member,
      args: [...member.args],
      pid: member.pid + 100,
      starttime: String(Number(member.starttime) + 1_000),
    })),
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
      connectionGeneration: 8,
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
    coreStarted: false,
    faultDelivered: false,
    firstEpochReads: 0,
    hostStarts: 0,
    interrupted: false,
    rebooted: false,
    stopped: false,
    successorFailed: false,
    successorEpochReads: 0,
  };
  const actions = [];
  const barrierJournalPids = [];
  const journalEntries = structuredClone(observation.entries).map((entry) => ({
    ...entry,
    _SYSTEMD_INVOCATION_ID: preparedEpoch.invocationId,
  }));
  const ports = {
    instrumentDigest,
    nanoCoreContainer: 'openkit-nanocore-unit-f',
    nanoCoreImageId: `sha256:${'e'.repeat(64)}`,
    nanoCoreImageRef: 'openkit/app:unit-f',
    async interruptTurn() {
      actions.push('interruptTurn');
      state.interrupted = true;
    },
    async killNanoCore() {
      actions.push('killNanoCore');
      state.coreStarted = false;
    },
    async pause() {},
    async readEpoch() {
      if (state.stopped) {
        return {
          activeState: 'inactive',
          bootId: state.rebooted ? 'boot-unit-f-rebooted' : initialEpoch.bootId,
          invocationId: null,
          members: [],
        };
      }
      if (!state.faultDelivered && !state.stopped) {
        return structuredClone(state.hostStarts === 0 ? initialEpoch : preparedEpoch);
      }
      const recoveryStarts = Math.max(0, state.hostStarts - 1);
      if (recoveryStarts === 0) {
        return {
          activeState: 'inactive',
          bootId: state.rebooted ? 'boot-unit-f-rebooted' : initialEpoch.bootId,
          invocationId: null,
          members: [],
        };
      }
      if (recoveryStarts === 1) {
        if (scenarioId === 'F3') return structuredClone(firstEpoch);
        state.firstEpochReads += 1;
        return state.firstEpochReads === 1
          ? structuredClone(firstEpoch)
          : { ...structuredClone(firstEpoch), activeState: 'inactive', members: [] };
      }
      if (recoveryStarts === 2 && !state.successorFailed) {
        state.successorEpochReads += 1;
        if (state.successorEpochReads === 1) {
          return { ...structuredClone(successorEpoch), members: [successorEpoch.members[0]] };
        }
      }
      if (recoveryStarts === 2 && state.successorFailed) {
        return { ...structuredClone(successorEpoch), activeState: 'inactive', members: [] };
      }
      return structuredClone(recoveryStarts > 2 ? finalEpoch : successorEpoch);
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
    async readNanoCoreContainer() {
      return {
        restart: 'no',
        running: state.rebooted ? state.coreStarted : true,
      };
    },
    async readOwnerSnapshot() {
      actions.push('readOwnerSnapshot');
      if (state.interrupted) return structuredClone(cleanedOwner);
      const recoveryStarts = Math.max(0, state.hostStarts - 1);
      if (scenarioId === 'F3' && recoveryStarts === 1) {
        return structuredClone(fencedOwner);
      }
      if (recoveryStarts === 2) {
        state.successorFailed = true;
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
          connectionGeneration: state.hostStarts === 0 ? (state.coreStarted ? 7 : 6) : 8,
          freshEmpty: true,
          predecessorFenced: true,
          ready: true,
        };
      }
      const recoveryStarts = Math.max(0, state.hostStarts - 1);
      if (recoveryStarts < 2) {
        const firstRecoveryReadiness =
          recoveryStarts === 1 && (scenarioId === 'F3' || state.firstEpochReads === 1);
        return {
          ...runtimeTarget,
          connectionGeneration: 9,
          freshEmpty: firstRecoveryReadiness,
          predecessorFenced: true,
          ready: firstRecoveryReadiness,
        };
      }
      if (recoveryStarts === 2) {
        state.successorFailed = true;
        return {
          ...runtimeTarget,
          connectionGeneration: 10,
          freshEmpty: false,
          predecessorFenced: true,
          ready: false,
        };
      }
      return {
        ...runtimeTarget,
        connectionGeneration: recoveryStarts > 2 ? 11 : 10,
        freshEmpty: true,
        predecessorFenced: true,
        ready: true,
      };
    },
    async readTurn() {
      return { id: lineage.turnId, status: 'failed' };
    },
    async rebootHost() {
      actions.push('rebootHost');
      state.faultDelivered = true;
      state.rebooted = true;
      state.coreStarted = false;
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
      if (signal === 'SIGKILL') state.faultDelivered = true;
      return { signalled: true };
    },
    async startNanoCore() {
      actions.push('startNanoCore');
      state.coreStarted = true;
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
    async waitSsh() {
      actions.push('waitSsh');
    },
    async waitTunnelDisconnect() {
      actions.push('waitTunnelDisconnect');
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
    preparedEpoch,
    ports,
    runtimeTarget,
    state,
  };
}

for (const scenarioId of ['F2', 'F3', 'F4']) {
  test(`sequences one complete ${scenarioId} blocked-create fault before recovery`, async () => {
    const fixture = sequencedBlockedFixture(scenarioId);
    const result = await sequenceNanoHostBlockedCreate(scenarioId, fixture.ports);
    const faultAction =
      scenarioId === 'F3'
        ? 'rebootHost'
        : fixture.actions.find((action) => action.startsWith('signal:'));

    assert.deepEqual(result.lineage, {
      agentSessionId: fixture.lineage.agentSessionId,
      backendSessionId: fixture.backendSessionId,
      leaseId: 'lease-blocked',
      turnId: fixture.lineage.turnId,
    });
    assert.equal(result.proof.instrument, instrumentDigest);
    assert.equal(result.proof.priorGeneration, 8);
    assert.equal(result.proof.fenceGeneration, scenarioId === 'F3' ? null : 9);
    assert.equal(result.proof.successorGeneration, scenarioId === 'F3' ? 9 : 11);
    assert.equal(
      result.proof.effectRequest,
      digest(`${fixture.lineage.requestId}\0sandbox.create`)
    );
    assert.equal(result.proof.sandbox, digest(fixture.backendSessionId));
    assert.ok(fixture.actions.indexOf('startTask') < fixture.actions.indexOf('resolveLineage'));
    assert.ok(fixture.actions.indexOf('resolveLineage') < fixture.actions.indexOf(faultAction));
    assert.ok(fixture.actions.indexOf('stopNanoHost') < fixture.actions.indexOf('startNanoHost'));
    assert.ok(fixture.actions.indexOf('startNanoHost') < fixture.actions.indexOf('startTask'));
    assert.ok(fixture.actions.indexOf(faultAction) < fixture.actions.lastIndexOf('startNanoHost'));
    assert.equal(
      fixture.actions.filter((action) => action === 'startNanoHost').length,
      scenarioId === 'F3' ? 2 : 4
    );
    assert.equal(fixture.actions.filter((action) => action === 'runDockerSmoke').length, 1);
    assert.ok(
      fixture.actions.lastIndexOf('startNanoHost') < fixture.actions.indexOf('interruptTurn')
    );
    if (scenarioId === 'F3') {
      const recoveryOwnerRead = fixture.actions.indexOf(
        'readOwnerSnapshot',
        fixture.actions.lastIndexOf('startNanoHost') + 1
      );
      assert.ok(fixture.actions.lastIndexOf('startNanoHost') < recoveryOwnerRead);
      assert.ok(recoveryOwnerRead < fixture.actions.indexOf('interruptTurn'));
    }
    assert.deepEqual(fixture.barrierJournalPids, [undefined, undefined]);
  });
}

test('F2 proves a fresh epoch before stopping dockerd when readiness may retain an idle Sandbox', async () => {
  const fixture = sequencedBlockedFixture('F2');
  const dockerd = fixture.initialEpoch.members.find((member) => member.exe.endsWith('/dockerd'));
  dockerd.state = 'S';
  let dockerdStopped = false;
  const readEpoch = fixture.ports.readEpoch;
  fixture.ports.readEpoch = async () => {
    const epoch = await readEpoch();
    const member = epoch.members.find((candidate) => candidate.exe.endsWith('/dockerd'));
    if (member && !fixture.state.faultDelivered) member.state = dockerdStopped ? 'T' : 'S';
    return epoch;
  };
  fixture.ports.signalMember = async (member, signal) => {
    fixture.actions.push(`signal:${member.pid}:${signal}`);
    if (signal === 'SIGSTOP') dockerdStopped = true;
    else fixture.state.faultDelivered = true;
    return { signalled: true };
  };

  const startTask = fixture.ports.startTask;
  fixture.ports.startTask = async () => {
    assert.ok(
      fixture.actions.includes('killNanoCore'),
      'blocked-create admission must not retain the previous Harness process-local continuity'
    );
    return startTask();
  };

  await sequenceNanoHostBlockedCreate('F2', fixture.ports);

  const ordinaryStop = fixture.actions.indexOf('stopNanoHost');
  const freshStart = fixture.actions.indexOf('startNanoHost');
  const dockerdStop = fixture.actions.findIndex((action) => action.endsWith(':SIGSTOP'));
  const taskStart = fixture.actions.indexOf('startTask');
  assert.ok(fixture.actions.indexOf('killNanoCore') < fixture.actions.indexOf('startNanoCore'));
  assert.ok(fixture.actions.indexOf('startNanoCore') < ordinaryStop);
  assert.ok(ordinaryStop < freshStart);
  assert.ok(freshStart < dockerdStop);
  assert.ok(dockerdStop < taskStart);
});

test('F3 accepts a healthy proof successor only after its cleanup owner is terminal', async () => {
  const fixture = sequencedBlockedFixture('F3');
  const readEpoch = fixture.ports.readEpoch;
  const readOwnerSnapshot = fixture.ports.readOwnerSnapshot;
  const readRuntimeTarget = fixture.ports.readRuntimeTarget;
  let recoveryEpochReads = 0;
  fixture.ports.readEpoch = async () => {
    const epoch = await readEpoch();
    if (fixture.state.hostStarts !== 2) return epoch;
    recoveryEpochReads += 1;
    return recoveryEpochReads === 1
      ? epoch
      : { ...structuredClone(epoch), activeState: 'inactive', members: [] };
  };
  fixture.ports.readOwnerSnapshot = async () => {
    if (fixture.state.hostStarts === 2) return structuredClone(fixture.ownerBefore);
    if (fixture.state.hostStarts === 3) return structuredClone(fixture.fencedOwner);
    return readOwnerSnapshot();
  };
  fixture.ports.readRuntimeTarget = async () => {
    if (fixture.state.hostStarts === 3) {
      return {
        ...structuredClone(fixture.runtimeTarget),
        connectionGeneration: 10,
        freshEmpty: true,
        predecessorFenced: true,
        ready: true,
      };
    }
    const target = await readRuntimeTarget();
    return fixture.state.hostStarts === 2 && recoveryEpochReads > 1
      ? { ...target, freshEmpty: false, ready: false }
      : target;
  };

  const result = await sequenceNanoHostBlockedCreate('F3', fixture.ports);

  assert.equal(result.proof.fenceGeneration, 9);
  assert.equal(result.proof.successorGeneration, 10);
  assert.equal(fixture.actions.filter((action) => action === 'startNanoHost').length, 3);
});

test('F3 tolerates one transient cgroup read after starting recovery', async () => {
  const fixture = sequencedBlockedFixture('F3');
  const readEpoch = fixture.ports.readEpoch;
  let injected = false;
  fixture.ports.readEpoch = async () => {
    if (!injected && fixture.state.hostStarts === 2) {
      injected = true;
      throw new Error('transient cgroup member disappeared');
    }
    return await readEpoch();
  };

  const result = await sequenceNanoHostBlockedCreate('F3', fixture.ports);

  assert.equal(result.proof.successorGeneration, 9);
  assert.equal(injected, true);
});

test('F3 stabilizes system Docker after reboot recovery before returning', async () => {
  const fixture = sequencedBlockedFixture('F3');

  await sequenceNanoHostBlockedCreate('F3', fixture.ports);

  const smoke = fixture.actions.indexOf('runDockerSmoke');
  const cleanup = fixture.actions.lastIndexOf('readOwnerSnapshot');
  assert.equal(fixture.actions.filter((action) => action === 'runDockerSmoke').length, 1);
  assert.ok(fixture.actions.indexOf('interruptTurn') < cleanup);
  assert.ok(cleanup < smoke);
});

test('F3 recovery failure does not reach the system Docker smoke', async () => {
  const fixture = sequencedBlockedFixture('F3');
  fixture.ports.interruptTurn = async () => {
    fixture.actions.push('interruptTurn');
    throw new Error('cleanup failed');
  };

  await assert.rejects(sequenceNanoHostBlockedCreate('F3', fixture.ports), /cleanup failed/u);
  assert.equal(fixture.actions.includes('runDockerSmoke'), false);
  assert.ok(fixture.actions.lastIndexOf('stopNanoHost') > fixture.actions.indexOf('interruptTurn'));
});

test('F3 smoke failure rejects the scenario and fail-stops NanoHost', async () => {
  const fixture = sequencedBlockedFixture('F3');
  fixture.ports.runDockerSmoke = async () => {
    fixture.actions.push('runDockerSmoke');
    throw new Error('smoke failed');
  };

  await assert.rejects(sequenceNanoHostBlockedCreate('F3', fixture.ports), /smoke failed/u);
  assert.ok(
    fixture.actions.lastIndexOf('stopNanoHost') > fixture.actions.indexOf('runDockerSmoke')
  );
});

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

test('F3 rejects an automatic NanoCore restart before dispatching host reboot', async () => {
  const fixture = sequencedBlockedFixture('F3');
  fixture.ports.readNanoCoreContainer = async () => ({ restart: 'always', running: true });

  await assert.rejects(sequenceNanoHostBlockedCreate('F3', fixture.ports));
  assert.equal(fixture.actions.includes('rebootHost'), false);
  assert.equal(fixture.actions.includes('interruptTurn'), false);
  assert.equal(fixture.actions.includes('runDockerSmoke'), false);
});

test('F3 rejects NanoHost boot activation before creating a Task or delivering a fault', async () => {
  const fixture = sequencedBlockedFixture('F3');
  fixture.initialEpoch.unitFileState = 'enabled';

  await assert.rejects(
    sequenceNanoHostBlockedCreate('F3', fixture.ports),
    /requires one static NanoHost unit/u
  );
  assert.equal(fixture.actions.includes('killNanoCore'), false);
  assert.equal(fixture.actions.includes('startTask'), false);
  assert.equal(fixture.actions.includes('rebootHost'), false);
  assert.equal(fixture.actions.includes('stopNanoHost'), false);
  assert.equal(fixture.actions.includes('runDockerSmoke'), false);
  assert.equal(
    fixture.actions.some((action) => action.startsWith('signal:')),
    false
  );
});

test('F4 recovers the fenced epoch before its pending Turn cleanup settles', async () => {
  const fixture = sequencedBlockedFixture('F4');
  fixture.ports.readTurn = async () => ({ id: fixture.lineage.turnId, status: 'running' });

  await sequenceNanoHostBlockedCreate('F4', fixture.ports);
  assert.ok(fixture.actions.indexOf('startNanoHost') < fixture.actions.indexOf('interruptTurn'));
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
      evidence.final.finalStatus.status = 'failed';
    },
    name: 'failed terminal status',
  },
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
    const baseline = hostBaseline(`baseline:${id}`);
    return {
      evidence: {
        action: { code: contracts[id].action, observed: true },
        barrier: { code: contracts[id].barrier, observed: true },
        cleanup: { code: contracts[id].cleanup, observed: true },
        credential: secretCanary,
        fault: { code: contracts[id].fault, observed: true },
        lineage: privateLineage,
        proof: scenarioProof(id, index),
        rawError: rawErrorCanary,
        verdict: 'PASS',
      },
      id,
      postBaseline: { ...baseline, components: { ...baseline.components } },
      preBaseline: { ...baseline, components: { ...baseline.components } },
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
    successorGeneration:
      (fenceGeneration ?? priorGeneration) + (id === 'F1' || id === 'F3' ? 1 : 2),
  };
}

function completeNormalLifecycleEvidence() {
  return Object.fromEntries(
    Object.entries(normalLifecycleContract).map(([name, code]) => [name, { code, observed: true }])
  );
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
    const baseline = scenarioEvidence.find(
      ({ id }) => id === overrides.baselineMismatch
    ).postBaseline;
    baseline.digest = digest(`changed:${overrides.baselineMismatch}`);
    if (overrides.baselineMismatch === 'F1' || overrides.baselineMismatch === 'F3') {
      baseline.components.nft = digest(`changed:${overrides.baselineMismatch}:nft`);
    }
  }
  const normalLifecycleEvidence = completeNormalLifecycleEvidence();
  if (overrides.invalidNormalLifecycle) {
    delete normalLifecycleEvidence[overrides.invalidNormalLifecycle];
  }
  return adjudicateNanoHostUnitFResult({
    attemptId: privateAttemptId,
    identity: overrides.identity ?? publicIdentity,
    instrumentDigest,
    normalLifecycleEvidence,
    scenarioEvidence,
  });
}

test('adjudicates the exact four Unit F scenarios and one aggregate from complete evidence', () => {
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

test('adjudication rejects a raw image ID as the retained NanoCore image reference', () => {
  assert.throws(
    () =>
      adjudicateAttempt({
        identity: {
          ...publicIdentity,
          nanoCoreImageId: `sha256:${'e'.repeat(64)}`,
          nanoCoreImageRef: `sha256:${'e'.repeat(64)}`,
          nanoHostExecutableSha256: 'f'.repeat(64),
        },
      }),
    /runtime byte identity is incomplete or invalid/u
  );
});

test('accepts distinct valid F3 baselines across the execution-server reboot', () => {
  const result = adjudicateAttempt({ baselineMismatch: 'F3' });
  const scenario = result.scenarios.find(({ id }) => id === 'F3');

  assert.notEqual(scenario.baseline.pre, scenario.baseline.post);
  assert.notEqual(scenario.baseline.components.pre.nft, scenario.baseline.components.post.nft);
  assert.equal(scenario.status, 'PASS');
  assert.equal(result.aggregate.status, 'PASS');
});

test('accepts distinct valid F1 baselines across the NanoCore restart', () => {
  const result = adjudicateAttempt({ baselineMismatch: 'F1' });
  const scenario = result.scenarios.find(({ id }) => id === 'F1');

  assert.notEqual(scenario.baseline.pre, scenario.baseline.post);
  assert.notEqual(scenario.baseline.components.pre.nft, scenario.baseline.components.post.nft);
  assert.equal(scenario.status, 'PASS');
  assert.equal(result.aggregate.status, 'PASS');
});

test('retains product-safe component hashes when a scenario baseline changes', () => {
  const scenarioEvidence = completeScenarioEvidence();
  const row = scenarioEvidence.find(({ id }) => id === 'F4');
  const pre = Object.fromEntries(
    baselineComponentNames.map((name) => [name, digest(`pre:${name}`)])
  );
  const post = { ...pre, nft: digest('post:nft') };
  row.preBaseline.components = pre;
  row.postBaseline = { components: post, digest: digest('changed:F4') };

  const result = adjudicateNanoHostUnitFResult({
    attemptId: privateAttemptId,
    identity: publicIdentity,
    instrumentDigest,
    normalLifecycleEvidence: completeNormalLifecycleEvidence(),
    scenarioEvidence,
  });
  const scenario = result.scenarios.find(({ id }) => id === 'F4');

  assert.equal(scenario.status, 'FAIL');
  assert.deepEqual(scenario.baseline.components, { post, pre });
});

for (const intervention of [
  { name: 'missing', mutate: (components) => delete components.nft },
  { name: 'malformed', mutate: (components) => (components.nft = rawErrorCanary) },
  { name: 'extra', mutate: (components) => (components.extra = digest('extra')) },
  {
    name: 'inherited',
    mutate: (components) => {
      const bridge = components.bridge;
      delete components.bridge;
      components.extra = digest('extra');
      Object.setPrototypeOf(components, { bridge });
    },
  },
]) {
  test(`fails closed when a baseline component hash is ${intervention.name}`, () => {
    const scenarioEvidence = completeScenarioEvidence();
    intervention.mutate(scenarioEvidence.find(({ id }) => id === 'F2').postBaseline.components);

    const result = adjudicateNanoHostUnitFResult({
      attemptId: privateAttemptId,
      identity: publicIdentity,
      instrumentDigest,
      normalLifecycleEvidence: completeNormalLifecycleEvidence(),
      scenarioEvidence,
    });

    assert.deepEqual(
      result.scenarios.map(({ id, status }) => ({ id, status })),
      scenarioIds.map((id) => ({ id, status: id === 'F2' ? 'FAIL' : 'PASS' }))
    );
    assert.doesNotMatch(JSON.stringify(result), new RegExp(rawErrorCanary, 'u'));
    assert.equal(result.aggregate.status, 'FAIL');
  });
}

test('fails only F4 when one retained component changes', () => {
  const scenarioEvidence = completeScenarioEvidence();
  scenarioEvidence.find(({ id }) => id === 'F4').postBaseline.components.nft =
    digest('changed:F4:nft');

  const result = adjudicateNanoHostUnitFResult({
    attemptId: privateAttemptId,
    identity: publicIdentity,
    instrumentDigest,
    normalLifecycleEvidence: completeNormalLifecycleEvidence(),
    scenarioEvidence,
  });

  assert.deepEqual(
    result.scenarios.map(({ id, status }) => ({ id, status })),
    scenarioIds.map((id) => ({ id, status: id === 'F4' ? 'FAIL' : 'PASS' }))
  );
  assert.equal(result.aggregate.status, 'FAIL');
});

test('rejects retained evidence whose scenario instrument differs from the actual runner', () => {
  const scenarioEvidence = completeScenarioEvidence();
  scenarioEvidence[2].evidence.proof.instrument = digest('foreign-unit-f-instrument');

  const result = adjudicateNanoHostUnitFResult({
    attemptId: privateAttemptId,
    identity: publicIdentity,
    instrumentDigest,
    normalLifecycleEvidence: completeNormalLifecycleEvidence(),
    scenarioEvidence,
  });

  assert.equal(result.scenarios[2].status, 'FAIL');
  assert.equal(result.aggregate.status, 'FAIL');
});

for (const incomplete of [
  { field: 'barrier', kind: 'missing', scenarioId: 'F1' },
  { field: 'fault', kind: 'wrong-code', scenarioId: 'F2' },
  { field: 'action', kind: 'not-observed', scenarioId: 'F3' },
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

test('coordinates exact F1 through F4 order before the normal lifecycle without trusting effects', async () => {
  const calls = [];
  const coordinated = await executeNanoHostUnitFCoordinator({
    captureBaseline: async () => {
      calls.push('baseline');
      return hostBaseline('coordinator-baseline');
    },
    executeScenarioEffect: async ({ scenarioId }) => {
      calls.push(`effect:${scenarioId}`);
      return {
        action: { code: 'effect-supplied-action', observed: false },
        barrier: { code: 'effect-supplied-barrier', observed: false },
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
    'effect:F1',
    'baseline',
    'baseline',
    'effect:F2',
    'baseline',
    'baseline',
    'effect:F3',
    'baseline',
    'baseline',
    'effect:F4',
    'baseline',
    'normal',
  ]);
  assert.deepEqual(
    coordinated.scenarioEvidence.map(({ evidence, id }) => ({ evidence, id })),
    scenarioIds.map((id) => ({
      evidence: {
        action: { code: contracts[id].action, observed: true },
        barrier: { code: contracts[id].barrier, observed: true },
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
  assert.deepEqual(calls, ['baseline', 'effect:F1', 'baseline', 'baseline', 'effect:F2']);
});

function defaultDriverOptions(overrides = {}) {
  return {
    attemptId: privateAttemptId,
    gitCommit: 'd'.repeat(40),
    gitUrl: 'https://github.com/openkit/openkit.git',
    hostManifestDigest: digest(
      readFileSync(join('apps', 'nanohost', 'deploy', 'host-manifest.json'))
    ),
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

test('default driver requires a Dockerfile-resolvable NanoCore image reference', () => {
  assert.throws(
    () =>
      createDefaultDriver(defaultDriverOptions({ nanoCoreImageRef: `sha256:${'e'.repeat(64)}` })),
    /Dockerfile-resolvable/u
  );
});

test('default driver proves the running image ID and candidate image reference independently', async () => {
  const calls = [];
  const imageId = `sha256:${'e'.repeat(64)}`;
  const manifestDigest = defaultDriverOptions().hostManifestDigest;
  let sshCalls = 0;
  const driver = createDefaultDriver(
    defaultDriverOptions({
      runCommand: async (command, args) => {
        calls.push({ args, command });
        if (command === '/usr/bin/env') return { stdout: `manifestDigest=${manifestDigest}\n` };
        if (command !== '/usr/bin/ssh') throw new Error('unexpected command owner boundary');
        sshCalls += 1;
        if (sshCalls === 1) return { stdout: JSON.stringify({ imageId }) };
        if (sshCalls === 2) return { stdout: JSON.stringify({ imageId }) };
        throw new Error('NanoHost identity boundary reached');
      },
    })
  );

  await assert.rejects(driver.captureBaseline(), /NanoHost identity boundary reached/u);
  assert.deepEqual(calls[2], {
    args: [
      'a1',
      "'/usr/bin/sudo' '-n' '/usr/bin/docker' 'image' 'inspect' '--format' '{\"imageId\":\"{{.Id}}\"}' 'openkit/app:unit-f'",
    ],
    command: '/usr/bin/ssh',
  });
});

test('default driver rejects a candidate image reference for different bytes', async () => {
  const imageId = `sha256:${'e'.repeat(64)}`;
  const manifestDigest = defaultDriverOptions().hostManifestDigest;
  let sshCalls = 0;
  const driver = createDefaultDriver(
    defaultDriverOptions({
      runCommand: async (command) => {
        if (command === '/usr/bin/env') return { stdout: `manifestDigest=${manifestDigest}\n` };
        sshCalls += 1;
        return sshCalls === 1
          ? { stdout: JSON.stringify({ imageId }) }
          : { stdout: JSON.stringify({ imageId: `sha256:${'c'.repeat(64)}` }) };
      },
    })
  );

  await assert.rejects(driver.captureBaseline(), /candidate image reference changed/u);
});

test('default driver admits only exact F1 through F4 identities into their real executor boundary', async () => {
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
        waitForDisconnect: async () => {},
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
        waitForDisconnect: async () => {},
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
  const manifestDigest = digest(
    readFileSync(join('apps', 'nanohost', 'deploy', 'host-manifest.json'))
  );
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
      tunnel: { start: async () => {}, stop: async () => {}, waitForDisconnect: async () => {} },
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
          waitForDisconnect: async () => {},
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
      "'/usr/bin/sudo' '-n' '/usr/bin/docker' 'inspect' '--format' '{\"imageId\":\"{{.Image}}\"}' 'openkit-nanocore-unit-f'",
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
