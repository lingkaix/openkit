// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateEntityId,
  type PolicyDocumentV1,
  PolicyDocumentV1Schema,
  PolicyWriteProposalV1Schema,
} from '@openkit/protocol';
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
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import {
  createTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
  disposeTestStore,
} from '../test-support/store.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { readAdmittedPolicyDocument } from './configuration.js';
import { listServerPermissionDecisions } from './permission-decisions.js';
import { policyDigest, preparePolicyDocument, validatePolicyDocument } from './statements.js';

const BASE = 'http://localhost:3000';
const GROUP = 'llm-gateway';
const HUMAN = 'usr_00000000-0000-7000-8000-000000000001';
const OTHER = 'usr_00000000-0000-7000-8000-000000000002';
const WORKSPACE = 'ws_00000000-0000-7000-8000-000000000001';

/** Authored input only: COORD 08:46 reserved control, never a grant or a stored decision. */
function control(human = HUMAN, state: 'active' | 'inactive' = 'active', group = GROUP) {
  return {
    id: 'close-gateway',
    kind: 'permission' as const,
    state,
    effect: 'prohibit' as const,
    grant: { kind: 'ordinary' as const },
    author: { kind: 'human' as const, id: human },
    authority: { kind: 'human' as const, userId: human },
    authoredAt: '2026-01-01T00:00:00.000Z',
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
    lifetime: { anchor: { owner: { kind: 'server' as const }, kind: 'server', id: 'server' } },
  };
}

type Control = ReturnType<typeof control>;
function document(...statements: unknown[]): PolicyDocumentV1 {
  return PolicyDocumentV1Schema.parse({ schemaVersion: 1, statements });
}

/** Existing ordinary human Workspace Tool restriction; it must never gain a global meaning. */
function toolCondition(human = HUMAN, workspaceId = WORKSPACE) {
  return {
    ...control(human),
    id: 'ordinary-self-prohibition',
    scope: {
      subjects: [{ kind: 'human' as const, id: human }],
      actions: ['tool.use'],
      resources: [{ kind: 'mcp-tool' as const, workspaceId, serverId: 'issues', toolName: 'read' }],
    },
    lifetime: {
      anchor: {
        owner: { kind: 'workspace' as const, workspaceId },
        kind: 'workspace',
        id: workspaceId,
      },
    },
  };
}

const invalid: readonly [string, (s: Control) => unknown][] = [
  ['allow effect', (s) => ({ ...s, effect: 'allow' })],
  ['approval effect', (s) => ({ ...s, effect: 'require_approval' })],
  [
    'wrong grant',
    (s) => ({
      ...s,
      grant: {
        kind: 'storage-lease',
        knowledgeBaseId: 'kb_00000000-0000-7000-8000-000000000001',
        mount: 'content',
        pathPrefix: '/',
        mode: 'read-only',
      },
    }),
  ],
  ['agent author', (s) => ({ ...s, author: { kind: 'agent', id: 'e13-agent' } })],
  [
    'delegated authority',
    (s) => ({
      ...s,
      authority: {
        kind: 'delegation',
        statement: { id: 'delegation', digest: `sha256:${'1'.repeat(64)}` },
      },
    }),
  ],
  ['author mismatch', (s) => ({ ...s, author: { kind: 'human', id: OTHER } })],
  ['authority mismatch', (s) => ({ ...s, authority: { kind: 'human', userId: OTHER } })],
  [
    'subject mismatch',
    (s) => ({ ...s, scope: { ...s.scope, subjects: [{ kind: 'human', id: OTHER }] } }),
  ],
  [
    'multiple subjects',
    (s) => ({
      ...s,
      scope: { ...s.scope, subjects: [...s.scope.subjects, { kind: 'human', id: OTHER }] },
    }),
  ],
  ['empty subjects', (s) => ({ ...s, scope: { ...s.scope, subjects: [] } })],
  [
    'agent subject',
    (s) => ({ ...s, scope: { ...s.scope, subjects: [{ kind: 'agent', id: 'e13-agent' }] } }),
  ],
  [
    'extra action',
    (s) => ({ ...s, scope: { ...s.scope, actions: [...s.scope.actions, 'tool.use'] } }),
  ],
  ['empty actions', (s) => ({ ...s, scope: { ...s.scope, actions: [] } })],
  [
    'maintenance action',
    (s) => ({ ...s, scope: { ...s.scope, actions: ['administration.configuration.apply'] } }),
  ],
  [
    'extra resource',
    (s) => ({
      ...s,
      scope: {
        ...s.scope,
        resources: [
          ...s.scope.resources,
          {
            kind: 'container',
            container: { owner: { kind: 'server' }, kind: 'server', id: 'server' },
          },
        ],
      },
    }),
  ],
  ['empty resources', (s) => ({ ...s, scope: { ...s.scope, resources: [] } })],
  [
    'Workspace resource owner',
    (s) => ({
      ...s,
      scope: {
        ...s.scope,
        resources: [
          {
            kind: 'container',
            container: {
              owner: { kind: 'workspace', workspaceId: WORKSPACE },
              kind: 'route-group-switch',
              id: GROUP,
            },
          },
        ],
      },
    }),
  ],
  [
    'User resource owner',
    (s) => ({
      ...s,
      scope: {
        ...s.scope,
        resources: [
          {
            kind: 'container',
            container: {
              owner: { kind: 'user', userId: HUMAN },
              kind: 'route-group-switch',
              id: GROUP,
            },
          },
        ],
      },
    }),
  ],
  [
    'wrong anchor kind',
    (s) => ({
      ...s,
      lifetime: { anchor: { owner: { kind: 'server' }, kind: 'route-group-switch', id: GROUP } },
    }),
  ],
  [
    'wrong anchor id',
    (s) => ({
      ...s,
      lifetime: { anchor: { owner: { kind: 'server' }, kind: 'server', id: 'another-server' } },
    }),
  ],
  ['expiry', (s) => ({ ...s, lifetime: { ...s.lifetime, notAfter: '2999-01-01T00:00:00.000Z' } })],
  ['finite uses', (s) => ({ ...s, lifetime: { ...s.lifetime, uses: 1 } })],
  ['unknown group', (s) => control(HUMAN, s.state, 'unknown-e13-group')],
  ['group prefix', (s) => control(HUMAN, s.state, 'llm')],
  ['group suffix', (s) => control(HUMAN, s.state, 'llm-gateway-extra')],
  ['wildcard group', (s) => control(HUMAN, s.state, '*')],
  ['protected auth surface as group', (s) => control(HUMAN, s.state, '/api/auth/*')],
  ['protected Policy operation as group', (s) => control(HUMAN, s.state, 'policy.write')],
  [
    'wrong statement kind',
    (s) => {
      const { effect: _effect, grant: _grant, ...base } = s;
      return { ...base, kind: 'managed-boundary' };
    },
  ],
];

