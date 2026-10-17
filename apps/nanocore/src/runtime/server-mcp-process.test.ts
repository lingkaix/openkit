// openkit-test-platform: posix
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkspaceMcpServer } from '@openkit/config-schema';
import { expect, it } from 'vitest';
import {
  composeWorkspaceMcpCatalog,
  createMcpConfig,
  loadResourceCatalog,
  updateMcpBinding,
} from '../catalog/resource-catalog.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { ensureWorkspaceLayout } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDefaultWorkerMcpGateway } from './worker-mcp-gateway.js';

it('partitions shared stdio sessions and mutable data by consuming Workspace and preserves local same-id sessions on shared cleanup', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-shared-mcp-process-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const store = new FsStore({ dataRoot });
  const consumers = [
    store.createWorkspace('Shared first'),
    store.createWorkspace('Shared second'),
    store.createWorkspace('Local collision'),
  ];
  const gateway = createDefaultWorkerMcpGateway(coreDb);
  try {
    const declaration = {
      kind: 'stdio',
      command: process.execPath,
      args: [
        fileURLToPath(new URL('../test-support/mcp-stdio-stub.mjs', import.meta.url)),
        // biome-ignore lint/suspicious/noTemplateCurlyInString: The Gateway owns this literal placeholder.
        '${PLUGIN_DATA}/calls.log',
      ],
    };
    const created = createMcpConfig({
      dataRoot,
      owner: { kind: 'server' },
      createdAt: new Date().toISOString(),
      declaration,
      displayName: 'Shared process',
      expectedRevision: 0,
      id: 'echo',
      allowedTools: ['echo'],
      selectCurrent: true,
    });
    const binding = created.catalog.mcp.bindings[0]!;
    updateMcpBinding({
      dataRoot,
      owner: { kind: 'server' },
      entryId: 'echo',
      expectedRevision: 1,
      binding: { ...binding, enabled: true, timeoutMs: 5_000 },
    });
    const local = createMcpConfig({
      dataRoot,
      owner: { kind: 'workspace', workspaceId: consumers[2]!.id },
      createdAt: new Date().toISOString(),
      declaration,
      displayName: 'Local process',
      expectedRevision: 0,
      id: 'echo',
      allowedTools: ['echo'],
      selectCurrent: true,
    });
    updateMcpBinding({
      dataRoot,
      owner: { kind: 'workspace', workspaceId: consumers[2]!.id },
      entryId: 'echo',
      expectedRevision: 1,
      binding: { ...local.catalog.mcp.bindings[0]!, enabled: true, timeoutMs: 5_000 },
    });
    expect(binding.packageDataKey).not.toBe(local.catalog.mcp.bindings[0]!.packageDataKey);
    const inputs = consumers.map((workspace) => ({
      workspaceId: workspace.id,
      server: resolveWorkspaceMcpServer({
        catalog: composeWorkspaceMcpCatalog({ dataRoot, workspaceId: workspace.id }),
        serverId: 'echo',
      }),
    }));
    const call = (index: number, message: string) =>
      gateway.callTool({ ...inputs[index]!, arguments: { message }, toolName: 'echo' });
    const first = await call(0, 'first');
    const second = await call(1, 'second');
    const localResult = await call(2, 'local');
    const pid = (value: Awaited<ReturnType<typeof call>>) =>
      (value.structuredContent as { pid: number }).pid;
    expect(new Set([pid(first), pid(second), pid(localResult)]).size).toBe(3);
    for (const [index, message] of ['first', 'second', 'local'].entries()) {
      const owner =
        index === 2
          ? { kind: 'workspace' as const, workspaceId: consumers[index]!.id }
          : { kind: 'server' as const };
      const key = loadResourceCatalog(dataRoot, owner).mcp.bindings[0]!.packageDataKey;
      const path = join(
        ensureWorkspaceLayout(dataRoot, consumers[index]!.id).catalogMcpData,
        key,
        'calls.log'
      );
      expect(readFileSync(path, 'utf8')).toBe(`${message}\n`);
    }
    expect(existsSync(join(dataRoot, 'server/catalog/mcp-data'))).toBe(false);
    await gateway.closeServerIfIdle({
      server: inputs[0]!.server,
      workspaceId: inputs[2]!.workspaceId,
    });
    expect(pid(await call(2, 'local-after-stale-shared-cleanup'))).toBe(pid(localResult));
    await gateway.closeServerScope?.();
    expect(pid(await call(2, 'local-after-shared-cleanup'))).toBe(pid(localResult));
    expect(pid(await call(0, 'fresh-shared-session'))).not.toBe(pid(first));
  } finally {
    await gateway.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
