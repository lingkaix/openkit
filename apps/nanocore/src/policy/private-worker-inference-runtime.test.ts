// openkit-test-platform: posix
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NON_API_EXPOSURE_DEFINITIONS } from '@openkit/app-api-schemas';
import { allocateEntityId, type PolicyDocumentV1, PolicyDocumentV1Schema } from '@openkit/protocol';
import { Hono } from 'hono';
import { expect, it, onTestFinished } from 'vitest';
import { WorkerControlClient } from '../../../../packages/worker-shim/src/control-client.js';
import { createApp, createDefaultWorkerControlGateway } from '../app.js';
import {
  createOpenKitAccessTokenRecord,
  resolveSessionDeploymentAdminTokenId,
} from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import type { Actor } from '../auth/identity.js';
import { type AuthVariables, createAuthMiddleware } from '../auth/middleware.js';
import {
  currentSchedulerAdmissionWorkspaceAuthority,
  currentWorkerLineageWorkspaceAuthority,
  evaluateProductAuthorization,
} from '../auth/operation-authorizer.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { createAdministrationConfiguration } from '../config/administration-configuration.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { readAdmittedPolicyDocument } from '../policy/configuration.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  acceptSchedulerExecutionObservation,
  schedulerExecutionCorrelation,
} from '../runtime/execution-attempt-records.js';
import { requireNanoHostExecutionAttempt } from '../runtime/nanohost-attempt-records.js';
import { hashWorkerRouteToken } from '../runtime/worker-control-gateway.js';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { closeWorkspaceProductReadHandles } from '../storage/control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openAdmittedTestNanoHost } from '../test-support/admitted-nanohost.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { submitTestNanoHostWorkerLease } from '../test-support/nanohost-worker-lease.js';
import { operationRequest } from '../test-support/operation-request.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { schedulerFixtureInput } from '../test-support/scheduler-admissions.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
  disposeTestStore,
} from '../test-support/store.js';

const BASE = 'http://localhost:3000';
const GROUP = 'llm-gateway';
const EXPIRY = '2999-01-01T00:00:00.000Z';

/** The landed A control; H identifies the real author, never every evaluated caller. */
function control(human: string, state: 'active' | 'inactive' = 'active', group = GROUP) {
  return {
    id: 'runtime-gateway-control',
    kind: 'permission' as const,
    state,
    author: { kind: 'human' as const, id: human },
    authority: { kind: 'human' as const, userId: human },
    authoredAt: '2026-01-01T00:00:00.000Z',
    effect: 'prohibit' as const,
    grant: { kind: 'ordinary' as const },
    scope: {
      subjects: [{ kind: 'human' as const, id: human }],
      actions: ['workspace.configure'],
      resources: [
        {
          kind: 'container' as const,
          container: {
            owner: { kind: 'server' as const },
            kind: 'route-group-switch',
            id: group,
          },
        },
      ],
    },
    lifetime: {
      anchor: {
        owner: { kind: 'server' as const },
        kind: 'server',
        id: 'server',
      },
    },
  };
}
function document(...statements: unknown[]): PolicyDocumentV1 {
  return PolicyDocumentV1Schema.parse({ schemaVersion: 1, statements });
}