// Ruling: exact reserved meaning, before inactive skip; no Policy v1 shape change.
describe('E13 Phase A reserved Server selector', () => {
  it.each(['active', 'inactive'] as const)(
    'admits the exact %s source-group control through the existing validator',
    (state) => {
      const expected = document(control(HUMAN, state));
      expect(validatePolicyDocument(document())).toEqual(document());
      expect(validatePolicyDocument(document(toolCondition()))).toEqual(document(toolCondition()));
      // Intended OLD active BODY: existing Human Tool scope error, never absent-module collection.
      expect(validatePolicyDocument(expected)).toEqual(expected);
    }
  );
  for (const state of ['active', 'inactive'] as const) {
    it.each(invalid)(`rejects ${state} reserved %s`, (_name, change) => {
      expect(() =>
        validatePolicyDocument({ schemaVersion: 1, statements: [change(control(HUMAN, state))] })
      ).toThrow();
    });
  }
  it('rejects shadow reserved controls', () => {
    expect(() =>
      validatePolicyDocument({ schemaVersion: 1, statements: [{ ...control(), state: 'shadow' }] })
    ).toThrow();
  });
  it.each(['active', 'inactive'] as const)(
    'rejects duplicate G across statement IDs/authors with %s first',
    (state) => {
      const first = control(HUMAN, state);
      const second = { ...control(OTHER, 'inactive'), id: 'another-statement-id' };
      expect(() => validatePolicyDocument(document(first, second))).toThrow();
    }
  );
  it('does not turn generic Server prohibitions into shared switches or tighten unrelated inactive declarations', () => {
    const generic = {
      ...control(),
      scope: {
        ...control().scope,
        resources: [
          {
            kind: 'container',
            container: { owner: { kind: 'server' }, kind: 'server', id: 'server' },
          },
        ],
      },
    };
    expect(() => validatePolicyDocument(document(generic))).toThrow();
    const dormant = document({ ...generic, state: 'inactive' });
    expect(validatePolicyDocument(dormant)).toEqual(dormant);
  });
});

