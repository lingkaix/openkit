import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { ensureServerBootstrapTokenForStartup } from '../auth/bootstrap-ensure.js';
import { FsStore } from '../lib/store.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

const roots: string[] = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Use production App composition and raw schema setup: no test owner may mask its admission.
it.each(['default', 'disk-reserve', 'supplied-refusal'] as const)(
  'binds an inferred App root before its first Core mutation with %s policy',
  async (policy) => {
    const root = mkdtempSync(join(tmpdir(), 'inferred-app-admission-'));
    roots.push(root);
    if (policy === 'disk-reserve') {
      mkdirSync(join(root, 'config'), { recursive: true });
      writeFileSync(
        join(root, 'config', 'server.jsonc'),
        JSON.stringify({ schemaVersion: 1, server: { fileReserveBytes: Number.MAX_SAFE_INTEGER } })
      );
    }
    const coreDb = openCoreDb(root);
    applyMigrations(coreDb);
    try {
      createApp({
        mode: 'server',
        coreDb,
        store: new FsStore({ dataRoot: root }),
        ...(policy === 'supplied-refusal'
          ? {
              fileAdmission: new FileStorageAdmission(
                root,
                () => 0n,
                () => 0n
              ),
            }
          : {}),
      });
      const admitted = await ensureServerBootstrapTokenForStartup(coreDb).then(
        (issue) => {
          expect(issue !== null).toBe(true);
          return true;
        },
        (error: unknown) => {
          expect(error).toMatchObject({ code: 'no-space', commit: 'not-committed' });
          return false;
        }
      );
      expect(admitted).toBe(policy === 'default');
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  }
);
