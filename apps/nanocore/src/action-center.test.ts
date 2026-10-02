import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ListHumanAttentionResponseSchema,
  type WorkspaceSyncReviewItem,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { createArtifactReview, decideArtifactReview } from './artifact-reviews.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION } from './knowledge/okf.js';
import { createPolicyApprovalGate } from './policy/approval-gates.js';
import { raiseRecordedPendingRequest } from './runtime/pending-request-flow.js';
import { upsertWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import { recordWorkspaceReconciliationRecord } from './runtime/workspace-reconciliation-records.js';
import {
  recordWorkspaceSyncReview,
  updateWorkspaceSyncReviewDecision,
} from './runtime/workspace-sync-records.js';
import { createSchedulerAdmissionEntry, denySchedulerAdmissionEntry } from './scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from './storage/workspace-file-records.js';
import { type createApp, createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordTestWorkspaceReviewMaterialization } from './test-support/workspace-sync.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const timestamp = '2026-05-31T00:00:00.000Z';

/**
 * Opens a migrated Core database for action center route tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-action-center-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Creates a Core-backed test app with the local actor authorized for every fixture Workspace.
 *
 * @param coreDb Core database that owns authorization facts.
 * @param store Test store whose Workspaces need canonical owner membership.
 * @returns NanoCore test app with local Workspace access.
 */
function createAuthorizedCoreApp(
  coreDb: CoreDb,
  store: ReturnType<typeof createDemoStore>
): ReturnType<typeof createApp> {
  ensureLocalUser(coreDb);
  for (const workspace of store.listWorkspaces()) {
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
  }
  return createAppWithWorkspaceAuthority({ coreDb, store });
}

/** Installs one failed-health catalog summary after createApp wires the live projection. */
function projectFailedAgentHealth(
  store: ReturnType<typeof createDemoStore>,
  health: { message: string; checkedAt: string }
): void {
  const failedHealth = {
    status: 'failed' as const,
    message: health.message,
    checkedAt: health.checkedAt,
  };
  const summary = {
    id: 'agent_codex_host',
    name: 'Codex Host Agent',
    kind: null,
    status: 'enabled' as const,
    modelId: null,
    skillIds: [],
    profiles: [],
    defaultProfileId: null,
    capabilities: [],
    sandboxSummary: null,
    health: failedHealth,
  };
  store.setWorkspaceAgentCatalogProjection(() => [summary]);
}

/**
 * Opens a migrated workspace database for action center tests.
 *
 * @param coreDb Core database whose data root owns the workspace database.
 * @param workspaceId Workspace id to open.
 * @returns Migrated workspace database handle.
 */
function openTestWorkspaceDb(coreDb: CoreDb, workspaceId: string): WorkspaceDb {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, workspaceId);
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Creates one strict immutable Knowledge Proposal for Action Center projection tests.
 *
 * @param store Test store that owns the Workspace.
 * @param workspaceId Workspace that owns the proposal.
 * @param label Stable lowercase fixture label.
 * @param rationale Human-readable proposal rationale.
 * @returns Deterministic pending proposal authority.
 */
function createKnowledgeProposalFixture(
  store: ReturnType<typeof createDemoStore>,
  workspaceId: string,
  label: string,
  rationale: string
) {
  const source = store.createKnowledgeEntry(workspaceId, {
    kind: 'project-context',
    title: `${label} evidence`,
    content: rationale,
    sourceReferences: [],
  });
  const sourceReference = `knowledge:${source.id}@sha256:${createHash('sha256')
    .update(serializeUserAuthoredKnowledgePage(source), 'utf8')
    .digest('hex')}`;
  const knowledgePageId = `action-center/${label}`;
  const canonicalPageBytes = [
    '---',
    'type: "KnowledgePage"',
    `title: ${JSON.stringify(`Review ${label}`)}`,
    'openkit_entry_kind: "project-context"',
    `openkit_entry_id: ${JSON.stringify(knowledgePageId)}`,
    `schema_version: ${JSON.stringify(DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION)}`,
    'openkit_status: "active"',
    'status: "stable"',
    'scope: "workspace"',
    `source_refs: ${JSON.stringify([sourceReference])}`,
    'review_state: "accepted"',
    'sensitivity: "normal"',
    'freshness: "current"',
    `created_at: ${JSON.stringify(timestamp)}`,
    `updated_at: ${JSON.stringify(timestamp)}`,
    '---',
    rationale,
    '',
  ].join('\n');
  const requestSuffix = createHash('sha256').update(label, 'utf8').digest('hex').slice(0, 12);

  return store.createKnowledgeProposal({
    workspaceId,
    requestId: `00000000-0000-4000-8000-${requestSuffix}`,
    knowledgePageId,
    canonicalPageBytes,
    contentDigest: `sha256:${createHash('sha256')
      .update(canonicalPageBytes, 'utf8')
      .digest('hex')}`,
    sourceReferences: [sourceReference],
    rationale,
    confidence: 0.9,
    verifiedExternalReferences: [],
    producer: { kind: 'system', id: 'system_action_center', responsibleUserId: 'user_local' },
    createdAt: timestamp,
  });
}

/**
 * Persists a manually assembled workspace review with its trusted materialization fixture.
 *
 * @param workspaceDb Workspace database owned by the test.
 * @param input Durable workspace review fixture.
 */
function recordTestWorkspaceSyncReview(
  workspaceDb: WorkspaceDb,
  input: { item: WorkspaceSyncReviewItem }
): void {
  recordTestWorkspaceReviewMaterialization(workspaceDb, input.item);
  recordWorkspaceSyncReview(workspaceDb, input);
}

/** Store-valid origins exercised by Workspace Review attention projection tests. */
type WorkspaceReviewOriginKind = 'visible' | 'private' | 'imported';

/**
 * Creates one Store-valid Artifact for workspace-review origin projection tests.
 *
 * Imported origin is the durable non-turn-output shape. ArtifactSchema rejects mismatched turn-output lineage.
 *
 * @param store Product store owned by the test.
 * @param workspaceId Workspace that owns the review.
 * @param input Artifact identity and origin kind.
 * @returns Thread and Turn ids when a turn-output origin exists.
 */
function createWorkspaceReviewBackingArtifact(
  store: ReturnType<typeof createDemoStore>,
  workspaceId: string,
  input: {
    readonly artifactId: string;
    readonly origin: WorkspaceReviewOriginKind;
  }
): { readonly threadId?: string; readonly turnId?: string; readonly turnRef: string } {
  const artifactRequestId = `action-center-${input.origin}-workspace-review-1`;
  const artifactBody = `{"review":"${input.origin}"}`;
  const contentDigest = `sha256:${createHash('sha256').update(artifactBody, 'utf8').digest('hex')}`;
  if (input.origin === 'imported') {
    store.createArtifact({
      id: input.artifactId,
      workspaceId,
      threadId: null,
      turnId: null,
      kind: 'file',
      title: 'Imported workspace changes',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'json', body: artifactBody },
      contentDigest,
      lastMutationRequestId: artifactRequestId,
      origin: {
        kind: 'imported',
        sourceKind: 'direct-import',
        sourceId: artifactRequestId,
        sourceDigest: contentDigest,
        actor: { kind: 'user', id: 'user_local' },
        requestId: artifactRequestId,
        recordedAt: timestamp,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { turnRef: 'turn_imported_origin' };
  }

  const thread = store.createThread(
    workspaceId,
    `${input.origin} origin conversation`,
    undefined,
    'conversation',
    input.origin === 'private'
      ? { privateOwnerUserId: 'user_other', visibility: 'private' }
      : undefined
  );
  const turn = store.createTurn(
    workspaceId,
    thread.id,
    `Produce ${input.origin} workspace changes`,
    { kind: 'user', id: input.origin === 'private' ? 'user_other' : 'user_local' },
    null,
    { turnId: `turn_${input.origin}_origin` }
  );
  store.createArtifact({
    id: input.artifactId,
    workspaceId,
    threadId: thread.id,
    turnId: turn.id,
    kind: 'diff',
    title: `${input.origin} workspace changes`,
    status: 'ready',
    summary: `${input.origin} origin.`,
    version: 1,
    content: { format: 'json', body: artifactBody },
    contentDigest,
    lastMutationRequestId: artifactRequestId,
    origin: {
      kind: 'turn-output',
      threadId: thread.id,
      turnId: turn.id,
      requestId: artifactRequestId,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return { threadId: thread.id, turnId: turn.id, turnRef: turn.id };
}

/**
 * Persists one pending git workspace-review fixture for Action Center lineage tests.
 *
 * @param workspaceDb Workspace database owned by the test.
 * @param input Review, Artifact, and path identities.
 */
function recordPendingWorkspaceReview(
  workspaceDb: WorkspaceDb,
  input: {
    readonly workspaceId: string;
    readonly artifactId: string;
    readonly reviewId: string;
    readonly path: string;
    readonly turnRef: string;
  }
): void {
  const patchText = `diff --git a/${input.path} b/${input.path}\n`;
  const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
  const changeSetId = `wcs_${input.reviewId}`;
  recordTestWorkspaceSyncReview(workspaceDb, {
    item: {
      artifactId: input.artifactId,
      changeSet: {
        id: changeSetId,
        materializationRecordId: `wmr_${input.reviewId}`,
        inputSnapshotId: `wis_${input.reviewId}`,
        workspaceId: input.workspaceId,
        resourceId: 'repo_default',
        strategy: 'git',
        base: { commit: 'abc123', contentDigest: null },
        head: { commit: 'def456', contentDigest: null },
        changedPaths: [{ path: input.path, status: 'modified', binary: false }],
        patch: {
          ref: 'artifact://patch',
          digest: patchDigest,
          bytes: Buffer.byteLength(patchText, 'utf8'),
        },
        bundle: null,
        artifactIds: [input.artifactId],
        evidenceRefs: [{ kind: 'worker', ref: input.turnRef }],
        redaction: { status: 'redacted', notes: [] },
        createdAt: timestamp,
      },
      patchPayload: {
        mediaType: 'text/x-diff',
        text: patchText,
        digest: patchDigest,
        bytes: Buffer.byteLength(patchText, 'utf8'),
      },
      review: {
        id: input.reviewId,
        changeSetId,
        workspaceId: input.workspaceId,
        status: 'pending',
        staging: {
          strategy: 'git_worktree',
          ref: `staging://workspace/${changeSetId}`,
          branch: `openkit/review/${input.reviewId}`,
        },
        diffSummary: { filesChanged: 1, additions: 0, deletions: 0 },
        riskSummary: '1 changed path staged for human review.',
        validation: [{ command: 'worker', status: 'passed', ref: input.turnRef }],
        actionCenterRowId: `workspace-review:${input.reviewId}`,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  });
}

describe('action center app API', () => {
  it('rejects a missing workspace without creating its canonical directory', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspaceRoot = join(coreDb.dataRoot, 'workspaces', 'ws_missing');

    try {
      const response = await createAuthorizedCoreApp(coreDb, store).request(
        ...operationRequest('attention.list', { workspaceId: 'ws_missing' }, undefined)
      );

      expect(response.status).toBe(403);
      expect(existsSync(workspaceRoot)).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns unified human attention rows for pending approval and question gates', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const thread = store.createThread('ws_demo', 'Needs human input');
    const approvalTurn = store.createTurn('ws_demo', thread.id, 'Run guarded work', {
      kind: 'user',
      id: 'user_local',
    });
    const questionTurn = store.createTurn('ws_demo', thread.id, 'Request a secret', {
      kind: 'user',
      id: 'user_local',
    });
    const approval = store.createApproval({
      id: 'ap_action_center',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: approvalTurn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve command',
      description: 'Allow the worker to continue.',
      createdAt: timestamp,
      resolvedAt: null,
    });
    const approvalItem = store.createItem({
      id: 'it_action_center_approval',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: approvalTurn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: approval.id,
      title: approval.title,
      description: approval.description,
      kind: approval.kind,
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const approvalDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      raiseRecordedPendingRequest(store, approvalDb.sqlite, {
        requestId: approval.id,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        raisingTurnId: approvalTurn.id,
        requestItemId: approvalItem.id,
        kind: 'approval',
        requesterKind: 'worker',
        agentId: 'agent_demo',
        responsibleUserId: 'user_local',
        approval: { kind: 'permission', title: approval.title, description: approval.description },
        now: timestamp,
      });
    } finally {
      approvalDb.sqlite.close();
    }
    const questionItem = store.createItem({
      id: 'it_action_center_question',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: questionTurn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'user_local',
      userInputRequestId: 'ui_action_center',
      prompt: 'Choose a path.',
      questions: [
        {
          id: 'path',
          header: 'Path',
          question: 'Which path should the worker use?',
          options: null,
          isOther: true,
          isSecret: true,
        },
      ],
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const questionDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      raiseRecordedPendingRequest(store, questionDb.sqlite, {
        requestId: questionItem.userInputRequestId,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        raisingTurnId: questionTurn.id,
        requestItemId: questionItem.id,
        kind: 'user-input',
        requesterKind: 'assistant',
        responsibleUserId: 'user_local',
        questions: questionItem.questions,
        questionDigest: 'digest-action-center',
        now: timestamp,
      });
    } finally {
      questionDb.sqlite.close();
    }
    const toolUseTurn = store.createTurn('ws_demo', thread.id, 'Use an MCP tool', {
      kind: 'user',
      id: 'user_local',
    });
    const toolUseWorkspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      createPolicyApprovalGate({
        action: 'tool.use',
        approvalId: 'ap_incomplete_tool_use',
        approvalItemId: 'it_incomplete_tool_use',
        decisionId: 'pd_incomplete_tool_use',
        description: 'Approve one exact MCP tool effect.',
        reasonCode: 'mcp_tool_approval_required',
        resourceSummary: { serverId: 'echo', tool: 'echo' },
        store,
        subjectSummary: { agentId: 'agent_codex' },
        title: 'Approve MCP tool use',
        turnId: toolUseTurn.id,
        workspaceDb: toolUseWorkspaceDb,
        workspaceId: 'ws_demo',
      });
    } finally {
      toolUseWorkspaceDb.sqlite.close();
    }
    const app = createAuthorizedCoreApp(coreDb, store);

    const res = await app.request(
      ...operationRequest('attention.list', { workspaceId: 'ws_demo' }, undefined)
    );

    expect(res.status).toBe(200);
    expect(ListHumanAttentionResponseSchema.parse(await res.json()).items).toEqual([
      expect.objectContaining({
        id: `approval:${approval.id}`,
        kind: 'approval',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: approvalTurn.id,
        itemId: approvalItem.id,
        title: 'Approve command',
        severity: 'needs_input',
        source: expect.objectContaining({ type: 'approval', approvalRequestId: approval.id }),
      }),
      expect.objectContaining({
        id: `question:${questionItem.userInputRequestId}`,
        kind: 'question',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: questionTurn.id,
        itemId: questionItem.id,
        title: 'Answer required',
        severity: 'needs_input',
        source: expect.objectContaining({ type: 'protocol_item', itemId: questionItem.id }),
        actions: expect.arrayContaining([
          expect.objectContaining({
            kind: 'answer_question',
            disabled: true,
            reason: 'Secret answers are not supported.',
          }),
        ]),
      }),
    ]);

    expect((await app.request('/api/app/workspaces/ws_demo/action-center/approvals')).status).toBe(
      404
    );
    expect((await app.request('/api/app/workspaces/ws_demo/action-center/questions')).status).toBe(
      404
    );

    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      upsertWorkerCheckpoint(workspaceDb, {
        diagnosticsSummary: null,
        iteration: 1,
        requestId: `req_${approvalTurn.id}`,
        requestInputHash: `sha256:${approvalTurn.id}`,
        stage: 'running_worker',
        threadId: thread.id,
        turnId: approvalTurn.id,
        workerSessionId: 'as_pending_worker_gate',
        workspaceId: 'ws_demo',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    const incompleteWorkerGate = await app.request(
      ...operationRequest('attention.list', { workspaceId: 'ws_demo' }, undefined)
    );
    expect(
      ListHumanAttentionResponseSchema.parse(await incompleteWorkerGate.json()).items.map(
        (item) => item.id
      )
    ).toEqual([`approval:${approval.id}`, `question:${questionItem.userInputRequestId}`]);
    coreDb.sqlite.close();
  });

  it('projects eligible member actions and admits an administrator to foreign private requests', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Actor-scoped attention');
    const approvalTurn = store.createTurn('ws_demo', thread.id, 'Request approval', {
      kind: 'user',
      id: 'user_owner',
    });
    const questionTurn = store.createTurn('ws_demo', thread.id, 'Request responsible input', {
      kind: 'user',
      id: 'user_responsible',
    });
    const approval = store.createApproval({
      id: 'ap_actor_scoped',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: approvalTurn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve actor-scoped work',
      description: 'Only a current decision authority may see this row.',
      createdAt: timestamp,
      resolvedAt: null,
    });
    const approvalItem = store.createItem({
      id: 'it_actor_scoped_approval',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: approvalTurn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: approval.id,
      title: approval.title,
      description: approval.description,
      kind: approval.kind,
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const approvalDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      raiseRecordedPendingRequest(store, approvalDb.sqlite, {
        requestId: approval.id,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        raisingTurnId: approvalTurn.id,
        requestItemId: approvalItem.id,
        kind: 'approval',
        requesterKind: 'person',
        responsibleUserId: 'user_owner',
        approval: { kind: 'permission', title: approval.title, description: approval.description },
        governedIntent: { action: 'repo.push' },
        now: timestamp,
      });
    } finally {
      approvalDb.sqlite.close();
    }
    const questionItem = store.createItem({
      id: 'it_actor_scoped_question',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: questionTurn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'user_responsible',
      userInputRequestId: 'ui_actor_scoped',
      prompt: 'Provide the responsible user input.',
      questions: [
        {
          id: 'choice',
          header: 'Choice',
          question: 'Which option should the worker use?',
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const questionDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      raiseRecordedPendingRequest(store, questionDb.sqlite, {
        requestId: questionItem.userInputRequestId,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        raisingTurnId: questionTurn.id,
        requestItemId: questionItem.id,
        kind: 'user-input',
        requesterKind: 'assistant',
        responsibleUserId: 'user_responsible',
        questions: questionItem.questions,
        questionDigest: 'digest-actor-scoped',
        now: timestamp,
      });
    } finally {
      questionDb.sqlite.close();
    }
    const knowledgeProposal = createKnowledgeProposalFixture(
      store,
      'ws_demo',
      'actor-scoped',
      'Only current review authority may see this row.'
    );

    const now = Date.now();
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
        ) VALUES
          ('user_owner', 'Owner', 'owner@example.com', false, ?, ?, 'human', 'active', NULL),
          ('user_responsible', 'Responsible', 'responsible@example.com', false, ?, ?, 'human', 'active', NULL),
          ('user_editor', 'Editor', 'editor@example.com', false, ?, ?, 'human', 'active', NULL),
          ('user_viewer', 'Viewer', 'viewer@example.com', false, ?, ?, 'human', 'active', NULL),
          ('user_removed', 'Removed', 'removed@example.com', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(now, now, now, now, now, now, now, now, now, now);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_owner',
      workspaceId: 'ws_demo',
    });
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, access_level, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES
          ('ws_demo', 'user_responsible', 'active', 'editor', NULL, ?, NULL, 1, ?, ?),
          ('ws_demo', 'user_editor', 'active', 'editor', NULL, ?, NULL, 1, ?, ?),
          ('ws_demo', 'user_viewer', 'active', 'viewer', NULL, ?, NULL, 1, ?, ?),
          ('ws_demo', 'user_removed', 'removed', 'editor', NULL, ?, ?, 2, ?, ?)`
      )
      .run(
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp
      );

    /** Issues one Workspace-bound token for the table actor. */
    const issueToken = (ownerUserId: string, scope: 'workspace' | 'workspace-readonly') =>
      createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2999-01-01T00:00:00.000Z',
        ownerUserId,
        scope,
        workspaceIds: ['ws_demo'],
      }).secret;
    const app = createAppWithWorkspaceAuthority({
      auth: {
        api: { getSession: async () => null },
        handler: async () => new Response(null, { status: 404 }),
      },
      coreDb,
      dataRoot: coreDb.dataRoot,
      mode: 'server',
      store,
    });
    projectFailedAgentHealth(store, {
      message: 'Shared runtime status remains visible.',
      checkedAt: timestamp,
    });
    const cases = [
      {
        name: 'owner',
        secret: issueToken('user_owner', 'workspace'),
        status: 200,
        visibleIds: [
          'agent-readiness:agent_codex_host',
          `approval:${approval.id}`,
          `knowledge:${knowledgeProposal.id}`,
        ],
      },
      {
        name: 'responsible editor',
        secret: issueToken('user_responsible', 'workspace'),
        status: 200,
        visibleIds: [
          'agent-readiness:agent_codex_host',
          `knowledge:${knowledgeProposal.id}`,
          `question:${questionItem.userInputRequestId}`,
        ],
      },
      {
        name: 'nonresponsible editor',
        secret: issueToken('user_editor', 'workspace'),
        status: 200,
        visibleIds: ['agent-readiness:agent_codex_host', `knowledge:${knowledgeProposal.id}`],
      },
      {
        name: 'readonly responsible editor',
        secret: issueToken('user_responsible', 'workspace-readonly'),
        status: 200,
        visibleIds: ['agent-readiness:agent_codex_host'],
      },
      {
        name: 'viewer',
        secret: issueToken('user_viewer', 'workspace'),
        status: 403,
        visibleIds: [],
      },
      {
        name: 'removed editor',
        secret: issueToken('user_removed', 'workspace'),
        status: 403,
        visibleIds: [],
      },
    ];
    const scopedRowIds = new Set([
      'agent-readiness:agent_codex_host',
      `approval:${approval.id}`,
      `question:${questionItem.userInputRequestId}`,
      `knowledge:${knowledgeProposal.id}`,
    ]);

    try {
      for (const testCase of cases) {
        const response = await app.request(
          ...operationRequest(
            'attention.list',
            { workspaceId: 'ws_demo' },
            {
              headers: { authorization: `Bearer ${testCase.secret}` },
            }
          )
        );
        expect(response.status, testCase.name).toBe(testCase.status);
        if (response.status === 200) {
          const visibleIds = ListHumanAttentionResponseSchema.parse(await response.json())
            .items.map((row) => row.id)
            .filter((rowId) => scopedRowIds.has(rowId));
          expect(visibleIds, testCase.name).toEqual(testCase.visibleIds);
        }
      }

      store.updateThread('ws_demo', thread.id, {
        visibility: 'private',
        privateOwnerUserId: 'user_responsible',
      });
      const admin = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'user_owner',
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
      }).secret;
      const adminResponse = await app.request(
        ...operationRequest(
          'attention.list',
          { workspaceId: 'ws_demo' },
          { headers: { authorization: `Bearer ${admin}` } }
        )
      );
      expect(adminResponse.status).toBe(200);
      expect(
        ListHumanAttentionResponseSchema.parse(await adminResponse.json()).items.map(
          (row) => row.id
        )
      ).toEqual(
        expect.arrayContaining([
          `approval:${approval.id}`,
          `question:${questionItem.userInputRequestId}`,
        ])
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('projects only the exact unresolved current ready turn-output Artifact Review', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Versioned Artifact Review');
    const thread = store.createThread(workspace.id, 'Review worker output');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Produce reviewable output',
      { kind: 'user', id: 'user_local' },
      null,
      {
        turnId: 'turn_artifact_review',
      }
    );
    store.updateTurn(turn.id, { agentId: 'agent_codex_host' });
    const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
    const content = '# Current output';
    const contentDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    const artifact = store.createArtifact({
      id: 'artifact_versioned_review',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'report',
      title: 'Current output',
      status: 'ready',
      summary: 'Review the current Artifact version.',
      version: 1,
      content: { format: 'markdown', body: content },
      contentDigest,
      lastMutationRequestId: 'artifact-version-1',
      origin: {
        kind: 'turn-output',
        threadId: thread.id,
        turnId: turn.id,
        requestId: 'artifact-version-1',
      },
      createdAt: timestamp,
      updatedAt: '2026-05-31T00:01:00.000Z',
    });
    try {
      const reviewInput = {
        artifactId: artifact.id,
        contentDigest: artifact.contentDigest,
        sourceThreadId: thread.id,
        sourceTurnId: turn.id,
        sourceAgentId: 'agent_codex_host',
        materialProposal: null,
      } as const;
      createArtifactReview(workspaceDb, {
        ...reviewInput,
        artifactVersion: 2,
        contentDigest: `sha256:${createHash('sha256').update('# Unavailable version').digest('hex')}`,
        createdAt: '2026-05-31T00:02:00.000Z',
      });
      const currentReview = createArtifactReview(workspaceDb, {
        ...reviewInput,
        artifactVersion: artifact.version,
        createdAt: '2026-05-31T00:01:00.000Z',
      });
      const app = createAuthorizedCoreApp(coreDb, store);
      const response = await app.request(
        ...operationRequest('attention.list', { workspaceId: workspace.id }, undefined)
      );
      const responsePayload = await response.json();
      expect(response.status, JSON.stringify(responsePayload)).toBe(200);
      const rows = ListHumanAttentionResponseSchema.parse(responsePayload).items.filter(
        (row) => row.source.type === 'artifact_review'
      );
      expect(rows).toEqual([
        expect.objectContaining({
          id: `artifact-review:${currentReview.reviewId}`,
          kind: 'artifact_review',
          workspaceId: workspace.id,
          threadId: thread.id,
          turnId: turn.id,
          reviewId: currentReview.reviewId,
          artifactId: artifact.id,
          artifactVersion: artifact.version,
          source: {
            type: 'artifact_review',
            reviewId: currentReview.reviewId,
            artifactId: artifact.id,
            artifactVersion: artifact.version,
            workspaceId: workspace.id,
            threadId: thread.id,
            turnId: turn.id,
          },
        }),
      ]);
      expect(rows[0]?.actions).toEqual([
        {
          kind: 'open_artifact',
          label: 'Open artifact',
          method: 'POST',
          href: '/api/app/operations/artifact.read',
        },
      ]);

      store.updateTurn(turn.id, { agentId: null });
      const contradictoryResponse = await app.request(
        ...operationRequest('attention.list', { workspaceId: workspace.id }, undefined)
      );
      expect(
        ListHumanAttentionResponseSchema.parse(await contradictoryResponse.json()).items.some(
          (row) => row.id === `artifact-review:${currentReview.reviewId}`
        )
      ).toBe(false);
      store.updateTurn(turn.id, { agentId: 'agent_codex_host' });

      decideArtifactReview(workspaceDb, {
        actorId: 'user_local',
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        decision: 'deferred',
        feedback: null,
        requestId: 'defer-current-review',
        artifactContent: content,
        artifactMediaType: 'text/markdown',
        decidedAt: '2026-05-31T00:02:00.000Z',
      });
      const decidedResponse = await app.request(
        ...operationRequest('attention.list', { workspaceId: workspace.id }, undefined)
      );
      expect(
        ListHumanAttentionResponseSchema.parse(await decidedResponse.json()).items.some(
          (row) => row.source.type === 'artifact_review'
        )
      ).toBe(false);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('omits approval and question requests without an exact completed Gate tuple', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Invalid human input gates');
    const approvalTurn = store.createTurn('ws_demo', thread.id, 'Incomplete approval request', {
      kind: 'user',
      id: 'user_local',
    });
    const questionTurn = store.createTurn('ws_demo', thread.id, 'Ungated question request', {
      kind: 'user',
      id: 'user_local',
    });
    const approval = store.createApproval({
      id: 'ap_incomplete_gate',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: approvalTurn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve command',
      description: 'Allow the worker to continue.',
      createdAt: timestamp,
      resolvedAt: null,
    });
    store.createItem({
      id: 'it_incomplete_gate_approval',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: approvalTurn.id,
      type: 'approval-request',
      status: 'in_progress',
      approvalRequestId: approval.id,
      title: approval.title,
      description: approval.description,
      kind: approval.kind,
      createdAt: timestamp,
      completedAt: null,
    });
    store.createItem({
      id: 'it_ungated_question',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: questionTurn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'user_local',
      userInputRequestId: 'ui_ungated_question',
      prompt: 'Choose a path.',
      questions: [
        {
          id: 'path',
          header: 'Path',
          question: 'Which path should the worker use?',
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const app = createAppWithWorkspaceAuthority({ store });

    const res = await app.request(
      ...operationRequest('attention.list', { workspaceId: 'ws_demo' }, undefined)
    );

    expect(ListHumanAttentionResponseSchema.parse(await res.json())).toEqual({ items: [] });
  });

  it('omits approval and question rows after matching decisions and answers exist', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Resolved human input');
    const turn = store.createTurn('ws_demo', thread.id, 'Run guarded work', {
      kind: 'user',
      id: 'user_local',
    });
    const approval = store.createApproval({
      id: 'ap_resolved',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      kind: 'permission',
      status: 'granted',
      title: 'Approve command',
      description: 'Allow the worker to continue.',
      createdAt: timestamp,
      resolvedAt: timestamp,
    });
    store.createItem({
      id: 'it_resolved_approval',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: approval.id,
      title: approval.title,
      description: approval.description,
      kind: approval.kind,
      createdAt: timestamp,
      completedAt: timestamp,
    });
    store.createItem({
      id: 'it_resolved_approval_decision',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'approval-decision',
      status: 'completed',
      actor: { kind: 'user', id: 'user_local' },
      causationId: 'it_resolved_approval',
      approvalRequestId: approval.id,
      decision: 'granted',
      decidedAt: timestamp,
      createdAt: timestamp,
      completedAt: timestamp,
    });
    store.createItem({
      id: 'it_resolved_question',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'user_local',
      userInputRequestId: 'ui_resolved',
      prompt: 'Choose a path.',
      questions: [
        {
          id: 'path',
          header: 'Path',
          question: 'Which path should the worker use?',
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
      createdAt: timestamp,
      completedAt: timestamp,
    });
    store.createItem({
      id: 'it_resolved_question_response',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-input-response',
      status: 'completed',
      actor: { kind: 'user', id: 'user_local' },
      causationId: 'it_resolved_question',
      userInputRequestId: 'ui_resolved',
      answers: { path: ['Use path A'] },
      answeredAt: timestamp,
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const app = createAppWithWorkspaceAuthority({ store });

    const res = await app.request(
      ...operationRequest('attention.list', { workspaceId: 'ws_demo' }, undefined)
    );

    expect(ListHumanAttentionResponseSchema.parse(await res.json())).toEqual({ items: [] });
  });

  it('projects scheduler admissions into the unified action center', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const queuedThread = store.createThread('ws_demo', 'Queued scheduler turn');
    const deniedThread = store.createThread('ws_demo', 'Denied scheduler turn');

    try {
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_action_center',
        workspaceId: 'ws_demo',
        threadId: queuedThread.id,
        turnId: 'turn_queued_scheduler',
        turnInput: 'Run when capacity is available.',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'agent_codex_host',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => timestamp,
      });
      createSchedulerAdmissionEntry(coreDb, {
        triggerActor: { kind: 'user', id: 'user_local' },
        queueEntryId: 'queue_denied_action_center',
        workspaceId: 'ws_demo',
        threadId: deniedThread.id,
        turnId: 'turn_denied_scheduler',
        turnInput: 'Run after target recovery.',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'agent_codex_host',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => timestamp,
      });
      denySchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_denied_action_center',
        denialReason: 'no-healthy-target',
      });

      const app = createAuthorizedCoreApp(coreDb, store);
      const res = await app.request(
        ...operationRequest('attention.list', { workspaceId: 'ws_demo' }, undefined)
      );
      const byId = new Map(
        ListHumanAttentionResponseSchema.parse(await res.json()).items.map((row) => [row.id, row])
      );

      expect(byId.get('scheduler-admission:queue_action_center')).toMatchObject({
        kind: 'pending_input',
        severity: 'info',
        threadId: queuedThread.id,
        turnId: 'turn_queued_scheduler',
        source: {
          type: 'scheduler_admission',
          queueEntryId: 'queue_action_center',
          status: 'queued',
          workspaceId: 'ws_demo',
          threadId: queuedThread.id,
          turnId: 'turn_queued_scheduler',
          requestedAgentId: 'agent_codex_host',
          priorityClass: 'interactive',
        },
        actions: expect.arrayContaining([
          expect.objectContaining({
            href: '/api/app/workspaces/ws_demo/scheduler/admissions/queue_action_center/cancel',
            kind: 'abort',
            method: 'POST',
          }),
        ]),
      });
      expect(byId.get('scheduler-admission:queue_denied_action_center')).toMatchObject({
        kind: 'blocked_turn',
        severity: 'blocked',
        threadId: deniedThread.id,
        turnId: 'turn_denied_scheduler',
        source: {
          type: 'scheduler_admission',
          queueEntryId: 'queue_denied_action_center',
          status: 'denied',
          denialReason: 'no-healthy-target',
        },
        actions: expect.arrayContaining([
          expect.objectContaining({
            href: '/api/app/workspaces/ws_demo/scheduler/admissions/queue_denied_action_center/retry',
            kind: 'retry_work',
            method: 'POST',
          }),
          expect.objectContaining({
            href: '/api/app/workspaces/ws_demo/scheduler/admissions/queue_denied_action_center/cancel',
            kind: 'abort',
            method: 'POST',
          }),
        ]),
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('projects Workspace admissions across authenticated trigger actors', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const shared = store.createThread('ws_demo', 'Shared other-user admission');

    try {
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_other_user_action_center',
        triggerActor: { kind: 'user', id: 'user_victim' },
        workspaceId: 'ws_demo',
        threadId: shared.id,
        turnId: 'turn_victim',
        turnInput: 'Show the Workspace admission to current authorized editors.',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'agent_codex_host',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => timestamp,
      });

      const app = createAuthorizedCoreApp(coreDb, store);
      const res = await app.request(
        ...operationRequest('attention.list', { workspaceId: 'ws_demo' }, undefined)
      );
      const items = ListHumanAttentionResponseSchema.parse(await res.json()).items;

      expect(res.status).toBe(200);
      expect(items.map((row) => row.id)).toContain(
        'scheduler-admission:queue_other_user_action_center'
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('projects recovery evidence into the unified action center', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Recovery evidence');
    const turn = store.createTurn('ws_demo', thread.id, 'Recover worker', {
      kind: 'user',
      id: 'user_local',
    });

    try {
      coreDb.sqlite
        .prepare(
          `
          INSERT INTO worker_control_rejected_evidence (
            rejection_id,
            workspace_id,
            thread_id,
            turn_id,
            agent_session_id,
            package_snapshot_id,
            request_id,
            route,
            operation,
            error_code,
            http_status,
            message,
            rejected_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          'wcr_action_center',
          'ws_demo',
          thread.id,
          turn.id,
          'as_rejected',
          'pkg_rejected',
          'req_rejected',
          '/api/worker-control/events/append',
          'event_append',
          'worker_control_lineage_mismatch',
          403,
          'Worker control request lineage does not match the active lease.',
          timestamp
        );
      coreDb.sqlite
        .prepare(
          `
          INSERT INTO scheduler_orphan_worker_evidence (
            evidence_id,
            lease_id,
            workspace_id,
            thread_id,
            turn_id,
            agent_session_id,
            package_snapshot_id,
            pool_id,
            target_id,
            reason,
            scheduler_epoch,
            heartbeat_deadline,
            last_accepted_heartbeat_at,
            recorded_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          'orphan_action_center',
          'lease_action_center',
          'ws_demo',
          thread.id,
          turn.id,
          'as_orphan',
          'pkg_orphan',
          'pool_local',
          'target_local',
          'restart-heartbeat-timeout',
          9,
          timestamp,
          null,
          timestamp
        );

      const app = createAuthorizedCoreApp(coreDb, store);
      const res = await app.request(
        ...operationRequest('attention.list', { workspaceId: 'ws_demo' }, undefined)
      );
      const byId = new Map(
        ListHumanAttentionResponseSchema.parse(await res.json()).items.map((row) => [row.id, row])
      );

      const rejection = byId.get('worker-control-rejection:wcr_action_center');
      expect(rejection).toMatchObject({
        kind: 'blocked_turn',
        severity: 'risk',
        threadId: thread.id,
        turnId: turn.id,
        source: {
          type: 'worker_control_rejection',
          rejectionId: 'wcr_action_center',
          errorCode: 'worker_control_lineage_mismatch',
          httpStatus: 403,
        },
        actions: [expect.objectContaining({ kind: 'open_thread' })],
      });
      expect(JSON.stringify(rejection)).not.toContain('as_rejected');
      expect(rejection?.source).not.toHaveProperty('agentSessionId');

      const orphan = byId.get('scheduler-orphan-worker:orphan_action_center');
      expect(orphan).toMatchObject({
        kind: 'blocked_turn',
        severity: 'risk',
        threadId: thread.id,
        turnId: turn.id,
        source: {
          type: 'scheduler_orphan_worker',
          evidenceId: 'orphan_action_center',
          leaseId: 'lease_action_center',
          reason: 'restart-heartbeat-timeout',
          schedulerEpoch: 9,
        },
        actions: [expect.objectContaining({ kind: 'open_thread' })],
      });
      expect(JSON.stringify(orphan)).not.toContain('as_orphan');
      expect(orphan?.source).not.toHaveProperty('agentSessionId');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('advertises the user-input answer route for question actions', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const thread = store.createThread('ws_demo', 'Question route metadata');
    const turn = store.createTurn('ws_demo', thread.id, 'Ask before continuing', {
      kind: 'user',
      id: 'user_local',
    });
    const questionItem = store.createItem({
      id: 'it_question_route',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: 'user_local',
      userInputRequestId: 'ui_question_route',
      prompt: 'Choose the next action.',
      questions: [
        {
          id: 'next_action',
          header: 'Action',
          question: 'Which action should run next?',
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    try {
      raiseRecordedPendingRequest(store, workspaceDb.sqlite, {
        requestId: questionItem.userInputRequestId,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        raisingTurnId: turn.id,
        requestItemId: questionItem.id,
        kind: 'user-input',
        requesterKind: 'assistant',
        responsibleUserId: 'user_local',
        questions: questionItem.questions,
        questionDigest: 'digest-question-route',
        now: timestamp,
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    const app = createAuthorizedCoreApp(coreDb, store);

    const res = await app.request(
      ...operationRequest('attention.list', { workspaceId: 'ws_demo' }, undefined)
    );
    const row = ListHumanAttentionResponseSchema.parse(await res.json()).items.find(
      (item) => item.id === `question:${questionItem.userInputRequestId}`
    );

    expect(row?.actions.find((action) => action.kind === 'answer_question')).toMatchObject({
      method: 'POST',
      href: '/api/app/operations/question.answer',
    });
    coreDb.sqlite.close();
  });

  it('projects durable staged workspace reviews when artifact rows are not available', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Durable workspace review');
    const patchText = 'diff --git a/docs/loop.md b/docs/loop.md\n';
    const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;

    try {
      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordTestWorkspaceSyncReview(workspaceDb, {
          item: {
            artifactId: 'ar_missing_workspace_review',
            changeSet: {
              id: 'wcs_durable_review',
              materializationRecordId: 'wmr_durable_review',
              inputSnapshotId: 'wis_durable_review',
              workspaceId: workspace.id,
              resourceId: 'repo_default',
              strategy: 'git',
              base: { commit: 'abc123', contentDigest: null },
              head: { commit: 'def456', contentDigest: null },
              changedPaths: [{ path: 'docs/loop.md', status: 'modified', binary: false }],
              patch: {
                ref: 'artifact://patch',
                digest: patchDigest,
                bytes: Buffer.byteLength(patchText, 'utf8'),
              },
              bundle: null,
              artifactIds: ['ar_missing_workspace_review'],
              evidenceRefs: [{ kind: 'worker', ref: 'turn_durable_review' }],
              redaction: { status: 'redacted', notes: [] },
              createdAt: timestamp,
            },
            patchPayload: {
              mediaType: 'text/x-diff',
              text: patchText,
              digest: patchDigest,
              bytes: Buffer.byteLength(patchText, 'utf8'),
            },
            review: {
              id: 'swr_durable_review',
              changeSetId: 'wcs_durable_review',
              workspaceId: workspace.id,
              status: 'pending',
              staging: {
                strategy: 'git_worktree',
                ref: 'staging://workspace/wcs_durable_review',
                branch: 'openkit/review/swr_durable_review',
              },
              diffSummary: { filesChanged: 1, additions: 0, deletions: 0 },
              riskSummary: '1 changed path staged for human review.',
              validation: [{ command: 'worker', status: 'passed', ref: 'turn_durable_review' }],
              actionCenterRowId: 'workspace-review:swr_durable_review',
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          },
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      ensureLocalUser(coreDb);
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_local',
        workspaceId: workspace.id,
      });
      const app = createAppWithWorkspaceAuthority({ coreDb, store, mode: 'server' });
      const memberToken = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'user_local',
        scope: 'workspace',
        workspaceIds: [workspace.id],
        expiresAt: '2099-01-01T00:00:00.000Z',
      }).secret;
      const res = await app.request(
        ...operationRequest(
          'attention.list',
          { workspaceId: workspace.id },
          { headers: { authorization: `Bearer ${memberToken}` } }
        )
      );
      const row = ListHumanAttentionResponseSchema.parse(await res.json()).items.find(
        (item) => item.id === 'workspace-review:swr_durable_review'
      );

      expect(row).toMatchObject({
        kind: 'workspace_review',
        artifactId: 'ar_missing_workspace_review',
        title: 'Review workspace changes',
        source: {
          type: 'workspace_review',
          reviewId: 'swr_durable_review',
          changeSetId: 'wcs_durable_review',
          status: 'pending',
        },
      });
      expect(row).not.toHaveProperty('threadId');
      expect(row).not.toHaveProperty('turnId');
      const reviewHref = `/api/app/workspaces/${workspace.id}/workspace-sync/reviews/swr_durable_review`;
      const decisionHref = `${reviewHref}/decision`;
      expect(row?.actions).toEqual([
        expect.objectContaining({ kind: 'open_artifact', href: reviewHref }),
        { kind: 'accepted', label: 'Accept', method: 'POST', href: decisionHref },
        { kind: 'needs_refinement', label: 'Refine', method: 'POST', href: decisionHref },
        { kind: 'rejected', label: 'Reject', method: 'POST', href: decisionHref },
        { kind: 'blocked', label: 'Block', method: 'POST', href: decisionHref },
      ]);
      expect(row?.actions.some((action) => action.disabled)).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      origin: 'visible' as const,
      artifactId: 'ar_visible_workspace_review',
      reviewId: 'swr_visible_origin',
      expectOriginIds: true,
    },
    {
      origin: 'private' as const,
      artifactId: 'ar_private_workspace_review',
      reviewId: 'swr_private_origin',
      expectOriginIds: false,
    },
    {
      origin: 'imported' as const,
      artifactId: 'ar_imported_workspace_review',
      reviewId: 'swr_imported_origin',
      expectOriginIds: false,
    },
  ])('retains the workspace-review row and actions for $origin backing Artifact origin', async ({
    origin,
    artifactId,
    reviewId,
    expectOriginIds,
  }) => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace(`${origin} workspace review origin`);

    try {
      const backing = createWorkspaceReviewBackingArtifact(store, workspace.id, {
        artifactId,
        origin,
      });
      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordPendingWorkspaceReview(workspaceDb, {
          workspaceId: workspace.id,
          artifactId,
          reviewId,
          path: `docs/${origin}.md`,
          turnRef: backing.turnRef,
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      ensureLocalUser(coreDb);
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_local',
        workspaceId: workspace.id,
      });
      const app = createAppWithWorkspaceAuthority({ coreDb, store, mode: 'server' });
      const memberToken = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'user_local',
        scope: 'workspace',
        workspaceIds: [workspace.id],
        expiresAt: '2099-01-01T00:00:00.000Z',
      }).secret;
      const res = await app.request(
        ...operationRequest(
          'attention.list',
          { workspaceId: workspace.id },
          { headers: { authorization: `Bearer ${memberToken}` } }
        )
      );
      const row = ListHumanAttentionResponseSchema.parse(await res.json()).items.find(
        (item) => item.id === `workspace-review:${reviewId}`
      );
      const reviewHref = `/api/app/workspaces/${workspace.id}/workspace-sync/reviews/${reviewId}`;
      const decisionHref = `${reviewHref}/decision`;

      expect(row).toMatchObject({
        kind: 'workspace_review',
        artifactId,
        source: { type: 'workspace_review', reviewId, status: 'pending' },
      });
      if (expectOriginIds) {
        expect(row).toMatchObject({ threadId: backing.threadId, turnId: backing.turnId });
      } else {
        expect(row).not.toHaveProperty('threadId');
        expect(row).not.toHaveProperty('turnId');
      }
      expect(row?.actions).toEqual([
        expect.objectContaining({ kind: 'open_artifact', href: reviewHref }),
        { kind: 'accepted', label: 'Accept', method: 'POST', href: decisionHref },
        { kind: 'needs_refinement', label: 'Refine', method: 'POST', href: decisionHref },
        { kind: 'rejected', label: 'Reject', method: 'POST', href: decisionHref },
        { kind: 'blocked', label: 'Block', method: 'POST', href: decisionHref },
      ]);
      expect(row?.actions.some((action) => action.disabled)).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps contradictory Review owners inspect-only after the workspace review is resolved', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Resolved durable workspace review');
    const thread = store.createThread(workspace.id, 'Resolved workspace review worker');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Produce resolved workspace changes',
      { kind: 'user', id: 'user_local' },
      null,
      {
        turnId: 'turn_resolved',
      }
    );
    const artifactId = 'ar_workspace_changes_turn_resolved_swr_resolved';
    const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
    const artifactBody = '{}';
    const artifactRequestId = 'action-center-resolved-workspace-review-output-1';
    const artifactContentDigest = `sha256:${createHash('sha256')
      .update(artifactBody, 'utf8')
      .digest('hex')}`;
    const patchText = 'diff --git a/docs/resolved.md b/docs/resolved.md\n';
    const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;

    try {
      const artifact = store.createArtifact({
        id: artifactId,
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        kind: 'diff',
        title: 'Workspace changes ready for review',
        status: 'ready',
        summary: 'Resolved workspace changes.',
        version: 1,
        content: { format: 'json', body: artifactBody },
        contentDigest: artifactContentDigest,
        lastMutationRequestId: artifactRequestId,
        origin: {
          kind: 'turn-output',
          threadId: thread.id,
          turnId: turn.id,
          requestId: artifactRequestId,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const genericReview = createArtifactReview(workspaceDb, {
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        contentDigest: artifact.contentDigest,
        sourceThreadId: thread.id,
        sourceTurnId: turn.id,
        sourceAgentId: 'agent_codex_host',
        materialProposal: null,
        createdAt: timestamp,
      });
      recordTestWorkspaceSyncReview(workspaceDb, {
        item: {
          artifactId,
          changeSet: {
            id: 'wcs_resolved_workspace_review',
            materializationRecordId: 'wmr_resolved_workspace_review',
            inputSnapshotId: 'wis_resolved_workspace_review',
            workspaceId: workspace.id,
            resourceId: 'repo_default',
            strategy: 'git',
            base: { commit: 'abc123', contentDigest: null },
            head: { commit: 'def456', contentDigest: null },
            changedPaths: [{ path: 'docs/resolved.md', status: 'modified', binary: false }],
            patch: {
              ref: 'artifact://patch',
              digest: patchDigest,
              bytes: Buffer.byteLength(patchText, 'utf8'),
            },
            bundle: null,
            artifactIds: [artifactId],
            evidenceRefs: [{ kind: 'worker', ref: 'turn_resolved' }],
            redaction: { status: 'redacted', notes: [] },
            createdAt: timestamp,
          },
          patchPayload: {
            mediaType: 'text/x-diff',
            text: patchText,
            digest: patchDigest,
            bytes: Buffer.byteLength(patchText, 'utf8'),
          },
          review: {
            id: 'swr_resolved',
            changeSetId: 'wcs_resolved_workspace_review',
            workspaceId: workspace.id,
            status: 'pending',
            staging: {
              strategy: 'git_worktree',
              ref: 'staging://workspace/wcs_resolved_workspace_review',
              branch: 'openkit/review/swr_resolved',
            },
            diffSummary: { filesChanged: 1, additions: 0, deletions: 0 },
            riskSummary: 'Resolved workspace changes.',
            validation: [],
            actionCenterRowId: 'workspace-review:swr_resolved',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
      });
      const app = createAuthorizedCoreApp(coreDb, store);
      const pendingResponse = await app.request(
        ...operationRequest('attention.list', { workspaceId: workspace.id }, undefined)
      );
      const pendingRows = ListHumanAttentionResponseSchema.parse(
        await pendingResponse.json()
      ).items;
      const pendingWorkspaceReview = pendingRows.find(
        (row) => row.id === 'workspace-review:swr_resolved'
      );

      expect(pendingRows.map((row) => row.id)).not.toContain(
        `artifact-review:${genericReview.reviewId}`
      );
      expect(pendingWorkspaceReview?.actions[0]).toMatchObject({ kind: 'open_artifact' });
      expect(pendingWorkspaceReview?.actions[0]?.disabled).not.toBe(true);
      expect(
        pendingWorkspaceReview?.actions
          .slice(1)
          .every(
            (action) => action.disabled === true && action.reason?.includes('recovery_required')
          )
      ).toBe(true);
      updateWorkspaceSyncReviewDecision(workspaceDb, {
        requestId: 'resolve-backing-artifact',
        reviewId: 'swr_resolved',
        status: 'rejected',
        updatedAt: '2026-05-31T00:01:00.000Z',
        workspaceId: workspace.id,
      });

      const response = await app.request(
        ...operationRequest('attention.list', { workspaceId: workspace.id }, undefined)
      );
      const resolvedRows = ListHumanAttentionResponseSchema.parse(await response.json()).items;
      const rowIds = resolvedRows.map((row) => row.id);
      const resolvedWorkspaceReview = resolvedRows.find(
        (row) => row.id === 'workspace-review:swr_resolved'
      );

      expect(rowIds).not.toContain(`artifact-review:${genericReview.reviewId}`);
      expect(resolvedWorkspaceReview).toMatchObject({
        severity: 'risk',
        source: { type: 'workspace_review', status: 'rejected' },
      });
      expect(resolvedWorkspaceReview?.actions).toEqual([
        expect.objectContaining({ kind: 'open_artifact', method: 'GET' }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('projects requires-human workspace recovery rows and omits terminal reconciliation records', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Workspace recovery review');

    try {
      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordWorkspaceReconciliationRecord(workspaceDb, {
          id: 'wrr_requires_human',
          workspaceId: workspace.id,
          triggerReason: 'restart',
          affectedRecordIds: ['wmr_requires_human', 'bwh_requires_human'],
          backendHandleSummary: {
            backendKind: 'openshell',
            handleId: 'bwh_requires_human',
            workerSessionId: 'session_requires_human',
            cleanupStatus: 'pending',
          },
          backendReachability: { status: 'unavailable', checkedAt: timestamp, detail: null },
          collectedOutputManifestIds: ['wom_requires_human'],
          evidenceBundleIds: ['evb_requires_human'],
          stateBefore: 'ready',
          stateAfter: 'requires-human',
          quarantineRefs: [],
          requiredHumanDecision: 'inspect_recovery',
          retentionDecision: 'retain-backend',
          startedAt: timestamp,
          finishedAt: null,
        });
        recordWorkspaceReconciliationRecord(workspaceDb, {
          id: 'wrr_recovered',
          workspaceId: workspace.id,
          triggerReason: 'restart',
          affectedRecordIds: ['wmr_recovered'],
          backendHandleSummary: {},
          backendReachability: { status: 'reachable', checkedAt: timestamp, detail: null },
          collectedOutputManifestIds: [],
          evidenceBundleIds: [],
          stateBefore: 'requires-human',
          stateAfter: 'recovered',
          quarantineRefs: [],
          requiredHumanDecision: null,
          retentionDecision: 'teardown-backend',
          startedAt: timestamp,
          finishedAt: timestamp,
        });
      } finally {
        workspaceDb.sqlite.close();
      }

      ensureLocalUser(coreDb);
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_local',
        workspaceId: workspace.id,
      });
      const app = createAppWithWorkspaceAuthority({ coreDb, store, mode: 'server' });
      const memberToken = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'user_local',
        scope: 'workspace',
        workspaceIds: [workspace.id],
        expiresAt: '2099-01-01T00:00:00.000Z',
      }).secret;
      const res = await app.request(
        ...operationRequest(
          'attention.list',
          { workspaceId: workspace.id },
          { headers: { authorization: `Bearer ${memberToken}` } }
        )
      );
      const rows = ListHumanAttentionResponseSchema.parse(await res.json()).items;
      const row = rows.find((item) => item.id === 'workspace-recovery:wrr_requires_human');

      expect(rows.map((item) => item.id)).not.toContain('workspace-recovery:wrr_recovered');
      expect(row).toMatchObject({
        kind: 'blocked_turn',
        title: 'Workspace recovery needs review',
        summary: 'Recovery requires a human decision: inspect_recovery.',
        severity: 'blocked',
        source: {
          type: 'workspace_recovery',
          reconciliationRecordId: 'wrr_requires_human',
          workspaceId: workspace.id,
          triggerReason: 'restart',
          stateAfter: 'requires-human',
          affectedRecordIds: ['wmr_requires_human', 'bwh_requires_human'],
          evidenceBundleIds: ['evb_requires_human'],
          requiredHumanDecision: 'inspect_recovery',
        },
      });
      expect(row?.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'open_artifact',
            href: `/api/app/workspaces/${workspace.id}/workspace-sync/reconciliation-records`,
          }),
          expect.objectContaining({
            kind: 'retry_work',
            label: 'Resume collection',
            href: `/api/app/workspaces/${workspace.id}/workspace-sync/reconciliation-records/wrr_requires_human/decision`,
            method: 'POST',
          }),
          expect.objectContaining({
            kind: 'accept_review',
            label: 'Stage verified',
            href: `/api/app/workspaces/${workspace.id}/workspace-sync/reconciliation-records/wrr_requires_human/decision`,
          }),
          expect.objectContaining({
            kind: 'mark_blocked',
            label: 'Quarantine',
            href: `/api/app/workspaces/${workspace.id}/workspace-sync/reconciliation-records/wrr_requires_human/decision`,
          }),
          expect.objectContaining({
            kind: 'abort',
            label: 'Abandon',
            href: `/api/app/workspaces/${workspace.id}/workspace-sync/reconciliation-records/wrr_requires_human/decision`,
          }),
        ])
      );
      expect(row?.actions.filter((action) => action.disabled).length).toBe(0);
    } finally {
      coreDb.sqlite.close();
    }
  });
});
