import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { type BetterAuthServer, createAuthMiddleware } from './middleware.js';

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

  it('does not treat a hostname beginning with 127 as a loopback address', async () => {
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
      new Request('http://127.evil.example/api/private', {
        headers: { authorization: 'Bearer okt_test_token' },
      })
    );

    expect(denied.status).toBe(400);
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

  it('uses the actual peer instead of a loopback Host header for bearer transport', async () => {
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
      new Request('https://127.0.0.1/api/private', {
        headers: { authorization: 'Bearer okt_test_token' },
      }),
      undefined,
      {
        incoming: {
          socket: {
            remoteAddress: '203.0.113.10',
            remoteFamily: 'IPv4',
            remotePort: 43123,
          },
        },
      }
    );

    expect(denied.status).toBe(400);
    await expect(denied.json()).resolves.toMatchObject({ code: 'core.auth.insecure_transport' });
    expect(verifierCalls).toBe(0);
  });

  it('accepts bearer transport from an encrypted Node socket regardless of the request URL', async () => {
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

    const allowed = await app.request(
      new Request('http://public.example/api/private', {
        headers: { authorization: 'Bearer okt_test_token' },
      }),
      undefined,
      {
        incoming: {
          socket: {
            encrypted: true,
            remoteAddress: '203.0.113.10',
            remoteFamily: 'IPv4',
            remotePort: 43123,
          },
        },
      }
    );

    expect(allowed.status).toBe(200);
  });

  it('uses the request URL only when no Node connection binding exists', async () => {
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

    const allowed = await app.request(
      new Request('https://public.example/api/private', {
        headers: { authorization: 'Bearer okt_test_token' },
      })
    );

    expect(allowed.status).toBe(200);
  });

  it('accepts plaintext bearer transport from an actual loopback peer', async () => {
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
      new Request('http://public.example/api/private', {
        headers: { authorization: 'Bearer okt_test_token' },
      }),
      undefined,
      {
        incoming: {
          socket: {
            remoteAddress: '::ffff:127.0.0.1',
            remoteFamily: 'IPv6',
            remotePort: 43123,
          },
        },
      }
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
        workspaceMembershipVerifier: async () => true,
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

  it('rejects workspace tokens when membership verification is unavailable', async () => {
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

    const denied = await app.request('/api/app/workspaces/ws_allowed/dashboard', {
      headers: { authorization: 'Bearer okt_test_token' },
    });

    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ code: 'core.auth.scope_forbidden' });
  });

  it('checks workspace membership for Better Auth session actors', async () => {
    const app = new Hono();
    const auth: BetterAuthServer = {
      api: {
        getSession: async () => ({ user: { id: 'user_session' } }),
      },
      handler: async () => new Response(null, { status: 404 }),
    };
    const checkedWorkspaceIds: string[] = [];

    app.use(
      '/api/*',
      createAuthMiddleware('server', auth, {
        workspaceMembershipVerifier: async (actor, workspaceId) => {
          expect(actor).toEqual({ kind: 'session', userId: 'user_session' });
          checkedWorkspaceIds.push(workspaceId);
          return workspaceId === 'ws_allowed';
        },
      })
    );
    app.get('/api/app/workspaces/:workspaceId/dashboard', (c) => c.json(c.get('actor')));

    const allowed = await app.request('/api/app/workspaces/ws_allowed/dashboard');
    const denied = await app.request('/api/app/workspaces/ws_denied/dashboard');
    const body = await denied.json();

    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
    expect(body.code).toBe('core.auth.scope_forbidden');
    expect(checkedWorkspaceIds).toEqual(['ws_allowed', 'ws_denied']);
  });

  it('rejects Better Auth session workspace access when membership verification is unavailable', async () => {
    const app = new Hono();
    const auth: BetterAuthServer = {
      api: {
        getSession: async () => ({ user: { id: 'user_session' } }),
      },
      handler: async () => new Response(null, { status: 404 }),
    };

    app.use('/api/*', createAuthMiddleware('server', auth));
    app.get('/api/app/workspaces/:workspaceId/dashboard', (c) => c.json(c.get('actor')));

    const denied = await app.request('/api/app/workspaces/ws_allowed/dashboard');

    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ code: 'core.auth.scope_forbidden' });
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
        workspaceMembershipVerifier: async () => true,
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
        workspaceMembershipVerifier: async () => true,
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

  it('gates workspace tokens by nested LLM Gateway workspace metadata', async () => {
    const app = new Hono();

    app.use(
      '/v1/*',
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
        workspaceMembershipVerifier: async (_actor, workspaceId) => workspaceId === 'ws_allowed',
      })
    );
    app.post('/v1/chat/completions', async (c) => c.json(await c.req.json()));

    const allowed = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer okt_test_token', 'content-type': 'text/plain' },
      body: JSON.stringify({ metadata: { openkit: { workspaceId: 'ws_allowed' } } }),
    });
    const denied = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer okt_test_token', 'content-type': 'text/plain' },
      body: JSON.stringify({ metadata: { openkit: { workspaceId: 'ws_denied' } } }),
    });

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ metadata: { openkit: { workspaceId: 'ws_allowed' } } });
    expect(denied.status).toBe(403);
  });

  it('gates Better Auth sessions by nested LLM Gateway workspace metadata', async () => {
    const app = new Hono();
    const auth: BetterAuthServer = {
      api: {
        getSession: async () => ({ user: { id: 'user_session' } }),
      },
      handler: async () => new Response(null, { status: 404 }),
    };

    app.use(
      '/v1/*',
      createAuthMiddleware('server', auth, {
        workspaceMembershipVerifier: async (_actor, workspaceId) => workspaceId === 'ws_allowed',
      })
    );
    app.post('/v1/responses', async (c) => c.json(await c.req.json()));

    const allowed = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ metadata: { openkit: { workspaceId: 'ws_allowed' } } }),
    });
    const denied = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ metadata: { openkit: { workspaceId: 'ws_denied' } } }),
    });

    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
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
