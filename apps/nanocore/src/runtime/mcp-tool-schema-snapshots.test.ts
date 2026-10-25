import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { openTestNativeWorkspace } from '../test-support/store.js';
import {
  importMcpToolSchemaSnapshots,
  listExportableMcpToolSchemaSnapshots,
  mcpToolSchemaContentDigest,
  readRetainedMcpToolSchemaSnapshot,
  readTurnMcpToolSchemaSnapshot,
  recordMcpToolSchemaSnapshot,
} from './mcp-tool-schema-snapshots.js';

/** Creates one disposable native snapshot owner without a live MCP server or App. */
function retainedSnapshotFixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-retained-mcp-schema-'));
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const db = openWorkspaceDb(root, workspaceId);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyScopedMigrations(db);
  const tools = [
    { name: 'lookup', inputSchema: { type: 'object', description: 'Retained schema description' } },
  ];
  const snapshot = {
    workspaceId,
    schemaSnapshotId: 'mcp-schema-fixture',
    catalogEntryId: 'example',
    capturedAt: '2026-10-18T00:00:00.000Z',
    source: 'aep' as const,
    sourceRef: null,
    serverVersion: null,
    contentDigest: mcpToolSchemaContentDigest(tools),
    tools,
  };
  importMcpToolSchemaSnapshots(db, [snapshot]);
  const selector = {
    workspaceDb: db,
    workspaceId,
    catalogEntryId: snapshot.catalogEntryId,
    schemaSnapshotId: snapshot.schemaSnapshotId,
  };
  return { db, snapshot, selector };
}

describe('retained MCP Tool schema SQL format', () => {
  it('writes v1 and reads exact nested schema annotations without changing stored bytes', async () => {
    const { db, snapshot, selector } = retainedSnapshotFixture();
    const before = db.sqlite.prepare('SELECT * FROM mcp_tool_schema_snapshots').get();
    expect(before).toMatchObject({ schema_version: 1 });
    expect(readRetainedMcpToolSchemaSnapshot(selector)?.tools).toEqual(snapshot.tools);
    expect(listExportableMcpToolSchemaSnapshots(db, snapshot.workspaceId)).toEqual([snapshot]);
    expect(db.sqlite.prepare('SELECT * FROM mcp_tool_schema_snapshots').get()).toEqual(before);

    const live = { ...snapshot, source: 'live' as const, schemaSnapshotId: 'mcp-schema-live' };
    const selected = {
      id: live.catalogEntryId,
      schemaPolicy: 'tracking' as const,
      pinnedSchemaSnapshotId: null,
    };
    const environmentPackage = {
      snapshotId: 'aep-read-owner',
      scope: {
        workspaceId: live.workspaceId,
        threadId: allocateEntityId('th'),
        turnId: allocateEntityId('tu'),
        agentSessionId: allocateEntityId('as'),
        triggerActor: { kind: 'user' as const, id: allocateEntityId('usr') },
      },
      agent: { agentId: 'agent_demo' },
      supply: { mcpServers: [selected] },
    };
    const input = { workspaceDb: db, environmentPackage, selected };
    await openTestNativeWorkspace(db);
    expect(readTurnMcpToolSchemaSnapshot(input)).toBeNull();
    // Import deliberately produces inert AEP rows; the native capture owner produces live rows.
    await expect(
      recordMcpToolSchemaSnapshot({
        workspaceDb: db,
        workspaceId: live.workspaceId,
        environmentPackage,
        schemaSnapshotId: live.schemaSnapshotId,
        serverId: selected.id,
        source: 'live',
        tools: live.tools,
      })
    ).resolves.toBe(live.schemaSnapshotId);
    await startCapabilityCall({
      workspaceDb: db,
      workspaceId: environmentPackage.scope.workspaceId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      agentSessionId: environmentPackage.scope.agentSessionId,
      authorityActor: null,
      packageSnapshotId: environmentPackage.snapshotId,
      schemaSnapshotId: live.schemaSnapshotId,
      family: 'mcp',
      operation: 'mcp.list-tools',
      capabilityId: 'mcp.list-tools',
      providerRef: selected.id,
      serviceRef: `mcp-tool:${selected.id}`,
      redactionClass: 'metadata-only',
    });
    const expectedLive = { schemaSnapshotId: live.schemaSnapshotId, tools: live.tools };
    // DX requires current committed binding after ACK, rather than a cached earlier absence.
    expect(readTurnMcpToolSchemaSnapshot(input)).toEqual(expectedLive);
    // COORD13:1x requires per-connection statement reuse at this measured read owner.
    const preparing = vi.spyOn(db.sqlite, 'prepare');
    try {
      expect(readTurnMcpToolSchemaSnapshot(input)).toEqual(expectedLive);
      expect(preparing).not.toHaveBeenCalled();
      expect(db.sqlite.inTransaction).toBe(false);
    } finally {
      preparing.mockRestore();
    }
  });

  it('refuses an unknown row version before decoding malformed Tool JSON or importing over it', () => {
    const { db, snapshot, selector } = retainedSnapshotFixture();
    db.sqlite
      .prepare("UPDATE mcp_tool_schema_snapshots SET schema_version=2, tools_json='{invalid'")
      .run();
    const before = db.sqlite.prepare('SELECT * FROM mcp_tool_schema_snapshots').get();
    expect(() => readRetainedMcpToolSchemaSnapshot(selector)).toThrow(
      'Unsupported retained record format'
    );
    expect(() => listExportableMcpToolSchemaSnapshots(db, snapshot.workspaceId)).toThrow(
      'Unsupported retained record format'
    );
    expect(() => importMcpToolSchemaSnapshots(db, [snapshot])).toThrow(
      'Unsupported retained record format'
    );
    expect(db.sqlite.prepare('SELECT * FROM mcp_tool_schema_snapshots').get()).toEqual(before);
  });
});
