import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';

/**
 * Creates a temporary NanoCore data root for config file API tests.
 *
 * @returns Temporary data root path.
 */
function createDataRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-config-files-'));
}

/**
 * Writes a minimal valid server config to one data root.
 *
 * @param dataRoot Data root to prepare.
 */
function writeServerConfig(dataRoot: string): void {
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'config', 'server.jsonc'),
    `{
      // comments must survive editor round-trips
      "schemaVersion": 1,
      "providers": [
        {
          "id": "agent-openrouter",
          "vendor": "openrouter",
          "displayName": "Agent OpenRouter",
          "kind": "custom",
          "baseUrl": "https://openrouter.ai/api/v1",
          "models": ["openai/gpt-5.1"],
          "secretRef": "vault://provider_agent_openrouter"
        }
      ],
      "defaults": {
        "coreProviderId": "agent-openrouter",
        "gatewayProviderId": "agent-openrouter"
      }
    }\n`
  );
}

describe('runtime config file API', () => {
  it('lists and reads allowed runtime config files with stable revisions', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const app = createApp({ dataRoot, store: createDemoStore({ dataRoot }) });

    const listRes = await app.request('/api/admin/config/files');
    const list = (await listRes.json()) as {
      files: Array<{ id: string; kind: string; revision: string | null }>;
    };

    expect(listRes.status).toBe(200);
    expect(list.files).toContainEqual(
      expect.objectContaining({
        id: 'server.jsonc',
        kind: 'server',
        revision: expect.stringMatching(/^sha256:/),
      })
    );

    const readRes = await app.request('/api/admin/config/file?id=server.jsonc');
    const read = (await readRes.json()) as { content: string; file: { id: string } };

    expect(read.file.id).toBe('server.jsonc');
    expect(read.content).toContain('comments must survive');
  });

  it('lists, reads, and updates workspace config files under the current user workspace', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const store = createDemoStore({ dataRoot });
    mkdirSync(join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo', 'config'), {
      recursive: true,
    });
    writeFileSync(
      join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo', 'config', 'workspace.jsonc'),
      `{
        "schemaVersion": 1,
        "workspace": {
          "roots": []
        }
      }\n`
    );
    const app = createApp({ dataRoot, store });

    const listRes = await app.request('/api/admin/config/files');
    const list = (await listRes.json()) as {
      files: Array<{ id: string; kind: string; revision: string | null }>;
    };
    const fileId = 'workspaces/ws_demo/workspace.jsonc';
    const readRes = await app.request(`/api/admin/config/file?id=${encodeURIComponent(fileId)}`);
    const read = (await readRes.json()) as { file: { revision: string }; content: string };
    const updateRes = await app.request('/api/admin/config/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: fileId,
        kind: 'workspace',
        content: read.content.replace('"roots": []', '"roots": [] // saved'),
        expectedRevision: read.file.revision,
      }),
    });

    expect(list.files).toContainEqual(expect.objectContaining({ id: fileId, kind: 'workspace' }));
    expect(readRes.status).toBe(200);
    expect(updateRes.status).toBe(200);
  });

  it('lists, reads, validates, and updates workspace data source catalog files', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const store = createDemoStore({ dataRoot });
    const configRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo', 'config');
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(
      join(configRoot, 'data-sources.jsonc'),
      `{
        "schemaVersion": 1,
        "sources": []
      }\n`
    );
    const app = createApp({ dataRoot, store });

    const fileId = 'workspaces/ws_demo/data-sources.jsonc';
    const listRes = await app.request('/api/admin/config/files');
    const list = (await listRes.json()) as { files: Array<{ id: string; kind: string }> };
    const readRes = await app.request(`/api/admin/config/file?id=${encodeURIComponent(fileId)}`);
    expect(readRes.status).toBe(200);
    const read = (await readRes.json()) as { file: { revision: string }; content: string };
    const validateRes = await app.request('/api/admin/config/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: [{ id: fileId, content: read.content }],
      }),
    });
    const updateRes = await app.request('/api/admin/config/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: fileId,
        kind: 'data-source',
        content: read.content.replace('"sources": []', '"sources": [] // saved'),
        expectedRevision: read.file.revision,
      }),
    });
    const schemasRes = await app.request('/api/admin/config/schemas');
    const schemas = (await schemasRes.json()) as { schemas: Array<{ kind: string }> };

    expect(list.files).toContainEqual(expect.objectContaining({ id: fileId, kind: 'data-source' }));
    expect(readRes.status).toBe(200);
    expect(validateRes.status).toBe(200);
    await expect(validateRes.json()).resolves.toMatchObject({ valid: true });
    expect(updateRes.status).toBe(200);
    expect(schemas.schemas).toContainEqual(expect.objectContaining({ kind: 'data-source' }));
  });

  it('audits authority-bearing workspace data source catalog edits', async () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    writeServerConfig(dataRoot);
    const store = createDemoStore({ dataRoot });
    const configRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo', 'config');
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(
      join(configRoot, 'data-sources.jsonc'),
      `{
        "schemaVersion": 1,
        "sources": [
          {
            "id": "repo_default",
            "kind": "git",
            "displayName": "Default repository",
            "locator": { "repositoryResourceId": "repo_default" },
            "access": "read-only",
            "sensitivity": "internal",
            "allowedSlotKinds": ["worktree"],
            "status": "active"
          }
        ]
      }\n`
    );

    try {
      const app = createApp({ coreDb, dataRoot, store });
      const fileId = 'workspaces/ws_demo/data-sources.jsonc';
      const readRes = await app.request(`/api/admin/config/file?id=${encodeURIComponent(fileId)}`);
      const read = (await readRes.json()) as { file: { revision: string }; content: string };
      const updateRes = await app.request('/api/admin/config/file', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: fileId,
          kind: 'data-source',
          content: read.content.replace('"access": "read-only"', '"access": "read-write"'),
          expectedRevision: read.file.revision,
        }),
      });
      const workspaceDb = openWorkspaceDb(dataRoot, 'user_local', 'ws_demo');
      applyScopedMigrations(workspaceDb);

      try {
        const row = workspaceDb.sqlite
          .prepare(
            "SELECT * FROM audit_events WHERE action = 'data_source_catalog.authority.update'"
          )
          .get() as Record<string, unknown> | undefined;

        expect(updateRes.status).toBe(200);
        expect(row).toMatchObject({
          workspace_id: 'ws_demo',
          category: 'system',
          resource: 'data-source-catalog:repo_default',
          outcome: 'succeeded',
          severity: 'info',
          summary: 'Workspace data source catalog authority changed for repo_default: access.',
        });
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('creates provider and agent config files from server templates', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const app = createApp({ dataRoot });

    const providerRes = await app.request('/api/admin/config/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'providers/new-openrouter.provider.jsonc',
        kind: 'provider',
      }),
    });
    const agentRes = await app.request('/api/admin/config/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'agents/new-agent.agent.jsonc',
        kind: 'agent',
      }),
    });

    expect(providerRes.status).toBe(200);
    expect(agentRes.status).toBe(200);
    expect(
      readFileSync(join(dataRoot, 'config', 'providers', 'new-openrouter.provider.jsonc'), 'utf8')
    ).toContain('"secretRef": "vault://provider_new-openrouter"');
    expect(
      readFileSync(join(dataRoot, 'config', 'agents', 'new-agent.agent.jsonc'), 'utf8')
    ).toContain('"id": "new-agent"');
  });

  it('updates config files with revision guards and rejects stale writes', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const app = createApp({ dataRoot });
    const readRes = await app.request('/api/admin/config/file?id=server.jsonc');
    const read = (await readRes.json()) as { file: { revision: string }; content: string };

    const okRes = await app.request('/api/admin/config/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'server.jsonc',
        kind: 'server',
        content: read.content.replace('openai/gpt-5.1', 'openai/gpt-5.2'),
        expectedRevision: read.file.revision,
      }),
    });
    const staleRes = await app.request('/api/admin/config/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'server.jsonc',
        kind: 'server',
        content: read.content,
        expectedRevision: read.file.revision,
      }),
    });

    expect(okRes.status).toBe(200);
    expect(staleRes.status).toBe(409);
  });

  it('rejects path traversal and invalid config writes', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const app = createApp({ dataRoot });

    const traversalRes = await app.request('/api/admin/config/file?id=../server.jsonc');
    const invalidRes = await app.request('/api/admin/config/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'server.jsonc',
        kind: 'server',
        content: '{',
        expectedRevision: 'sha256:not-current',
      }),
    });

    expect(traversalRes.status).toBe(400);
    expect(invalidRes.status).toBe(400);
  });

  it('validates draft overlays without mutating disk and returns reload plans', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const app = createApp({ dataRoot });
    const original = readFileSync(join(dataRoot, 'config', 'server.jsonc'), 'utf8');

    const invalidRes = await app.request('/api/admin/config/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: [{ id: 'server.jsonc', content: '{' }],
        mode: 'safe',
      }),
    });
    const changedRes = await app.request('/api/admin/config/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: [
          {
            id: 'server.jsonc',
            content: original.replace('openai/gpt-5.1', 'openai/gpt-5.3'),
          },
        ],
        mode: 'safe',
      }),
    });
    const invalid = (await invalidRes.json()) as {
      valid: boolean;
      diagnostics: Array<{ range: { startLine: number } | null }>;
    };
    const changed = (await changedRes.json()) as {
      valid: boolean;
      plan: { applied: unknown[]; requiresRestart: Array<{ path: string }> };
    };

    expect(invalid.valid).toBe(false);
    expect(invalid.diagnostics[0]?.range?.startLine).toBe(1);
    expect(changed.valid).toBe(true);
    expect(changed.plan.applied).toEqual([]);
    expect(changed.plan.requiresRestart).toEqual([expect.objectContaining({ path: 'providers' })]);
    expect(readFileSync(join(dataRoot, 'config', 'server.jsonc'), 'utf8')).toBe(original);
  });

  it('keeps admin config routes protected in server mode', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const app = createApp({
      auth: {
        api: { getSession: async () => null },
        handler: async () => Response.json({ status: 'auth-ok' }),
      },
      dataRoot,
      mode: 'server',
    });
    const listRes = await app.request('/api/admin/config/files');

    expect(listRes.status).toBe(401);
  });

  it('does not reload unsaved validation overlays', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const app = createApp({ dataRoot });
    const original = readFileSync(join(dataRoot, 'config', 'server.jsonc'), 'utf8');

    await app.request('/api/admin/config/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: [
          {
            id: 'server.jsonc',
            content: original.replace('openai/gpt-5.1', 'openai/gpt-5.4'),
          },
        ],
      }),
    });
    const reloadRes = await app.request('/api/admin/config/reload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true, mode: 'safe' }),
    });
    const reload = (await reloadRes.json()) as { plan: { applied: unknown[] } };

    expect(existsSync(join(dataRoot, 'config', 'server.jsonc'))).toBe(true);
    expect(reload.plan.applied).toEqual([]);
  });
});
