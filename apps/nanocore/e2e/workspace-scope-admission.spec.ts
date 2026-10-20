import { randomUUID } from 'node:crypto';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
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
