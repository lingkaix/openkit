// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { OPERATION_REGISTRY } from '@openkit/app-api-schemas';
import {
  allocateEntityId,
  isRecord,
  type PolicyDocumentV1,
  PolicyDocumentV1Schema,
} from '@openkit/protocol';
import { Hono } from 'hono';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createApp } from '../app.js';
import {
  createOpenKitAccessTokenRecord,
  resolveSessionDeploymentAdminTokenId,
} from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import type { Actor } from '../auth/identity.js';
import { type AuthVariables, createAuthMiddleware } from '../auth/middleware.js';
import { evaluateProductAuthorization } from '../auth/operation-authorizer.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { createAdministrationConfiguration } from '../config/administration-configuration.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { createOperationEngine } from '../operation-invocation.js';
import { readAdmittedPolicyDocument } from '../policy/configuration.js';
import { policyDigest } from '../policy/statements.js';
import { closeWorkspaceProductReadHandles } from '../storage/control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
  disposeTestStore,
} from '../test-support/store.js';
import { createWorkspaceOperationImplementations } from '../workspace-operation-implementations.js';

const verification = vi.hoisted(() => ({
  tokenId: '',
  ids: [] as number[],
  arrived: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
}));
// Hold only the original matching native verification reply; all SQL/auth owners stay real.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        const request: unknown = args[0];
        if (
          isRecord(request) &&
          request.operation === 'access-token-verification' &&
          isRecord(request.input) &&
          request.input.tokenId === verification.tokenId &&
          typeof request.id === 'number'
        )
          verification.ids.push(request.id);
        return super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const reply = args[0];
        if (
          event === 'message' &&
          isRecord(reply) &&
          reply.status === 'ok' &&
          reply.operation === 'access-token-verification' &&
          verification.ids.includes(reply.id as number)
        ) {
          verification.release = () => super.emit(event, ...args);
          verification.arrived?.();
          return true;
        }
        return super.emit(event, ...args);
      }
    },
  };
});

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
          container: { owner: { kind: 'server' as const }, kind: 'route-group-switch', id: group },
        },
      ],
    },
    lifetime: { anchor: { owner: { kind: 'server' as const }, kind: 'server', id: 'server' } },
  };
}
function document(...statements: unknown[]): PolicyDocumentV1 {
  return PolicyDocumentV1Schema.parse({ schemaVersion: 1, statements });
}

