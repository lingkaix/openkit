// openkit-test-platform: posix
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { NON_API_EXPOSURE_DEFINITIONS, OPERATION_REGISTRY } from '@openkit/app-api-schemas';
import { allocateEntityId, type PolicyDocumentV1, PolicyDocumentV1Schema } from '@openkit/protocol';
import { Hono } from 'hono';
import { expect, it, onTestFinished } from 'vitest';
import { createApp } from '../app.js';
import {
  createOpenKitAccessTokenRecord,
  resolveSessionDeploymentAdminTokenId,
} from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import type { Actor } from '../auth/identity.js';
import { type AuthVariables, createAuthMiddleware } from '../auth/middleware.js';
import transportRevision from '../auth/nanohost-transport-revision.json' with { type: 'json' };
import { createNanoHostTransportSessionAuthority } from '../auth/nanohost-transport-session.js';
import { createNanoHostTransportTokenRecord } from '../auth/nanohost-transport-token-store.js';
import { evaluateProductAuthorization } from '../auth/operation-authorizer.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { createAdministrationConfiguration } from '../config/administration-configuration.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { readAdmittedPolicyDocument } from '../policy/configuration.js';
import {
  createNanoHostSessionDispatch,
  NANO_HOST_EFFECT_OPERATIONS,
} from '../runtime/nanohost-session-dispatch.js';

