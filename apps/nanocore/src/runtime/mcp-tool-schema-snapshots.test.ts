import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, canonicalJsonText } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { openTestNativeWorkspace } from '../test-support/store.js';
import {
  canonicalMcpToolSchemas,
  importMcpToolSchemaSnapshots,
  listExportableMcpToolSchemaSnapshots,
  mcpToolSchemaContentDigest,
  readRetainedMcpToolSchemaSnapshot,
  readTurnMcpToolSchemaSnapshot,
  recordMcpToolSchemaSnapshot,
} from './mcp-tool-schema-snapshots.js';

/**
 * Creates one disposable native snapshot owner without a live MCP server or App.
 * @param tools Product-safe schemas for owner setup.
 * @param contentDigest Original proof when setting up a captured historical row.
 * @param toolsJson Exact current or captured representation supplied to import admission.
 * @returns Open owner, root, retained snapshot and selector.
 */
function retainedSnapshotFixture(
  tools: Array<{ name: string; inputSchema: Record<string, unknown> }> = [
    { name: 'lookup', inputSchema: { type: 'object', description: 'Retained schema description' } },
  ],
  contentDigest = mcpToolSchemaContentDigest(tools),
  toolsJson = canonicalJsonText(canonicalMcpToolSchemas(tools))
) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-retained-mcp-schema-'));
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const db = openWorkspaceDb(root, workspaceId);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    if (db.sqlite.open) db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyScopedMigrations(db);
  const snapshot = {
    workspaceId,
    schemaSnapshotId: 'mcp-schema-fixture',
    catalogEntryId: 'example',
    capturedAt: '2026-10-18T00:00:00.000Z',
    source: 'aep' as const,
    sourceRef: null,
    serverVersion: null,
    contentDigest,
    toolsJson,
    tools,
  };
  importMcpToolSchemaSnapshots(db, [snapshot]);
  const selector = {
    workspaceDb: db,
    workspaceId,
    catalogEntryId: snapshot.catalogEntryId,
    schemaSnapshotId: snapshot.schemaSnapshotId,
  };
  return { db, root, snapshot, selector };
}

