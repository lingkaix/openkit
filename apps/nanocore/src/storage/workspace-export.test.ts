import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchivedGitPushRecordSchema } from '@openkit/app-api-schemas';
import { deriveEntityId, isEntityId, PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createArtifactReview } from '../artifact-reviews.js';
import { FsStore } from '../lib/store.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createDemoWorkspaceForUser } from '../test-support/demo-store.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from '../test-support/local-user.js';
import { notebookImportFixture } from '../test-support/notebook-import.js';
import { operationRequest } from '../test-support/operation-request.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import {
  bindThreadMaterial,
  createWorkspaceMaterial,
  saveWorkspaceMaterialRevision,
} from '../workspace-materials.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
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
import {
  readWorkspacePortableFileState,
  writeWorkspacePortableFileState,
} from './workspace-portable-file-state.js';

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
      retrievalTraceFiles: new Map(),
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
    targetServerId: 'server_test_target',
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
  recordText: string = '{"id":"ws_00000000-0000-7000-8000-000000000001"}'
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
      id: 'wsexp_00000000-0000-7569-b23e-40ca1402f214',
      ownerScope: 'workspace',
      lineage: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      createdAt: timestamp,
      updatedAt: timestamp,
      contentDigest: `sha256:${createHash('sha256')
        .update(JSON.stringify(contentInventory))
        .digest('hex')}`,
      redactionLevel: 'metadata',
      sensitivity: 'internal',
      requiredFeatures: [],
      extensions: {},
      sourceDeploymentId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      exportCreatedAt: timestamp,
      exportFormatVersion: 3,
      contentInventory,
    })
  );

  return root;
}

