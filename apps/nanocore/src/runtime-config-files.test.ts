import { createHash } from 'node:crypto';
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import {
  RuntimeConfigFileService,
  readRuntimeConfigPolicySource,
} from './config/runtime-config-files.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp as createTestApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { disposeTestStore, initializeTestCore } from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/**
 * Creates a temporary NanoCore data root for config file API tests.
 *
 * @returns Temporary data root path.
 */
function createDataRoot(): string {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-files-'));
  initializeTestCore(dataRoot);
  return dataRoot;
}

/** Creates a simulated app whose runtime config owner reads the real test data root. */
function createApp(options: Parameters<typeof createTestApp>[0]): ReturnType<typeof createTestApp> {
  const dataRoot = options.dataRoot;
  if (!dataRoot) {
    throw new Error('Runtime config file tests require a data root.');
  }
  return createTestApp({
    ...options,
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
  });
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
      "defaults": {
        "defaultAgentId": "agent_codex"
      }
    }\n`
  );
  mkdirSync(join(dataRoot, 'config', 'providers'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'config', 'providers', 'agent-openrouter.provider.jsonc'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'agent-openrouter',
        vendor: 'openrouter',
        displayName: 'Agent OpenRouter',
        kind: 'custom',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: ['openai/gpt-5.1'],
        secretRef: 'vault://vault_00000000-0000-794f-be5b-43dd897fef0c',
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(dataRoot, 'config', 'gateway.jsonc'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'openai/gpt-5.2',
        logicalModels: [
          {
            id: 'openai/gpt-5.2',
            displayName: 'OpenAI GPT-5.2',
            contextManagement: [{ type: 'compaction', compactThreshold: 200_000 }],
            routes: [
              {
                id: 'primary',
                providerProfileId: 'agent-openrouter',
                providerModel: 'openai/gpt-5.1',
              },
            ],
          },
        ],
        requiredFeatures: [],
      },
      null,
      2
    )}\n`
  );
}

