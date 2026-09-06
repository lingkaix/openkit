import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const scenarioIds = Object.freeze(['F1', 'F2', 'F3', 'F4']);
const scenarioContracts = Object.freeze({
  F1: Object.freeze({
    action: 'successor-transport-fenced-and-reconnected',
    barrier: 'post-launch-worker-sequence-durable',
    cleanup: 'same-lineage-finalized-without-replay',
    fault: 'nanocore-only-restarted',
  }),
  F2: Object.freeze({
    action: 'supervised-effect-domain-terminated',
    barrier: 'sandbox-create-accepted-and-blocked',
    cleanup: 'no-late-residue-and-fresh-empty-ready',
    fault: 'nanohost-sigkill-delivered',
  }),
  F3: Object.freeze({
    action: 'sessions-interrupted-or-unknown-and-epoch-nonready',
    barrier: 'nanohost-operation-live-or-in-flight',
    cleanup: 'fresh-members-empty-and-images-reverified',
    fault: 'execution-server-restarted',
  }),
  F4: Object.freeze({
    action: 'epoch-invalidated-siblings-terminated-without-member-restart',
    barrier: 'sandbox-operation-accepted',
    cleanup: 'sessions-interrupted-routes-capacity-fenced-and-fresh-epoch-ready',
    fault: 'effect-capable-member-killed',
  }),
});
const normalLifecycleContract = Object.freeze({
  finalFreshStart: 'final-fresh-start-all-three-ready',
  ordinaryStart: 'ordinary-start-all-three-ready',
  ordinaryStop: 'ordinary-stop-cgroup-and-private-network-namespace-absent',
  stoppedBaseline: 'service-stopped-baseline',
  systemDocker: 'system-docker-baseline-exact-equal',
});
const baselineComponentIds = Object.freeze(['bridge', 'containers', 'docker0', 'nft']);

const hostRoot = dirname(fileURLToPath(import.meta.url));
const hostManifestPath = resolve(hostRoot, '../../../apps/nanohost/deploy/host-manifest.json');
const hostAssertPath = resolve(hostRoot, 'assert.sh');
const sshAliasPattern = /^[a-z][a-z0-9-]{0,62}$/;
const digest40Pattern = /^[a-f0-9]{40}$/;
const digest64Pattern = /^[a-f0-9]{64}$/;
const workerImagePattern = /^(?:\S+@)?sha256:[a-f0-9]{64}$/;
const failureEvidenceByError = new WeakMap();

/** Hashes one private attempt value for retained correlation. */
function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Projects one epoch into retained public hashes without exposing member identity. */
function epochProof(epoch) {
  const members = epoch.members
    .map((member) =>
      JSON.stringify({
        exe: member.exe,
        netns: member.netns,
        pid: member.pid,
        starttime: member.starttime,
      })
    )
    .sort();
  return {
    boot: digest(epoch.bootId),
    invocation: digest(epoch.invocationId),
    members: digest(JSON.stringify(members)),
  };
}

/** Returns true only for one exact observed contract row. */
function observedContractRow(value, code) {
  return value?.code === code && value?.observed === true;
}

/** Accepts only the four hashed normalized host-baseline components. */
function validBaselineComponents(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === baselineComponentIds.length &&
    baselineComponentIds.every(
      (name) => Object.hasOwn(value, name) && digest64Pattern.test(value[name] ?? '')
    )
  );
}

/** Adjudicates one F scenario without trusting a producer-supplied verdict. */
export function adjudicateNanoHostUnitFScenario(
  id,
  evidence,
  preBaseline,
  postBaseline,
  instrumentDigest
) {
  const contract = scenarioContracts[id];
  const observations = { ...contract };
  const lineage = evidence?.lineage;
  const lineageComplete = [
    lineage?.agentSessionId,
    lineage?.backendSessionId,
    lineage?.leaseId,
    lineage?.turnId,
  ].every((value) => typeof value === 'string' && value.length > 0);
  const proof = evidence?.proof;
  const generationsComplete =
    Number.isSafeInteger(proof?.priorGeneration) &&
    Number.isSafeInteger(proof?.successorGeneration) &&
    (proof?.fenceGeneration === null
      ? proof.successorGeneration === proof.priorGeneration + 1
      : Number.isSafeInteger(proof?.fenceGeneration) &&
        proof.fenceGeneration === proof.priorGeneration + 1 &&
        proof.successorGeneration === proof.fenceGeneration + (id === 'F3' ? 1 : 2));
  const proofComplete =
    [proof?.boot, proof?.faultTarget, proof?.instrument, proof?.invocation, proof?.members].every(
      (value) => digest64Pattern.test(value ?? '')
    ) &&
    generationsComplete &&
    (instrumentDigest === undefined || proof?.instrument === instrumentDigest) &&
    (id === 'F1'
      ? proof.effectRequest === null && proof.sandbox === null
      : digest64Pattern.test(proof?.effectRequest ?? '') &&
        digest64Pattern.test(proof?.sandbox ?? ''));
  const baselineComplete =
    digest64Pattern.test(preBaseline?.digest ?? '') &&
    digest64Pattern.test(postBaseline?.digest ?? '') &&
    validBaselineComponents(preBaseline?.components) &&
    validBaselineComponents(postBaseline?.components) &&
    (id === 'F1' ||
      id === 'F3' ||
      (preBaseline.digest === postBaseline.digest &&
        baselineComponentIds.every(
          (name) => preBaseline.components[name] === postBaseline.components[name]
        )));
  const complete =
    baselineComplete &&
    observedContractRow(evidence?.barrier, contract.barrier) &&
    observedContractRow(evidence?.fault, contract.fault) &&
    observedContractRow(evidence?.action, contract.action) &&
    observedContractRow(evidence?.cleanup, contract.cleanup) &&
    lineageComplete &&
    proofComplete;

  return {
    baseline: {
      components: {
        post: Object.fromEntries(
          baselineComponentIds.map((name) => [
            name,
            digest64Pattern.test(postBaseline?.components?.[name] ?? '')
              ? postBaseline.components[name]
              : null,
          ])
        ),
        pre: Object.fromEntries(
          baselineComponentIds.map((name) => [
            name,
            digest64Pattern.test(preBaseline?.components?.[name] ?? '')
              ? preBaseline.components[name]
              : null,
          ])
        ),
      },
      post: postBaseline?.digest ?? null,
      pre: preBaseline?.digest ?? null,
    },
    id,
    lineage: {
      agentSession:
        typeof lineage?.agentSessionId === 'string' ? digest(lineage.agentSessionId) : null,
      backendSession:
        typeof lineage?.backendSessionId === 'string' ? digest(lineage.backendSessionId) : null,
      lease: typeof lineage?.leaseId === 'string' ? digest(lineage.leaseId) : null,
      turn: typeof lineage?.turnId === 'string' ? digest(lineage.turnId) : null,
    },
    observations,
    proof: proofComplete
      ? {
          boot: proof.boot,
          effectRequest: proof.effectRequest,
          faultTarget: proof.faultTarget,
          fenceGeneration: proof.fenceGeneration,
          instrument: proof.instrument,
          invocation: proof.invocation,
          members: proof.members,
          priorGeneration: proof.priorGeneration,
          sandbox: proof.sandbox,
          successorGeneration: proof.successorGeneration,
        }
      : null,
    status: complete ? 'PASS' : 'FAIL',
  };
}

/** Adjudicates the Aggregate-owned ordinary lifecycle gate. */
function adjudicateNormalLifecycle(evidence) {
  const complete = Object.entries(normalLifecycleContract).every(([name, code]) =>
    observedContractRow(evidence?.[name], code)
  );
  return {
    observations: { ...normalLifecycleContract },
    status: complete ? 'PASS' : 'FAIL',
  };
}

/** Executes one command without a shell and returns its exact captured streams. */
export function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      reject(new Error('Unit F command timeout is invalid.'));
      return;
    }
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let deadlineExpired = false;
    const settle = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const closed = new Promise((resolvePromise) => child.once('close', resolvePromise));
    const timer = setTimeout(() => {
      if (settled) return;
      deadlineExpired = true;
      void killChildAndWaitForClose(child, closed, 'verification command').then(
        () => settle(() => reject(new Error('Unit F verification command deadline expired.'))),
        (error) => settle(() => reject(error))
      );
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      if (!deadlineExpired) settle(() => reject(error));
    });
    child.once('close', (status, signal) => {
      if (deadlineExpired) return;
      const result = {
        signal,
        status,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      };
      if (status !== 0) {
        settle(() =>
          reject(new Error(`Verification command failed with status ${status ?? 'null'}.`))
        );
        return;
      }
      settle(() => resolvePromise(result));
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}

/** SIGKILLs one child and proves its close event within a second bounded deadline. */
async function killChildAndWaitForClose(child, closed, label, timeoutMs = 5_000) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  const proved = await Promise.race([closed.then(() => true), delay(timeoutMs).then(() => false)]);
  if (!proved) throw new Error(`Unit F ${label} cleanup is unproved.`);
}

/** Polls one owner observation until it succeeds or the bounded deadline expires. */
export async function waitForObservation(observe, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observationTimeoutMs = Math.max(1, deadline - Date.now());
    const observationDeadline = new AbortController();
    const value = await Promise.race([
      Promise.resolve()
        .then(observe)
        .catch(() => null),
      delay(observationTimeoutMs, null, { signal: observationDeadline.signal }),
    ]);
    observationDeadline.abort();
    if (value) return value;
    await delay(250);
  }
  throw new Error('Unit F owner observation deadline expired.');
}

/** Parses one command's exact single JSON value. */
function parseCommandJson(result) {
  const text = result.stdout.trim();
  if (!text) throw new Error('Unit F owner command returned no observation.');
  return JSON.parse(text);
}

/** Owns the one explicit SSH local forward used by the stdlib App API client. */
export function createNanoCoreTunnel(config, spawnChild = spawn) {
  let child = null;
  let childClosed = null;
  const start = async () => {
    if (child && child.exitCode === null && child.signalCode === null) return;
    child = spawnChild(
      '/usr/bin/ssh',
      [
        '-o',
        'ExitOnForwardFailure=yes',
        '-L',
        `127.0.0.1:${config.localPort}:127.0.0.1:${config.remoteNanoCorePort}`,
        '-N',
        config.sshAlias,
      ],
      { stdio: 'ignore' }
    );
    childClosed = new Promise((resolvePromise) => child.once('close', resolvePromise));
    await config.waitFor(async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Unit F NanoCore SSH forward exited.');
      }
      return appRequest(config, 'GET', '/api/health', undefined, 'product').catch(() => null);
    }, 300_000);
  };
  const stop = async () => {
    const current = child;
    const currentClosed = childClosed;
    child = null;
    childClosed = null;
    if (!current || !currentClosed) return;
    if (current.exitCode === null && current.signalCode === null) current.kill('SIGTERM');
    const closedAfterGrace = await Promise.race([
      currentClosed.then(() => true),
      delay(5_000).then(() => false),
    ]);
    if (!closedAfterGrace) {
      await killChildAndWaitForClose(current, currentClosed, 'SSH forward');
    }
  };
  const waitForDisconnect = async () => {
    const current = child;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    await Promise.race([
      new Promise((resolvePromise) => current.once('close', resolvePromise)),
      delay(60_000).then(() => {
        throw new Error('Unit F SSH forward did not observe host reboot.');
      }),
    ]);
  };
  return { start, stop, waitForDisconnect };
}

