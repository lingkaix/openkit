import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';
import { cookieHeader, postJson } from './_lib/http.js';

let harness: NanoCoreHarness | null = null;
afterEach(async () => {
  if (!harness) return;
  const current = harness;
  harness = null;
  await current.stop();
  await removeDataRoot(current.dataRoot);
});

it.each([
  'absent',
  'empty',
] as const)('refuses %s server authority before creating a replacement', async (fault) => {
  harness = await startNanoCoreHarness({ coreMode: 'server' });
  const { dataRoot } = harness;
  await harness.stop();
  const database = join(dataRoot, 'server', 'db', 'core.sqlite');
  expect((await readFile(database)).length).toBeGreaterThan(0);
  const markerPath = join(dataRoot, 'server', 'layout.json');
  const marker = await readFile(markerPath);
  if (fault === 'absent') await rm(database);
  else await writeFile(database, '');
  await expect(
    startNanoCoreHarness({ coreMode: 'server', dataRoot, seedDemoWorkspace: false })
  ).rejects.toThrow(/Core database is missing/);
  if (fault === 'absent') await expect(lstat(database)).rejects.toMatchObject({ code: 'ENOENT' });
  else expect(await readFile(database)).toEqual(Buffer.alloc(0));
  expect(await readFile(markerPath)).toEqual(marker);
});

