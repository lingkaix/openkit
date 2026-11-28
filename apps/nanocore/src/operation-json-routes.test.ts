import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureRetryContext } from './auth/capture-retry-context.js';
import type { Actor } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { PUBLIC_OPERATION_ACCESS } from './auth/operation-access.js';
import type { FsStore } from './lib/store.js';
import * as invocation from './operation-composition.js';
import {
  registerOperationJsonRoutes,
  registerRetainedOperationRoutes,
} from './operation-json-routes.js';
import type { CoreDb } from './storage/db.js';
import { operationRequest } from './test-support/operation-request.js';

const requestActor: Actor = {
  kind: 'session',
  userId: 'usr_00000000-0000-7000-8000-000000000101',
  sessionId: 'auth_00000000-0000-7000-8000-000000000101',
};
const otherContextActor: Actor = {
  kind: 'session',
  userId: 'usr_00000000-0000-7000-8000-000000000102',
  sessionId: 'auth_00000000-0000-7000-8000-000000000102',
};

// Clone the immutable projection only in this test module so a synthetic access configuration can be installed.
vi.mock('./auth/operation-access.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth/operation-access.js')>();
  return { ...actual, PUBLIC_OPERATION_ACCESS: { ...actual.PUBLIC_OPERATION_ACCESS } };
});

/** Builds one route-level fixture with synthetic authenticated actors and a protected-operation spy. */
function createRouteFixture() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.set('actor', requestActor);
    await next();
  });
  registerOperationJsonRoutes({
    app,
    coreDb: undefined,
    requestStore: () => ({}) as FsStore,
  });
  const invoke = vi.fn(async () => ({
    userId: requestActor.userId,
    credential: { kind: 'session', scope: null },
  }));
  const createOperationInvocation = vi
    .spyOn(invocation, 'createOperationInvocation')
    .mockReturnValue(invoke);
  return { app, createOperationInvocation, invoke };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('operation JSON capture-retry context binding', () => {
  it('rejects a retry context owned by a different authenticated context before invocation', async () => {
    const { app, createOperationInvocation, invoke } = createRouteFixture();
    const retryContext = captureRetryContext(otherContextActor);
    expect(retryContext).toMatch(/^[a-f0-9]{64}$/);

    const response = await app.request(
      ...operationRequest(
        'caller.read',
        {},
        {
          headers: { 'x-openkit-retry-context': retryContext! },
        }
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'workspace_access_denied',
      message: 'Workspace access denied.',
    });
    expect(createOperationInvocation).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the same-context retry path available to the operation', async () => {
    const { app, invoke } = createRouteFixture();
    const retryContext = captureRetryContext(requestActor);
    expect(retryContext).toMatch(/^[a-f0-9]{64}$/);

    const response = await app.request(
      ...operationRequest(
        'caller.read',
        {},
        {
          headers: { 'x-openkit-retry-context': retryContext! },
        }
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      userId: requestActor.userId,
      credential: { kind: 'session', scope: null },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'caller.read',
      {},
      expect.objectContaining({
        kind: 'public',
        actor: requestActor,
      })
    );
  });
});

describe('retained Workspace operation administrator admission', () => {
  it('maps a deployment-administrator refusal to the uniform denial before invocation', async () => {
    const originalAccess = PUBLIC_OPERATION_ACCESS['workspace.archive-download'];
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      PUBLIC_OPERATION_ACCESS,
      'workspace.archive-download'
    );
    expect(originalAccess).toMatchObject({ resolver: 'path-workspace', scope: 'workspace' });
    Object.defineProperty(PUBLIC_OPERATION_ACCESS, 'workspace.archive-download', {
      configurable: true,
      enumerable: true,
      value: { ...originalAccess, authentication: 'deployment-admin' },
    });

    try {
      const app = new Hono<{ Variables: AuthVariables }>();
      app.use('*', async (c, next) => {
        c.set('actor', requestActor);
        await next();
      });
      registerRetainedOperationRoutes({
        app,
        coreDb: {
          dataRoot: '/unused',
          sqlite: {
            prepare: () => ({ get: () => ({ status: 'active' }) }),
          },
        } as unknown as CoreDb,
        quickChatWorkspaceIdForUser: () => 'ws_00000000-0000-7000-8000-000000000001',
        store: {} as FsStore,
      });
      const archiveHandler = vi.fn(() => Response.json({ downloaded: true }));
      app.get('/api/app/workspaces/:workspaceId/exports/:exportId/archive', archiveHandler);

      const response = await app.request(
        '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/exports/export-1/archive'
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: 'workspace_access_denied',
        message: 'Workspace access denied.',
      });
      expect(archiveHandler).not.toHaveBeenCalled();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          PUBLIC_OPERATION_ACCESS,
          'workspace.archive-download',
          originalDescriptor
        );
      }
    }
  });
});
