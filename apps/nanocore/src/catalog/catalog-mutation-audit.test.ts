import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationId } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createAppWithLocalIdentity as createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';

describe('Catalog mutation Audit', () => {
  it('retains the caller, exact resource, revision and request without declarations or bindings', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'catalog-mutation-audit-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Audit');
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
    const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
    applyScopedMigrations(workspaceDb);
    const app = createApp({ coreDb, dataRoot, store, mode: 'local' });
    const requests = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const call = (id: OperationId, input: unknown) =>
      app.request(
        ...operationRequest(
          id,
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          }
        )
      );
    try {
      const created = await call('catalog.mcp-create', {
        workspaceId: workspace.id,
        requestId: requests[0],
        expectedRevision: 0,
        id: 'stub',
        displayName: 'Harmless stub',
        allowedTools: ['echo'],
        declaration: { kind: 'http', endpoint: 'https://private-locator-sentinel.invalid/mcp' },
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const mcp = await created.json();
      const selected = await call('catalog.mcp-select', {
        workspaceId: workspace.id,
        requestId: requests[1],
        expectedRevision: 1,
        mcpId: 'stub',
        digest: mcp.versionDigest,
      });
      expect(selected.status, await selected.clone().text()).toBe(200);
      const binding = await call('catalog.mcp-binding', {
        workspaceId: workspace.id,
        requestId: requests[2],
        expectedRevision: 2,
        mcpId: 'stub',
        bindingRevision: 1,
        enabled: true,
        allowedTools: ['echo'],
        schemaPolicy: 'tracking',
      });
      expect(binding.status, await binding.clone().text()).toBe(200);
      const imported = await call('catalog.plugin-import', {
        workspaceId: workspace.id,
        requestId: requests[3],
        expectedRevision: 3,
        tree: [
          {
            kind: 'file',
            path: 'plugin.json',
            contentBase64: Buffer.from(
              JSON.stringify({ name: 'audit-pack', version: '1.0.0' })
            ).toString('base64'),
          },
        ],
      });
      expect(imported.status, await imported.clone().text()).toBe(201);
      const plugin = await imported.json();
      const events = listWorkspaceAuditEvents(workspaceDb, workspace.id);
      const actions = [
        'catalog.mcp-create',
        'catalog.mcp-select',
        'catalog.mcp-binding',
        'catalog.plugin-import',
      ];
      const resources = [
        `mcp:stub@${mcp.versionDigest}`,
        `mcp:stub@${mcp.versionDigest}`,
        'mcp:stub',
        `plugin:${plugin.entry.id}@${plugin.versionDigest}`,
      ];
      for (const [index, action] of actions.entries()) {
        expect(events.find((event) => event.action === action)).toMatchObject({
          actor: { kind: 'user', id: userId },
          authentication: { credentialKind: 'local', credentialId: null },
          requestId: requests[index],
          resource: resources[index],
          resourceRevision: index + 1,
          outcome: 'succeeded',
          category: 'command',
        });
      }
      expect(JSON.stringify(events)).not.toContain('private-locator-sentinel');
      const refused = await call('catalog.mcp-select', {
        workspaceId: workspace.id,
        requestId: randomUUID(),
        expectedRevision: 0,
        mcpId: 'stub',
        digest: mcp.versionDigest,
      });
      expect(refused.status).toBe(409);
      expect(listWorkspaceAuditEvents(workspaceDb, workspace.id)).toEqual(events);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
