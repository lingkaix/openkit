import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { createBootReadinessSnapshot } from './bootstrap/readiness.js';
import { FsStore } from './lib/store.js';
import { registerRemoteMcpRoutes } from './remote-mcp-routes.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

describe('Remote MCP Workspace export retained snapshot refusal', () => {
  it.each([
    'JSON',
    'schema',
  ] as const)('returns a safe operation failure for %s corruption', async (corruption) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-mcp-export-snapshot-'));
    const coreDb = openCoreDb(dataRoot);
    try {
      applyMigrations(coreDb);
      ensureLocalUser(coreDb);
      const store = new FsStore({ dataRoot });
      const workspace = store.createWorkspace('Corrupt snapshot export');
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: workspace.id,
        ownerUserId: 'user_local',
      });
      const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
      try {
        applyScopedMigrations(workspaceDb);
      } finally {
        workspaceDb.sqlite.close();
      }
      const token = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'user_local',
        scope: 'workspace',
        workspaceIds: [workspace.id],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const app = new Hono<{ Variables: AuthVariables }>();
      // Supply the durable Token actor locally; bearer HTTP authentication is outside this seam.
      app.use('*', async (c, next) => {
        c.set('actor', {
          userId: 'user_local',
          kind: 'token',
          tokenId: token.tokenId,
          tokenScope: 'workspace',
          tokenWorkspaceIds: [workspace.id],
        });
        await next();
      });
      registerRemoteMcpRoutes({
        app,
        coreDb,
        store,
        repositoryWorkspaceDb: (id) => openWorkspaceDb(dataRoot, id),
        inflightCommands: new WeakMap(),
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
        getBootReadiness: createBootReadinessSnapshot,
      });
      const snapshotsRoot = join(
        dataRoot,
        'workspaces',
        workspace.id,
        'runtime',
        'agent-sessions',
        'as_corrupt',
        'aep-snapshots'
      );
      mkdirSync(snapshotsRoot, { recursive: true });
      const marker = 'ROW_SECRET_X9';
      writeFileSync(
        join(snapshotsRoot, 'aepsnap_corrupt.json'),
        corruption === 'JSON' ? marker : JSON.stringify(marker)
      );

      const response = await app.request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'call',
            arguments: { operation: 'workspace.export', input: { workspaceId: workspace.id } },
          },
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      const responseText = await response.text();
      expect(responseText).not.toContain(marker);
      const body = JSON.parse(responseText);
      // Retained corruption is an owner failure, so changing the tool input is not the remedy.
      expect(body).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                code: 'operation_failed',
                message: 'Operation failed. Inspect the owner outcome before retrying.',
              }),
            },
          ],
        },
      });
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
