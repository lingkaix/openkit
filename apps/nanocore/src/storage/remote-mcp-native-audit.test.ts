import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

it('returns the original MCP result after native Audit persistence and surfaces Audit storage failure', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-remote-mcp-native-audit-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      workspaceId: DEMO_WORKSPACE_ID,
    });
    const token = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      scope: 'workspace-readonly',
      workspaceIds: [DEMO_WORKSPACE_ID],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const app = await createApp({ coreDb, dataRoot, store, mode: 'server' });
    const observedErrors = vi.fn();
    app.onError((error, context) => {
      observedErrors(error);
      return context.text('Internal Server Error', 500);
    });
    const privateArgument = 'zzzzprivateargument7c9dzzzz';
    const request = () =>
      app.request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token.secret}`,
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'openkit_search', arguments: { query: privateArgument } },
        }),
      });

    // The Token verifier still owns its Main update. Fail only the displaced Audit writer.
    // Storage's SQLite Layers rule requires the moved family to use its physical owner.
    const prepare = coreDb.sqlite.prepare.bind(coreDb.sqlite);
    const mainAuditFailure = new Database.SqliteError('Main Audit writer is busy', 'SQLITE_BUSY');
    const fault = vi.spyOn(coreDb.sqlite, 'prepare').mockImplementation((sql: string) => {
      if (/^\s*INSERT\s+INTO\s+audit_events\b/i.test(sql)) throw mainAuditFailure;
      return prepare(sql);
    });
    const response = await request();
    expect(response.status, observedErrors.mock.calls[0]?.[0]?.message).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ items: [], total: 0, hasMore: false }) }],
      },
    });
    expect(observedErrors).not.toHaveBeenCalled();
    const audits = listServerAuditEvents(coreDb).filter(
      (event) => event.action === 'remote-mcp.request'
    );
    // Remote MCP's Actor and attribution contract requires these exact redacted facts.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
      authentication: { credentialKind: 'token', credentialId: token.record.tokenId },
      workspaceId: null,
      requestId: null,
      action: 'remote-mcp.request',
      resource: '/mcp',
      outcome: 'succeeded',
      summary: `remote-mcp request using Token ${token.record.tokenId}.`,
    });
    expect(JSON.stringify(audits)).not.toContain(token.secret);
    expect(JSON.stringify(audits)).not.toContain(privateArgument);
    fault.mockRestore();

    // Inject a real database refusal after valid setup; neither writer can claim persistence.
    coreDb.sqlite.exec(`CREATE TRIGGER refuse_remote_mcp_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'remote-mcp.request'
      BEGIN SELECT RAISE(ABORT, 'remote-mcp-audit-storage-canary'); END`);
    const failed = await request();
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe('Internal Server Error');
    expect(observedErrors).toHaveBeenCalledTimes(1);
    expect(observedErrors.mock.calls[0]?.[0]).toMatchObject({
      name: 'ControlStoreWorkerError',
      code: 'constraint',
      commit: 'not-committed',
    });
    expect(
      listServerAuditEvents(coreDb).filter((event) => event.action === 'remote-mcp.request')
    ).toEqual(audits);
  } finally {
    vi.restoreAllMocks();
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