describe('runtime config file API', () => {
  it('refuses Policy edits through the generic config endpoint before file replacement', async () => {
    const dataRoot = createDataRoot();
    try {
      writeServerConfig(dataRoot);
      const store = await createDemoStore({ dataRoot });
      const app = createApp({ dataRoot, store });
      const before = readFileSync(join(dataRoot, 'config/server.jsonc'), 'utf8');
      const readResponse = await app.request(
        ...operationRequest('runtime.file-read', { id: 'server.jsonc' })
      );
      expect(readResponse.status).toBe(200);
      const read = (await readResponse.json()) as { file: { revision: string } };
      const response = await app.request(
        ...operationRequest(
          'runtime.file-update',
          {},
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: 'server.jsonc',
              kind: 'server',
              expectedRevision: read.file.revision,
              content: JSON.stringify({
                schemaVersion: 1,
                policy: { mediation: { schemaVersion: 1, statements: [] } },
              }),
            }),
          }
        )
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'policy_write_required' });
      expect(readFileSync(join(dataRoot, 'config/server.jsonc'), 'utf8')).toBe(before);
    } finally {
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('lists and reads allowed runtime config files with stable revisions', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const app = createApp({ dataRoot, store: await createDemoStore({ dataRoot }) });

    const listRes = await app.request(...operationRequest('runtime.file-list', {}));
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

    const readRes = await app.request(
      ...operationRequest('runtime.file-read', { id: 'server.jsonc' })
    );
    const read = (await readRes.json()) as { content: string; file: { id: string } };

    expect(read.file.id).toBe('server.jsonc');
    expect(read.content).toContain('comments must survive');
  });

  it('lists, reads, and updates workspace config files under the current user workspace', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const store = await createDemoStore({ dataRoot });
    mkdirSync(join(dataRoot, 'workspaces', 'ws_00000000-0000-7000-8000-000000000001', 'config'), {
      recursive: true,
    });
    writeFileSync(
      join(
        dataRoot,
        'workspaces',
        'ws_00000000-0000-7000-8000-000000000001',
        'config',
        'workspace.jsonc'
      ),
      `{
        "schemaVersion": 1,
        "workspace": {
          "name": "Demo Workspace",
          "roots": []
        }
      }\n`
    );
    const app = createApp({ dataRoot, store });

    const listRes = await app.request(...operationRequest('runtime.file-list', {}));
    const list = (await listRes.json()) as {
      files: Array<{ id: string; kind: string; revision: string | null }>;
    };
    const fileId = 'workspaces/ws_00000000-0000-7000-8000-000000000001/workspace.jsonc';
    const readRes = await app.request(...operationRequest('runtime.file-read', { id: fileId }));
    const read = (await readRes.json()) as { file: { revision: string }; content: string };
    const updateRes = await app.request(
      ...operationRequest(
        'runtime.file-update',
        {},
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: fileId,
            kind: 'workspace',
            content: read.content.replace('"roots": []', '"roots": [] // saved'),
            expectedRevision: read.file.revision,
          }),
        }
      )
    );

    expect(list.files).toContainEqual(expect.objectContaining({ id: fileId, kind: 'workspace' }));
    expect(readRes.status).toBe(200);
    expect(updateRes.status).toBe(200);
  });

  it('lists, reads, validates, and updates workspace data source catalog files', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const store = await createDemoStore({ dataRoot });
    const configRoot = join(
      dataRoot,
      'workspaces',
      'ws_00000000-0000-7000-8000-000000000001',
      'config'
    );
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(
      join(configRoot, 'data-sources.jsonc'),
      `{
        "schemaVersion": 1,
        "sources": []
      }\n`
    );
    const app = createApp({ dataRoot, store });

    const fileId = 'workspaces/ws_00000000-0000-7000-8000-000000000001/data-sources.jsonc';
    const listRes = await app.request(...operationRequest('runtime.file-list', {}));
    const list = (await listRes.json()) as { files: Array<{ id: string; kind: string }> };
    const readRes = await app.request(...operationRequest('runtime.file-read', { id: fileId }));
    expect(readRes.status).toBe(200);
    const read = (await readRes.json()) as { file: { revision: string }; content: string };
    const validateRes = await app.request(
      ...operationRequest(
        'runtime.validate',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            files: [{ id: fileId, content: read.content }],
          }),
        }
      )
    );
    const updateRes = await app.request(
      ...operationRequest(
        'runtime.file-update',
        {},
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: fileId,
            kind: 'data-source',
            content: read.content.replace('"sources": []', '"sources": [] // saved'),
            expectedRevision: read.file.revision,
          }),
        }
      )
    );
    const schemasRes = await app.request(...operationRequest('runtime.schemas', {}));
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
    const localUserId = ensureLocalUser(coreDb);
    writeServerConfig(dataRoot);
    const store = await createDemoStore({ dataRoot });
    const configRoot = join(
      dataRoot,
      'workspaces',
      'ws_00000000-0000-7000-8000-000000000001',
      'config'
    );
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
      const fileId = 'workspaces/ws_00000000-0000-7000-8000-000000000001/data-sources.jsonc';
      const readRes = await app.request(...operationRequest('runtime.file-read', { id: fileId }));
      const read = (await readRes.json()) as { file: { revision: string }; content: string };
      const updateRes = await app.request(
        ...operationRequest(
          'runtime.file-update',
          {},
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: fileId,
              kind: 'data-source',
              content: read.content.replace('"access": "read-only"', '"access": "read-write"'),
              expectedRevision: read.file.revision,
            }),
          }
        )
      );
      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');

      try {
        const row = workspaceDb.sqlite
          .prepare(
            "SELECT * FROM audit_events WHERE action = 'data_source_catalog.authority.update'"
          )
          .get() as Record<string, unknown> | undefined;

        expect(updateRes.status).toBe(200);
        expect(row).toMatchObject({
          workspace_id: 'ws_00000000-0000-7000-8000-000000000001',
          category: 'system',
          actor_json: JSON.stringify({
            kind: 'user',
            id: localUserId,
          }),
          authentication_json: JSON.stringify({ credentialKind: 'local', credentialId: null }),
          request_id: null,
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

  it('creates Workspace MCP configurations through the catalog App API instead of runtime config files', async () => {
    const dataRoot = createDataRoot();
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    writeServerConfig(dataRoot);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });

    try {
      const app = createApp({ coreDb, dataRoot, store });
      const created = await app.request(
        ...operationRequest(
          'catalog.mcp-create',
          {},
          {
            method: 'POST',
            headers: {
              ...{ 'content-type': 'application/json' },
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              ...{
                allowedTools: ['echo'],
                declaration: { args: [], command: 'node', kind: 'stdio' },
                displayName: 'Echo',
                expectedRevision: 0,
                id: 'echo',
                requestId: '00000000-0000-4000-8000-000000000101',
              },
            }),
          }
        )
      );
      const listed = await app.request(
        ...operationRequest(
          'catalog.mcp-list',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' }),
          }
        )
      );
      const files = await app.request(...operationRequest('runtime.file-list', {}));
      const fileList = (await files.json()) as { files: Array<{ id: string; kind: string }> };

      expect(created.status).toBe(201);
      expect(listed.status).toBe(200);
      expect((await listed.json()) as { items: Array<{ id: string }> }).toMatchObject({
        items: [expect.objectContaining({ id: 'echo', enabled: false })],
      });
      expect(fileList.files.some((file) => file.id.includes('mcp-servers.jsonc'))).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('creates provider and agent config files from server templates', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const app = createApp({ dataRoot });

    const providerRes = await app.request(
      ...operationRequest(
        'runtime.file-create',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: 'providers/new-openrouter.provider.jsonc',
            kind: 'provider',
          }),
        }
      )
    );
    const agentRes = await app.request(
      ...operationRequest(
        'runtime.file-create',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: 'agents/new-agent.agent.jsonc',
            kind: 'agent',
          }),
        }
      )
    );

    expect(providerRes.status).toBe(200);
    expect(agentRes.status).toBe(200);
    const providerTemplate = JSON.parse(
      readFileSync(join(dataRoot, 'config', 'providers', 'new-openrouter.provider.jsonc'), 'utf8')
    );
    expect(providerTemplate.secretRef).toMatch(
      /^vault:\/\/vault_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    const agentTemplate = readFileSync(
      join(dataRoot, 'config', 'agents', 'new-agent.agent.jsonc'),
      'utf8'
    );
    expect(agentTemplate).toContain('"id": "new-agent"');
    expect(JSON.parse(agentTemplate).models).toEqual({
      preferredLogicalModelId: 'smart',
      allowedLogicalModelIds: 'all',
    });
    expect(agentTemplate).toContain('"kind": "reference"');
    expect(JSON.parse(agentTemplate).runtime).toMatchObject({
      adapter: 'codex',
      version: '0.166.0',
      image: { kind: 'reference', ref: 'openkit/worker-runtimes:dev' },
    });
    expect(agentTemplate).toContain('"path": "/opt/openkit/venv/bin/python"');
    expect(agentTemplate).toContain('"path": "/opt/openkit/venv/bin/pip"');
    expect(agentTemplate).not.toContain('/sandbox/.venv');
  });

  it('updates config files with revision guards and rejects stale writes', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const serverPath = join(dataRoot, 'config', 'server.jsonc');
    const previousUmask = process.umask(0o022);
    try {
      chmodSync(serverPath, 0o600);
      expect(statSync(serverPath).mode & 0o777).toBe(0o600);
      const app = createApp({ dataRoot });
      const readRes = await app.request(
        ...operationRequest('runtime.file-read', { id: 'server.jsonc' })
      );
      const read = (await readRes.json()) as { file: { revision: string }; content: string };
      const nextContent = read.content.replace('agent_codex', 'agent_pi');

      const okRes = await app.request(
        ...operationRequest(
          'runtime.file-update',
          {},
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: 'server.jsonc',
              kind: 'server',
              content: nextContent,
              expectedRevision: read.file.revision,
            }),
          }
        )
      );
      const staleRes = await app.request(
        ...operationRequest(
          'runtime.file-update',
          {},
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: 'server.jsonc',
              kind: 'server',
              content: read.content,
              expectedRevision: read.file.revision,
            }),
          }
        )
      );

      expect(okRes.status).toBe(200);
      expect(readFileSync(serverPath, 'utf8')).toBe(nextContent);
      expect(statSync(serverPath).mode & 0o777).toBe(0o600);
      expect(staleRes.status).toBe(409);
    } finally {
      process.umask(previousUmask);
    }
  });

  it('rejects path traversal and invalid config writes', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const app = createApp({ dataRoot });

    const traversalRes = await app.request(
      ...operationRequest('runtime.file-read', { id: '../server.jsonc' })
    );
    const invalidRes = await app.request(
      ...operationRequest(
        'runtime.file-update',
        {},
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: 'server.jsonc',
            kind: 'server',
            content: '{',
            expectedRevision: 'sha256:not-current',
          }),
        }
      )
    );

    expect(traversalRes.status).toBe(400);
    expect(invalidRes.status).toBe(400);
  });

  it('validates draft overlays without mutating disk and returns reload plans', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const runtimeConfigManager = createRuntimeConfigManager({ dataRoot });
    const app = createTestApp({ dataRoot, runtimeConfigManager });
    const activeSnapshot = runtimeConfigManager.current();
    const activeProviders = structuredClone(activeSnapshot.providerRegistry.list());
    const providerFileId = 'providers/agent-openrouter.provider.jsonc';
    const providerPath = join(dataRoot, 'config', providerFileId);
    const original = readFileSync(providerPath, 'utf8');
    const serverPath = join(dataRoot, 'config', 'server.jsonc');
    const originalServer = readFileSync(serverPath, 'utf8');
    const overlayRoots: string[] = [];
    const allocate = fs.mkdtempSync;
    // Delegate every real allocation; observe only request-owned validation staging.
    const allocation = vi.spyOn(fs, 'mkdtempSync').mockImplementation((...args) => {
      const root = allocate(...args);
      if (String(args[0]) === join(tmpdir(), 'openkit-config-overlay-')) {
        expect(lstatSync(root).isDirectory()).toBe(true);
        overlayRoots.push(String(root));
      }
      return root;
    });
    try {
      syncBuiltinESMExports();
      const invalidRes = await app.request(
        ...operationRequest(
          'runtime.validate',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              files: [{ id: 'server.jsonc', content: '{' }],
              mode: 'safe',
            }),
          }
        )
      );
      expect(overlayRoots).toHaveLength(0);
      const changedRes = await app.request(
        ...operationRequest(
          'runtime.validate',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              files: [
                {
                  id: providerFileId,
                  content: original.replace('openrouter.ai', 'openrouter.example.com'),
                },
              ],
              mode: 'safe',
            }),
          }
        )
      );
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
      expect(changed.plan.requiresRestart).toEqual([
        expect.objectContaining({ path: 'providers' }),
      ]);
      expect(readFileSync(providerPath, 'utf8')).toBe(original);
      // Temporary-root hygiene includes removal before either validation result returns.
      // Owner: File Storage And Knowledge Packages, Control-Store Integration.
      expect(overlayRoots.length).toBeGreaterThan(0);
      for (const root of overlayRoots) {
        expect(() => lstatSync(root)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
      }
      const successRootCount = overlayRoots.length;
      const rejectedRes = await app.request(
        ...operationRequest(
          'runtime.validate',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              files: [
                {
                  id: providerFileId,
                  content: original.replace('openai/gpt-5.1', 'openkit/no-known-context-fixture'),
                },
              ],
              mode: 'safe',
            }),
          }
        )
      );
      const rejected = (await rejectedRes.json()) as {
        valid: boolean;
        diagnostics: Array<{ severity: string }>;
      };
      // Gateway Provider Model Metadata requires a known positive context limit.
      expect(rejected.valid).toBe(false);
      expect(rejected.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error' }));
      expect(overlayRoots.length).toBeGreaterThan(successRootCount);
      expect(new Set(overlayRoots).size).toBe(overlayRoots.length);
      for (const root of overlayRoots) {
        expect(() => lstatSync(root)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
      }
      // Config And Identity, Reload And Failure Contract: drafts do not activate a snapshot.
      expect(runtimeConfigManager.current()).toBe(activeSnapshot);
      expect(runtimeConfigManager.current().providerRegistry.list()).toEqual(activeProviders);
      expect(readFileSync(providerPath, 'utf8')).toBe(original);
      expect(readFileSync(serverPath, 'utf8')).toBe(originalServer);
    } finally {
      allocation.mockRestore();
      syncBuiltinESMExports();
      await shutdownControlStoreWorkerClient();
      for (const root of overlayRoots) rmSync(root, { recursive: true, force: true });
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('preserves preparation failure and partial overlay bytes before validation cleanup', () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const manager = createRuntimeConfigManager({ dataRoot });
    const snapshot = manager.current();
    const first = join(dataRoot, 'workspaces', 'ws_overlay_first', 'config');
    const second = join(dataRoot, 'workspaces', 'ws_overlay_second', 'config');
    const user = join(dataRoot, 'users', 'user_overlay', 'config');
    for (const path of [first, second, user]) mkdirSync(path, { recursive: true });
    const workspaceBytes = '{ "schemaVersion": 1 }\n';
    const catalogBytes = '{ "schemaVersion": 1, "sources": [] }\n';
    writeFileSync(join(first, 'workspace.jsonc'), workspaceBytes);
    writeFileSync(join(first, 'data-sources.jsonc'), catalogBytes);
    writeFileSync(join(second, 'workspace.jsonc'), workspaceBytes);
    writeFileSync(join(user, 'user.jsonc'), workspaceBytes);
    const sourceProvider = join(dataRoot, 'config/providers/agent-openrouter.provider.jsonc');
    const originalProvider = readFileSync(sourceProvider, 'utf8');
    const failure = new Error('Injected overlay catalog copy failure');
    const overlayRoots: string[] = [];
    const allocate = fs.mkdtempSync;
    const copy = fs.cpSync;
    const allocation = vi.spyOn(fs, 'mkdtempSync').mockImplementation((...args) => {
      const root = allocate(...args);
      if (String(args[0]) === join(tmpdir(), 'openkit-config-overlay-'))
        overlayRoots.push(String(root));
      return root;
    });
    const copying = vi.spyOn(fs, 'cpSync').mockImplementation((...args) => {
      if (String(args[0]) === join(first, 'data-sources.jsonc')) throw failure;
      return copy(...args);
    });
    try {
      syncBuiltinESMExports();
      const service = new RuntimeConfigFileService({
        dataRoot,
        workspaceIds: ['ws_overlay_first', 'ws_overlay_second'],
        userId: 'user_overlay',
        runtimeConfigManager: manager,
        readRuntimeConfigStatus: () => manager.status(),
      });
      let caught: unknown;
      try {
        service.validate({
          files: [
            { id: 'providers/agent-openrouter.provider.jsonc', content: originalProvider + '\n' },
          ],
          mode: 'safe',
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(overlayRoots).toHaveLength(1);
      const root = overlayRoots[0]!;
      expect(lstatSync(root).isDirectory()).toBe(true);
      expect(
        readFileSync(join(root, 'config/providers/agent-openrouter.provider.jsonc'), 'utf8')
      ).toBe(originalProvider);
      expect(
        readFileSync(join(root, 'workspaces/ws_overlay_first/config/workspace.jsonc'), 'utf8')
      ).toBe(workspaceBytes);
      expect(existsSync(join(root, 'workspaces/ws_overlay_first/config/data-sources.jsonc'))).toBe(
        false
      );
      expect(existsSync(join(root, 'workspaces/ws_overlay_second'))).toBe(false);
      expect(existsSync(join(root, 'users/user_overlay'))).toBe(false);
      expect(readFileSync(join(first, 'data-sources.jsonc'), 'utf8')).toBe(catalogBytes);
      expect(readFileSync(sourceProvider, 'utf8')).toBe(originalProvider);
      expect(manager.current()).toBe(snapshot);
    } finally {
      copying.mockRestore();
      allocation.mockRestore();
      syncBuiltinESMExports();
      for (const root of overlayRoots) rmSync(root, { recursive: true, force: true });
      rmSync(dataRoot, { recursive: true, force: true });
    }
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
    const listRes = await app.request(...operationRequest('runtime.file-list', {}));

    expect(listRes.status).toBe(401);
  });

  it('does not reload unsaved validation overlays', async () => {
    const dataRoot = createDataRoot();
    writeServerConfig(dataRoot);
    const app = createApp({ dataRoot });
    const providerFileId = 'providers/agent-openrouter.provider.jsonc';
    const original = readFileSync(join(dataRoot, 'config', providerFileId), 'utf8');

    await app.request(
      ...operationRequest(
        'runtime.validate',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            files: [
              {
                id: providerFileId,
                content: original.replace('openrouter.ai', 'openrouter.example.com'),
              },
            ],
          }),
        }
      )
    );
    const reloadRes = await app.request(
      ...operationRequest(
        'runtime.reload',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dryRun: true, mode: 'safe' }),
        }
      )
    );
    const reload = (await reloadRes.json()) as { plan: { applied: unknown[] } };

    expect(existsSync(join(dataRoot, 'config', 'server.jsonc'))).toBe(true);
    expect(reload.plan.applied).toEqual([]);
  });
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});

