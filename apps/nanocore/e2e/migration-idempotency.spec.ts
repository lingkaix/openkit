import { readFileSync } from 'node:fs';
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
    const ledgerRows = sqlite
      .prepare(
        'select created_at as createdAt, count(*) as count from __drizzle_migrations group by created_at'
      )
      .all() as Array<{ count: number; createdAt: number }>;
    // Compare persisted boot effects with the released journal without invoking the migrator under test.
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/core/meta/_journal.json', import.meta.url), 'utf8')
    ) as { entries: Array<{ tag: string; when: number }> };
    const localUsers = sqlite
      .prepare(
        "select count(*) as count from users where id = 'usr_00000000-0000-7000-8000-000000000001'"
      )
      .get() as { count: number };
    sqlite.close();

    expect(journal.entries.map((entry) => `core_${entry.tag}`)).toEqual([
      'core_0000_setup',
      'core_0001_concurrent_turn_capacity',
      'core_0002_durable_recurring_schedules',
      'core_0003_notebook_admission',
      'core_0004_equal_workspace_members',

      'core_0005_channel_notifications',
      'core_0006_external_trigger_admissions',
      'core_0007_discord_capture_origin',
      'core_0008_server_capability_usage',
      'core_0009_retained_record_formats',
    ]);
    expect(ledgerRows).toEqual(
      journal.entries.map((entry) => ({ createdAt: entry.when, count: 1 }))
    );
    expect(localUsers.count).toBe(1);
  });
});
