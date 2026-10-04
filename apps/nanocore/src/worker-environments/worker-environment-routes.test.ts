import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { registerOperationJsonRoutes } from '../operation-json-routes.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  WorkerEnvironmentOperationError,
  type WorkerEnvironmentOperations,
} from './worker-environment-operations.js';

const fixtures: Array<{ coreDb: CoreDb; dataRoot: string }> = [];
afterEach(() => {
  for (const { coreDb, dataRoot } of fixtures.splice(0)) {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
/** Uses real admission and explicit membership for the isolated family owner. */
function registerFamilyFixture(input: {
  app: Hono<{ Variables: AuthVariables }>;
  operations: WorkerEnvironmentOperations | null;
  prepare?: NonNullable<
    Parameters<typeof registerOperationJsonRoutes>[0]['workerEnvironmentServices']
  >['prepare'];
}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b10-routes-'));
  const coreDb = openCoreDb(dataRoot);
  fixtures.push({ coreDb, dataRoot });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
  registerOperationJsonRoutes({
    app: input.app,
    coreDb,
    store,
    requestStore: () => store,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    workerEnvironmentServices: { operations: input.operations, prepare: input.prepare },
  });
}

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
  registerFamilyFixture({ app, operations });
  return { app, operations };
}

describe('Worker environment routes', () => {
  it('keeps the public surface registered when its backing owner is unavailable', async () => {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (context, next) => {
      context.set('actor', { kind: 'local', userId: 'user_local' });
      await next();
    });
    registerFamilyFixture({ app, operations: null });

    const response = await app.request(
      ...operationRequest('worker-environment.list', { workspaceId: 'ws_demo' })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'worker_environment_unavailable',
    });
  });

  it('parses bounded list pagination before invoking the shared operation', async () => {
    const { app, operations } = fixture();
    const response = await app.request(
      ...operationRequest('worker-environment.list', { workspaceId: 'ws_demo', limit: 12 })
    );

    expect(response.status).toBe(200);
    expect(operations.list).toHaveBeenCalledWith(
      { actor: { kind: 'local', userId: 'user_local' }, workspaceId: 'ws_demo' },
      { limit: 12 }
    );
  });

  it('rejects a purge confirmation/logical reference mismatch before any destructive operation', async () => {
    const { app, operations } = fixture();
    const otherRef = `wst_${'b'.repeat(32)}`;
    const response = await app.request(
      ...operationRequest(
        'worker-environment.purge',
        { workspaceId: 'ws_demo', storageRef: STORAGE_REF },
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
      )
    );

    expect(response.status).toBe(400);
    expect(operations.purge).not.toHaveBeenCalled();
  });

  it('rejects an invalid status reference before invoking the shared operation', async () => {
    const { app, operations } = fixture();
    const response = await app.request(
      ...operationRequest('worker-environment.status', {
        workspaceId: 'ws_demo',
        storageRef: 'not-a-storage-ref',
      })
    );

    expect(response.status).toBe(400);
    expect(operations.status).not.toHaveBeenCalled();
  });

  it('keeps preparation and activation visibly unavailable until their owners are composed', async () => {
    const { app } = fixture();
    const response = await app.request(
      ...operationRequest(
        'worker-environment.recover',
        {},
        {
          body: JSON.stringify({
            administrationThreadId: 'thread_admin',
            requestId: REQUEST_ID,
            recoverFrom: {
              artifactId: 'artifact_candidate',
              artifactVersion: 1,
              contentDigest: `sha256:${'b'.repeat(64)}`,
            },
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );

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
    registerFamilyFixture({ app, operations: null, prepare });
    const input = {
      administrationThreadId: 'thread_admin',
      requestId: REQUEST_ID,
      recoverFrom: {
        artifactId: 'artifact_candidate',
        artifactVersion: 1,
        contentDigest: `sha256:${'b'.repeat(64)}`,
      },
    };
    const response = await app.request(
      ...operationRequest(
        'worker-environment.recover',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }
      )
    );
    expect(response.status).toBe(409);
    expect(prepare).toHaveBeenCalledWith(
      { actor: { kind: 'local', userId: 'user_local' } },
      { ...input, mode: 'recover' }
    );
    await expect(response.json()).resolves.toMatchObject({ code: 'recovery_required' });
  });
});