describe('workspace export verifier', () => {
  it('verifies manifest shape and inventory file digests offline', () => {
    const verified = verifyWorkspaceExportTree({ exportRoot: writeExportTree() });

    expect(verified.manifest.workspaceId).toBe('ws_00000000-0000-7000-8000-000000000001');
    expect(verified.checkedFiles).toEqual(['records/workspace-record.json']);
  });

  it.each([
    false,
    true,
  ])('rejects exact inventory annotations with covering digest %s', (coversAddition) => {
    const root = writeExportTree();
    const path = join(root, WORKSPACE_EXPORT_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    verifyWorkspaceExportTree({ exportRoot: root });
    manifest.contentInventory[0].annotation = 'inert';
    if (coversAddition)
      manifest.contentDigest = `sha256:${createHash('sha256').update(JSON.stringify(manifest.contentInventory)).digest('hex')}`;
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => verifyWorkspaceExportTree({ exportRoot: root })).toThrow(/Unrecognized key/);
  });

  it('verifies the original serialized inventory ordering before projecting known fields', () => {
    const root = writeExportTree();
    const path = join(root, WORKSPACE_EXPORT_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const entry = manifest.contentInventory[0];
    manifest.contentInventory = [{ bytes: entry.bytes, digest: entry.digest, path: entry.path }];
    manifest.contentDigest = `sha256:${createHash('sha256').update(JSON.stringify(manifest.contentInventory)).digest('hex')}`;
    writeFileSync(path, JSON.stringify(manifest));
    expect(verifyWorkspaceExportTree({ exportRoot: root }).manifest.contentDigest).toBe(
      manifest.contentDigest
    );
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(manifest));
  });

  it('rejects tampered or extra files', () => {
    const tamperedRoot = writeExportTree();
    const tamperedPath = join(tamperedRoot, 'records', 'workspace-record.json');
    const tamperedBytes = readFileSync(tamperedPath);
    tamperedBytes[0] = tamperedBytes[0]! ^ 1;
    writeFileSync(tamperedPath, tamperedBytes);

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
    'records/knowledge-retrieval-traces.jsonl',
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
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      operation: 'create',
      knowledgePageId: 'portable/export-exclusion',
      canonicalPageBytes,
      contentDigest,
      sourceReferences: ['turn:tu_00000000-0000-72a5-8d51-50bb4c19b084'],
      rationale: 'Proposal authority remains local to its source Workspace.',
      confidence: 1,
      producer: localActor,
      createdAt: timestamp,
    } as const;
    const reviewRequestId = '00000000-0000-4000-8000-00000000a701';
    const exported = writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      createdAt: timestamp,
      workspace: {
        id: 'ws_00000000-0000-7000-8000-000000000001',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        counts: { threadCount: 1, artifactCount: 0, knowledgeEntryCount: 1 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [
        {
          id: 'th_00000000-0000-7000-8000-000000000001',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          name: 'Demo thread',
          preview: 'Demo thread',
          status: 'active',
          entryPath: 'conversation',
          visibility: 'workspace',
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
          reviewId: deriveEntityId('kr', {
            ownerScope: { kind: 'workspace', workspaceId: proposal.workspaceId },
            proposalId: proposal.id,
            requestId: reviewRequestId,
          }),
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
      workspaceMaterials: [
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          materialId: 'mat_00000000-0000-73c9-9f22-f7782f4c52a3',
        },
      ],
      workspaceMaterialRevisions: [
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          materialId: 'mat_00000000-0000-73c9-9f22-f7782f4c52a3',
          revisionId: 'mrev_00000000-0000-714f-b6fc-6eab4a9755a9',
        },
      ],
      threadMaterialBindings: [
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          materialId: 'mat_00000000-0000-73c9-9f22-f7782f4c52a3',
        },
      ],
      agentSessions: [],
      turnEvents: [],
      workspaceQuarantineRecords: [
        {
          id: 'wqr_1',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      'records/agent-resource-catalog.json',
      'records/agent-sessions.jsonl',
      'records/artifact-reviews.jsonl',
      'records/item-revisions.jsonl',
      'records/knowledge-claims.jsonl',
      'records/knowledge-conflicts.jsonl',
      'records/knowledge-observations.jsonl',
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
    ).toMatchObject({ id: 'wqr_1', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' });
    expect(
      JSON.parse(readFileSync(join(root, 'records', 'workspace-materials.jsonl'), 'utf8').trim())
    ).toEqual({
      materialId: 'mat_00000000-0000-73c9-9f22-f7782f4c52a3',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    expect(existsSync(join(root, 'records', 'workspace-sync-evidence-bundles.jsonl'))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(root, 'records', 'workspace-record.json'), 'utf8'))
    ).toMatchObject({
      id: 'ws_00000000-0000-7000-8000-000000000001',
    });
    expect(verifyWorkspaceExportTree({ exportRoot: root }).manifest).toMatchObject({
      requiredFeatures: ['agent.resource-catalog.v1'],
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
  });

  it('remints each import independently while preserving the complete history reference graph', () => {
    const root = freshExportRoot('openkit-workspace-history-export-');
    const targetWorkspaceId = 'ws_00000000-0000-7ec3-acba-f55eebcacc35';
    const workspace = {
      id: 'ws_00000000-0000-71b1-9af2-985861a05396',
      name: 'History workspace',
      kind: 'general',
      status: 'active',
      counts: { threadCount: 3, artifactCount: 1, knowledgeEntryCount: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const thread = {
      id: 'th_00000000-0000-76e4-9cab-bf0f18349249',
      workspaceId: workspace.id,
      name: 'History thread',
      preview: 'Canonical history',
      status: 'active',
      entryPath: 'conversation',
      visibility: 'workspace',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const receivingThread = {
      ...thread,
      id: 'th_01890f3e-0000-7000-8000-000000000002',
      name: 'Receiving history',
      parentThreadId: thread.id,
    };
    const unresolvedParentId = 'th_01890f3e-0000-7000-8000-000000000004';
    const unresolvedThread = {
      ...thread,
      id: 'th_01890f3e-0000-7000-8000-000000000003',
      name: 'Unresolved source lineage',
      parentThreadId: unresolvedParentId,
    };
    const firstItemRevision = {
      id: 'it_00000000-0000-7cab-8553-ff29f1f63940',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: 'tu_00000000-0000-72a5-8d51-50bb4c19b084',
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
      retainedStorage: {
        storageRef: 'wst_00000000-0000-7ac8-9f6c-13552db6aa87',
        workSlotRef: 'slot-source',
      },
      id: 'as_00000000-0000-7d81-8a02-21a51fa74819',
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
      id: 'ar_00000000-0000-7e0d-8050-96f36ec9a01f',
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
      id: 'it_00000000-0000-75b1-b567-8dba93fffe22',
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
      id: 'it_00000000-0000-72f3-8907-3b2acee786c0',
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
      id: 'it_00000000-0000-7af0-a35f-2d6dbcf53c85',
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
      id: 'it_00000000-0000-7695-a7a1-7f48f8a3702c',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: firstItemRevision.turnId,
      type: 'user-input-response',
      actor: localActor,
      causationId: userInputResponseRequestId,
      status: 'completed',
      userInputRequestId: userInputRequestItem.userInputRequestId,
      answers: { question_portable: ['Yes'] as [string] },
      answeredAt: timestamp,
      createdAt: timestamp,
      completedAt: timestamp,
    } as const;
    expect(
      listUnresolvedUserInputRequestItemIds([
        userInputRequestItem,
        {
          ...userInputResponseItem,
          actor: { kind: 'user', id: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' },
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
      status: 'running',
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
      exportId: 'wsexp_00000000-0000-743a-9531-8ebe42619a57',
      sourceDeploymentId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
      createdAt: timestamp,
      workspace,
      threads: [receivingThread, thread, unresolvedThread],
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

    expect
      .soft(exported.checkedFiles)
      .toContain('artifacts/ar_00000000-0000-7e0d-8050-96f36ec9a01f/artifact.json');
    expect
      .soft(exported.checkedFiles)
      .toContain('artifacts/ar_00000000-0000-7e0d-8050-96f36ec9a01f/files/content.md');
    expect.soft(artifactMetadata).toEqual({
      ...artifact,
      content: { format: artifact.content.format },
    });
    expect.soft(JSON.stringify(artifactMetadata)).not.toContain(artifact.content.body);
    expect.soft(readFileSync(artifactBodyPath, 'utf8')).toBe(artifact.content.body);
    expect.soft(verifyWorkspaceExportTree({ exportRoot: root })).toEqual(exported);

    const snapshot = readImportSnapshot(root, targetWorkspaceId);
    const imported = snapshot as unknown as {
      threads: Array<typeof thread & { parentThreadId?: string }>;
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

    const importedParent = imported.threads.find((candidate) => candidate.name === thread.name)!;
    const importedChild = imported.threads.find(
      (candidate) => candidate.name === receivingThread.name
    )!;
    const importedUnresolved = imported.threads.find(
      (candidate) => candidate.name === unresolvedThread.name
    )!;
    expect(imported.threads).toHaveLength(3);
    expect(importedChild.parentThreadId).toBe(importedParent.id);
    expect(importedChild.parentThreadId).not.toBe(thread.id);
    expect(importedUnresolved.parentThreadId).toBe(unresolvedParentId);
    expect(imported.threads.some((candidate) => candidate.id === unresolvedParentId)).toBe(false);
    expect(snapshot.workspace.importedFrom?.sourceWorkspaceId).toBe(workspace.id);
    expect.soft(imported.turns).toHaveLength(1);
    expect.soft(imported.itemRevisions).toHaveLength(7);
    expect.soft(imported.artifacts).toHaveLength(1);
    expect.soft(imported.agentSessions).toHaveLength(1);
    expect(readFileSync(join(root, 'records/agent-sessions.jsonl'), 'utf8')).not.toContain('wst_');
    expect(imported.agentSessions[0]).toHaveProperty('retainedStorage', null);
    expect.soft(imported.turnEvents).toHaveLength(1);

    const importedThread = imported.threads.find((candidate) => candidate.name === thread.name);
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
        status: 'running',
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
      const previous = {
        th: imported.threads.map((candidate) => candidate.id),
        tu: [importedTurn.id],
        ar: [importedArtifact.id],
        as: [importedSession.id],
        it: importedRevisions.map((item) => item.id),
      };
      const next = {
        th: repeated.threads.map((entry) => entry.id),
        tu: repeated.turns.map((entry) => entry.id),
        ar: repeated.artifacts.map((entry) => entry.id),
        as: repeated.agentSessions.map((entry) => entry.id),
        it: repeated.itemRevisions.map((entry) => entry.id),
      };
      for (const kind of ['th', 'tu', 'ar', 'as', 'it'] as const) {
        expect.soft(next[kind]).toHaveLength(previous[kind].length);
        expect.soft(next[kind].every((id) => isEntityId(kind, id))).toBe(true);
        expect.soft(next[kind].every((id) => !previous[kind].includes(id))).toBe(true);
      }
      expect
        .soft(repeated.turns[0]!.threadId)
        .toBe(repeated.threads.find((candidate) => candidate.name === thread.name)!.id);
      expect
        .soft(
          repeated.threads.find((candidate) => candidate.name === receivingThread.name)!
            .parentThreadId
        )
        .toBe(repeated.turns[0]!.threadId);
      expect
        .soft(
          repeated.threads.find((candidate) => candidate.name === unresolvedThread.name)!
            .parentThreadId
        )
        .toBe(unresolvedParentId);
      expect.soft(repeated.artifacts[0]!.turnId).toBe(repeated.turns[0]!.id);
      expect.soft(repeated.agentSessions[0]!.threadId).toBe(repeated.turns[0]!.threadId);
      expect
        .soft(
          new Set(
            repeated.itemRevisions
              .filter((item) => item.type === 'assistant-message')
              .map((item) => item.id)
          ).size
        )
        .toBe(1);
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
        exportId: 'wsexp_00000000-0000-7b57-ae1f-cd70a99553d1',
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
        targetWorkspaceId: 'ws_00000000-0000-7c16-af81-224a86d87d76',
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
        exportId: 'wsexp_00000000-0000-74f0-9b7a-9816422cbe75',
        artifacts: [
          {
            ...artifact,
            turnId: 'tu_00000000-0000-78f5-884c-f2d747d2d666',
            origin: { ...artifact.origin, turnId: 'tu_00000000-0000-78f5-884c-f2d747d2d666' },
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
        exportId: 'wsexp_00000000-0000-72fa-9618-ee266cf41c0d',
        turns: [{ ...turn, items: [firstItemRevision, artifactItem, approvalItem] }],
      })
    ).toThrow('Turn items must equal the latest canonical item revisions.');

    const reorderedItemsRoot = freshExportRoot('openkit-workspace-history-reordered-items-');
    expect(() =>
      writeWorkspaceExportTree({
        ...exportInput,
        exportRoot: reorderedItemsRoot,
        exportId: 'wsexp_00000000-0000-7292-b1af-04a26a6a9d15',
        turns: [{ ...turn, items: [artifactItem, currentItem, approvalItem] }],
      })
    ).toThrow(/Turn items/);
  });

  it('exports full turn event history after the in-memory replay window rolls over', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-event-history-export-'));
    const fixture = createDemoWorkspaceForUser(LOCAL_USER_ID);
    const store = new FsStore({ dataRoot });
    store.importWorkspaceSnapshot({
      ...notebookImportFixture({ workspaceId: fixture.workspace.id, knowledge: fixture.knowledge }),
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

    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: fixture.workspace.id,
    });
    const response = await createApp({ coreDb, dataRoot, store }).request(
      ...operationRequest(
        'workspace.export',
        { workspaceId: fixture.workspace.id },
        { method: 'POST' }
      )
    );
    expect.soft(response.status).toBe(200);
    const responseText = await response.text();
    if (response.status === 200) {
      const body = JSON.parse(responseText) as { exportId: string };
      const imported = readImportSnapshot(
        join(dataRoot, 'server', 'exports', 'workspaces', fixture.workspace.id, body.exportId),
        'ws_00000000-0000-7340-b235-ccdf7acf0cac'
      );
      expect(imported.turnEvents[0]?.[1].map((event) => event.sequence)).toEqual(
        Array.from({ length: 101 }, (_, index) => index + 1)
      );
    }
    coreDb.sqlite.close();
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
        ) VALUES (?, ?, ?, false, ?, ?, 'local')`
      )
      .run(LOCAL_USER_ID, 'Local user', 'local@example.com', now, now);
    const fixture = createDemoWorkspaceForUser(LOCAL_USER_ID);
    const store = new FsStore({ dataRoot });
    store.importWorkspaceSnapshot({
      ...notebookImportFixture({ workspaceId: fixture.workspace.id, knowledge: [] }),
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
      actor: { kind: 'user', id: LOCAL_USER_ID },
      kind: 'markdown',
      requestId: 'request-material-export',
      sensitivity: 'internal',
      title: 'Portable material',
    });
    const baseContent = '# Base material\n';
    const baseContentDigest = `sha256:${createHash('sha256').update(baseContent).digest('hex')}`;
    saveWorkspaceMaterialRevision(workspaceDb, {
      acceptedAt: timestamp,
      actor: { kind: 'user', id: LOCAL_USER_ID },
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
    // Revision identity is scoped to its Material. A portable graph can contain
    // the same canonical revision ID beneath two distinct Material owners.
    const secondMaterial = createWorkspaceMaterial(workspaceDb, {
      acceptedAt: timestamp,
      actor: localActor,
      kind: 'markdown',
      requestId: 'request-second-material-export',
      sensitivity: 'internal',
      title: 'Second portable material',
    });
    const sourceRevisionId = (
      workspaceDb.sqlite
        .prepare('SELECT current_revision_id AS id FROM workspace_materials WHERE material_id = ?')
        .get(material.materialId) as { id: string }
    ).id;
    workspaceDb.sqlite
      .prepare(`INSERT INTO workspace_material_revisions
      SELECT workspace_id, ?, revision_id, parent_revision_id, media_type,
        content_digest, content, author_id, ?, created_at
      FROM workspace_material_revisions WHERE material_id = ?`)
      .run(secondMaterial.materialId, 'second-source-revision', material.materialId);
    workspaceDb.sqlite
      .prepare(
        'UPDATE workspace_materials SET current_revision_id = ?, last_mutation_request_id = ? WHERE material_id = ?'
      )
      .run(sourceRevisionId, 'second-source-revision', secondMaterial.materialId);
    const secondMaterialThread = store.createThread(
      fixture.workspace.id,
      'Second material binding'
    );
    bindThreadMaterial(workspaceDb, {
      acceptedAt: timestamp,
      expectedBindingState: 'not_bound',
      materialId: secondMaterial.materialId,
      requestId: 'request-second-material-binding-export',
      threadId: secondMaterialThread.id,
    });
    const artifactContent = '# Proposed material\n';
    const artifactDigest = `sha256:${createHash('sha256').update(artifactContent).digest('hex')}`;
    const artifact = store.createArtifact({
      id: 'ar_00000000-0000-7bb4-a6cd-48b4189a9712',
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
    const response = await app.request(
      ...operationRequest(
        'workspace.export',
        { workspaceId: fixture.workspace.id },
        {
          method: 'POST',
        }
      )
    );
    expect(response.status).toBe(200);
    const { exportId } = (await response.json()) as { exportId: string };
    const importResponse = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: fixture.workspace.id,
            exportId,
            requestId: '00000000-0000-4000-8000-000000000051',
          }),
        }
      )
    );
    const importResponseText = await importResponse.text();
    expect(importResponse.status, importResponseText).toBe(200);
    const { importedWorkspaceId } = JSON.parse(importResponseText) as {
      importedWorkspaceId: string;
    };
    const importedWorkspaceDb = openWorkspaceDb(dataRoot, importedWorkspaceId);
    let firstImportedRevisionIds: string[] = [];
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
      ).toEqual({ materials: 2, revisions: 2, bindings: 2, reviews: 1 });
      const revisions = importedWorkspaceDb.sqlite
        .prepare(`SELECT
        material_id AS materialId, revision_id AS revisionId
        FROM workspace_material_revisions ORDER BY material_id`)
        .all() as {
        materialId: string;
        revisionId: string;
      }[];
      expect(new Set(revisions.map((row) => row.materialId)).size).toBe(2);
      firstImportedRevisionIds = revisions.map((row) => row.revisionId);
      expect(new Set(firstImportedRevisionIds).size).toBe(2);
      for (const row of revisions) {
        expect(isEntityId('mat', row.materialId)).toBe(true);
        expect(isEntityId('mrev', row.revisionId)).toBe(true);
        expect(row.materialId).not.toBe(material.materialId);
        expect(row.materialId).not.toBe(secondMaterial.materialId);
        expect(row.revisionId).not.toBe(sourceRevisionId);
        expect(
          importedWorkspaceDb.sqlite
            .prepare(`SELECT current_revision_id AS revisionId
          FROM workspace_materials WHERE material_id = ?`)
            .get(row.materialId)
        ).toEqual({
          revisionId: row.revisionId,
        });
        expect(
          importedWorkspaceDb.sqlite
            .prepare(`SELECT latest_queued_revision_id AS revisionId
          FROM thread_material_bindings WHERE material_id = ?`)
            .get(row.materialId)
        ).toEqual({
          revisionId: row.revisionId,
        });
      }
    } finally {
      importedWorkspaceDb.sqlite.close();
    }

    const reExportResponse = await app.request(
      ...operationRequest(
        'workspace.export',
        { workspaceId: importedWorkspaceId },
        { method: 'POST' }
      )
    );
    expect(reExportResponse.status).toBe(200);
    const { exportId: reExportId } = (await reExportResponse.json()) as { exportId: string };
    const secondImportResponse = await app.request(
      ...operationRequest(
        'workspace.import',
        {},
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceWorkspaceId: importedWorkspaceId,
            exportId: reExportId,
            requestId: '00000000-0000-4000-8000-000000000052',
          }),
        }
      )
    );
    expect(secondImportResponse.status).toBe(200);
    const secondTarget = (await secondImportResponse.json()) as { importedWorkspaceId: string };
    const secondDb = openWorkspaceDb(dataRoot, secondTarget.importedWorkspaceId);
    try {
      const rows = secondDb.sqlite
        .prepare('SELECT revision_id AS revisionId FROM workspace_material_revisions')
        .all() as { revisionId: string }[];
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.revisionId)).size).toBe(2);
      for (const row of rows) {
        expect(firstImportedRevisionIds).not.toContain(row.revisionId);
        expect(row.revisionId).not.toBe(sourceRevisionId);
      }
    } finally {
      secondDb.sqlite.close();
    }
    coreDb.sqlite.close();
  });

  it('dry-runs workspace import verification and collision preview without mutating', () => {
    const root = freshExportRoot('openkit-workspace-import-dry-run-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      createdAt: timestamp,
      workspace: {
        id: 'ws_00000000-0000-7000-8000-000000000001',
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
        workspaceExists: (workspaceId) => workspaceId === 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).toMatchObject({
      mode: 'dry-run',
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      exportedWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      collision: {
        status: 'collides',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        suggestedWorkspaceId: 'ws_9e57e6ec-74d8-56ed-89aa-baf519ca4af6',
      },
      verification: {
        fileCount: 18,
        checkedFiles: [
          'records/agent-resource-catalog.json',
          'records/agent-sessions.jsonl',
          'records/artifact-reviews.jsonl',
          'records/item-revisions.jsonl',
          'records/knowledge-claims.jsonl',
          'records/knowledge-conflicts.jsonl',
          'records/knowledge-observations.jsonl',
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

  it('remints trace context while retaining foreign Server references as unavailable evidence', () => {
    const root = freshExportRoot('openkit-workspace-server-trace-import-');
    const thread = {
      id: 'th_00000000-0000-7967-a569-efdf670da460',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      name: 'Server trace',
      preview: 'Server trace',
      status: 'active',
      entryPath: 'conversation',
      visibility: 'workspace',
      createdAt: timestamp,
      updatedAt: timestamp,
    } as const;
    const traceId = 'krt_00000000-0000-77c6-84f7-ac86ac6632b2';
    const requestDigest = `sha256:${'8'.repeat(64)}`;
    const sourcePortableRoot = mkdtempSync(
      join(tmpdir(), 'openkit-workspace-server-trace-source-')
    );
    const sourceTracePath = `threads/${thread.id}/retrieval-traces/${traceId}.json`;
    const sourceTrace = {
      traceId,
      query: 'private query annotation',
      futureRootNote: 'private root annotation',
      queryContext: {
        serverId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        actor: {
          kind: 'user',
          id: 'usr_00000000-0000-7431-921d-ea7bcc58a6f2',
          futureActorNote: 'retained',
        },
        threadId: thread.id,
      },
      sourceScope: 'page/server',
      notebookRevision: null,
      caller: 'app-api',
      requestDigest,
      retrievalParameters: {
        limit: 1,
        pinnedReferences: [],
        states: ['active'],
        sourceScope: 'server',
        futureParameterNote: 'private parameter annotation',
      },
      selected: [
        {
          reference: { scopeId: 'page/server', objectId: 'same-path' },
          revision: `sha256:${'9'.repeat(64)}`,
          contentDigest: `sha256:${'9'.repeat(64)}`,
          sourceReferences: [],
          body: 'private body annotation',
          title: 'private title annotation',
          snippet: 'private snippet annotation',
          score: 99,
          futureSelectedNote: 'private selected annotation',
        },
      ],
      excluded: [],
      createdAt: timestamp,
    };
    mkdirSync(join(sourcePortableRoot, 'config'));
    writeFileSync(
      join(sourcePortableRoot, 'config', 'workspace.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        workspace: { name: 'Demo workspace', defaultAgentId: null },
      })
    );
    mkdirSync(join(sourcePortableRoot, 'threads', thread.id, 'retrieval-traces'), {
      recursive: true,
    });
    const sourceTraceText = `${JSON.stringify(sourceTrace)}\n`;
    writeFileSync(join(sourcePortableRoot, sourceTracePath), sourceTraceText);
    const portableFileState = readWorkspacePortableFileState(sourcePortableRoot, {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threads: [{ threadId: thread.id }],
      turns: [],
    });
    const normalizedSourceTrace = [...portableFileState.retrievalTraceFiles.values()][0]!;
    expect(
      (normalizedSourceTrace.queryContext.actor as Record<string, unknown>).futureActorNote
    ).toBeUndefined();
    expect(JSON.stringify(normalizedSourceTrace)).not.toContain('private');
    expect(readFileSync(join(sourcePortableRoot, sourceTracePath), 'utf8')).toBe(sourceTraceText);
    const verified = writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_00000000-0000-7891-af5f-e2a90c3bc344',
      sourceDeploymentId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
      createdAt: timestamp,
      workspace: {
        id: 'ws_00000000-0000-7000-8000-000000000001',
        name: 'Demo workspace',
        kind: 'general',
        status: 'active',
        counts: { threadCount: 1, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [thread],
      turns: [],
      knowledge: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
      portableFileState,
    });
    const imported = readWorkspaceImportSnapshot({
      verified,
      targetWorkspaceId: 'ws_00000000-0000-7b16-81e5-c0b623c0c636',
      targetServerId: 'dep_00000000-0000-7a9d-bc94-7beac17dc657',
    });
    const [path, trace] = [...imported.portableFileState.retrievalTraceFiles][0]!;
    const exportedTraceText = verified.fileContents.get(`workspace-files/${sourceTracePath}`)!;

    expect(imported.workspace.importedFrom?.sourceDeploymentId).toBe(
      'dep_00000000-0000-7737-8fe7-61ca07c79d45'
    );
    for (const annotation of [
      'private query annotation',
      'private root annotation',
      'private parameter annotation',
      'private body annotation',
      'private title annotation',
      'private snippet annotation',
      'private selected annotation',
      'futureActorNote',
    ]) {
      expect(exportedTraceText).not.toContain(annotation);
      expect(JSON.stringify(trace)).not.toContain(annotation);
    }
    expect(path).toBe(`threads/${imported.threads[0]?.id}/retrieval-traces/${traceId}.json`);
    expect(trace).toMatchObject({
      requestDigest,
      queryContext: {
        serverId: 'dep_00000000-0000-7a9d-bc94-7beac17dc657',
        workspaceId: 'ws_00000000-0000-7b16-81e5-c0b623c0c636',
        threadId: imported.threads[0]?.id,
      },
      sourceScope: 'page/server',
      selected: [
        expect.objectContaining({
          reference: { scopeId: 'page/server', objectId: 'same-path' },
        }),
      ],
    });
    expect((trace.queryContext.actor as Record<string, unknown>).futureActorNote).toBeUndefined();
    const targetPortableRoot = mkdtempSync(
      join(tmpdir(), 'openkit-workspace-server-trace-target-')
    );
    writeWorkspacePortableFileState(targetPortableRoot, imported.portableFileState);
    const targetTraceText = readFileSync(join(targetPortableRoot, path), 'utf8');
    expect(targetTraceText).not.toContain('private');
    expect(targetTraceText).not.toContain('futureActorNote');
  });

  it('rejects imported records with unsupported required features', () => {
    const root = freshExportRoot('openkit-workspace-import-record-feature-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      createdAt: timestamp,
      workspace: {
        id: 'ws_00000000-0000-7000-8000-000000000001',
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

    expect(() => readImportSnapshot(root, 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8')).toThrow(
      'Unsupported requiredFeatures in records/workspace-record.json: workspace.record.future'
    );
  });

  it('rejects unknown runtime provenance features at the record boundary', () => {
    const root = freshExportRoot('openkit-workspace-import-provenance-feature-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      createdAt: timestamp,
      workspace: {
        id: 'ws_00000000-0000-7000-8000-000000000001',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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

    expect(() => readImportSnapshot(root, 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8')).toThrow(
      'Unsupported requiredFeatures in records/evidence-bundles.jsonl:1: worker.runtime-provenance.future'
    );
  });

  it('rejects a workspace record owned by another manifest workspace', () => {
    const root = freshExportRoot('openkit-workspace-import-owner-mismatch-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_00000000-0000-78c2-b3d2-ebf10afec64e',
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      createdAt: timestamp,
      workspace: {
        id: 'ws_00000000-0000-7301-8f4e-e88b52a3d73a',
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
      { ...workspaceRecord, id: 'ws_00000000-0000-7c4b-b7f3-2cbedd77782b' },
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

    expect(() => readImportSnapshot(root, 'ws_00000000-0000-70f7-8ccc-f6cfc9b1c728')).toThrow(
      'Workspace record id does not match the export manifest.'
    );
  });

  it('normalizes unknown evidence fields while reading workspace imports', () => {
    const root = freshExportRoot('openkit-workspace-import-evidence-extra-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      createdAt: timestamp,
      workspace: {
        id: 'ws_00000000-0000-7000-8000-000000000001',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: null,
          goalId: null,
          turnId: null,
          agentSessionId: null,
          backendType: null,
          sourceKind: 'manual',
          summary: 'Evidence with future metadata.',
          rawEvidenceRefs: [],
          redactedEvidenceRefs: [
            { kind: 'workspace', ref: 'ws_00000000-0000-7000-8000-000000000001' },
          ],
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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

    const imported = readImportSnapshot(root, 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8');
    expect(JSON.stringify(imported)).not.toContain('futureOptionalNote');
    expect(readImportSnapshot(root, 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8')).toEqual(imported);
  });

  it('normalizes unknown usage ledger fields while reading workspace imports', () => {
    const root = freshExportRoot('openkit-workspace-import-usage-extra-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      createdAt: timestamp,
      workspace: {
        id: 'ws_00000000-0000-7000-8000-000000000001',
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
          id: 'cap_00000000-0000-768a-b60e-361b4ce8bea1',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
          id: 'use_00000000-0000-72bf-9e10-f40598fbe4f3',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          responsibleUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
          threadId: null,
          turnId: null,
          itemId: null,
          capabilityCallId: 'cap_00000000-0000-768a-b60e-361b4ce8bea1',
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

    const imported = readImportSnapshot(root, 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8');
    expect(JSON.stringify(imported)).not.toContain('futureOptionalNote');
    expect(readImportSnapshot(root, 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8')).toEqual(imported);
  });

  it('preserves ordinary archived Git push fixture text through verified bytes and retained reads', () => {
    const root = freshExportRoot('openkit-workspace-import-git-push-extra-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      createdAt: timestamp,
      workspace: {
        id: 'ws_00000000-0000-7000-8000-000000000001',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          repositoryResourceId: 'repo_default',
          approvalRowId: null,
          policyDecisionId: null,
          actorId: 'usr_00000000-0000-7000-8000-000000000001',
          remoteSummary: 'Public fixture ghp_publicFixture on origin',
          sourceRef: 'hf_publicFixture',
          targetBranch: 'sk-Latn',
          commitIds: ['abc123'],
          reviewIds: [],
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

    const imported = readImportSnapshot(root, 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8');
    const bytes = readFileSync(join(root, 'records/git-push-records.jsonl'));
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(imported.gitPushRecords[0]).toMatchObject({
      remoteSummary: 'Public fixture ghp_publicFixture on origin',
      sourceRef: 'hf_publicFixture',
      targetBranch: 'sk-Latn',
    });
    const { requestId: _requestId, ...history } = imported.gitPushRecords[0]!;
    expect(ArchivedGitPushRecordSchema.parse(history)).toEqual(history);
    expect(readFileSync(join(root, 'records/git-push-records.jsonl'))).toEqual(bytes);
    expect(
      createHash('sha256')
        .update(readFileSync(join(root, 'records/git-push-records.jsonl')))
        .digest('hex')
    ).toBe(digest);
    expect(JSON.stringify(imported)).not.toContain('futureOptionalNote');
    expect(readImportSnapshot(root, 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8')).toEqual(imported);
  });

  it('rewrites workspace quarantine records while reading workspace imports', () => {
    const root = freshExportRoot('openkit-workspace-import-quarantine-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      createdAt: timestamp,
      workspace: {
        id: 'ws_00000000-0000-7000-8000-000000000001',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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

    const snapshot = readImportSnapshot(root, 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8');

    expect(snapshot.workspaceQuarantineRecords).toEqual([
      expect.objectContaining({
        id: 'wqr_import',
        workspaceId: 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8',
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
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      createdAt: timestamp,
      workspace: {
        id: 'ws_00000000-0000-7000-8000-000000000001',
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
    const removedContent = `${JSON.stringify({ id: 'removed_import', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' })}\n`;
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

    expect(() => readImportSnapshot(root, 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8')).toThrow(
      `Unsupported workspace export record path: ${removedPath}`
    );
  });

  it('exports and imports redacted worker setup evidence rows', () => {
    const agentSetup = createTestAgentSetup();
    const root = freshExportRoot('openkit-workspace-worker-evidence-');
    const workerThread = {
      id: 'th_00000000-0000-7267-800d-a65e1b6a22d7',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      name: 'Worker evidence thread',
      preview: 'Worker evidence',
      status: 'active',
      entryPath: 'conversation',
      visibility: 'workspace',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const workerTurn = {
      id: 'tu_00000000-0000-7b5c-9add-c4bfc5a04575',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: workerThread.id,
      triggerActor: localActor,
      items: [],
      status: 'completed' as const,
      error: null,
      configVersion: null,
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 1,
    };
    const workerPackage = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId: 'as_00000000-0000-7b98-8803-ea4242ad797b',
      agentSetup,
      backend: { kind: 'openshell' },
      requestId: 'req_1',
      triggerActor: localActor,
      turn: workerTurn,
      turnInput: 'Worker evidence',
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    });
    const workerSession = {
      id: 'as_00000000-0000-7b98-8803-ea4242ad797b',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: workerThread.id,
      status: 'idle',
      message: null,
      sandboxSummary: null,
      configVersion: null,
      environmentPackageSnapshotId: workerPackage.snapshotId,
      policySnapshotId: null,
      sessionCompatibilityKey: null,
      stale: false,
      workspaceRoots: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      createdAt: timestamp,
      workspace: {
        id: 'ws_00000000-0000-7000-8000-000000000001',
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-7b5c-9add-c4bfc5a04575',
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
          snapshotId: workerPackage.snapshotId,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-7b5c-9add-c4bfc5a04575',
          threadId: 'th_00000000-0000-7267-800d-a65e1b6a22d7',
          agentSessionId: 'as_00000000-0000-7b98-8803-ea4242ad797b',
          agentId: 'agent_codex_host',
          packageId: workerPackage.packageId,
          runtimeKind: 'codex',
          backendKind: 'openshell',
          contentDigest: createHash('sha256').update(JSON.stringify(workerPackage)).digest('hex'),
          snapshot: workerPackage,
          createdAt: timestamp,
        },
      ],
    });

    expect(readFileSync(join(root, 'records', 'resolved-agent-setups.jsonl'), 'utf8')).toContain(
      'ras_demo'
    );
    expect(
      readFileSync(join(root, 'records', 'agent-environment-package-snapshots.jsonl'), 'utf8')
    ).toContain(workerPackage.snapshotId);

    const snapshot = readImportSnapshot(root, 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8');

    expect(snapshot.resolvedAgentSetups).toEqual([
      expect.objectContaining({
        id: 'ras_demo',
        workspaceId: 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8',
        turnId: snapshot.turns[0]?.id,
        setup: expect.objectContaining({
          manifest: expect.objectContaining({ id: 'agent_codex_host' }),
        }),
      }),
    ]);
    expect(snapshot.agentEnvironmentPackageSnapshots).toEqual([
      expect.objectContaining({
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        workspaceId: 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8',
        snapshot: expect.objectContaining({
          scope: expect.objectContaining({
            workspaceId: 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8',
            threadId: snapshot.threads[0]?.id,
            turnId: snapshot.turns[0]?.id,
            agentSessionId: snapshot.agentSessions[0]?.id,
          }),
        }),
      }),
    ]);
    expect(snapshot.agentEnvironmentPackageSnapshots[0]!.snapshotId).not.toBe(
      workerPackage.snapshotId
    );
    expect(snapshot.agentEnvironmentPackageSnapshots[0]!.contentDigest).not.toBe('digest_demo');
  });

  it('imports workspace-family capability call rows', () => {
    const root = freshExportRoot('openkit-workspace-capability-family-');
    writeWorkspaceExportTree({
      exportRoot: root,
      exportId: 'wsexp_00000000-0000-7693-ae39-6c3f6020c3c4',
      sourceDeploymentId: 'dep_00000000-0000-7562-9a88-afe7e367ea27',
      createdAt: timestamp,
      workspace: {
        id: 'ws_00000000-0000-7000-8000-000000000001',
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
          id: 'cap_00000000-0000-7e87-a828-c80cc3539f51',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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

    expect(
      readImportSnapshot(root, 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8').capabilityCalls
    ).toEqual([
      expect.objectContaining({
        capabilityId: 'assistant.repository.read',
        family: 'workspace',
        workspaceId: 'ws_00000000-0000-7689-a3f6-ae0b906eb3a8',
      }),
    ]);
  });

  it('keeps workspace sqlite table export coverage explicit', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-coverage-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb);
      const tables = (
        workspaceDb.sqlite
          .prepare(
            `SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'
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
          table: 'pending_requests',
          reason:
            'pending-request lifecycle stays in the workspace database and has no portable export family',
        },
        {
          table: 'workspace_filesystem_staging_roots',
          reason: 'host-local apply staging paths are not portable export history',
        },
        {
          table: 'workspace_snapshot_collections',
          reason:
            'exact collection replay and private candidate bytes belong to the source storage attachment',
        },
        {
          table: 'workspace_snapshot_cursors',
          reason:
            'accepted snapshot and capture cursor require the source storage attachment and private scan store',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});

// This fixture supplies confirmed image evidence; the production resolver and subject checks still run.
vi.mock('../runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    '../test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});
