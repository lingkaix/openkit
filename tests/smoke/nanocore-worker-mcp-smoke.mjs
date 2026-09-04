import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect as connectHttp2 } from 'node:http2';
import { createRequire } from 'node:module';
import { connect as connectTcp, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { seedDemoWorkspaceAuthority, seedDemoWorkspaceDataRoot } from '../support/demo-data.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const smokeRequestId = '0190f4c8-0000-7000-8000-000000000601';
const integrationHeader = 'x-openkit-integration-binding';
const smokeAdjudicationTimeoutMs = 5_000;

class SmokeAdjudicationTimeout extends Error {}

/** Runs one public Task through the built NanoCore, native NanoHost carriage, and a real SDK MCP client. */
async function main() {
  const appPort = await findOpenPort();
  let nanoHostPort = await findOpenPort();
  while (nanoHostPort === appPort) nanoHostPort = await findOpenPort();
  const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-worker-mcp-smoke-'));
  const repositoryPath = await mkdtemp(join(tmpdir(), 'openkit-worker-mcp-repository-'));
  const callFile = join(repositoryPath, 'mcp-calls.txt');
  let child;
  let h2;
  let mcpServerPid = null;
  const observation = {};

  try {
    await seedFixture(dataRoot, repositoryPath, callFile, nanoHostPort);
    const nanoHostSecret = await issueNanoHostToken(dataRoot);
    const env = {
      ...process.env,
      OPENKIT_BIND_HOST: '127.0.0.1',
      OPENKIT_CORE_MODE: 'local',
      OPENKIT_DATA_ROOT: dataRoot,
      PORT: String(appPort),
    };
    delete env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;
    child = spawn(process.execPath, [join(repoRoot, 'apps/nanocore/dist/index.js')], {
      cwd: join(repoRoot, 'apps/nanocore'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = captureOutput(child);
    const baseUrl = `http://127.0.0.1:${appPort}`;
    await waitForHttp(`${baseUrl}/api/health`, child, output);

    h2 = connectHttp2(`http://127.0.0.1:${nanoHostPort}`);
    const h2Closed = new Promise((resolveClose) => h2.once('close', resolveClose));
    await waitForH2Connect(h2, child, output);
    const admission = await requestHttp2(
      h2,
      'POST',
      '/api/nanohost/transport/session/admit',
      '{}',
      { authorization: `Bearer ${nanoHostSecret}`, 'content-type': 'application/json' }
    );
    assert.equal(admission.status, 200, responseFailure('NanoHost admission', admission));
    const admissionProjection = pickJson(admission, ['mayCarryWork', 'role']);
    assert.deepEqual(admissionProjection, {
      mayCarryWork: true,
      role: 'authoritative',
    });
    const readiness = await requestHttp2(
      h2,
      'POST',
      '/api/nanohost/transport/session/readiness',
      '{}',
      { 'content-type': 'application/json' }
    );
    assert.equal(readiness.status, 204, responseFailure('NanoHost readiness', readiness));

    const repository = await fetch(`${baseUrl}/api/app/workspaces/ws_demo/repositories/default`, {
      body: JSON.stringify({
        displayName: 'Worker MCP smoke repository',
        localPath: repositoryPath,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    });
    assert.equal(repository.status, 200, await repository.text());

    let taskFailure = null;
    const taskPromise = fetch(`${baseUrl}/api/app/workspaces/ws_demo/threads/th_demo/task`, {
      body: JSON.stringify({
        input: 'Implement the MCP verification by calling the echo tool.',
        requestId: smokeRequestId,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    void taskPromise.then(
      async (response) => {
        if (response.status !== 202) {
          taskFailure = new Error(
            `Public Task returned ${response.status}: ${await response.text()}`
          );
        }
      },
      (error) => {
        taskFailure = error;
      }
    );

    const image = await waitForEffect(h2, 'image.acquire', child, output, () => taskFailure);
    assert.equal(image.command.imageReference, 'openkit/worker-codex:dev');
    await settleJsonEffect(h2, 'image.acquire', {
      digest: `sha256:${'a'.repeat(64)}`,
      requestId: image.command.requestId,
    });
    const sandbox = await waitForEffect(h2, 'sandbox.create', child, output, () => taskFailure);
    const sandboxId = requireString(sandbox.command.sandboxId, 'Sandbox id');
    await settleJsonEffect(h2, 'sandbox.create', {
      requestId: sandbox.command.requestId,
      sandboxId,
      state: 'created',
    });

    let environmentPackage = null;
    let importCount = 0;
    let integrationBindingRef = null;
    const startupDeadline = Date.now() + 30_000;
    while (!integrationBindingRef && Date.now() < startupDeadline) {
      assertProcessRunning(child, output, taskFailure);
      const imported = await pollEffect(h2, 'reference.import');
      if (imported.status === 200) {
        importCount += 1;
        const metadata = verifyImportedFile(imported);
        if (metadata.slot === 'package-config' && metadata.relativePath === 'package.json') {
          environmentPackage = JSON.parse(imported.bodyBytes.toString('utf8'));
        }
        const settled = await requestHttp2(
          h2,
          'POST',
          '/api/nanohost/transport/effects/reference.import/result',
          JSON.stringify({
            byteLength: imported.bodyBytes.byteLength,
            reference: `sandbox://${sandboxId}/${metadata.slot}/${metadata.relativePath}`,
            requestId: metadata.requestId,
          }),
          { 'content-type': 'application/json' }
        );
        assert.equal(settled.status, 204, responseFailure('reference.import result', settled));
        continue;
      }
      assert.equal(imported.status, 204, responseFailure('reference.import poll', imported));
      const bridge = await pollEffect(h2, 'bridge.open');
      if (bridge.status === 200) {
        const command = parseJson(bridge, 'bridge.open command');
        integrationBindingRef = requireString(
          command.sandboxIntegrationBindingRef,
          'Sandbox Integration binding'
        );
        await settleJsonEffect(h2, 'bridge.open', {
          accepted: true,
          integrationReady: true,
          requestId: command.requestId,
          state: 'open',
        });
      } else {
        assert.equal(bridge.status, 204, responseFailure('bridge.open poll', bridge));
        await sleep(10);
      }
    }
    assert.ok(integrationBindingRef, 'NanoHost bridge.open was not dispatched.');
    assert.ok(importCount >= 1, 'NanoHost did not import the canonical AEP.');
    assert.ok(environmentPackage, 'NanoHost did not import package-config/package.json.');

    const harnessOperations = [];
    const opened = await waitForHarnessOperation(
      h2,
      integrationBindingRef,
      'session.open',
      child,
      output,
      () => taskFailure
    );
    harnessOperations.push(opened.operation);
    await settleHarness(h2, integrationBindingRef, opened, {
      maxActiveTurns: 1,
      nativeHandleDigest: null,
      nativeHandleState: 'pending',
      state: 'open',
    });
    const started = await waitForHarnessOperation(
      h2,
      integrationBindingRef,
      'turn.start',
      child,
      output,
      () => taskFailure
    );
    harnessOperations.push(started.operation);
    await settleHarness(h2, integrationBindingRef, started, {
      nativeHandleDigest: null,
      nativeHandleState: 'pending',
      state: 'started',
    });

    const capabilityToken = requireString(started.body.capabilityToken, 'Capability token');
    const workerControlToken = requireString(
      started.body.workerControlToken,
      'Worker-control token'
    );
    const inferenceToken = requireString(started.body.inferenceToken, 'Inference token');
    const distinctTokenCount = new Set([capabilityToken, workerControlToken, inferenceToken]).size;
    assert.equal(distinctTokenCount, 3);
    assert.equal(started.body.packageSnapshotId, environmentPackage.snapshotId);
    assert.equal(started.body.turnId, environmentPackage.scope.turnId);
    const lineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };
    const heartbeat = await requestHttp2(
      h2,
      'POST',
      '/worker-control/heartbeat',
      JSON.stringify({
        body: {
          message: null,
          processKeyHash: createHash('sha256').update('worker-mcp-smoke').digest('base64url'),
          status: 'starting',
        },
        lineage,
        operation: 'heartbeat',
        schemaVersion: 1,
        sequence: 0,
      }),
      { authorization: `Bearer ${workerControlToken}`, 'content-type': 'application/json' }
    );
    assert.equal(heartbeat.status, 200, responseFailure('Worker heartbeat', heartbeat));

    const { Client, StreamableHTTPClientTransport } = await loadMcpSdk();
    const mcpClient = new Client({ name: 'openkit-built-worker-mcp-smoke', version: '1.0.0' });
    try {
      await mcpClient.connect(
        new StreamableHTTPClientTransport(new URL('http://nanocore.test/capabilities/mcp/echo'), {
          fetch: h2Fetch(h2),
          requestInit: { headers: { authorization: `Bearer ${capabilityToken}` } },
        })
      );
      const tools = await mcpClient.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      assert.deepEqual(toolNames, ['echo']);
      const result = await mcpClient.callTool({
        arguments: { message: 'l5-packaged' },
        name: 'echo',
      });
      assert.deepEqual(result.content, [{ text: 'l5-packaged', type: 'text' }]);
      assert.equal(result.structuredContent?.message, 'l5-packaged');
      mcpServerPid = Number(result.structuredContent?.pid);
      assert.ok(Number.isSafeInteger(mcpServerPid) && mcpServerPid > 0, 'MCP stub pid is invalid.');
      observation.toolNames = toolNames;
      observation.toolContent = result.content;
      observation.toolMessage = result.structuredContent?.message;
    } finally {
      await mcpClient.close();
    }
    const callLog = (await readFile(callFile, 'utf8')).trim().split('\n');
    assert.deepEqual(callLog, ['l5-packaged']);

    const terminalBody = {
      evidenceManifestDigests: {},
      status: 'completed',
      stopReason: 'completed',
    };
    const terminalBytes = Buffer.from(
      `${JSON.stringify({
        event: { data: terminalBody, type: 'turn.completed' },
        kind: 'event',
        lineage,
        schemaVersion: 1,
        sequence: 1,
      })}\n`
    );
    const finalStatus = await requestHttp2(
      h2,
      'POST',
      '/worker-control/final-status',
      JSON.stringify({
        body: terminalBody,
        lineage,
        operation: 'final_status',
        schemaVersion: 1,
        sequence: 1,
      }),
      { authorization: `Bearer ${workerControlToken}`, 'content-type': 'application/json' }
    );
    assert.equal(finalStatus.status, 200, responseFailure('Worker final status', finalStatus));

    const inspected = await waitForHarnessOperation(
      h2,
      integrationBindingRef,
      'session.inspect',
      child,
      output,
      () => taskFailure
    );
    harnessOperations.push(inspected.operation);
    await settleHarness(h2, integrationBindingRef, inspected, {
      childState: 'absent',
      cleanupState: 'clean',
      nativeHandleDigest: null,
      nativeHandleState: 'pending',
      state: 'open',
    });

    const exports = [];
    let closed = false;
    const closeDeadline = Date.now() + 30_000;
    while (!closed && Date.now() < closeDeadline) {
      assertProcessRunning(child, output, taskFailure);
      const exported = await pollEffect(h2, 'file.export');
      if (exported.status === 200) {
        const command = parseJson(exported, 'file.export command');
        exports.push({ presence: command.presence, relativePath: command.relativePath });
        if (command.presence === 'optional') {
          await settleJsonEffect(h2, 'file.export', {
            requestId: command.requestId,
            state: 'absent',
          });
        } else {
          assert.equal(command.presence, 'required');
          const bytes = String(command.relativePath).endsWith('events.jsonl')
            ? terminalBytes
            : Buffer.alloc(0);
          await settleFileExport(h2, command, bytes);
        }
        continue;
      }
      assert.equal(exported.status, 204, responseFailure('file.export poll', exported));
      const nextHarness = await pollHarness(h2, integrationBindingRef);
      if (nextHarness.status === 200) {
        const command = parseJson(nextHarness, 'session.close command');
        assert.equal(command.operation, 'session.close');
        harnessOperations.push(command.operation);
        await settleHarness(h2, integrationBindingRef, command, {
          childState: 'absent',
          privateState: 'absent',
          state: 'closed',
        });
        closed = true;
      } else {
        assert.equal(nextHarness.status, 204, responseFailure('Harness poll', nextHarness));
        await sleep(10);
      }
    }
    assert.ok(closed, 'NanoHost Harness session.close was not dispatched.');
    assert.deepEqual(harnessOperations, [
      'session.open',
      'turn.start',
      'session.inspect',
      'session.close',
    ]);
    assert.deepEqual(exports, [
      { presence: 'required', relativePath: 'events.jsonl' },
      { presence: 'required', relativePath: 'items.jsonl' },
      { presence: 'required', relativePath: 'artifacts.jsonl' },
    ]);

    const taskResponse = await taskPromise;
    const task = await taskResponse.json();
    assert.equal(taskResponse.status, 202, JSON.stringify(task));
    assert.equal(task.state, 'completed');
    assert.equal(task.turn?.status, 'completed');
    assert.equal(task.turn?.humanGate, null);
    assert.equal(task.turn?.id, environmentPackage.scope.turnId);

    await stopProcess(child);
    await Promise.race([
      h2Closed,
      sleep(5_000).then(() => {
        throw new Error('NanoHost HTTP/2 connection did not close with NanoCore.');
      }),
    ]);
    await waitForProcessExit(mcpServerPid);
    await assertPortClosed(nanoHostPort);
    const terminal = await settleSmokeAdjudication(async () => ({
      admission: admissionProjection,
      callLog,
      cleanup: { h2Closed: true, listenerClosed: true, mcpProcessExited: true },
      distinctTokenCount,
      durable: await readDurableOutcome(dataRoot, task.turn.id),
      environmentPackagePresent: environmentPackage !== null,
      exports,
      harnessOperations,
      imageReference: image.command.imageReference,
      importObserved: importCount >= 1,
      readinessStatus: readiness.status,
      targetObservable: existsSync(dataRoot),
      task: {
        humanGate: task.turn?.humanGate,
        httpStatus: taskResponse.status,
        state: task.state,
        turnMatchesPackage: task.turn?.id === environmentPackage.scope.turnId,
        turnStatus: task.turn?.status,
      },
      toolContent: observation.toolContent,
      toolMessage: observation.toolMessage,
      toolNames: observation.toolNames,
    }));
    if (terminal.status !== 'pass') throw terminal.error;
    console.log('OpenKit built public Task Worker MCP smoke PASS');
  } finally {
    h2?.destroy();
    if (child && child.exitCode === null && child.signalCode === null) {
      await stopProcess(child).catch(async () => {
        child.kill('SIGKILL');
        await new Promise((resolveExit) => child.once('exit', resolveExit));
      });
    }
    if (mcpServerPid) {
      try {
        process.kill(mcpServerPid, 'SIGKILL');
      } catch {}
    }
    await rm(repositoryPath, { force: true, recursive: true });
    await rm(dataRoot, { force: true, recursive: true });
    assert.equal(existsSync(repositoryPath), false);
    assert.equal(existsSync(dataRoot), false);
  }
}

/** Runs the shared finite smoke adjudicator against pass, failure, and timeout stand-ins. */
async function runHarnessAdmissionSelfCheck() {
  const standInRoot = await mkdtemp(join(tmpdir(), 'worker-tool-smoke-admission-'));
  const marker = join(standInRoot, 'observable');
  try {
    await writeFile(marker, 'stand-in remains observable');
    const passed = await settleSmokeAdjudication(async () => ({
      ...expectedSmokeObservation(),
      targetObservable: existsSync(marker),
    }));
    assert.equal(passed.status, 'pass');

    const failedObservation = structuredClone(expectedSmokeObservation());
    failedObservation.cleanup.listenerClosed = false;
    const failed = await settleSmokeAdjudication(async () => failedObservation);
    assert.equal(failed.status, 'fail');

    const timedOut = await settleSmokeAdjudication(() => new Promise(() => undefined), 25);
    assert.equal(timedOut.status, 'timeout');
    assert.equal(existsSync(marker), true);
    console.log('OpenKit Worker MCP smoke Harness Admission PASS');
  } finally {
    await rm(standInRoot, { force: true, recursive: true });
  }
}

/** Returns the complete normalized observation that the product smoke must match. */
function expectedSmokeObservation() {
  return {
    admission: { mayCarryWork: true, role: 'authoritative' },
    callLog: ['l5-packaged'],
    cleanup: { h2Closed: true, listenerClosed: true, mcpProcessExited: true },
    distinctTokenCount: 3,
    durable: {
      audit: [{ action: 'capability.finish', outcome: 'succeeded' }],
      backend: { state: 'cleaned', workspaceHandoffState: 'complete' },
      call: { itemIdValid: true, schemaSnapshotIdValid: true, status: 'succeeded' },
      item: { server: 'echo', status: 'completed', tool: 'echo', type: 'tool-call' },
      lease: { status: 'released' },
      permission: [{ enforcementPoint: 'worker_capability.mcp.call_tool', result: 'allow' }],
      schema: { catalogEntryId: 'echo', source: 'live', toolNames: ['echo'] },
      usage: [{ quantity: 1, unit: 'tool_calls' }],
    },
    environmentPackagePresent: true,
    exports: [
      { presence: 'required', relativePath: 'events.jsonl' },
      { presence: 'required', relativePath: 'items.jsonl' },
      { presence: 'required', relativePath: 'artifacts.jsonl' },
    ],
    harnessOperations: ['session.open', 'turn.start', 'session.inspect', 'session.close'],
    imageReference: 'openkit/worker-codex:dev',
    importObserved: true,
    readinessStatus: 204,
    targetObservable: true,
    task: {
      humanGate: null,
      httpStatus: 202,
      state: 'completed',
      turnMatchesPackage: true,
      turnStatus: 'completed',
    },
    toolContent: [{ text: 'l5-packaged', type: 'text' }],
    toolMessage: 'l5-packaged',
    toolNames: ['echo'],
  };
}

/** Converts one bounded observation into the smoke's shared terminal verdict. */
async function settleSmokeAdjudication(readObservation, timeoutMs = smokeAdjudicationTimeoutMs) {
  let timeout;
  try {
    const observation = await Promise.race([
      readObservation(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new SmokeAdjudicationTimeout('Worker MCP smoke adjudication timed out.')),
          timeoutMs
        );
      }),
    ]);
    assert.deepEqual(observation, expectedSmokeObservation());
    return { status: 'pass' };
  } catch (error) {
    return {
      error,
      status: error instanceof SmokeAdjudicationTimeout ? 'timeout' : 'fail',
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Writes the smallest production-valid config and repository inputs for the packaged lifecycle. */
async function seedFixture(dataRoot, repositoryPath, callFile, nanoHostPort) {
  seedDemoWorkspaceDataRoot(dataRoot);
  await mkdir(join(dataRoot, 'config', 'agents'), { recursive: true });
  await mkdir(join(dataRoot, 'config', 'providers'), { recursive: true });
  await writeJson(join(dataRoot, 'config', 'server.jsonc'), {
    defaults: { defaultAgentId: 'agent_codex_host' },
    mode: 'local',
    nanohost: {
      bind: { host: '127.0.0.1', port: nanoHostPort },
      credentialRef: 'nanohost-transport:worker-mcp-smoke',
      credentialSlots: {
        A: {
          companionPath: join(repositoryPath, 'transport-a.json'),
          secretPath: join(repositoryPath, 'transport-a.token'),
        },
        B: {
          companionPath: join(repositoryPath, 'transport-b.json'),
          secretPath: join(repositoryPath, 'transport-b.token'),
        },
      },
      deploymentId: 'deployment-worker-mcp-smoke',
      identityId: 'nanohost-worker-mcp-smoke',
      rendezvousUrl: `http://127.0.0.1:${nanoHostPort}`,
    },
    schemaVersion: 1,
  });
  await writeJson(join(dataRoot, 'config', 'gateway.jsonc'), {
    defaultLogicalModelId: 'openai/gpt-5.2',
    enabled: true,
    logicalModels: [
      {
        displayName: 'openai/gpt-5.2',
        id: 'openai/gpt-5.2',
        routes: [
          {
            id: 'smoke',
            providerModel: 'openai/gpt-5.2',
            providerProfileId: 'agent-openrouter',
          },
        ],
      },
    ],
    requiredFeatures: [],
    schemaVersion: 1,
  });
  await writeJson(join(dataRoot, 'config', 'providers', 'agent-openrouter.provider.jsonc'), {
    displayName: 'Agent OpenRouter',
    id: 'agent-openrouter',
    kind: 'local',
    models: ['openai/gpt-5.2'],
    vendor: 'openrouter',
  });
  await writeJson(join(dataRoot, 'config', 'agents', 'codex.agent.jsonc'), {
    defaultProfileId: 'default',
    displayName: 'Codex Agent',
    id: 'agent_codex_host',
    mcp: [{ id: 'echo' }],
    models: {
      allowedLogicalModelIds: ['openai/gpt-5.2'],
      preferredLogicalModelId: 'openai/gpt-5.2',
    },
    profiles: [{ id: 'default', instructionsRef: 'codex', mcp: [], skills: [] }],
    requiredFeatures: [],
    runtime: {
      adapter: 'codex',
      binaries: [
        { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
        { id: 'node', path: '/usr/local/bin/node' },
        { id: 'codex', path: '/usr/local/bin/codex' },
      ],
      image: { kind: 'reference', pullPolicy: 'if-not-present', ref: 'openkit/worker-codex:dev' },
      kind: 'codex',
      version: 'smoke',
    },
    sandbox: {
      backend: {
        allowedKinds: ['openshell'],
        preferred: 'openshell',
        requiredCapabilities: ['backend-local-inference'],
      },
      credentialDeclarations: [],
      filesystem: [],
      network: [],
    },
    schemaVersion: 1,
    skills: [],
  });
  await writeJson(join(dataRoot, 'workspaces', 'ws_demo', 'config', 'mcp-servers.jsonc'), {
    schemaVersion: 1,
    servers: [
      {
        allowedTools: ['echo'],
        approvalRequiredTools: [],
        credentialBindings: [],
        deniedTools: [],
        enabled: true,
        id: 'echo',
        pinnedSchemaSnapshotId: null,
        schemaPolicy: 'tracking',
        timeoutMs: 10_000,
        transport: {
          args: [join(repoRoot, 'apps/nanocore/src/test-support/mcp-stdio-stub.mjs'), callFile],
          command: process.execPath,
          environment: {},
          kind: 'stdio',
        },
      },
    ],
  });
  await writeFile(join(repositoryPath, 'README.md'), '# Worker MCP smoke\n');
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'smoke@openkit.local'],
    ['config', 'user.name', 'OpenKit Smoke'],
    ['add', 'README.md'],
    ['commit', '-qm', 'seed'],
  ]) {
    execFileSync('git', args, { cwd: repositoryPath, stdio: 'ignore' });
  }
  await seedDemoWorkspaceAuthority(dataRoot);
}

/** Issues the one temporary secret used only for native transport admission. */
async function issueNanoHostToken(dataRoot) {
  const [{ createNanoHostTransportTokenRecord }, { openCoreDb }] = await Promise.all([
    import('../../apps/nanocore/dist/auth/nanohost-transport-token-store.js'),
    import('../../apps/nanocore/dist/storage/db.js'),
  ]);
  const coreDb = openCoreDb(dataRoot);
  try {
    return createNanoHostTransportTokenRecord(coreDb, {
      deploymentId: 'deployment-worker-mcp-smoke',
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerNanoHostIdentityId: 'nanohost-worker-mcp-smoke',
      responsibleServerAdminActorId: 'user_local',
    }).secret;
  } finally {
    coreDb.sqlite.close();
  }
}

/** Reads the normalized durable call, policy, schema, audit, usage, Item, backend, and lease facts. */
async function readDurableOutcome(dataRoot, turnId) {
  const [{ FsStore }, { openCoreDb, openWorkspaceDb }] = await Promise.all([
    import('../../apps/nanocore/dist/lib/store.js'),
    import('../../apps/nanocore/dist/storage/db.js'),
  ]);
  const coreDb = openCoreDb(dataRoot);
  let backend;
  let lease;
  try {
    backend = coreDb.sqlite
      .prepare(
        `SELECT state, workspace_handoff_state AS workspaceHandoffState
         FROM worker_backend_sessions WHERE turn_id = ?`
      )
      .get(turnId);
    lease = coreDb.sqlite
      .prepare('SELECT status FROM scheduler_session_leases WHERE turn_id = ?')
      .get(turnId);
  } finally {
    coreDb.sqlite.close();
  }
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  let audit = [];
  let call = null;
  let permission = [];
  let schema = null;
  let usage = [];
  try {
    const calls = workspaceDb.sqlite
      .prepare(
        `SELECT call_id AS callId, item_id AS itemId, schema_snapshot_id AS schemaSnapshotId, status
         FROM capability_calls WHERE operation = 'mcp.call_tool'`
      )
      .all();
    if (calls.length === 1) {
      [call] = calls;
      const schemaRow = workspaceDb.sqlite
        .prepare(
          `SELECT catalog_entry_id AS catalogEntryId, source, tools_json AS toolsJson
           FROM mcp_tool_schema_snapshots WHERE snapshot_id = ?`
        )
        .get(call.schemaSnapshotId);
      schema = schemaRow
        ? {
            catalogEntryId: schemaRow.catalogEntryId,
            source: schemaRow.source,
            toolNames: JSON.parse(schemaRow.toolsJson).map((tool) => tool.name),
          }
        : null;
      usage = workspaceDb.sqlite
        .prepare(
          `SELECT quantity, unit FROM usage_records
           WHERE capability_call_id = ? AND unit = 'tool_calls'`
        )
        .all(call.callId);
      audit = workspaceDb.sqlite
        .prepare(
          `SELECT action, outcome FROM audit_events
           WHERE capability_call_id = ? AND action = 'capability.finish'`
        )
        .all(call.callId);
    }
    permission = workspaceDb.sqlite
      .prepare(
        `SELECT enforcement_point AS enforcementPoint, result
         FROM permission_decisions WHERE action = 'tool.use'`
      )
      .all();
  } finally {
    workspaceDb.sqlite.close();
  }
  const item = call
    ? new FsStore({ dataRoot })
        .getTurnById(turnId)
        .items.find((candidate) => candidate.id === call.itemId)
    : null;
  return {
    audit,
    backend,
    call:
      call === null
        ? null
        : {
            itemIdValid: /^it_mcp_/u.test(call.itemId),
            schemaSnapshotIdValid: /^mcpsnap_echo_/u.test(call.schemaSnapshotId),
            status: call.status,
          },
    item: {
      server: item?.server,
      status: item?.status,
      tool: item?.tool,
      type: item?.type,
    },
    lease,
    permission,
    schema,
    usage,
  };
}

/** Verifies one raw Context import response and returns its decoded metadata. */
function verifyImportedFile(response) {
  const byteLength = Number(header(response, 'x-openkit-byte-length'));
  const relativePath = decodeURIComponent(header(response, 'x-openkit-relative-path'));
  const requestId = header(response, 'x-openkit-request-id');
  const sha256 = header(response, 'x-openkit-sha256');
  const slot = header(response, 'x-openkit-slot');
  assert.equal(byteLength, response.bodyBytes.byteLength);
  assert.equal(header(response, 'content-length'), String(byteLength));
  assert.equal(sha256, `sha256:${createHash('sha256').update(response.bodyBytes).digest('hex')}`);
  return { relativePath, requestId, slot };
}

/** Posts one JSON result to a fixed effect endpoint. */
async function settleJsonEffect(client, operation, result) {
  const response = await requestHttp2(
    client,
    'POST',
    `/api/nanohost/transport/effects/${operation}/result`,
    JSON.stringify(result),
    { 'content-type': 'application/json' }
  );
  assert.equal(response.status, 204, responseFailure(`${operation} result`, response));
}

/** Posts one byte-exact required file result. */
async function settleFileExport(client, command, bytes) {
  const relativePath = requireString(command.relativePath, 'Export relative path');
  const response = await requestHttp2(
    client,
    'POST',
    '/api/nanohost/transport/effects/file.export/result',
    bytes,
    {
      'content-length': String(bytes.byteLength),
      'content-type': 'application/octet-stream',
      'x-openkit-byte-length': String(bytes.byteLength),
      'x-openkit-relative-path': relativePath,
      'x-openkit-request-id': requireString(command.requestId, 'Export request id'),
      'x-openkit-sha256': `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      'x-openkit-slot': requireString(command.slot, 'Export slot'),
    }
  );
  assert.equal(response.status, 204, responseFailure('file.export result', response));
}

/** Waits for one named fixed-effect command. */
async function waitForEffect(client, operation, child, output, failure) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assertProcessRunning(child, output, failure());
    const response = await pollEffect(client, operation);
    if (response.status === 200) return { command: parseJson(response, `${operation} command`) };
    assert.equal(response.status, 204, responseFailure(`${operation} poll`, response));
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${operation}.\n${output()}`);
}

/** Polls one fixed NanoHost effect on the admitted HTTP/2 connection. */
function pollEffect(client, operation) {
  return requestHttp2(client, 'POST', `/api/nanohost/transport/effects/${operation}`, '{}', {
    'content-type': 'application/json',
  });
}

/** Waits for one exact private Harness operation. */
async function waitForHarnessOperation(client, binding, operation, child, output, failure) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assertProcessRunning(child, output, failure());
    const response = await pollHarness(client, binding);
    if (response.status === 200) {
      const command = parseJson(response, `${operation} command`);
      assert.equal(command.operation, operation);
      return command;
    }
    assert.equal(response.status, 204, responseFailure('Harness poll', response));
    await sleep(10);
  }
  throw new Error(`Timed out waiting for Harness ${operation}.\n${output()}`);
}

/** Polls the private Harness without presenting a bearer token. */
function pollHarness(client, binding) {
  return requestHttp2(client, 'POST', '/worker-control/harness/poll', '{"schemaVersion":1}', {
    'content-type': 'application/json',
    [integrationHeader]: binding,
  });
}

/** Settles one private Harness command. */
async function settleHarness(client, binding, command, body) {
  const response = await requestHttp2(
    client,
    'POST',
    '/worker-control/harness/result',
    JSON.stringify({
      body,
      disposition: 'succeeded',
      harnessInstanceId: command.harnessInstanceId,
      operationId: command.operationId,
      schemaVersion: 1,
      sequence: command.sequence,
    }),
    { 'content-type': 'application/json', [integrationHeader]: binding }
  );
  assert.equal(response.status, 204, responseFailure('Harness result', response));
}

/** Loads the official MCP SDK from the NanoCore package that owns the dependency. */
async function loadMcpSdk() {
  const fromNanoCore = createRequire(join(repoRoot, 'apps/nanocore/package.json'));
  const [client, transport] = await Promise.all([
    import(pathToFileURL(fromNanoCore.resolve('@modelcontextprotocol/sdk/client/index.js'))),
    import(
      pathToFileURL(fromNanoCore.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
    ),
  ]);
  return {
    Client: client.Client,
    StreamableHTTPClientTransport: transport.StreamableHTTPClientTransport,
  };
}

/** Adapts SDK fetch calls onto the already-admitted native HTTP/2 connection. */
function h2Fetch(client) {
  return async (input, init) => {
    const request = new Request(input, init);
    const body = ['GET', 'HEAD'].includes(request.method)
      ? Buffer.alloc(0)
      : Buffer.from(await request.arrayBuffer());
    const headers = Object.fromEntries(request.headers.entries());
    const response = await requestHttp2(
      client,
      request.method,
      new URL(request.url).pathname,
      body,
      headers
    );
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (!name.startsWith(':') && value !== undefined) {
        responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
      }
    }
    return new Response(response.bodyBytes.byteLength === 0 ? null : response.bodyBytes, {
      headers: responseHeaders,
      status: response.status,
    });
  };
}

/** Sends one bounded request over the dedicated native HTTP/2 listener. */
function requestHttp2(client, method, path, body = '', headers = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = client.request({ ':method': method, ':path': path, ...headers });
    const chunks = [];
    let responseHeaders = {};
    let status = 0;
    request.setTimeout(10_000, () =>
      request.destroy(new Error(`HTTP/2 request timed out: ${path}`))
    );
    request.on('response', (received) => {
      responseHeaders = received;
      status = Number(received[':status']);
    });
    request.on('error', rejectRequest);
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const bodyBytes = Buffer.concat(chunks);
      resolveRequest({
        body: bodyBytes.toString('utf8'),
        bodyBytes,
        headers: responseHeaders,
        status,
      });
    });
    request.end(body);
  });
}

/** Returns selected keys from a JSON response. */
function pickJson(response, keys) {
  const value = parseJson(response, 'JSON response');
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

/** Parses one JSON response object. */
function parseJson(response, label) {
  try {
    const value = JSON.parse(response.body);
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    return value;
  } catch (error) {
    throw new Error(`${label} was not a JSON object: ${response.body.slice(0, 512)}`, {
      cause: error,
    });
  }
}

/** Reads one required HTTP/2 response header. */
function header(response, name) {
  return requireString(response.headers[name], `Response header ${name}`);
}

/** Reads one required nonempty string. */
function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing.`);
  return value;
}

/** Formats a bounded private-route failure. */
function responseFailure(label, response) {
  return `${label} returned ${response.status}: ${response.body.slice(0, 512)}`;
}

/** Retains bounded startup output for a deciding smoke failure. */
function captureOutput(child) {
  let output = '';
  const append = (chunk) => {
    output = `${output}${chunk}`.slice(-8192);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return () => output;
}

/** Fails promptly when the disposable server or Task has already failed. */
function assertProcessRunning(child, output, taskFailure = null) {
  if (taskFailure) throw taskFailure;
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `NanoCore exited early: code=${child.exitCode}, signal=${child.signalCode}.\n${output()}`
    );
  }
}

/** Waits until one public HTTP endpoint becomes ready. */
async function waitForHttp(url, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assertProcessRunning(child, output);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

/** Waits for the native HTTP/2 client connection. */
async function waitForH2Connect(client, child, output) {
  await Promise.race([
    new Promise((resolveConnect, rejectConnect) => {
      client.once('connect', resolveConnect);
      client.once('error', rejectConnect);
    }),
    sleep(10_000).then(() => {
      assertProcessRunning(child, output);
      throw new Error('Timed out connecting to the NanoHost HTTP/2 listener.');
    }),
  ]);
}

/** Stops only the disposable NanoCore child and requires an orderly zero-code exit. */
async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode !== 0 || child.signalCode !== null) {
      throw new Error(
        `NanoCore exited unexpectedly: code=${child.exitCode}, signal=${child.signalCode}.`
      );
    }
    return;
  }
  const exit = new Promise((resolveExit) =>
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  );
  child.kill('SIGTERM');
  const result = await Promise.race([exit, sleep(10_000).then(() => null)]);
  if (!result) throw new Error('NanoCore did not exit within 10000ms after SIGTERM.');
  if (result.code !== 0) {
    throw new Error(
      `NanoCore exited unsuccessfully: code=${result.code}, signal=${result.signal}.`
    );
  }
}

/** Waits until the gateway-owned MCP stub no longer exists. */
async function waitForProcessExit(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
      throw error;
    }
    await sleep(25);
  }
  throw new Error(`Gateway-owned MCP process ${pid} survived NanoCore shutdown.`);
}

/** Proves the disposable native listener no longer accepts TCP connections. */
async function assertPortClosed(port) {
  await new Promise((resolveClosed, rejectOpen) => {
    const socket = connectTcp({ host: '127.0.0.1', port });
    socket.setTimeout(2_000);
    socket.once('connect', () => {
      socket.destroy();
      rejectOpen(new Error(`NanoHost listener ${port} remained open after shutdown.`));
    });
    socket.once('error', (error) => {
      if (error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED') {
        resolveClosed();
        return;
      }
      rejectOpen(error);
    });
    socket.once('timeout', () => {
      socket.destroy();
      rejectOpen(new Error(`NanoHost listener ${port} closure probe timed out.`));
    });
  });
}

/** Finds one available localhost TCP port. */
function findOpenPort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => rejectPort(new Error('Could not allocate a TCP port.')));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

/** Writes one formatted JSON configuration file. */
function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Resolves after a short polling delay. */
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

if (process.argv[2] === '--self-check') {
  await runHarnessAdmissionSelfCheck();
} else {
  await main();
}
