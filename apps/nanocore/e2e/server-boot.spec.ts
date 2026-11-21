import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  completeServerBootstrap,
  findOpenPort,
  type NanoCoreHarness,
  removeDataRoot,
  startNanoCoreHarness,
} from './_lib/harness.js';
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

  it('enrolls NanoHost through the public route after a fresh server boot', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-nanohost-enrollment-'));
    const slots = join(dataRoot, 'slots');
    const slot = (name: string) => ({
      secretPath: join(slots, `${name}.token`),
      companionPath: join(slots, `${name}.env`),
    });
    const deploymentId = 'dep_0190f4c8-0000-7000-8000-000000000602';
    const identityId = 'fresh-enrollment';
    try {
      const port = await findOpenPort();
      let nanoHostPort = await findOpenPort();
      while (nanoHostPort === port) nanoHostPort = await findOpenPort();
      await mkdir(join(dataRoot, 'config'));
      await mkdir(slots, { mode: 0o700 });
      await writeFile(
        join(dataRoot, 'config', 'server.jsonc'),
        JSON.stringify({
          schemaVersion: 1,
          mode: 'server',
          nanohost: {
            bind: { host: '127.0.0.1', port: nanoHostPort },
            credentialRef: 'nanohost-transport:fresh-enrollment',
            credentialSlots: { A: slot('A'), B: slot('B') },
            deploymentId,
            identityId,
            rendezvousUrl: `http://127.0.0.1:${nanoHostPort}`,
          },
        })
      );
      harness = await startNanoCoreHarness({
        coreMode: 'server',
        dataRoot,
        port,
        useSimulator: false,
      });
      const token = await completeServerBootstrap(harness);
      const url = `${harness.baseUrl}/api/app/operations/nanohost.enroll`;
      const request = {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          targetSlot: 'A',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      };
      const enrollment = await fetch(url, request);
      const body = (await enrollment.json()) as { code?: string };
      expect(enrollment.status, body.code).toBe(201);
      expect(body).toMatchObject({ deploymentId, identityId, targetSlot: 'A' });
      expect(await lstat(slot('A').secretPath)).toMatchObject({ mode: 0o100600 });
      const companion = await readFile(slot('A').companionPath, 'utf8');
      expect(companion).toContain(`=${deploymentId}\n`);
      expect(companion).toContain(`=${identityId}\n`);
      const duplicate = await fetch(url, request);
      expect(duplicate.status).toBe(409);
      await expect(duplicate.json()).resolves.toMatchObject({ code: 'nanohost_already_enrolled' });
      expect(await readFile(slot('A').companionPath, 'utf8')).toBe(companion);
    } finally {
      if (!harness) await removeDataRoot(dataRoot);
    }
  });

  it.each(['corrupt', 'missing'] as const)(
    'serves a healthy sibling after restart with a %s Workspace database, without replacing authority',
    async (fault) => {
      harness = await startNanoCoreHarness({ coreMode: 'server' });
      await completeServerBootstrap(harness);
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
        const threadId = ((await thread.json()) as { id: string }).id;
        const retained = await api('thread.read', { workspaceId: workspace.id, threadId });
        expect(retained.status).toBe(200);
        await expect(retained.json()).resolves.toMatchObject({ id: threadId });
        workspaces.push({ ...workspace, threadId });
      }
      const [damaged, sibling] = workspaces;
      const { dataRoot } = harness;
      await harness.stop();
      const workspaceRoot = join(dataRoot, 'workspaces', damaged.id);
      const databasePath = join(workspaceRoot, 'db', 'workspace.sqlite');
      expect((await readFile(databasePath)).length).toBeGreaterThan(0);
      const corruptBytes = Buffer.from('Damaged Workspace authority: do not replace or repair.');
      if (fault === 'missing') await rm(databasePath);
      else await writeFile(databasePath, corruptBytes);

      // Quarantine must preserve the native fault and all remaining bytes in this scope.
      const retainedPaths = (await readdir(workspaceRoot, { recursive: true })).sort();
      const retainedBytes = new Map<string, Buffer>();
      for (const relativePath of retainedPaths) {
        const path = join(workspaceRoot, relativePath);
        const entry = await lstat(path);
        if (entry.isDirectory()) continue;
        expect(entry.isFile()).toBe(true);
        retainedBytes.set(relativePath, await readFile(path));
      }
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
      expect((await readdir(workspaceRoot, { recursive: true })).sort()).toEqual(retainedPaths);
      for (const [relativePath, bytes] of retainedBytes) {
        expect(await readFile(join(workspaceRoot, relativePath))).toEqual(bytes);
      }
      if (fault === 'missing') {
        await expect(readFile(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(dirname(databasePath))).toEqual([]);
      } else {
        expect(await readFile(databasePath)).toEqual(corruptBytes);
        expect(await readdir(dirname(databasePath))).toEqual([basename(databasePath)]);
      }
    }
  );

  it('refuses boot for corrupt server authority and preserves the original database', async () => {
    harness = await startNanoCoreHarness({ coreMode: 'server' });
    const { dataRoot, baseUrl } = harness;
    await harness.stop();
    const databasePath = join(dataRoot, 'server', 'db', 'core.sqlite');
    expect(await readdir(dirname(databasePath))).toEqual([basename(databasePath)]);
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
      /NanoCore exited before health check passed: [1-9][\s\S]*NanoCore boot failed during critical phase "data-root-admission": [^\n]*Follow the v0\.2\.0 Storage Reinstall procedure in docs\/cookbooks\/persistent-live-acceptance\.md#v020-storage-reinstall\./
    );
    await expect(fetch(`${baseUrl}/api/health`)).rejects.toThrow();
    expect(await readFile(databasePath)).toEqual(corruptBytes);
    expect(await readdir(dirname(databasePath))).toEqual([basename(databasePath)]);
  });
});
