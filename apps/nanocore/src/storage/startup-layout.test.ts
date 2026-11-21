import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { createAppWithLocalIdentity as createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestStore } from '../test-support/store.js';
import { ensureUserQuickChatWorkspace } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { admitDataRootForBoot, openCoreDb, recordDataRootDeploymentMove } from './db.js';
import { coreDbPath, ensureLayout } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import { dataRootInventory, retainedV010CoreBytes } from './test-support/data-root-admission.js';

/**
 * Creates an isolated data root for NanoCore startup layout tests.
 *
 * @returns Absolute temporary data-root path.
 */
function createDataRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-startup-layout-'));
}

/**
 * Proves the refused child left no process bound to the fixture port.
 *
 * @param port Port the real entrypoint would have used.
 */
function expectNoListener(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.end();
      reject(new Error(`A listener remained on port ${port}.`));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
  });
}

/** Boots the real entrypoint with isolated authority until it refuses the root. */
function runRefusedNanoCore(dataRoot: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      VITEST: 'true',
      OPENKIT_DATA_ROOT: dataRoot,
      OPENKIT_CORE_MODE: 'server',
      OPENKIT_BIND_HOST: '127.0.0.1',
      PORT: '9947',
      BETTER_AUTH_SECRET: 'ad1-isolated-boot-fixture-only-better-auth',
    },
  });
}