import { closeWorkspaceProductReadHandles } from '../storage/control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
  disposeTestStore,
} from '../test-support/store.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

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
    coreDb: ReturnType<typeof createTestCoreDb>
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
      const response = await authentication.request(BASE + '/api/e13-fixture-identity', {
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
    const workspaceMutationAdmission = new WorkspaceMutationAdmission();
    const app = createApp({
      mode: 'server',
      coreDb,
      dataRoot,
      store,
      auth,
      runtimeConfigManager: manager,
      workspaceMutationAdmission,
      ...createOptions(coreDb),
    });
    return {
      coreDb,
      dataRoot,
      workspaceMutationAdmission,
      store,
      manager,
      accounts,
      app,
    };
  }
  let current = await graph();
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

it('closes native NanoHost effect delivery only after real enrollment, Token verification and physical H2 session admission', async () => {
  const slots = mkdtempSync(join(tmpdir(), 'openkit-e13-host-slots-'));
  onTestFinished(() => rmSync(slots, { recursive: true, force: true }));
  const config = {
    bind: { host: '127.0.0.1', port: 4318 },
    credentialRef: 'nanohost-transport:primary',
    credentialSlots: {
      A: {
        companionPath: join(slots, 'A.meta'),
        secretPath: join(slots, 'A.token'),
      },
      B: {
        companionPath: join(slots, 'B.meta'),
        secretPath: join(slots, 'B.token'),
      },
    },
    deploymentId: 'dep_00000000-0000-7bdd-bdc3-910a52eaec87',
    identityId: 'integration_e13_native',
    rendezvousUrl: 'https://e13.example.test',
  };
  const authority = createNanoHostTransportSessionAuthority();
  let dispatch!: ReturnType<typeof createNanoHostSessionDispatch>;
  const f = await fixture({ nanohost: config }, (coreDb) => {
    dispatch = createNanoHostSessionDispatch({
      coreDb,
      sessionAuthority: authority,
    });
    return {
      nanohostTransportSessionAuthority: authority,
      nanoHostSessionDispatch: dispatch,
    };
  });
  const g = f.graph();
  const enrollmentInput = OPERATION_REGISTRY['nanohost.enroll'].inputSchema.parse({
    targetSlot: 'A',
    expiresAt: EXPIRY,
  });
  const denied = await g.app.request(
    ...operationRequest(
      'nanohost.enroll',
      {},
      {
        headers: { cookie: f.ordinary.cookie },
        body: JSON.stringify(enrollmentInput),
      }
    )
  );
  expect(denied.status).toBe(403);
  const enrolled = await g.app.request(
    ...operationRequest(
      'nanohost.enroll',
      {},
      {
        headers: { cookie: f.first.cookie },
        body: JSON.stringify(enrollmentInput),
      }
    )
  );
  expect(enrolled.status).toBe(
    Reflect.get(OPERATION_REGISTRY['nanohost.enroll'], 'successStatus') ?? 200
  );
  // Same actual native Token owner, with the original SDK-authenticated administrator Actor.
  // Do not read even this temporary slot's secret file, manually create identity rows, or call authority.admit.
  const token = await createNanoHostTransportTokenRecord(
    g.coreDb,
    {
      deploymentId: config.deploymentId,
      ownerNanoHostIdentityId: config.identityId,
      responsibleServerAdminActorId: f.first.userId,
      expiresAt: EXPIRY,
    },
    g.accounts[0]!.actor
  );
  const nativeHeaders = {
    authorization: 'Bearer ' + token.secret,
    'x-openkit-nanohost-transport-revision': String(transportRevision),
  };
  const noPhysicalSession = await g.app.request('/api/nanohost/transport/session/admit', {
    method: 'POST',
    headers: { ...nativeHeaders, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(noPhysicalSession.status).toBe(409);
  const listener = getRequestListener(g.app.fetch);
  const server = createHttp2Server((request, response) => {
    void listener(request, response);
  });
  let client: ReturnType<typeof connectHttp2> | undefined;
  const abort = new AbortController();
  let closed!: () => void;
  const closeFinished = new Promise<void>((resolve) => {
    closed = resolve;
  });
  f.pending.push(closeFinished);
  f.releases.push(() => {
    abort.abort(new Error('Temporary native transport fixture ended.'));
    if (client && !client.destroyed) {
      client.once('close', () => server.close(() => closed()));
      client.destroy();
    } else server.close(() => closed());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native fixture listener.');
  client = connectHttp2('http://127.0.0.1:' + address.port);
  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const stream = client!.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/json',
      ...headers,
    });
    const response = once(stream, 'response');
    stream.end(JSON.stringify(body));
    const [received] = await response;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return {
      status: received[':status'] as number,
      body: Buffer.concat(chunks).toString('utf8'),
    };
  }
  expect(
    (
      await post(
        '/api/nanohost/transport/session/admit',
        {},
        {
          ...nativeHeaders,
          authorization: 'Bearer invalid-synthetic-token',
        }
      )
    ).status
  ).toBe(401);
  const admitted = await post('/api/nanohost/transport/session/admit', {}, nativeHeaders);
  expect(admitted.status).toBe(200);
  expect(JSON.parse(admitted.body)).toMatchObject({
    identityId: config.identityId,
    deploymentId: config.deploymentId,
    mayCarryWork: true,
  });
  const physicalEpoch = randomBytes(32).toString('hex');
  expect((await post('/api/nanohost/transport/session/readiness', { physicalEpoch })).status).toBe(
    204
  );
  const requestId = randomBytes(32).toString('hex');
  // An inspection target identifier only: no image existence or Native inspection result is claimed.
  const imageDigest = 'sha256:' + randomBytes(32).toString('hex');
  expect(NANO_HOST_EFFECT_OPERATIONS).toContain('image.inspect');
  const effect = dispatch.effect({
    kind: 'image.inspect',
    requestId,
    // The actual owner accepts exactly this one input field and adds requestId itself.
    input: { imageDigest },
    signal: abort.signal,
  });
  // A real queued supported Core command; original cancellation is joined without a host result.
  f.pending.push(effect.catch((error) => error));
  const path = '/api/nanohost/transport/effects/image.inspect';
  const delivery = await post(path, {});
  expect(delivery.status).toBe(200);
  expect(JSON.parse(delivery.body)).toEqual({ imageDigest, requestId });
  const group = sourceGroup('POST ' + path);
  await f.change(document(control(f.first.userId, 'active', group)));
  // Staged B2 OLD has metadata/common enforcement but this original private effect join is still old.
  expect((await post(path, {})).status).toBe(403);
  expect(
    (
      await g.app.request('/api/auth/get-session', {
        headers: { cookie: f.second.cookie },
      })
    ).status
  ).toBe(200);
  await f.change(document(), 1);
  expect(f.loaded().statements).toEqual([]);
});
