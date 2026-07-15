import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ApiErrorSchema, PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import { createApp } from '../test-support/app.js';
import { actorFromSession } from './identity.js';
import type { BetterAuthServer } from './middleware.js';

/**
 * Lists TypeScript source files recursively.
 *
 * @param root Directory to scan.
 * @returns Absolute TypeScript file paths.
 */
function listSourceFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
      continue;
    }

    if (entry.isFile() && path.endsWith('.ts')) {
      files.push(path);
    }
  }

  return files;
}

/**
 * Creates a minimal Better Auth stub for server-mode middleware tests.
 *
 * @param session Session payload returned by getSession.
 * @returns Better Auth-compatible test double.
 */
function createAuthStub(
  session: Awaited<ReturnType<BetterAuthServer['api']['getSession']>>
): BetterAuthServer {
  return {
    api: {
      getSession: async () => session,
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

describe('server-mode auth middleware', () => {
  it('rejects protected API routes without a session', async () => {
    const app = createApp({ auth: createAuthStub(null), mode: 'server' });
    const res = await app.request('/api/workspaces');

    expect(res.status).toBe(401);
    expect(ApiErrorSchema.parse(await res.json())).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      code: 'core.auth.unauthenticated',
      message: 'Authentication required.',
    });
  });

  it('allows protected API routes with a valid session', async () => {
    const app = createApp({
      auth: createAuthStub({
        session: { id: 'session_1' },
        user: { id: 'user_1' },
      }),
      mode: 'server',
    });
    const res = await app.request('/api/workspaces');

    expect(res.status).toBe(200);
  });

  it('protects every public LLM Gateway route before request parsing', async () => {
    const app = createApp({ auth: createAuthStub(null), mode: 'server' });

    for (const request of [
      { path: '/v1/models' },
      {
        path: '/v1/chat/completions',
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' },
      },
      {
        path: '/v1/responses',
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' },
      },
    ]) {
      const res = await app.request(request.path, request.init);

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ code: 'core.auth.unauthenticated' });
    }
  });

  it('keeps LLM Gateway routes usable for authenticated server actors and local mode', async () => {
    const serverApp = createApp({
      auth: createAuthStub({ session: { id: 'session_1' }, user: { id: 'user_1' } }),
      mode: 'server',
    });
    const localApp = createApp({ mode: 'local' });

    expect((await serverApp.request('/v1/models')).status).toBe(200);
    expect((await localApp.request('/v1/models')).status).toBe(200);
  });

  it('keeps reduced public meta, health, and Better Auth routes open', async () => {
    const app = createApp({ auth: createAuthStub(null), mode: 'server' });

    const metaRes = await app.request('/api/meta');
    const healthRes = await app.request('/api/health');
    const authRes = await app.request('/api/auth/ok');

    expect(metaRes.status).toBe(200);
    expect(await metaRes.json()).toEqual({
      protocolVersion: '0.3.0',
      capabilities: [],
      eventFamilies: [],
    });
    expect(healthRes.status).toBe(200);
    expect(authRes.status).toBe(200);
  });

  it('maps Better Auth sessions through the identity facade', () => {
    expect(actorFromSession({ user: { id: 'user_1' } })).toEqual({
      userId: 'user_1',
      kind: 'session',
    });
  });

  it('keeps Better Auth imports isolated to auth modules', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const offenders = listSourceFiles(sourceRoot)
      .filter((path) => !relative(sourceRoot, path).startsWith('auth/'))
      .filter((path) => /from ['"]@?better-auth/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(process.cwd(), path));

    expect(offenders).toEqual([]);
  });
});
