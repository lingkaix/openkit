import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  importMcpToolSchemaSnapshots,
  listExportableMcpToolSchemaSnapshots,
  mcpToolSchemaContentDigest,
  readRetainedMcpToolSchemaSnapshot,
} from './mcp-tool-schema-snapshots.js';

/** Creates one disposable native snapshot owner without a live MCP server or App. */
function retainedSnapshotFixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-retained-mcp-schema-'));
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const db = openWorkspaceDb(root, workspaceId);
  onTestFinished(() => {
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
  it('writes v1 and reads exact nested schema annotations without changing stored bytes', () => {
    const { db, snapshot, selector } = retainedSnapshotFixture();
    const before = db.sqlite.prepare('SELECT * FROM mcp_tool_schema_snapshots').get();
    expect(before).toMatchObject({ schema_version: 1 });
    expect(readRetainedMcpToolSchemaSnapshot(selector)?.tools).toEqual(snapshot.tools);
    expect(listExportableMcpToolSchemaSnapshots(db, snapshot.workspaceId)).toEqual([snapshot]);
    expect(db.sqlite.prepare('SELECT * FROM mcp_tool_schema_snapshots').get()).toEqual(before);
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
