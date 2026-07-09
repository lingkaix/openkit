import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createAuthMiddleware } from './middleware.js';

describe('createAuthMiddleware', () => {
  it('passes through local-mode requests and exposes the local actor', async () => {
    const app = new Hono();

    app.use('/api/*', createAuthMiddleware('local'));
    app.get('/api/private', (c) => c.json(c.get('actor')));

    const res = await app.request('/api/private');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'user_local', kind: 'local' });
  });

  it('authenticates server-mode bearer access tokens without exposing token material', async () => {
    const token = 'okt_test_token';
    const app = new Hono();

    app.use(
      '/api/*',
      createAuthMiddleware('server', undefined, {
        accessTokenVerifier: async (secret) =>
          secret === token
            ? {
                actor: { userId: 'user_token', kind: 'token' },
                tokenId: 'tok_1',
              }
            : null,
      })
    );
    app.get('/api/private', (c) => c.json(c.get('actor')));

    const ok = await app.request('/api/private', {
      headers: { authorization: `Bearer ${token}` },
    });
    const denied = await app.request('/api/private', {
      headers: { authorization: 'Bearer okt_bad_token' },
    });

    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ userId: 'user_token', kind: 'token', tokenId: 'tok_1' });
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain('okt_bad_token');
  });

  it('refuses bearer tokens over non-loopback plaintext HTTP before verification', async () => {
    let verifierCalls = 0;
    const app = new Hono();

    app.use(
      '/api/*',
      createAuthMiddleware('server', undefined, {
        accessTokenVerifier: async () => {
          verifierCalls += 1;
          return {
            actor: { userId: 'user_token', kind: 'token' },
            tokenId: 'tok_1',
          };
        },
      })
    );
    app.get('/api/private', (c) => c.json(c.get('actor')));

    const denied = await app.request(
      new Request('http://203.0.113.10/api/private', {
        headers: { authorization: 'Bearer okt_test_token' },
      })
    );
    const body = await denied.json();

    expect(denied.status).toBe(400);
    expect(body.code).toBe('core.auth.insecure_transport');
    expect(JSON.stringify(body)).not.toContain('okt_test_token');
    expect(verifierCalls).toBe(0);
  });

  it('accepts bearer tokens over loopback plaintext HTTP', async () => {
    const app = new Hono();

    app.use(
      '/api/*',
      createAuthMiddleware('server', undefined, {
        accessTokenVerifier: async () => ({
          actor: { userId: 'user_token', kind: 'token' },
          tokenId: 'tok_1',
        }),
      })
    );
    app.get('/api/private', (c) => c.json(c.get('actor')));

    const ok = await app.request(
      new Request('http://127.0.0.1/api/private', {
        headers: { authorization: 'Bearer okt_test_token' },
      })
    );

    expect(ok.status).toBe(200);
  });

  it('rejects workspace tokens on unbound workspace routes', async () => {
    const app = new Hono();

    app.use(
      '/api/*',
      createAuthMiddleware('server', undefined, {
        accessTokenVerifier: async () => ({
          actor: {
            userId: 'user_token',
            kind: 'token',
            tokenScope: 'workspace',
            tokenWorkspaceIds: ['ws_allowed'],
          },
          tokenId: 'tok_1',
        }),
      })
    );
    app.get('/api/app/workspaces/:workspaceId/dashboard', (c) => c.json(c.get('actor')));

    const allowed = await app.request('/api/app/workspaces/ws_allowed/dashboard', {
      headers: { authorization: 'Bearer okt_test_token' },
    });
    const denied = await app.request('/api/app/workspaces/ws_denied/dashboard', {
      headers: { authorization: 'Bearer okt_test_token' },
    });
    const body = await denied.json();

    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
    expect(body.code).toBe('core.auth.scope_forbidden');
    expect(JSON.stringify(body)).not.toContain('ws_denied');
  });

  it('rejects workspace tokens when the owner is not an active workspace member', async () => {
    const app = new Hono();

    app.use(
      '/api/*',
      createAuthMiddleware('server', undefined, {
        accessTokenVerifier: async () => ({
          actor: {
            userId: 'user_token',
            kind: 'token',
            tokenScope: 'workspace',
            tokenWorkspaceIds: ['ws_allowed'],
          },
          tokenId: 'tok_1',
        }),
        workspaceMembershipVerifier: async () => false,
      })
    );
    app.get('/api/app/workspaces/:workspaceId/dashboard', (c) => c.json(c.get('actor')));

    const denied = await app.request('/api/app/workspaces/ws_allowed/dashboard', {
      headers: { authorization: 'Bearer okt_test_token' },
    });
    const body = await denied.json();

    expect(denied.status).toBe(403);
    expect(body.code).toBe('core.auth.scope_forbidden');
  });

  it('rejects workspace-readonly tokens on mutating workspace routes', async () => {
    const app = new Hono();

    app.use(
      '/api/*',
      createAuthMiddleware('server', undefined, {
        accessTokenVerifier: async () => ({
          actor: {
            userId: 'user_token',
            kind: 'token',
            tokenScope: 'workspace-readonly',
            tokenWorkspaceIds: ['ws_allowed'],
          },
          tokenId: 'tok_1',
        }),
      })
    );
    app.get('/api/app/workspaces/:workspaceId/dashboard', (c) => c.json(c.get('actor')));
    app.post('/api/app/workspaces/:workspaceId/threads', (c) => c.json(c.get('actor')));

    const read = await app.request('/api/app/workspaces/ws_allowed/dashboard', {
      headers: { authorization: 'Bearer okt_test_token' },
    });
    const write = await app.request('/api/app/workspaces/ws_allowed/threads', {
      method: 'POST',
      headers: { authorization: 'Bearer okt_test_token' },
    });

    expect(read.status).toBe(200);
    expect(write.status).toBe(403);
  });

  it('gates non-workspace paths by JSON body workspace without consuming the body', async () => {
    const app = new Hono();

    app.use(
      '/api/*',
      createAuthMiddleware('server', undefined, {
        accessTokenVerifier: async () => ({
          actor: {
            userId: 'user_token',
            kind: 'token',
            tokenScope: 'workspace',
            tokenWorkspaceIds: ['ws_allowed'],
          },
          tokenId: 'tok_1',
        }),
      })
    );
    app.post('/api/approvals/:approvalRequestId/respond', async (c) => c.json(await c.req.json()));

    const allowed = await app.request('/api/approvals/ap_allowed/respond', {
      method: 'POST',
      headers: {
        authorization: 'Bearer okt_test_token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'granted', workspaceId: 'ws_allowed' }),
    });
    const denied = await app.request('/api/approvals/ap_denied/respond', {
      method: 'POST',
      headers: {
        authorization: 'Bearer okt_test_token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'granted', workspaceId: 'ws_denied' }),
    });

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ decision: 'granted', workspaceId: 'ws_allowed' });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain('ws_denied');
  });

  it('rejects workspace-scoped tokens on non-workspace mutating routes', async () => {
    const app = new Hono();

    app.use(
      '/api/*',
      createAuthMiddleware('server', undefined, {
        accessTokenVerifier: async () => ({
          actor: {
            userId: 'user_token',
            kind: 'token',
            tokenScope: 'workspace',
            tokenWorkspaceIds: ['ws_allowed'],
          },
          tokenId: 'tok_1',
        }),
      })
    );
    app.post('/api/workspaces', (c) => c.json(c.get('actor')));

    const denied = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { authorization: 'Bearer okt_test_token' },
    });

    expect(denied.status).toBe(403);
  });
});