/** Real SDK/Token/auth/configuration/native owners. No Provider or invented Actor/Kernel. */
async function fixture(
  serverConfig: Record<string, unknown> = {},
  createOptions: (
    coreDb: ReturnType<typeof createTestCoreDb>,
    nanoHostStorage: Awaited<ReturnType<typeof openAdmittedTestNanoHost>>
  ) => Partial<Parameters<typeof createApp>[0]> = () => ({})
) {
  const pending: Promise<unknown>[] = [];
  const releases: Array<() => void> = [];
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-e13-runtime-'));
  let coreDb = createTestCoreDb(dataRoot);
  let workspaceReaders: ReturnType<typeof createTestWorkspaceDb>[] = [];
  onTestFinished(async () => {
    for (const release of releases) release();
    await Promise.allSettled(pending);
    await disposeTestStore(dataRoot, ...workspaceReaders, coreDb);
  });
  ensureLocalUser(coreDb); // initialization only; no local Actor is ever used
  // Boot admits the NanoHost owner before the Worker control gateway is built (`app.ts`).
  const nanoHostStorage = await openAdmittedTestNanoHost(coreDb);
  let auth = createBetterAuth(coreDb, { env: { BETTER_AUTH_URL: BASE } });
  async function human(label: string, administrator: boolean) {
    const response = await auth.handler(
      new Request(`${BASE}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: label,
          email: `${label}@example.test`,
          password: 'synthetic-e13-runtime-password',
        }),
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.user?.id).toBe('string');
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(cookie.length).toBeGreaterThan(0);
    const bootstrap = administrator
      ? createOpenKitAccessTokenRecord(coreDb, {
          ownerUserId: body.user.id,
          scope: 'server-admin',
          workspaceIds: [],
          expiresAt: EXPIRY,
        })
      : null;
    return { userId: body.user.id as string, cookie, bootstrap };
  }
  const first = await human('runtime-first', true);
  const second = await human('runtime-second', true);
  const ordinary = await human('runtime-ordinary', false);
  expect(new Set([first.userId, second.userId, ordinary.userId]).size).toBe(3);
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'config/server.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      ...serverConfig,
      policy: { mediation: document() },
    })
  );
  writeFileSync(
    join(dataRoot, 'config/gateway.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      logicalModels: [],
      requiredFeatures: [],
    })
  );

  async function graph() {
    const store = createTestStore({ dataRoot });
    const manager = createRuntimeConfigManager({ dataRoot });
    expect(manager.current().gatewayConfig.logicalModels).toEqual([]);
    const authentication = new Hono<{ Variables: AuthVariables }>();
    authentication.use(
      createAuthMiddleware('server', auth, {
        coreDb,
        canonicalUserActive: (id) => isCanonicalUserActive(coreDb, id),
        sessionDeploymentAdmin: (id) => resolveSessionDeploymentAdminTokenId(coreDb, id),
      })
    );
    authentication.get('/api/e13-fixture-identity', (c) => c.json(c.get('actor')));
    const accounts = [];
    for (const human of [first, second, ordinary]) {
      const response = await authentication.request(`${BASE}/api/e13-fixture-identity`, {
        headers: { cookie: human.cookie },
      });
      expect(response.status).toBe(200);
      const actor = (await response.json()) as Actor;
      expect(actor).toMatchObject({ kind: 'session', userId: human.userId });
      if (actor.kind !== 'session') throw new Error('Expected the actual SDK session Actor.');
      // H1's real Home is needed by the original personal-Tool control. Other
      // management scopes, and every Thread/Turn/service, open only when invoked.
      let home =
        human.userId === first.userId
          ? await store.ensureQuickChatWorkspace(human.userId)
          : undefined;
      let files: RuntimeConfigFileService | undefined;
      let opened: ReturnType<typeof openManagement> | undefined;
      async function openManagement() {
        home ??= await store.ensureQuickChatWorkspace(human.userId);
        const ownedHome = home;
        const thread = await store.createThread(
          ownedHome.id,
          'Native E13 review',
          allocateEntityId('th'),
          'administration',
          { visibility: 'private', privateOwnerUserId: human.userId }
        );
        const turn = await store.createTurn(
          ownedHome.id,
          thread.id,
          'Review this exact exposure change.',
          { kind: 'user', id: human.userId },
          null
        );
        const ownedFiles = new RuntimeConfigFileService({
          dataRoot,
          userId: human.userId,
          workspaceIds: [ownedHome.id],
          runtimeConfigManager: manager,
          readRuntimeConfigStatus: () => manager.status(),
        });
        files = ownedFiles;
        let workspaceDb: ReturnType<typeof createTestWorkspaceDb> | undefined;
        const service = createAdministrationConfiguration({
          actor,
          coreDb,
          store,
          files: ownedFiles,
          runtimeConfig: () => manager.current(),
          reload: async () => await manager.reload({ mode: 'safe', dryRun: false }),
          repositoryWorkspaceDb: (id) => {
            if (id !== ownedHome.id)
              throw new Error('No fixture authority for another private Home.');
            if (!workspaceDb) {
              workspaceDb = createTestWorkspaceDb(dataRoot, id);
              workspaceReaders.push(workspaceDb);
            }
            return workspaceDb;
          },
          inflightCommands: new WeakMap(),
        });
        const propose = (proposed: PolicyDocumentV1) =>
          service.propose(
            {
              targetFamily: 'policy',
              targetId: 'server',
              expectedRevision: ownedFiles.readFile('server.jsonc').file.revision!,
              changes: {
                proposed,
                rationale: 'Actual human review of this exact switch.',
              },
            },
            { threadId: thread.id, turnId: turn.id, requestId: randomUUID() }
          );
        const apply = (p: Awaited<ReturnType<typeof propose>>) =>
          service.apply({
            requestId: randomUUID(),
            candidate: p.candidate,
            confirmation: p.confirmation,
          });
        return { propose, apply };
      }
      const management = () => (opened ??= openManagement());
      const propose = async (proposed: PolicyDocumentV1) => (await management()).propose(proposed);
      const apply = async (p: Awaited<ReturnType<typeof propose>>) => (await management()).apply(p);
      accounts.push({
        human,
        actor,
        get home() {
          if (!home) throw new Error('This actual management Home has not been opened.');
          return home;
        },
        get files() {
          if (!files) throw new Error('This actual management file service has not been opened.');
          return files;
        },
        propose,
        apply,
      });
    }
    const admin = accounts[0]!;
    expect(admin.actor.adminTokenId).toBe(first.bootstrap!.tokenId);
    expect(
      evaluateProductAuthorization(
        coreDb,
        admin.actor,
        { kind: 'server' },
        'workspace.configure',
        true
      ).effect
    ).toBe('allow');
    expect(accounts[2]!.actor.adminTokenId).toBeUndefined();
    const app = createApp({
      mode: 'server',
      coreDb,
      dataRoot,
      store,
      auth,
      runtimeConfigManager: manager,
      ...createOptions(coreDb, nanoHostStorage),
    });
    return {
      coreDb,
      dataRoot,
      store,
      manager,
      accounts,
      app,
      auth,
    };
  }
  let current = await graph();
  const workspaceResponse = await current.app.request(
    ...operationRequest(
      'workspace.create',
      {},
      {
        headers: { cookie: first.cookie },
        body: JSON.stringify({
          name: 'Real scoped runtime caller',
          requestId: randomUUID(),
        }),
      }
    )
  );
  expect(workspaceResponse.status).toBe(201);
  const workspace = await workspaceResponse.json();
  expect(typeof workspace.id).toBe('string');
  async function change(proposed: PolicyDocumentV1, account = 0) {
    const owner = current.accounts[account]!;
    const result = await owner.apply(await owner.propose(proposed));
    expect(result).toMatchObject({ persisted: true, reload: 'applied' });
    return readAdmittedPolicyDocument(
      coreDb,
      current.manager.current().openKitConfig.policy?.mediation
    );
  }
  const loaded = () =>
    readAdmittedPolicyDocument(coreDb, current.manager.current().openKitConfig.policy?.mediation);
  async function restart() {
    await shutdownControlStoreWorkerClient();
    for (const reader of workspaceReaders) closeTestCoreDb(reader);
    workspaceReaders = [];
    closeWorkspaceProductReadHandles(dataRoot);
    closeTestCoreDb(coreDb);
    coreDb = createTestCoreDb(dataRoot);
    auth = createBetterAuth(coreDb, { env: { BETTER_AUTH_URL: BASE } });
    current = await graph();
  }
  return {
    first,
    second,
    ordinary,
    change,
    loaded,
    restart,
    pending,
    releases,
    ordinaryWorkspace: workspace,
    graph: () => current,
    post: (path: string, body: unknown, headers: HeadersInit) =>
      current.app.request(path, {
        method: 'POST',
        headers: {
          ...Object.fromEntries(new Headers(headers)),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
  };
}

/** Read an exact existing source descriptor; do not invent names for new B1 groups. */
function sourceGroup(entry: string) {
  const descriptor = Reflect.get(NON_API_EXPOSURE_DEFINITIONS, entry);
  expect(descriptor).toBeDefined();
  const metadata = descriptor && Reflect.get(descriptor, 'exposure');
  expect(metadata).toMatchObject({
    kind: 'switchable',
    owner: expect.any(String),
    group: expect.any(String),
  });
  const group = Reflect.get(metadata, 'group') as string;
  expect(group.length).toBeGreaterThan(0);
  return group;
}

/** Existing S1 allocation owners seed a real package/session/attempt; no SQL grant or allow decision is inserted. */
async function workerFixture() {
  let gateway!: ReturnType<typeof createDefaultWorkerControlGateway>;
  const f = await fixture({}, (coreDb, nanoHostStorage) => {
    gateway = createDefaultWorkerControlGateway(coreDb, undefined, nanoHostStorage);
    return { workerControlGateway: gateway };
  });
  const g = f.graph();
  const workspaceId = f.ordinaryWorkspace.id; // Already created by actual workspace.create/H1 SDK IO and owner membership.
  const thread = await g.store.createThread(
    workspaceId,
    'Native private Worker',
    allocateEntityId('th')
  );
  const setup = createTestAgentSetup({
    mcpIds: [],
    requiredCapabilities: ['trusted-worker-inference-relay'],
  });
  const turn = await g.store.createTurn(
    workspaceId,
    thread.id,
    'Exercise the original allocated Worker package.',
    { kind: 'user', id: f.first.userId }
  );
  const coverage = g.store.getTurnCaptureCoverage(turn.id);
  expect(coverage).toBeDefined();
  const environmentPackage = await resolveAgentEnvironmentPackage({
    coreDb: g.coreDb,
    captureCoverage: coverage!,
    agentSetup: setup,
    agentSessionId: allocateEntityId('as'),
    triggerActor: turn.triggerActor,
    backend: { kind: 'openshell' },
    createdAt: new Date().toISOString(),
    requestId: randomUUID(),
    turn,
    workspaceCwd: '/workspace',
    workspaceRoots: [],
    workspaceMcpServerCatalog: { schemaVersion: 1, servers: [] },
  });
  const db = createTestWorkspaceDb(g.dataRoot, workspaceId);
  f.releases.push(() => closeTestCoreDb(db));
  const lineage = {
    workspaceId,
    threadId: thread.id,
    turnId: turn.id,
    agentSessionId: environmentPackage.scope.agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: environmentPackage.scope.requestId,
  };
  const queueEntryId = randomUUID();
  const entry = createSchedulerAdmissionEntry(g.coreDb, {
    backendId: 'nanohost',
    triggerActor: turn.triggerActor,
    // Exact credential already projected by the actual SDK session, as in product-turn-start.
    serverAdminTokenId: g.accounts[0]!.actor.adminTokenId ?? null,
    profileRef: environmentPackage.agent.profileId,
    queueEntryId,
    requestId: lineage.requestId,
    requestedAgentId: environmentPackage.agent.agentId,
    threadId: thread.id,
    turnId: turn.id,
    inputRef: schedulerFixtureInput(
      workspaceId,
      turn.id,
      'Exercise original allocated Worker package.'
    ),
    workspaceId,
  });
  expect(entry.status).toBe('queued');
  expect(entry.backendId).toBe('nanohost');
  expect(entry.serverAdminTokenId).toBe(g.accounts[0]!.actor.adminTokenId);
  let launchKernel: ReturnType<typeof evaluateProductAuthorization> | undefined;
  const dispatchable = currentSchedulerAdmissionWorkspaceAuthority(
    g.coreDb,
    entry,
    'runtime.launch',
    true,
    {
      dependencyFailure: 'throw',
      onEvaluation: (event) => {
        launchKernel = event.decision;
      },
    }
  );
  expect(dispatchable).not.toBeNull();
  expect(launchKernel?.effect).toBe('allow');

  const attemptId = allocateEntityId('attempt');
  const binding = `lease-binding:${attemptId}`;
  const secrets = {
    control: randomBytes(32).toString('base64url'),
    capability: randomBytes(32).toString('base64url'),
    inference: randomBytes(32).toString('base64url'),
  };
  // The original Native submit carries the three route-token hashes (K8 owner).
  const attempt = submitTestNanoHostWorkerLease(
    g.coreDb,
    requireSchedulerAdmissionEntry(g.coreDb, queueEntryId),
    binding,
    {
      agentSessionId: lineage.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      workerControlTokenHash: hashWorkerRouteToken(secrets.control),
      workerCapabilityTokenHash: hashWorkerRouteToken(secrets.capability),
      workerInferenceTokenHash: hashWorkerRouteToken(secrets.inference),
    },
    { attemptId }
  );
  await recordAgentEnvironmentPackageSnapshot(db, {
    environmentPackage,
    createdAt: environmentPackage.createdAt,
  });
  await g.store.createAgentSession({
    id: environmentPackage.scope.agentSessionId,
    workspaceId,
    threadId: thread.id,
    agentId: environmentPackage.agent.agentId,
    status: 'busy',
    message: null,
    environmentPackageSnapshotId: environmentPackage.snapshotId,
    createdAt: environmentPackage.createdAt,
    updatedAt: environmentPackage.createdAt,
  });
  await g.store.updateTurn(turn.id, {
    agentSessionId: environmentPackage.scope.agentSessionId,
    agentId: environmentPackage.agent.agentId,
  });
  expect(attempt).toMatchObject({
    queueEntryId: entry.queueEntryId,
    phase: 'open',
    agentSessionId: lineage.agentSessionId,
    inputRef: environmentPackage.snapshotId,
    bindingRef: binding,
  });
  // Existing allocated S1 fixture observation, not a fabricated Policy/Kernel verdict.
  acceptSchedulerExecutionObservation(g.coreDb, {
    ...schedulerExecutionCorrelation(attempt),
    disposition: 'accepted',
    execution: 'running',
    fenceRef: null,
    outcomeRef: null,
  });
  const registration = gateway.registerSession(environmentPackage, {
    sandboxBindingRef: binding,
    workerControlToken: secrets.control,
    workerCapabilityToken: secrets.capability,
    workerInferenceToken: secrets.inference,
  });
  expect(registration.token).toBe(secrets.control);
  const authenticated: Array<typeof lineage> = [];
  const recordHeartbeat = gateway.recordHeartbeat.bind(gateway);
  gateway.recordHeartbeat = (input) =>
    recordHeartbeat({
      ...input,
      onAuthenticated: (actual) => {
        authenticated.push({ ...actual });
        input.onAuthenticated?.(actual);
      },
    });
  let kernel: ReturnType<typeof evaluateProductAuthorization> | undefined;
  const authority = currentWorkerLineageWorkspaceAuthority(
    g.coreDb,
    { ...lineage, triggerActor: turn.triggerActor },
    'tool.use',
    true,
    {
      dependencyFailure: 'throw',
      onEvaluation: (event) => {
        kernel = event.decision;
      },
    }
  );
  expect(authority).not.toBeNull();
  expect(kernel?.effect).toBe('allow');
  const client = new WorkerControlClient({
    baseUrl: `${BASE}/api/worker-control`,
    token: secrets.control,
    lineage,
    fetch: async (input, init) => await g.app.request(input, init),
  });
  return {
    f,
    g,
    db,
    gateway,
    client,
    lineage,
    environmentPackage,
    attemptId,
    secrets,
    authenticated,
  };
}

/** Empty configured logical-model supply is ORIGINAL503, not a fabricated Provider success or guessed400. */
it('closes the actual trusted Worker inference resource without quarantining its original package', async () => {
  const w = await workerFixture();
  expect(w.environmentPackage.backend.requiredCapabilities).toContain(
    'trusted-worker-inference-relay'
  );
  const llm = w.environmentPackage.llm;
  expect(llm.mode).toBe('gateway');
  if (llm.mode !== 'gateway')
    throw new Error('The actual resolved package does not admit trusted gateway inference.');
  expect(llm.routes.length).toBeGreaterThan(0);
  for (const route of llm.routes) {
    expect(route.credentialVisibility).toBe('placeholder');
    expect(route.endpoint.upstream?.kind).toBe('nanocore-gateway');
  }
  const model = llm.routes[0]!.model;
  const body = {
    model,
    messages: [{ role: 'user', content: 'Synthetic resource availability control.' }],
    stream: false,
  };
  const send = () =>
    w.g.app.request(`${BASE}/api/worker-inference/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${w.secrets.inference}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  const open = async () => {
    const response = await send();
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('worker_inference_provider_unavailable');
  };
  await open(); // Valid original inference authentication, schema, trusted AEP and current Kernel, no Provider.
  const group = sourceGroup('POST /api/worker-inference/v1/chat/completions');
  expect(group).toBe(GROUP);
  await w.f.change(document(control(w.f.first.userId, 'active', group)));
  expect((await send()).status).toBe(403);
  const authenticated = w.gateway.authenticatePackageToken(`Bearer ${w.secrets.inference}`, {
    tokenFamily: 'inference',
  });
  expect(authenticated.snapshotId).toBe(w.environmentPackage.snapshotId);
  expect(authenticated.scope).toEqual(w.environmentPackage.scope);
  expect(requireNanoHostExecutionAttempt(w.g.coreDb, w.attemptId)).toMatchObject({
    phase: 'open',
    recoveryState: null,
  });
  await w.f.change(document(), 1);
  await open();
}, 30_000);
