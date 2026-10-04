import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATION_DEFINITIONS, operationMcpEligible } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createOperationInvocation } from '../operation-composition.js';
import type { OperationInvocationContext } from '../operation-contract.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createOpenKitAccessTokenRecord } from './access-token-store.js';
import { ensureServerBootstrapToken } from './bootstrap-token.js';
import { ensureLocalUser } from './identity.js';
import type { BetterAuthServer } from './middleware.js';

/** Fresh storage proves refusal before bootstrap writes to any of its three durable owners. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b12-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const bootstrap = ensureServerBootstrapToken(coreDb)!;
  const input = {
    token: bootstrap.token,
    ownerUserId: 'user_bootstrap',
    displayName: 'Bootstrap owner',
    email: 'bootstrap@example.test',
    password: 'fixture-password',
    tokenExpiresAt: '2999-01-01T00:00:00.000Z',
  };
  return {
    coreDb,
    dataRoot,
    input,
    rows: () =>
      ['users', 'account', 'openkit_access_tokens'].map((table) =>
        coreDb.sqlite.prepare(`SELECT * FROM ${table}`).all()
      ),
    close: () => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

describe('B12 bootstrap credential admission', () => {
  it.each([
    'bearer',
    'session',
  ] as const)('refuses an ordinary %s before any bootstrap row is written', async (credential) => {
    const f = fixture();
    const auth: BetterAuthServer = {
      api: {
        getSession: async () =>
          credential === 'session' ? { user: { id: 'user_session' } } : null,
      },
      handler: async () => new Response(null, { status: 404 }),
    };
    const app = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, mode: 'server', auth });
    try {
      const before = f.rows();
      const response = await app.request(
        ...operationRequest(
          'bootstrap.consume',
          {},
          {
            headers: credential === 'bearer' ? { authorization: 'Bearer okt_fixture_bearer' } : {},
            body: JSON.stringify(f.input),
          }
        )
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'core.auth.unauthenticated' });
      expect(f.rows()).toEqual(before);
    } finally {
      f.close();
    }
  });

  it('refuses non-loopback plaintext before bootstrap writes even with a valid secret', async () => {
    const f = fixture();
    try {
      const app = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, mode: 'server' });
      const before = f.rows();
      const response = await app.request(
        new Request('http://public.example/api/app/operations/bootstrap.consume', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(f.input),
        }),
        undefined,
        { incoming: { socket: { encrypted: false, remoteAddress: '203.0.113.5' } } }
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'core.auth.insecure_transport' });
      expect(f.rows()).toEqual(before);
    } finally {
      f.close();
    }
  });

  it('refuses bootstrap under public, worker and coordinator contexts before its native owner writes', async () => {
    const f = fixture();
    try {
      const invoke = createOperationInvocation({ coreDb: f.coreDb, mode: 'server' });
      const contexts: OperationInvocationContext[] = [
        { kind: 'public', actor: { kind: 'local', userId: 'user_local' } },
        { kind: 'public', actor: { kind: 'session', userId: 'user_session' } },
        {
          kind: 'public',
          actor: { kind: 'token', userId: 'user_admin', tokenScope: 'server-admin' },
        },
        {
          kind: 'worker',
          actor: { kind: 'user', id: 'user_worker' },
          requestId: 'request_worker',
          bindings: {},
          lineage: {
            workspaceId: 'ws_test',
            threadId: 'th_test',
            turnId: 'turn_test',
            agentSessionId: 'as_test',
            packageSnapshotId: 'package_test',
          },
        },
        {
          kind: 'coordinator',
          actor: { kind: 'local', userId: 'user_local' },
          workspaceId: 'ws_test',
          threadId: 'th_test',
          goalId: 'goal_test',
          turnId: 'turn_test',
          requestId: 'request_test',
        },
      ];
      const before = f.rows();
      for (const context of contexts) {
        await expect(invoke('bootstrap.consume', f.input, context)).rejects.toMatchObject({
          code: 'core.auth.unauthenticated',
          status: 401,
        });
        expect(f.rows()).toEqual(before);
      }
      await expect(
        invoke(
          'token.create',
          { scope: 'server-admin', expiresAt: f.input.tokenExpiresAt },
          { kind: 'bootstrap' }
        )
      ).rejects.toMatchObject({ code: 'core.auth.unauthenticated', status: 401 });
      await expect(
        invoke('token.my-admin-default', { tokenId: 'missing' }, { kind: 'bootstrap' })
      ).rejects.toMatchObject({ code: 'core.auth.unauthenticated', status: 401 });
      expect(f.rows()).toEqual(before);
    } finally {
      f.close();
    }
  });

  it('declares every existing one-time-secret result ineligible for MCP', () => {
    for (const id of ['token.create', 'token.rotate', 'bootstrap.consume'] as const) {
      expect(OPERATION_DEFINITIONS[id].returnsOneTimeSecret).toBe(true);
      expect(operationMcpEligible(OPERATION_DEFINITIONS[id])).toBe(false);
    }
  });
});

const formerBindings = [
  ['GET', '/api/app/auth/my-admin-tokens', {}],
  ['PUT', '/api/app/auth/my-admin-tokens/default', { tokenId: 'tok_admin' }],
  ['GET', '/api/app/auth/tokens', {}],
  [
    'POST',
    '/api/app/auth/tokens',
    { scope: 'server-admin', expiresAt: '2999-01-01T00:00:00.000Z' },
  ],
  ['POST', '/api/app/auth/tokens/tok_admin/rotate', { graceSeconds: 60 }],
  ['POST', '/api/app/auth/tokens/tok_admin/revoke', {}],
  ['POST', '/api/app/auth/bootstrap/consume', {}],
] as const;

describe('B12 authorized former binding retirement', () => {
  it.each(
    formerBindings
  )('removes %s %s after reaching its native response on the base', async (method, path, input) => {
    const f = fixture();
    try {
      ensureLocalUser(f.coreDb);
      const admin = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'user_local',
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
        tokenId: 'tok_admin',
      });
      const auth: BetterAuthServer = {
        api: {
          getSession: async ({ headers }) =>
            headers.has('x-test-session') ? { user: { id: 'user_local' } } : null,
        },
        handler: async () => new Response(null, { status: 404 }),
      };
      const app = createApp({ coreDb: f.coreDb, dataRoot: f.dataRoot, mode: 'server', auth });
      const response = await app.request(path, {
        method,
        headers: path.includes('my-admin-tokens')
          ? { 'x-test-session': '1', 'content-type': 'application/json' }
          : { authorization: `Bearer ${admin.secret}`, 'content-type': 'application/json' },
        ...(method !== 'GET'
          ? { body: JSON.stringify(path.includes('bootstrap') ? f.input : input) }
          : {}),
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('404 Not Found');
    } finally {
      f.close();
    }
  });
});