describe('retained MCP Tool schema SQL format', () => {
  it('keeps historical schema preimages and the pinned identity through cold read, capture and portability', async () => {
    const tools = [
      {
        name: 'lookup',
        inputSchema: {
          type: 'object',
          properties: {
            10: { type: 'number' },
            2: { type: 'string' },
            alpha: { type: 'boolean', description: 'Retained annotation' },
          },
        },
      },
    ];
    // Captured pre-switch bytes: inputSchema precedes name; integer-looking keys retain numeric enumeration.
    const historical =
      '[{"inputSchema":{"properties":{"2":{"type":"string"},"10":{"type":"number"},"alpha":{"description":"Retained annotation","type":"boolean"}},"type":"object"},"name":"lookup"}]';
    const historicalDigest = createHash('sha256').update(historical).digest('hex');
    const historicalTools = (JSON.parse(historical) as typeof tools).map((tool) => ({
      name: tool.name,
      inputSchema: tool.inputSchema,
    }));
    const { db, root, snapshot, selector } = retainedSnapshotFixture(
      historicalTools,
      historicalDigest,
      historical
    );
    // Restore this owner's historical content proof without inventing another snapshot identity.
    db.sqlite
      .prepare('UPDATE mcp_tool_schema_snapshots SET tools_json = ?, content_digest = ?')
      .run(historical, historicalDigest);
    db.sqlite.close();
    const reopened = openWorkspaceDb(root, snapshot.workspaceId);
    try {
      expect(readRetainedMcpToolSchemaSnapshot({ ...selector, workspaceDb: reopened })).toEqual({
        schemaSnapshotId: snapshot.schemaSnapshotId,
        tools,
      });
      const selected = {
        id: snapshot.catalogEntryId,
        schemaPolicy: 'pinned' as const,
        pinnedSchemaSnapshotId: snapshot.schemaSnapshotId,
      };
      const environmentPackage = {
        snapshotId: 'aep-retained-schema-proof',
        scope: {
          workspaceId: snapshot.workspaceId,
          threadId: allocateEntityId('th'),
          turnId: allocateEntityId('tu'),
          agentSessionId: allocateEntityId('as'),
          triggerActor: { kind: 'user' as const, id: allocateEntityId('usr') },
        },
        agent: { agentId: 'agent_demo' },
        supply: { mcpServers: [selected] },
      };
      await openTestNativeWorkspace(reopened);
      await expect(
        recordMcpToolSchemaSnapshot({
          workspaceDb: reopened,
          workspaceId: snapshot.workspaceId,
          environmentPackage,
          schemaSnapshotId: snapshot.schemaSnapshotId,
          serverId: selected.id,
          source: 'live',
          tools,
        })
      ).resolves.toBe(snapshot.schemaSnapshotId);
      await startCapabilityCall({
        workspaceDb: reopened,
        workspaceId: environmentPackage.scope.workspaceId,
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        agentSessionId: environmentPackage.scope.agentSessionId,
        authorityActor: environmentPackage.scope.triggerActor,
        packageSnapshotId: environmentPackage.snapshotId,
        schemaSnapshotId: snapshot.schemaSnapshotId,
        family: 'mcp',
        operation: 'mcp.list-tools',
        capabilityId: 'mcp.list-tools',
        providerRef: selected.id,
        serviceRef: `mcp-tool:${selected.id}`,
        redactionClass: 'metadata-only',
      });
      expect(
        readTurnMcpToolSchemaSnapshot({ workspaceDb: reopened, environmentPackage, selected })
      ).toEqual({ schemaSnapshotId: snapshot.schemaSnapshotId, tools });
      // The retained tools_json is the content_digest preimage; fresh encoding cannot replace it.
      expect(
        reopened.sqlite
          .prepare('SELECT snapshot_id, tools_json, content_digest FROM mcp_tool_schema_snapshots')
          .all()
      ).toEqual([
        {
          snapshot_id: snapshot.schemaSnapshotId,
          tools_json: historical,
          content_digest: historicalDigest,
        },
      ]);
      const exported = listExportableMcpToolSchemaSnapshots(reopened, snapshot.workspaceId);
      // The earlier portable row has only the original structured fields, before optional byte carriage.
      const earlierStructured = [
        {
          ...snapshot,
          contentDigest: historicalDigest,
          tools: historicalTools,
        },
      ];
      for (const [label, rows] of [
        ['new export', exported],
        ['earlier structured row', earlierStructured],
      ] as const) {
        const destinationRoot = mkdtempSync(join(tmpdir(), 'openkit-mcp-schema-portable-'));
        let destination = openWorkspaceDb(destinationRoot, snapshot.workspaceId);
        try {
          applyScopedMigrations(destination);
          // Backup Export/Import: portable SQL rows cross strict line-oriented JSON transport.
          const jsonl = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
          const transported = jsonl
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line)) as typeof exported;
          importMcpToolSchemaSnapshots(destination, transported);
          destination.sqlite.close();
          destination = openWorkspaceDb(destinationRoot, snapshot.workspaceId);
          expect
            .soft(
              readRetainedMcpToolSchemaSnapshot({
                workspaceDb: destination,
                workspaceId: snapshot.workspaceId,
                catalogEntryId: selected.id,
                schemaSnapshotId: selected.pinnedSchemaSnapshotId,
              }),
              label
            )
            .toEqual({ schemaSnapshotId: snapshot.schemaSnapshotId, tools });
          await openTestNativeWorkspace(destination);
          // The public route proposes identity from fresh schema encoding; the accepted pin stays historical.
          const proposedId = `mcpsnap_${selected.id}_${mcpToolSchemaContentDigest(tools)}`;
          const capture = {
            workspaceDb: destination,
            workspaceId: snapshot.workspaceId,
            environmentPackage,
            schemaSnapshotId: proposedId,
            serverId: selected.id,
            source: 'live' as const,
            tools,
          };
          const liveSnapshotId = await recordMcpToolSchemaSnapshot(capture);
          expect.soft(liveSnapshotId, label).toBe(selected.pinnedSchemaSnapshotId);
          const beforeVersion = destination.sqlite
            .prepare('SELECT captured_at FROM mcp_tool_schema_snapshots WHERE snapshot_id = ?')
            .get(selected.pinnedSchemaSnapshotId) as { captured_at: string };
          expect
            .soft(
              await recordMcpToolSchemaSnapshot({
                ...capture,
                serverVersion: 'observed-version-after-import',
              }),
              label
            )
            .toBe(selected.pinnedSchemaSnapshotId);
          const afterVersion = destination.sqlite
            .prepare(
              'SELECT captured_at, server_version FROM mcp_tool_schema_snapshots WHERE snapshot_id = ?'
            )
            .get(selected.pinnedSchemaSnapshotId) as {
            captured_at: string;
            server_version: string | null;
          };
          // Reusing immutable schema identity must still record a real version-only observation.
          expect.soft(afterVersion.server_version, label).toBe('observed-version-after-import');
          expect
            .soft(Date.parse(afterVersion.captured_at), label)
            .toBeGreaterThan(Date.parse(beforeVersion.captured_at));
          await startCapabilityCall({
            workspaceDb: destination,
            workspaceId: environmentPackage.scope.workspaceId,
            threadId: environmentPackage.scope.threadId,
            turnId: environmentPackage.scope.turnId,
            agentSessionId: environmentPackage.scope.agentSessionId,
            authorityActor: environmentPackage.scope.triggerActor,
            packageSnapshotId: environmentPackage.snapshotId,
            schemaSnapshotId: liveSnapshotId,
            family: 'mcp',
            operation: 'mcp.list-tools',
            capabilityId: 'mcp.list-tools',
            providerRef: selected.id,
            serviceRef: `mcp-tool:${selected.id}`,
            redactionClass: 'metadata-only',
          });
          expect
            .soft(
              readTurnMcpToolSchemaSnapshot({
                workspaceDb: destination,
                environmentPackage,
                selected,
              }),
              label
            )
            .toEqual({ schemaSnapshotId: snapshot.schemaSnapshotId, tools });
          // The same pin must resolve the complete schema with its original exact-byte proof.
          expect
            .soft(
              destination.sqlite
                .prepare(
                  'SELECT snapshot_id, tools_json, content_digest FROM mcp_tool_schema_snapshots'
                )
                .all(),
              label
            )
            .toEqual([
              {
                snapshot_id: snapshot.schemaSnapshotId,
                tools_json: historical,
                content_digest: historicalDigest,
              },
            ]);
        } catch (error) {
          expect.soft(error, label).toBeUndefined();
        } finally {
          await shutdownControlStoreWorkerClient();
          if (destination.sqlite.open) destination.sqlite.close();
          rmSync(destinationRoot, { recursive: true, force: true });
        }
      }
    } finally {
      await shutdownControlStoreWorkerClient();
      reopened.sqlite.close();
    }
  });

  it.each([
    '{',
    '[{"inputSchema":{"type":"string"},"name":"lookup"}]',
  ])('refuses a cold retained schema whose original digest no longer proves tools_json: %s', (changed) => {
    const { db, root, snapshot, selector } = retainedSnapshotFixture();
    db.sqlite.prepare('UPDATE mcp_tool_schema_snapshots SET tools_json = ?').run(changed);
    db.sqlite.close();
    const reopened = openWorkspaceDb(root, snapshot.workspaceId);
    try {
      expect(() =>
        readRetainedMcpToolSchemaSnapshot({ ...selector, workspaceDb: reopened })
      ).toThrow();
      expect(
        reopened.sqlite.prepare('SELECT tools_json FROM mcp_tool_schema_snapshots').all()
      ).toEqual([{ tools_json: changed }]);
    } finally {
      reopened.sqlite.close();
    }
  });

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
      authorityActor: environmentPackage.scope.triggerActor,
      packageSnapshotId: environmentPackage.snapshotId,
      schemaSnapshotId: live.schemaSnapshotId,
      family: 'mcp',
      operation: 'mcp.list-tools',
      capabilityId: 'mcp.list-tools',
      providerRef: selected.id,
      serviceRef: `mcp-tool:${selected.id}`,
      redactionClass: 'metadata-only',
    });
    // #568: exact retained catalog/source/Tool content stays at its snapshot-writer owner.
    expect(listExportableMcpToolSchemaSnapshots(db, live.workspaceId)).toContainEqual(
      expect.objectContaining({
        catalogEntryId: live.catalogEntryId,
        schemaSnapshotId: live.schemaSnapshotId,
        source: 'live',
        tools: live.tools,
      })
    );
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
