// openkit-test-platform: posix

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  type ClientHttp2Session,
  connect as connectHttp2,
  type IncomingHttpHeaders,
} from 'node:http2';
import { connect as connectTcp, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type {
  AdministratorCleanupReadResponse,
  CapabilityUsageResponse,
  CreateMcpConfigResponse,
  GetWorkspaceCatalogResponse,
  ListWorkspaceAuditEventsResponse,
  ListWorkspacePermissionDecisionsResponse,
  PrepareWorkerEnvironmentResponse,
  RuntimeConfigFileReadResponse,
} from '@openkit/app-api-schemas';
import {
  ListHumanAttentionResponseSchema,
  StartTaskModeResponseSchema,
  SubmitAdministrationConversationResponseSchema,
} from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { ItemIdSchema, ThreadSchema, TurnReadProjectionSchema } from '@openkit/protocol';
import { describe, it } from 'vitest';
import transportRevision from '../dist/auth/nanohost-transport-revision.json' with { type: 'json' };
import {
  completeServerBootstrap,
  type NanoCoreHarness,
  startNanoCoreHarness,
} from './_lib/harness.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const smokeRequestId = '0190f4c8-0000-7000-8000-000000000601';
const integrationHeader = 'x-openkit-integration-binding';
const smokeImageDigest = `sha256:${'a'.repeat(64)}`;
const smokeImageDefaults = {
  defaultsDigest: `sha256:${createHash('sha256').update('{}').digest('hex')}`,
  values: {},
};
const runtimeImage = {
  kind: 'reference',
  pullPolicy: 'if-not-present',
  ref: 'openkit/worker-codex:dev',
};

interface PublicApp {
  baseUrl: string;
  administratorToken: string;
}

interface Http2Response {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  bodyBytes: Buffer;
}

/** Existing host-effect wire fields used by the relocated protocol peer, not retained Core records. */
interface EffectCommand {
  requestId: string;
  operation: string;
  operationId: string;
  harnessInstanceId: string;
  sequence: number;
  imageReference: string;
  imageDigest: string;
  sandboxId: string;
  sandboxIntegrationBindingRef: string;
  mode: 'baseline' | 'capture';
  relativePath: string;
  presence: string;
  slot: string;
  storage: { targets: Array<{ target: string; initialized?: boolean }>; [key: string]: unknown };
  body: {
    agentSessionId: string;
    workspaceId: string;
    threadId: string;
    turnId: string;
    maxActiveTurns: number;
    contextPackageId: string;
    capabilityToken: string;
    workerControlToken: string;
    inferenceToken: string;
    packageSnapshotId: string;
    aepRef: string;
    contextRef: string;
  };
}
interface ContextManifest {
  contextPackageId: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
  fileInventory: Array<{ path: string }>;
}

/**
 * Relocates the former deep L5 Task/MCP proof to L3 through built-process public owners.
 * The NanoHost/Worker peer supplies external protocol effects; it is not a native Worker runtime.
 */
async function runPublicWorkerMcpLifecycle() {
  const nanoHostPort = await findOpenPort();
  const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-public-worker-mcp-'));
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'openkit-public-worker-mcp-fixture-'));
  const callFile = join(fixtureRoot, 'mcp-calls.txt');
  let harness: NanoCoreHarness | undefined;
  let h2: ClientHttp2Session | undefined;
  let mcpServerPid: number | null = null;
  try {
    // The existing administration owner creates its private Thread before any model is configured.
    harness = await startNanoCoreHarness({
      coreMode: 'server',
      dataRoot,
      seedDemoWorkspace: false,
      useSimulator: false,
    });
    const administratorToken = requireString(
      await completeServerBootstrap(harness),
      'Bootstrap administrator access'
    );
    const initialApp: PublicApp = { baseUrl: harness.baseUrl, administratorToken };
    const administration = SubmitAdministrationConversationResponseSchema.parse(
      await publicOperation(initialApp, 'administration.conversation-submit', {
        input: 'Prepare this isolated Worker environment.',
        requestId: randomUUID(),
      })
    );
    const administrationThreadId = requireString(
      administration.turn?.threadId,
      'Administration Thread'
    );
    await harness.stop();
    await writeFixtureConfiguration(dataRoot, fixtureRoot, nanoHostPort);
    let appPort = await findOpenPort();
    while (appPort === nanoHostPort) appPort = await findOpenPort();
    harness = await startNanoCoreHarness({
      coreMode: 'server',
      dataRoot,
      port: appPort,
      seedDemoWorkspace: false,
      useSimulator: false,
    });
    const app: PublicApp = { baseUrl: harness.baseUrl, administratorToken };
    const validated = await publicOperation<{ valid: boolean; diagnostics: unknown[] }>(
      app,
      'runtime.validate',
      { files: [], mode: 'safe' }
    );
    assert.equal(validated.valid, true);
    assert.deepEqual(validated.diagnostics, []);
    const files = await publicOperation<{ files: Array<{ id: string; kind: string }> }>(
      app,
      'runtime.file-list',
      {}
    );
    assert.equal(
      files.files.filter((file) => file.id === 'providers/agent-openrouter.provider.jsonc').length,
      1
    );
    const workspace = await publicOperation<{ id: string }>(
      app,
      'workspace.create',
      { name: 'Public Worker MCP lifecycle', requestId: randomUUID() },
      201
    );
    const workspaceId = workspace.id;
    const thread = ThreadSchema.parse(
      await publicOperation(app, 'thread.create', {
        workspaceId,
        name: 'Public Task MCP',
        visibility: 'workspace',
        requestId: randomUUID(),
      })
    );
    assert.equal(thread.visibility, 'workspace');
    const threadId = thread.id;
    const catalog = await publicOperation<GetWorkspaceCatalogResponse>(app, 'catalog.read', {
      workspaceId,
    });
    const created = await publicOperation<CreateMcpConfigResponse>(
      app,
      'catalog.mcp-create',
      {
        workspaceId,
        id: 'echo',
        displayName: 'Echo fixture',
        allowedTools: ['echo'],
        declaration: {
          kind: 'stdio',
          command: process.execPath,
          args: [join(repoRoot, 'apps/nanocore/src/test-support/mcp-stdio-stub.mjs'), callFile],
          cwd: null,
          environment: {},
          environmentSlots: {},
        },
        expectedRevision: catalog.revision,
        requestId: randomUUID(),
      },
      201
    );
    assert.equal(created.entry.currentVersionDigest, created.versionDigest);
    await publicOperation(app, 'catalog.mcp-binding', {
      workspaceId,
      mcpId: created.entry.id,
      allowedTools: ['echo'],
      enabled: true,
      schemaPolicy: 'tracking',
      timeoutMs: 10_000,
      credentialBindings: [],
      bindingRevision: created.entry.bindingRevision,
      expectedRevision: created.revision,
      requestId: randomUUID(),
    });
    await publicOperation(
      app,
      'nanohost.enroll',
      {
        targetSlot: 'A',
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
      201
    );
    // Read only this fixture's authorized safe-sink delivery, never a user's credential store.
    const nanoHostSecret = (await readFile(join(fixtureRoot, 'transport-a.token'), 'utf8')).trim();
    h2 = connectHttp2(`http://127.0.0.1:${nanoHostPort}`);
    const h2Closed = new Promise<void>((resolveClose) => h2!.once('close', resolveClose));
    await waitForH2Connect(h2);
    const admission = await requestHttp2(
      h2,
      'POST',
      '/api/nanohost/transport/session/admit',
      '{}',
      {
        authorization: `Bearer ${nanoHostSecret}`,
        'content-type': 'application/json',
        'x-openkit-nanohost-transport-revision': String(transportRevision),
      }
    );
    assert.equal(admission.status, 200, responseFailure('NanoHost admission', admission));
    assert.equal(
      admission.headers['x-openkit-nanohost-transport-revision'],
      String(transportRevision)
    );
    assert.deepEqual(pickJson(admission, ['mayCarryWork', 'role']), {
      mayCarryWork: true,
      role: 'authoritative',
    });
    const readiness = await requestHttp2(
      h2,
      'POST',
      '/api/nanohost/transport/session/readiness',
      JSON.stringify({ physicalEpoch: 'a'.repeat(64) }),
      { 'content-type': 'application/json' }
    );
    assert.equal(readiness.status, 204, responseFailure('NanoHost readiness', readiness));
    await prepareAndActivateEnvironment(app, h2, administrationThreadId);
    let taskFailure: unknown = null;
    const taskInput = {
      workspaceId,
      threadId,
      input: 'Implement the MCP verification by calling the echo tool.',
      requestId: smokeRequestId,
    };
    const taskPromise = fetch(`${app.baseUrl}/api/app/operations/task.start`, {
      body: JSON.stringify(taskInput),
      headers: {
        authorization: `Bearer ${app.administratorToken}`,
        'content-type': 'application/json',
        'x-openkit-request-id': smokeRequestId,
      },
      method: 'POST',
    });
    void taskPromise.then(
      async (response) => {
        if (response.status !== 202) {
          taskFailure = await publicOperationFailure('task.start', response.clone());
        }
      },
      (error) => {
        taskFailure = error;
      }
    );

    const image = await waitForEffect(h2, 'image.acquire', () => taskFailure);
    assert.equal(image.command.imageReference, smokeImageDigest);
    await settleJsonEffect(h2, 'image.acquire', {
      digest: smokeImageDigest,
      requestId: image.command.requestId,
    });
    const inspection = await waitForEffect(h2, 'image.inspect', () => taskFailure);
    await settleJsonEffect(h2, 'image.inspect', {
      requestId: inspection.command.requestId,
      digest: inspection.command.imageDigest,
      environmentDefaults: smokeImageDefaults,
      platform: { architecture: 'arm64', os: 'linux' },
      storageLayout: {
        family: 'openkit-worker',
        gid: 1000,
        uid: 1000,
        version: '1',
        targets: [{ target: '/workspace' }, { target: '/openkit/threads' }],
        workingDirectory: '/workspace',
      },
    });
    const sandbox = await waitForEffect(h2, 'sandbox.create', () => taskFailure);
    const sandboxId = requireString(sandbox.command.sandboxId, 'Sandbox id');
    await settleJsonEffect(h2, 'sandbox.create', {
      requestId: sandbox.command.requestId,
      sandboxId,
      state: 'created',
      storage: {
        ...sandbox.command.storage,
        targets: sandbox.command.storage.targets.map((target) => ({
          ...target,
          initialized: true,
        })),
      },
    });

    const bridge = await waitForEffect(h2, 'bridge.open', () => taskFailure);
    const integrationBindingRef = requireString(
      bridge.command.sandboxIntegrationBindingRef,
      'Sandbox Integration binding'
    );
    await settleJsonEffect(h2, 'bridge.open', {
      accepted: true,
      integrationReady: true,
      requestId: bridge.command.requestId,
      state: 'open',
    });

    const harnessOperations: string[] = [];
    const collections: string[] = [];
    let opened: EffectCommand | null = null;
    let environmentPackage: AgentEnvironmentPackage | null = null;
    const contextFiles = new Map<string, Buffer>();
    let importCount = 0;
    let started: EffectCommand | null = null;
    const startupDeadline = Date.now() + 30_000;
    while (!started && Date.now() < startupDeadline) {
      throwIfFailed(taskFailure);
      const imported = await pollEffect(h2, 'reference.import');
      if (imported.status === 200) {
        importCount += 1;
        const metadata = verifyImportedFile(imported);
        if (metadata.slot === 'package-config') {
          assert.equal(importCount, 1, 'The canonical AEP must be the first Turn import.');
          assert.equal(environmentPackage, null, 'NanoHost imported more than one canonical AEP.');
          environmentPackage = AgentEnvironmentPackageSchema.parse(
            JSON.parse(imported.bodyBytes.toString('utf8'))
          );
          assert.equal(
            metadata.relativePath,
            `${environmentPackage.scope.agentSessionId}/config/package.json`
          );
          assert.deepEqual(environmentPackage.runtime.environment, {
            imageDigest: smokeImageDigest,
            ...smokeImageDefaults,
          });
        } else if (metadata.slot === 'context') {
          assert.ok(environmentPackage, 'NanoHost imported Context before the canonical AEP.');
          const contextPrefix = `${environmentPackage.scope.agentSessionId}/context/`;
          assert.ok(metadata.relativePath.startsWith(contextPrefix));
          contextFiles.set(metadata.relativePath.slice(contextPrefix.length), imported.bodyBytes);
        } else {
          assert.fail(`Unexpected Worker MCP smoke import slot: ${metadata.slot}`);
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
      const collection = await pollEffect(h2, 'workspace.collect');
      if (collection.status === 200) {
        collections.push(await settleEmptyWorkspaceCollection(h2, collection));
        continue;
      }
      assert.equal(collection.status, 204, responseFailure('workspace.collect poll', collection));
      const nextHarness = await pollHarness(h2, integrationBindingRef);
      if (nextHarness.status === 200) {
        const command = parseJson(nextHarness, 'Harness startup command');
        if (command.operation === 'session.open') {
          assert.equal(opened, null, 'NanoHost opened more than one AgentSession.');
          assert.ok(environmentPackage, 'NanoHost opened the AgentSession before its AEP import.');
          opened = command;
          assert.equal(environmentPackage.scope.agentSessionId, opened.body.agentSessionId);
          assert.equal(environmentPackage.scope.workspaceId, opened.body.workspaceId);
          assert.equal(environmentPackage.scope.threadId, opened.body.threadId);
          harnessOperations.push(opened.operation);
          await settleHarness(h2, integrationBindingRef, opened, {
            maxActiveTurns: opened.body.maxActiveTurns,
            nativeHandleDigest: null,
            nativeHandleState: 'pending',
            state: 'open',
          });
        } else {
          assert.ok(opened, 'NanoHost started a Turn before opening its AgentSession.');
          started = command;
          assert.equal(started.operation, 'turn.start');
        }
      } else {
        assert.equal(nextHarness.status, 204, responseFailure('Harness poll', nextHarness));
        await sleep(10);
      }
    }
    assert.ok(started, 'NanoHost Harness turn.start was not dispatched after Turn imports.');
    assert.ok(environmentPackage, 'NanoHost did not import the canonical AgentSession AEP.');
    const contextManifestBytes = contextFiles.get('package.json');
    assert.ok(contextManifestBytes, 'NanoHost did not import the Context Package manifest.');
    const contextManifest = JSON.parse(contextManifestBytes.toString('utf8')) as ContextManifest;
    const contextInputId = `context_${environmentPackage.scope.turnId}`;
    const contextInputs = environmentPackage.workspace.inputs.filter(
      (input) => input.id === contextInputId
    );
    assert.equal(contextInputs.length, 1);
    assert.ok(contextInputs[0]);
    assert.equal(
      contextInputs[0].target,
      `/openkit/sessions/${environmentPackage.scope.agentSessionId}/context`
    );
    assert.equal(contextManifest.contextPackageId, `ctxpkg_${environmentPackage.scope.turnId}`);
    assert.equal(started.body.contextPackageId, contextManifest.contextPackageId);
    assert.equal(contextManifest.workspaceId, environmentPackage.scope.workspaceId);
    assert.equal(contextManifest.threadId, environmentPackage.scope.threadId);
    assert.equal(contextManifest.turnId, environmentPackage.scope.turnId);
    assert.deepEqual(
      [...contextFiles.keys()].sort(),
      [...contextManifest.fileInventory.map((file) => file.path), 'package.json'].sort()
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
    assert.equal(started.body.agentSessionId, environmentPackage.scope.agentSessionId);
    assert.equal(started.body.packageSnapshotId, environmentPackage.snapshotId);
    assert.equal(
      started.body.aepRef,
      `/openkit/sessions/${environmentPackage.scope.agentSessionId}/config/package.json`
    );
    assert.equal(
      started.body.contextRef,
      `/openkit/sessions/${environmentPackage.scope.agentSessionId}/context`
    );
    assert.equal(started.body.turnId, environmentPackage.scope.turnId);
    const lineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: requireString(environmentPackage.scope.requestId, 'AEP request identity'),
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
        schemaVersion: 2,
        sequence: 0,
      }),
      { authorization: `Bearer ${workerControlToken}`, 'content-type': 'application/json' }
    );
    assert.equal(heartbeat.status, 200, responseFailure('Worker heartbeat', heartbeat));

    const mcpClient = new Client({ name: 'openkit-public-worker-mcp-l3', version: '1.0.0' });
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
        arguments: { message: 'l3-public' },
        name: 'echo',
      });
      assert.deepEqual(result.content, [{ text: 'l3-public', type: 'text' }]);
      const structured = result.structuredContent;
      assert.ok(
        structured !== null && typeof structured === 'object' && !Array.isArray(structured),
        'MCP echo result must carry structured content.'
      );
      const details = structured as Record<string, unknown>;
      assert.equal(details.message, 'l3-public');
      mcpServerPid = Number(details.pid);
      assert.ok(Number.isSafeInteger(mcpServerPid) && mcpServerPid > 0, 'MCP stub pid is invalid.');
    } finally {
      await mcpClient.close();
    }
    const callLog = (await readFile(callFile, 'utf8')).trim().split('\n');
    assert.deepEqual(callLog, ['l3-public']);

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
        schemaVersion: 2,
        sequence: 1,
      }),
      { authorization: `Bearer ${workerControlToken}`, 'content-type': 'application/json' }
    );
    assert.equal(finalStatus.status, 200, responseFailure('Worker final status', finalStatus));

    const inspected = await waitForHarnessOperation(
      h2,
      integrationBindingRef,
      'session.inspect',
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

    const exports: Array<{ presence: string; relativePath: string }> = [];
    let closed = false;
    const closeDeadline = Date.now() + 30_000;
    while (!closed && Date.now() < closeDeadline) {
      throwIfFailed(taskFailure);
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
      const collection = await pollEffect(h2, 'workspace.collect');
      if (collection.status === 200) {
        collections.push(await settleEmptyWorkspaceCollection(h2, collection));
        continue;
      }
      assert.equal(collection.status, 204, responseFailure('workspace.collect poll', collection));
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
    const captureRelativeRoot = `${environmentPackage.scope.threadId}/codex/capture/${environmentPackage.scope.turnId}/`;
    assert.deepEqual(exports, [
      { presence: 'required', relativePath: `${captureRelativeRoot}events.jsonl` },
      { presence: 'required', relativePath: `${captureRelativeRoot}items.jsonl` },
    ]);

    const taskResponse = await taskPromise;
    assert.equal(taskResponse.status, 202, `Task start returned ${taskResponse.status}.`);
    const admitted = StartTaskModeResponseSchema.parse(await taskResponse.json());
    assert.equal(admitted.turn?.id, environmentPackage.scope.turnId);
    // Task start returns at durable admission; exact replay observes the same owner's closeout.
    let task = admitted;
    const taskDeadline = Date.now() + 30_000;
    while (task.state !== 'completed' && Date.now() < taskDeadline) {
      throwIfFailed(taskFailure);
      assert.notEqual(task.turn?.status, 'failed', 'The admitted Task failed before closeout.');
      const replay = await fetch(`${app.baseUrl}/api/app/operations/task.start`, {
        body: JSON.stringify(taskInput),
        headers: {
          authorization: `Bearer ${app.administratorToken}`,
          'content-type': 'application/json',
          'x-openkit-request-id': smokeRequestId,
        },
        method: 'POST',
      });
      assert.equal(replay.status, 202, `Task replay returned ${replay.status}.`);
      const replayBody = StartTaskModeResponseSchema.parse(await replay.json());
      assert.equal(replayBody.turn?.id, admitted.turn.id);
      task = replayBody;
      if (task.state !== 'completed') await sleep(10);
    }
    assert.equal(task.state, 'completed');
    assert.equal(task.turn?.status, 'completed');
    assert.equal(Object.hasOwn(task.turn, 'humanGate'), false);
    const attention = ListHumanAttentionResponseSchema.parse(
      await publicOperation(app, 'attention.list', { workspaceId })
    );
    assert.deepEqual(attention.items, [], 'Worker left a human-attention request.');
    assert.equal(task.turn?.id, environmentPackage.scope.turnId);

    await assertPublicDurableOutcome(app, workspaceId, threadId, task.turn.id);
    assert.deepEqual(collections, ['baseline', 'capture', 'capture']);
    assert.ok(importCount >= 1);
    assert.equal(existsSync(dataRoot), true);
    await harness.stop();
    await Promise.race([
      h2Closed,
      sleep(5_000).then(() => {
        throw new Error('NanoHost HTTP/2 connection did not close with NanoCore.');
      }),
    ]);
    await waitForProcessExit(mcpServerPid);
    await assertPortClosed(nanoHostPort);
  } finally {
    h2?.destroy();
    await harness?.stop();
    if (mcpServerPid) {
      try {
        process.kill(mcpServerPid, 'SIGKILL');
      } catch {}
    }
    await rm(fixtureRoot, { force: true, recursive: true });
    await rm(dataRoot, { force: true, recursive: true });
    assert.equal(existsSync(fixtureRoot), false);
    assert.equal(existsSync(dataRoot), false);
  }
}

