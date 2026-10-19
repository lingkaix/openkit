import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';
import { cookieHeader, postJson } from './_lib/http.js';

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
    const protectedResponse = await fetch(`${harness.baseUrl}/api/app/operations/workspace.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
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

  it.each([
    'corrupt',
    'missing',
  ] as const)('serves a healthy sibling after restart with a %s Workspace database, without replacing authority', async (fault) => {
    harness = await startNanoCoreHarness({ coreMode: 'server' });
    const signup = await postJson(`${harness.baseUrl}/api/auth/sign-up/email`, {
      email: 'workspace-owner@example.com',
      name: 'Workspace Owner',
      password: 'password123456',
    });
    expect(signup.status).toBe(200);
    const cookie = cookieHeader(signup);
    const api = (operation: string, input: Record<string, unknown>) =>
      postJson(`${harness!.baseUrl}/api/app/operations/${operation}`, input, cookie);
    const workspaces: Array<{ id: string; threadId: string }> = [];
    for (const name of ['Damaged authority', 'Healthy sibling']) {
      const created = await api('workspace.create', { name, requestId: randomUUID() });
      expect(created.status).toBe(201);
      const workspace = (await created.json()) as { id: string };
      const thread = await api('thread.create', {
        workspaceId: workspace.id,
        name: 'Retained Thread',
        requestId: randomUUID(),
      });
      expect(thread.status).toBe(200);
      workspaces.push({ ...workspace, threadId: ((await thread.json()) as { id: string }).id });
    }
    const [damaged, sibling] = workspaces;
    const { dataRoot } = harness;
    await harness.stop();
    const databasePath = join(dataRoot, 'workspaces', damaged.id, 'db', 'workspace.sqlite');
    const recordPath = join(dataRoot, 'workspaces', damaged.id, 'workspace-record.json');
    const retainedRecord = await readFile(recordPath);
    const corruptBytes = Buffer.from('Damaged Workspace authority: do not replace or repair.');
    if (fault === 'missing') await rm(databasePath);
    else await writeFile(databasePath, corruptBytes);

    // The first start and real writes above establish that the injected fault, not setup, caused RED.
    harness = await startNanoCoreHarness({
      coreMode: 'server',
      dataRoot,
      seedDemoWorkspace: false,
    });
    const healthyRead = await api('thread.dashboard', {
      workspaceId: sibling.id,
      threadId: sibling.threadId,
    });
    expect(healthyRead.status).toBe(200);
    await expect(healthyRead.json()).resolves.toMatchObject({ thread: { id: sibling.threadId } });
    const healthyWrite = await api('thread.create', {
      workspaceId: sibling.id,
      name: 'Admitted after quarantine',
      requestId: randomUUID(),
    });
    expect(healthyWrite.status).toBe(200);
    const written = (await healthyWrite.json()) as { id: string };
    const readBack = await api('thread.dashboard', {
      workspaceId: sibling.id,
      threadId: written.id,
    });
    expect(readBack.status).toBe(200);
    await expect(readBack.json()).resolves.toMatchObject({ thread: { id: written.id } });

    for (const [operation, input] of [
      ['thread.dashboard', { workspaceId: damaged.id, threadId: damaged.threadId }],
      [
        'thread.create',
        { workspaceId: damaged.id, name: 'Must not exist', requestId: randomUUID() },
      ],
      [
        'turn.start',
        {
          workspaceId: damaged.id,
          threadId: damaged.threadId,
          input: 'Must not dispatch',
          requestId: randomUUID(),
        },
      ],
    ] as const) {
      const refused = await api(operation, input);
      expect(refused.ok, `${operation} must refuse quarantined authority`).toBe(false);
      // Match the recovery category, not an implementation-chosen status or spelling.
      const diagnosis = (await refused.json()) as { code: string };
      expect(diagnosis.code).toMatch(/recovery|quarantin/);
    }
    await harness.stop();
    expect(await readFile(recordPath)).toEqual(retainedRecord);
    if (fault === 'missing') {
      await expect(readFile(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(dirname(databasePath))).toEqual([]);
    } else {
      expect(await readFile(databasePath)).toEqual(corruptBytes);
      expect(await readdir(dirname(databasePath))).toEqual([basename(databasePath)]);
    }
  });

  it('refuses boot for corrupt server authority and preserves the original database', async () => {
    harness = await startNanoCoreHarness({ coreMode: 'server' });
    const { dataRoot, baseUrl } = harness;
    await harness.stop();
    const databasePath = join(dataRoot, 'server', 'db', 'core.sqlite');
    const corruptBytes = Buffer.from(
      'Damaged server authority: do not create a fresh identity store.'
    );
    await writeFile(databasePath, corruptBytes);

    await expect(
      startNanoCoreHarness({
        coreMode: 'server',
        dataRoot,
        port: Number(new URL(baseUrl).port),
        seedDemoWorkspace: false,
      }).then((unexpectedlyStarted) => {
        // A broken refusal must still leave the unexpected child owned by afterEach.
        harness = unexpectedlyStarted;
        return unexpectedlyStarted;
      })
    ).rejects.toThrow(
      /NanoCore exited before health check passed: [1-9][\s\S]*SQLite integrity check failed/
    );
    await expect(fetch(`${baseUrl}/api/health`)).rejects.toThrow();
    expect(await readFile(databasePath)).toEqual(corruptBytes);
    expect(await readdir(dirname(databasePath))).toEqual([basename(databasePath)]);
  });
});
