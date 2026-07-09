import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';

let harness: NanoCoreHarness | null = null;

afterEach(async () => {
  const current = harness;
  harness = null;

  if (current) {
    await current.stop();
    await removeDataRoot(current.dataRoot);
  }
});

describe('nanocore e2e server boot', () => {
  it('boots server mode from an empty data root with auth tables and protected routes', async () => {
    harness = await startNanoCoreHarness({ coreMode: 'server' });

    const healthResponse = await fetch(`${harness.baseUrl}/api/health`);
    const protectedResponse = await fetch(`${harness.baseUrl}/api/workspaces`);
    const protectedBody = (await protectedResponse.json()) as Record<string, unknown>;
    const sqlite = new Database(join(harness.dataRoot, 'server', 'db', 'core.sqlite'), {
      readonly: true,
    });
    const tables = sqlite
      .prepare("select name from sqlite_master where type = 'table'")
      .all() as Array<{ name: string }>;
    sqlite.close();

    expect(healthResponse.status).toBe(200);
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(['users', 'session', 'account', 'verification'])
    );
    expect(protectedResponse.status).toBe(401);
    expect(protectedBody).toMatchObject({ code: 'core.auth.unauthenticated' });
  });
});