/** Sends one bounded JSON request over the current HTTP/1.1 App SSH forward. */
export async function requestJson(config, method, path, body, authority = 'product') {
  const timeoutMs = config.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Unit F App API timeout is invalid.');
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${config.localPort}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(authority === 'admin'
          ? { authorization: `Bearer ${config.token}` }
          : { cookie: config.sessionCookie }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      method,
      signal: deadline.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Unit F App API request failed with status ${response.status}.`);
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error('Unit F App API response was not JSON.');
    }
  } catch (error) {
    if (deadline.signal.aborted) {
      throw new Error('Unit F App API request deadline expired.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Routes App API operations through the injectable low-level HTTP seam. */
function appRequest(config, method, path, body, authority = 'product') {
  return (config.request ?? requestJson)(config, method, path, body, authority);
}

/** Reads and verifies the repository-owned A1 host manifest through its existing owner. */
async function assertHostManifest(sshAlias, expectedDigest, execute = runCommand) {
  const manifestBytes = await readFile(hostManifestPath);
  if (digest(manifestBytes) !== expectedDigest) {
    throw new Error('Unit F host-manifest identity does not match repository bytes.');
  }
  const asserted = await execute('/usr/bin/env', ['bash', hostAssertPath, sshAlias]);
  if (asserted.stdout !== `manifestDigest=${expectedDigest}\n`) {
    throw new Error('Unit F host-manifest assertion did not return its exact identity.');
  }
}

/** Proves the running container and candidate reference resolve to one admitted image ID. */
async function assertNanoCoreImageIdentity(config) {
  const observed = parseCommandJson(
    await runSudo(config.execute, config.sshAlias, [
      '/usr/bin/docker',
      'inspect',
      '--format',
      '{"imageId":"{{.Image}}"}',
      config.nanoCoreContainer,
    ])
  );
  if (observed.imageId !== config.nanoCoreImageId) {
    throw new Error('Unit F NanoCore image identity changed from the admitted deployment.');
  }
  const candidate = parseCommandJson(
    await runSudo(config.execute, config.sshAlias, [
      '/usr/bin/docker',
      'image',
      'inspect',
      '--format',
      '{"imageId":"{{.Id}}"}',
      config.nanoCoreImageRef,
    ])
  );
  if (candidate.imageId !== config.nanoCoreImageId) {
    throw new Error(
      'Unit F NanoCore candidate image reference changed from the admitted image ID.'
    );
  }
}

/** Binds the installed NanoHost executable to the exact admitted A1 bytes. */
async function assertNanoHostExecutableIdentity(config) {
  const beforeEpoch = await readEpochMembers(config);
  if (beforeEpoch.activeState !== 'active') {
    if (config.nanoHostExecutableProved !== true) {
      throw new Error('Unit F cannot bind NanoHost bytes without one live epoch.');
    }
    return;
  }
  const before = selectEpochMember(beforeEpoch, 'nanohost');
  if (config.nanoHostExecutablePath && config.nanoHostExecutablePath !== before.exe) {
    throw new Error('Unit F NanoHost executable path changed between epochs.');
  }
  const result = await runSudo(config.execute, config.sshAlias, [
    '/usr/bin/sha256sum',
    '--',
    `/proc/${before.pid}/exe`,
  ]);
  const afterEpoch = await readEpochMembers(config);
  const after = selectEpochMember(afterEpoch, 'nanohost');
  if (
    beforeEpoch.bootId !== afterEpoch.bootId ||
    beforeEpoch.invocationId !== afterEpoch.invocationId ||
    before.pid !== after.pid ||
    before.starttime !== after.starttime ||
    before.exe !== after.exe ||
    before.netns !== after.netns
  ) {
    throw new Error('Unit F NanoHost executable identity changed during hashing.');
  }
  const observed = result.stdout.trim().split(/\s+/u)[0];
  if (observed !== config.nanoHostExecutableSha256) {
    throw new Error('Unit F running NanoHost executable bytes changed.');
  }
  if (!before.exe.startsWith('/')) {
    throw new Error('Unit F cannot bind NanoHost bytes without one live epoch.');
  }
  config.nanoHostExecutablePath = before.exe;
  config.nanoHostExecutableProved = true;
}

/** Runs one exact POSIX-quoted command through OpenSSH's remote shell. */
function runSsh(execute, sshAlias, remoteArgs, options = {}) {
  const remoteCommand = remoteArgs.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
  return execute('/usr/bin/ssh', [sshAlias, remoteCommand], options);
}

/** Runs one exact privileged host command through the manifest-owned sudo boundary. */
function runSudo(execute, sshAlias, args, options = {}) {
  return runSsh(execute, sshAlias, ['/usr/bin/sudo', '-n', ...args], options);
}

/** Captures the normalized system-Docker and host-network baseline on A1. */
async function captureA1Baseline(config) {
  await assertHostManifest(config.sshAlias, config.hostManifestDigest, config.execute);
  await assertNanoCoreImageIdentity(config);
  await assertNanoHostExecutableIdentity(config);
  const script = String.raw`
    const { createHash } = require('node:crypto');
    const { spawnSync } = require('node:child_process');
    const run = (path, args, input) => {
      const result = spawnSync(path, args, { encoding: 'utf8', input });
      if (result.status !== 0) process.exit(1);
      return result.stdout;
    };
    const stable = (value) => {
      if (Array.isArray(value)) return value.map(stable);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !['bytes', 'counter', 'handle', 'packets'].includes(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]));
    };
    const containerIds = run('/usr/bin/docker', ['ps', '-aq', '--no-trunc'])
      .trim().split(/\s+/u).filter(Boolean);
    const containers = containerIds.length === 0
      ? []
      : JSON.parse(run('/usr/bin/docker', ['inspect', ...containerIds]));
    const projectedContainers = containers.map((container) => ({
      id: container.Id,
      image: container.Image,
      name: container.Name,
      networks: Object.fromEntries(Object.entries(container.NetworkSettings?.Networks ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, network]) => [name, {
        endpointId: network.EndpointID,
        gateway: network.Gateway,
        ipAddress: network.IPAddress,
        macAddress: network.MacAddress,
        networkId: network.NetworkID,
      }])),
    })).sort((a, b) => a.name.localeCompare(b.name));
    const bridge = stable(JSON.parse(run('/usr/bin/docker', ['network', 'inspect', 'bridge'])));
    const docker0 = {
      address: JSON.parse(run('/usr/sbin/ip', ['-j', 'address', 'show', 'docker0'])),
      route: JSON.parse(run('/usr/sbin/ip', ['-j', 'route', 'show', 'dev', 'docker0'])),
    };
    const nft = stable(JSON.parse(run('/usr/sbin/nft', ['-j', 'list', 'ruleset'])));
    const payload = stable({ bridge, containers: projectedContainers, docker0, nft });
    const componentDigests = Object.fromEntries(Object.entries(payload).map(([name, value]) => [name, createHash('sha256').update(JSON.stringify(value)).digest('hex')]));
    process.stdout.write(JSON.stringify({ components: componentDigests, digest: createHash('sha256').update(JSON.stringify(payload)).digest('hex') }));
  `;
  return parseCommandJson(
    await runSudo(config.execute, config.sshAlias, ['/usr/bin/node', '-e', script])
  );
}

/** Proves one bounded system-Docker build has usable default-network DNS. */
async function runSystemDockerBuildNetworkSmoke(config) {
  const image = parseCommandJson(
    await runSudo(config.execute, config.sshAlias, [
      '/usr/bin/docker',
      'inspect',
      '--format',
      '{"image":"{{.Image}}"}',
      config.nanoCoreContainer,
    ])
  ).image;
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('Unit F system-Docker smoke image identity is invalid.');
  }
  const dockerfile = `FROM ${config.nanoCoreImageRef}\nRUN node -e "require('node:dns').lookup('registry.npmjs.org',(error)=>process.exit(error?1:0))"\n`;
  await runSudo(
    config.execute,
    config.sshAlias,
    ['/usr/bin/docker', 'build', '--network=default', '--no-cache', '--output=type=cacheonly', '-'],
    { input: dockerfile }
  );
}

/** Reads the configured RuntimeTarget through the existing authenticated App API. */
async function readRuntimeTarget(config) {
  const target = await appRequest(
    config,
    'GET',
    '/api/app/nanohost/runtime-target',
    undefined,
    'admin'
  );
  if (
    target.identityId !== config.nanoHostIdentityId ||
    target.deploymentId !== config.nanoHostDeploymentId ||
    !Number.isSafeInteger(target.connectionGeneration)
  ) {
    throw new Error('Unit F RuntimeTarget identity is incompatible.');
  }
  return target;
}

/** Reads product-safe runtime evidence for one exact Turn through the existing App API. */
export async function readTurnRuntimeEvidence(config, lineage) {
  const runtimeEvidence = await readWorkspaceRuntimeEvidence(config, lineage.workspaceId);
  return runtimeEvidence.filter((record) => record.turnId === lineage.turnId);
}

/** Reads product-safe runtime evidence for one fresh Unit F Workspace. */
export async function readWorkspaceRuntimeEvidence(config, workspaceId) {
  const response = await appRequest(
    config,
    'GET',
    `/api/app/workspaces/${workspaceId}/runtime-evidence`,
    undefined,
    'product'
  );
  return response.runtimeEvidence ?? [];
}

/** Reads one public AEP lineage for the in-flight Task. */
async function waitForTaskLineage(task) {
  return task.config.waitFor(async () => {
    const response = await appRequest(
      task.config,
      'GET',
      `/api/app/workspaces/${task.workspaceId}/agent-environment/snapshots`,
      undefined,
      'product'
    );
    const records = (response.items ?? []).filter(
      (record) => record.workspaceId === task.workspaceId && record.threadId === task.threadId
    );
    const record = records.at(-1);
    const snapshot = record?.snapshot;
    const requestId = snapshot?.scope?.requestId;
    if (!record || requestId !== task.requestId) {
      const completionError = task.readCompletionError();
      if (completionError) throw completionError;
      return null;
    }
    const workspaceInputs = snapshot?.workspace?.inputs ?? [];
    const workspaceInput = workspaceInputs.find(
      (input) => input.target === '/workspace/openkit/worktrees/main'
    );
    if (
      snapshot?.runtime?.image?.ref !== task.config.workerImageRef ||
      snapshot?.workspace?.root !== '/workspace/openkit' ||
      workspaceInput?.target !== '/workspace/openkit/worktrees/main' ||
      workspaceInput?.source?.kind !== 'git' ||
      workspaceInput?.source?.url !== task.config.gitUrl ||
      workspaceInput?.source?.commit !== task.config.gitCommit ||
      workspaceInput?.source?.sourceId !== 'task-mode-repository' ||
      workspaceInput?.source?.sourceRef !== 'task-mode-repository'
    ) {
      throw new Error('Unit F Task AEP does not bind the exact image and Git workspace.');
    }
    return {
      agentSessionId: record.agentSessionId,
      packageSnapshotId: record.snapshotId,
      requestId,
      threadId: record.threadId,
      turnId: record.turnId,
      workspaceId: record.workspaceId,
    };
  });
}

/**
 * Reads internal NanoCore facts only through their built owning accessors.
 *
 * The streamed program contains no SQL and returns one bounded exact-lineage
 * snapshot; the caller retains only adjudicated hashes.
 */
async function readNanoCoreOwnerSnapshot(config, lineage) {
  const script = `
    const { createHash } = await import('node:crypto');
    const input = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));
    const root = '/app/nanocore/dist';
    const { openCoreDb, openWorkspaceDb } = await import(root + '/storage/db.js');
    const { FsStore } = await import(root + '/lib/store.js');
    const { listWorkspaceCapabilityCalls, listWorkspaceUsageRecords } = await import(root + '/capability/usage-ledger.js');
    const { listWorkerControlAcceptedEvents, getWorkerControlAcceptedFinalStatus } = await import(root + '/runtime/worker-control-records.js');
    const { listSchedulerSessionLeasesForTurn } = await import(root + '/scheduler-records.js');
    const { getWorkerBackendSession } = await import(root + '/runtime/worker-backend-sessions.js');
    const { getNanoHostRuntimeTarget } = await import(root + '/runtime/nanohost-runtime-target.js');
    const { listWorkspaceRuntimeEvidence } = await import(root + '/runtime/runtime-evidence.js');
    const coreDb = openCoreDb(input.dataRoot);
    const workspaceDb = openWorkspaceDb(input.dataRoot, input.lineage.workspaceId);
    try {
      const store = new FsStore({ dataRoot: input.dataRoot });
      const turn = store.getTurn(input.lineage.workspaceId, input.lineage.threadId, input.lineage.turnId);
      const agentSession = store.getAgentSession(input.lineage.agentSessionId);
      const leases = listSchedulerSessionLeasesForTurn(coreDb, input.lineage).filter((row) => row.agentSessionId === input.lineage.agentSessionId && row.packageSnapshotId === input.lineage.packageSnapshotId);
      const backends = leases.map((lease) => getWorkerBackendSession(coreDb, lease.leaseId)).filter(Boolean);
      const runtimeTarget = backends.length === 1 && typeof backends[0].runtimeTargetId === 'string' ? getNanoHostRuntimeTarget(coreDb, backends[0].runtimeTargetId) : null;
      const events = listWorkerControlAcceptedEvents(coreDb, input.lineage);
      const acceptedFinalStatus = getWorkerControlAcceptedFinalStatus(coreDb, input.lineage);
      const terminalEvents = events.filter((row) => row.event?.type === 'turn.completed' || row.event?.type === 'turn.failed');
      if (acceptedFinalStatus && (terminalEvents.length !== 1 || terminalEvents[0].event?.data?.status !== acceptedFinalStatus.status || terminalEvents[0].event?.data?.stopReason !== acceptedFinalStatus.stopReason)) {
        throw new Error('Accepted final status contradicts its canonical terminal event.');
      }
      if (!acceptedFinalStatus && terminalEvents.length !== 0) {
        throw new Error('Canonical terminal event has no accepted final status.');
      }
      const finalStatus = acceptedFinalStatus ? { ...acceptedFinalStatus, sequence: terminalEvents[0].sequence } : null;
      const runtimeEvidence = listWorkspaceRuntimeEvidence(workspaceDb, input.lineage.workspaceId).filter((row) => row.turnId === input.lineage.turnId);
      const capabilityCalls = listWorkspaceCapabilityCalls(workspaceDb, input.lineage.workspaceId).filter((row) => row.turnId === input.lineage.turnId && row.agentSessionId === input.lineage.agentSessionId && row.packageSnapshotId === input.lineage.packageSnapshotId);
      const usageRecords = listWorkspaceUsageRecords(workspaceDb, input.lineage.workspaceId).filter((row) => row.turnId === input.lineage.turnId && row.agentSessionId === input.lineage.agentSessionId);
      const items = store.listThreadItems(input.lineage.workspaceId, input.lineage.threadId).filter((row) => row.turnId === input.lineage.turnId);
      const artifacts = store.listArtifacts(input.lineage.workspaceId).filter((row) => row.turnId === input.lineage.turnId);
      const fingerprint = (row) => createHash('sha256').update(JSON.stringify(row)).digest('hex');
      const transcriptSequence = (id, prefix) => {
        if (!id.startsWith(prefix)) return null;
        const value = Number(id.slice(prefix.length));
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
      };
      const projectionOwners = {
        artifacts: artifacts.map((row) => ({
          fingerprint: fingerprint(row),
          id: row.id,
          requestId: row.lastMutationRequestId,
          transcriptSequence: transcriptSequence(row.id, 'worker-artifact-' + input.lineage.packageSnapshotId + '-'),
        })),
        capabilityCalls: capabilityCalls.map((row) => {
          const { completedAt, errorCode, status, ...immutable } = row;
          return {
            completedAt,
            errorCode,
            family: row.family,
            fingerprint: fingerprint(immutable),
            id: row.id,
            serviceRef: row.serviceRef,
            status,
          };
        }),
        inference: usageRecords.filter((row) => row.category === 'llm').map((row) => ({
          capabilityCallId: row.capabilityCallId,
          fingerprint: fingerprint(row),
          id: row.id,
          itemId: row.itemId,
        })),
        items: items.map((row) => ({
          artifactId: row.type === 'artifact-reference' ? row.artifactId : null,
          fingerprint: fingerprint(row),
          id: row.id,
          transcriptSequence: transcriptSequence(row.id, 'it_worker_' + input.lineage.turnId + '_'),
          type: row.type,
        })),
      };
      const projectionCounts = {
        activeBackend: backends.filter((row) => !['cleaned', 'physical-cleaned'].includes(row.state)).length,
        activeLease: leases.filter((row) => !['released', 'lost', 'failed'].includes(row.status)).length,
        workerReady: events.filter((row) => row.event?.type === 'worker.ready').length,
      };
      process.stdout.write(JSON.stringify({ agentSession, backends, events, finalStatus, leases, projectionCounts, projectionOwners, runtimeEvidence, runtimeTarget, turn }));
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  `;
  const payload = Buffer.from(
    JSON.stringify({ dataRoot: config.nanoCoreDataRoot, lineage })
  ).toString('base64url');
  return parseCommandJson(
    await runSudo(config.execute, config.sshAlias, [
      '/usr/bin/docker',
      'exec',
      config.nanoCoreContainer,
      '/usr/local/bin/node',
      '--input-type=module',
      '-e',
      script,
      payload,
    ])
  );
}

/** Starts the existing real Task runner while exposing only its public lineage coordinates. */
async function startRealTaskAttempt(config, scenarioId) {
  const workspace = await appRequest(
    config,
    'POST',
    '/api/workspaces',
    { name: `NanoHost Unit F ${scenarioId}`, requestId: randomUUID() },
    'product'
  );
  config.failureWorkspaceId = workspace.id;
  const thread = await appRequest(
    config,
    'POST',
    `/api/workspaces/${workspace.id}/threads`,
    {
      name: `NanoHost Unit F ${scenarioId}`,
      requestId: randomUUID(),
      workspaceId: workspace.id,
    },
    'product'
  );
  const catalog = `${JSON.stringify(
    {
      schemaVersion: 1,
      sources: [
        {
          access: 'read-write',
          allowedSlotKinds: ['worktree'],
          displayName: 'NanoHost Unit F repository',
          id: 'task-mode-repository',
          kind: 'git',
          locator: { commit: config.gitCommit, url: config.gitUrl },
          sensitivity: 'internal',
          status: 'active',
        },
      ],
    },
    null,
    2
  )}\n`;
  const created = await appRequest(
    config,
    'POST',
    '/api/admin/config/file',
    {
      content: catalog,
      id: `workspaces/${workspace.id}/data-sources.jsonc`,
      kind: 'data-source',
    },
    'admin'
  );
  if (created?.file?.exists !== true || (created?.diagnostics ?? []).length !== 0) {
    throw new Error('Unit F workspace data-source owner rejected setup.');
  }
  const reload = await appRequest(
    config,
    'POST',
    '/api/admin/config/reload',
    { mode: 'safe' },
    'admin'
  );
  if (
    (reload?.plan?.rejected ?? []).length !== 0 ||
    (reload?.plan?.requiresRestart ?? []).length !== 0
  ) {
    throw new Error('Unit F workspace data-source reload was not safe.');
  }
  const requestId = randomUUID();
  const completion = appRequest(
    config,
    'POST',
    `/api/app/workspaces/${workspace.id}/threads/${thread.id}/task`,
    {
      input:
        scenarioId === 'F1'
          ? 'Run `sleep 240` once. After it returns, reply exactly `DONE` without running another command.'
          : 'Inspect README.md and report one concise observation.',
      requestId,
    },
    'product'
  );
  let completionError = null;
  void completion.catch((error) => {
    completionError = error;
  });
  return {
    config,
    readCompletionError: () => completionError,
    requestId,
    threadId: thread.id,
    workspaceId: workspace.id,
  };
}

/** Reads exact current NanoHost cgroup members and their process identities. */
async function readEpochMembers(config) {
  const script = String.raw`
    const { readFileSync, readdirSync, readlinkSync } = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const show = spawnSync('/usr/bin/systemctl', ['show', 'openkit-nanohost.service', '--property=ActiveState,SubState,ControlGroup,InvocationID,UnitFileState'], { encoding: 'utf8' });
    if (show.status !== 0) process.exit(1);
    const fields = Object.fromEntries(show.stdout.trim().split(/\r?\n/u).map((line) => line.split(/=(.*)/su).slice(0, 2)));
    const { ActiveState: activeState, ControlGroup: controlGroup, InvocationID: invocationId, SubState: subState, UnitFileState: unitFileState } = fields;
    const root = controlGroup ? '/sys/fs/cgroup' + controlGroup : null;
    const collect = (directory) => {
      let pids = [];
      try { pids.push(...readFileSync(directory + '/cgroup.procs', 'utf8').trim().split(/\s+/u).filter(Boolean).map(Number)); } catch {}
      try { for (const name of readdirSync(directory, { withFileTypes: true })) if (name.isDirectory()) pids.push(...collect(directory + '/' + name.name)); } catch {}
      return pids;
    };
    const members = [...new Set(root ? collect(root) : [])].sort((a, b) => a - b).map((pid) => {
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8').split(' ');
      return {
        args: readFileSync('/proc/' + pid + '/cmdline').toString().split('\0').filter(Boolean),
        exe: readlinkSync('/proc/' + pid + '/exe'),
        netns: readlinkSync('/proc/' + pid + '/ns/net'),
        pid,
        starttime: stat[21],
        state: stat[2],
      };
    });
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    process.stdout.write(JSON.stringify({ activeState, bootId, controlGroup, invocationId, members, subState, unitFileState }));
  `;
  const value = parseCommandJson(
    await runSudo(config.execute, config.sshAlias, ['/usr/bin/node', '-e', script])
  );
  if (
    !value.bootId ||
    !value.unitFileState ||
    !Array.isArray(value.members) ||
    (value.activeState === 'active' && (!value.controlGroup || !value.invocationId))
  ) {
    throw new Error('Unit F NanoHost cgroup observation is incomplete.');
  }
  return value;
}

/** Selects one exact current epoch member by its executable and closed argument signature. */
function selectEpochMember(epoch, role) {
  const matches = epoch.members.filter((member) => {
    const command = `${member.exe}\0${member.args.join('\0')}`;
    if (role === 'nanohost') {
      return member.exe.endsWith('/nanohost') && member.args[0] === member.exe;
    }
    if (role === 'gateway') return /openshell/u.test(command) && /gateway/u.test(command);
    if (role === 'dockerd')
      return /\/dockerd(?:\0|$)/u.test(command) && /openkit-nanohost/u.test(command);
    return false;
  });
  if (matches.length !== 1) throw new Error(`Unit F exact ${role} member is unavailable.`);
  return matches[0];
}

/** Signals one process only while its exact proc identity still matches. */
async function signalExactMember(config, member, signal) {
  const script = `
    const { readFileSync, readlinkSync } = require('node:fs');
    const input = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));
    try {
      const stat = readFileSync('/proc/' + input.pid + '/stat', 'utf8').split(' ');
      const exe = readlinkSync('/proc/' + input.pid + '/exe');
      const netns = readlinkSync('/proc/' + input.pid + '/ns/net');
      if (stat[21] !== input.starttime || exe !== input.exe || netns !== input.netns) process.exit(2);
      process.kill(input.pid, input.signal);
      process.stdout.write('{"signalled":true}');
    } catch (error) {
      if (error && error.code === 'ENOENT') process.stdout.write('{"signalled":false}');
      else process.exit(1);
    }
  `;
  const payload = Buffer.from(JSON.stringify({ ...member, signal })).toString('base64url');
  return parseCommandJson(
    await runSudo(config.execute, config.sshAlias, ['/usr/bin/node', '-e', script, payload])
  );
}

/** Captures the current service journal cursor without retaining it in results. */
async function readJournalCursor(config) {
  const output = await runSudo(config.execute, config.sshAlias, [
    '/usr/bin/journalctl',
    '-u',
    'openkit-nanohost.service',
    '-n',
    '0',
    '--show-cursor',
    '--no-pager',
  ]);
  const match = /-- cursor: (\S+)/u.exec(output.stdout);
  if (!match) throw new Error('Unit F journal cursor is unavailable.');
  return match[1];
}

/** Validates one frozen NanoHost accepted-effect observation without performing a fault. */
export function inspectNanoHostBlockedCreateObservation({ current, entries, fixture, target }) {
  const effectRequestHash = digest(`${fixture.lineage.requestId}\0sandbox.create`);
  const nanohost = selectEpochMember(current, 'nanohost');
  const gateway = selectEpochMember(current, 'gateway');
  const dockerd = selectEpochMember(current, 'dockerd');
  const sameMember = (observed, frozen) =>
    observed.pid === frozen.pid &&
    observed.starttime === frozen.starttime &&
    observed.exe === frozen.exe &&
    observed.netns === frozen.netns &&
    JSON.stringify(observed.args) === JSON.stringify(frozen.args);
  if (
    current.bootId !== fixture.epoch.bootId ||
    current.invocationId !== fixture.epoch.invocationId ||
    !sameMember(nanohost, fixture.nanohost) ||
    !sameMember(gateway, fixture.gateway) ||
    !sameMember(dockerd, fixture.dockerd) ||
    dockerd.state !== 'T'
  ) {
    throw new Error('Unit F blocked-create member identity changed.');
  }
  if (
    target.connectionGeneration !== fixture.target.connectionGeneration ||
    target.predecessorFenced !== true ||
    target.ready !== true ||
    target.freshEmpty !== true
  ) {
    throw new Error('Unit F blocked-create RuntimeTarget changed.');
  }
  const messages = entries
    .filter(
      (entry) =>
        entry._SYSTEMD_INVOCATION_ID === fixture.epoch.invocationId &&
        entry._SYSTEMD_UNIT === 'openkit-nanohost.service' &&
        entry._EXE === fixture.nanohost.exe
    )
    .map((entry) => String(entry.MESSAGE ?? '').trim());
  const accepted = messages.filter(
    (message) => message === 'nanohost effect accepted: operation=CreateSandbox'
  );
  if (accepted.length !== 1 || messages.some((message) => message.includes('effect failure'))) {
    return null;
  }
  return {
    effectRequestHash,
    sandboxHash: digest(fixture.backendSessionId),
  };
}

/** Resolves exact old state/runtime roots from frozen member arguments. */
function privateEpochRoots(oldEpoch) {
  const roots = [
    ...new Set(
      oldEpoch.members.flatMap((member) =>
        member.args.flatMap((argument) => {
          const match = /^((?:\/var\/lib|\/run)\/openkit\/nanohost\/epoch-[^/]+)/u.exec(argument);
          return match ? [match[1]] : [];
        })
      )
    ),
  ];
  if (roots.length !== 2) {
    throw new Error('Unit F cannot identify the exact private epoch state and runtime roots.');
  }
  return roots;
}

/** Decides whether one old epoch has no live socket or same-boot namespace residue. */
export function epochEffectsAreAbsent(observation, oldBootId) {
  return (
    typeof oldBootId === 'string' &&
    oldBootId.length > 0 &&
    typeof observation.bootId === 'string' &&
    observation.bootId.length > 0 &&
    observation.socketsAbsent === true &&
    (observation.bootId !== oldBootId || observation.netnsStillReferenced === false)
  );
}

/** Proves old private namespace holders and live private sockets are absent. */
async function waitForEpochEffectsAbsent(config, oldEpoch) {
  const privateNetns = selectEpochMember(oldEpoch, 'gateway').netns;
  const runtimeRoot = privateEpochRoots(oldEpoch).find((path) => path.startsWith('/run/'));
  if (!runtimeRoot) throw new Error('Unit F cannot identify the private runtime root.');
  await config.waitFor(async () => {
    const payload = Buffer.from(JSON.stringify({ privateNetns, runtimeRoot })).toString(
      'base64url'
    );
    const script = `
      const { readFileSync, readdirSync, readlinkSync } = require('node:fs');
      const input = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));
      if (!/^\\/run\\/openkit\\/nanohost\\/epoch-[^/]+$/u.test(input.runtimeRoot)) process.exit(2);
      if (!/^net:\\[[0-9]+\\]$/u.test(input.privateNetns)) process.exit(2);
      const netnsStillReferenced = readdirSync('/proc').filter((name) => /^[0-9]+$/u.test(name)).some((pid) => {
        try { return readlinkSync('/proc/' + pid + '/ns/net') === input.privateNetns; } catch { return false; }
      });
      const liveSockets = new Set(readFileSync('/proc/net/unix', 'utf8').split(/\\r?\\n/u).map((line) => line.trim().split(/\\s+/u).at(-1)));
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const socketsAbsent = !liveSockets.has(input.runtimeRoot + '/containerd.sock') && !liveSockets.has(input.runtimeRoot + '/docker.sock');
      process.stdout.write(JSON.stringify({ bootId, netnsStillReferenced, socketsAbsent }));
    `;
    const residue = parseCommandJson(
      await runSudo(config.execute, config.sshAlias, ['/usr/bin/node', '-e', script, payload])
    );
    return epochEffectsAreAbsent(residue, oldEpoch.bootId) ? true : null;
  });
}

/** Proves a successful successor removed both inert prior epoch roots. */
async function waitForPriorEpochRootsRemoved(config, oldEpoch) {
  const roots = privateEpochRoots(oldEpoch);
  await config.waitFor(async () => {
    const payload = Buffer.from(JSON.stringify({ roots })).toString('base64url');
    const script = `
      const { existsSync } = require('node:fs');
      const input = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));
      if (!input.roots.every((path) => /^\\/(?:var\\/lib|run)\\/openkit\\/nanohost\\/epoch-[^/]+$/u.test(path))) process.exit(2);
      process.stdout.write(JSON.stringify({ absent: input.roots.every((path) => !existsSync(path)) }));
    `;
    const result = parseCommandJson(
      await runSudo(config.execute, config.sshAlias, ['/usr/bin/node', '-e', script, payload])
    );
    return result.absent === true ? true : null;
  });
}

/** Returns whether one runtime generation is the sole exact successor of another. */
function isExactNextGeneration(priorGeneration, successorGeneration) {
  return (
    Number.isSafeInteger(priorGeneration) &&
    Number.isSafeInteger(successorGeneration) &&
    successorGeneration === priorGeneration + 1
  );
}

/** Completes one proven first-fence recovery before starting its sole successor. */
export async function completeNanoHostFirstFenceRecovery({
  fenceGeneration,
  firstEpoch,
  priorGeneration,
  proveEffectsAbsent,
  proveEpochEmpty,
  provePriorRootsRemoved,
  startSuccessor,
  waitForFreshTarget,
}) {
  if (!firstEpoch || !Number.isSafeInteger(fenceGeneration)) {
    throw new Error('Unit F first-fence recovery observation is incomplete.');
  }
  await proveEpochEmpty(firstEpoch);
  await proveEffectsAbsent(firstEpoch);
  if (!isExactNextGeneration(priorGeneration, fenceGeneration)) {
    throw new Error('Unit F first-fence generation is not the exact next generation.');
  }
  await startSuccessor();
  const target = await waitForFreshTarget(fenceGeneration);
  if (!isExactNextGeneration(fenceGeneration, target?.connectionGeneration)) {
    throw new Error('Unit F first-fence successor generation is not exact.');
  }
  await provePriorRootsRemoved(firstEpoch);
  return target;
}

/** Returns one exact backend/lease lineage or fails closed. */
function requireOwnerTuple(snapshot, lineage) {
  if (
    snapshot.leases?.length !== 1 ||
    snapshot.backends?.length !== 1 ||
    snapshot.leases[0].agentSessionId !== lineage.agentSessionId ||
    snapshot.backends[0].agentSessionId !== lineage.agentSessionId ||
    snapshot.leases[0].packageSnapshotId !== lineage.packageSnapshotId ||
    snapshot.backends[0].packageSnapshotId !== lineage.packageSnapshotId
  ) {
    throw new Error('Unit F durable owner tuple is not singular.');
  }
  return { backend: snapshot.backends[0], lease: snapshot.leases[0] };
}

/** Requires one exact live lease/backend/RuntimeTarget capacity tuple. */
function requireBlockedCreateLiveOwner(snapshot, lineage, generation) {
  const tuple = requireOwnerTuple(snapshot, lineage);
  const runtimeTarget = snapshot.runtimeTarget;
  const activeBackend = snapshot.backends.filter(
    (record) => !['cleaned', 'physical-cleaned'].includes(record.state)
  ).length;
  const activeLease = snapshot.leases.filter(
    (record) => !['released', 'lost', 'failed'].includes(record.status)
  ).length;
  if (
    ['cleaned', 'physical-cleaned'].includes(tuple.backend.state) ||
    ['released', 'lost', 'failed'].includes(tuple.lease.status) ||
    activeBackend !== 1 ||
    activeLease !== 1 ||
    (snapshot.projectionCounts !== undefined &&
      (snapshot.projectionCounts.activeBackend !== 1 ||
        snapshot.projectionCounts.activeLease !== 1)) ||
    runtimeTarget?.targetId !== tuple.backend.runtimeTargetId ||
    runtimeTarget?.connectionGeneration !== generation ||
    runtimeTarget?.slotCount !== 1 ||
    runtimeTarget?.predecessorFenced !== true ||
    runtimeTarget?.ready !== true ||
    runtimeTarget?.freshEmpty !== true
  ) {
    throw new Error('Unit F blocked-create owner no longer holds exact live capacity.');
  }
  return {
    backendSessionId: tuple.backend.backendSessionId,
    connectionGeneration: runtimeTarget.connectionGeneration,
    leaseId: tuple.lease.leaseId,
    runtimeTargetId: tuple.backend.runtimeTargetId,
    tuple,
  };
}

/** Requires a stable blocked-create owner immediately before fault delivery. */
function requireSameBlockedCreateOwner(snapshot, lineage, expected) {
  const current = requireBlockedCreateLiveOwner(snapshot, lineage, expected.connectionGeneration);
  if (
    current.leaseId !== expected.leaseId ||
    current.backendSessionId !== expected.backendSessionId ||
    current.runtimeTargetId !== expected.runtimeTargetId
  ) {
    throw new Error('Unit F blocked-create owner changed before fault delivery.');
  }
  return current;
}

/** Proves a nonempty worker sequence has no gap, replay, or reordering. */
function hasExactWorkerSequence(events) {
  const sequences = events.map((event) => event.sequence);
  return (
    sequences.length > 0 &&
    sequences.every(
      (sequence, index) =>
        Number.isSafeInteger(sequence) && (index === 0 || sequence === sequences[index - 1] + 1)
    )
  );
}

/** Returns whether one ordered owner projection is a byte-exact prefix of another. */
function hasExactProjectionPrefix(prefix, records) {
  return (
    Array.isArray(prefix) &&
    Array.isArray(records) &&
    prefix.length <= records.length &&
    prefix.every((record, index) => JSON.stringify(record) === JSON.stringify(records[index]))
  );
}

/** Returns whether capability identities are stable and status only advances to terminal. */
function hasCapabilityProjectionProgression(prefix, records, allowSuffix) {
  if (
    !Array.isArray(prefix) ||
    !Array.isArray(records) ||
    prefix.length > records.length ||
    (!allowSuffix && prefix.length !== records.length)
  ) {
    return false;
  }
  const terminal = new Set(['cancelled', 'failed', 'succeeded']);
  return prefix.every((record, index) => {
    const successor = records[index];
    const stateUnchanged =
      record.status === successor?.status &&
      record.completedAt === successor.completedAt &&
      record.errorCode === successor.errorCode;
    const reachedTerminal =
      record.status === 'running' &&
      record.completedAt === null &&
      record.errorCode === null &&
      terminal.has(successor?.status) &&
      typeof successor.completedAt === 'string';
    return (
      record.id === successor?.id &&
      record.fingerprint === successor.fingerprint &&
      (stateUnchanged || reachedTerminal)
    );
  });
}

/** Returns whether every projected durable owner has one unique nonempty identity. */
function hasUniqueProjectionIds(records) {
  return (
    Array.isArray(records) &&
    records.every((record) => typeof record.id === 'string' && record.id.length > 0) &&
    new Set(records.map((record) => record.id)).size === records.length
  );
}

/** Adjudicates exact F1 generation, epoch, sequence, output, capability, and capacity continuity. */
export function adjudicateNanoHostF1Continuation({
  adopted,
  before,
  epochAfter,
  epochBefore,
  final,
  journal,
  lineage,
  priorGeneration,
  successorTarget,
}) {
  const beforeTuple = requireOwnerTuple(before, lineage);
  const adoptedTuple = requireOwnerTuple(adopted, lineage);
  const finalTuple = requireOwnerTuple(final, lineage);
  const beforeSequences = before.events.map((event) => event.sequence);
  const adoptedSequences = adopted.events.map((event) => event.sequence);
  const beforeHeartbeatSequence = beforeTuple.lease.lastWorkerSequence;
  const beforeTranscriptSequence = beforeSequences.at(-1);
  const adoptedTranscriptSequence = adoptedSequences.at(-1);
  const beforeOwners = before.projectionOwners;
  const adoptedOwners = adopted.projectionOwners;
  const finalOwners = final.projectionOwners;
  const ownerNames = ['artifacts', 'inference', 'items'];
  const finalCapabilityIds = new Set(
    (finalOwners?.capabilityCalls ?? []).map((record) => record.id)
  );
  const newArtifacts = (finalOwners?.artifacts ?? []).slice(adoptedOwners?.artifacts?.length);
  const newItems = (finalOwners?.items ?? []).slice(adoptedOwners?.items?.length);
  const newInference = (finalOwners?.inference ?? []).slice(adoptedOwners?.inference?.length);
  const newArtifactIds = new Set(newArtifacts.map((record) => record.id));
  const finalSuffixSequences = [
    ...final.events.slice(adopted.events.length).map((event) => event.sequence),
    ...newItems.flatMap((record) =>
      Number.isSafeInteger(record.transcriptSequence) ? [record.transcriptSequence] : []
    ),
    ...newArtifacts.flatMap((record) =>
      Number.isSafeInteger(record.transcriptSequence) ? [record.transcriptSequence] : []
    ),
  ].sort((left, right) => left - right);
  const expectedFinalSuffixLength = final.finalStatus?.sequence - adoptedTranscriptSequence;
  const expectedFinalSuffix =
    Number.isSafeInteger(expectedFinalSuffixLength) && expectedFinalSuffixLength >= 0
      ? Array.from(
          { length: expectedFinalSuffixLength },
          (_, index) => adoptedTranscriptSequence + index + 1
        )
      : null;
  if (
    successorTarget.connectionGeneration !== priorGeneration + 1 ||
    successorTarget.predecessorFenced !== true ||
    successorTarget.ready !== true ||
    epochAfter.bootId !== epochBefore.bootId ||
    epochAfter.invocationId !== epochBefore.invocationId ||
    epochBefore.members.some(
      (member) =>
        !epochAfter.members.some(
          (current) =>
            current.pid === member.pid &&
            current.starttime === member.starttime &&
            current.exe === member.exe &&
            current.netns === member.netns
        )
    ) ||
    journal.includes('/openshell.v1.OpenShell/CreateSandbox') ||
    !hasExactWorkerSequence(before.events) ||
    !Number.isSafeInteger(beforeHeartbeatSequence) ||
    !Number.isSafeInteger(beforeTranscriptSequence) ||
    before.projectionCounts.workerReady !== 1 ||
    before.projectionCounts.activeBackend !== 1 ||
    before.projectionCounts.activeLease !== 1 ||
    before.finalStatus !== null ||
    adoptedTuple.backend.backendSessionId !== beforeTuple.backend.backendSessionId ||
    adoptedTuple.lease.workerProcessKeyHash !== beforeTuple.lease.workerProcessKeyHash ||
    adoptedTuple.lease.packageSnapshotId !== beforeTuple.lease.packageSnapshotId ||
    adoptedSequences.length <= beforeSequences.length ||
    !Number.isSafeInteger(adoptedTranscriptSequence) ||
    adoptedTranscriptSequence <= beforeTranscriptSequence ||
    !Number.isSafeInteger(adoptedTuple.lease.lastWorkerSequence) ||
    adoptedTuple.lease.lastWorkerSequence <= beforeHeartbeatSequence ||
    !hasExactWorkerSequence(adopted.events) ||
    !hasExactProjectionPrefix(before.events, adopted.events) ||
    !ownerNames.every((name) =>
      hasExactProjectionPrefix(beforeOwners?.[name], adoptedOwners?.[name])
    ) ||
    !hasCapabilityProjectionProgression(
      beforeOwners?.capabilityCalls,
      adoptedOwners?.capabilityCalls,
      true
    ) ||
    adopted.projectionCounts.workerReady !== 1 ||
    adopted.projectionCounts.activeBackend !== 1 ||
    adopted.projectionCounts.activeLease !== 1 ||
    final.finalStatus?.status !== 'completed' ||
    finalTuple.backend.backendSessionId !== beforeTuple.backend.backendSessionId ||
    finalTuple.lease.leaseId !== beforeTuple.lease.leaseId ||
    !Number.isSafeInteger(finalTuple.lease.lastWorkerSequence) ||
    finalTuple.lease.lastWorkerSequence < adoptedTuple.lease.lastWorkerSequence ||
    !Number.isSafeInteger(final.finalStatus?.sequence) ||
    final.finalStatus.sequence < adoptedTranscriptSequence ||
    final.events.at(-1)?.sequence !== final.finalStatus.sequence ||
    !hasExactProjectionPrefix(adopted.events, final.events) ||
    !ownerNames.every((name) =>
      hasExactProjectionPrefix(adoptedOwners?.[name], finalOwners?.[name])
    ) ||
    !['artifacts', 'capabilityCalls', 'inference', 'items'].every((name) =>
      hasUniqueProjectionIds(finalOwners?.[name])
    ) ||
    !hasCapabilityProjectionProgression(
      adoptedOwners?.capabilityCalls,
      finalOwners?.capabilityCalls,
      true
    ) ||
    (finalOwners?.capabilityCalls ?? []).some(
      (record) =>
        !['cancelled', 'failed', 'running', 'succeeded'].includes(record.status) ||
        (record.status === 'running'
          ? record.completedAt !== null || record.errorCode !== null
          : typeof record.completedAt !== 'string')
    ) ||
    newInference.some((record) => !finalCapabilityIds.has(record.capabilityCallId)) ||
    newArtifacts.some(
      (record) =>
        record.requestId !== lineage.requestId || !Number.isSafeInteger(record.transcriptSequence)
    ) ||
    newItems.some(
      (record) =>
        !Number.isSafeInteger(record.transcriptSequence) &&
        !(record.type === 'artifact-reference' && newArtifactIds.has(record.artifactId))
    ) ||
    newArtifacts.some(
      (artifact) =>
        newItems.filter(
          (item) => item.type === 'artifact-reference' && item.artifactId === artifact.id
        ).length !== 1
    ) ||
    !expectedFinalSuffix ||
    finalSuffixSequences.length !== expectedFinalSuffix.length ||
    finalSuffixSequences.some((sequence, index) => sequence !== expectedFinalSuffix[index]) ||
    final.projectionCounts.workerReady !== 1 ||
    final.projectionCounts.activeBackend !== 0 ||
    final.projectionCounts.activeLease !== 0 ||
    final.runtimeEvidence.filter((record) => record.phase === 'teardown').length !== 1
  ) {
    throw new Error('Unit F F1 continuation proof failed.');
  }
  return true;
}

/** Interrupts a surviving fault Task through the existing product owner. */
async function interruptFaultTask(config, lineage) {
  const turnPath = `/api/workspaces/${lineage.workspaceId}/threads/${lineage.threadId}/turns/${lineage.turnId}`;
  const isTerminal = (turn) =>
    ['cancelled', 'completed', 'failed', 'interrupted'].includes(turn?.status);
  if (isTerminal(await appRequest(config, 'GET', turnPath, undefined, 'product'))) return;
  try {
    await appRequest(
      config,
      'POST',
      `${turnPath}/interrupt`,
      {
        requestId: randomUUID(),
        threadId: lineage.threadId,
        turnId: lineage.turnId,
        workspaceId: lineage.workspaceId,
      },
      'product'
    );
  } catch (error) {
    if (isTerminal(await appRequest(config, 'GET', turnPath, undefined, 'product'))) return;
    throw error;
  }
}

/** Waits for one raw RuntimeTarget projection to satisfy one local predicate. */
async function waitForSequencedRuntimeTarget(ports, predicate) {
  return ports.waitFor(async () => {
    const target = await ports.readRuntimeTarget();
    return predicate(target) ? target : null;
  });
}

/** Waits for one exact-lineage owner snapshot to satisfy one local predicate. */
async function waitForSequencedOwnerSnapshot(ports, lineage, predicate) {
  return ports.waitFor(async () => {
    const snapshot = await ports.readOwnerSnapshot(lineage);
    return predicate(snapshot) ? snapshot : null;
  });
}

/** Returns whether one exact fault owner released its backend capacity. */
function sequencedFaultCapacityReleased(candidate) {
  const backend = candidate.backends?.[0];
  const lease = candidate.leases?.[0];
  return (
    candidate.backends?.length === 1 &&
    candidate.leases?.length === 1 &&
    ['cleaned', 'physical-cleaned'].includes(backend?.state) &&
    typeof backend?.physicalCleanedAt === 'string' &&
    ['released', 'lost', 'failed'].includes(lease?.status) &&
    candidate.runtimeEvidence.filter((record) => record.phase === 'teardown').length === 1
  );
}

/** Returns whether one exact fault Turn is terminal after releasing its backend route. */
function sequencedFaultTurnFenced(candidate) {
  return (
    sequencedFaultCapacityReleased(candidate) &&
    ['cancelled', 'failed', 'interrupted'].includes(candidate.turn?.status)
  );
}

/** Proves exact-lineage backend, lease, Turn, and target cleanup. */
async function proveSequencedTurnCleanup(ports, lineage) {
  const snapshot = await waitForSequencedOwnerSnapshot(ports, lineage, (candidate) => {
    const backend = candidate.backends?.[0];
    const lease = candidate.leases?.[0];
    return (
      candidate.backends?.length === 1 &&
      candidate.leases?.length === 1 &&
      ['cleaned', 'physical-cleaned'].includes(backend?.state) &&
      typeof backend?.physicalCleanedAt === 'string' &&
      ['released', 'lost', 'failed'].includes(lease?.status) &&
      candidate.runtimeEvidence.filter((record) => record.phase === 'teardown').length === 1 &&
      !['pending', 'running', 'awaiting_human'].includes(candidate.turn?.status)
    );
  });
  requireOwnerTuple(snapshot, lineage);
  const target = await ports.readRuntimeTarget();
  if (target.predecessorFenced !== true || target.ready !== true || target.freshEmpty !== true) {
    throw new Error('Unit F cleanup did not restore exact empty RuntimeTarget capacity.');
  }
}

/** Proves one stopped epoch has no surviving member or live private effect. */
async function proveSequencedEpochAbsent(ports, oldEpoch) {
  await ports.waitFor(async () => {
    const current = await ports.readEpoch();
    return current.members.length === 0 &&
      oldEpoch.members.every(
        (old) =>
          !current.members.some(
            (member) => member.pid === old.pid && member.starttime === old.starttime
          )
      )
      ? true
      : null;
  });
  await ports.waitFor(async () => ((await ports.readEpochEffects(oldEpoch)).absent ? true : null));
}

/** Proves one successful successor removed the prior epoch roots. */
async function proveSequencedPriorRootsRemoved(ports, oldEpoch) {
  await ports.waitFor(async () => ((await ports.readPriorRoots(oldEpoch)).absent ? true : null));
}

/** Starts and proves one exact fresh successor, including the accepted first-fence path. */
async function recoverFreshEpochSequence(
  ports,
  priorGeneration,
  oldEpoch,
  faultLineage = null,
  acceptDirectReady = false
) {
  await ports.startNanoHost();
  const startedEpoch = await ports.waitFor(() => ports.readEpoch().catch(() => null));
  let firstInvocationId =
    startedEpoch.invocationId && startedEpoch.invocationId !== oldEpoch.invocationId
      ? startedEpoch.invocationId
      : null;
  let firstEpoch = startedEpoch.activeState === 'active' && firstInvocationId ? startedEpoch : null;
  const outcome = await ports.waitFor(async () => {
    const target = await ports.readRuntimeTarget();
    const directlyReady =
      isExactNextGeneration(priorGeneration, target.connectionGeneration) &&
      target.predecessorFenced === true &&
      target.ready === true &&
      target.freshEmpty === true;
    if (directlyReady && !faultLineage) return { kind: 'ready', target };
    if (directlyReady && acceptDirectReady) {
      const owner = await ports.readOwnerSnapshot(faultLineage);
      if (sequencedFaultTurnFenced(owner)) {
        requireOwnerTuple(owner, faultLineage);
        return { kind: 'ready', target };
      }
    }
    const epoch = await ports.readEpoch();
    if (epoch.activeState === 'active') {
      if (epoch.invocationId !== oldEpoch.invocationId) {
        if (firstInvocationId && epoch.invocationId !== firstInvocationId) {
          throw new Error('Unit F first recovery epoch identity changed.');
        }
        firstInvocationId = epoch.invocationId;
        firstEpoch = epoch;
      }
      return null;
    }
    if (
      !firstInvocationId ||
      !firstEpoch ||
      !isExactNextGeneration(priorGeneration, target.connectionGeneration) ||
      target.predecessorFenced !== true ||
      target.ready !== false ||
      target.freshEmpty !== false ||
      epoch.members.length !== 0
    ) {
      return null;
    }
    const journal = await ports.readJournal({ invocationId: firstInvocationId });
    const terminal = journal.entries.filter(
      (entry) =>
        String(entry.MESSAGE ?? '').trim() ===
        'nanohost outer session failure: disposition=terminal stage=poll operation=sandbox.create status=409'
    );
    return terminal.length === 1
      ? { fenceGeneration: target.connectionGeneration, firstEpoch, kind: 'first-fence' }
      : null;
  });
  let target = outcome.target;
  let postFenceEpoch = null;
  if (outcome.kind === 'first-fence') {
    target = await completeNanoHostFirstFenceRecovery({
      fenceGeneration: outcome.fenceGeneration,
      firstEpoch: outcome.firstEpoch,
      priorGeneration,
      proveEffectsAbsent: async (epoch) => {
        await ports.waitFor(async () =>
          (await ports.readEpochEffects(epoch)).absent ? true : null
        );
      },
      proveEpochEmpty: async (epoch) => {
        await ports.waitFor(async () => {
          const current = await ports.readEpoch();
          return current.members.length === 0 &&
            epoch.members.every(
              (old) =>
                !current.members.some(
                  (member) => member.pid === old.pid && member.starttime === old.starttime
                )
            )
            ? true
            : null;
        });
      },
      provePriorRootsRemoved: (epoch) => proveSequencedPriorRootsRemoved(ports, epoch),
      startSuccessor: async () => {
        await ports.startNanoHost();
        if (faultLineage) {
          postFenceEpoch = await ports.waitFor(async () => {
            const epoch = await ports.readEpoch();
            if (
              epoch.activeState !== 'active' ||
              epoch.invocationId === outcome.firstEpoch.invocationId
            ) {
              return null;
            }
            try {
              selectEpochMember(epoch, 'gateway');
              selectEpochMember(epoch, 'dockerd');
            } catch {
              return null;
            }
            return epoch;
          });
        }
      },
      waitForFreshTarget: (generation) =>
        ports.waitFor(async () => {
          const candidate = await ports.readRuntimeTarget();
          if (
            !isExactNextGeneration(generation, candidate.connectionGeneration) ||
            candidate.predecessorFenced !== true
          ) {
            return null;
          }
          if (!faultLineage) {
            return candidate.ready === true && candidate.freshEmpty === true ? candidate : null;
          }
          if (candidate.ready === false && candidate.freshEmpty === false) return candidate;
          if (candidate.ready === true && candidate.freshEmpty === true) {
            const owner = await ports.readOwnerSnapshot(faultLineage);
            if (sequencedFaultTurnFenced(owner)) {
              requireOwnerTuple(owner, faultLineage);
              return candidate;
            }
          }
          return null;
        }),
    });
    if (faultLineage) {
      const released = await waitForSequencedOwnerSnapshot(
        ports,
        faultLineage,
        sequencedFaultCapacityReleased
      );
      requireOwnerTuple(released, faultLineage);
      if (!postFenceEpoch) {
        throw new Error('Unit F post-fence proof successor epoch is unavailable.');
      }
      if (target.ready === false && target.freshEmpty === false) {
        await proveSequencedEpochAbsent(ports, postFenceEpoch);
        const journal = await ports.readJournal({ invocationId: postFenceEpoch.invocationId });
        const terminal = journal.entries.filter(
          (entry) =>
            String(entry.MESSAGE ?? '').trim() ===
            'nanohost outer session failure: disposition=terminal stage=poll operation=sandbox.create status=409'
        );
        if (terminal.length !== 1) {
          throw new Error('Unit F post-fence proof successor did not fail-stop exactly once.');
        }
        const proofGeneration = target.connectionGeneration;
        await ports.startNanoHost();
        target = await waitForSequencedRuntimeTarget(
          ports,
          (candidate) =>
            isExactNextGeneration(proofGeneration, candidate.connectionGeneration) &&
            candidate.predecessorFenced === true &&
            candidate.ready === true &&
            candidate.freshEmpty === true
        );
        await proveSequencedPriorRootsRemoved(ports, postFenceEpoch);
      }
    }
  }
  const epoch = await ports.readEpoch();
  if (
    epoch.invocationId === oldEpoch.invocationId ||
    epoch.members.some((member) =>
      oldEpoch.members.some((old) => old.pid === member.pid && old.starttime === member.starttime)
    )
  ) {
    throw new Error('Unit F fresh epoch reused an old member identity.');
  }
  return {
    epoch,
    fenceGeneration: outcome.kind === 'first-fence' ? outcome.fenceGeneration : null,
    target,
  };
}

/** Sequences F1 from closed owner facts and primitive effects. */
export async function sequenceNanoHostF1(ports) {
  const priorTarget = await waitForSequencedRuntimeTarget(
    ports,
    (target) =>
      Number.isSafeInteger(target.connectionGeneration) &&
      target.predecessorFenced === true &&
      target.ready === true &&
      target.freshEmpty === true
  );
  let task = null;
  let lineage = null;
  let epochBefore = null;
  let primaryError = null;
  let result = null;
  try {
    epochBefore = await ports.readEpoch();
    task = await ports.startTask('F1');
    lineage = await ports.resolveLineage(task);
    if (!lineage) throw new Error('Unit F F1 Task lineage is unavailable.');
    const beforeObservation = await ports.waitFor(async () => {
      const snapshot = await ports.readOwnerSnapshot(lineage);
      const runtimeTarget = snapshot.runtimeTarget ?? (await ports.readRuntimeTarget());
      if (runtimeTarget.ready === false) {
        return { runtimeTargetLost: true, snapshot };
      }
      const capabilityCalls = snapshot.projectionOwners?.capabilityCalls ?? [];
      const inference = snapshot.projectionOwners?.inference ?? [];
      const inferenceCalls = capabilityCalls.filter(
        ({ family, serviceRef }) => family === 'llm' && serviceRef === 'worker-inference-gateway'
      );
      return snapshot.projectionCounts?.workerReady === 1 &&
        snapshot.leases?.length === 1 &&
        snapshot.backends?.length === 1 &&
        inference.some(({ capabilityCallId }) =>
          inferenceCalls.some(({ id, status }) => id === capabilityCallId && status === 'succeeded')
        ) &&
        inferenceCalls.every((record) => record.status !== 'running')
        ? { runtimeTargetLost: false, snapshot }
        : null;
    });
    if (beforeObservation.runtimeTargetLost) {
      throw new Error('Unit F F1 RuntimeTarget became nonready before its restart barrier.');
    }
    const before = beforeObservation.snapshot;
    const beforeTuple = requireOwnerTuple(before, lineage);
    const beforeSequences = before.events.map((event) => event.sequence);
    const beforeHeartbeatSequence = beforeTuple.lease.lastWorkerSequence;
    const beforeTranscriptSequence = beforeSequences.at(-1);
    if (
      !hasExactWorkerSequence(before.events) ||
      !Number.isSafeInteger(beforeHeartbeatSequence) ||
      !Number.isSafeInteger(beforeTranscriptSequence) ||
      before.projectionCounts.workerReady !== 1 ||
      before.projectionCounts.activeBackend !== 1 ||
      before.projectionCounts.activeLease !== 1 ||
      before.finalStatus !== null
    ) {
      throw new Error('Unit F F1 post-launch sequence barrier is incomplete.');
    }
    epochBefore = await ports.readEpoch();
    const cursor = await ports.readJournalCursor();
    await ports.killNanoCore();
    await ports.startNanoCore();
    await ports.startTunnel();
    const successorTarget = await waitForSequencedRuntimeTarget(
      ports,
      (target) =>
        isExactNextGeneration(priorTarget.connectionGeneration, target.connectionGeneration) &&
        target.predecessorFenced === true &&
        target.ready === true
    );
    const epochAfter = await ports.readEpoch();
    const journal = await ports.readJournal({
      afterCursor: cursor,
      invocationId: epochBefore.invocationId,
    });
    const adopted = await waitForSequencedOwnerSnapshot(ports, lineage, (snapshot) => {
      const lease = snapshot.leases?.[0];
      return (
        snapshot.leases?.length === 1 &&
        snapshot.backends?.length === 1 &&
        lease?.leaseId === beforeTuple.lease.leaseId &&
        Number.isSafeInteger(lease?.lastWorkerSequence) &&
        lease?.lastWorkerSequence > beforeHeartbeatSequence &&
        Number.isSafeInteger(snapshot.events?.at(-1)?.sequence) &&
        snapshot.events?.at(-1)?.sequence > beforeTranscriptSequence
      );
    });
    const final = await waitForSequencedOwnerSnapshot(
      ports,
      lineage,
      (snapshot) =>
        snapshot.finalStatus !== null &&
        snapshot.projectionCounts?.activeBackend === 0 &&
        snapshot.projectionCounts?.activeLease === 0 &&
        snapshot.runtimeEvidence.filter((record) => record.phase === 'teardown').length === 1
    );
    adjudicateNanoHostF1Continuation({
      adopted,
      before,
      epochAfter,
      epochBefore,
      final,
      journal: journal.text,
      lineage,
      priorGeneration: priorTarget.connectionGeneration,
      successorTarget,
    });
    const finalTarget = await ports.readRuntimeTarget();
    if (
      finalTarget.predecessorFenced !== true ||
      finalTarget.ready !== true ||
      finalTarget.freshEmpty !== true
    ) {
      throw new Error('Unit F F1 did not restore exact empty RuntimeTarget capacity.');
    }
    result = {
      lineage: {
        agentSessionId: lineage.agentSessionId,
        backendSessionId: beforeTuple.backend.backendSessionId,
        leaseId: beforeTuple.lease.leaseId,
        turnId: lineage.turnId,
      },
      proof: {
        ...epochProof(epochBefore),
        faultTarget: digest(
          JSON.stringify({
            imageId: ports.nanoCoreImageId,
            imageRef: ports.nanoCoreImageRef,
            target: 'nanocore-container',
          })
        ),
        effectRequest: null,
        fenceGeneration: null,
        instrument: ports.instrumentDigest,
        priorGeneration: priorTarget.connectionGeneration,
        sandbox: null,
        successorGeneration: successorTarget.connectionGeneration,
      },
    };
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try {
    await ports.startNanoCore();
    await ports.startTunnel();
    if (task && !lineage) {
      await ports.stopNanoHost();
      if (epochBefore) await proveSequencedEpochAbsent(ports, epochBefore);
    }
    await ports.startNanoHost();
    if (lineage && !result) {
      await ports.interruptTurn(lineage);
      await proveSequencedTurnCleanup(ports, lineage);
      await ports.startNanoHost();
    }
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'Unit F F1 failed and exact cleanup also failed.'
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

/** Sequences one shared F2-F4 blocked-create fault from closed owner facts. */
export async function sequenceNanoHostBlockedCreate(scenarioId, ports) {
  if (!['F2', 'F3', 'F4'].includes(scenarioId)) {
    throw new Error('Unit F blocked-create scenario identity is invalid.');
  }
  const projectedTarget = await waitForSequencedRuntimeTarget(
    ports,
    (target) =>
      Number.isSafeInteger(target.connectionGeneration) &&
      target.predecessorFenced === true &&
      target.ready === true &&
      target.freshEmpty === true
  );
  const projectedEpoch = await ports.readEpoch();
  if (scenarioId === 'F3' && projectedEpoch.unitFileState !== 'static') {
    throw new Error('Unit F F3 requires one static NanoHost unit before Task creation.');
  }
  // Drop the prior Harness's process-local continuity before its physical epoch is replaced.
  await ports.killNanoCore();
  await ports.startNanoCore();
  await ports.startTunnel();
  const reconnectedTarget = await waitForSequencedRuntimeTarget(
    ports,
    (target) =>
      isExactNextGeneration(projectedTarget.connectionGeneration, target.connectionGeneration) &&
      target.predecessorFenced === true &&
      target.ready === true &&
      target.freshEmpty === true
  );
  await ports.stopNanoHost();
  await proveSequencedEpochAbsent(ports, projectedEpoch);
  const prepared = await recoverFreshEpochSequence(
    ports,
    reconnectedTarget.connectionGeneration,
    projectedEpoch
  );
  await proveSequencedPriorRootsRemoved(ports, projectedEpoch);
  const priorTarget = prepared.target;
  let epoch = prepared.epoch;
  let nanohost = selectEpochMember(epoch, 'nanohost');
  let gateway = selectEpochMember(epoch, 'gateway');
  let dockerd = selectEpochMember(epoch, 'dockerd');
  if (
    epoch.members.some((member) =>
      member.args.some((argument) => /openkit-as_|openshell-supervisor/iu.test(argument))
    )
  ) {
    throw new Error('Unit F blocked-create fixture is not fresh-empty.');
  }
  if (dockerd.state !== 'T') {
    const stopped = await ports.signalMember(dockerd, 'SIGSTOP');
    if (stopped.signalled !== true) {
      throw new Error('Unit F dockerd stop was not delivered.');
    }
    const stoppedEpoch = await ports.readEpoch();
    const stoppedDockerd = selectEpochMember(stoppedEpoch, 'dockerd');
    if (
      stoppedEpoch.invocationId !== epoch.invocationId ||
      stoppedEpoch.bootId !== epoch.bootId ||
      stoppedDockerd.pid !== dockerd.pid ||
      stoppedDockerd.starttime !== dockerd.starttime ||
      stoppedDockerd.state !== 'T'
    ) {
      throw new Error('Unit F dockerd stop changed the epoch identity.');
    }
    epoch = stoppedEpoch;
    nanohost = selectEpochMember(epoch, 'nanohost');
    gateway = selectEpochMember(epoch, 'gateway');
    dockerd = stoppedDockerd;
  }
  try {
    const cursor = await ports.readJournalCursor();
    const task = await ports.startTask(scenarioId);
    const lineage = await ports.resolveLineage(task);
    if (!lineage) throw new Error('Unit F blocked-create Task lineage is unavailable.');
    const ownerBefore = await waitForSequencedOwnerSnapshot(
      ports,
      lineage,
      (snapshot) => snapshot.leases?.length === 1 && snapshot.backends?.length === 1
    );
    const owner = requireBlockedCreateLiveOwner(
      ownerBefore,
      lineage,
      priorTarget.connectionGeneration
    );
    const tuple = owner.tuple;
    const fixture = {
      backendSessionId: tuple.backend.backendSessionId,
      cursor,
      dockerd,
      epoch,
      gateway,
      lineage,
      nanohost,
      target: priorTarget,
    };
    const observeBarrier = async () => {
      const journal = await ports.readJournal({
        afterCursor: cursor,
        invocationId: epoch.invocationId,
      });
      return inspectNanoHostBlockedCreateObservation({
        current: await ports.readEpoch(),
        entries: journal.entries,
        fixture,
        target: await ports.readRuntimeTarget(),
      });
    };
    const barrier = await ports.waitFor(observeBarrier);
    await ports.pause(1_000);
    const confirmed = await ports.waitFor(observeBarrier);
    if (
      confirmed.effectRequestHash !== barrier.effectRequestHash ||
      confirmed.sandboxHash !== barrier.sandboxHash
    ) {
      throw new Error('Unit F blocked-create barrier changed before fault delivery.');
    }
    requireSameBlockedCreateOwner(await ports.readOwnerSnapshot(lineage), lineage, owner);
    const faultMember =
      scenarioId === 'F2'
        ? selectEpochMember(epoch, 'nanohost')
        : scenarioId === 'F4'
          ? gateway
          : null;
    const faultTarget = faultMember
      ? digest(
          JSON.stringify({
            exe: faultMember.exe,
            netns: faultMember.netns,
            pid: faultMember.pid,
            starttime: faultMember.starttime,
          })
        )
      : digest(
          JSON.stringify({
            bootId: epoch.bootId,
            container: ports.nanoCoreContainer,
            target: 'execution-server',
          })
        );
    if (scenarioId === 'F3') {
      const container = await ports.readNanoCoreContainer();
      if (container.restart !== 'no' || container.running !== true) {
        throw new Error('Unit F F3 requires one running restart=no NanoCore container.');
      }
      await ports.rebootHost();
    } else {
      const killed = await ports.signalMember(faultMember, 'SIGKILL');
      if (killed.signalled !== true) {
        throw new Error(`Unit F ${scenarioId} exact fault signal was not delivered.`);
      }
    }
    if (scenarioId === 'F3') {
      await ports.waitTunnelDisconnect();
      await ports.stopTunnel();
      await ports.waitSsh();
      const rebootedEpoch = await ports.readEpoch();
      if (
        rebootedEpoch.bootId === epoch.bootId ||
        rebootedEpoch.activeState === 'active' ||
        rebootedEpoch.members.length !== 0
      ) {
        throw new Error('Unit F F3 did not observe a fresh host boot with NanoHost stopped.');
      }
      const container = await ports.readNanoCoreContainer();
      if (container.restart !== 'no' || container.running !== false) {
        throw new Error('Unit F F3 NanoCore restarted without explicit recovery.');
      }
      await ports.startNanoCore();
      await ports.startTunnel();
      await waitForSequencedRuntimeTarget(
        ports,
        (target) =>
          target.connectionGeneration >= priorTarget.connectionGeneration &&
          target.predecessorFenced === true &&
          target.ready === false &&
          target.freshEmpty === false
      );
      const coreOnlyEpoch = await ports.readEpoch();
      if (
        coreOnlyEpoch.bootId !== rebootedEpoch.bootId ||
        coreOnlyEpoch.activeState === 'active' ||
        coreOnlyEpoch.members.length !== 0
      ) {
        throw new Error('Unit F F3 started NanoHost before the Core-only nonready proof.');
      }
    }
    await proveSequencedEpochAbsent(ports, epoch);
    await waitForSequencedRuntimeTarget(
      ports,
      (target) =>
        target.connectionGeneration >= priorTarget.connectionGeneration &&
        target.predecessorFenced === true &&
        target.ready === false &&
        target.freshEmpty === false
    );
    if ((await ports.readTurn(lineage))?.status === 'completed') {
      throw new Error(`Unit F ${scenarioId} Turn completed before fresh recovery.`);
    }
    const recovered = await recoverFreshEpochSequence(
      ports,
      priorTarget.connectionGeneration,
      epoch,
      lineage,
      scenarioId === 'F3'
    );
    await proveSequencedPriorRootsRemoved(ports, epoch);
    await ports.interruptTurn(lineage);
    await proveSequencedTurnCleanup(ports, lineage);
    await ports.runDockerSmoke();
    return {
      lineage: {
        agentSessionId: lineage.agentSessionId,
        backendSessionId: tuple.backend.backendSessionId,
        leaseId: tuple.lease.leaseId,
        turnId: lineage.turnId,
      },
      proof: {
        ...epochProof(epoch),
        effectRequest: barrier.effectRequestHash,
        faultTarget,
        fenceGeneration: recovered.fenceGeneration,
        instrument: ports.instrumentDigest,
        priorGeneration: priorTarget.connectionGeneration,
        sandbox: barrier.sandboxHash,
        successorGeneration: recovered.target.connectionGeneration,
      },
    };
  } catch (error) {
    try {
      await ports.stopNanoHost();
      await proveSequencedEpochAbsent(ports, epoch);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Unit F scenario failed and fail-stop cleanup also failed.'
      );
    }
    throw error;
  }
}

/** Sequences the Aggregate-owned ordinary stop/start lifecycle from raw facts. */
export async function sequenceNanoHostNormalLifecycle(ports) {
  try {
    await ports.runDockerSmoke();
    const baseline = await ports.readBaseline();
    const initialTarget = await waitForSequencedRuntimeTarget(
      ports,
      (target) =>
        Number.isSafeInteger(target.connectionGeneration) &&
        target.predecessorFenced === true &&
        target.ready === true &&
        target.freshEmpty === true
    );
    const initialEpoch = await ports.readEpoch();
    await ports.stopNanoHost();
    await proveSequencedEpochAbsent(ports, initialEpoch);
    if ((await ports.readBaseline()).digest !== baseline.digest) {
      throw new Error('Unit F ordinary stopped baseline changed system Docker.');
    }
    const ordinary = await recoverFreshEpochSequence(
      ports,
      initialTarget.connectionGeneration,
      initialEpoch
    );
    await proveSequencedPriorRootsRemoved(ports, initialEpoch);
    await ports.stopNanoHost();
    await proveSequencedEpochAbsent(ports, ordinary.epoch);
    if ((await ports.readBaseline()).digest !== baseline.digest) {
      throw new Error('Unit F ordinary lifecycle changed the normalized baseline.');
    }
    const finalFresh = await recoverFreshEpochSequence(
      ports,
      ordinary.target.connectionGeneration,
      ordinary.epoch
    );
    await proveSequencedPriorRootsRemoved(ports, ordinary.epoch);
    await ports.runDockerSmoke();
    const finalBaseline = await ports.readBaseline();
    if (finalBaseline.digest !== baseline.digest || finalFresh.target.ready !== true) {
      throw new Error('Unit F final fresh start changed system Docker.');
    }
    return true;
  } finally {
    await ports.startNanoHost();
  }
}

/** Binds the closed sequence ports to the existing A1 owners. */
function bindNanoHostUnitFSequencePorts(config) {
  return {
    instrumentDigest: config.instrumentDigest,
    nanoCoreContainer: config.nanoCoreContainer,
    nanoCoreImageId: config.nanoCoreImageId,
    nanoCoreImageRef: config.nanoCoreImageRef,
    interruptTurn: (lineage) => interruptFaultTask(config, lineage),
    killNanoCore: () =>
      runSudo(config.execute, config.sshAlias, [
        '/usr/bin/docker',
        'kill',
        '--signal=KILL',
        config.nanoCoreContainer,
      ]),
    pause: config.pause,
    readBaseline: () => captureA1Baseline(config),
    readEpoch: () => readEpochMembers(config),
    readEpochEffects: async (epoch) => {
      await waitForEpochEffectsAbsent(config, epoch);
      return { absent: true };
    },
    readJournal: async ({ afterCursor, invocationId, pid } = {}) => {
      const journal = await runSudo(config.execute, config.sshAlias, [
        '/usr/bin/journalctl',
        ...(invocationId ? [`_SYSTEMD_INVOCATION_ID=${invocationId}`] : []),
        ...(Number.isSafeInteger(pid) ? [`_PID=${pid}`] : []),
        ...(afterCursor ? ['--after-cursor', afterCursor] : []),
        '-o',
        'json',
        '--no-pager',
      ]);
      return {
        entries: journal.stdout
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
        text: journal.stdout,
      };
    },
    readJournalCursor: () => readJournalCursor(config),
    readNanoCoreContainer: async () =>
      parseCommandJson(
        await runSudo(config.execute, config.sshAlias, [
          '/usr/bin/docker',
          'inspect',
          '--format',
          '{"restart":"{{.HostConfig.RestartPolicy.Name}}","running":{{.State.Running}}}',
          config.nanoCoreContainer,
        ])
      ),
    readOwnerSnapshot: (lineage) => readNanoCoreOwnerSnapshot(config, lineage),
    readPriorRoots: async (epoch) => {
      await waitForPriorEpochRootsRemoved(config, epoch);
      return { absent: true };
    },
    readRuntimeTarget: () => readRuntimeTarget(config),
    readTurn: (lineage) =>
      appRequest(
        config,
        'GET',
        `/api/workspaces/${lineage.workspaceId}/threads/${lineage.threadId}/turns/${lineage.turnId}`,
        undefined,
        'product'
      ),
    rebootHost: () =>
      runSudo(config.execute, config.sshAlias, ['/usr/bin/systemctl', 'reboot']).catch(
        () => undefined
      ),
    resolveLineage: async (task) => {
      const lineage = await waitForTaskLineage(task);
      config.failureLineage = lineage;
      return lineage;
    },
    runDockerSmoke: () => runSystemDockerBuildNetworkSmoke(config),
    signalMember: (member, signal) => signalExactMember(config, member, signal),
    startNanoCore: () =>
      runSudo(config.execute, config.sshAlias, [
        '/usr/bin/docker',
        'start',
        config.nanoCoreContainer,
      ]),
    startNanoHost: () =>
      runSudo(config.execute, config.sshAlias, [
        '/usr/bin/systemctl',
        'start',
        'openkit-nanohost.service',
      ]),
    startTask: (scenarioId) => startRealTaskAttempt(config, scenarioId),
    startTunnel: () => config.tunnel.start(),
    stopNanoHost: () =>
      runSudo(config.execute, config.sshAlias, [
        '/usr/bin/systemctl',
        'stop',
        'openkit-nanohost.service',
      ]),
    stopTunnel: () => config.tunnel.stop(),
    waitFor: config.waitFor,
    waitSsh: () =>
      config.waitFor(
        () => runSsh(config.execute, config.sshAlias, ['/usr/bin/true']).then(() => true),
        300_000
      ),
    waitTunnelDisconnect: () => config.tunnel.waitForDisconnect(),
  };
}

/** Runs F1 through the existing Task, accessor, container, and transport owners. */
async function executeF1(config) {
  return sequenceNanoHostF1(bindNanoHostUnitFSequencePorts(config));
}

/** Runs one of F2-F4 from the same exact blocked-create fixture. */
async function executeBlockedCreateFault(config, scenarioId) {
  return sequenceNanoHostBlockedCreate(scenarioId, bindNanoHostUnitFSequencePorts(config));
}

/** Runs the Aggregate-owned ordinary stop/start lifecycle and final fresh start. */
async function verifyA1NormalLifecycle(config) {
  return sequenceNanoHostNormalLifecycle(bindNanoHostUnitFSequencePorts(config));
}

/**
 * Creates the real A1 driver boundary.
 *
 * SSH targets remain explicit, host identity is delegated to `assert.sh`, and
 * every effect stays behind the existing Task/App API, systemd/cgroup, journal,
 * and built NanoCore accessor owners.
 */
export function createDefaultDriver(options) {
  const env = options.env ?? process.env;
  const sshAlias = options.sshAlias ?? env.OPENKIT_NHC_UNIT_F_SSH_ALIAS ?? '';
  const hostManifestDigest =
    options.hostManifestDigest ?? env.OPENKIT_L6_TASK_HOST_MANIFEST_DIGEST ?? '';
  const nanoCoreContainer =
    options.nanoCoreContainer ?? env.OPENKIT_NHC_UNIT_F_NANOCORE_CONTAINER ?? '';
  const nanoCoreImageId = options.nanoCoreImageId ?? env.OPENKIT_NHC_UNIT_F_NANOCORE_IMAGE_ID ?? '';
  const nanoCoreImageRef =
    options.nanoCoreImageRef ?? env.OPENKIT_NHC_UNIT_F_NANOCORE_IMAGE_REF ?? '';
  const nanoCoreDataRoot = '/data/openkit';
  const localPort = Number(options.localPort ?? env.OPENKIT_NHC_UNIT_F_LOCAL_PORT ?? '');
  const remoteNanoCorePort = Number(
    options.remoteNanoCorePort ?? env.OPENKIT_NHC_UNIT_F_NANOCORE_PORT ?? ''
  );
  const token = options.token ?? env.OPENKIT_NANOCORE_TOKEN;
  const sessionCookie = options.sessionCookie ?? env.OPENKIT_NANOCORE_SESSION_COOKIE;
  const nanoHostIdentityId =
    options.nanoHostIdentityId ?? env.OPENKIT_HOST_NANOHOST_IDENTITY_ID ?? '';
  const nanoHostDeploymentId =
    options.nanoHostDeploymentId ?? env.OPENKIT_HOST_NANOHOST_DEPLOYMENT_ID ?? '';
  const nanoHostExecutableSha256 =
    options.nanoHostExecutableSha256 ?? env.OPENKIT_NHC_UNIT_F_NANOHOST_EXECUTABLE_SHA256 ?? '';
  const gitUrl = options.gitUrl ?? env.OPENKIT_L6_TASK_GIT_URL ?? '';
  const gitCommit = options.gitCommit ?? env.OPENKIT_L6_TASK_GIT_COMMIT ?? '';

  if (!sshAliasPattern.test(sshAlias)) {
    throw new Error('Unit F requires one explicit valid A1 SSH alias.');
  }
  if (!digest64Pattern.test(hostManifestDigest)) {
    throw new Error('Unit F requires the exact asserted host-manifest digest.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(nanoCoreContainer)) {
    throw new Error('Unit F requires the exact NanoCore container identity for F1.');
  }
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(nanoCoreImageId) ||
    nanoCoreImageRef.startsWith('sha256:') ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(nanoCoreImageRef)
  ) {
    throw new Error(
      'Unit F requires the admitted NanoCore image ID and one Dockerfile-resolvable image reference.'
    );
  }
  if (
    !Number.isSafeInteger(localPort) ||
    localPort < 1 ||
    localPort > 65_535 ||
    !Number.isSafeInteger(remoteNanoCorePort) ||
    remoteNanoCorePort < 1 ||
    remoteNanoCorePort > 65_535
  ) {
    throw new Error('Unit F requires exact local-forward and remote NanoCore ports.');
  }
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('Unit F requires the existing server-admin App API credential.');
  }
  if (typeof sessionCookie !== 'string' || sessionCookie.trim() === '') {
    throw new Error('Unit F requires the existing product App API session.');
  }
  if (!nanoHostIdentityId || !nanoHostDeploymentId) {
    throw new Error('Unit F requires the configured NanoHost identity and deployment.');
  }
  if (!digest64Pattern.test(nanoHostExecutableSha256)) {
    throw new Error('Unit F requires the exact installed NanoHost executable SHA-256.');
  }
  let parsedGitUrl;
  try {
    parsedGitUrl = new URL(gitUrl);
  } catch {
    parsedGitUrl = null;
  }
  if (
    !parsedGitUrl ||
    parsedGitUrl.protocol !== 'https:' ||
    parsedGitUrl.username ||
    parsedGitUrl.password ||
    parsedGitUrl.search ||
    parsedGitUrl.hash ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(gitCommit)
  ) {
    throw new Error('Unit F requires one credential-free exact remote Git source.');
  }
  const config = {
    execute: options.runCommand ?? runCommand,
    gitCommit,
    gitUrl,
    hostManifestDigest,
    instrumentDigest: options.instrumentDigest,
    localPort,
    nanoCoreContainer,
    nanoCoreDataRoot,
    nanoCoreImageId,
    nanoCoreImageRef,
    nanoHostDeploymentId,
    nanoHostExecutablePath: null,
    nanoHostExecutableProved: false,
    nanoHostExecutableSha256,
    nanoHostIdentityId,
    remoteNanoCorePort,
    request: options.requestJson,
    pause: options.delay ?? delay,
    sessionCookie,
    sshAlias,
    token,
    waitFor: options.waitForObservation ?? waitForObservation,
    workerImageRef: options.workerImageRef,
    failureWorkspaceId: null,
  };
  config.tunnel = options.tunnel ?? createNanoCoreTunnel(config);
  return {
    captureBaseline: async () => captureA1Baseline(config),
    executeScenarioEffect: async ({ scenarioId }) => {
      if (!scenarioIds.includes(scenarioId)) {
        throw new Error('Unit F default driver scenario identity is invalid.');
      }
      config.failureLineage = null;
      config.failureWorkspaceId = null;
      try {
        await config.tunnel.start();
        return await (scenarioId === 'F1'
          ? executeF1(config)
          : executeBlockedCreateFault(config, scenarioId));
      } catch (error) {
        const runtimeEvidence = config.failureLineage
          ? await readTurnRuntimeEvidence(config, config.failureLineage).catch(() => [])
          : config.failureWorkspaceId
            ? await readWorkspaceRuntimeEvidence(config, config.failureWorkspaceId).catch(() => [])
            : [];
        if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
          failureEvidenceByError.set(error, { runtimeEvidence, scenarioId });
        }
        throw error;
      } finally {
        await config.tunnel.stop();
      }
    },
    verifyNormalLifecycleEffect: async () => {
      try {
        await config.tunnel.start();
        return await verifyA1NormalLifecycle(config);
      } finally {
        await config.tunnel.stop();
      }
    },
  };
}

/** Validates retained public identity, including the caller-asserted source commit. */
function publicIdentity(options) {
  const runtimeIdentity = [
    options.nanoCoreImageId,
    options.nanoCoreImageRef,
    options.nanoHostExecutableSha256,
  ];
  const identity = {
    hostManifestDigest: options.hostManifestDigest,
    productCommit: options.productCommit,
    sshAlias: options.sshAlias,
    workerImageRef: options.workerImageRef,
    ...(runtimeIdentity.every((value) => value !== undefined)
      ? {
          nanoCoreImageId: options.nanoCoreImageId,
          nanoCoreImageRef: options.nanoCoreImageRef,
          nanoHostExecutableSha256: options.nanoHostExecutableSha256,
        }
      : {}),
  };
  if (!sshAliasPattern.test(identity.sshAlias ?? '')) {
    throw new Error('Unit F SSH alias is invalid.');
  }
  if (!digest64Pattern.test(identity.hostManifestDigest ?? '')) {
    throw new Error('Unit F host-manifest digest is invalid.');
  }
  if (!digest40Pattern.test(identity.productCommit ?? '')) {
    throw new Error('Unit F product commit is invalid.');
  }
  if (!workerImagePattern.test(identity.workerImageRef ?? '')) {
    throw new Error('Unit F worker image identity is invalid.');
  }
  if (
    runtimeIdentity.some((value) => value !== undefined) &&
    (!/^sha256:[a-f0-9]{64}$/u.test(options.nanoCoreImageId ?? '') ||
      options.nanoCoreImageRef?.startsWith('sha256:') ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(
        options.nanoCoreImageRef ?? ''
      ) ||
      !digest64Pattern.test(options.nanoHostExecutableSha256 ?? ''))
  ) {
    throw new Error('Unit F runtime byte identity is incomplete or invalid.');
  }
  if (typeof options.attemptId !== 'string' || options.attemptId.length === 0) {
    throw new Error('Unit F attempt identity is required.');
  }
  return identity;
}

/** Adjudicates one complete Unit F attempt without performing or retaining effects. */
export function adjudicateNanoHostUnitFResult({
  attemptId,
  identity: identityInput,
  instrumentDigest,
  normalLifecycleEvidence,
  scenarioEvidence,
}) {
  const identity = publicIdentity({ ...identityInput, attemptId });
  const expectedInstrument = digest64Pattern.test(instrumentDigest ?? '') ? instrumentDigest : null;
  if (
    !Array.isArray(scenarioEvidence) ||
    scenarioEvidence.length !== scenarioIds.length ||
    scenarioIds.some(
      (id) => scenarioEvidence.filter((candidate) => candidate?.id === id).length !== 1
    )
  ) {
    throw new Error('Unit F adjudication requires one exact evidence row per scenario.');
  }
  const scenarios = scenarioIds.map((id) => {
    const row = scenarioEvidence.find((candidate) => candidate.id === id);
    return adjudicateNanoHostUnitFScenario(
      id,
      row.evidence,
      row.preBaseline,
      row.postBaseline,
      expectedInstrument
    );
  });
  const normalLifecycle = adjudicateNormalLifecycle(normalLifecycleEvidence);
  return {
    aggregate: {
      id: 'Aggregate',
      normalLifecycle,
      scenarioIds: [...scenarioIds],
      status:
        scenarios.every(({ status }) => status === 'PASS') && normalLifecycle.status === 'PASS'
          ? 'PASS'
          : 'FAIL',
    },
    attemptLineageHash: digest(attemptId),
    identity,
    scenarios,
  };
}

/** Executes the fixed Unit F scenario order while retaining authority projections locally. */
export async function executeNanoHostUnitFCoordinator(driver) {
  const scenarioEvidence = [];
  for (const id of scenarioIds) {
    const preBaseline = await driver.captureBaseline();
    const raw = await driver.executeScenarioEffect({ scenarioId: id });
    const contract = scenarioContracts[id];
    const evidence = {
      action: { code: contract.action, observed: true },
      barrier: { code: contract.barrier, observed: true },
      cleanup: { code: contract.cleanup, observed: true },
      fault: { code: contract.fault, observed: true },
      lineage: raw?.lineage,
      proof: raw?.proof,
    };
    const postBaseline = await driver.captureBaseline();
    scenarioEvidence.push({ evidence, id, postBaseline, preBaseline });
  }
  await driver.verifyNormalLifecycleEffect();
  const normalLifecycleEvidence = Object.fromEntries(
    Object.entries(normalLifecycleContract).map(([name, code]) => [name, { code, observed: true }])
  );
  return { normalLifecycleEvidence, scenarioEvidence };
}

/** Runs the fixed real A1 driver and returns only independently adjudicated evidence. */
export async function runNanoHostUnitF(options = {}) {
  if (
    [
      options.captureBaseline,
      options.executeScenario,
      options.executeScenarioEffect,
      options.verifyNormalLifecycle,
      options.verifyNormalLifecycleEffect,
    ].some((callback) => callback !== undefined)
  ) {
    throw new Error('Unit F retained execution does not accept high-level driver callbacks.');
  }
  const instrumentDigest = digest(await readFile(fileURLToPath(import.meta.url)));
  const identity = publicIdentity(options);
  const driver = createDefaultDriver({ ...options, instrumentDigest });
  const { normalLifecycleEvidence, scenarioEvidence } =
    await executeNanoHostUnitFCoordinator(driver);
  return adjudicateNanoHostUnitFResult({
    attemptId: options.attemptId,
    identity,
    instrumentDigest,
    normalLifecycleEvidence,
    scenarioEvidence,
  });
}

/** Projects the explicit environment inputs required by the real A1 operator. */
function optionsFromEnvironment(env) {
  return {
    attemptId: env.OPENKIT_NHC_UNIT_F_ATTEMPT_ID ?? '',
    env,
    gitCommit: env.OPENKIT_L6_TASK_GIT_COMMIT ?? '',
    gitUrl: env.OPENKIT_L6_TASK_GIT_URL ?? '',
    hostManifestDigest: env.OPENKIT_L6_TASK_HOST_MANIFEST_DIGEST ?? '',
    localPort: env.OPENKIT_NHC_UNIT_F_LOCAL_PORT ?? '',
    nanoCoreContainer: env.OPENKIT_NHC_UNIT_F_NANOCORE_CONTAINER ?? '',
    nanoCoreImageId: env.OPENKIT_NHC_UNIT_F_NANOCORE_IMAGE_ID ?? '',
    nanoCoreImageRef: env.OPENKIT_NHC_UNIT_F_NANOCORE_IMAGE_REF ?? '',
    nanoHostDeploymentId: env.OPENKIT_HOST_NANOHOST_DEPLOYMENT_ID ?? '',
    nanoHostExecutableSha256: env.OPENKIT_NHC_UNIT_F_NANOHOST_EXECUTABLE_SHA256 ?? '',
    nanoHostIdentityId: env.OPENKIT_HOST_NANOHOST_IDENTITY_ID ?? '',
    productCommit: env.OPENKIT_L6_TASK_PRODUCT_COMMIT ?? '',
    remoteNanoCorePort: env.OPENKIT_NHC_UNIT_F_NANOCORE_PORT ?? '',
    sessionCookie: env.OPENKIT_NANOCORE_SESSION_COOKIE,
    sshAlias: env.OPENKIT_NHC_UNIT_F_SSH_ALIAS ?? '',
    token: env.OPENKIT_NANOCORE_TOKEN,
    workerImageRef: env.OPENKIT_L6_TASK_WORKER_IMAGE_REF ?? '',
  };
}

/** Returns one redacted fail-closed result when the real driver cannot complete. */
function failedRunResult(options, failure = null) {
  return {
    aggregate: {
      id: 'Aggregate',
      normalLifecycle: {
        observations: { ...normalLifecycleContract },
        status: 'FAIL',
      },
      scenarioIds: [...scenarioIds],
      status: 'FAIL',
    },
    attemptLineageHash:
      typeof options.attemptId === 'string' && options.attemptId.length > 0
        ? digest(options.attemptId)
        : null,
    failure,
    identity: null,
    scenarios: [],
  };
}

/** Runs the real operator entrypoint and retains only redacted adjudicated JSON. */
async function runCli(env) {
  const outputPath = env.OPENKIT_NHC_UNIT_F_OUTPUT_PATH ?? '';
  if (!isAbsolute(outputPath)) {
    process.stdout.write('aggregate=FAIL evidenceSha256=none\n');
    process.exitCode = 1;
    return;
  }
  const options = optionsFromEnvironment(env);
  let result;
  try {
    result = await runNanoHostUnitF(options);
  } catch (error) {
    const failure =
      error !== null && (typeof error === 'object' || typeof error === 'function')
        ? (failureEvidenceByError.get(error) ?? null)
        : null;
    result = failedRunResult(options, failure);
  }
  const bytes = `${JSON.stringify(result, null, 2)}\n`;
  const evidenceSha256 = digest(bytes);
  try {
    await writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 });
  } catch {
    process.stdout.write('aggregate=FAIL evidenceSha256=none\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`aggregate=${result.aggregate.status} evidenceSha256=${evidenceSha256}\n`);
  if (result.aggregate.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli(process.env);
}
