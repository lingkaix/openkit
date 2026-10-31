import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActivateWorkerEnvironmentResponse,
  PrepareWorkerEnvironmentResponse,
} from '@openkit/app-api-schemas';
import { AuthoredAgentConfigSchema } from '@openkit/config-schema';
import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import type { BetterAuthServer } from '../auth/middleware.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  listSchedulerExecutionAttemptsForTurn,
  requireSchedulerExecutionAttempt,
} from '../runtime/execution-attempt-records.js';
import type {
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from '../runtime/nanohost-session-dispatch.js';
import { resolvePublicNativeEnvironment } from '../runtime/native-environment.js';
import * as schedulerDispatch from '../runtime/scheduler-dispatch-loop.js';
import type { WorkerGovernanceBackend } from '../runtime/worker-governance-backend.js';
import { writeWorkerImageSettlement } from '../runtime/worker-image-settlements.js';
import { getWorkerStorageBindingForSandbox } from '../runtime/worker-storage-bindings.js';
import { listSchedulerAdmissionEntriesForWorkspace } from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createAppWithLocalIdentity as createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { operationRequest } from '../test-support/operation-request.js';
import {
  ensureUserQuickChatWorkspace,
  recordWorkspaceOwnerMembership,
} from '../workspace-membership.js';

const OWNER_SESSION_HEADER = 'x-openkit-worker-environment-owner-session';
const AGENT_ID = 'agent_codex_host';
const CONFIGURATION_FILE_ID = 'agents/codex.agent.jsonc';
const IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
const DECLARATION = {
  kind: 'reference' as const,
  pullPolicy: 'if-not-present' as const,
  ref: 'registry.example.com/openkit/worker-codex:browser',
};
const IMAGE_INSPECTION = {
  digest: IMAGE_DIGEST,
  platform: { architecture: 'arm64', os: 'linux' },
  storageLayout: {
    family: 'openkit-worker',
    gid: 1000,
    targets: [{ target: '/sandbox' }, { target: '/workspace' }],
    uid: 1000,
    version: '1',
    workingDirectory: '/tmp/openkit-bootstrap',
  },
} as const;
/** Returns an auth server that leaves bearer-token authentication to NanoCore. */
function noSessionAuth(): BetterAuthServer {
  return {
    api: { getSession: async () => null },
    handler: async () => new Response(null, { status: 404 }),
  };
}

/** Returns the current-user session used to intersect Workspace and deployment-admin authority. */
function ownerSessionAuth(userId: string): BetterAuthServer {
  return {
    api: {
      getSession: async ({ headers }) =>
        headers.get(OWNER_SESSION_HEADER) === '1'
          ? { session: { id: 'session_worker_environment_owner' }, user: { id: userId } }
          : null,
    },
    handler: async () => new Response(null, { status: 404 }),
  };
}

/** Creates the active canonical human through the ordinary signup owner. */
async function createCanonicalUser(coreDb: CoreDb): Promise<string> {
  const { user } = await createBetterAuth(coreDb, { env: {} }).api.signUpEmail({
    body: { name: 'Owner', email: randomUUID() + '@example.invalid', password: randomUUID() },
  });
  return user.id;
}

/** Creates the fixed image acquire and inspect boundary used by the real App composition. */
function createNanoHostDispatch(
  coreDb: CoreDb,
  effect: ReturnType<typeof vi.fn>
): NanoHostSessionDispatch {
  return {
    async effect(requestOrConnection, carriedRequest) {
      const request = (carriedRequest ?? requestOrConnection) as NanoHostSessionEffectRequest;
      const result = (await effect(request)) as { digest?: string };
      if (
        request.imageSettlement &&
        (request.kind === 'image.acquire' || request.kind === 'image.build')
      )
        writeWorkerImageSettlement(coreDb, {
          ...request.imageSettlement,
          requestId: request.requestId,
          operation: request.kind,
          outcome: { kind: 'success', imageDigest: result.digest! },
        });
      return result;
    },
    async fileExportResult() {},
    async imageBuildInput() {
      throw new Error('Unexpected image build input request.');
    },
    async poll() {
      return null;
    },
    async result() {},
    async route() {
      throw new Error('Unexpected NanoHost semantic route.');
    },
  };
}

/** Computes the runtime configuration service's exact content revision. */
function contentRevision(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** Persists the same credential-free model catalog used before and after safe config reload. */
function writeReloadableModelCatalog(dataRoot: string): void {
  writeFileSync(
    join(dataRoot, 'config', 'providers', 'worker-environment-fixture.provider.jsonc'),
    `${JSON.stringify(
      {
        displayName: 'Worker environment fixture provider',
        id: 'worker-environment-fixture',
        kind: 'local',
        models: ['openai/gpt-5.2'],
        schemaVersion: 1,
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(dataRoot, 'config', 'gateway.jsonc'),
    `${JSON.stringify(
      {
        defaultLogicalModelId: 'smart',
        enabled: true,
        logicalModels: [
          {
            contextManagement: [{ compactThreshold: 8_000, type: 'compaction' }],
            displayName: 'Smart',
            id: 'smart',
            routes: [
              {
                id: 'worker-environment-fixture',
                providerModel: 'openai/gpt-5.2',
                providerProfileId: 'worker-environment-fixture',
              },
            ],
          },
        ],
        requiredFeatures: [],
        schemaVersion: 1,
      },
      null,
      2
    )}\n`
  );
}

describe('Worker environment App composition', () => {
  it.each([
    false,
    true,
  ])('prepares and activates confirmed defaults with already-pinned=%s, replays, and denies non-admin entry', async (alreadyPinned) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-environment-app-'));
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const USER_ID = await createCanonicalUser(coreDb);
      const store = new FsStore({ dataRoot });
      await ensureUserQuickChatWorkspace({ coreDb, store, userId: USER_ID });
      const privateWorkspace = await store.ensureQuickChatWorkspace(USER_ID);
      const administrationThread = await store.createThread(
        privateWorkspace.id,
        'Administration',
        testEntityId('th', 'thread_worker_environment_app'),
        'administration',
        { privateOwnerUserId: USER_ID, visibility: 'private' }
      );
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: USER_ID,
        scope: 'server-admin',
        workspaceIds: [],
      });
      const workspaceToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: USER_ID,
        scope: 'workspace',
        workspaceIds: [privateWorkspace.id],
      });
      const agentPath = join(dataRoot, 'config', CONFIGURATION_FILE_ID);
      if (alreadyPinned) {
        const manifest = parse(readFileSync(agentPath, 'utf8'));
        manifest.runtime.image = { kind: 'reference', pullPolicy: 'never', ref: IMAGE_DIGEST };
        writeFileSync(agentPath, JSON.stringify(manifest, null, 2));
      }
      const initialAgentContent = readFileSync(agentPath, 'utf8');
      const initialRevision = contentRevision(initialAgentContent);
      const values = { PUBLIC_SETTING: 'confirmed-native-default' };
      const defaultsDigest = `sha256:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
      const nanoHostEffect = vi.fn(async (request: NanoHostSessionEffectRequest) => {
        if (request.kind === 'image.acquire') return { digest: IMAGE_DIGEST };
        if (request.kind === 'image.inspect')
          return {
            ...IMAGE_INSPECTION,
            environmentDefaults: {
              defaultsDigest,
              values,
            },
          };
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      });
      const createResponses = vi.fn(async () => {
        throw new Error('Private administration provider dispatch must remain denied.');
      });
      const runtimeConfigManager = createRuntimeConfigManager({ dataRoot });
      const actualReload = runtimeConfigManager.reload.bind(runtimeConfigManager);
      const nativeAtReload: ReturnType<typeof resolvePublicNativeEnvironment>[] = [];
      const reload = vi.spyOn(runtimeConfigManager, 'reload').mockImplementation((input) => {
        nativeAtReload.push(
          resolvePublicNativeEnvironment(
            coreDb,
            AuthoredAgentConfigSchema.parse(parse(readFileSync(agentPath, 'utf8')))
          )
        );
        return actualReload(input);
      });
      const app = createApp({
        runtimeConfigManager,
        auth: noSessionAuth(),
        coreDb,
        dataRoot,
        llmGatewayDispatcher: { createResponses },
        mode: 'server',
        nanoHostSessionDispatch: createNanoHostDispatch(coreDb, nanoHostEffect),
        store,
      });
      const adminHeaders = {
        authorization: `Bearer ${admin.secret}`,
        'content-type': 'application/json',
      };

      const preparedResponse = await app.request(
        ...operationRequest(
          'worker-environment.prepare',
          {},
          {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({
              administrationThreadId: administrationThread.id,
              configuration: {
                expectedRevision: initialRevision,
                fileId: CONFIGURATION_FILE_ID,
              },
              declaration: DECLARATION,
              replaceNow: null,
              requestId: '11111111-1111-4111-8111-111111111111',
              target: { agentId: AGENT_ID, kind: 'agent' },
            }),
          }
        )
      );
      const prepared = (await preparedResponse.json()) as PrepareWorkerEnvironmentResponse;

      expect(preparedResponse.status).toBe(200);
      expect(prepared).toMatchObject({
        affectedStorage: [],
        configuration: {
          expectedRevision: initialRevision,
          fileId: CONFIGURATION_FILE_ID,
        },
        image: {
          ...IMAGE_INSPECTION,
          environmentDefaults: {
            defaultsDigest,
            classification: 'unadmitted',
            names: ['PUBLIC_SETTING'],
          },
        },
        replaceNow: null,
        target: { agentId: AGENT_ID, kind: 'agent' },
      });
      expect(prepared.authoredCandidate.artifactVersion).toBe(1);
      expect(prepared.resolvedCandidate.artifactVersion).toBe(1);
      expect(prepared.authoredCandidate.artifactId).not.toBe(prepared.resolvedCandidate.artifactId);
      expect(
        store
          .listArtifacts(privateWorkspace.id)
          .map((artifact) => JSON.parse(artifact.content.body) as { kind?: string })
          .map((artifact) => artifact.kind)
      ).toEqual(['worker-environment-authored-candidate', 'worker-environment-resolved-candidate']);
      expect(nanoHostEffect.mock.calls.map(([request]) => request.kind)).toEqual([
        'image.acquire',
        'image.inspect',
      ]);

      if (alreadyPinned) {
        expect(() =>
          resolvePublicNativeEnvironment(
            coreDb,
            AuthoredAgentConfigSchema.parse(parse(initialAgentContent))
          )
        ).toThrow(
          expect.objectContaining({ code: 'worker_environment_preparation_required', status: 409 })
        );
      }
      const prepareRequestId = '11111111-1111-4111-8111-111111111111';
      const logicalPreparation = {
        administrationThreadId: administrationThread.id,
        requestId: prepareRequestId,
        configuration: prepared.configuration,
        declaration: DECLARATION,
        target: prepared.target,
      };
      const logicalRecovery = {
        administrationThreadId: administrationThread.id,
        requestId: '33333333-3333-4333-8333-333333333333',
        recoverFrom: prepared.authoredCandidate,
      };
      const beforeArtifacts = store.listArtifacts(privateWorkspace.id);
      const beforeTurns = store.listThreadTurns(privateWorkspace.id, administrationThread.id);
      const beforeEffects = nanoHostEffect.mock.calls.length;
      for (const [operation, input] of [
        ['worker-environment.prepare', logicalPreparation],
        ['worker-environment.recover', logicalRecovery],
      ] as const) {
        const response = await app.request(
          ...operationRequest(operation, {}, { headers: adminHeaders, body: JSON.stringify(input) })
        );
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result).toMatchObject({
          authoredCandidate: prepared.authoredCandidate,
          resolvedCandidate: prepared.resolvedCandidate,
          requestId: input.requestId,
          replaceNow: null,
        });
        const remote = await app.request('/mcp', {
          method: 'POST',
          headers: { ...adminHeaders, accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'openkit_call', arguments: { operation, input } },
          }),
        });
        expect(remote.status).toBe(200);
        const remoteBody = await remote.json();
        expect(remoteBody.result.isError).not.toBe(true);
        expect(JSON.parse(remoteBody.result.content[0].text)).toEqual(result);
        const conflict = await app.request(`/api/app/operations/${operation}`, {
          method: 'POST',
          headers: {
            ...adminHeaders,
            'x-openkit-request-id': '44444444-4444-4444-8444-444444444444',
          },
          body: JSON.stringify(input),
        });
        expect(conflict.status).toBe(403);
        expect(await conflict.json()).toMatchObject({
          code: 'bound_input_conflict',
          message: 'Request identity conflicts with its header.',
        });
      }
      for (const operation of [
        'worker-environment.prepare',
        'worker-environment.recover',
      ] as const) {
        const input =
          operation === 'worker-environment.prepare'
            ? { ...logicalPreparation, requestId: logicalRecovery.requestId }
            : { ...logicalRecovery, requestId: prepareRequestId };
        const httpConflict = await app.request(
          ...operationRequest(operation, {}, { headers: adminHeaders, body: JSON.stringify(input) })
        );
        expect(httpConflict.status).toBe(409);
        expect(await httpConflict.json()).toMatchObject({ code: 'idempotency_key_conflict' });
        const remoteConflict = await app.request('/mcp', {
          method: 'POST',
          headers: { ...adminHeaders, accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'openkit_call', arguments: { operation, input } },
          }),
        });
        const remoteBody = await remoteConflict.json();
        expect(remoteBody.result.isError).toBe(true);
        expect(JSON.parse(remoteBody.result.content[0].text)).toMatchObject({
          code: 'idempotency_key_conflict',
          status: 409,
        });
      }
      const foreignUserId = 'usr_00000000-0000-7d99-87e6-45245a236d32';
      coreDb.sqlite
        .prepare(
          `INSERT INTO users (id, display_name, email, email_verified, image, created_at, updated_at, kind, last_seen_at) VALUES (?, 'Foreign Administrator', 'foreign@example.test', false, NULL, ?, ?, 'human', NULL)`
        )
        .run(foreignUserId, Date.now(), Date.now());
      await ensureUserQuickChatWorkspace({ coreDb, store, userId: foreignUserId });
      const foreignHome = await store.ensureQuickChatWorkspace(foreignUserId);
      const foreignThread = await store.createThread(
        foreignHome.id,
        'Foreign administration',
        testEntityId('th', 'thread_foreign_administration'),
        'administration',
        { visibility: 'private', privateOwnerUserId: foreignUserId }
      );
      const foreignAdmin = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: foreignUserId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
      for (const [operation, input] of [
        ['worker-environment.prepare', logicalPreparation],
        ['worker-environment.recover', logicalRecovery],
      ] as const) {
        for (const [secret, refusedInput, status, code] of [
          [workspaceToken.secret, input, 403, 'deployment_admin_required'],
          [
            foreignAdmin.secret,
            operation === 'worker-environment.recover'
              ? {
                  ...input,
                  administrationThreadId: foreignThread.id,
                  requestId: '55555555-5555-4555-8555-555555555555',
                }
              : { ...input, requestId: '66666666-6666-4666-8666-666666666666' },
            404,
            'not_found',
          ],
        ] as const) {
          const refusal = await app.request(
            ...operationRequest(
              operation,
              {},
              {
                headers: { ...adminHeaders, authorization: `Bearer ${secret}` },
                body: JSON.stringify(refusedInput),
              }
            )
          );
          expect(refusal.status).toBe(status);
          expect(await refusal.json()).toMatchObject({ code });
          const remote = await app.request('/mcp', {
            method: 'POST',
            headers: {
              ...adminHeaders,
              authorization: `Bearer ${secret}`,
              accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: { name: 'openkit_call', arguments: { operation, input: refusedInput } },
            }),
          });
          const remoteBody = await remote.json();
          expect(remoteBody.result.isError).toBe(true);
          expect(JSON.parse(remoteBody.result.content[0].text)).toMatchObject({ status, code });
          expect(store.listThreadTurns(foreignHome.id, foreignThread.id)).toEqual([]);
        }
      }
      expect(nanoHostEffect.mock.calls).toHaveLength(beforeEffects);
      expect(store.listArtifacts(privateWorkspace.id)).toEqual(beforeArtifacts);
      expect(store.listThreadTurns(privateWorkspace.id, administrationThread.id)).toEqual(
        beforeTurns
      );

      const activationInput = {
        affectedStorage: prepared.affectedStorage,
        configuration: prepared.configuration,
        confirmation: prepared.activationConfirmation,
        replaceNow: prepared.replaceNow,
        requestId: '22222222-2222-4222-8222-222222222222',
        resolvedCandidate: prepared.resolvedCandidate,
        target: prepared.target,
      };
      const activatedResponse = await app.request(
        ...operationRequest(
          'worker-environment.activate',
          {},
          {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify(activationInput),
          }
        )
      );
      const activated = (await activatedResponse.json()) as ActivateWorkerEnvironmentResponse;
      const activatedAgentContent = readFileSync(agentPath, 'utf8');

      expect(activatedResponse.status, JSON.stringify(activated)).toBe(200);
      expect(activated).toMatchObject({
        affected: [],
        configuration: {
          fileId: CONFIGURATION_FILE_ID,
          revision: contentRevision(activatedAgentContent),
        },
        replaceNow: null,
        requestId: '22222222-2222-4222-8222-222222222222',
        resolvedCandidate: prepared.resolvedCandidate,
        target: prepared.target,
      });
      expect(parse(activatedAgentContent)).toMatchObject({
        id: AGENT_ID,
        runtime: {
          image: { kind: 'reference', pullPolicy: 'never', ref: IMAGE_DIGEST },
        },
      });
      if (alreadyPinned) {
        expect(activatedAgentContent).toBe(initialAgentContent);
        expect(contentRevision(activatedAgentContent)).toBe(initialRevision);
      } else {
        expect(activatedAgentContent).not.toBe(initialAgentContent);
      }
      expect(
        resolvePublicNativeEnvironment(
          coreDb,
          AuthoredAgentConfigSchema.parse(parse(activatedAgentContent))
        )
      ).toEqual({
        imageDigest: IMAGE_DIGEST,
        defaultsDigest,
        values,
      });
      expect(nativeAtReload).toEqual([{ imageDigest: IMAGE_DIGEST, defaultsDigest, values }]);
      expect(reload).toHaveReturnedWith(expect.objectContaining({ status: 'applied' }));
      expect(reload).toHaveBeenCalledTimes(1);
      const effectsBeforeReplay = nanoHostEffect.mock.calls.length;
      const replay = await app.request(
        ...operationRequest(
          'worker-environment.activate',
          {},
          {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify(activationInput),
          }
        )
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(activated);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(nanoHostEffect).toHaveBeenCalledTimes(effectsBeforeReplay);
      expect(readFileSync(agentPath, 'utf8')).toBe(activatedAgentContent);
      const resultArtifacts = store
        .listArtifacts(privateWorkspace.id)
        .filter((artifact) => artifact.title === 'Worker environment activation result');
      expect(resultArtifacts).toHaveLength(1);
      expect(JSON.parse(resultArtifacts[0]!.content.body)).toEqual(activated);

      const denied = await app.request(
        ...operationRequest(
          'administration.conversation-submit',
          {},
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${workspaceToken.secret}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              input: 'Prepare another Worker environment.',
              requestId: '33333333-3333-4333-8333-333333333333',
              threadId: administrationThread.id,
            }),
          }
        )
      );

      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
      expect(createResponses).not.toHaveBeenCalled();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('waits for resident interrupted cleanup before admitting a same-storage successor', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-environment-replacement-app-'));
    const coreDb = openCoreDb(dataRoot);
    const dispatchObservation = vi.spyOn(schedulerDispatch, 'runSchedulerDispatchLoop');
    const collectionEntered = Promise.withResolvers<void>();
    const releaseCollection = Promise.withResolvers<void>();
    const entered: { turnId: string; execution: Promise<void> }[] = [];
    let native: ReturnType<typeof createNativeTaskAdmissionFixture> | undefined;
    let restoreCollection: (() => void) | undefined;
    let responseSettled = false;
    let successorDispatch:
      | ReturnType<typeof schedulerDispatch.runSchedulerDispatchLoop>
      | undefined;

    try {
      applyMigrations(coreDb);
      const USER_ID = await createCanonicalUser(coreDb);
      const store = await createDemoStore({ dataRoot }, USER_ID);
      await ensureUserQuickChatWorkspace({ coreDb, store, userId: USER_ID });
      const privateWorkspace = await store.ensureQuickChatWorkspace(USER_ID);
      const administrationThread = await store.createThread(
        privateWorkspace.id,
        'Administration',
        testEntityId('th', 'thread_worker_environment_replacement'),
        'administration',
        { privateOwnerUserId: USER_ID, visibility: 'private' }
      );
      const productWorkspace = store
        .listWorkspaces()
        .find((workspace) => workspace.kind === 'code');
      const productThread = productWorkspace
        ? store.listThreads(productWorkspace.id)[0]
        : undefined;
      if (!productWorkspace || !productThread) throw new Error('Demo product Workspace is absent.');
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: USER_ID,
        workspaceId: productWorkspace.id,
      });
      createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId: USER_ID,
        scope: 'server-admin',
        workspaceIds: [],
      });
      writeReloadableModelCatalog(dataRoot);
      const sessionHeaders = { [OWNER_SESSION_HEADER]: '1' };
      const agentPath = join(dataRoot, 'config', CONFIGURATION_FILE_ID);
      const nanoHostEffect = vi.fn(async (request: NanoHostSessionEffectRequest) => {
        if (request.kind === 'image.acquire') return { digest: IMAGE_DIGEST };
        if (request.kind === 'image.inspect')
          return {
            ...IMAGE_INSPECTION,
            platform: { architecture: 'amd64', os: 'linux' },
            storageLayout: {
              ...IMAGE_INSPECTION.storageLayout,
              targets: ['/openkit/threads', '/sandbox', '/workspace'].map((target) => ({ target })),
            },
            environmentDefaults: {
              defaultsDigest:
                'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
              values: {},
            },
          };
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      });
      const agentSetupOptions = {
        logicalModelId: 'smart',
        privateRoute: {
          providerModel: 'openai/gpt-5.2',
          providerProfileId: 'worker-environment-fixture',
        },
        requiredCapabilities: ['trusted-worker-inference-relay'],
      } satisfies Parameters<typeof createTestAgentSetup>[0];
      const agentSetup = createTestAgentSetup(agentSetupOptions);
      writeFileSync(agentPath, JSON.stringify(agentSetup.manifest, null, 2));
      const initialRevision = contentRevision(readFileSync(agentPath, 'utf8'));
      const runtimeConfigManager = createRuntimeConfigManager({ dataRoot });
      admitTestNativeEnvironment(coreDb, agentSetup.manifest, {}, IMAGE_DIGEST);
      native = createNativeTaskAdmissionFixture(coreDb, store, {
        readRuntimeConfig: () => runtimeConfigManager.current(),
      });
      const executor = native.executor;
      const start = executor.startTurn.bind(executor);
      executor.startTurn = (...args) => {
        const execution = start(...args);
        entered.push({ turnId: args[1], execution });
        return execution;
      };
      const backend = executor.executionBackend as WorkerGovernanceBackend;
      const collect = backend.collectTranscript.bind(backend);
      const collection = vi
        .spyOn(backend, 'collectTranscript')
        .mockImplementation(async (...args) => {
          const transcript = await collect(...args);
          collectionEntered.resolve();
          await releaseCollection.promise;
          return transcript;
        });
      restoreCollection = () => collection.mockRestore();
      const app = createApp({
        agentManifests: [agentSetup.manifest],
        auth: ownerSessionAuth(USER_ID),
        runtimeConfigManager,
        fileAdmission: native.fileAdmission,
        workerControlGateway: native.workerControlGateway,
        coreDb,
        dataRoot,
        gatewayConfig: createTestGatewayConfig(agentSetupOptions),
        mode: 'server',
        nanoHostSessionDispatch: createNanoHostDispatch(coreDb, nanoHostEffect),
        openKitConfig: { defaults: { defaultAgentId: AGENT_ID } },
        providerRegistry: new ProviderRegistry([
          {
            defaultModel: 'openai/gpt-5.2',
            displayName: 'Worker environment fixture provider',
            id: 'worker-environment-fixture',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
        store,
        turnExecutor: executor,
      });

      const predecessorResponse = await app.request(
        ...operationRequest(
          'turn.start',
          {},
          {
            method: 'POST',
            headers: { ...sessionHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
              input: 'Keep the resident Worker active until replacement.',
              requestId: '44444444-4444-4444-8444-444444444444',
              threadId: productThread.id,
              workspaceId: productWorkspace.id,
            }),
          }
        )
      );
      const predecessor = (await predecessorResponse.json()) as {
        id: string;
        status: string;
      };
      expect(predecessorResponse.status, JSON.stringify(predecessor)).toBe(202);
      await native.executionFor(predecessor.id).launched.promise;
      await vi.waitFor(() =>
        expect(store.getTurnById(predecessor.id)).toMatchObject({
          agentSessionId: expect.any(String),
          status: 'running',
        })
      );
      const storedPredecessor = store.getTurnById(predecessor.id);
      expect(storedPredecessor).toMatchObject({
        agentSessionId: expect.any(String),
        status: 'running',
      });
      if (!storedPredecessor.agentSessionId) throw new Error('Predecessor AgentSession is absent.');
      const predecessorLease = listSchedulerExecutionAttemptsForTurn(coreDb, {
        threadId: productThread.id,
        turnId: predecessor.id,
        workspaceId: productWorkspace.id,
      })[0];
      if (!predecessorLease) throw new Error('Predecessor scheduler lease is absent.');
      const attached = getWorkerStorageBindingForSandbox(coreDb, {
        sandboxBindingRef: predecessorLease.bindingRef!,
      });
      if (!attached) throw new Error('Predecessor native storage is absent.');

      const preparedResponse = await app.request(
        ...operationRequest(
          'worker-environment.prepare',
          {},
          {
            method: 'POST',
            headers: { ...sessionHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
              administrationThreadId: administrationThread.id,
              configuration: {
                expectedRevision: initialRevision,
                fileId: CONFIGURATION_FILE_ID,
              },
              declaration: DECLARATION,
              replaceNow: {
                prompt: 'Continue with the resolved Worker image.',
                threadId: productThread.id,
                workspaceId: productWorkspace.id,
              },
              requestId: '55555555-5555-4555-8555-555555555555',
              target: { agentId: AGENT_ID, kind: 'agent' },
            }),
          }
        )
      );
      const prepared = (await preparedResponse.json()) as PrepareWorkerEnvironmentResponse;
      expect(preparedResponse.status).toBe(200);
      expect(prepared.affectedStorage).toEqual([
        { expectedRevision: attached.revision, storageRef: attached.storageRef },
      ]);

      const activationResponsePromise = app.request(
        ...operationRequest(
          'worker-environment.activate',
          {},
          {
            method: 'POST',
            headers: { ...sessionHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
              affectedStorage: prepared.affectedStorage,
              configuration: prepared.configuration,
              confirmation: prepared.activationConfirmation,
              replaceNow: prepared.replaceNow,
              requestId: '66666666-6666-4666-8666-666666666666',
              resolvedCandidate: prepared.resolvedCandidate,
              target: prepared.target,
            }),
          }
        )
      );
      void activationResponsePromise.then(() => {
        responseSettled = true;
      });
      // Join the existing collection hold point within this case's original timeout.
      await Promise.race([
        collectionEntered.promise,
        activationResponsePromise.then(() => {
          throw new Error('Activation completed before transcript collection was held.');
        }),
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const beforeTerminalTurnIds = store
        .listThreadTurns(productWorkspace.id, productThread.id)
        .map((turn) => turn.id);

      expect(responseSettled).toBe(false);
      releaseCollection.resolve();
      // Join the actual HTTP acknowledgment within the existing test timeout.
      const activationResponse = await activationResponsePromise;
      expect(responseSettled).toBe(true);
      const activation = (await activationResponse.json()) as ActivateWorkerEnvironmentResponse;
      const productTurns = store.listThreadTurns(productWorkspace.id, productThread.id);
      const successor = productTurns.find((turn) => turn.id !== predecessor.id);
      if (!successor) throw new Error('Same-storage successor Turn is absent.');
      const entry = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        statuses: ['queued', 'admitted'],
        workspaceId: productWorkspace.id,
      }).find((candidate) => candidate.turnId === successor.id);
      if (!entry) throw new Error('Same-storage successor admission is absent.');
      const original = await vi.waitFor(() => {
        const call = dispatchObservation.mock.calls.find(
          ([input]) => input.coreDb === coreDb && input.callerQueueEntryId === entry.queueEntryId
        )?.[0];
        if (!call) throw new Error('Original successor dispatch has not entered.');
        return call;
      });
      // App acknowledgment precedes dispatch; run the server's ordinary queued-work pass.
      successorDispatch = schedulerDispatch.runSchedulerDispatchLoop(original);
      const launched = native.executionFor(successor.id).launched.promise;
      await Promise.race([
        launched,
        successorDispatch.then((result) => {
          expect(result.startedTurns.map((start) => start.dispatch.entry.turnId)).toContain(
            successor.id
          );
          return launched;
        }),
      ]);
      await vi.waitFor(() => expect(executor.launches).toBe(2));

      expect(beforeTerminalTurnIds).toEqual([predecessor.id]);
      expect(activationResponse.status).toBe(200);
      expect(activation).toMatchObject({
        affected: [
          {
            expectedRevision: attached.revision,
            storageRef: attached.storageRef,
          },
        ],
        configuration: { fileId: CONFIGURATION_FILE_ID },
      });
      expect(parse(readFileSync(agentPath, 'utf8'))).toMatchObject({
        runtime: {
          image: { kind: 'reference', pullPolicy: 'never', ref: IMAGE_DIGEST },
        },
      });
      expect(store.getTurnById(predecessor.id).status).toBe('interrupted');
      await vi.waitFor(() =>
        expect(store.getTurnById(successor.id)).toMatchObject({ status: 'running' })
      );
      expect(entered.map((entry) => entry.turnId)).toEqual([predecessor.id, successor.id]);
      // Durable Scheduler Design retains the first cancellation cause and exact terminal outcome.
      expect(requireSchedulerExecutionAttempt(coreDb, predecessorLease.attemptId)).toMatchObject({
        phase: 'closed',
        terminalCause: 'turn-cancelled',
        outcomeRef: `turn:${predecessor.id}:interrupted`,
        fenceRef: expect.any(String),
      });
      const successorAdmission = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        statuses: ['admitted'],
        workspaceId: productWorkspace.id,
      }).find((entry) => entry.turnId === successor.id);
      expect(successorAdmission?.workerStorageChoice).toMatchObject({
        expectedRevision: attached.revision,
        kind: 'selected',
        storageRef: attached.storageRef,
      });
    } finally {
      releaseCollection.resolve();
      for (const entry of entered) native?.executionFor(entry.turnId).completion.resolve();
      await Promise.allSettled(entered.map((entry) => entry.execution));
      await successorDispatch?.catch(() => undefined);
      restoreCollection?.();
      await native?.restore();
      if (!responseSettled) {
        const observations = await Promise.all(
          dispatchObservation.mock.results.flatMap((result, index) =>
            dispatchObservation.mock.calls[index]?.[0].coreDb === coreDb && result.type === 'return'
              ? [Promise.resolve(result.value)]
              : []
          )
        );
        console.info(
          'worker-environment-replacement-dispatch',
          JSON.stringify(
            observations.map((result) => ({
              startedTurns: result.startedTurns.map((started) => ({
                turnId: started.dispatch.entry.turnId,
                attemptId: started.dispatch.attempt.attemptId,
              })),
              terminalResult: result.terminalResult,
            }))
          )
        );
        console.info(
          'worker-environment-replacement-owners',
          JSON.stringify({
            admissions: coreDb.sqlite
              .prepare(
                'SELECT queue_entry_id, request_id, turn_id, status FROM scheduler_admission_entries'
              )
              .all(),
            attempts: coreDb.sqlite
              .prepare(
                'SELECT attempt_id, turn_id, phase, disposition, operation_id, terminal_cause, fence_ref FROM scheduler_execution_attempts'
              )
              .all(),
          })
        );
      }
      dispatchObservation.mockRestore();
      coreDb.sqlite.close();
    }
  });
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
