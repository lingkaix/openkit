import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { AuthVariables } from '../auth/middleware.js';
import {
  WorkerEnvironmentOperationError,
  type WorkerEnvironmentOperations,
} from './worker-environment-operations.js';
import { registerWorkerEnvironmentRoutes } from './worker-environment-routes.js';

const STORAGE_REF = `wst_${'a'.repeat(32)}`;
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

/** Creates an isolated route surface with one authenticated local actor. */
function fixture() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (context, next) => {
    context.set('actor', { kind: 'local', userId: 'user_local' });
    await next();
  });
  const operations: WorkerEnvironmentOperations = {
    list: vi.fn(() => ({ items: [], nextCursor: null })),
    select: vi.fn(() => {
      throw new Error('Not exercised.');
    }),
    status: vi.fn(async () => {
      throw new Error('Not exercised.');
    }),
    purge: vi.fn(async (_context, input) => ({
      environment: null,
      outcome: 'purged',
      requestId: input.requestId,
      storageRef: input.storageRef,
    })),
  };
  registerWorkerEnvironmentRoutes({ app, operations });
  return { app, operations };
}

describe('Worker environment routes', () => {
  it('keeps the public surface registered when its backing owner is unavailable', async () => {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (context, next) => {
      context.set('actor', { kind: 'local', userId: 'user_local' });
      await next();
    });
    registerWorkerEnvironmentRoutes({ app, operations: null });

    const response = await app.request('/api/app/workspaces/ws_demo/worker-environments');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'worker_environment_unavailable',
    });
  });

  it('parses bounded list pagination before invoking the shared operation', async () => {
    const { app, operations } = fixture();
    const response = await app.request('/api/app/workspaces/ws_demo/worker-environments?limit=12');

    expect(response.status).toBe(200);
    expect(operations.list).toHaveBeenCalledWith(
      { actor: { kind: 'local', userId: 'user_local' }, workspaceId: 'ws_demo' },
      { limit: 12 }
    );
  });

  it('rejects a purge path/body mismatch before any destructive operation', async () => {
    const { app, operations } = fixture();
    const otherRef = `wst_${'b'.repeat(32)}`;
    const response = await app.request(
      `/api/app/workspaces/ws_demo/worker-environments/${STORAGE_REF}/purge`,
      {
        body: JSON.stringify({
          confirmation: `purge-worker-environment:${otherRef}:4`,
          expectedRevision: 4,
          requestId: REQUEST_ID,
          storageRef: otherRef,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );

    expect(response.status).toBe(400);
    expect(operations.purge).not.toHaveBeenCalled();
  });

  it('rejects an invalid status reference before invoking the shared operation', async () => {
    const { app, operations } = fixture();
    const response = await app.request(
      '/api/app/workspaces/ws_demo/worker-environments/not-a-storage-ref/status'
    );

    expect(response.status).toBe(400);
    expect(operations.status).not.toHaveBeenCalled();
  });

  it('keeps preparation and activation visibly unavailable until their owners are composed', async () => {
    const { app } = fixture();
    const response = await app.request('/api/app/worker-environments/prepare', {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'worker_environment_unavailable',
    });
  });
  it('dispatches exact global recovery input with the current actor and preserves recovery refusal', async () => {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (context, next) => {
      context.set('actor', { kind: 'local', userId: 'user_local' });
      await next();
    });
    const prepare = vi.fn(async () => {
      throw new WorkerEnvironmentOperationError(
        'recovery_required',
        'Image result is unavailable.'
      );
    });
    registerWorkerEnvironmentRoutes({ app, operations: null, prepare });
    const input = {
      mode: 'recover',
      administrationThreadId: 'thread_admin',
      requestId: REQUEST_ID,
      recoverFrom: {
        artifactId: 'artifact_candidate',
        artifactVersion: 1,
        contentDigest: `sha256:${'b'.repeat(64)}`,
      },
    };
    const response = await app.request('/api/app/worker-environments/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(409);
    expect(prepare).toHaveBeenCalledWith({ actor: { kind: 'local', userId: 'user_local' } }, input);
    await expect(response.json()).resolves.toMatchObject({ code: 'recovery_required' });
  });
});
