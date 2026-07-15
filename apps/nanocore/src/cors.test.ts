import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BetterAuthServer } from './auth/middleware.js';
import { createApp } from './test-support/app.js';

/**
 * Creates the smallest signed-out Better Auth surface needed by CORS tests.
 *
 * @returns Better Auth facade that never authenticates a session.
 */
function signedOutAuth(): BetterAuthServer {
  return {
    api: { getSession: async () => null },
    handler: async () => new Response(null, { status: 404 }),
  };
}

describe('browser CORS', () => {
  it('allows only exact configured origins with credentials in server mode', async () => {
    const app = createApp({
      auth: signedOutAuth(),
      mode: 'server',
      openKitConfig: {
        server: {
          cors: { origins: ['https://console.openkit.example'] },
          publicBaseUrl: 'https://core.openkit.example',
        },
      },
    });

    for (const origin of ['https://console.openkit.example', 'https://core.openkit.example']) {
      const allowed = await app.request('/api/health', { headers: { origin } });

      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('access-control-allow-origin')).toBe(origin);
      expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    }

    for (const origin of [
      'https://evil.example',
      'https://console.openkit.example.evil.test',
      'http://127.evil.example',
      'null',
    ]) {
      const rejected = await app.request('/api/health', { headers: { origin } });

      expect(rejected.status).toBe(403);
      expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
      expect(rejected.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });

  it('allows loopback browser origins by default in local mode', async () => {
    const app = createApp();
    const loopback = await app.request('/api/health', {
      headers: { origin: 'http://localhost:5173' },
    });
    const remote = await app.request('/api/health', {
      headers: { origin: 'https://evil.example' },
    });
    const spoofed = await app.request('/api/health', {
      headers: { origin: 'http://127.evil.example' },
    });
    const nonOriginUrl = await app.request('/api/health', {
      headers: { origin: 'http://localhost:5173/path' },
    });
    const withoutOrigin = await app.request('/api/health');

    expect(loopback.status).toBe(200);
    expect(loopback.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(loopback.headers.get('access-control-allow-credentials')).toBe('true');
    expect(remote.status).toBe(403);
    expect(remote.headers.get('access-control-allow-origin')).toBeNull();
    expect(remote.headers.get('access-control-allow-credentials')).toBeNull();
    expect(spoofed.status).toBe(403);
    expect(spoofed.headers.get('access-control-allow-origin')).toBeNull();
    expect(spoofed.headers.get('access-control-allow-credentials')).toBeNull();
    expect(nonOriginUrl.status).toBe(403);
    expect(nonOriginUrl.headers.get('access-control-allow-origin')).toBeNull();
    expect(nonOriginUrl.headers.get('access-control-allow-credentials')).toBeNull();
    expect(withoutOrigin.status).toBe(200);
  });

  it('rejects a disallowed browser origin before a mutating handler runs', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-cors-mutation-'));
    const app = createApp({ dataRoot });
    const before = await app.request('/api/workspaces');
    const workspacesBefore = await before.json();

    const rejected = await app.request('/api/workspaces', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({
        name: 'CSRF probe',
        requestId: '00000000-0000-4000-8000-00000000c001',
      }),
    });
    const workspaces = await app.request('/api/workspaces');

    expect(rejected.status).toBe(403);
    await expect(workspaces.json()).resolves.toEqual(workspacesBefore);
  });
});
