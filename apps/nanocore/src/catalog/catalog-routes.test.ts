import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationId } from '@openkit/app-api-schemas';
import {
  GetWorkspaceCatalogResponseSchema,
  ImportSkillResponseSchema,
} from '@openkit/app-api-schemas';
import { createCoreClient } from '@openkit/core-client';
import { ApiErrorSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createVaultGrant } from '../vault/vault-grants.js';
import { createVaultReference } from '../vault/vault-references.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  catalogDocumentPath,
  loadWorkspaceResourceCatalog,
  projectEffectiveWorkspaceMcpCatalog,
} from './resource-catalog.js';

/** Creates isolated catalog authority without credential material or upstream contact. */
function catalogFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-mcp-binding-routes-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('MCP binding workspace');
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: workspace.id });
  const app = createApp({ coreDb, dataRoot, store });
  return { app, coreDb, dataRoot, workspace };
}

/** Posts complete logical input through the canonical catalog operation. */
function postCatalog(app: ReturnType<typeof createApp>, path: OperationId, input: unknown) {
  return app.request(
    ...operationRequest(
      path,
      {},
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }
    )
  );
}

describe('resource catalog operations', () => {
  it('keeps schema-invalid retained catalog reads on the fixed catalog.read error', async () => {
    const f = catalogFixture();
    try {
      writeFileSync(
        catalogDocumentPath(f.dataRoot, f.workspace.id),
        JSON.stringify({ revision: 'invalid-retained-revision' })
      );
      const response = await f.app.request(
        ...operationRequest(
          'catalog.read',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: f.workspace.id }),
          }
        )
      );
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(ApiErrorSchema.parse(await response.json())).toMatchObject({
        code: 'catalog_read_failed',
        message: 'The record could not be processed.',
      });
    } finally {
      f.coreDb.sqlite.close();
      rmSync(f.dataRoot, { force: true, recursive: true });
    }
  });

  it.each([
    'http',
    'cli',
  ] as const)('stores, retains and replaces credential bindings through %s', async (surface) => {
    const f = catalogFixture();
    try {
      createVaultReference(f.coreDb, {
        referenceId: 'vault_binding_synthetic',
        displayName: 'Synthetic MCP token',
        ownerScope: 'workspace',
        workspaceId: f.workspace.id,
        secretKind: 'mcp-token',
        backendKind: 'encrypted-file',
        backendLocator: 'synthetic',
      });
      const grant = createVaultGrant(f.coreDb, {
        grantId: 'grant_binding_synthetic',
        vaultReferenceId: 'vault_binding_synthetic',
        ownerScope: 'workspace',
        workspaceId: f.workspace.id,
        allowedInjectionPaths: ['gateway-only'],
        lifetime: 'workspace',
      });
      expect(grant.targetCapabilityId).toBeNull();
      const created = await postCatalog(f.app, 'catalog.mcp-create', {
        workspaceId: f.workspace.id,
        ...{
          allowedTools: ['echo'],
          declaration: { endpoint: 'https://mcp.example.test/mcp', kind: 'http' },
          displayName: 'Echo',
          id: 'echo',
          expectedRevision: 0,
          requestId: crypto.randomUUID(),
        },
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const credentialBindings = [
        {
          slot: 'token',
          vaultGrantId: grant.grantId,
          sink: { kind: 'header', name: 'Authorization' },
          presentation: 'bearer',
        },
      ];
      const command = {
        allowedTools: ['echo'],
        enabled: true,
        schemaPolicy: 'tracking',
        bindingRevision: 1,
        expectedRevision: 1,
        requestId: crypto.randomUUID(),
        credentialBindings,
      };
      const client = createCoreClient({
        baseUrl: 'http://nanocore.test',
        fetch: (input, init) => f.app.fetch(new Request(input, init)),
      });
      const { operationCatalog } = await import(
        new URL('../../../../skills/openkit-operations.mjs', import.meta.url).href
      );
      const operation = operationCatalog.find(
        (entry: { id: string }) => entry.id === 'catalog.mcp-binding'
      );
      const update = async (body: Record<string, unknown>) => {
        if (surface === 'cli') {
          return operation.handler(
            { client },
            operation.inputSchema.parse({
              ...body,
              workspaceId: f.workspace.id,
              mcpId: 'echo',
            })
          );
        }
        const response = await postCatalog(f.app, 'catalog.mcp-binding', {
          workspaceId: f.workspace.id,
          mcpId: 'echo',
          ...body,
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      expect(await update(command)).toEqual({ revision: 2 });
      const bound = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
      expect(bound.mcp.bindings[0]?.credentialBindings).toEqual(credentialBindings);
      expect(projectEffectiveWorkspaceMcpCatalog(bound).servers[0]?.credentialBindings).toEqual(
        credentialBindings
      );
      const { credentialBindings: _omitted, ...policyOnly } = command;
      expect(
        await update({
          ...policyOnly,
          bindingRevision: 2,
          expectedRevision: 2,
          requestId: crypto.randomUUID(),
          timeoutMs: 1200,
        })
      ).toEqual({ revision: 3 });
      const retained = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
      expect(retained.mcp.bindings[0]?.credentialBindings).toEqual(credentialBindings);
      expect(projectEffectiveWorkspaceMcpCatalog(retained).servers[0]?.credentialBindings).toEqual(
        credentialBindings
      );
      const stale = await postCatalog(f.app, 'catalog.mcp-binding', {
        workspaceId: f.workspace.id,
        mcpId: 'echo',
        ...{
          ...command,
          expectedRevision: 2,
          bindingRevision: 3,
          requestId: crypto.randomUUID(),
          credentialBindings: [],
        },
      });
      expect(stale.status).toBe(409);
      expect(ApiErrorSchema.parse(await stale.json()).code).toBe('conflict');
      const staleBinding = await postCatalog(f.app, 'catalog.mcp-binding', {
        workspaceId: f.workspace.id,
        mcpId: 'echo',
        ...{
          ...command,
          expectedRevision: 3,
          bindingRevision: 1,
          requestId: crypto.randomUUID(),
          credentialBindings: [],
        },
      });
      expect(staleBinding.status).toBe(409);
      expect(ApiErrorSchema.parse(await staleBinding.json()).code).toBe('conflict');
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(retained);
      expect(
        await update({
          ...command,
          bindingRevision: 3,
          expectedRevision: 3,
          requestId: crypto.randomUUID(),
          credentialBindings: [],
        })
      ).toEqual({ revision: 4 });
      const cleared = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
      expect(cleared.mcp.bindings[0]?.credentialBindings).toEqual([]);
      expect(projectEffectiveWorkspaceMcpCatalog(cleared).servers[0]?.credentialBindings).toEqual(
        []
      );
    } finally {
      f.coreDb.sqlite.close();
      rmSync(f.dataRoot, { force: true, recursive: true });
    }
  });

  it.each([
    'bearer-sink',
    'transport-sink',
    'duplicate-destination',
  ] as const)('refuses %s without publishing a catalog revision', async (invalid) => {
    const f = catalogFixture();
    try {
      const created = await postCatalog(f.app, 'catalog.mcp-create', {
        workspaceId: f.workspace.id,
        ...{
          allowedTools: ['echo'],
          declaration: { endpoint: 'https://mcp.example.test/mcp', kind: 'http' },
          displayName: 'Echo',
          id: 'echo',
          expectedRevision: 0,
          requestId: crypto.randomUUID(),
        },
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const before = loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id);
      const binding = {
        slot: 'token',
        vaultGrantId: 'grant_binding_synthetic',
        sink:
          invalid === 'transport-sink'
            ? { kind: 'env', name: 'TOKEN' }
            : { kind: 'header', name: invalid === 'bearer-sink' ? 'X-Token' : 'Authorization' },
        ...(invalid === 'bearer-sink' ? { presentation: 'bearer' } : {}),
      };
      const response = await postCatalog(f.app, 'catalog.mcp-binding', {
        workspaceId: f.workspace.id,
        mcpId: 'echo',
        ...{
          allowedTools: ['echo'],
          bindingRevision: 1,
          enabled: true,
          expectedRevision: 1,
          requestId: crypto.randomUUID(),
          schemaPolicy: 'tracking',
          credentialBindings:
            invalid === 'duplicate-destination'
              ? [
                  binding,
                  { ...binding, slot: 'other', sink: { kind: 'header', name: 'authorization' } },
                ]
              : [binding],
        },
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(ApiErrorSchema.parse(await response.json()).code).toBe('invalid_request');
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(before);
    } finally {
      f.coreDb.sqlite.close();
      rmSync(f.dataRoot, { force: true, recursive: true });
    }
  });

  it('returns JSON invalid_request for a malformed catalog body', async () => {
    const f = catalogFixture();
    try {
      const response = await postCatalog(f.app, 'catalog.mcp-create', {
        workspaceId: f.workspace.id,
        ...{ displayName: 42 },
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(ApiErrorSchema.parse(await response.json())).toMatchObject({
        code: 'invalid_request',
        message: 'Invalid operation input.',
      });
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).revision).toBe(0);
    } finally {
      f.coreDb.sqlite.close();
      rmSync(f.dataRoot, { force: true, recursive: true });
    }
  });

  it('imports a Skill and returns the redacted Workspace catalog summary', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-resource-catalog-routes-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Catalog workspace');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const empty = await app.request(
        ...operationRequest(
          'catalog.read',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: workspace.id }),
          }
        )
      );
      expect(empty.status).toBe(200);
      expect(GetWorkspaceCatalogResponseSchema.parse(await empty.json())).toMatchObject({
        candidates: [],
        mcp: [],
        plugins: [],
        revision: 0,
        skills: [],
      });

      const imported = await app.request(
        ...operationRequest(
          'catalog.skill-import',
          {},
          {
            method: 'POST',
            headers: {
              ...{ 'content-type': 'application/json' },
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              workspaceId: workspace.id,
              ...{
                activate: true,
                displayName: 'Repo guidelines',
                expectedRevision: 0,
                requestId: '00000000-0000-4000-8000-000000000001',
                tree: [
                  {
                    contentBase64: Buffer.from('# Hello\n', 'utf8').toString('base64'),
                    kind: 'file',
                    path: 'SKILL.md',
                  },
                ],
              },
            }),
          }
        )
      );
      expect(imported.status).toBe(201);
      const importedBody = ImportSkillResponseSchema.parse(await imported.json());
      expect(importedBody.entry.id).toBe('repo-guidelines');
      expect(importedBody.version.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

      const summary = await app.request(
        ...operationRequest(
          'catalog.read',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: workspace.id }),
          }
        )
      );
      expect(GetWorkspaceCatalogResponseSchema.parse(await summary.json()).skills).toEqual([
        expect.objectContaining({
          currentDigest: importedBody.version.digest,
          displayName: 'Repo guidelines',
          id: 'repo-guidelines',
          pinDigest: null,
          versions: [expect.objectContaining({ digest: importedBody.version.digest })],
        }),
      ]);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('rejects a plugin upload path that escapes the staging root', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-resource-catalog-routes-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Catalog workspace');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const app = createApp({ coreDb, dataRoot, store });
    try {
      const escaped = await app.request(
        ...operationRequest(
          'catalog.plugin-import',
          {},
          {
            method: 'POST',
            headers: {
              ...{ 'content-type': 'application/json' },
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              workspaceId: workspace.id,
              ...{
                expectedRevision: 0,
                install: true,
                requestId: '00000000-0000-4000-8000-000000000002',
                tree: [
                  {
                    contentBase64: Buffer.from('x').toString('base64'),
                    kind: 'file',
                    path: '../../outside.txt',
                  },
                ],
              },
            }),
          }
        )
      );
      expect(escaped.status).toBe(400);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });
});
