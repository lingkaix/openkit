// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { findSchedulerAdmissionForTurn } from '../scheduler-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { createTestCoreDb, createTestStore, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createOpenKitAccessTokenRecord } from './access-token-store.js';
import { createBetterAuth } from './better-auth.js';
import { currentSchedulerAdmissionWorkspaceAuthority } from './operation-authorizer.js';

it.each([
  {
    name: 'keeps the initiating token current through native asynchronous Task admission',
    kind: 'token',
    handOff: false,
  },
  {
    name: 'keeps the initiating session current through native asynchronous Task admission',
    kind: 'session',
    handOff: false,
  },
  {
    name: 'reads a remote hand-off before and after Worker completion with the same bearer',
    kind: 'token',
    handOff: true,
  },
] as const)(
  '$name',
  async ({ kind, handOff }) => {
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
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Actual asynchronous credential boundary');
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: owner.id });
    const thread = await store.createThread(workspace.id, 'Client-owned Task');
    const native = await createNativeTaskAdmissionFixture(coreDb, store);
    onTestFinished(async () => {
      await native.restore();
    });
    const setup = createTestAgentSetup({
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const app = createApp({
      mode: 'server',
      coreDb,
      dataRoot,
      store,
      auth,
      turnExecutor: native.executor,
      fileAdmission: native.fileAdmission,
      workerControlGateway: native.workerControlGateway,
      agentManifests: [setup.manifest],
      openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    });
    const command = (operation: string, input: Record<string, unknown>) =>
      app.request(`/api/app/operations/${operation}`, {
        method: 'POST',
        headers: {
          cookie,
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
    const call = (name: string, arguments_: unknown) =>
      app.request('http://127.0.0.1/mcp', {
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
          params: { name, arguments: arguments_ },
        }),
      });
    const task =
      kind === 'token' ? await call('task_start', input) : await command('task.start', input);
    expect(task.status, await task.clone().text()).toBe(kind === 'token' ? 200 : 202);
    const reply = await task.json();
    if (kind === 'token') expect(reply.result.isError, JSON.stringify(reply)).not.toBe(true);
    const accepted = kind === 'token' ? JSON.parse(reply.result.content[0].text) : reply;
    const execution = native.executionFor(accepted.turn.id);
    try {
      await execution.launched.promise;
      if (handOff) {
        const { threadId, id: turnId } = accepted.turn;
        expect(threadId).toBe(thread.id);
        const readTurn = async () => {
          const response = await call('turn_read', { workspaceId: workspace.id, threadId, turnId });
          expect(response.status).toBe(200);
          const { result } = await response.json();
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          return JSON.parse(result.content[0].text);
        };
        const before = await readTurn();
        expect(before).toMatchObject({ id: turnId, threadId, status: 'running' });
        expect(before.items).not.toContainEqual(
          expect.objectContaining({ type: 'artifact-reference' })
        );

        // Simulate the controlled Worker's output through the real Artifact publication owner.
        const body = 'Result from the controlled Worker.';
        const title = 'Hand-off result';
        const requestId = randomUUID();
        const now = new Date().toISOString();
        const artifact = await store.createArtifact({
          id: testEntityId('ar', 'remote-handoff-result'),
          workspaceId: workspace.id,
          threadId,
          turnId,
          title,
          kind: 'summary',
          status: 'draft',
          summary: null,
          version: 1,
          content: { format: 'text', body },
          contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
          lastMutationRequestId: requestId,
          origin: { kind: 'turn-output', threadId, turnId, requestId },
          createdAt: now,
          updatedAt: now,
        });
        execution.completion.resolve();
        await execution.execution;

        const after = await readTurn();
        expect(after).toMatchObject({ id: turnId, threadId, status: 'completed' });
        expect(after.items).toContainEqual(
          expect.objectContaining({
            type: 'artifact-reference',
            artifactId: artifact.id,
            artifactVersion: artifact.version,
            title,
          })
        );
        return;
      }
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
      const revoked =
        kind === 'token'
          ? await command('credential.revoke', { kind: 'access-token', id: client.record.tokenId })
          : await auth.handler(
              new Request(`${base}/api/auth/revoke-session`, {
                method: 'POST',
                headers: { cookie, origin: base, 'content-type': 'application/json' },
                body: JSON.stringify({ token: session!.session.token }),
              })
            );
      expect(revoked.status, await revoked.clone().text()).toBe(200);
      expect(current()).toBeNull();
    } finally {
      execution.completion.resolve();
      await execution.execution.catch(() => undefined);
    }
  },
  30_000
);
