import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { createDemoWorkspaceForUser, FsStore } from '../lib/store.js';
import { openWorkspaceDb } from './db.js';
import { LOCAL_USER_ID } from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';
import {
  dryRunWorkspaceImport,
  verifyWorkspaceExportTree,
  WORKSPACE_EXPORT_MANIFEST_FILE,
  WORKSPACE_EXPORT_NON_PORTABLE_WORKSPACE_SQLITE_TABLES,
  WORKSPACE_EXPORT_PORTABLE_WORKSPACE_SQLITE_TABLES,
  writeWorkspaceExportTree,
} from './workspace-export.js';
import { readWorkspaceImportSnapshot } from './workspace-import.js';

const timestamp = '2026-07-05T00:00:00.000Z';

/** Returns one absent export root beneath a unique temporary parent. */
function freshExportRoot(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'export');
}

/** Reads one export through the verified import boundary. */
function readImportSnapshot(exportRoot: string, targetWorkspaceId: string) {
  return readWorkspaceImportSnapshot({
    verified: verifyWorkspaceExportTree({ exportRoot }),
    targetWorkspaceId,
  });
}

/**
 * Writes a minimal export tree fixture.
 *
 * @returns Export root path.
 */
function writeExportTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-'));
  const recordsDir = join(root, 'records');
  const contentInventory = [
    {
      path: 'records/workspace.json',
      digest: 'sha256:ab4a13e5a040b76a82521f52dabddd42e7e4d4244c47e16ee8c6e1aa16233f3f',
      bytes: 16,
    },
  ];

  mkdirSync(recordsDir);
  writeFileSync(join(recordsDir, 'workspace.json'), '{"id":"ws_demo"}');
  writeFileSync(
    join(root, WORKSPACE_EXPORT_MANIFEST_FILE),
    JSON.stringify({
      schemaVersion: 1,
      recordType: 'workspace-export',
      id: 'wsexp_1',
      ownerScope: 'workspace',
      lineage: { workspaceId: 'ws_demo' },
      createdAt: timestamp,
      updatedAt: timestamp,
      contentDigest: `sha256:${createHash('sha256')
        .update(JSON.stringify(contentInventory))
        .digest('hex')}`,
      redactionLevel: 'metadata',
      sensitivity: 'internal',
      requiredFeatures: [],
      extensions: {},
      sourceDeploymentId: 'dep_source',
      workspaceId: 'ws_demo',
      exportCreatedAt: timestamp,
      exportFormatVersion: 2,
      contentInventory,
    })
  );

  return root;
}