describe('NanoCore startup storage layout', () => {
  it.runIf(process.platform === 'linux').each(['present', 'missing'] as const)(
    'refuses the predecessor Core ledger before credentials or ingress with runtime %s',
    (runtime) => {
      const dataRoot = createDataRoot();
      try {
        const coreDb = openCoreDb(dataRoot);
        try {
          applyMigrations(coreDb);
          coreDb.sqlite.prepare('UPDATE __drizzle_migrations SET hash = ?').run('predecessor-sql');
        } finally {
          coreDb.sqlite.close();
        }
        const dbPath = coreDbPath(dataRoot);
        const original = readFileSync(dbPath);
        const runtimePath = join(dataRoot, 'server', 'runtime');
        if (runtime === 'missing') rmSync(runtimePath, { recursive: true });
        const result = runRefusedNanoCore(dataRoot);

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr.includes('A fresh v0.2.0 installation is required.')).toBe(true);
        expect(result.stdout.includes('App server is running')).toBe(false);
        expect(existsSync(join(dataRoot, 'server', 'files', 'auth', 'bootstrap-token.txt'))).toBe(
          false
        );
        expect(existsSync(runtimePath)).toBe(runtime === 'present');
        expect(readFileSync(dbPath)).toEqual(original);
      } finally {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === 'linux')(
    'checks legacy ownership on restart after current Core admission of a restored root',
    () => {
      const dataRoot = createDataRoot();
      try {
        const coreDb = openCoreDb(dataRoot);
        try {
          applyMigrations(coreDb);
        } finally {
          coreDb.sqlite.close();
        }
        const original = readFileSync(coreDbPath(dataRoot));
        const runtimePath = join(dataRoot, 'server', 'runtime');
        rmSync(runtimePath, { recursive: true });
        writeFileSync(join(dataRoot, 'core.sqlite'), 'legacy Core');

        const result = runRefusedNanoCore(dataRoot);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Unsupported legacy root core database');
        expect(result.stdout).not.toContain('App server is running');
        expect(existsSync(runtimePath)).toBe(true);
        expect(readFileSync(coreDbPath(dataRoot))).toEqual(original);
      } finally {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === 'linux').each([
    { label: 'markerless', marker: false },
    { label: 'original v1 marker without deploymentId', marker: true },
  ])('refuses retained v0.1.0 Core before startup writes ($label)', async ({ marker }) => {
    const dataRoot = createDataRoot();
    try {
      mkdirSync(join(dataRoot, 'server', 'db'), { recursive: true });
      writeFileSync(join(dataRoot, 'server', 'db', 'core.sqlite'), retainedV010CoreBytes());
      if (marker) {
        writeFileSync(
          join(dataRoot, 'server', 'layout.json'),
          `${JSON.stringify({ schemaVersion: 1, layoutVersion: 1 }, null, 2)}\n`
        );
      }
      // Config templates are absent on purpose. A write before refusal would create them.
      expect(existsSync(join(dataRoot, 'config'))).toBe(false);
      const before = dataRootInventory(dataRoot);
      const result = runRefusedNanoCore(dataRoot);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unsupported core baseline');
      expect(result.stderr).toContain('v0.2.0 Storage Reinstall');
      expect(result.stdout).not.toContain('App server is running');
      await expectNoListener(9947);
      expect(dataRootInventory(dataRoot)).toEqual(before);
      expect(existsSync(join(dataRoot, 'config'))).toBe(false);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses to rewrite a valid-looking v1 marker for the predecessor Core', async () => {
    const dataRoot = createDataRoot();
    try {
      ensureLayout(dataRoot);
      writeFileSync(coreDbPath(dataRoot), retainedV010CoreBytes());
      const before = dataRootInventory(dataRoot);

      await expect(
        recordDataRootDeploymentMove(dataRoot, 'dep_00000000-0000-7000-8000-000000000011')
      ).rejects.toThrow('Unsupported core baseline');
      expect(dataRootInventory(dataRoot)).toEqual(before);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'linux')(
    'refuses inspection scratch within DATA_ROOT before creating a temporary entry',
    async () => {
      const dataRoot = createDataRoot();
      try {
        const scratch = join(dataRoot, 'server', 'runtime');
        mkdirSync(scratch, { recursive: true });
        mkdirSync(join(dataRoot, 'server', 'db'), { recursive: true });
        writeFileSync(coreDbPath(dataRoot), retainedV010CoreBytes());
        const before = dataRootInventory(dataRoot);
        const originalScratch = statSync(scratch, { bigint: true });

        vi.stubEnv('TMPDIR', scratch);
        const failure = await admitDataRootForBoot(dataRoot).catch((error: unknown) => error);
        expect(dataRootInventory(dataRoot)).toEqual(before);
        const afterScratch = statSync(scratch, { bigint: true });
        expect(afterScratch.mtimeNs).toBe(originalScratch.mtimeNs);
        expect(afterScratch.ctimeNs).toBe(originalScratch.ctimeNs);
        expect(failure).toHaveProperty(
          'message',
          expect.stringContaining(
            'Core inspection requires a temporary directory outside DATA_ROOT.'
          )
        );
      } finally {
        vi.unstubAllEnvs();
        rmSync(dataRoot, { recursive: true, force: true });
      }
    }
  );

  it('boots the app on the ownership-scoped storage tree', async () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);

    try {
      applyMigrations(coreDb);
      const userId = ensureLocalUser(coreDb);
      const store = createTestStore({ dataRoot });
      await ensureUserQuickChatWorkspace({ coreDb, store, userId });

      const app = createApp({ coreDb, dataRoot, store });
      const res = await app.request('/api/app/operations/workspace.list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      expect(statSync(coreDbPath(dataRoot)).isFile()).toBe(true);
      expect(existsSync(join(dataRoot, 'core.sqlite'))).toBe(false);

      for (const path of [
        join(dataRoot, 'server', 'db'),
        join(dataRoot, 'server', 'evidence'),
        join(dataRoot, 'server', 'exports'),
        join(dataRoot, 'users', 'usr_00000000-0000-7000-8000-000000000001', 'db'),
        join(
          dataRoot,
          'workspaces',
          'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28',
          'db',
          'workspace.sqlite'
        ),
        join(
          dataRoot,
          'workspaces',
          'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28',
          'config',
          'workspace.jsonc'
        ),
        join(dataRoot, 'workspaces', 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28', 'knowledge'),
        join(dataRoot, 'workspaces', 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28', 'sources'),
        join(dataRoot, 'workspaces', 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28', 'indexes'),
      ]) {
        expect(existsSync(path)).toBe(true);
      }

      expect(
        existsSync(
          join(dataRoot, 'workspaces', 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28', 'memory')
        )
      ).toBe(false);
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
