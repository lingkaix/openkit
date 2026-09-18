import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { listAppliedNativeMigrationIds } from '../src/storage/migrate.js';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';

let harness: NanoCoreHarness | null = null;
let dataRootToRemove: string | null = null;

afterEach(async () => {
  const current = harness;
  harness = null;

  if (current) {
    await current.stop();
  }

  if (dataRootToRemove) {
    await removeDataRoot(dataRootToRemove);
    dataRootToRemove = null;
  }
});

describe('nanocore e2e migration idempotency', () => {
  it('boots twice without duplicate migrations or local users', async () => {
    harness = await startNanoCoreHarness();
    dataRootToRemove = harness.dataRoot;

    const dataRoot = harness.dataRoot;
    await harness.stop();
    harness = await startNanoCoreHarness({ dataRoot });
    await harness.stop();
    harness = null;

    const sqlite = new Database(join(dataRoot, 'server', 'db', 'core.sqlite'), { readonly: true });
    const ledgerRows = sqlite
      .prepare(
        'select created_at as createdAt, count(*) as count from __drizzle_migrations group by created_at'
      )
      .all() as Array<{ count: number; createdAt: number }>;
    const applied = listAppliedNativeMigrationIds(sqlite, 'core');
    const localUsers = sqlite
      .prepare("select count(*) as count from users where id = 'user_local'")
      .get() as { count: number };
    sqlite.close();

    expect(applied).toEqual(['core_0000_setup']);
    expect(ledgerRows).toEqual([expect.objectContaining({ count: 1 })]);
    expect(localUsers.count).toBe(1);
  });
});