it('quarantines a server-registered Workspace whose entire directory is absent', async () => {
  harness = await startNanoCoreHarness({ coreMode: 'server' });
  const signup = await postJson(`${harness.baseUrl}/api/auth/sign-up/email`, {
    email: 'registered-owner@example.invalid',
    name: 'Registered owner',
    password: 'password123456',
  });
  expect(signup.status).toBe(200);
  const cookie = cookieHeader(signup);
  const api = (operation: string, input: Record<string, unknown>) =>
    postJson(`${harness!.baseUrl}/api/app/operations/${operation}`, input, cookie);
  const workspaces: Array<{ id: string }> = [];
  for (const name of ['Missing registered root', 'Retained sibling']) {
    const created = await api('workspace.create', { name, requestId: randomUUID() });
    expect(created.status).toBe(201);
    workspaces.push(await created.json());
  }
  const [missing, sibling] = workspaces;
  const threadResponse = await api('thread.create', {
    workspaceId: missing!.id,
    name: 'Prior thread',
    requestId: randomUUID(),
  });
  expect(threadResponse.status).toBe(200);
  const thread = (await threadResponse.json()) as { id: string };
  const dataRoot = harness.dataRoot;
  await harness.stop();
  const missingRoot = join(dataRoot, 'workspaces', missing!.id);
  await rm(missingRoot, { recursive: true });
  harness = await startNanoCoreHarness({ coreMode: 'server', dataRoot, seedDemoWorkspace: false });
  const healthy = await api('thread.create', {
    workspaceId: sibling!.id,
    name: 'Still usable',
    requestId: randomUUID(),
  });
  expect(healthy.status).toBe(200);
  const refused = await api('thread.read', { workspaceId: missing!.id, threadId: thread.id });
  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toMatchObject({ code: 'recovery_required' });
  const core = new Database(join(dataRoot, 'server/db/core.sqlite'), { readonly: true });
  try {
    expect(
      core
        .prepare('SELECT status FROM workspace_registry WHERE workspace_id = ?')
        .pluck()
        .get(missing!.id)
    ).toBe('active');
  } finally {
    core.close();
  }
  await harness.stop();
  await expect(lstat(missingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  'corrupt',
  'missing',
] as const)('keeps local boot and a healthy sibling usable with %s Personal authority', async (fault) => {
  harness = await startNanoCoreHarness({ seedDemoWorkspace: false });
  const api = (operation: string, input: Record<string, unknown>) =>
    postJson(`${harness!.baseUrl}/api/app/operations/${operation}`, input);
  const listed = await api('workspace.list', {});
  expect(listed.status).toBe(200);
  const { items } = (await listed.json()) as {
    items: Array<{ workspace: { id: string; kind: string } }>;
  };
  expect(items).toHaveLength(1);
  expect(items[0]!.workspace.kind).toBe('personal');
  const personalId = items[0]!.workspace.id;
  const siblingResponse = await api('workspace.create', {
    name: 'Healthy local sibling',
    requestId: randomUUID(),
  });
  expect(siblingResponse.status).toBe(201);
  const sibling = (await siblingResponse.json()) as { id: string };
  const { dataRoot } = harness;
  await harness.stop();

  // Keep trusted server identity and membership intact; fault only Personal authority.
  const serverPath = join(dataRoot, 'server', 'db', 'core.sqlite');
  const before = new Database(serverPath, { readonly: true });
  const registryBefore = before
    .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
    .all();
  const membersBefore = before
    .prepare('SELECT * FROM workspace_members ORDER BY workspace_id, user_id')
    .all();
  before.close();
  const workspaceRoot = join(dataRoot, 'workspaces');
  const rootsBefore = (await readdir(workspaceRoot)).filter((entry) => entry !== '.staging').sort();
  const personalRoot = join(workspaceRoot, personalId);
  const configPath = join(personalRoot, 'config', 'workspace.jsonc');
  const configBefore = await readFile(configPath);
  const databaseDirectory = join(personalRoot, 'db');
  const databasePath = join(databaseDirectory, 'workspace.sqlite');
  expect((await readFile(databasePath)).length).toBeGreaterThan(0);
  const corruptBytes = Buffer.from('Personal authority fault: preserve these bytes.');
  if (fault === 'missing') await rm(databasePath);
  else await writeFile(databasePath, corruptBytes);

  for (let restart = 0; restart < 2; restart += 1) {
    harness = await startNanoCoreHarness({ dataRoot, seedDemoWorkspace: false });
    expect((await fetch(`${harness.baseUrl}/api/health`)).status).toBe(200);
    const healthy = await api('thread.create', {
      workspaceId: sibling.id,
      name: `Sibling remains writable after restart ${restart}`,
      requestId: randomUUID(),
    });
    expect(healthy.status).toBe(200);
    const thread = (await healthy.json()) as { id: string };
    const readBack = await api('thread.read', {
      workspaceId: sibling.id,
      threadId: thread.id,
    });
    expect(readBack.status).toBe(200);
    await expect(readBack.json()).resolves.toMatchObject({ id: thread.id });

    for (const [operation, input] of [
      ['workspace.read', { workspaceId: personalId }],
      ['thread.create', { workspaceId: personalId, name: 'Must refuse', requestId: randomUUID() }],
    ] as const) {
      const refused = await api(operation, input);
      expect(refused.status).toBe(409);
      await expect(refused.json()).resolves.toMatchObject({ code: 'recovery_required' });
    }
    const diagnostics = await api('diagnostics.app', {});
    expect(diagnostics.status).toBe(200);
    await expect(diagnostics.json()).resolves.toMatchObject({
      boot: {
        subsystems: {
          storage: {
            reasons: expect.arrayContaining([
              expect.objectContaining({
                code: 'storage.scope-quarantined',
                message: expect.stringContaining(personalId),
                blocks: [`workspace:${personalId}`],
              }),
            ]),
          },
        },
      },
    });
    await harness.stop();
    expect(await readFile(configPath)).toEqual(configBefore);
    expect((await readdir(workspaceRoot)).filter((entry) => entry !== '.staging').sort()).toEqual(
      rootsBefore
    );
    if (fault === 'missing') {
      await expect(lstat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(databaseDirectory)).toEqual([]);
    } else {
      expect(await readFile(databasePath)).toEqual(corruptBytes);
      expect(await readdir(databaseDirectory)).toEqual(['workspace.sqlite']);
    }
  }

  const after = new Database(serverPath, { readonly: true });
  try {
    expect(after.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()).toEqual(
      registryBefore
    );
    expect(
      after.prepare('SELECT * FROM workspace_members ORDER BY workspace_id, user_id').all()
    ).toEqual(membersBefore);
  } finally {
    after.close();
  }
});