describe('public Worker MCP lifecycle', () => {
  it(
    'completes one public Task through authenticated host carriage, governed MCP and correlated release',
    runPublicWorkerMcpLifecycle,
    120_000
  );
});
/** Invokes one registered operation with the same public request identity in body and header. */
async function publicOperation<T = unknown>(
  app: PublicApp,
  operation: string,
  body: Record<string, unknown>,
  status = 200
): Promise<T> {
  const response = await fetch(`${app.baseUrl}/api/app/operations/${operation}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${app.administratorToken}`,
      'content-type': 'application/json',
      ...(typeof body.requestId === 'string' ? { 'x-openkit-request-id': body.requestId } : {}),
    },
  });
  if (response.status !== status) throw await publicOperationFailure(operation, response);
  return (await response.json()) as T;
}

/** Reports only the bounded public status/code, never a response message or payload. */
async function publicOperationFailure(operation: string, response: Response): Promise<Error> {
  const failure: unknown = await response.json().catch(() => null);
  const value = failure && typeof failure === 'object' && 'code' in failure ? failure.code : null;
  const code =
    typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : 'unknown';
  return new Error(`${operation} returned ${response.status} (${code}).`);
}

/** Produces and confirms the exact image candidate through the public environment owner. */
async function prepareAndActivateEnvironment(
  app: PublicApp,
  host: ClientHttp2Session,
  administrationThreadId: string
) {
  const file = await publicOperation<RuntimeConfigFileReadResponse>(app, 'runtime.file-read', {
    id: 'agents/codex.agent.jsonc',
  });
  const pending = publicOperation<PrepareWorkerEnvironmentResponse>(
    app,
    'worker-environment.prepare',
    {
      administrationThreadId,
      configuration: {
        expectedRevision: requireString(file.file.revision, 'Agent configuration revision'),
        fileId: file.file.id,
      },
      declaration: runtimeImage,
      replaceNow: null,
      requestId: randomUUID(),
      target: { agentId: 'agent_codex_host', kind: 'agent' },
    }
  );
  const prepared = await settlePendingImage(host, pending, true);
  assert.equal(prepared.image.digest, smokeImageDigest);
  const activation = publicOperation(app, 'worker-environment.activate', {
    affectedStorage: prepared.affectedStorage,
    configuration: prepared.configuration,
    confirmation: prepared.activationConfirmation,
    replaceNow: prepared.replaceNow,
    resolvedCandidate: prepared.resolvedCandidate,
    target: prepared.target,
    requestId: randomUUID(),
  });
  await settlePendingImage(host, activation, false);
}