describe('workspace export verifier', () => {
  it('verifies manifest shape and inventory file digests offline', () => {
    const verified = verifyWorkspaceExportTree({ exportRoot: writeExportTree() });

    expect(verified.manifest.workspaceId).toBe('ws_demo');
    expect(verified.checkedFiles).toEqual(['records/workspace.json']);
  });

  it('rejects tampered or extra files', () => {
    const tamperedRoot = writeExportTree();
    writeFileSync(join(tamperedRoot, 'records', 'workspace.json'), '{"id":"changed"}');

    expect(() => verifyWorkspaceExportTree({ exportRoot: tamperedRoot })).toThrow(
      'Digest mismatch for export file records/workspace.json'
    );

    const extraRoot = writeExportTree();
    writeFileSync(join(extraRoot, 'records', 'extra.json'), '{}');

    expect(() => verifyWorkspaceExportTree({ exportRoot: extraRoot })).toThrow(
      'Export file missing from inventory: records/extra.json'
    );
  });

  it('writes a verifiable workspace export tree', () => {
    const root = freshExportRoot('openkit-workspace-export-write-');
    const exported = writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 1, artifactCount: 0, knowledgeEntryCount: 1 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [
        {
          id: 'th_demo',
          workspaceId: 'ws_demo',
          name: 'Demo thread',
          preview: 'Demo thread',
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      knowledge: [
        {
          id: 'kn_demo',
          kind: 'project-context',
          title: 'Release cadence',
          content: 'Review releases every Friday.',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      turns: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
      workspaceQuarantineRecords: [
        {
          id: 'wqr_1',
          workspaceId: 'ws_demo',
          lifecycleRecordIds: ['wrr_1', 'wom_1'],
          failureKind: 'digest_mismatch',
          storageRef: 'quarantine/workspace-sync/wqr_1',
          retentionClass: 'restricted-evidence',
          requiredHumanDecision: 'inspect_quarantined_output',
          resolution: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp,
          resolvedAt: null,
        },
      ],
      workspaceSyncEvidenceBundles: [
        {
          id: 'wseb_1',
          workspaceId: 'ws_demo',
          lifecycleRecordIds: ['wrr_1', 'wom_1'],
          evidenceBundleIds: ['evb_workspace_materialization_wmr_1'],
          backendEvidenceRefs: [{ kind: 'backend.openshell', ref: 'session/session_1/output' }],
          redactedEvidenceManifest: [
            {
              kind: 'worker-log',
              ref: 'evidence/workspace-sync/wseb_1/log',
              digest: 'sha256:log',
              bytes: 42,
            },
          ],
          contentDigests: ['sha256:bundle'],
          retentionClass: 'workspace-audit',
          createdAt: timestamp,
        },
      ],
    });

    expect(existsSync(join(root, WORKSPACE_EXPORT_MANIFEST_FILE))).toBe(true);
    expect(exported.checkedFiles).toEqual([
      'records/agent-sessions.jsonl',
      'records/artifact-reviews.jsonl',
      'records/item-revisions.jsonl',
      'records/knowledge-claims.jsonl',
      'records/knowledge-conflicts.jsonl',
      'records/knowledge-context-package-traces.jsonl',
      'records/knowledge-observations.jsonl',
      'records/knowledge-retrieval-traces.jsonl',
      'records/knowledge.jsonl',
      'records/threads.jsonl',
      'records/turn-events.jsonl',
      'records/turns.jsonl',
      'records/workspace-quarantine-records.jsonl',
      'records/workspace-sync-evidence-bundles.jsonl',
      'records/workspace.json',
    ]);
    expect(
      JSON.parse(
        readFileSync(join(root, 'records', 'workspace-quarantine-records.jsonl'), 'utf8').trim()
      )
    ).toMatchObject({ id: 'wqr_1', workspaceId: 'ws_demo' });
    expect(
      JSON.parse(
        readFileSync(join(root, 'records', 'workspace-sync-evidence-bundles.jsonl'), 'utf8').trim()
      )
    ).toMatchObject({ id: 'wseb_1', workspaceId: 'ws_demo' });
    expect(JSON.parse(readFileSync(join(root, 'records', 'workspace.json'), 'utf8'))).toMatchObject(
      {
        id: 'ws_demo',
      }
    );
    expect(verifyWorkspaceExportTree({ exportRoot: root }).manifest.workspaceId).toBe('ws_demo');
  });

  it('round-trips a knowledge proposal source claim', () => {
    const root = freshExportRoot('openkit-workspace-proposal-export-');
    const fixture = createDemoWorkspaceForUser(LOCAL_USER_ID);

    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_proposal',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: fixture.workspace,
      threads: [fixture.thread],
      turns: [],
      knowledge: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
      portableFileState: {
        observations: new Map(),
        claims: new Map([
          [
            '202607',
            [
              {
                id: 'cl_demo',
                workspaceId: fixture.workspace.id,
                statement: 'Portable source claim.',
                sourceReferences: [],
                scope: 'workspace',
                producer: 'test',
                confidence: 1,
                freshness: 'current',
                reviewState: 'accepted',
                conflictStatus: 'none',
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ],
          ],
        ]),
        conflicts: new Map(),
        contextPackageTraces: new Map(),
        retrievalTraces: new Map(),
        workspaceConfig: null,
        workspaceSchema: null,
        nativeKnowledgePages: new Map(),
        contextMaterializations: new Map(),
      },
      knowledgeProposals: [
        {
          id: 'kp_demo',
          workspaceId: fixture.workspace.id,
          title: 'Source-backed proposal',
          summary: 'Preserve the source claim through workspace transfer.',
          sourceClaimId: 'cl_demo',
          status: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    });

    expect(readImportSnapshot(root, 'ws_imported_proposal').knowledgeProposals).toEqual([
      expect.objectContaining({
        workspaceId: 'ws_imported_proposal',
        sourceClaimId: 'cl_demo',
      }),
    ]);
  });

  it('round-trips canonical workspace history with deterministic reminted lineage', () => {
    const root = freshExportRoot('openkit-workspace-history-export-');
    const targetWorkspaceId = 'ws_imported_history';
    const workspace = {
      id: 'ws_source',
      name: 'History workspace',
      kind: 'general',
      status: 'active',
      defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
      counts: { threadCount: 1, artifactCount: 1, knowledgeEntryCount: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const thread = {
      id: 'th_source',
      workspaceId: workspace.id,
      name: 'History thread',
      preview: 'Canonical history',
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const firstItemRevision = {
      id: 'it_source',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: 'tu_source',
      type: 'assistant-message',
      status: 'in_progress',
      text: 'First answer revision.',
      createdAt: timestamp,
      completedAt: null,
    };
    const currentItem = {
      ...firstItemRevision,
      status: 'completed',
      text: 'Current answer revision.',
      completedAt: timestamp,
    };
    const agentSession = {
      id: 'as_source',
      agentId: 'agent_codex_host',
      workspaceId: workspace.id,
      threadId: thread.id,
      status: 'idle',
      message: null,
      sandboxSummary: null,
      configVersion: 1,
      environmentPackageSnapshotId: null,
      policySnapshotId: null,
      sessionCompatibilityKey: null,
      stale: false,
      workspaceRoots: [
        {
          id: 'root_source',
          sourceKind: 'host-dir',
          sourcePath: '/private/source/workspace',
          workerPath: '/workspace/source',
          access: 'read-write',
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const artifact = {
      id: 'ar_source',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: firstItemRevision.turnId,
      kind: 'summary',
      title: 'Canonical artifact',
      status: 'ready',
      summary: 'Portable artifact metadata.',
      version: 1,
      content: {
        format: 'markdown',
        body: '# Portable artifact\n\nThe body has one file owner.',
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const artifactItem = {
      id: 'it_artifact_source',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: firstItemRevision.turnId,
      type: 'artifact-reference',
      status: 'completed',
      parentItemId: firstItemRevision.id,
      artifactId: artifact.id,
      title: artifact.title,
      summary: artifact.summary,
      createdAt: timestamp,
      completedAt: timestamp,
    };
    const approvalItem = {
      id: 'it_approval_source',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: firstItemRevision.turnId,
      type: 'approval-request',
      status: 'in_progress',
      approvalRequestId: 'apr_source',
      title: 'Approve portable history',
      description: 'Confirm the imported history.',
      kind: 'permission',
      createdAt: timestamp,
      completedAt: null,
    };
    const turn = {
      id: firstItemRevision.turnId,
      workspaceId: workspace.id,
      threadId: thread.id,
      items: [currentItem, artifactItem, approvalItem],
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: approvalItem.approvalRequestId,
        itemId: approvalItem.id,
      },
      agentSessionId: agentSession.id,
      error: null,
      configVersion: null,
      startedAt: timestamp,
      completedAt: null,
      durationMs: null,
    };
    const artifactReview = {
      artifactId: artifact.id,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      status: 'needs_refinement',
      requestId: 'artifact-review-export',
      message: 'Refine this artifact in a deterministic future turn.',
      decidedAt: timestamp,
      followUpTurnId: 'tu_future_refinement',
      lifecycle: 'pending',
    };
    const agentSessionEvent = {
      protocolVersion: PROTOCOL_VERSION,
      event: 'agent.session.updated',
      sequence: 1,
      requestId: null,
      timestamp,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'agent-session-updated', agentSession },
    };
    const artifactDeltaEvent = {
      protocolVersion: PROTOCOL_VERSION,
      event: 'item.delta',
      sequence: 2,
      requestId: null,
      timestamp,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: {
        type: 'item-delta',
        itemId: artifactItem.id,
        itemType: artifactItem.type,
        deltaKind: 'artifact-updated',
        artifactId: artifact.id,
      },
    };
    const approvalEvent = {
      protocolVersion: PROTOCOL_VERSION,
      event: 'approval.requested',
      sequence: 3,
      requestId: null,
      timestamp,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: {
        type: 'approval-requested',
        approval: {
          id: approvalItem.approvalRequestId,
          workspaceId: workspace.id,
          threadId: thread.id,
          turnId: turn.id,
          kind: approvalItem.kind,
          status: 'pending',
          title: approvalItem.title,
          description: approvalItem.description,
          createdAt: timestamp,
          resolvedAt: null,
        },
      },
    };
    const exportInput = {
      exportRoot: root,
      exportId: 'wsexp_history',
      sourceDeploymentId: 'dep_source',
      createdAt: timestamp,
      workspace,
      threads: [thread],
      turns: [turn],
      knowledge: [],
      itemRevisions: [firstItemRevision, artifactItem, approvalItem, currentItem],
      artifacts: [artifact],
      artifactReviews: [artifactReview],
      agentSessions: [agentSession],
      turnEvents: [[turn.id, [agentSessionEvent, artifactDeltaEvent, approvalEvent]]],
    };

    const exported = writeWorkspaceExportTree(exportInput);
    const artifactMetadataPath = join(root, 'artifacts', artifact.id, 'artifact.json');
    const artifactBodyPath = join(root, 'artifacts', artifact.id, 'files', 'content.md');
    const artifactMetadata = JSON.parse(readFileSync(artifactMetadataPath, 'utf8'));

    expect.soft(exported.checkedFiles).toContain('artifacts/ar_source/artifact.json');
    expect.soft(exported.checkedFiles).toContain('artifacts/ar_source/files/content.md');
    expect.soft(artifactMetadata).toEqual({
      ...artifact,
      content: { format: artifact.content.format },
    });
    expect.soft(JSON.stringify(artifactMetadata)).not.toContain(artifact.content.body);
    expect.soft(readFileSync(artifactBodyPath, 'utf8')).toBe(artifact.content.body);
    expect.soft(verifyWorkspaceExportTree({ exportRoot: root })).toEqual(exported);

    const snapshot = readImportSnapshot(root, targetWorkspaceId);
    const imported = snapshot as unknown as {
      threads: Array<typeof thread>;
      turns: Array<typeof turn>;
      itemRevisions: Array<typeof currentItem | typeof artifactItem | typeof approvalItem>;
      artifacts: Array<typeof artifact>;
      artifactReviews: Array<typeof artifactReview>;
      agentSessions: Array<typeof agentSession>;
      turnEvents: Array<
        [string, Array<typeof agentSessionEvent | typeof artifactDeltaEvent | typeof approvalEvent>]
      >;
    };

    expect.soft(imported.turns).toHaveLength(1);
    expect.soft(imported.itemRevisions).toHaveLength(4);
    expect.soft(imported.artifacts).toHaveLength(1);
    expect.soft(imported.artifactReviews).toHaveLength(1);
    expect.soft(imported.agentSessions).toHaveLength(1);
    expect.soft(imported.turnEvents).toHaveLength(1);

    const importedThread = imported.threads[0];
    const importedTurn = imported.turns?.[0];
    const importedRevisions = imported.itemRevisions ?? [];
    const importedArtifact = imported.artifacts?.[0];
    const importedReview = imported.artifactReviews?.[0];
    const importedSession = imported.agentSessions?.[0];
    const importedEventEntry = imported.turnEvents?.[0];

    if (
      importedThread &&
      importedTurn &&
      importedRevisions.length === 4 &&
      importedArtifact &&
      importedReview &&
      importedSession &&
      importedEventEntry
    ) {
      const [importedTurnId, [importedSessionEvent, importedArtifactEvent, importedApprovalEvent]] =
        importedEventEntry;
      const importedFirstRevision = importedRevisions[0]!;
      const importedArtifactItem = importedRevisions[1]!;
      const importedApprovalItem = importedRevisions[2]!;
      const importedCurrentItem = importedRevisions[3]!;

      expect.soft(importedThread.id).not.toBe(thread.id);
      expect.soft(importedTurn.id).not.toBe(turn.id);
      expect.soft(importedFirstRevision.id).not.toBe(firstItemRevision.id);
      expect.soft(importedArtifact.id).not.toBe(artifact.id);
      expect.soft(importedSession.id).not.toBe(agentSession.id);
      expect.soft(importedTurn).toMatchObject({
        workspaceId: targetWorkspaceId,
        threadId: importedThread.id,
        agentSessionId: importedSession.id,
        humanGate: { itemId: importedApprovalItem.id },
        items: [importedCurrentItem, importedArtifactItem, importedApprovalItem],
      });
      expect
        .soft(
          importedRevisions.map((item) =>
            item.type === 'assistant-message' ? `${item.type}:${item.text}` : item.type
          )
        )
        .toEqual([
          `assistant-message:${firstItemRevision.text}`,
          'artifact-reference',
          'approval-request',
          `assistant-message:${currentItem.text}`,
        ]);
      expect.soft(importedCurrentItem.id).toBe(importedFirstRevision.id);
      expect.soft(importedArtifactItem).toMatchObject({
        parentItemId: importedCurrentItem.id,
        artifactId: importedArtifact.id,
      });
      expect.soft(importedRevisions).toEqual(
        importedRevisions.map((item) => ({
          ...item,
          workspaceId: targetWorkspaceId,
          threadId: importedThread.id,
          turnId: importedTurn.id,
        }))
      );
      expect.soft(importedArtifact).toMatchObject({
        workspaceId: targetWorkspaceId,
        threadId: importedThread.id,
        turnId: importedTurn.id,
        content: artifact.content,
      });
      expect.soft(importedReview).toMatchObject({
        artifactId: importedArtifact.id,
        workspaceId: targetWorkspaceId,
        threadId: importedThread.id,
        turnId: importedTurn.id,
        status: 'needs_refinement',
        lifecycle: 'pending',
      });
      expect.soft(importedReview.followUpTurnId).not.toBe(artifactReview.followUpTurnId);
      expect.soft(importedSession).toMatchObject({
        workspaceId: targetWorkspaceId,
        threadId: importedThread.id,
      });
      expect.soft(importedTurnId).toBe(importedTurn.id);
      expect.soft(importedSessionEvent).toMatchObject({
        workspaceId: targetWorkspaceId,
        threadId: importedThread.id,
        turnId: importedTurn.id,
        data: {
          type: 'agent-session-updated',
          agentSession: {
            id: importedSession.id,
            workspaceId: targetWorkspaceId,
            threadId: importedThread.id,
          },
        },
      });
      expect
        .soft(importedSessionEvent.data.agentSession)
        .not.toHaveProperty('environmentPackageSnapshotId');
      expect.soft(importedSessionEvent.data.agentSession).not.toHaveProperty('workspaceRoots');
      expect.soft(JSON.stringify(importedSessionEvent)).not.toContain('/private/source/workspace');
      expect.soft(importedArtifactEvent).toMatchObject({
        workspaceId: targetWorkspaceId,
        threadId: importedThread.id,
        turnId: importedTurn.id,
        data: {
          itemId: importedArtifactItem.id,
          artifactId: importedArtifact.id,
        },
      });
      expect.soft(importedApprovalEvent).toMatchObject({
        workspaceId: targetWorkspaceId,
        threadId: importedThread.id,
        turnId: importedTurn.id,
        data: {
          approval: {
            workspaceId: targetWorkspaceId,
            threadId: importedThread.id,
            turnId: importedTurn.id,
          },
        },
      });

      const repeated = readImportSnapshot(root, targetWorkspaceId);
      expect.soft(repeated).toMatchObject({
        threads: [{ id: importedThread.id }],
        turns: [{ id: importedTurn.id }],
        itemRevisions: importedRevisions.map((item) => ({ id: item.id })),
        artifacts: [{ id: importedArtifact.id }],
        artifactReviews: [{ followUpTurnId: importedReview.followUpTurnId }],
        agentSessions: [{ id: importedSession.id }],
      });
    }

    const invalidRoot = freshExportRoot('openkit-workspace-history-invalid-');
    expect(() => {
      writeWorkspaceExportTree({
        ...exportInput,
        exportRoot: invalidRoot,
        exportId: 'wsexp_history_invalid',
        artifacts: [{ ...artifact, turnId: 'tu_stale' }],
      });
      readImportSnapshot(invalidRoot, targetWorkspaceId);
    }).toThrow(/Artifact .* (missing exported turn|invalid lineage)/);

    const staleItemRoot = freshExportRoot('openkit-workspace-history-stale-item-');
    expect(() =>
      writeWorkspaceExportTree({
        ...exportInput,
        exportRoot: staleItemRoot,
        exportId: 'wsexp_history_stale_item',
        turns: [{ ...turn, items: [firstItemRevision, artifactItem, approvalItem] }],
      })
    ).toThrow('Turn items must equal the latest canonical item revisions.');

    const reorderedItemsRoot = freshExportRoot('openkit-workspace-history-reordered-items-');
    expect(() =>
      writeWorkspaceExportTree({
        ...exportInput,
        exportRoot: reorderedItemsRoot,
        exportId: 'wsexp_history_reordered_items',
        turns: [{ ...turn, items: [artifactItem, currentItem, approvalItem] }],
      })
    ).toThrow(/Turn items/);
  });

  it('exports full turn event history after the in-memory replay window rolls over', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-event-history-export-'));
    const fixture = createDemoWorkspaceForUser(LOCAL_USER_ID);
    const store = new FsStore({ dataRoot });
    store.importWorkspaceSnapshot({
      workspace: fixture.workspace,
      threads: [fixture.thread],
      turns: [],
      knowledge: fixture.knowledge,
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
    });
    const turn = store.createTurn(fixture.workspace.id, fixture.thread.id, 'Retain full history');
    for (let index = 0; index < 101; index += 1) {
      store.emitTurnEvent(turn.id, {
        event: 'turn.started',
        workspaceId: fixture.workspace.id,
        threadId: fixture.thread.id,
        turnId: turn.id,
        data: { type: 'turn-started', turnId: turn.id, status: 'running' },
      });
    }
    expect(store.getTurnEvents(turn.id).map((event) => event.sequence)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 2)
    );

    const response = await createApp({ dataRoot, store }).request(
      `/api/app/workspaces/${fixture.workspace.id}/export`,
      { method: 'POST' }
    );
    expect.soft(response.status).toBe(200);
    const responseText = await response.text();
    if (response.status === 200) {
      const body = JSON.parse(responseText) as { exportId: string };
      const imported = readImportSnapshot(
        join(dataRoot, 'server', 'exports', 'workspaces', fixture.workspace.id, body.exportId),
        'ws_imported_event_history'
      );
      expect(imported.turnEvents[0]?.[1].map((event) => event.sequence)).toEqual(
        Array.from({ length: 101 }, (_, index) => index + 1)
      );
    }
  });

  it('dry-runs workspace import verification and collision preview without mutating', () => {
    const root = freshExportRoot('openkit-workspace-import-dry-run-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      turns: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
    });

    expect(
      dryRunWorkspaceImport({
        verified: verifyWorkspaceExportTree({ exportRoot: root }),
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
      })
    ).toMatchObject({
      mode: 'dry-run',
      exportId: 'wsexp_demo',
      exportedWorkspaceId: 'ws_demo',
      collision: {
        status: 'collides',
        workspaceId: 'ws_demo',
        suggestedWorkspaceId: 'ws_imported_ws_demo',
      },
      verification: {
        fileCount: 13,
        checkedFiles: [
          'records/agent-sessions.jsonl',
          'records/artifact-reviews.jsonl',
          'records/item-revisions.jsonl',
          'records/knowledge-claims.jsonl',
          'records/knowledge-conflicts.jsonl',
          'records/knowledge-context-package-traces.jsonl',
          'records/knowledge-observations.jsonl',
          'records/knowledge-retrieval-traces.jsonl',
          'records/knowledge.jsonl',
          'records/threads.jsonl',
          'records/turn-events.jsonl',
          'records/turns.jsonl',
          'records/workspace.json',
        ],
      },
    });
  });

  it('rejects imported records with unsupported required features', () => {
    const root = freshExportRoot('openkit-workspace-import-record-feature-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      turns: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
    });
    const workspacePath = join(root, 'records', 'workspace.json');
    const workspaceRecord = JSON.parse(readFileSync(workspacePath, 'utf8')) as Record<
      string,
      unknown
    >;
    const workspaceText = `${JSON.stringify(
      { ...workspaceRecord, requiredFeatures: ['workspace.record.future'] },
      null,
      2
    )}\n`;
    writeFileSync(workspacePath, workspaceText);
    const manifestPath = join(root, WORKSPACE_EXPORT_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      contentDigest: string;
      contentInventory: Array<{ path: string; digest: string; bytes: number }>;
    };
    const workspaceEntry = manifest.contentInventory.find(
      (entry) => entry.path === 'records/workspace.json'
    );
    if (!workspaceEntry) {
      throw new Error('Expected workspace inventory entry.');
    }
    workspaceEntry.bytes = Buffer.byteLength(workspaceText);
    workspaceEntry.digest = `sha256:${createHash('sha256').update(workspaceText).digest('hex')}`;
    manifest.contentDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify(manifest.contentInventory))
      .digest('hex')}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => readImportSnapshot(root, 'ws_imported_demo')).toThrow(
      'Unsupported requiredFeatures in records/workspace.json: workspace.record.future'
    );
  });

  it('rejects a workspace record owned by another manifest workspace', () => {
    const root = freshExportRoot('openkit-workspace-import-owner-mismatch-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_owner_mismatch',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_manifest_owner',
        name: 'Manifest owner',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      turns: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
    });
    const workspacePath = join(root, 'records', 'workspace.json');
    const workspaceRecord = JSON.parse(readFileSync(workspacePath, 'utf8')) as Record<
      string,
      unknown
    >;
    const workspaceText = `${JSON.stringify(
      { ...workspaceRecord, id: 'ws_record_owner' },
      null,
      2
    )}\n`;
    writeFileSync(workspacePath, workspaceText);
    const manifestPath = join(root, WORKSPACE_EXPORT_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      contentDigest: string;
      contentInventory: Array<{ path: string; digest: string; bytes: number }>;
    };
    const workspaceEntry = manifest.contentInventory.find(
      (entry) => entry.path === 'records/workspace.json'
    );
    if (!workspaceEntry) {
      throw new Error('Expected workspace inventory entry.');
    }
    workspaceEntry.bytes = Buffer.byteLength(workspaceText);
    workspaceEntry.digest = `sha256:${createHash('sha256').update(workspaceText).digest('hex')}`;
    manifest.contentDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify(manifest.contentInventory))
      .digest('hex')}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => readImportSnapshot(root, 'ws_imported_owner')).toThrow(
      'Workspace record id does not match the export manifest.'
    );
  });

  it('rejects unknown evidence fields while reading workspace imports', () => {
    const root = freshExportRoot('openkit-workspace-import-evidence-extra-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      turns: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
      evidenceBundles: [
        {
          id: 'evb_extra',
          workspaceId: 'ws_demo',
          threadId: null,
          goalId: null,
          turnId: null,
          agentSessionId: null,
          backendType: null,
          sourceKind: 'manual',
          summary: 'Evidence with future metadata.',
          rawEvidenceRefs: [],
          redactedEvidenceRefs: [{ kind: 'workspace', ref: 'ws_demo' }],
          contentDigests: ['sha256:evidence'],
          retentionClass: 'workspace-audit',
          sensitivityClass: 'product-safe',
          importStatus: 'promoted',
          requiredFeatures: ['evidence.bundle.v1'],
          createdAt: timestamp,
          futureOptionalNote: 'ignored by this reader',
        },
      ],
      runtimeEvidence: [
        {
          id: 'rte_extra',
          workspaceId: 'ws_demo',
          threadId: null,
          turnId: null,
          goalId: null,
          taskId: null,
          agentSessionId: null,
          backendType: 'openshell',
          backendVersion: null,
          placement: 'local',
          phase: 'teardown',
          summary: 'Runtime evidence with future metadata.',
          policyDigest: null,
          workerImage: null,
          sandboxSummary: null,
          capabilitySummary: null,
          uploadManifest: [],
          downloadManifest: [],
          transcriptSummary: null,
          workspaceChangeSummary: null,
          controlSummary: null,
          outcome: 'succeeded',
          exitCode: 0,
          signal: null,
          stopReason: 'completed',
          errorCode: null,
          errorMessage: null,
          redactedStdoutSummary: null,
          redactedStderrSummary: null,
          evidenceBundleIds: [],
          contentDigests: ['sha256:runtime'],
          requiredFeatures: ['runtime.evidence.v1'],
          createdAt: timestamp,
          startedAt: timestamp,
          completedAt: timestamp,
          collectedAt: timestamp,
          futureOptionalNote: 'ignored by this reader',
        },
      ],
    });

    expect(() => readImportSnapshot(root, 'ws_imported_demo')).toThrow();
  });

  it('rejects unknown usage ledger fields while reading workspace imports', () => {
    const root = freshExportRoot('openkit-workspace-import-usage-extra-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      turns: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
      capabilityCalls: [
        {
          id: 'cap_extra',
          workspaceId: 'ws_demo',
          threadId: null,
          turnId: null,
          itemId: null,
          agentId: null,
          agentSessionId: null,
          requestId: null,
          sourceIds: [],
          capabilityId: 'runtime.worker_turn',
          status: 'succeeded',
          summary: 'Imported capability call.',
          errorCode: null,
          startedAt: timestamp,
          completedAt: timestamp,
          family: 'runtime',
          operation: 'worker.checkpoint.terminal',
          providerRef: 'nanocore-runtime',
          serviceRef: 'worker-checkpoint',
          redactionClass: 'metadata-only',
          futureOptionalNote: 'ignored by this reader',
        },
      ],
      usageRecords: [
        {
          id: 'use_extra',
          workspaceId: 'ws_demo',
          threadId: null,
          turnId: null,
          itemId: null,
          capabilityCallId: 'cap_extra',
          requestId: null,
          agentId: null,
          agentSessionId: null,
          sourceIds: [],
          category: 'runtime',
          unit: 'sandbox_sessions',
          quantity: 1,
          modelId: null,
          providerRef: 'nanocore-runtime',
          source: 'worker-checkpoint-terminal',
          recordedAt: timestamp,
          futureOptionalNote: 'ignored by this reader',
        },
      ],
    });

    expect(() => readImportSnapshot(root, 'ws_imported_demo')).toThrow();
  });

  it('rejects unknown Git push record fields while reading workspace imports', () => {
    const root = freshExportRoot('openkit-workspace-import-git-push-extra-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      turns: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
      gitPushRecords: [
        {
          id: 'gpr_extra',
          workspaceId: 'ws_demo',
          repositoryResourceId: 'repo_default',
          approvalRowId: 'act_git_push_1',
          policyDecisionId: 'pd_git_push_1',
          actorId: 'user_local',
          remoteSummary: 'GitHub repository openkit on origin',
          sourceRef: 'HEAD',
          targetBranch: 'main',
          commitIds: ['abc123'],
          reviewIds: ['wr_review_1'],
          remoteHeadBefore: 'abc000',
          remoteHeadAfter: 'def456',
          outcome: 'pushed',
          errorSummary: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          requestId: '00000000-0000-4000-8000-00000000d753',
          futureOptionalNote: 'ignored by this reader',
        },
      ],
    });

    expect(() => readImportSnapshot(root, 'ws_imported_demo')).toThrow();
  });

  it('rewrites workspace quarantine records while reading workspace imports', () => {
    const root = freshExportRoot('openkit-workspace-import-quarantine-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      turns: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
      workspaceQuarantineRecords: [
        {
          id: 'wqr_import',
          workspaceId: 'ws_demo',
          lifecycleRecordIds: ['wrr_import'],
          failureKind: 'schema_failure',
          storageRef: 'quarantine/workspace-sync/wqr_import',
          retentionClass: 'restricted-evidence',
          requiredHumanDecision: null,
          resolution: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp,
          resolvedAt: null,
        },
      ],
    });

    const snapshot = readImportSnapshot(root, 'ws_imported_demo');

    expect(snapshot.workspaceQuarantineRecords).toEqual([
      expect.objectContaining({
        id: 'wqr_import',
        workspaceId: 'ws_imported_demo',
        storageRef: 'quarantine/workspace-sync/wqr_import',
      }),
    ]);
  });

  it('rewrites workspace sync evidence bundles while reading workspace imports', () => {
    const root = freshExportRoot('openkit-workspace-import-sync-evidence-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      turns: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
      workspaceSyncEvidenceBundles: [
        {
          id: 'wseb_import',
          workspaceId: 'ws_demo',
          lifecycleRecordIds: ['wrr_import'],
          evidenceBundleIds: ['evb_import'],
          backendEvidenceRefs: [{ kind: 'backend.openshell', ref: 'session/session_1/output' }],
          redactedEvidenceManifest: [
            {
              kind: 'worker-log',
              ref: 'evidence/workspace-sync/wseb_import/log',
              digest: 'sha256:log',
              bytes: 42,
            },
          ],
          contentDigests: ['sha256:bundle'],
          retentionClass: 'workspace-audit',
          createdAt: timestamp,
        },
      ],
    });

    const snapshot = readImportSnapshot(root, 'ws_imported_demo');

    expect(snapshot.workspaceSyncEvidenceBundles).toEqual([
      expect.objectContaining({
        id: 'wseb_import',
        workspaceId: 'ws_imported_demo',
        evidenceBundleIds: ['evb_import'],
      }),
    ]);
  });

  it('exports and imports redacted worker setup evidence rows', () => {
    const root = freshExportRoot('openkit-workspace-worker-evidence-');
    const workerThread = {
      id: 'th_1',
      workspaceId: 'ws_demo',
      name: 'Worker evidence thread',
      preview: 'Worker evidence',
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const workerTurn = {
      id: 'turn_1',
      workspaceId: 'ws_demo',
      threadId: workerThread.id,
      items: [],
      status: 'completed',
      humanGate: null,
      error: null,
      configVersion: null,
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 1,
    };
    const workerSession = {
      id: 'as_1',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: workerThread.id,
      status: 'idle',
      message: null,
      sandboxSummary: null,
      configVersion: null,
      environmentPackageSnapshotId: 'aepsnap_demo',
      policySnapshotId: null,
      sessionCompatibilityKey: null,
      stale: false,
      workspaceRoots: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 1, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [workerThread],
      knowledge: [],
      turns: [workerTurn],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [workerSession],
      turnEvents: [],
      resolvedAgentSetups: [
        {
          id: 'ras_demo',
          workspaceId: 'ws_demo',
          turnId: 'turn_1',
          requestId: 'req_1',
          agentId: 'agent_codex_host',
          providerId: 'openai_codex',
          runtimeKind: 'codex',
          runtimeAdapter: 'codex-app-server',
          requiredFeatures: ['knowledge.read'],
          setup: {
            agent: { displayName: 'Codex Agent', id: 'agent_codex_host' },
            deployment: {
              config: { args: ['app-server'], command: 'codex' },
              mode: 'local',
              origin: 'agent-config',
            },
            origins: {
              deployment: 'agent-config',
              provider: 'server-providers',
              runtime: 'agent-config',
              transport: 'adapter-defaults',
            },
            provider: {
              model: 'gpt-5',
              origin: 'server-providers',
              providerId: 'openai_codex',
              secretRef: null,
            },
            requiredFeatures: ['knowledge.read'],
            runtime: { adapter: 'codex-app-server', kind: 'codex', version: '0.130.0' },
            transport: { kind: 'stdio', origin: 'adapter-defaults' },
          },
          createdAt: timestamp,
        },
      ],
      agentEnvironmentPackageSnapshots: [
        {
          snapshotId: 'aepsnap_demo',
          workspaceId: 'ws_demo',
          turnId: 'turn_1',
          threadId: 'th_1',
          agentSessionId: 'as_1',
          agentId: 'agent_codex_host',
          packageId: 'aep_demo',
          runtimeKind: 'codex',
          backendKind: 'openshell',
          contentDigest: 'digest_demo',
          snapshot: {
            snapshotId: 'aepsnap_demo',
            packageId: 'aep_demo',
            scope: {
              workspaceId: 'ws_demo',
              threadId: 'th_1',
              turnId: 'turn_1',
              agentSessionId: 'as_1',
            },
            agent: { agentId: 'agent_codex_host', runtimeKind: 'codex' },
            backend: { preferred: 'openshell' },
          },
          createdAt: timestamp,
        },
      ],
    });

    expect(readFileSync(join(root, 'records', 'resolved-agent-setups.jsonl'), 'utf8')).toContain(
      'ras_demo'
    );
    expect(
      readFileSync(join(root, 'records', 'agent-environment-package-snapshots.jsonl'), 'utf8')
    ).toContain('aepsnap_demo');

    const snapshot = readImportSnapshot(root, 'ws_imported_demo');

    expect(snapshot.resolvedAgentSetups).toEqual([
      expect.objectContaining({
        id: 'ras_demo',
        workspaceId: 'ws_imported_demo',
        turnId: snapshot.turns[0]?.id,
        setup: expect.objectContaining({
          agent: { displayName: 'Codex Agent', id: 'agent_codex_host' },
        }),
      }),
    ]);
    expect(snapshot.agentEnvironmentPackageSnapshots).toEqual([
      expect.objectContaining({
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        workspaceId: 'ws_imported_demo',
        snapshot: expect.objectContaining({
          scope: expect.objectContaining({
            workspaceId: 'ws_imported_demo',
            threadId: snapshot.threads[0]?.id,
            turnId: snapshot.turns[0]?.id,
            agentSessionId: snapshot.agentSessions[0]?.id,
          }),
        }),
      }),
    ]);
    expect(snapshot.agentEnvironmentPackageSnapshots[0]!.snapshotId).not.toBe('aepsnap_demo');
    expect(snapshot.agentEnvironmentPackageSnapshots[0]!.contentDigest).not.toBe('digest_demo');
  });

  it('imports workspace-family capability call rows', () => {
    const root = freshExportRoot('openkit-workspace-capability-family-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_demo',
      sourceDeploymentId: 'dep_local',
      createdAt: timestamp,
      workspace: {
        id: 'ws_demo',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        defaults: { defaultModelId: null, defaultAgentId: null, defaultSkillIds: [] },
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      knowledge: [],
      turns: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
      capabilityCalls: [
        {
          id: 'cap_workspace_read',
          workspaceId: 'ws_demo',
          threadId: null,
          turnId: null,
          itemId: null,
          agentId: null,
          agentSessionId: null,
          requestId: null,
          sourceIds: [],
          capabilityId: 'assistant.repository.read',
          family: 'workspace',
          operation: 'repository.root_list',
          summary: 'Assistant read linked repository root entries.',
          providerRef: null,
          serviceRef: 'workspace-repository',
          redactionClass: 'metadata',
          status: 'succeeded',
          errorCode: null,
          startedAt: timestamp,
          completedAt: timestamp,
        },
      ],
    });

    expect(readImportSnapshot(root, 'ws_imported_demo').capabilityCalls).toEqual([
      expect.objectContaining({
        capabilityId: 'assistant.repository.read',
        family: 'workspace',
        workspaceId: 'ws_imported_demo',
      }),
    ]);
  });

  it('keeps workspace sqlite table export coverage explicit', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-coverage-'));
    const workspaceDb = openWorkspaceDb(dataRoot, LOCAL_USER_ID, 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      const tables = (
        workspaceDb.sqlite
          .prepare(
            `SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'
             ORDER BY name ASC`
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      const covered = [
        ...WORKSPACE_EXPORT_PORTABLE_WORKSPACE_SQLITE_TABLES,
        ...WORKSPACE_EXPORT_NON_PORTABLE_WORKSPACE_SQLITE_TABLES.map((entry) => entry.table),
      ].sort();

      expect(covered).toEqual(tables);
      expect(WORKSPACE_EXPORT_NON_PORTABLE_WORKSPACE_SQLITE_TABLES).toEqual([
        {
          table: 'idempotency_requests',
          reason: 'short-lived request replay state is local to the source workspace',
        },
        {
          table: 'workspace_filesystem_staging_roots',
          reason: 'host-local apply staging paths are not portable export history',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
