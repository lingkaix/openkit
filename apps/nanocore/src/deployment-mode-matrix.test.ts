import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { createConfiguredWorkerLifecycleRuntime } from './runtime/turn-executor-factory.js';
import { WorkerControlGateway } from './runtime/worker-control-gateway.js';
import { type CoreDb, openCoreDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';

/** NanoCore product deployment mode used by the verification matrix. */
type CoreDeploymentMode = 'local' | 'server';

/** One NanoCore deployment matrix case. */
interface DeploymentModeMatrixCase {
  /** NanoCore product mode selected for the app. */
  coreMode: CoreDeploymentMode;
  /** Sole production runtime target selected for the turn executor. */
  runtimeTargetKind: 'nanohost';
}

const MATRIX_CASES: DeploymentModeMatrixCase[] = [
  { coreMode: 'local', runtimeTargetKind: 'nanohost' },
  { coreMode: 'server', runtimeTargetKind: 'nanohost' },
];

describe('NanoCore deployment mode matrix', () => {
  it.each(MATRIX_CASES)('boots diagnostics for core=$coreMode runtime=$runtimeTargetKind', async ({
    coreMode,
    runtimeTargetKind,
  }) => {
    const coreDb = createCoreDb();
    const runtime = createMatrixRuntime(coreDb);

    try {
      let authorization: string | undefined;
      if (coreDb) {
        ensureLocalUser(coreDb);
        const serverAdmin = createOpenKitAccessTokenRecord(coreDb, {
          expiresAt: '2999-01-01T00:00:00.000Z',
          ownerUserId: LOCAL_USER_ID,
          scope: 'server-admin',
          workspaceIds: [],
        });
        authorization = `Bearer ${serverAdmin.secret}`;
      }
      const app = createApp({
        ...(coreMode === 'server'
          ? { auth: createSignedInAuthStub(), coreDb: coreDb!, mode: 'server' }
          : {}),
        agentManifests: [],
        turnExecutor: runtime.turnExecutor,
      });
      const diagnostics = await app.request('/api/diagnostics', {
        ...(authorization ? { headers: { authorization } } : {}),
      });
      const payload = await diagnostics.json();

      expect(diagnostics.status).toBe(200);
      expect(payload).toMatchObject({
        auth: coreMode === 'server' ? { mode: 'server', signedIn: false } : { mode: 'local' },
        mode: coreMode,
      });
      expect((runtime as unknown as { runtimeTargetKind?: string }).runtimeTargetKind).toEqual(
        runtimeTargetKind
      );
      expect(runtime.turnExecutor).not.toHaveProperty('environmentBackend');
    } finally {
      coreDb.sqlite.close();
    }
  });
});

/**
 * Creates the configured NanoHost lifecycle without starting a real worker process.
 *
 * @param coreDb Durable Core database required by the real executor factory.
 * @returns Configured lifecycle runtime.
 */
function createMatrixRuntime(coreDb: CoreDb) {
  return createConfiguredWorkerLifecycleRuntime({
    coreDb,
    env: {},
    workerControlGateway: new WorkerControlGateway(),
  });
}

/**
 * Opens a migrated temporary Core database for deployment matrix tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-deployment-matrix-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Creates a signed-in Better Auth test double for server-mode matrix checks.
 *
 * @returns Better Auth-compatible server stub.
 */
function createSignedInAuthStub(): BetterAuthServer {
  return {
    api: {
      getSession: async () => ({
        session: { id: 'session_matrix_secret' },
        user: { id: LOCAL_USER_ID },
      }),
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

// This fixture supplies confirmed image evidence; the production resolver and subject checks still run.
vi.mock('./runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    './test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});
