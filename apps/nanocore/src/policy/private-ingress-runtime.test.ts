// openkit-test-platform: posix
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NON_API_EXPOSURE_DEFINITIONS } from '@openkit/app-api-schemas';
import { allocateEntityId, type PolicyDocumentV1, PolicyDocumentV1Schema } from '@openkit/protocol';
import { Hono } from 'hono';
import { describe, expect, it, onTestFinished } from 'vitest';
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
import { readAdmittedPolicyDocument } from '../policy/configuration.js';
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
async function fixture(serverConfig: Record<string, unknown> = {}) {
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
    'administrator bearer': {
      authorization: `Bearer ${first.bootstrap!.secret}`,
    },
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
const DISCORD = '/api/channels/discord/interactions';
async function discordFixture() {
  const keys = generateKeyPairSync('ed25519');
  const identity = {
    applicationId: '123456789012345678',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
  };
  const f = await fixture({
    server: { publicBaseUrl: 'https://e13.example.test' },
    channels: { discord: identity },
  });
  const body = JSON.stringify({
    id: '223456789012345678',
    application_id: identity.applicationId,
    type: 1,
    version: 1,
  });
  function headers(value = body) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      'content-type': 'application/json',
      'x-signature-timestamp': timestamp,
      'x-signature-ed25519': sign(null, Buffer.from(timestamp + value), keys.privateKey).toString(
        'hex'
      ),
    };
  }
  const send = (value = body, signature = headers()) =>
    f.graph().app.request(DISCORD, {
      method: 'POST',
      body: value,
      headers: signature,
    });
  async function open() {
    const response = await send();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ type: 1 });
  }
  return { f, body, headers, send, open };
}

describe('E13B2 signed ingress through the real App and native channel owners', () => {
  it('closes signed Discord before ordinary App authentication without replacing its verifier or channel', async () => {
    const d = await discordFixture();
    await d.open(); // Real cryptographic verifier + production ChannelServices/Discord channel, not a callback.
    const invalid = await d.send(`${d.body} `, d.headers());
    expect(invalid.status).toBe(401);
    const group = sourceGroup(`POST ${DISCORD}`);
    expect(group).not.toBe(GROUP); // The accepted llm-gateway remains exactly its original source family.
    await d.f.change(document(control(d.f.first.userId, 'active', group)));
    // B2 OLD baseline is after B1 metadata, with the signed private join still unchanged.
    expect((await d.send()).status).toBe(403);
    expect(
      (
        await d.f.graph().app.request('/api/auth/get-session', {
          headers: { cookie: d.f.second.cookie },
        })
      ).status
    ).toBe(200);
    await d.f.change(document(), 1);
    await d.open();
  });

  it('keeps invalid signatures forbidden under an inactive switch and never reopens on author loss', async () => {
    const d = await discordFixture();
    await d.open();
    const group = sourceGroup(`POST ${DISCORD}`);
    await d.f.change(document(control(d.f.first.userId, 'inactive', group)));
    expect((await d.send(`${d.body} `, d.headers())).status).toBe(401);
    await d.open();
    await d.f.change(document(control(d.f.first.userId, 'active', group)));
    const revoke = await d.f
      .graph()
      .app.request(
        ...operationRequest(
          'credential.revoke',
          { kind: 'access-token', id: d.f.first.bootstrap!.tokenId },
          { headers: { cookie: d.f.second.cookie } }
        )
      );
    expect(revoke.status).toBe(200);
    expect((await d.send()).status).toBe(403);
    await expect(d.f.graph().accounts[2]!.propose(document())).rejects.toThrow();
    await d.f.change(document(), 1);
    await d.open();
  });
});
