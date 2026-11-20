// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { allocateEntityId, PolicyDocumentV1Schema } from '@openkit/protocol';
import { policyDigest } from '@openkit/protocol/digest';
import { expect, it, onTestFinished } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import { readAdmittedPolicyDocument, recordPolicyWriteDecision } from '../policy/configuration.js';
import { preparePolicyDocument } from '../policy/statements.js';
import { findSchedulerAdmissionForTurn } from '../scheduler-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp, prepareTestAppOptions } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { createTestCoreDb, createTestStore, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createOpenKitAccessTokenRecord } from './access-token-store.js';
import { createBetterAuth } from './better-auth.js';
import { currentSchedulerAdmissionWorkspaceAuthority } from './operation-authorizer.js';

it.each(['token'] as const)(
  'inherits exact Tool restrictions from the actual asynchronous Task %s issuer',
  async (kind) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-async-credential-'));
    const coreDb = createTestCoreDb(dataRoot);
    onTestFinished(() => disposeTestStore(dataRoot, coreDb));
    ensureLocalUser(coreDb);
    const base = 'http://localhost:3000';
    const auth = createBetterAuth(coreDb, { env: { BETTER_AUTH_URL: base } });
    const response = await auth.handler(
      new Request(`${base}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Task owner',
          email: `${randomUUID()}@example.test`,
          password: randomUUID(),
        }),
      })
    );
    expect(response.status).toBe(200);
    const owner = (await response.json()).user;
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session).not.toBeNull();
    createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: owner.id,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const registeredIssuer = await auth.handler(
      new Request(`${base}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Task issuer',
          email: `${randomUUID()}@example.test`,
          password: randomUUID(),
        }),
      })
    );
    expect(registeredIssuer.status).toBe(200);
    const issuer = (await registeredIssuer.json()).user;
    const issuerCookie = registeredIssuer.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const issuerSession = await auth.api.getSession({
      headers: new Headers({ cookie: issuerCookie }),
    });
    const issuerAdmin = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: issuer.id,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Actual asynchronous credential boundary');
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: owner.id });
    const thread = await store.createThread(workspace.id, 'Client-owned Task');
    const setup = createTestAgentSetup({
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const manager = createRuntimeConfigManager({
      dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        ...prepareTestAppOptions({ coreDb, dataRoot }),
        dataRoot,
        agentManifests: [setup.manifest],
        workspaceConfigs: loadRuntimeConfig(dataRoot).workspaceConfigs,
        openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
      }),
    });
    const native = await createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () => manager.current(),
    });
    onTestFinished(async () => {
      await native.restore();
    });
    const appOptions = {
      mode: 'server' as const,
      coreDb,
      dataRoot,
      store,
      auth,
      turnExecutor: native.executor,
      fileAdmission: native.fileAdmission,
      workerControlGateway: native.workerControlGateway,
      runtimeConfigManager: manager,
      agentManifests: [setup.manifest],
      openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    };
    let app = createApp(appOptions);

    const command = (operation: string, input: Record<string, unknown>) =>
      app.request(`/api/app/operations/${operation}`, {
        method: 'POST',
        headers: {
          cookie: operation === 'token.create' ? issuerCookie : cookie,
          'content-type': 'application/json',
          ...(typeof input.requestId === 'string'
            ? { 'x-openkit-request-id': input.requestId }
            : {}),
        },
        body: JSON.stringify(input),
      });
    const issued = await command('token.create', {
      ownerUserId: owner.id,
      forMcpClient: true,
      scope: 'workspace',
      workspaceIds: [workspace.id],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    expect(issued.status).toBe(201);
    const client = await issued.json();
    const input = {
      workspaceId: workspace.id,
      threadId: thread.id,
      requestId: randomUUID(),
      input: 'Retain the initiating credential during this actual Task.',
    };
    const task =
      kind === 'token'
        ? await app.request('http://127.0.0.1/mcp', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${client.token}`,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'task_start', arguments: input },
            }),
          })
        : await command('task.start', input);
    expect(task.status, await task.clone().text()).toBe(kind === 'token' ? 200 : 202);
    const reply = await task.json();
    if (kind === 'token') expect(reply.result.isError, JSON.stringify(reply)).not.toBe(true);
    const accepted = kind === 'token' ? JSON.parse(reply.result.content[0].text) : reply;
    const execution = native.executionFor(accepted.turn.id);
    try {
      await execution.launched.promise;
      const admission = findSchedulerAdmissionForTurn(coreDb, {
        workspaceId: workspace.id,
        threadId: accepted.turn.threadId,
        turnId: accepted.turn.id,
      });
      expect(admission).not.toBeNull();
      expect(admission!.triggerActor).toEqual(
        kind === 'token'
          ? { kind: 'integration', id: client.record.tokenId, responsibleUserId: owner.id }
          : { kind: 'user', id: owner.id }
      );
      expect(admission!.credentialRef).toEqual({
        kind,
        id: kind === 'token' ? client.record.tokenId : session!.session.id,
      });
      const current = () =>
        currentSchedulerAdmissionWorkspaceAuthority(coreDb, admission!, 'thread.read', true, {
          mutating: false,
        });
      expect(current()).toBe(kind === 'token' ? 'member' : 'administrator');
      const worker = new Client({ name: 'fixture', version: '1.0.0' });
      onTestFinished(async () => {
        await worker.close();
      });
      await worker.connect(
        new StreamableHTTPClientTransport(
          new URL('http://localhost:3000/api/worker-capabilities/mcp/openkit-generative'),
          {
            fetch: (request, init) => app.fetch(new Request(request, init)),
            requestInit: {
              headers: {
                authorization: `Bearer ${native.executor.capabilityToken}`,
              },
            },
          }
        )
      );
      expect((await worker.listTools()).tools.map((tool) => tool.name)).toContain(
        'kernel_apps_list'
      );
      expect(await worker.callTool({ name: 'kernel_apps_list', arguments: {} })).not.toMatchObject({
        isError: true,
      });
      const proposed = PolicyDocumentV1Schema.parse({
        schemaVersion: 1,
        statements: [
          {
            kind: 'permission',
            id: 'issuer-current-restriction',
            state: 'active',
            effect: 'prohibit',
            grant: { kind: 'ordinary' },
            author: { kind: 'human', id: issuer.id },
            authority: { kind: 'human', userId: issuer.id },
            authoredAt: new Date().toISOString(),
            scope: {
              subjects: [{ kind: 'human', id: issuer.id }],
              actions: ['tool.use'],
              resources: [
                {
                  kind: 'mcp-tool',
                  workspaceId: workspace.id,
                  serverId: 'openkit-generative',
                  toolName: 'kernel_apps_list',
                },
              ],
            },
            lifetime: {
              anchor: {
                owner: { kind: 'workspace', workspaceId: workspace.id },
                kind: 'workspace',
                id: workspace.id,
              },
            },
          },
        ],
      });
      const prepared = preparePolicyDocument({
        current: { schemaVersion: 1, statements: [] },
        proposed,
        userId: issuer.id,
        now: new Date().toISOString(),
      });
      await recordPolicyWriteDecision({
        coreDb,
        actor: {
          kind: 'session',
          userId: issuer.id,
          sessionId: issuerSession!.session.id,
          adminTokenId: issuerAdmin.tokenId,
        },
        candidate: {
          artifactId: allocateEntityId('ar'),
          contentDigest: policyDigest(prepared.document),
        },
        proposal: {
          schemaVersion: 1,
          proposer: { kind: 'human', id: issuer.id },
          rationale: 'Apply the current restrictive issuer Policy.',
          baseRevision: policyDigest({ schemaVersion: 1, statements: [] }),
          proposed: prepared.document,
          validation: 'valid',
        },
        requestId: randomUUID(),
        threadId: thread.id,
        turnId: accepted.turn.id,
      });
      const document = readAdmittedPolicyDocument(coreDb, prepared.document);
      const currentManager = createRuntimeConfigManager({
        dataRoot,
        initialSnapshot: {
          ...manager.current(),
          openKitConfig: {
            ...manager.current().openKitConfig,
            policy: { ...manager.current().openKitConfig.policy, mediation: document },
          },
        },
      });
      app = createApp({ ...appOptions, runtimeConfigManager: currentManager });
      expect((await worker.listTools()).tools.map((tool) => tool.name)).not.toContain(
        'kernel_apps_list'
      );
      await expect(
        worker.callTool({ name: 'kernel_apps_list', arguments: {} })
      ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
    } finally {
      execution.completion.resolve();
      await execution.execution.catch(() => undefined);
    }
  },
  30_000
);
