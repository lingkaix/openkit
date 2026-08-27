import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { type BetterAuthServer, createAuthMiddleware } from './middleware.js';

describe('createAuthMiddleware', () => {
  it('fails closed for disabled implicit local and session users', async () => {
    const localApp = new Hono();
    localApp.use(
      '/api/*',
      createAuthMiddleware('local', undefined, { canonicalUserActive: () => false })
    );
    localApp.get('/api/private', (c) => c.json(c.get('actor')));

    const sessionApp = new Hono();
    const auth: BetterAuthServer = {
      api: { getSession: async () => ({ user: { id: 'user_disabled' } }) },
      handler: async () => new Response(null, { status: 404 }),
    };
    sessionApp.use(
      '/api/*',
      createAuthMiddleware('server', auth, { canonicalUserActive: () => false })
    );
    sessionApp.get('/api/private', (c) => c.json(c.get('actor')));

    expect((await localApp.request('/api/private')).status).toBe(401);
    expect((await sessionApp.request('/api/private')).status).toBe(401);
  });

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

  it('authenticates without inferring Workspace authorization from HTTP requests', async () => {
    let membershipVerifierCalls = 0;
    const options = {
      accessTokenVerifier: async () => ({
        actor: {
          userId: 'user_token',
          kind: 'token' as const,
          tokenScope: 'workspace-readonly' as const,
          tokenWorkspaceIds: ['ws_path', 'ws_body', 'ws_gateway'],
        },
        tokenId: 'tok_1',
      }),
      workspaceMembershipVerifier: async () => {
        membershipVerifierCalls += 1;
        return true;
      },
    };
    const tokenApp = new Hono();

    tokenApp.use('*', createAuthMiddleware('server', undefined, options));
    tokenApp.post('/api/app/workspaces/:workspaceId/mutate', async (c) =>
      c.json(await c.req.json())
    );
    tokenApp.post('/api/approvals/:approvalRequestId/respond', async (c) =>
      c.json(await c.req.json())
    );
    tokenApp.post('/v1/responses', async (c) => c.json(await c.req.json()));

    for (const request of [
      {
        path: '/api/app/workspaces/ws_path/mutate',
        body: { action: 'path-owned' },
      },
      {
        path: '/api/approvals/ap_1/respond',
        body: { action: 'body-owned', workspaceId: 'ws_body' },
      },
      {
        path: '/v1/responses',
        body: { metadata: { openkit: { workspaceId: 'ws_gateway' } } },
      },
    ]) {
      const response = await tokenApp.request(request.path, {
        method: 'POST',
        headers: {
          authorization: 'Bearer okt_test_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(request.body),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(request.body);
    }

    const sessionApp = new Hono();
    const auth: BetterAuthServer = {
      api: {
        getSession: async () => ({ user: { id: 'user_session' } }),
      },
      handler: async () => new Response(null, { status: 404 }),
    };

    sessionApp.use('*', createAuthMiddleware('server', auth, options));
    sessionApp.post('/api/app/workspaces/:workspaceId/mutate', (c) => c.json(c.get('actor')));

    const sessionResponse = await sessionApp.request('/api/app/workspaces/ws_path/mutate', {
      method: 'POST',
    });

    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toEqual({
      kind: 'session',
      userId: 'user_session',
    });
    expect(membershipVerifierCalls).toBe(0);
  });

  /**
   * S-2b-1 Unit 2: presented `nanohost-transport` material MUST NOT become a
   * product or `server-admin` actor on App API product paths
   * (`docs/specs/20260802-nanohost_runtime_and_transport.md`).
   */
  it('rejects presented nanohost-transport material on product App API paths', async () => {
    const nanohostSecret = 'okt_nanohost_transport_must_not_become_product_actor';
    const app = new Hono();

    app.use(
      '/api/*',
      createAuthMiddleware('server', undefined, {
        accessTokenVerifier: async (secret) =>
          secret === nanohostSecret
            ? {
                actor: {
                  kind: 'token',
                  // Simulate nanohost-transport material resolving into the product actor path.
                  tokenScope: 'nanohost-transport',
                  userId: 'integration_nanohost_primary',
                } as import('./identity.js').Actor,
                tokenId: 'tok_nanohost_1',
              }
            : null,
      })
    );
    app.get('/api/app/workspaces', (c) => c.json(c.get('actor')));
    app.get('/api/app/auth/tokens', (c) => c.json(c.get('actor')));

    for (const path of ['/api/app/workspaces', '/api/app/auth/tokens']) {
      const denied = await app.request(path, {
        headers: { authorization: `Bearer ${nanohostSecret}` },
      });
      const body = await denied.text();

      expect(denied.status).toBe(401);
      expect(body).not.toContain(nanohostSecret);
      expect(body).not.toContain('server-admin');
      expect(body).not.toContain('integration_nanohost_primary');
    }
  });
});
