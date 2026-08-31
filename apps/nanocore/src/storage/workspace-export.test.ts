import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { createArtifactReview } from '../artifact-reviews.js';
import { createDemoWorkspaceForUser, FsStore } from '../lib/store.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import {
  bindThreadMaterial,
  createWorkspaceMaterial,
  saveWorkspaceMaterialRevision,
} from '../workspace-materials.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { LOCAL_USER_ID } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import {
  dryRunWorkspaceImport,
  verifyWorkspaceExportTree,
  WORKSPACE_EXPORT_MANIFEST_FILE,
  WORKSPACE_EXPORT_NON_PORTABLE_WORKSPACE_SQLITE_TABLES,
  WORKSPACE_EXPORT_PORTABLE_WORKSPACE_SQLITE_TABLES,
  type WriteWorkspaceExportTreeInput,
  writeWorkspaceExportTree as writeWorkspaceExportTreeOwner,
} from './workspace-export.js';
import {
  artifactReferenceItemId,
  listUnresolvedUserInputRequestItemIds,
  serializeKnowledgeProposalRecord,
} from './workspace-file-records.js';
import { readWorkspaceImportSnapshot } from './workspace-import.js';

const timestamp = '2026-07-05T00:00:00.000Z';
const localActor = { kind: 'user', id: LOCAL_USER_ID } as const;

/** Export fixture input with empty Material owner families supplied by the local writer wrapper. */
type WorkspaceExportTestInput = Omit<
  WriteWorkspaceExportTreeInput,
  'threadMaterialBindings' | 'workspaceMaterialRevisions' | 'workspaceMaterials'
> &
  Partial<
    Pick<
      WriteWorkspaceExportTreeInput,
      'threadMaterialBindings' | 'workspaceMaterialRevisions' | 'workspaceMaterials'
    >
  >;

/**
 * Writes one test export while supplying explicit empty private work-resource owner families.
 *
 * @param input Complete export fixture with optional work-resource rows.
 * @returns Verified export tree.
 * @throws Error when the production export writer rejects the fixture.
 */
function writeWorkspaceExportTree(input: WorkspaceExportTestInput) {
  return writeWorkspaceExportTreeOwner({
    threadMaterialBindings: [],
    workspaceMaterialRevisions: [],
    workspaceMaterials: [],
    portableFileState: input.portableFileState ?? {
      claims: new Map(),
      conflicts: new Map(),
      nativeKnowledgePages: new Map(),
      observations: new Map(),
      retrievalTraces: new Map(),
      workerContextPackageFiles: new Map(),
      workspaceConfig: JSON.stringify({
        schemaVersion: 1,
        workspace: { name: input.workspace.name, defaultAgentId: null },
      }),
      workspaceSchema: null,
    },
    ...input,
  });
}

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
 * Removes completed user-input responses from canonical Item JSONL.
 *
 * @param text Canonical Item revision JSONL.
 * @returns Canonical JSONL containing the unresolved request only.
 */
function withoutUserInputResponses(text: string): string {
  return `${text
    .trim()
    .split('\n')
    .filter((line) => JSON.parse(line).type !== 'user-input-response')
    .join('\n')}\n`;
}

/**
 * Writes a minimal export tree fixture.
 *
 * @param recordPath Export-relative path for the single inventory record.
 * @param recordText Exact record bytes.
 * @returns Export root path.
 */