/** Real SDK human sessions, native bootstrap credentials, auth facade, private Home and config owners. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-e13-selector-'));
  const coreDb = createTestCoreDb(dataRoot);
  const workspaces: ReturnType<typeof createTestWorkspaceDb>[] = [];
  onTestFinished(async () => {
    await disposeTestStore(dataRoot, ...workspaces, coreDb);
  });
  ensureLocalUser(coreDb);
  const auth = createBetterAuth(coreDb, { env: { BETTER_AUTH_URL: BASE } });
  async function human(label: string) {
    const response = await auth.handler(
      new Request(`${BASE}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({
          name: label,
          email: `${label}@example.test`,
          password: 'synthetic-e13-fixture-password',
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
    const administrator = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: body.user.id,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    return { userId: body.user.id as string, cookie, administrator };
  }
  const first = await human('e13-first');
  const second = await human('e13-second');
  expect(first.userId).not.toBe(second.userId);
  // This is the actual auth module with real native resolvers, not an injected Actor or Kernel.
  const authentication = new Hono<{ Variables: AuthVariables }>();
  authentication.use(
    createAuthMiddleware('server', auth, {
      coreDb,
      canonicalUserActive: (id) => isCanonicalUserActive(coreDb, id),
      sessionDeploymentAdmin: (id) => resolveSessionDeploymentAdminTokenId(coreDb, id),
    })
  );
  authentication.get('/api/e13-fixture-identity', (c) => c.json(c.get('actor')));
  async function authenticatedActor(cookie: string): Promise<Actor> {
    const response = await authentication.request(`${BASE}/api/e13-fixture-identity`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Actor;
  }
  const actor = await authenticatedActor(first.cookie);
  expect(actor).toMatchObject({
    kind: 'session',
    userId: first.userId,
    adminTokenId: first.administrator.tokenId,
  });
  expect(typeof actor.sessionId).toBe('string');
  expect(
    evaluateProductAuthorization(coreDb, actor, { kind: 'server' }, 'workspace.configure', true)
      .effect
  ).toBe('allow');
  const store = createTestStore({ dataRoot });
  const personal = await store.ensureQuickChatWorkspace(first.userId);
  const thread = await store.createThread(
    personal.id,
    'Review E13 control',
    allocateEntityId('th'),
    'administration',
    { visibility: 'private', privateOwnerUserId: first.userId }
  );
  const turn = await store.createTurn(
    personal.id,
    thread.id,
    'Review the exact proposed control.',
    { kind: 'user', id: first.userId },
    null
  );
  const workspaceDb = createTestWorkspaceDb(dataRoot, personal.id);
  workspaces.push(workspaceDb);
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'config/server.jsonc'),
    JSON.stringify({ schemaVersion: 1, policy: { mediation: document() } })
  );
  const manager = createRuntimeConfigManager({ dataRoot });
  const files = new RuntimeConfigFileService({
    dataRoot,
    userId: first.userId,
    workspaceIds: [personal.id],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const service = createAdministrationConfiguration({
    actor,
    coreDb,
    store,
    files,
    runtimeConfig: () => manager.current(),
    reload: async () => await manager.reload({ mode: 'safe', dryRun: false }),
    repositoryWorkspaceDb: (id) => {
      if (id !== personal.id) throw new Error('No fixture authority for another Workspace.');
      return workspaceDb;
    },
    inflightCommands: new WeakMap(),
  });
  const app = createApp({
    mode: 'server',
    coreDb,
    dataRoot,
    store,
    auth,
    runtimeConfigManager: manager,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
  });
  function request(proposed: PolicyDocumentV1) {
    return {
      targetFamily: 'policy' as const,
      targetId: 'server' as const,
      expectedRevision: files.readFile('server.jsonc').file.revision!,
      changes: { proposed, rationale: 'Human review of this exact reserved exposure control.' },
    };
  }
  const home = () => ({ threadId: thread.id, turnId: turn.id, requestId: randomUUID() });
  const propose = (proposed: PolicyDocumentV1) => service.propose(request(proposed), home());
  const apply = (p: Awaited<ReturnType<typeof propose>>) =>
    service.apply({
      requestId: randomUUID(),
      candidate: p.candidate,
      confirmation: p.confirmation,
    });
  const loaded = () =>
    readAdmittedPolicyDocument(coreDb, manager.current().openKitConfig.policy?.mediation);
  const bytes = () => files.readFile('server.jsonc').content;
  return {
    first,
    second,
    actor,
    coreDb,
    app,
    personal,
    service,
    files,
    manager,
    request,
    home,
    propose,
    apply,
    loaded,
    bytes,
  };
}

describe('E13 Phase A native human configuration', () => {
  it('stamps the actual human, preserves immutable confirmation, admits/reloads, and clears only by current widening', async () => {
    const f = await fixture();
    const original = f.bytes();
    const began = Date.now();
    const submitted = {
      ...control(f.first.userId),
      author: { kind: 'human', id: f.second.userId },
      authority: { kind: 'human', userId: f.second.userId },
    };
    const proposed = await f.propose(document(submitted));
    const ended = Date.now();
    expect(f.bytes()).toBe(original);
    const preview = PolicyWriteProposalV1Schema.parse(
      Reflect.get(proposed.preview, 'policyProposal')
    );
    expect(preview.proposer).toEqual({ kind: 'human', id: f.first.userId });
    expect(preview.proposed.statements[0]).toMatchObject({
      author: { kind: 'human', id: f.first.userId },
      authority: { kind: 'human', userId: f.first.userId },
      scope: { subjects: [{ kind: 'human', id: f.first.userId }] },
    });
    const stamp = Date.parse(preview.proposed.statements[0]!.authoredAt);
    expect(stamp).toBeGreaterThanOrEqual(began);
    expect(stamp).toBeLessThanOrEqual(ended);
    await expect(
      f.service.apply({
        requestId: randomUUID(),
        candidate: proposed.candidate,
        confirmation: { ...proposed.confirmation, contentDigest: `sha256:${'0'.repeat(64)}` },
      })
    ).rejects.toThrow();
    expect(f.bytes()).toBe(original);
    expect(await f.apply(proposed)).toMatchObject({ persisted: true, reload: 'applied' });
    const active = f.loaded();
    expect(active).toEqual(preview.proposed);
    expect(listServerPermissionDecisions(f.coreDb)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'workspace.configure',
          result: 'allow',
          resourceSummary: expect.objectContaining({ policyRevision: policyDigest(active) }),
          contextSummary: expect.objectContaining({ operation: 'policy.write' }),
        }),
      ])
    );
    expect(
      preparePolicyDocument({
        current: active,
        proposed: document(),
        userId: f.first.userId,
        now: new Date().toISOString(),
      }).classification
    ).toBe('widening');
    const clear = await f.propose(document());
    expect(f.loaded()).toEqual(active);
    expect(await f.apply(clear)).toMatchObject({ persisted: true, reload: 'applied' });
    expect(f.loaded()).toEqual(document());
  });

  it('preserves the existing ordinary Workspace Tool self-prohibition guard without a switch', async () => {
    const f = await fixture();
    const proposed = await f.propose(document(toolCondition(f.first.userId, f.personal.id)));
    expect(await f.apply(proposed)).toMatchObject({ persisted: true, reload: 'applied' });
    const before = f.bytes();
    await expect(f.propose(document())).rejects.toThrow(
      'Policy authors cannot widen their own authority.'
    );
    expect(f.bytes()).toBe(before);
  });

  it('does not exempt deactivation or laundering another self-prohibition alongside exact removal', async () => {
    const f = await fixture();
    const condition = toolCondition(f.first.userId, f.personal.id);
    const installed = await f.propose(document(control(f.first.userId), condition));
    expect(await f.apply(installed)).toMatchObject({ persisted: true, reload: 'applied' });
    const before = f.bytes();
    const active = f.loaded();
    const inactive = document(
      ...active.statements.map((s) => (s.id === 'close-gateway' ? { ...s, state: 'inactive' } : s))
    );
    await expect(f.propose(inactive)).rejects.toThrow(
      'Policy authors cannot widen their own authority.'
    );
    await expect(f.propose(document())).rejects.toThrow(
      'Policy authors cannot widen their own authority.'
    );
    expect(f.bytes()).toBe(before);
    expect(f.loaded()).toEqual(active);
  });

  it('retains real file CAS before accepting a stale canonical proposal', async () => {
    const f = await fixture();
    const stale = f.request(document(control(f.first.userId)));
    const read = f.files.readFile('server.jsonc');
    await f.files.updateFile({
      id: 'server.jsonc',
      kind: 'server',
      content: `${read.content}\n`,
      expectedRevision: read.file.revision!,
    });
    expect(f.files.readFile('server.jsonc').file.revision).not.toBe(stale.expectedRevision);
    const before = f.bytes();
    await expect(f.service.propose(stale, f.home())).rejects.toMatchObject({
      code: 'config_revision_conflict',
    });
    expect(f.bytes()).toBe(before);
    expect(f.loaded()).toEqual(document());
  });

  it('does not let a prepared clear retain revoked real administrator authority', async () => {
    const f = await fixture();
    expect(await f.apply(await f.propose(document(control(f.first.userId))))).toMatchObject({
      persisted: true,
      reload: 'applied',
    });
    const clear = await f.propose(document());
    const before = f.bytes();
    const revoke = await f.app.request(
      ...operationRequest(
        'token.revoke',
        { tokenId: f.first.administrator.tokenId },
        { headers: { cookie: f.second.cookie } }
      )
    );
    expect(revoke.status).toBe(200);
    await expect(f.apply(clear)).rejects.toThrow();
    expect(f.bytes()).toBe(before);
    expect(f.loaded().statements).toHaveLength(1);
  });
});
