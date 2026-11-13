import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { CoreDb } from './storage/db.js';
import { createTestCoreDb, createTestStore, disposeTestStore } from './test-support/store.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const POLICY = "script-src 'self'; object-src 'none'; base-uri 'self'";
const ORIGIN = 'https://ui.fixture.invalid';
const corsOptions = {
  mode: 'server' as const,
  openKitConfig: { server: { cors: { origins: [ORIGIN] } } },
};

const owned: { dataRoot: string; coreDb: CoreDb }[] = [];

afterEach(async () => {
  for (const fixture of owned.splice(0)) await disposeTestStore(fixture.dataRoot, fixture.coreDb);
});

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-core-csp-'));
  const coreDb = createTestCoreDb(dataRoot);
  owned.push({ dataRoot, coreDb });
  return {
    coreDb,
    dataRoot,
    store: createTestStore({ dataRoot }),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
  };
}

describe('default Core response CSP at the actual Hono App boundary', () => {
  it('protects ordinary public success responses without changing body or configured CORS', async () => {
    const owner = fixture();
    const ordinary = await createApp({ ...owner, mode: 'server' }).request('/health');
    expect(ordinary.status).toBe(200);
    expect(await ordinary.json()).toEqual({ status: 'ok', service: 'nanocore' });
    expect(ordinary.headers.get('www-authenticate')).toBeNull();
    expect(ordinary.headers.get('access-control-allow-origin')).toBeNull();

    const cors = await createApp({ ...owner, ...corsOptions }).request('/api/health', {
      headers: { origin: ORIGIN },
    });
    expect(cors.status).toBe(200);
    expect(await cors.json()).toEqual({ status: 'ok', service: 'nanocore' });
    expect(cors.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(cors.headers.get('access-control-allow-credentials')).toBe('true');
    expect(cors.headers.get('access-control-expose-headers')).toBe(
      'X-OpenKit-Content-Digest,X-OpenKit-Byte-Length,Retry-After,X-OpenKit-Retry-Context'
    );

    expect(ordinary.headers.get('content-security-policy')).toBe(POLICY);
    expect(cors.headers.get('content-security-policy')).toBe(POLICY);
  });

  it('protects early auth and CORS refusals without granting admission or losing their original headers', async () => {
    const app = createApp({ ...fixture(), ...corsOptions });
    const unauthorized = await app.request('/mcp', {
      method: 'POST',
      headers: { origin: ORIGIN },
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      code: 'core.auth.unauthenticated',
      message: 'Authentication required.',
    });
    expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');
    expect(unauthorized.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(unauthorized.headers.get('access-control-allow-credentials')).toBe('true');

    const forbidden = await app.request('/api/health', {
      headers: { origin: 'https://blocked.fixture.invalid' },
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      code: 'cors_origin_forbidden',
      message: 'Browser origin is not allowed.',
    });
    expect(forbidden.headers.get('access-control-allow-origin')).toBeNull();
    expect(forbidden.headers.get('access-control-allow-credentials')).toBeNull();
    expect(forbidden.headers.get('access-control-expose-headers')).toBeNull();

    expect(unauthorized.headers.get('content-security-policy')).toBe(POLICY);
    expect(forbidden.headers.get('content-security-policy')).toBe(POLICY);
  });

  it('protects the actual unmatched Core response without replacing its status or plain-text body', async () => {
    const response = await createApp({ ...fixture(), mode: 'server' }).request(
      '/__core_csp_unregistered__'
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=UTF-8');
    expect(await response.text()).toBe('404 Not Found');
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBe(POLICY);
  });
});