function writeExportTree(
  recordPath: string = 'records/workspace-record.json',
  recordText: string = '{"id":"ws_demo"}'
): string {
  const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-'));
  const recordsDir = join(root, 'records');
  const contentInventory = [
    {
      path: recordPath,
      digest: `sha256:${createHash('sha256').update(recordText).digest('hex')}`,
      bytes: Buffer.byteLength(recordText),
    },
  ];

  mkdirSync(recordsDir);
  writeFileSync(join(root, recordPath), recordText);
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
    expect(verified.checkedFiles).toEqual(['records/workspace-record.json']);
  });

  it('rejects tampered or extra files', () => {
    const tamperedRoot = writeExportTree();
    writeFileSync(join(tamperedRoot, 'records', 'workspace-record.json'), '{"id":"changed"}');

    expect(() => verifyWorkspaceExportTree({ exportRoot: tamperedRoot })).toThrow(
      'Digest mismatch for export file records/workspace-record.json'
    );

    const extraRoot = writeExportTree();
    writeFileSync(join(extraRoot, 'records', 'extra.json'), '{}');

    expect(() => verifyWorkspaceExportTree({ exportRoot: extraRoot })).toThrow(
      'Export file missing from inventory: records/extra.json'
    );
  });

  it.each([
    'records/injection-plans.jsonl',
    'records/injection-receipts.jsonl',
  ])('rejects the unsupported legacy workspace export record path %s', (recordPath) => {
    expect(() =>
      verifyWorkspaceExportTree({ exportRoot: writeExportTree(recordPath, '') })
    ).toThrow(`Unsupported workspace export record path: ${recordPath}`);
  });

  it('writes a verifiable workspace export tree', () => {
    const root = freshExportRoot('openkit-workspace-export-write-');
    const canonicalPageBytes = 'Portable exports must not carry actionable proposals.\n';
    const contentDigest = `sha256:${createHash('sha256').update(canonicalPageBytes).digest('hex')}`;
    const proposal = {
      id: `kp_${'a'.repeat(64)}`,
      workspaceId: 'ws_demo',
      operation: 'create',
      knowledgePageId: 'portable/export-exclusion',
      canonicalPageBytes,
      contentDigest,
      sourceReferences: ['turn:tu_source'],
      rationale: 'Proposal authority remains local to its source Workspace.',
      confidence: 1,
      producer: localActor,
      createdAt: timestamp,
    } as const;
    const reviewRequestId = '00000000-0000-4000-8000-00000000a701';
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
      knowledgeProposals: [proposal],
      knowledgeProposalReviews: [
        {
          proposalId: proposal.id,
          workspaceId: proposal.workspaceId,
          reviewId: `kr_${createHash('sha256')
            .update(
              JSON.stringify({
                workspaceId: proposal.workspaceId,
                proposalId: proposal.id,
                requestId: reviewRequestId,
              })
            )
            .digest('hex')}`,
          requestId: reviewRequestId,
          decision: 'deferred',
          actor: localActor,
          proposalDigest: `sha256:${createHash('sha256')
            .update(serializeKnowledgeProposalRecord(proposal))
            .digest('hex')}`,
          knowledgePageId: proposal.knowledgePageId,
          contentDigest: proposal.contentDigest,
          targetAbsentAtDecision: null,
          decidedAt: timestamp,
        },
      ],
      workspaceMaterials: [{ workspaceId: 'ws_demo', materialId: 'mat_demo' }],
      workspaceMaterialRevisions: [
        { workspaceId: 'ws_demo', materialId: 'mat_demo', revisionId: 'mrev_demo' },
      ],
      threadMaterialBindings: [
        { workspaceId: 'ws_demo', threadId: 'th_demo', materialId: 'mat_demo' },
      ],
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
    });

    expect(existsSync(join(root, WORKSPACE_EXPORT_MANIFEST_FILE))).toBe(true);
    expect(exported.checkedFiles).toEqual([
      'records/agent-sessions.jsonl',
      'records/artifact-reviews.jsonl',
      'records/item-revisions.jsonl',
      'records/knowledge-claims.jsonl',
      'records/knowledge-conflicts.jsonl',
      'records/knowledge-observations.jsonl',
      'records/knowledge-retrieval-traces.jsonl',
      'records/knowledge.jsonl',
      'records/thread-material-bindings.jsonl',
      'records/threads.jsonl',
      'records/turn-events.jsonl',
      'records/turns.jsonl',
      'records/vault-injection-plans.jsonl',
      'records/vault-injection-receipts.jsonl',
      'records/workspace-material-revisions.jsonl',
      'records/workspace-materials.jsonl',
      'records/workspace-quarantine-records.jsonl',
      'records/workspace-record.json',
      'workspace-files/config/workspace.jsonc',
    ]);
    expect(
      JSON.parse(
        readFileSync(join(root, 'records', 'workspace-quarantine-records.jsonl'), 'utf8').trim()
      )
    ).toMatchObject({ id: 'wqr_1', workspaceId: 'ws_demo' });
    expect(
      JSON.parse(readFileSync(join(root, 'records', 'workspace-materials.jsonl'), 'utf8').trim())
    ).toEqual({ materialId: 'mat_demo', workspaceId: 'ws_demo' });
    expect(existsSync(join(root, 'records', 'workspace-sync-evidence-bundles.jsonl'))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(root, 'records', 'workspace-record.json'), 'utf8'))
    ).toMatchObject({
      id: 'ws_demo',
    });
    expect(verifyWorkspaceExportTree({ exportRoot: root }).manifest.workspaceId).toBe('ws_demo');
  });

  it('round-trips canonical workspace history with deterministic reminted lineage', () => {
    const root = freshExportRoot('openkit-workspace-history-export-');
    const targetWorkspaceId = 'ws_imported_history';
    const workspace = {
      id: 'ws_source',
      name: 'History workspace',
      kind: 'general',
      status: 'active',
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
      contentDigest: `sha256:${createHash('sha256')
        .update('# Portable artifact\n\nThe body has one file owner.', 'utf8')
        .digest('hex')}`,
      lastMutationRequestId: 'artifact-create-source',
      origin: {
        kind: 'turn-output',
        threadId: thread.id,
        turnId: firstItemRevision.turnId,
        requestId: 'artifact-create-source',
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const artifactItem = {
      id: artifactReferenceItemId(artifact.id, firstItemRevision.turnId),
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: firstItemRevision.turnId,
      type: 'artifact-reference',
      status: 'completed',
      parentItemId: firstItemRevision.id,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      lastMutationRequestId: artifact.lastMutationRequestId,
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
    const userMessageItem = {
      id: 'it_user_source',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: firstItemRevision.turnId,
      type: 'user-message',
      actor: localActor,
      status: 'completed',
      text: 'Preserve the initiating actor.',
      createdAt: timestamp,
      completedAt: timestamp,
    } as const;
    const userInputRequestItem = {
      id: 'it_user_input_request_source',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: firstItemRevision.turnId,
      type: 'user-input-request',
      responsibleUserId: localActor.id,
      status: 'completed',
      userInputRequestId: 'uir_source',
      prompt: 'Confirm portable attribution.',
      questions: [
        {
          id: 'question_portable',
          header: 'Portable attribution',
          question: 'Continue?',
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
      createdAt: timestamp,
      completedAt: timestamp,
    } as const;
    const userInputResponseRequestId = 'req_user_input_response_source';
    const userInputResponseItem = {
      id: 'it_user_input_response_source',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: firstItemRevision.turnId,
      type: 'user-input-response',
      actor: localActor,
      causationId: userInputResponseRequestId,
      status: 'completed',
      userInputRequestId: userInputRequestItem.userInputRequestId,
      answers: { question_portable: ['Yes'] as [string] },
      createdAt: timestamp,
      completedAt: timestamp,
    } as const;
    expect(
      listUnresolvedUserInputRequestItemIds([
        userInputRequestItem,
        {
          ...userInputResponseItem,
          actor: { kind: 'user', id: 'user_other' },
        },
      ])
    ).toEqual([userInputRequestItem.id]);
    const turn = {
      id: firstItemRevision.turnId,
      workspaceId: workspace.id,
      threadId: thread.id,
      triggerActor: localActor,
      items: [
        currentItem,
        artifactItem,
        approvalItem,
        userMessageItem,
        userInputRequestItem,
        userInputResponseItem,
      ],
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: approvalItem.approvalRequestId,
        itemId: approvalItem.id,
      },
      agentSessionId: null,
      error: null,
      configVersion: null,
      startedAt: timestamp,
      completedAt: null,
      durationMs: null,
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
      itemRevisions: [
        firstItemRevision,
        artifactItem,
        approvalItem,
        currentItem,
        userMessageItem,
        userInputRequestItem,
        userInputResponseItem,
      ],
      artifacts: [artifact],
      artifactReviews: [],
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
      itemRevisions: Array<
        | typeof currentItem
        | typeof artifactItem
        | typeof approvalItem
        | typeof userMessageItem
        | typeof userInputRequestItem
        | typeof userInputResponseItem
      >;
      artifacts: Array<typeof artifact>;
      agentSessions: Array<typeof agentSession>;
      turnEvents: Array<
        [string, Array<typeof agentSessionEvent | typeof artifactDeltaEvent | typeof approvalEvent>]
      >;
    };

    expect.soft(imported.turns).toHaveLength(1);
    expect.soft(imported.itemRevisions).toHaveLength(7);
    expect.soft(imported.artifacts).toHaveLength(1);
    expect.soft(imported.agentSessions).toHaveLength(1);
    expect.soft(imported.turnEvents).toHaveLength(1);

    const importedThread = imported.threads[0];
    const importedTurn = imported.turns?.[0];
    const importedRevisions = imported.itemRevisions ?? [];
    const importedArtifact = imported.artifacts?.[0];
    const importedSession = imported.agentSessions?.[0];
    const importedEventEntry = imported.turnEvents?.[0];

    if (
      importedThread &&
      importedTurn &&
      importedRevisions.length === 7 &&
      importedArtifact &&
      importedSession &&
      importedEventEntry
    ) {
      const [importedTurnId, [importedSessionEvent, importedArtifactEvent, importedApprovalEvent]] =
        importedEventEntry;
      const importedFirstRevision = importedRevisions[0]!;
      const importedArtifactItem = importedRevisions[1]!;
      const importedApprovalItem = importedRevisions[2]!;
      const importedCurrentItem = importedRevisions[3]!;
      const importedUserMessageItem = importedRevisions[4]!;
      const importedUserInputRequestItem = importedRevisions[5]!;
      const importedUserInputResponseItem = importedRevisions[6]!;

      expect.soft(importedThread.id).not.toBe(thread.id);
      expect.soft(importedTurn.id).not.toBe(turn.id);
      expect.soft(importedFirstRevision.id).not.toBe(firstItemRevision.id);
      expect.soft(importedArtifact.id).not.toBe(artifact.id);
      expect.soft(importedSession.id).not.toBe(agentSession.id);
      expect.soft(importedTurn).toMatchObject({
        workspaceId: targetWorkspaceId,
        threadId: importedThread.id,
        agentSessionId: null,
        humanGate: { itemId: importedApprovalItem.id },
        triggerActor: localActor,
        items: [
          importedCurrentItem,
          importedArtifactItem,
          importedApprovalItem,
          importedUserMessageItem,
          importedUserInputRequestItem,
          importedUserInputResponseItem,
        ],
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
          'user-message',
          'user-input-request',
          'user-input-response',
        ]);
      expect.soft(importedCurrentItem.id).toBe(importedFirstRevision.id);
      expect.soft(importedArtifactItem).toMatchObject({
        parentItemId: importedCurrentItem.id,
        artifactId: importedArtifact.id,
        artifactVersion: importedArtifact.version,
      });
      expect.soft(importedUserMessageItem).toMatchObject({
        type: 'user-message',
        actor: localActor,
      });
      expect.soft(importedUserInputRequestItem).toMatchObject({
        type: 'user-input-request',
        responsibleUserId: localActor.id,
      });
      expect.soft(importedUserInputResponseItem).toMatchObject({
        type: 'user-input-response',
        actor: localActor,
        causationId: userInputResponseRequestId,
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
        agentSessions: [{ id: importedSession.id }],
      });
    }

    const unresolvedRoot = freshExportRoot('openkit-workspace-history-unresolved-writer-');
    const unresolvedItems = turn.items.filter((item) => item.type !== 'user-input-response');
    const unresolvedRevisions = exportInput.itemRevisions.filter(
      (item) => item.type !== 'user-input-response'
    );

    expect(() =>
      writeWorkspaceExportTree({
        ...exportInput,
        exportRoot: unresolvedRoot,
        exportId: 'wsexp_history_unresolved',
        turns: [{ ...turn, items: unresolvedItems }],
        itemRevisions: unresolvedRevisions,
      })
    ).toThrow(new RegExp(userInputRequestItem.id));
    expect(existsSync(unresolvedRoot)).toBe(false);

    const itemPath = 'records/item-revisions.jsonl';
    const unresolvedItemText = withoutUserInputResponses(exported.fileContents.get(itemPath)!);
    const unresolvedFileContents = new Map(exported.fileContents);

    unresolvedFileContents.set(itemPath, unresolvedItemText);
    expect(() =>
      readWorkspaceImportSnapshot({
        verified: { ...exported, fileContents: unresolvedFileContents },
        targetWorkspaceId: 'ws_unresolved_import_target',
      })
    ).toThrow(new RegExp(userInputRequestItem.id));

    const manifestPath = join(root, WORKSPACE_EXPORT_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const itemEntry = manifest.contentInventory.find(
      (candidate: { path: string }) => candidate.path === itemPath
    );

    writeFileSync(join(root, itemPath), unresolvedItemText);
    itemEntry.bytes = Buffer.byteLength(unresolvedItemText);
    itemEntry.digest = `sha256:${createHash('sha256').update(unresolvedItemText).digest('hex')}`;
    manifest.contentDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify(manifest.contentInventory))
      .digest('hex')}`;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyWorkspaceExportTree({ exportRoot: root })).toThrow(
      new RegExp(userInputRequestItem.id)
    );

    const invalidRoot = freshExportRoot('openkit-workspace-history-invalid-');
    expect(() => {
      writeWorkspaceExportTree({
        ...exportInput,
        exportRoot: invalidRoot,
        exportId: 'wsexp_history_invalid',
        artifacts: [
          {
            ...artifact,
            turnId: 'tu_stale',
            origin: { ...artifact.origin, turnId: 'tu_stale' },
          },
        ],
      });
      readImportSnapshot(invalidRoot, targetWorkspaceId);
    }).toThrow(`Artifact ${artifact.id} has invalid artifact-reference lineage.`);

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
      agentSessions: [],
      turnEvents: [],
    });
    const turn = store.createTurn(
      fixture.workspace.id,
      fixture.thread.id,
      'Retain full history',
      localActor
    );
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

  it('round-trips private Material and Review owners through the workspace endpoints', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-material-review-export-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const now = Date.parse(timestamp);
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind
        ) VALUES (?, ?, ?, false, ?, ?, 'human')`
      )
      .run(LOCAL_USER_ID, 'Local user', 'local@example.com', now, now);
    const fixture = createDemoWorkspaceForUser(LOCAL_USER_ID);
    const store = new FsStore({ dataRoot });
    store.importWorkspaceSnapshot({
      workspace: fixture.workspace,
      threads: [fixture.thread],
      turns: [],
      knowledge: [],
      itemRevisions: [],
      artifacts: [],
      agentSessions: [],
      turnEvents: [],
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: LOCAL_USER_ID,
      workspaceId: fixture.workspace.id,
      now: new Date(timestamp),
    });
    const turn = store.createTurn(
      fixture.workspace.id,
      fixture.thread.id,
      'Create review output',
      localActor
    );
    const workspaceDb = openWorkspaceDb(dataRoot, fixture.workspace.id);
    applyScopedMigrations(workspaceDb);
    const material = createWorkspaceMaterial(workspaceDb, {
      acceptedAt: timestamp,
      actorId: LOCAL_USER_ID,
      kind: 'markdown',
      requestId: 'request-material-export',
      sensitivity: 'internal',
      title: 'Portable material',
    });
    const baseContent = '# Base material\n';
    const baseContentDigest = `sha256:${createHash('sha256').update(baseContent).digest('hex')}`;
    saveWorkspaceMaterialRevision(workspaceDb, {
      acceptedAt: timestamp,
      actorId: LOCAL_USER_ID,
      content: baseContent,
      contentDigest: baseContentDigest,
      expectedRevisionId: null,
      materialId: material.materialId,
      requestId: 'request-material-revision-export',
    });
    bindThreadMaterial(workspaceDb, {
      acceptedAt: timestamp,
      expectedBindingState: 'not_bound',
      materialId: material.materialId,
      requestId: 'request-material-binding-export',
      threadId: fixture.thread.id,
    });
    const artifactContent = '# Proposed material\n';
    const artifactDigest = `sha256:${createHash('sha256').update(artifactContent).digest('hex')}`;
    const artifact = store.createArtifact({
      id: 'art_material_review_export',
      workspaceId: fixture.workspace.id,
      threadId: fixture.thread.id,
      turnId: turn.id,
      kind: 'report',
      title: 'Portable review',
      status: 'ready',
      summary: null,
      version: 1,
      content: { body: artifactContent, format: 'markdown' },
      contentDigest: artifactDigest,
      lastMutationRequestId: 'request-artifact-export',
      origin: {
        kind: 'turn-output',
        requestId: 'request-artifact-export',
        threadId: fixture.thread.id,
        turnId: turn.id,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    createArtifactReview(workspaceDb, {
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      contentDigest: artifact.contentDigest,
      sourceAgentId: null,
      sourceThreadId: fixture.thread.id,
      sourceTurnId: turn.id,
      materialProposal: null,
      createdAt: timestamp,
    });
    workspaceDb.sqlite.close();

    const app = createApp({ coreDb, dataRoot, store });
    const response = await app.request(`/api/app/workspaces/${fixture.workspace.id}/export`, {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const { exportId } = (await response.json()) as { exportId: string };
    const importResponse = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: fixture.workspace.id,
        exportId,
        requestId: '00000000-0000-4000-8000-000000000051',
      }),
    });
    const importResponseText = await importResponse.text();
    expect(importResponse.status, importResponseText).toBe(200);
    const { importedWorkspaceId } = JSON.parse(importResponseText) as {
      importedWorkspaceId: string;
    };
    const importedWorkspaceDb = openWorkspaceDb(dataRoot, importedWorkspaceId);
    try {
      expect(
        importedWorkspaceDb.sqlite
          .prepare(
            `SELECT
              (SELECT COUNT(*) FROM workspace_materials) AS materials,
              (SELECT COUNT(*) FROM workspace_material_revisions) AS revisions,
              (SELECT COUNT(*) FROM thread_material_bindings) AS bindings,
              (SELECT COUNT(*) FROM artifact_reviews) AS reviews`
          )
          .get()
      ).toEqual({ materials: 1, revisions: 1, bindings: 1, reviews: 1 });
    } finally {
      importedWorkspaceDb.sqlite.close();
    }

    const reExportResponse = await app.request(
      `/api/app/workspaces/${importedWorkspaceId}/export`,
      { method: 'POST' }
    );
    expect(reExportResponse.status).toBe(200);
    const { exportId: reExportId } = (await reExportResponse.json()) as { exportId: string };
    const secondImportResponse = await app.request('/api/app/workspace-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceWorkspaceId: importedWorkspaceId,
        exportId: reExportId,
        requestId: '00000000-0000-4000-8000-000000000052',
      }),
    });
    expect(secondImportResponse.status).toBe(200);
    coreDb.sqlite.close();
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
        fileCount: 18,
        checkedFiles: [
          'records/agent-sessions.jsonl',
          'records/artifact-reviews.jsonl',
          'records/item-revisions.jsonl',
          'records/knowledge-claims.jsonl',
          'records/knowledge-conflicts.jsonl',
          'records/knowledge-observations.jsonl',
          'records/knowledge-retrieval-traces.jsonl',
          'records/knowledge.jsonl',
          'records/thread-material-bindings.jsonl',
          'records/threads.jsonl',
          'records/turn-events.jsonl',
          'records/turns.jsonl',
          'records/vault-injection-plans.jsonl',
          'records/vault-injection-receipts.jsonl',
          'records/workspace-material-revisions.jsonl',
          'records/workspace-materials.jsonl',
          'records/workspace-record.json',
          'workspace-files/config/workspace.jsonc',
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
    const workspacePath = join(root, 'records', 'workspace-record.json');
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
      (entry) => entry.path === 'records/workspace-record.json'
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
      'Unsupported requiredFeatures in records/workspace-record.json: workspace.record.future'
    );
  });

  it('rejects unknown runtime provenance features at the record boundary', () => {
    const root = freshExportRoot('openkit-workspace-import-provenance-feature-');
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
          id: 'evb_runtime_provenance',
          workspaceId: 'ws_demo',
          threadId: null,
          goalId: null,
          turnId: null,
          agentSessionId: null,
          backendType: 'openshell',
          sourceKind: 'worker-runtime-provenance-index',
          summary: 'Portable runtime provenance index.',
          rawEvidenceRefs: [],
          redactedEvidenceRefs: [
            { kind: 'worker-runtime-provenance-index', ref: 'runtime-origin-index.jsonl' },
          ],
          contentDigests: ['sha256:provenance'],
          retentionClass: 'turn-evidence',
          sensitivityClass: 'product-safe',
          importStatus: 'promoted',
          requiredFeatures: [
            'evidence.bundle.v1',
            'worker.runtime-provenance.v1',
            'worker.runtime-provenance.future',
          ],
          createdAt: timestamp,
        },
      ],
    });

    expect(() => readImportSnapshot(root, 'ws_imported_demo')).toThrow(
      'Unsupported requiredFeatures in records/evidence-bundles.jsonl:1: worker.runtime-provenance.future'
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
    const workspacePath = join(root, 'records', 'workspace-record.json');
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
      (entry) => entry.path === 'records/workspace-record.json'
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
          responsibleUserId: 'user_1',
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

  it.each([
    'records/workspace-sync-evidence-bundles.jsonl',
    'records/knowledge-context-package-traces.jsonl',
    'records/knowledge-proposals.jsonl',
    'records/knowledge-proposal-reviews.jsonl',
  ] as const)('rejects removed export record %s on import', (removedPath) => {
    const root = freshExportRoot('openkit-workspace-import-removed-record-');
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
    const removedContent = `${JSON.stringify({ id: 'removed_import', workspaceId: 'ws_demo' })}\n`;
    writeFileSync(join(root, removedPath), removedContent);
    const manifestPath = join(root, WORKSPACE_EXPORT_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      contentDigest: string;
      contentInventory: Array<{ path: string; digest: string; bytes: number }>;
    };
    manifest.contentInventory.push({
      path: removedPath,
      digest: `sha256:${createHash('sha256').update(removedContent).digest('hex')}`,
      bytes: Buffer.byteLength(removedContent),
    });
    manifest.contentInventory.sort((left, right) => left.path.localeCompare(right.path));
    manifest.contentDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify(manifest.contentInventory))
      .digest('hex')}`;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() => readImportSnapshot(root, 'ws_imported_demo')).toThrow(
      `Unsupported workspace export record path: ${removedPath}`
    );
  });

  it('exports and imports redacted worker setup evidence rows', () => {
    const agentSetup = createTestAgentSetup();
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
      triggerActor: localActor,
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
          logicalModelId: agentSetup.logicalModels.preferredLogicalModelId,
          runtimeKind: 'codex',
          runtimeAdapter: 'codex-app-server',
          requiredFeatures: ['knowledge.read'],
          setup: {
            manifest: {
              id: agentSetup.manifest.id,
              requiredFeatures: ['knowledge.read'],
              runtime: agentSetup.manifest.runtime,
              sandbox: {
                credentialDeclarations: agentSetup.manifest.sandbox.credentialDeclarations,
                network: agentSetup.manifest.sandbox.network,
              },
            },
            logicalModels: {
              preferredLogicalModelId: agentSetup.logicalModels.preferredLogicalModelId,
              allowed: agentSetup.logicalModels.allowed.map((model) => ({
                id: model.id,
                capabilities: model.capabilities,
                modelFamilyId: model.modelFamilyId,
              })),
            },
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
          manifest: expect.objectContaining({ id: 'agent_codex_host' }),
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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

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
          table: 'pending_user_turn_records',
          reason: 'active Goal steering delivery proof is local to the source workspace',
        },
        {
          table: 'steering_terminal_outcomes',
          reason: 'terminal Goal steering command proof is local to the source workspace',
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
