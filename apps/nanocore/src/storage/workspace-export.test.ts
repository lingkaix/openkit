import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseWorkspaceExportManifest } from '@openkit/config-schema';
import {
  ArtifactVersionRecordSchema,
  AuditEventSchema,
  allocateEntityId,
  deriveEntityId,
  PROTOCOL_VERSION,
  writeRetainedV1,
} from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createArtifactReview, listExportableArtifactReviews } from '../artifact-reviews.js';
import { parseJsoncObject } from '../config/jsonc.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createDemoWorkspaceForUser } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { knowledgePageFixture } from '../test-support/knowledge-page.js';
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
  listExportableWorkspaceMaterialRows,
  saveWorkspaceMaterialRevision,
} from '../workspace-materials.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { publishArtifactVersionRecord } from './artifacts/artifact-version-records.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import {
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
import { readWorkspacePortableFileState } from './workspace-portable-file-state.js';

const timestamp = '2026-07-05T00:00:00.000Z';
const localActor = { kind: 'user', id: LOCAL_USER_ID } as const;
const workspaceKnowledgeBaseId = 'kb_00000000-0000-7000-8000-000000000001';

it('marks exported Thread semantics before an unsupported reader can admit dependent content', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-semantics-export-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  try {
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Portable private Thread');
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
    await store.createThread(workspace.id, 'Private history', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: userId,
    });
    const app = await createApp({ coreDb, dataRoot, store });
    const response = await app.request(
      ...operationRequest('workspace.export', { workspaceId: workspace.id }, { method: 'POST' })
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const { exportId } = (await response.json()) as { exportId: string };
    const manifest = JSON.parse(
      readFileSync(
        join(
          dataRoot,
          'server',
          'exports',
          'workspaces',
          workspace.id,
          exportId,
          WORKSPACE_EXPORT_MANIFEST_FILE
        ),
        'utf8'
      )
    );
    const features = ['openkit.thread-entry.v1', 'openkit.thread-visibility.v1'];
    expect(manifest.requiredFeatures).toEqual(expect.arrayContaining(features));
    for (const missing of features) {
      // The real envelope reader has all other capabilities; this one is absent.
      expect(() =>
        parseWorkspaceExportManifest(manifest, {
          supportedFeatures: manifest.requiredFeatures.filter(
            (feature: string) => feature !== missing
          ),
        })
      ).toThrow(`Unsupported required feature: ${missing}`);
    }
    expect(
      verifyWorkspaceExportTree({
        exportRoot: join(dataRoot, 'server', 'exports', 'workspaces', workspace.id, exportId),
      }).manifest.requiredFeatures
    ).toEqual(manifest.requiredFeatures);

    // A supported manifest cannot authorize unknown semantics on a dependent row.
    const exportRoot = join(dataRoot, 'server', 'exports', 'workspaces', workspace.id, exportId);
    const threadPath = join(exportRoot, 'records', 'threads.jsonl');
    const originalThreads = readFileSync(threadPath, 'utf8').trim().split('\n');
    expect(originalThreads).toHaveLength(1);
    const row = JSON.parse(originalThreads[0]!);
    const threadText = `${JSON.stringify({
      ...row,
      requiredFeatures: [...row.requiredFeatures, 'openkit.thread-visibility.future'],
    })}\n`;
    writeFileSync(threadPath, threadText);
    const entry = manifest.contentInventory.find(
      (candidate: { path: string }) => candidate.path === 'records/threads.jsonl'
    );
    if (!entry) throw new Error('Expected native Thread inventory entry.');
    entry.bytes = Buffer.byteLength(threadText);
    entry.digest = `sha256:${createHash('sha256').update(threadText).digest('hex')}`;
    manifest.contentDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify(manifest.contentInventory))
      .digest('hex')}`;
    writeFileSync(
      join(exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE),
      `${JSON.stringify(manifest)}\n`
    );
    expect(manifest.requiredFeatures).not.toContain('openkit.thread-visibility.future');
    expect(() => verifyWorkspaceExportTree({ exportRoot })).toThrow();
    expect(readFileSync(threadPath, 'utf8')).toBe(threadText);
  } finally {
    await getControlStoreWorkerClient().shutdown();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it('uses native product history for public Workspace export without a product-file fallback', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'native-history-transfer-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  try {
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Portable SQL history');
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
    const thread = await store.createThread(workspace.id, 'Portable Thread');
    const turn = await store.createTurn(workspace.id, thread.id, 'Record history', {
      kind: 'user',
      id: userId,
    });
    const item = await store.createItem({
      id: allocateEntityId('it'),
      owner: { kind: 'workspace', workspaceId: workspace.id },
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      text: 'First revision',
      status: 'in_progress',
      createdAt: turn.startedAt!,
      completedAt: null,
    });
    await store.updateItem(item.id, { text: 'Second revision' });
    const envelope = await store.persistTurnEvent(turn.id, {
      event: 'error',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'error', code: 'fixture', message: 'Retained event' },
    });
    store.emitTurnEvent(turn.id, envelope);
    const app = await createApp({ coreDb, dataRoot, store });
    rmSync(join(dataRoot, 'workspaces', workspace.id, 'threads'), {
      recursive: true,
      force: true,
    });
    const exported = await app.request(
      ...operationRequest(
        'workspace.export',
        {
          workspaceId: workspace.id,
        },
        { method: 'POST' }
      )
    );
    expect(exported.status, await exported.clone().text()).toBe(200);
  } finally {
    await getControlStoreWorkerClient().shutdown();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

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
      nativeKnowledgePages: new Map(),
      retrievalTraceFiles: new Map(),
      workerContextPackageFiles: new Map(),
      workspaceConfig: JSON.stringify({
        schemaVersion: 1,
        workspace: {
          name: input.workspace.name,
          defaultAgentId: null,
          defaultKnowledgeBaseId: workspaceKnowledgeBaseId,
          knowledgeMounts: [
            {
              name: 'raw',
              knowledgeBaseId: workspaceKnowledgeBaseId,
              default: true,
              backend: 'local',
              root: 'raw',
            },
          ],
        },
      }),
      workspaceSchema: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
    },
    ...input,
  });
}

/** Returns one absent export root beneath a unique temporary parent. */
function freshExportRoot(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'export');
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
  it('T1 classifies each native Workspace journal table exactly once without changing retained bytes', ({
    skip,
  }) => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-journal-export-'));
    const db = openWorkspaceDb(root, 'ws_00000000-0000-7000-8000-000000000001');
    try {
      applyScopedMigrations(db, undefined, 'pre-knowledge');
      const names = ['control_execution_steps', 'control_executions'];
      const tables = (
        db.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('control_executions', 'control_execution_steps') ORDER BY name"
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
      if (
        tables.length === 0 &&
        !existsSync(new URL('../../drizzle/workspace/0012_execution_journal.sql', import.meta.url))
      )
        skip('schema-pending: Workspace0012 execution journal');
      expect(tables).toEqual(names);
      const before = db.sqlite.serialize();
      // Classification is a prerequisite, not proof of portable history or a restored execution grant.
      const classified = [
        ...WORKSPACE_EXPORT_PORTABLE_WORKSPACE_SQLITE_TABLES,
        ...WORKSPACE_EXPORT_NON_PORTABLE_WORKSPACE_SQLITE_TABLES.map((entry) => entry.table),
      ];
      expect(classified.filter((name) => names.includes(name)).sort()).toEqual([
        'control_execution_steps',
        'control_executions',
      ]);
      expect(db.sqlite.serialize().equals(before)).toBe(true);
    } finally {
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('carries non-secret authenticated credential identity through verified export', () => {
    const root = freshExportRoot('audit-auth-export-');
    const workspaceId = testEntityId('ws', 'audit-auth-export');
    const authentication = {
      credentialKind: 'session' as const,
      credentialId: testEntityId('auth', 'source-credential'),
    };
    const event = AuditEventSchema.parse({
      id: testEntityId('aud', 'audit-auth-export'),
      workspaceId,
      actor: { kind: 'user', id: testEntityId('usr', 'source-actor') },
      authentication,
      action: 'catalog.mcp-create',
      resource: 'mcp:stub',
      outcome: 'succeeded',
      summary: 'MCP created.',
      createdAt: timestamp,
      occurredAt: timestamp,
    });
    try {
      const verified = writeWorkspaceExportTree({
        exportRoot: root,
        exportId: testEntityId('wsexp', 'audit-auth-export'),
        sourceDeploymentId: testEntityId('dep', 'audit-auth-export'),
        createdAt: timestamp,
        workspace: {
          id: workspaceId,
          name: 'Audit',
          kind: 'code',
          status: 'active',
          counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        threads: [],
        turns: [],
        itemRevisions: [],
        artifacts: [],
        artifactReviews: [],
        agentSessions: [],
        turnEvents: [],
        knowledge: [],
        auditEvents: [event],
      });
      const exported = verified.fileContents.get('records/audit-events.jsonl');
      expect(exported).toBe(`${JSON.stringify(writeRetainedV1(event))}\n`);
      expect(JSON.parse(exported!.trim())).toMatchObject({ authentication, workspaceId });
      expect(verified.manifest.workspaceId).toBe(workspaceId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('always exports all three empty recurring families with their required feature', () => {
    const root = freshExportRoot('recurring-empty-export-');
    const verified = writeWorkspaceExportTree({
      exportRoot: root,
      exportId: testEntityId('wsexp', 'recurring-empty-export'),
      sourceDeploymentId: testEntityId('dep', 'recurring-empty-export'),
      createdAt: timestamp,
      workspace: {
        id: testEntityId('ws', 'recurring-empty-export'),
        name: 'Demo',
        kind: 'code',
        status: 'active',
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threads: [],
      turns: [],
      itemRevisions: [],
      artifacts: [],
      artifactReviews: [],
      agentSessions: [],
      turnEvents: [],
      knowledge: [],
    });
    expect(verified.manifest.requiredFeatures).toContain('workspace.recurring-triggers.v1');
    expect(
      parseJsoncObject(verified.fileContents.get('workspace-files/config/workspace.jsonc')!)
    ).toMatchObject({ workspace: { defaultKnowledgeBaseId: workspaceKnowledgeBaseId } });
    for (const family of ['schedules', 'occurrences', 'expired-ranges'])
      expect(verified.fileContents.get(`records/recurring-${family}.jsonl`)).toBe('');
    expect(verified.fileContents.has('workspace-files/imports/recurrence-history.json')).toBe(
      false
    );
  });

  it('rejects a recurring file without its feature and a feature without all three families', () => {
    const root = writeExportTree('records/recurring-schedules.jsonl', '');
    expect(() => verifyWorkspaceExportTree({ exportRoot: root })).toThrow('all three families');
    const path = join(root, WORKSPACE_EXPORT_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.requiredFeatures = ['workspace.recurring-triggers.v1'];
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => verifyWorkspaceExportTree({ exportRoot: root })).toThrow('all three families');
  });

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
          owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
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
        knowledgePageFixture(
          {
            id: 'release-cadence',
            title: 'Release cadence',
            content: 'Review releases every Friday.',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' }
        ),
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
      'records/evaluation-candidate-sets.jsonl',
      'records/item-revisions.jsonl',
      'records/knowledge.jsonl',
      'records/recurring-expired-ranges.jsonl',
      'records/recurring-occurrences.jsonl',
      'records/recurring-schedules.jsonl',
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
      'workspace-files/knowledge/schema/scope-schema.yaml',
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
      requiredFeatures: [
        'agent.resource-catalog.v1',
        'workspace.recurring-triggers.v1',
        'openkit.thread-entry.v1',
        'openkit.thread-visibility.v1',
      ],
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
  });

  it('verifies exported history bytes, offline equality, and unresolved or stale item refusals', () => {
    const root = freshExportRoot('openkit-workspace-history-export-');
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
      owner: { kind: 'workspace', workspaceId: workspace.id },
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
      owner: { kind: 'workspace', workspaceId: workspace.id },
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
      owner: { kind: 'workspace', workspaceId: workspace.id },
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
      owner: { kind: 'workspace', workspaceId: workspace.id },
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
      owner: { kind: 'workspace', workspaceId: workspace.id },
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
      owner: { kind: 'workspace', workspaceId: workspace.id },
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
      owner: { kind: 'workspace', workspaceId: workspace.id },
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
      owner: { kind: 'workspace', workspaceId: workspace.id },
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
    const sourceWorkspaceRoot = join(dirname(root), 'source');
    publishArtifactVersionRecord({
      workspaceRoot: sourceWorkspaceRoot,
      record: ArtifactVersionRecordSchema.parse({
        artifact,
        version: {
          parentVersion: null,
          actor: turn.triggerActor,
          threadId: artifact.threadId,
          turnId: artifact.turnId,
          requestId: artifact.lastMutationRequestId,
          recordedAt: artifact.updatedAt,
        },
      }),
    });
    const exportInput = {
      sourceWorkspaceRoot,
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
    expect.soft(artifactMetadata).toEqual(
      writeRetainedV1({
        ...artifact,
        content: { format: artifact.content.format },
      })
    );
    expect.soft(JSON.stringify(artifactMetadata)).not.toContain(artifact.content.body);
    expect.soft(readFileSync(artifactBodyPath, 'utf8')).toBe(artifact.content.body);
    expect.soft(verifyWorkspaceExportTree({ exportRoot: root })).toEqual(exported);

    expect(readFileSync(join(root, 'records/agent-sessions.jsonl'), 'utf8')).not.toContain('wst_');

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

  it('normalizes a Server retrieval trace on export and omits forbidden annotations', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-server-trace-source-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const root = freshExportRoot('openkit-workspace-server-trace-import-');
    try {
      const store = new FsStore({ dataRoot });
      const workspace = await store.createWorkspace('Demo workspace');
      recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
      const thread = await store.createThread(workspace.id, 'Server trace');
      const serverPageScope = `page/server/${allocateEntityId('kb')}`;
      const traceId = 'krt_00000000-0000-77c6-84f7-ac86ac6632b2';
      const requestDigest = `sha256:${'8'.repeat(64)}`;
      const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
      const sourceTracePath = `threads/${thread.id}/retrieval-traces/${traceId}.json`;
      const sourceTrace = {
        traceId,
        query: 'private query annotation',
        futureRootNote: 'private root annotation',
        queryContext: {
          serverId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
          workspaceId: workspace.id,
          actor: {
            kind: 'user',
            id: 'usr_00000000-0000-7431-921d-ea7bcc58a6f2',
            futureActorNote: 'retained',
          },
          threadId: thread.id,
        },
        sourceScope: serverPageScope,
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
            reference: { scopeId: serverPageScope, objectId: 'same-path' },
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
      mkdirSync(join(workspaceRoot, 'threads', thread.id, 'retrieval-traces'), {
        recursive: true,
      });
      const sourceTraceText = `${JSON.stringify(writeRetainedV1(sourceTrace))}\n`;
      writeFileSync(join(workspaceRoot, sourceTracePath), sourceTraceText);
      const portableFileState = readWorkspacePortableFileState(workspaceRoot, {
        workspaceId: workspace.id,
        threads: store.listThreads(workspace.id).map((listed) => ({ threadId: listed.id })),
        turns: [],
      });
      const normalizedSourceTrace = [...portableFileState.retrievalTraceFiles.values()][0]!;
      expect(
        (normalizedSourceTrace.queryContext.actor as Record<string, unknown>).futureActorNote
      ).toBeUndefined();
      expect(JSON.stringify(normalizedSourceTrace)).not.toContain('private');
      expect(readFileSync(join(workspaceRoot, sourceTracePath), 'utf8')).toBe(sourceTraceText);
      const verified = writeWorkspaceExportTree({
        exportRoot: root,
        exportId: 'wsexp_00000000-0000-7891-af5f-e2a90c3bc344',
        sourceDeploymentId: 'dep_00000000-0000-7737-8fe7-61ca07c79d45',
        createdAt: timestamp,
        workspace: store.getWorkspace(workspace.id),
        threads: store.listThreads(workspace.id),
        turns: [],
        knowledge: [],
        itemRevisions: [],
        artifacts: [],
        artifactReviews: [],
        agentSessions: [],
        turnEvents: [],
        portableFileState,
      });
      const exportedTraceText = verified.fileContents.get(`workspace-files/${sourceTracePath}`)!;
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
      }
    } finally {
      await getControlStoreWorkerClient().shutdown();
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('exports full turn event history after the in-memory replay window rolls over', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-event-history-export-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    onTestFinished(async () => {
      await getControlStoreWorkerClient().shutdown();
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const fixture = createDemoWorkspaceForUser(LOCAL_USER_ID);
    const store = new FsStore({ dataRoot });
    await store.importWorkspaceSnapshot({
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
    const sourceKnowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot,
      scope: { kind: 'workspace', workspaceId: fixture.workspace.id },
    });
    const turn = await store.createTurn(
      fixture.workspace.id,
      fixture.thread.id,
      'Retain full history',
      localActor
    );
    for (let index = 0; index < 101; index += 1) {
      const event = await store.persistTurnEvent(turn.id, {
        event: 'turn.started',
        workspaceId: fixture.workspace.id,
        threadId: fixture.thread.id,
        turnId: turn.id,
        data: { type: 'turn-started', turnId: turn.id, status: 'running' },
      });
      store.emitTurnEvent(turn.id, event);
    }
    expect(store.getTurnEvents(turn.id).map((event) => event.sequence)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 2)
    );

    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: fixture.workspace.id,
    });
    const response = await (await createApp({ coreDb, dataRoot, store })).request(
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
      const exportRoot = join(
        dataRoot,
        'server',
        'exports',
        'workspaces',
        fixture.workspace.id,
        body.exportId
      );
      const verified = verifyWorkspaceExportTree({ exportRoot });
      expect(
        parseJsoncObject(verified.fileContents.get('workspace-files/config/workspace.jsonc')!)
      ).toMatchObject({ workspace: { defaultKnowledgeBaseId: sourceKnowledgeBaseId } });
      expect(
        verified.fileContents
          .get('records/turn-events.jsonl')!
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).sequence)
      ).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
    }
  });

  it('round-trips private Material and Review owners through the workspace endpoints', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-material-review-export-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    onTestFinished(async () => {
      await getControlStoreWorkerClient().shutdown();
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
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
    await store.importWorkspaceSnapshot({
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
    const sourceKnowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot,
      scope: { kind: 'workspace', workspaceId: fixture.workspace.id },
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: LOCAL_USER_ID,
      workspaceId: fixture.workspace.id,
      now: new Date(timestamp),
    });
    const turn = await store.createTurn(
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
      (workspace_id, material_id, revision_id, parent_revision_id, media_type,
       content_digest, content, author_id, created_by_request_id, created_at)
      SELECT workspace_id, ?, revision_id, parent_revision_id, media_type,
        content_digest, content, author_id, ?, created_at
      FROM workspace_material_revisions WHERE material_id = ?`)
      .run(secondMaterial.materialId, 'second-source-revision', material.materialId);
    workspaceDb.sqlite
      .prepare(
        'UPDATE workspace_materials SET current_revision_id = ?, last_mutation_request_id = ? WHERE material_id = ?'
      )
      .run(sourceRevisionId, 'second-source-revision', secondMaterial.materialId);
    const secondMaterialThread = await store.createThread(
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
    const artifact = await store.createArtifact({
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

    const app = await createApp({ coreDb, dataRoot, store });
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
    const verified = verifyWorkspaceExportTree({
      exportRoot: join(dataRoot, 'server', 'exports', 'workspaces', fixture.workspace.id, exportId),
    });
    const exportedRecords = (path: string) =>
      (verified.fileContents.get(path) ?? '')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);
    const sameRecords = (actual: readonly unknown[], expected: readonly unknown[]) => {
      const key = (value: unknown) => JSON.stringify(value);
      expect([...actual].sort((left, right) => key(left).localeCompare(key(right)))).toEqual(
        [...expected].sort((left, right) => key(left).localeCompare(key(right)))
      );
    };
    const reopened = openWorkspaceDb(dataRoot, fixture.workspace.id);
    try {
      const rows = listExportableWorkspaceMaterialRows(reopened);
      const reviews = listExportableArtifactReviews(reopened);
      sameRecords(exportedRecords('records/workspace-materials.jsonl'), rows.materials);
      sameRecords(exportedRecords('records/workspace-material-revisions.jsonl'), rows.revisions);
      sameRecords(exportedRecords('records/thread-material-bindings.jsonl'), rows.bindings);
      sameRecords(exportedRecords('records/artifact-reviews.jsonl'), reviews);
      expect(rows.materials.map((row) => row.materialId).sort()).toEqual(
        [material.materialId, secondMaterial.materialId].sort()
      );
      expect(rows.revisions.map((row) => row.revisionId)).toEqual([
        sourceRevisionId,
        sourceRevisionId,
      ]);
      expect(rows.bindings).toHaveLength(2);
      expect(reviews).toHaveLength(1);
    } finally {
      reopened.sqlite.close();
    }
    expect(
      parseJsoncObject(verified.fileContents.get('workspace-files/config/workspace.jsonc')!)
    ).toMatchObject({ workspace: { defaultKnowledgeBaseId: sourceKnowledgeBaseId } });
    expect(verified.manifest.workspaceId).toBe(fixture.workspace.id);
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

    const verified = verifyWorkspaceExportTree({ exportRoot: root });
    const text = verified.fileContents.get('records/git-push-records.jsonl')!;
    const bytes = Buffer.from(text);
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(JSON.parse(text)).toMatchObject({
      remoteSummary: 'Public fixture ghp_publicFixture on origin',
      sourceRef: 'hf_publicFixture',
      targetBranch: 'sk-Latn',
    });
    expect(readFileSync(join(root, 'records/git-push-records.jsonl'))).toEqual(bytes);
    expect(
      createHash('sha256')
        .update(readFileSync(join(root, 'records/git-push-records.jsonl')))
        .digest('hex')
    ).toBe(digest);
    expect(verified.manifest.workspaceId).toBe('ws_00000000-0000-7000-8000-000000000001');
  });

  it.each([
    'records/knowledge-observations.jsonl',
    'records/knowledge-claims.jsonl',
    'records/knowledge-conflicts.jsonl',
  ] as const)('rejects removed export record %s during export verification', (removedPath) => {
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
    // Retired fact fixtures retain their former complete rows, so refusal protects authored content.
    const factFields = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      sourceReferences: [],
      producer: LOCAL_USER_ID,
      createdAt: timestamp,
    };
    const retiredFactRows: Record<string, unknown> = {
      'records/knowledge-observations.jsonl': {
        ...factFields,
        id: 'ko_00000000-0000-7000-8000-000000000001',
        kind: 'maintenance',
        summary: 'A retained release assessment must not disappear during import.',
        scope: 'workspace',
        confidence: 0.75,
        freshness: 'current',
        status: 'retained',
        observedAt: timestamp,
      },
      'records/knowledge-claims.jsonl': {
        ...factFields,
        id: 'kc_00000000-0000-7000-8000-000000000001',
        statement: 'The retained release cadence is fortnightly.',
        scope: 'workspace',
        confidence: 0.75,
        freshness: 'current',
        reviewState: 'needs-review',
        conflictStatus: 'none',
        updatedAt: timestamp,
      },
      'records/knowledge-conflicts.jsonl': {
        ...factFields,
        id: 'kf_00000000-0000-7000-8000-000000000001',
        subjectReferences: [
          'openkit:page/workspace/ws_00000000-0000-7000-8000-000000000001/kb_00000000-0000-7000-8000-000000000001/release-cadence',
        ],
        status: 'conflicting',
        summary: 'Retained release evidence contains competing cadence assessments.',
        suggestedActions: ['Inspect the competing evidence before publication.'],
        updatedAt: timestamp,
      },
    };
    const removedContent = `${JSON.stringify(
      retiredFactRows[removedPath] ?? {
        id: 'removed_import',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      }
    )}\n`;
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

    expect(() => verifyWorkspaceExportTree({ exportRoot: root })).toThrow(
      `Unsupported workspace export record path: ${removedPath}`
    );
  });

  it('exports redacted worker setup evidence rows', async () => {
    const agentSetup = createTestAgentSetup();
    const root = freshExportRoot('openkit-workspace-worker-evidence-');
    const workerThread = {
      id: 'th_00000000-0000-7267-800d-a65e1b6a22d7',
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
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
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
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
    const workerPackage = await resolveAgentEnvironmentPackage({
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

    const verified = verifyWorkspaceExportTree({ exportRoot: root });
    expect(verified.fileContents.get('records/resolved-agent-setups.jsonl')).toContain('ras_demo');
    expect(
      verified.fileContents.get('records/agent-environment-package-snapshots.jsonl')
    ).toContain(workerPackage.snapshotId);
  });

  it('keeps workspace sqlite table export coverage explicit', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-export-coverage-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');

    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
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
      expect(WORKSPACE_EXPORT_PORTABLE_WORKSPACE_SQLITE_TABLES).toEqual(
        expect.arrayContaining([
          'control_workspaces',
          'control_threads',
          'control_agent_sessions',
          'control_turns',
          'control_product_entries',
        ])
      );
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
        {
          table: 'workspace_capture_records',
          reason:
            'capture lifecycle belongs to Workspace backup coordination, not portable Workspace product history',
        },
        {
          table: 'control_executions',
          reason:
            'non-portable execution control state; operational backup and MOVE retain Workspace database bytes',
        },
        {
          table: 'control_execution_steps',
          reason:
            'non-portable execution control state; operational backup and MOVE retain Workspace database bytes',
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
