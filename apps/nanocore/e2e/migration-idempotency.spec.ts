import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
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
    const migrations = sqlite
      .prepare('select id, count(*) as count from schema_migrations group by id')
      .all() as Array<{ id: string; count: number }>;
    const localUsers = sqlite
      .prepare("select count(*) as count from users where id = 'user_local'")
      .get() as { count: number };
    sqlite.close();

    expect(migrations).toEqual([{ id: 'core_0000_setup', count: 1 }]);
    expect(localUsers.count).toBe(1);
  });
});
