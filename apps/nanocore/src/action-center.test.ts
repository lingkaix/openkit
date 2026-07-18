import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ListHumanAttentionResponseSchema,
  type WorkspaceSyncReviewItem,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { createGoalReviewRecord, resolveGoalReviewRecord } from './runtime/goal-review-records.js';
import { createGoalRecord, createGoalTask, updateGoalStatus } from './runtime/goal-store.js';
import { upsertWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import { recordWorkspaceReconciliationRecord } from './runtime/workspace-reconciliation-records.js';
import {
  recordWorkspaceSyncReview,
  updateWorkspaceSyncReviewDecision,
} from './runtime/workspace-sync-records.js';
import { createSchedulerAdmissionEntry, denySchedulerAdmissionEntry } from './scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordTestWorkspaceReviewMaterialization } from './test-support/workspace-sync.js';

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
 * Opens a migrated workspace database for action center tests.
 *
 * @param coreDb Core database whose data root owns the workspace database.
 * @param workspaceId Workspace id to open.
 * @returns Migrated workspace database handle.
 */
function openTestWorkspaceDb(coreDb: CoreDb, workspaceId: string): WorkspaceDb {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, LOCAL_USER_ID, workspaceId);
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
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

describe('action center app API', () => {
  it('rejects a missing workspace without creating its canonical directory', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspaceRoot = join(coreDb.dataRoot, 'users', LOCAL_USER_ID, 'workspaces', 'ws_missing');

    try {
      const response = await createApp({ coreDb, store }).request(
        '/api/app/workspaces/ws_missing/action-center'
      );

      expect(response.status).toBe(404);
      expect(existsSync(workspaceRoot)).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns unified human attention rows for pending approval and question gates', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Needs human input');
    const approvalTurn = store.createTurn('ws_demo', thread.id, 'Run guarded work');
    const questionTurn = store.createTurn('ws_demo', thread.id, 'Request a secret');
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
    store.updateTurn(approvalTurn.id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: approval.id,
        itemId: approvalItem.id,
      },
    });
    const questionItem = store.createItem({
      id: 'it_action_center_question',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: questionTurn.id,
      type: 'user-input-request',
      status: 'completed',
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
    store.updateTurn(questionTurn.id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'user-input',
        userInputRequestId: questionItem.userInputRequestId,
        itemId: questionItem.id,
      },
    });
    const app = createApp({ store });

    const res = await app.request('/api/app/workspaces/ws_demo/action-center');

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
        id: `question:${questionItem.id}`,
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
            reason: 'Secret answers require a future Vault-backed input contract.',
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
  });

  it('omits approval and question requests without an exact completed Gate tuple', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Invalid human input gates');
    const approvalTurn = store.createTurn('ws_demo', thread.id, 'Incomplete approval request');
    const questionTurn = store.createTurn('ws_demo', thread.id, 'Ungated question request');
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
    const approvalItem = store.createItem({
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
    store.updateTurn(approvalTurn.id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: approval.id,
        itemId: approvalItem.id,
      },
    });
    store.createItem({
      id: 'it_ungated_question',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: questionTurn.id,
      type: 'user-input-request',
      status: 'completed',
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
    const app = createApp({ store });

    const res = await app.request('/api/app/workspaces/ws_demo/action-center');

    expect(ListHumanAttentionResponseSchema.parse(await res.json())).toEqual({ items: [] });
  });

  it('omits approval and question rows after matching decisions and answers exist', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Resolved human input');
    const turn = store.createTurn('ws_demo', thread.id, 'Run guarded work');
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
      approvalRequestId: approval.id,
      decision: 'granted',
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
      userInputRequestId: 'ui_resolved',
      answers: { path: ['Use path A'] },
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const app = createApp({ store });

    const res = await app.request('/api/app/workspaces/ws_demo/action-center');

    expect(ListHumanAttentionResponseSchema.parse(await res.json())).toEqual({ items: [] });
  });

  it('projects runtime attention sources into the unified action center', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Runtime attention');
    const turn = store.createTurn('ws_demo', thread.id, 'Run goal worker');

    try {
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: turn.id,
        requestId: `req_${turn.id}`,
        requestInputHash: `sha256:${turn.id}`,
        stage: 'running_worker',
        iteration: 1,
        workerSessionId: 'worker_session_demo',
        diagnosticsSummary: 'Interrupted before terminal save.',
        now: () => timestamp,
      });
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_demo',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Ship the slice',
        objective: 'Finish the human attention slice.',
        status: 'awaiting_plan_approval',
        now: () => timestamp,
      });
      createGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_demo',
        planItemId: 'it_goal_plan_demo',
        taskId: 'task_demo',
        title: 'Implement projection',
        objective: 'Build projection helper.',
        orderIndex: 0,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['Rows are visible.'],
        contextBudgetTokens: 1024,
        resources: [],
        expectedArtifacts: [],
        verificationChecks: [{ kind: 'manual', description: 'Confirm rows are visible.' }],
        reviewPolicy: {
          required: true,
          reviewers: ['human'],
          instructions: 'Review the projected rows.',
        },
        escalationConditions: [],
        status: 'reviewing',
        now: () => timestamp,
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_demo',
        status: 'blocked',
        planItemId: 'it_goal_plan_demo',
        terminalStopReason: 'budget_exhausted',
        now: () => timestamp,
      });
      store.updateAgentHealth('ws_demo', 'agent_codex_host', {
        status: 'failed',
        message: 'Runtime binary is not available on PATH: codex.',
        checkedAt: timestamp,
      });
      store.createArtifact({
        id: 'artifact_demo',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: turn.id,
        kind: 'report',
        title: 'Worker report',
        status: 'ready',
        summary: 'Review this artifact.',
        version: 1,
        content: { format: 'markdown', body: '# Report' },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      store.createArtifact({
        id: 'ar_workspace_changes_turn_1_swr_1',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: turn.id,
        kind: 'diff',
        title: 'Workspace changes ready for review',
        status: 'ready',
        summary: '1 changed paths staged for human review.',
        version: 1,
        content: { format: 'json', body: '{"changeSet":{"id":"wcs_1"}}' },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      store.createArtifact({
        id: 'artifact_deferred',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: turn.id,
        kind: 'report',
        title: 'Deferred report',
        status: 'ready',
        summary: 'Already deferred.',
        version: 1,
        content: { format: 'markdown', body: '# Deferred' },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      store.recordArtifactReviewDecision({
        artifactId: 'artifact_deferred',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: turn.id,
        status: 'deferred',
        requestId: 'artifact-deferred-review',
        message: 'Review later.',
        decidedAt: timestamp,
        followUpTurnId: null,
        lifecycle: 'completed',
      });
      store.createKnowledgeProposal({
        id: 'knowledge_proposal_demo',
        workspaceId: 'ws_demo',
        title: 'Remember project decision',
        summary: 'Persist the Action Center decision.',
        status: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const app = createApp({ coreDb, store });

      const res = await app.request('/api/app/workspaces/ws_demo/action-center');
      const payload = ListHumanAttentionResponseSchema.parse(await res.json());
      const byId = new Map(payload.items.map((row) => [row.id, row]));

      expect(byId.get(`checkpoint:ws_demo:${thread.id}:${turn.id}`)).toBeUndefined();
      expect(byId.get(`goal:ws_demo:${thread.id}:goal_demo`)).toMatchObject({
        kind: 'budget',
        severity: 'risk',
        source: { type: 'goal', status: 'blocked' },
      });
      expect(byId.get('agent-readiness:agent_codex_host')).toMatchObject({
        kind: 'agent_readiness',
        severity: 'blocked',
      });
      expect(byId.get('artifact:artifact_demo')).toBeUndefined();
      expect(byId.get('artifact:ar_workspace_changes_turn_1_swr_1')).toBeUndefined();
      expect(byId.has('artifact:artifact_deferred')).toBe(false);
      expect(byId.get('knowledge:knowledge_proposal_demo')).toMatchObject({
        kind: 'knowledge_review',
        severity: 'needs_input',
        source: { type: 'knowledge', status: 'pending' },
        actions: expect.arrayContaining([
          expect.objectContaining({
            kind: 'accept_knowledge',
            method: 'POST',
            href: '/api/app/workspaces/ws_demo/knowledge/proposals/knowledge_proposal_demo/decision',
          }),
          expect.objectContaining({
            kind: 'reject_knowledge',
            method: 'POST',
            href: '/api/app/workspaces/ws_demo/knowledge/proposals/knowledge_proposal_demo/decision',
          }),
        ]),
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('projects scheduler admissions into the unified action center', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const queuedThread = store.createThread('ws_demo', 'Queued scheduler turn');
    const deniedThread = store.createThread('ws_demo', 'Denied scheduler turn');

    try {
      createSchedulerAdmissionEntry(coreDb, {
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

      const app = createApp({ coreDb, store });
      const res = await app.request('/api/app/workspaces/ws_demo/action-center');
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

  it('omits another user scheduler admissions when workspace ids collide', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();

    try {
      createSchedulerAdmissionEntry(coreDb, {
        queueEntryId: 'queue_other_user_action_center',
        userId: 'user_victim',
        workspaceId: 'ws_demo',
        threadId: 'thread_victim',
        turnId: 'turn_victim',
        turnInput: 'Keep another user scheduler row out of Action Center.',
        requestedAgentId: 'agent_codex_host',
        profileRef: 'agent_codex_host',
        priorityClass: 'interactive',
        requiredPoolConstraints: ['openshell.local'],
        now: () => timestamp,
      });

      const app = createApp({ coreDb, store });
      const res = await app.request('/api/app/workspaces/ws_demo/action-center');
      const items = ListHumanAttentionResponseSchema.parse(await res.json()).items;

      expect(res.status).toBe(200);
      expect(items.map((row) => row.id)).not.toContain(
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
    const turn = store.createTurn('ws_demo', thread.id, 'Recover worker');

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

      const app = createApp({ coreDb, store });
      const res = await app.request('/api/app/workspaces/ws_demo/action-center');
      const byId = new Map(
        ListHumanAttentionResponseSchema.parse(await res.json()).items.map((row) => [row.id, row])
      );

      expect(byId.get('worker-control-rejection:wcr_action_center')).toMatchObject({
        kind: 'blocked_turn',
        severity: 'risk',
        threadId: thread.id,
        turnId: turn.id,
        agentSessionId: 'as_rejected',
        source: {
          type: 'worker_control_rejection',
          rejectionId: 'wcr_action_center',
          errorCode: 'worker_control_lineage_mismatch',
          httpStatus: 403,
        },
        actions: [expect.objectContaining({ kind: 'open_thread' })],
      });
      expect(byId.get('scheduler-orphan-worker:orphan_action_center')).toMatchObject({
        kind: 'blocked_turn',
        severity: 'risk',
        threadId: thread.id,
        turnId: turn.id,
        agentSessionId: 'as_orphan',
        source: {
          type: 'scheduler_orphan_worker',
          evidenceId: 'orphan_action_center',
          leaseId: 'lease_action_center',
          reason: 'restart-heartbeat-timeout',
          schedulerEpoch: 9,
        },
        actions: [expect.objectContaining({ kind: 'open_thread' })],
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('advertises the actual turn input route for question actions', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Question route metadata');
    const turn = store.createTurn('ws_demo', thread.id, 'Ask before continuing');
    const questionItem = store.createItem({
      id: 'it_question_route',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-input-request',
      status: 'completed',
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
    store.updateTurn(turn.id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'user-input',
        userInputRequestId: questionItem.userInputRequestId,
        itemId: questionItem.id,
      },
    });
    const app = createApp({ store });

    const res = await app.request('/api/app/workspaces/ws_demo/action-center');
    const row = ListHumanAttentionResponseSchema.parse(await res.json()).items.find(
      (item) => item.id === 'question:it_question_route'
    );

    expect(row?.actions.find((action) => action.kind === 'answer_question')).toMatchObject({
      method: 'POST',
      href: '/api/turns',
    });
  });

  it('scopes Goal Review row ids by workspace, thread, and Goal', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const store = createDemoStore();
    const firstThread = store.createThread('ws_demo', 'First scoped goal');
    const secondThread = store.createThread('ws_demo', 'Second scoped goal');

    try {
      for (const thread of [firstThread, secondThread]) {
        const turn = store.createTurn('ws_demo', thread.id, 'Review duplicated ids');

        createGoalRecord(workspaceDb, {
          workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
          goalId: 'goal_duplicate',
          workspaceId: 'ws_demo',
          threadId: thread.id,
          title: 'Duplicated app-local goal',
          objective: 'Prove Action Center ids are scoped.',
          status: 'reviewing',
          now: () => timestamp,
        });
        createGoalTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_duplicate',
          planItemId: 'it_goal_plan_duplicate',
          taskId: 'task_duplicate',
          title: 'Review duplicated task',
          objective: 'Persist a review with a repeated id.',
          orderIndex: 0,
          dependsOnTaskIds: [],
          acceptanceCriteria: ['Rows are distinct.'],
          contextBudgetTokens: 1024,
          resources: [],
          expectedArtifacts: [],
          verificationChecks: [{ kind: 'manual', description: 'Confirm rows are distinct.' }],
          reviewPolicy: {
            required: true,
            reviewers: ['human'],
            instructions: 'Review the scoped row.',
          },
          escalationConditions: [],
          status: 'reviewing',
          now: () => timestamp,
        });
        updateGoalStatus(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_duplicate',
          status: 'reviewing',
          planItemId: 'it_goal_plan_duplicate',
          currentTaskId: 'task_duplicate',
          now: () => timestamp,
        });
        createGoalReviewRecord(workspaceDb, {
          reviewId: 'review_duplicate',
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_duplicate',
          taskId: 'task_duplicate',
          turnId: turn.id,
          prompt: 'Review the duplicated Task evidence.',
          createdByRequestId: `goal-step-${thread.id}`,
          now: () => timestamp,
        });
      }

      const app = createApp({ coreDb, store });
      const res = await app.request('/api/app/workspaces/ws_demo/action-center');
      const rowIds = ListHumanAttentionResponseSchema.parse(await res.json()).items.map(
        (row) => row.id
      );

      expect(rowIds).toEqual(
        expect.arrayContaining([
          `goal-review:ws_demo:${firstThread.id}:goal_duplicate:review_duplicate`,
          `goal-review:ws_demo:${secondThread.id}:goal_duplicate:review_duplicate`,
        ])
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('projects only active unresolved Goal Reviews with four executable decisions', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const store = createDemoStore();
    const activeThread = store.createThread('ws_demo', 'Active accept review');
    const inactiveGoalThread = store.createThread('ws_demo', 'Inactive goal accept review');
    const inactiveTaskThread = store.createThread('ws_demo', 'Inactive task accept review');
    const scenarios = [
      {
        id: 'active',
        thread: activeThread,
        goalStatus: 'reviewing',
        taskStatus: 'reviewing',
      },
      {
        id: 'inactive_goal',
        thread: inactiveGoalThread,
        goalStatus: 'running',
        taskStatus: 'reviewing',
      },
      {
        id: 'inactive_task',
        thread: inactiveTaskThread,
        goalStatus: 'reviewing',
        taskStatus: 'completed',
      },
    ] as const;

    try {
      for (const scenario of scenarios) {
        const turn = store.createTurn(
          'ws_demo',
          scenario.thread.id,
          `Review ${scenario.id} Goal output`
        );
        createGoalRecord(workspaceDb, {
          workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
          goalId: `goal_accept_${scenario.id}`,
          workspaceId: 'ws_demo',
          threadId: scenario.thread.id,
          title: 'Accept review goal',
          objective: 'Project only actionable accept review attention.',
          status: scenario.goalStatus,
          now: () => timestamp,
        });
        createGoalTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: scenario.thread.id,
          goalId: `goal_accept_${scenario.id}`,
          planItemId: `it_goal_plan_accept_${scenario.id}`,
          taskId: `task_accept_${scenario.id}`,
          title: 'Accept review task',
          objective: 'Expose the accept review while the task is reviewing.',
          orderIndex: 0,
          dependsOnTaskIds: [],
          acceptanceCriteria: ['The actionable review state is projected exactly once.'],
          contextBudgetTokens: 1024,
          resources: [],
          expectedArtifacts: [],
          verificationChecks: [
            { kind: 'manual', description: 'Confirm the review is projected exactly once.' },
          ],
          reviewPolicy: {
            required: true,
            reviewers: ['human'],
            instructions: 'Review the completed task.',
          },
          escalationConditions: [],
          status: scenario.taskStatus,
          now: () => timestamp,
        });
        updateGoalStatus(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: scenario.thread.id,
          goalId: `goal_accept_${scenario.id}`,
          status: scenario.goalStatus,
          planItemId: `it_goal_plan_accept_${scenario.id}`,
          currentTaskId: `task_accept_${scenario.id}`,
          now: () => timestamp,
        });
        createGoalReviewRecord(workspaceDb, {
          reviewId: `review_accept_${scenario.id}`,
          workspaceId: 'ws_demo',
          threadId: scenario.thread.id,
          goalId: `goal_accept_${scenario.id}`,
          taskId: `task_accept_${scenario.id}`,
          turnId: turn.id,
          prompt: 'Review the completed worker output.',
          createdByRequestId: `goal-step-${scenario.id}`,
          now: () => timestamp,
        });
      }

      const app = createApp({ coreDb, store });
      const res = await app.request('/api/app/workspaces/ws_demo/action-center');
      const reviewRows = ListHumanAttentionResponseSchema.parse(await res.json()).items.filter(
        (row) => row.source.type === 'goal_review'
      );
      const decisionHref = `/api/app/workspaces/ws_demo/threads/${activeThread.id}/goals/goal_accept_active/reviews/review_accept_active/decision`;

      expect(reviewRows).toEqual([
        expect.objectContaining({
          id: `goal-review:ws_demo:${activeThread.id}:goal_accept_active:review_accept_active`,
          source: expect.objectContaining({
            type: 'goal_review',
            reviewId: 'review_accept_active',
          }),
          actions: [
            {
              kind: 'accept_review',
              label: 'Accept review',
              method: 'POST',
              href: decisionHref,
            },
            {
              kind: 'request_refinement',
              label: 'Request refinement',
              method: 'POST',
              href: decisionHref,
            },
            {
              kind: 'retry_work',
              label: 'Retry work',
              method: 'POST',
              href: decisionHref,
            },
            {
              kind: 'abort',
              label: 'Abort goal',
              method: 'POST',
              href: decisionHref,
            },
          ],
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('omits resolved goal review rows', async () => {
    const coreDb = createCoreDb();
    const workspaceDb = openTestWorkspaceDb(coreDb, 'ws_demo');
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Resolved goal review');
    const turn = store.createTurn('ws_demo', thread.id, 'Review then resolve');

    try {
      const goal = createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_resolved_review',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Resolved review goal',
        objective: 'Hide resolved review attention.',
        status: 'reviewing',
        currentTaskId: 'task_resolved_review',
        now: () => timestamp,
      });
      const task = createGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_resolved_review',
        planItemId: 'it_goal_plan_resolved_review',
        taskId: 'task_resolved_review',
        title: 'Resolved review task',
        objective: 'Resolve the review row.',
        orderIndex: 0,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['Resolved rows are hidden.'],
        contextBudgetTokens: 1024,
        resources: [],
        expectedArtifacts: [],
        verificationChecks: [{ kind: 'manual', description: 'Confirm resolved rows are hidden.' }],
        reviewPolicy: {
          required: true,
          reviewers: ['human'],
          instructions: 'Review the completed task.',
        },
        escalationConditions: [],
        status: 'reviewing',
        now: () => timestamp,
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_resolved_review',
        status: 'reviewing',
        planItemId: 'it_goal_plan_resolved_review',
        currentTaskId: 'task_resolved_review',
        now: () => timestamp,
      });
      createGoalReviewRecord(workspaceDb, {
        reviewId: 'review_resolved_attention',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_resolved_review',
        taskId: 'task_resolved_review',
        turnId: turn.id,
        prompt: 'Review the completed worker output.',
        createdByRequestId: 'goal-step-resolved',
        now: () => timestamp,
      });
      resolveGoalReviewRecord(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_resolved_review',
        reviewId: 'review_resolved_attention',
        requestId: 'resolution-request-1',
        actorId: 'user_demo',
        verdict: 'accept',
        resolutionSnapshot: {
          outcome: 'complete_goal',
          task: { taskId: task.taskId, status: 'completed' },
          goal: {
            goalId: goal.goalId,
            status: 'completed',
            currentTaskId: null,
            terminalStopReason: 'completed',
          },
          nextReadyTaskId: null,
        },
        now: () => timestamp,
      });

      const app = createApp({ coreDb, store });
      const res = await app.request('/api/app/workspaces/ws_demo/action-center');
      const rowIds = ListHumanAttentionResponseSchema.parse(await res.json()).items.map(
        (row) => row.id
      );

      expect(rowIds).not.toContain(
        `goal-review:ws_demo:${thread.id}:goal_resolved_review:review_resolved_attention`
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
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

      const app = createApp({ coreDb, store });
      const res = await app.request(`/api/app/workspaces/${workspace.id}/action-center`);
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

  it('omits backing artifact rows after a durable workspace review is resolved', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore();
    const workspace = store.createWorkspace('Resolved durable workspace review');
    const artifactId = 'ar_workspace_changes_turn_resolved_swr_resolved';
    const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
    const patchText = 'diff --git a/docs/resolved.md b/docs/resolved.md\n';
    const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;

    try {
      store.createArtifact({
        id: artifactId,
        workspaceId: workspace.id,
        threadId: null,
        turnId: null,
        kind: 'diff',
        title: 'Workspace changes ready for review',
        status: 'ready',
        summary: 'Resolved workspace changes.',
        version: 1,
        content: { format: 'json', body: '{}' },
        createdAt: timestamp,
        updatedAt: timestamp,
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
      updateWorkspaceSyncReviewDecision(workspaceDb, {
        requestId: 'resolve-backing-artifact',
        reviewId: 'swr_resolved',
        status: 'rejected',
        updatedAt: '2026-05-31T00:01:00.000Z',
        workspaceId: workspace.id,
      });

      const app = createApp({ coreDb, store });
      const response = await app.request(`/api/app/workspaces/${workspace.id}/action-center`);
      const rowIds = ListHumanAttentionResponseSchema.parse(await response.json()).items.map(
        (row) => row.id
      );

      expect(rowIds).not.toContain(`artifact:${artifactId}`);
      expect(rowIds).not.toContain('workspace-review:swr_resolved');
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

      const app = createApp({ coreDb, store });
      const res = await app.request(`/api/app/workspaces/${workspace.id}/action-center`);
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