/** Real SDK/Token/auth/configuration/native owners. No Provider or invented Actor/Kernel. */
async function fixture() {
  verification.tokenId = '';
  verification.ids.length = 0;
  verification.release = undefined;
  const pending: Promise<unknown>[] = [];
  const releases: Array<() => void> = [];
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-e13-runtime-'));
  let coreDb = createTestCoreDb(dataRoot);
  let workspaceReaders: ReturnType<typeof createTestWorkspaceDb>[] = [];
  onTestFinished(async () => {
    verification.tokenId = '';
    verification.ids.length = 0;
    verification.release?.();
    verification.release = undefined;
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
    JSON.stringify({ schemaVersion: 1, policy: { mediation: document() } })
  );
  writeFileSync(
    join(dataRoot, 'config/gateway.jsonc'),
    JSON.stringify({ schemaVersion: 1, enabled: true, logicalModels: [], requiredFeatures: [] })
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
              changes: { proposed, rationale: 'Actual human review of this exact switch.' },
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
    const workspaceMutationAdmission = getControlStoreWorkerClient().workspaceMutations(dataRoot);
    const app = createApp({
      mode: 'server',
      coreDb,
      dataRoot,
      store,
      auth,
      runtimeConfigManager: manager,
      workspaceMutationAdmission,
    });
    return { coreDb, dataRoot, workspaceMutationAdmission, store, manager, accounts, app };
  }
  let current = await graph();
  const workspaceResponse = await current.app.request(
    ...operationRequest(
      'workspace.create',
      {},
      {
        headers: { cookie: first.cookie },
        body: JSON.stringify({ name: 'Real scoped runtime caller', requestId: randomUUID() }),
      }
    )
  );
  expect(workspaceResponse.status).toBe(201);
  const workspace = await workspaceResponse.json();
  expect(typeof workspace.id).toBe('string');
  const issue = await current.app.request(
    ...operationRequest(
      'token.create',
      {},
      {
        headers: { cookie: first.cookie },
        body: JSON.stringify({
          scope: 'workspace-readonly',
          workspaceIds: [workspace.id],
          expiresAt: EXPIRY,
        }),
      }
    )
  );
  expect(issue.status).toBe(201);
  const token = await issue.json();
  expect(typeof token.token).toBe('string');
  const callers: Record<string, HeadersInit> = {
    'author session': { cookie: first.cookie },
    'other administrator session': { cookie: second.cookie },
    'ordinary other human': { cookie: ordinary.cookie },
    'administrator bearer': { authorization: `Bearer ${first.bootstrap!.secret}` },
    'ordinary scoped bearer': { authorization: `Bearer ${token.token}` },
  };
  const models = async (headers: HeadersInit) =>
    await current.app.request('/v1/models', { headers });
  async function open(headers: HeadersInit) {
    const response = await models(headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ object: 'list', data: [] });
  }
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
    callers,
    models,
    open,
    change,
    loaded,
    restart,
    pending,
    releases,
    ordinaryTokenId: token.record.tokenId as string,
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

describe('E13 native current resource availability', () => {
  it.each([
    'author session',
    'other administrator session',
    'ordinary other human',
    'administrator bearer',
    'ordinary scoped bearer',
  ])(
    'one human control closes the real Gateway for %s without borrowing its subject',
    async (name) => {
      const f = await fixture();
      await f.open(f.callers[name]!);
      const admitted = await f.change(document(control(f.first.userId)));
      expect(admitted.statements[0]!.scope.subjects).toEqual([
        { kind: 'human', id: f.first.userId },
      ]);
      expect(f.graph().manager.current().gatewayConfig.enabled).toBe(true);
      // Intended OLD: actual enabled empty-catalog GET still returns 200, not a missing API.
      expect((await f.models(f.callers[name]!)).status).toBe(403);
    }
  );

  it.each([
    [
      '/v1/chat/completions',
      { model: 'not-configured', messages: [{ role: 'user', content: 'Fixture request' }] },
    ],
    ['/v1/responses', { model: 'not-configured', input: 'Fixture request' }],
  ] as const)('closes %s before logical-model/Provider selection', async (path, input) => {
    const f = await fixture();
    const before = await f.post(path, input, f.callers['author session']!);
    expect(before.status).toBe(400);
    expect(await before.json()).toMatchObject({ error: { code: 'model_not_configured' } });
    await f.change(document(control(f.first.userId)));
    expect((await f.post(path, input, f.callers['author session']!)).status).toBe(403);
  });

  it('rechecks current loaded Policy rather than a primed allow and restores only through real human clear', async () => {
    const f = await fixture();
    await f.open(f.callers['ordinary other human']!);
    const before = policyDigest(f.loaded());
    await f.change(document(control(f.first.userId)));
    expect(policyDigest(f.loaded())).not.toBe(before);
    expect((await f.models(f.callers['ordinary other human']!)).status).toBe(403);
    const owner = f.graph().accounts[0]!;
    const clear = await owner.propose(document());
    expect((await f.models(f.callers['ordinary other human']!)).status).toBe(403);
    expect(await owner.apply(clear)).toMatchObject({ persisted: true, reload: 'applied' });
    await f.open(f.callers['ordinary other human']!);
  });

  it('rechecks a primed allow after its original native bearer verification ACK wait', async () => {
    const f = await fixture();
    await f.open(f.callers['ordinary scoped bearer']!);
    verification.tokenId = f.ordinaryTokenId;
    const arrived = new Promise<void>((resolve) => {
      verification.arrived = resolve;
    });
    const request = f.models(f.callers['ordinary scoped bearer']!);
    f.pending.push(request);
    expect(await Promise.race([arrived.then(() => true), request.then(() => false)])).toBe(true);
    const prior = policyDigest(f.loaded());
    await f.change(document(control(f.first.userId)));
    expect(policyDigest(f.loaded())).not.toBe(prior);
    verification.tokenId = '';
    verification.ids.length = 0;
    verification.release?.();
    verification.release = undefined;
    expect((await request).status).toBe(403);
  });

  it('preserves ordinary per-human Tool restrictions without turning them into global switches', async () => {
    const f = await fixture();
    const home = f.graph().accounts[0]!.home;
    const condition = {
      ...control(f.first.userId),
      id: 'ordinary-personal-rule',
      scope: {
        subjects: [{ kind: 'human', id: f.first.userId }],
        actions: ['tool.use'],
        resources: [
          { kind: 'mcp-tool', workspaceId: home.id, serverId: 'issues', toolName: 'read' },
        ],
      },
      lifetime: {
        anchor: {
          owner: { kind: 'workspace', workspaceId: home.id },
          kind: 'workspace',
          id: home.id,
        },
      },
    };
    await f.change(document(condition));
    await f.open(f.callers['author session']!);
    await f.open(f.callers['ordinary other human']!);
  });

  it('absence and inactive controls supply no extra Token authority or legacy Gateway enablement', async () => {
    const f = await fixture();
    const forbidden = () =>
      f
        .graph()
        .app.request(
          ...operationRequest(
            'credential.list',
            {},
            { headers: f.callers['ordinary scoped bearer']! }
          )
        );
    expect((await forbidden()).status).toBe(403);
    await f.change(document(control(f.first.userId, 'inactive')));
    await f.open(f.callers['ordinary scoped bearer']!);
    expect((await forbidden()).status).toBe(403);
    const files = f.graph().accounts[0]!.files;
    const read = files.readFile('gateway.jsonc');
    await files.updateFile({
      id: 'gateway.jsonc',
      kind: 'gateway',
      expectedRevision: read.file.revision!,
      content: JSON.stringify({ ...JSON.parse(read.content), enabled: false }),
    });
    expect((await f.graph().manager.reload({ mode: 'safe', dryRun: false })).status).toBe(
      'applied'
    );
    const response = await f.models(f.callers['author session']!);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'gateway_disabled' } });
  });

  it('rechecks an admitted queued Workspace command at its native effect and recovers the exact request only after human clear', async () => {
    const f = await fixture();
    const g = f.graph();
    const dependencies = {
      coreDb: g.coreDb,
      dataRoot: g.dataRoot,
      store: g.store,
      workspaceMutationAdmission: g.workspaceMutationAdmission,
      runtimeConfigManager: g.manager,
      readRuntimePolicy: () => g.manager.current().openKitConfig.policy?.mediation,
      inflightCommands: new WeakMap(),
    };
    const engine = createOperationEngine(
      createWorkspaceOperationImplementations(dependencies),
      dependencies
    );
    const actor = g.accounts[0]!.actor;
    const positiveInput = { name: 'Native positive queue control', requestId: randomUUID() };
    const positive = await engine('workspace.create', positiveInput, { kind: 'public', actor });
    expect(g.store.getWorkspace(positive.id).name).toBe('Native positive queue control');
    const metadata = Reflect.get(OPERATION_REGISTRY['workspace.create'], 'exposure');
    // Intended OLD: missing existing-definition exposure; no later queue assertion is credited.
    expect(metadata).toMatchObject({
      kind: 'switchable',
      owner: expect.any(String),
      group: expect.any(String),
    });
    const group = Reflect.get(metadata, 'group') as string;
    expect(group.length).toBeGreaterThan(0);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const queued = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let checks = 0;
    const input = { name: `Deferred real effect ${randomUUID()}`, requestId: randomUUID() };
    const running = engine('workspace.create', input, {
      kind: 'public',
      actor,
      recheckEntry: async () => {
        if (++checks === 2) {
          arrived();
          await wait;
        }
      },
    });
    f.pending.push(running);
    f.releases.push(release);
    expect(
      await Promise.race([
        queued.then(() => true),
        running.then(
          () => false,
          () => false
        ),
      ])
    ).toBe(true);
    await f.change(document(control(f.first.userId, 'active', group)));
    await expect(
      engine('workspace.create', positiveInput, { kind: 'public', actor })
    ).rejects.toMatchObject({ status: 403 });
    const denied = running.then(
      () => null,
      (error) => error
    );
    release();
    expect(await denied).toMatchObject({ status: 403 });
    expect(g.store.listWorkspaces().some((workspace) => workspace.name === input.name)).toBe(false);
    await f.change(document(), 1);
    const recovered = await engine('workspace.create', input, { kind: 'public', actor });
    expect(g.store.getWorkspace(recovered.id).name).toBe(input.name);
    const replay = await engine('workspace.create', input, { kind: 'public', actor });
    expect(replay.id).toBe(recovered.id);
    expect(
      g.store.listWorkspaces().filter((workspace) => workspace.name === input.name)
    ).toHaveLength(1);
  });

  it('retains native file CAS so a stale close cannot silently replace a newer human revision', async () => {
    const f = await fixture();
    const first = f.graph().accounts[0]!;
    const stale = await first.propose(document(control(f.first.userId)));
    await f.change(document(control(f.second.userId, 'inactive')), 1);
    const current = f.loaded();
    await expect(first.apply(stale)).rejects.toThrow();
    expect(f.loaded()).toEqual(current);
    await f.open(f.callers['ordinary other human']!);
  });

  it('cold-reopens the same durable root without automatically reopening the group', async () => {
    const f = await fixture();
    await f.open(f.callers['ordinary other human']!);
    await f.change(document(control(f.first.userId)));
    const before = f.loaded();
    await f.restart();
    expect(f.loaded()).toEqual(before);
    expect((await f.models(f.callers['ordinary other human']!)).status).toBe(403);
  });

  it('never opens after author authority loss; only another current human can clear', async () => {
    const f = await fixture();
    await f.change(document(control(f.first.userId)));
    const restricted = f.loaded();
    const response = await f
      .graph()
      .app.request(
        ...operationRequest(
          'credential.revoke',
          { kind: 'access-token', id: f.first.bootstrap!.tokenId },
          { headers: { cookie: f.second.cookie } }
        )
      );
    expect(response.status).toBe(200);
    expect((await f.models(f.callers['ordinary other human']!)).status).toBe(403);
    expect(f.loaded()).toEqual(restricted);
    expect(
      f
        .loaded()
        .statements.filter(
          (statement) =>
            !statement.scope.resources.some(
              (resource) =>
                resource.kind === 'container' && resource.container.kind === 'context-preset'
            )
        )
        .map(({ id }) => id)
        .sort()
    ).toEqual(['runtime-gateway-control', 'security-investigation']);
    await expect(f.graph().accounts[2]!.propose(document())).rejects.toThrow();
    const authenticated = await f
      .graph()
      .app.request('/api/auth/get-session', { headers: { cookie: f.second.cookie } });
    expect(authenticated.status).toBe(200);
    const management = await f
      .graph()
      .app.request(
        ...operationRequest('token.my-admin-list', {}, { headers: { cookie: f.second.cookie } })
      );
    expect(management.status).toBe(200);
    await f.change(document(), 1);
    await f.open(f.callers['ordinary other human']!);
  });
});