/** Supplies host observations only after the real public owner dispatches each fixed image effect. */
async function settlePendingImage<T>(
  host: ClientHttp2Session,
  pending: Promise<T>,
  acquire: boolean
): Promise<T> {
  let failure: unknown = null;
  void pending.catch((error: unknown) => {
    failure = error;
  });
  if (acquire) {
    const image = await waitForEffect(host, 'image.acquire', () => failure);
    assert.equal(image.command.imageReference, runtimeImage.ref);
    await settleJsonEffect(host, 'image.acquire', {
      digest: smokeImageDigest,
      requestId: image.command.requestId,
    });
  }
  const inspection = await waitForEffect(host, 'image.inspect', () => failure);
  assert.equal(inspection.command.imageDigest, smokeImageDigest);
  await settleJsonEffect(host, 'image.inspect', {
    requestId: inspection.command.requestId,
    digest: smokeImageDigest,
    environmentDefaults: smokeImageDefaults,
    platform: { architecture: 'arm64', os: 'linux' },
    storageLayout: {
      family: 'openkit-worker',
      gid: 1000,
      uid: 1000,
      version: '1',
      targets: [{ target: '/workspace' }, { target: '/openkit/threads' }],
      workingDirectory: '/workspace',
    },
  });
  return pending;
}