// openkit-test-platform: posix
// These source checks require real POSIX file symlinks and link-resolution semantics.
// Config Identity: source inspection preserves bytes/revisions; loading and Policy stay separate.
describe.each([
  {
    kind: 'server',
    owner: { kind: 'server' },
    id: 'server.jsonc',
    relativePath: 'config/server.jsonc',
  },
  {
    kind: 'workspace',
    owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
    id: 'workspaces/ws_00000000-0000-7000-8000-000000000001/workspace.jsonc',
    relativePath: 'workspaces/ws_00000000-0000-7000-8000-000000000001/config/workspace.jsonc',
  },
] as const)('$kind runtime config Policy source', ({ kind, owner, id, relativePath }) => {
  it('returns exact raw source and content revision, then observes a fresh byte-only edit', () => {
    // Reuse this owner's temporary-root pattern without initializing SQL or a runtime manager.
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-files-'));
    const path = join(dataRoot, relativePath);
    const source =
      '// Preserve comments, CRLF and Unicode.\r\n{ "sourceOnly": "synthetic ☃", }\r\n';
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
      const expected = {
        content: source,
        file: {
          id,
          kind,
          path: id,
          exists: true,
          revision: `sha256:${createHash('sha256').update(source).digest('hex')}`,
          updatedAt: statSync(path).mtime.toISOString(),
        },
      };
      // This source deliberately has no valid family configuration; reads do not load it.
      expect(readRuntimeConfigPolicySource(dataRoot, owner)).toEqual(expected);
      expect(readRuntimeConfigPolicySource(dataRoot, owner)).toEqual(expected);
      const changed = `${source}// A source-only revision change.\r\n`;
      writeFileSync(path, changed);
      const current = readRuntimeConfigPolicySource(dataRoot, owner);
      expect(current.content).toBe(changed);
      expect(current.file).toEqual({
        ...expected.file,
        revision: `sha256:${createHash('sha256').update(changed).digest('hex')}`,
        updatedAt: statSync(path).mtime.toISOString(),
      });
      expect(current.file.revision).not.toBe(expected.file.revision);
      expect(readFileSync(path, 'utf8')).toBe(changed);
      expect(existsSync(join(dataRoot, 'server'))).toBe(false);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('reports a missing source without creating a file or default configuration', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-files-'));
    const path = join(dataRoot, relativePath);
    try {
      mkdirSync(dirname(path), { recursive: true });
      expect(() => readRuntimeConfigPolicySource(dataRoot, owner)).toThrow(
        expect.objectContaining({ code: 'config_file_not_found', status: 404 })
      );
      expect(existsSync(path)).toBe(false);
      expect(existsSync(join(dataRoot, 'server'))).toBe(false);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each(['inside', 'outside'] as const)(
    'refuses a real file symlink with its target %s the config root before reading content',
    (location) => {
      const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-files-'));
      const outsideRoot = mkdtempSync(join(tmpdir(), 'openkit-config-files-'));
      const path = join(dataRoot, relativePath);
      const target = join(location === 'inside' ? dirname(path) : outsideRoot, 'source.jsonc');
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(target, '// Synthetic outside-read sentinel.\n{}\n');
        symlinkSync(target, path);
        expect(lstatSync(path).isSymbolicLink()).toBe(true);
        const reads = vi.spyOn(fs, 'readFileSync');
        try {
          syncBuiltinESMExports();
          // Preserve existing error priority: containment is checked before file symlink refusal.
          expect(() => readRuntimeConfigPolicySource(dataRoot, owner)).toThrow(
            expect.objectContaining({
              code:
                location === 'inside' ? 'config_symlink_not_allowed' : 'config_path_not_allowed',
              status: 400,
            })
          );
          expect(reads).not.toHaveBeenCalled();
        } finally {
          reads.mockRestore();
          syncBuiltinESMExports();
        }
        expect(readFileSync(target, 'utf8')).toBe('// Synthetic outside-read sentinel.\n{}\n');
        expect(lstatSync(path).isSymbolicLink()).toBe(true);
      } finally {
        rmSync(dataRoot, { recursive: true, force: true });
        rmSync(outsideRoot, { recursive: true, force: true });
      }
    }
  );
});

describe('runtime config Policy source selector', () => {
  it.each([
    { kind: 'workspace', workspaceId: '' },
    { kind: 'workspace', workspaceId: '../outside' },
    { kind: 'workspace', workspaceId: 'nested/workspace' },
    { kind: 'user' },
  ])('refuses unsupported or invalid owner %j before any source content read', (owner) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-files-'));
    const reads = vi.spyOn(fs, 'readFileSync');
    try {
      syncBuiltinESMExports();
      expect(() =>
        readRuntimeConfigPolicySource(
          dataRoot,
          owner as unknown as Parameters<typeof readRuntimeConfigPolicySource>[1]
        )
      ).toThrow(expect.objectContaining({ code: 'config_path_not_allowed', status: 400 }));
      expect(reads).not.toHaveBeenCalled();
      expect(fs.readdirSync(dataRoot)).toEqual([]);
    } finally {
      reads.mockRestore();
      syncBuiltinESMExports();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('requires a nonempty bound data root before any source content read', () => {
    const reads = vi.spyOn(fs, 'readFileSync');
    try {
      syncBuiltinESMExports();
      expect(() => readRuntimeConfigPolicySource('', { kind: 'server' })).toThrow(
        expect.objectContaining({ code: 'config_data_root_required', status: 400 })
      );
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      syncBuiltinESMExports();
    }
  });
});

/** Builds only the actual file owner's inputs; callback failure is an external effect fault. */
async function credentialPreferenceFileFixture(
  onCredentialBindingChange?: (change: unknown) => Promise<void>
) {
  const dataRoot = createDataRoot();
  try {
    writeServerConfig(dataRoot);
    await createDemoStore({ dataRoot });
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const fileId = `workspaces/${workspaceId}/workspace.jsonc`;
    const path = join(dataRoot, 'workspaces', workspaceId, 'config', 'workspace.jsonc');
    const document = parse(readFileSync(path, 'utf8'));
    document.workspace.agents = [
      {
        agentId: 'agent_codex',
        credentialBindings: [
          {
            requirementId: 'first-login',
            vaultGrantId: 'grant_00000000-0000-7000-8000-000000000091',
          },
          {
            requirementId: 'second-login',
            vaultGrantId: 'grant_00000000-0000-7000-8000-000000000092',
          },
        ],
      },
    ];
    const content = JSON.stringify(document);
    writeFileSync(path, content);
    const manager = createRuntimeConfigManager({ dataRoot });
    const files = new RuntimeConfigFileService({
      dataRoot,
      workspaceIds: [workspaceId],
      userId: 'usr_00000000-0000-7000-8000-000000000001',
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
      ...(onCredentialBindingChange ? { onCredentialBindingChange } : {}),
    });
    return { dataRoot, workspaceId, fileId, path, content, manager, files };
  } catch (error) {
    await disposeTestStore(dataRoot);
    throw error;
  }
}

/** Changes both authored references without inventing grant records or loaded authority. */
function changedPreferenceContent(content: string): string {
  const document = JSON.parse(content);
  document.workspace.agents[0].credentialBindings[0].vaultGrantId =
    'grant_00000000-0000-7000-8000-000000000093';
  document.workspace.agents[0].credentialBindings[1].vaultGrantId =
    'grant_00000000-0000-7000-8000-000000000094';
  return JSON.stringify(document);
}

// Unknown authority refuses before publication; an Audit-tail failure cannot undo saved bytes.
describe('credential preference publication failure boundaries', () => {
  it.each(['duplicate-requirement', 'invalid-grant'] as const)(
    'refuses unknown previous binding authority before replacing its bytes: %s',
    async (fault) => {
      const audit = vi.fn(async (_change: unknown) => undefined);
      const f = await credentialPreferenceFileFixture(audit);
      try {
        const loaded = f.manager.current();
        const reload = vi.spyOn(f.manager, 'reload');
        const corrupt = JSON.parse(f.content);
        const bindings = corrupt.workspace.agents[0].credentialBindings;
        if (fault === 'duplicate-requirement') bindings.push({ ...bindings[0] });
        else bindings[0].vaultGrantId = 'not-a-grant-id';
        const corruptContent = JSON.stringify(corrupt);
        // Deliberate physical fault follows valid setup and preserves the retained header/default ID.
        writeFileSync(f.path, corruptContent);
        const current = f.files.readFile(f.fileId);
        expect(current.content).toBe(corruptContent);
        await expect(
          f.files.updateFile({
            id: f.fileId,
            kind: 'workspace',
            expectedRevision: current.file.revision,
            content: changedPreferenceContent(f.content),
          })
        ).rejects.toMatchObject({ code: 'invalid_config_content', status: 409 });
        // Deciding R1 assertion: first draft rejected only after replacing the file.
        expect(readFileSync(f.path, 'utf8')).toBe(corruptContent);
        expect(audit).not.toHaveBeenCalled();
        expect(f.manager.current()).toBe(loaded);
        expect(reload).not.toHaveBeenCalled();
      } finally {
        await disposeTestStore(f.dataRoot);
      }
    }
  );

  it('requires an Audit owner for a nonempty diff while allowing an unchanged save', async () => {
    const f = await credentialPreferenceFileFixture();
    try {
      const current = f.files.readFile(f.fileId);
      const loaded = f.manager.current();
      const reload = vi.spyOn(f.manager, 'reload');
      await expect(
        f.files.updateFile({
          id: f.fileId,
          kind: 'workspace',
          expectedRevision: current.file.revision,
          content: changedPreferenceContent(f.content),
        })
      ).rejects.toMatchObject({ code: 'config_binding_audit_unavailable', status: 503 });
      expect(readFileSync(f.path, 'utf8')).toBe(f.content);
      await expect(
        f.files.updateFile({
          id: f.fileId,
          kind: 'workspace',
          expectedRevision: current.file.revision,
          content: current.content,
        })
      ).resolves.toMatchObject({ file: { id: f.fileId } });
      expect(readFileSync(f.path, 'utf8')).toBe(f.content);
      expect(f.manager.current()).toBe(loaded);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      await disposeTestStore(f.dataRoot);
    }
  });

  it.each([1, 2])(
    'reports saved/Audit-unknown without replay when Audit callback %i fails',
    async (failAt) => {
      const failure = new Error('Injected external Audit acknowledgement failure');
      const atCallback: string[] = [];
      const acknowledged: unknown[] = [];
      let publishedPath = '';
      const audit = vi.fn(async (change: unknown) => {
        atCallback.push(readFileSync(publishedPath, 'utf8'));
        if (atCallback.length === failAt) throw failure;
        acknowledged.push(change);
      });
      const f = await credentialPreferenceFileFixture(audit);
      try {
        publishedPath = f.path;
        const loaded = f.manager.current();
        const reload = vi.spyOn(f.manager, 'reload');
        const current = f.files.readFile(f.fileId);
        const replacement = changedPreferenceContent(current.content);
        let caught: unknown;
        try {
          await f.files.updateFile({
            id: f.fileId,
            kind: 'workspace',
            expectedRevision: current.file.revision,
            content: replacement,
          });
        } catch (error) {
          caught = error;
        }
        // Establish actual callback entry and completed file effect before classifying the failure.
        expect(atCallback).toEqual(Array.from({ length: failAt }, () => replacement));
        expect(readFileSync(f.path, 'utf8')).toBe(replacement);
        expect(f.files.readFile(f.fileId).content).toBe(replacement);
        expect(caught).toMatchObject({ code: 'config_file_saved_audit_unknown', status: 503 });
        expect(caught).toBeInstanceOf(Error);
        if (!(caught instanceof Error))
          throw new Error('The typed publication failure is required.');
        expect(caught.message).toMatch(/\bsaved\b/i);
        expect(caught.message).toMatch(/\baudit\b.*\bunknown\b/i);
        expect(caught.message).toMatch(/\binspect\b/i);
        const offered = audit.mock.calls.map(([change]) => change);
        const expected = [
          {
            workspaceId: f.workspaceId,
            agentId: 'agent_codex',
            requirementId: 'first-login',
            previousGrantId: 'grant_00000000-0000-7000-8000-000000000091',
            nextGrantId: 'grant_00000000-0000-7000-8000-000000000093',
          },
          {
            workspaceId: f.workspaceId,
            agentId: 'agent_codex',
            requirementId: 'second-login',
            previousGrantId: 'grant_00000000-0000-7000-8000-000000000092',
            nextGrantId: 'grant_00000000-0000-7000-8000-000000000094',
          },
        ];
        expect(offered).toHaveLength(failAt);
        for (const change of offered) expect(expected).toContainEqual(change);
        expect(new Set(offered.map((change) => JSON.stringify(change))).size).toBe(failAt);
        expect(acknowledged).toEqual(offered.slice(0, -1));
        expect(f.manager.current()).toBe(loaded);
        expect(reload).not.toHaveBeenCalled();
      } finally {
        await disposeTestStore(f.dataRoot);
      }
    }
  );
});