/** Replaces the old private SQL/store observations with their actual public owning projections. */
async function assertPublicDurableOutcome(
  app: PublicApp,
  workspaceId: string,
  threadId: string,
  turnId: string
) {
  const usage = await publicOperation<CapabilityUsageResponse>(app, 'usage.read', {
    workspaceId,
  });
  const calls = usage.capabilityCalls.filter(
    (call) =>
      call.turnId === turnId && call.operation === 'mcp.call-tool' && call.providerRef === 'echo'
  );
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.status, 'succeeded');
  assert.equal(ItemIdSchema.safeParse(call.itemId).success, true);
  assert.ok(requireString(call.schemaSnapshotId, 'Retained schema snapshot reference'));
  const records = usage.usageRecords.filter(
    (record) => record.capabilityCallId === call.id && record.unit === 'tool_calls'
  );
  assert.deepEqual(
    records.map(({ quantity, unit }) => ({ quantity, unit })),
    [{ quantity: 1, unit: 'tool_calls' }]
  );
  const turn = TurnReadProjectionSchema.parse(
    await publicOperation(app, 'turn.read', { workspaceId, threadId, turnId })
  );
  assert.equal(turn.id, turnId);
  const item = turn.items.find((candidate) => candidate.id === call.itemId);
  assert.ok(
    item && item.type === 'tool-call',
    'The actual call must reference a retained Tool-call Item.'
  );
  assert.deepEqual(
    { server: item.server, tool: item.tool, type: item.type, status: item.status },
    { server: 'echo', tool: 'echo', type: 'tool-call', status: 'completed' }
  );
  const audit = await publicOperation<ListWorkspaceAuditEventsResponse>(
    app,
    'audit.workspace-list',
    { workspaceId }
  );
  assert.deepEqual(
    audit.auditEvents
      .filter((event) => event.capabilityCallId === call.id && event.action === 'capability.finish')
      .map(({ action, outcome }) => ({ action, outcome })),
    [{ action: 'capability.finish', outcome: 'succeeded' }]
  );
  const decisions = await publicOperation<ListWorkspacePermissionDecisionsResponse>(
    app,
    'permission.workspace-list',
    { workspaceId }
  );
  const permission = decisions.permissionDecisions.filter(
    (decision) =>
      decision.action === 'tool.use' &&
      (decision.contextSummary as { capabilityCallId?: string } | null)?.capabilityCallId ===
        call.id
  );
  assert.deepEqual(
    permission.map((decision) => ({
      operation: decision.mediation?.operation,
      stage: decision.mediation?.stage,
      result: decision.result,
    })),
    [{ operation: 'mcp.call-tool', stage: 'decide', result: 'allow' }]
  );
  const cleanup = await publicOperation<AdministratorCleanupReadResponse>(
    app,
    'administration.cleanup-read',
    {}
  );
  for (const source of ['backend-session', 'execution-attempt']) {
    const coverage = cleanup.sources.find((candidate) => candidate.source === source);
    assert.equal(coverage?.availability, 'available');
    assert.equal(coverage?.incomplete, false);
  }
  const backends = cleanup.items.filter(
    (item) => item.source === 'backend-session' && item.target.turnId === turnId
  );
  assert.equal(backends.length, 1);
  const backend = backends[0]!;
  assert.equal(backend.source, 'backend-session');
  if (backend.source !== 'backend-session')
    throw new Error('Expected the correlated backend source.');
  assert.equal(backend.state.state, 'cleaned');
  assert.equal(backend.state.workspaceHandoffState, 'complete');
  const attempts = cleanup.items.filter(
    (item) =>
      item.source === 'execution-attempt' &&
      item.target.turnId === turnId &&
      item.target.attemptId === backend.target.attemptId
  );
  assert.equal(attempts.length, 1);
  const attempt = attempts[0]!;
  assert.equal(attempt.source, 'execution-attempt');
  if (attempt.source !== 'execution-attempt')
    throw new Error('Expected the correlated attempt source.');
  assert.equal(attempt.state.phase, 'closed');
}

/** Authors accepted configuration; public commands produce all retained lifecycle state. */
async function writeFixtureConfiguration(
  dataRoot: string,
  fixtureRoot: string,
  nanoHostPort: number
) {
  await mkdir(join(dataRoot, 'config', 'agents'), { recursive: true });
  await mkdir(join(dataRoot, 'config', 'providers'), { recursive: true });
  await writeJson(join(dataRoot, 'config', 'server.jsonc'), {
    defaults: { defaultAgentId: 'agent_codex_host' },
    mode: 'server',
    nanohost: {
      bind: { host: '127.0.0.1', port: nanoHostPort },
      credentialRef: 'nanohost-transport:worker-mcp-smoke',
      credentialSlots: {
        A: {
          companionPath: join(fixtureRoot, 'transport-a.json'),
          secretPath: join(fixtureRoot, 'transport-a.token'),
        },
        B: {
          companionPath: join(fixtureRoot, 'transport-b.json'),
          secretPath: join(fixtureRoot, 'transport-b.token'),
        },
      },
      deploymentId: 'dep_0190f4c8-0000-7000-8000-000000000602',
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
        contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
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
    schemaVersion: 1,
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
    profiles: [{ id: 'default', mcp: [], skills: [] }],
    requiredFeatures: [],
    runtime: {
      adapter: 'codex',
      binaries: [
        { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
        { id: 'node', path: '/usr/local/bin/node' },
        { id: 'codex', path: '/usr/local/bin/codex' },
      ],
      image: runtimeImage,
      kind: 'codex',
      version: 'smoke',
    },
    sandbox: {
      backend: {
        allowedKinds: ['openshell'],
        preferred: 'openshell',
        requiredCapabilities: ['trusted-worker-inference-relay'],
      },
      credentialDeclarations: [],
      filesystem: [],
      network: [],
    },
    schemaVersion: 1,
    skills: [],
  });
}
/** Verifies one raw Context import response and returns its decoded metadata. */
function verifyImportedFile(response: Http2Response) {
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
async function settleJsonEffect(client: ClientHttp2Session, operation: string, result: object) {
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
async function settleFileExport(client: ClientHttp2Session, command: EffectCommand, bytes: Buffer) {
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
async function waitForEffect(
  client: ClientHttp2Session,
  operation: string,
  failure: () => unknown
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    throwIfFailed(failure());
    const response = await pollEffect(client, operation);
    if (response.status === 200) return { command: parseJson(response, `${operation} command`) };
    assert.equal(response.status, 204, responseFailure(`${operation} poll`, response));
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${operation}.`);
}

/** Polls one fixed NanoHost effect on the admitted HTTP/2 connection. */
function pollEffect(client: ClientHttp2Session, operation: string) {
  return requestHttp2(client, 'POST', `/api/nanohost/transport/effects/${operation}`, '{}', {
    'content-type': 'application/json',
  });
}

/** Waits for one exact private Harness operation. */
async function waitForHarnessOperation(
  client: ClientHttp2Session,
  binding: string,
  operation: string,
  failure: () => unknown
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    throwIfFailed(failure());
    const response = await pollHarness(client, binding);
    if (response.status === 200) {
      const command = parseJson(response, `${operation} command`);
      assert.equal(command.operation, operation);
      return command;
    }
    assert.equal(response.status, 204, responseFailure('Harness poll', response));
    await sleep(10);
  }
  throw new Error(`Timed out waiting for Harness ${operation}.`);
}

/** Settles the explicitly empty synthetic Sandbox workspace through the native collection wire. */
async function settleEmptyWorkspaceCollection(client: ClientHttp2Session, response: Http2Response) {
  const command = parseJson(response, 'workspace.collect command');
  assert.ok(['baseline', 'capture'].includes(command.mode));
  await settleJsonEffect(
    client,
    'workspace.collect',
    command.mode === 'baseline'
      ? {
          requestId: command.requestId,
          outcome: 'baseline',
          head: {
            tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
            manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
          },
        }
      : { requestId: command.requestId, outcome: 'no_new_head', unstable: false }
  );
  return command.mode;
}

/** Polls the private Harness without presenting a bearer token. */
function pollHarness(client: ClientHttp2Session, binding: string) {
  return requestHttp2(client, 'POST', '/worker-control/harness/poll', '{"schemaVersion":2}', {
    'content-type': 'application/json',
    [integrationHeader]: binding,
  });
}

/** Settles one private Harness command. */
async function settleHarness(
  client: ClientHttp2Session,
  binding: string,
  command: EffectCommand,
  body: object
) {
  const response = await requestHttp2(
    client,
    'POST',
    '/worker-control/harness/result',
    JSON.stringify({
      body,
      disposition: 'succeeded',
      harnessInstanceId: command.harnessInstanceId,
      operationId: command.operationId,
      schemaVersion: 2,
      sequence: command.sequence,
    }),
    { 'content-type': 'application/json', [integrationHeader]: binding }
  );
  assert.equal(response.status, 204, responseFailure('Harness result', response));
}

/** Adapts SDK fetch calls onto the already-admitted native HTTP/2 connection. */
function h2Fetch(client: ClientHttp2Session): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const body = ['GET', 'HEAD'].includes(request.method)
      ? Buffer.alloc(0)
      : Buffer.from(await request.arrayBuffer());
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
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
    return new Response(
      response.bodyBytes.byteLength === 0 ? null : new Uint8Array(response.bodyBytes),
      {
        headers: responseHeaders,
        status: response.status,
      }
    );
  };
}

/** Sends one bounded request over the dedicated native HTTP/2 listener. */
function requestHttp2(
  client: ClientHttp2Session,
  method: string,
  path: string,
  body: string | Buffer = '',
  headers: Record<string, string> = {}
): Promise<Http2Response> {
  return new Promise<Http2Response>((resolveRequest, rejectRequest) => {
    const request = client.request({ ':method': method, ':path': path, ...headers });
    const chunks: Buffer[] = [];
    let responseHeaders: IncomingHttpHeaders = {};
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
function pickJson(response: Http2Response, keys: string[]) {
  const value = parseJson(response, 'JSON response') as unknown as Record<string, unknown>;
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

/** Parses one JSON response object. */
function parseJson(response: Http2Response, label: string): EffectCommand {
  try {
    const value = JSON.parse(response.body);
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    return value;
  } catch {
    throw new Error(`${label} was not a JSON object.`);
  }
}

/** Reads one required HTTP/2 response header. */
function header(response: Http2Response, name: string) {
  return requireString(response.headers[name], `Response header ${name}`);
}

/** Reads one required nonempty string. */
function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing.`);
  return value;
}

/** Formats a bounded private-route failure. */
function responseFailure(label: string, response: Http2Response) {
  return `${label} returned ${response.status}.`;
}

/** Propagates a public command failure without reading private process state. */
function throwIfFailed(failure: unknown) {
  if (failure) throw failure;
}

/** Waits for the real transport connection under the original finite deadline. */
async function waitForH2Connect(client: ClientHttp2Session) {
  await Promise.race([
    new Promise<void>((resolveConnect, rejectConnect) => {
      client.once('connect', resolveConnect);
      client.once('error', rejectConnect);
    }),
    sleep(10_000).then(() => {
      throw new Error('Timed out connecting to the NanoHost HTTP/2 listener.');
    }),
  ]);
}

/** Waits until the gateway-owned MCP stub no longer exists. */
async function waitForProcessExit(pid: number) {
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
async function assertPortClosed(port: number) {
  await new Promise<void>((resolveClosed, rejectOpen) => {
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
  return new Promise<number>((resolvePort, rejectPort) => {
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
function writeJson(path: string, value: object) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Resolves after a short polling delay. */
function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
