import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListHumanAttentionResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createGoalReviewRecord, resolveGoalReviewRecord } from './runtime/goal-review-records.js';
import { createGoalRecord, createGoalTask, updateGoalStatus } from './runtime/goal-store.js';
import { enqueuePendingUserTurn } from './runtime/pending-user-turns.js';
import { upsertWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import { recordWorkspaceReconciliationRecord } from './runtime/workspace-reconciliation-records.js';
import { recordWorkspaceSyncReview } from './runtime/workspace-sync-records.js';
import { createSchedulerAdmissionEntry, denySchedulerAdmissionEntry } from './scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';

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

describe('action center app API', () => {
  it('returns unified human attention rows for pending approval and question gates', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Needs human input');
    const turn = store.createTurn('ws_demo', thread.id, 'Run guarded work');
    const approval = store.createApproval({
      id: 'ap_action_center',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
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
      turnId: turn.id,
      type: 'approval-request',
      status: 'in_progress',
      approvalRequestId: approval.id,
      title: approval.title,
      description: approval.description,
      kind: approval.kind,
      createdAt: timestamp,
      completedAt: null,
    });
    const questionItem = store.createItem({
      id: 'it_action_center_question',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-input-request',
      status: 'in_progress',
      userInputRequestId: 'ui_action_center',
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
      completedAt: null,
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
        turnId: turn.id,
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
        turnId: turn.id,
        itemId: questionItem.id,
        title: 'Answer required',
        severity: 'needs_input',
        source: expect.objectContaining({ type: 'protocol_item', itemId: questionItem.id }),
      }),
    ]);

    expect((await app.request('/api/app/workspaces/ws_demo/action-center/approvals')).status).toBe(
      404
    );
    expect((await app.request('/api/app/workspaces/ws_demo/action-center/questions')).status).toBe(
      404
    );
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
      const pendingItem = store.createItem({
        id: 'it_pending_input',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: turn.id,
        type: 'user-message',
        status: 'completed',
        text: 'Queued steering',
        createdAt: timestamp,
        completedAt: timestamp,
      });
      enqueuePendingUserTurn(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        requestId: 'req_pending',
        contentItemId: pendingItem.id,
        queueMode: 'safe_point_steering',
        receivedAt: timestamp,
      });
      upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        turnId: turn.id,
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
        taskId: 'task_demo',
        title: 'Implement projection',
        objective: 'Build projection helper.',
        orderIndex: 0,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['Rows are visible.'],
        contextBudgetTokens: 1024,
        status: 'reviewing',
        now: () => timestamp,
      });
      createGoalReviewRecord(workspaceDb, {
        reviewId: 'review_demo',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_demo',
        taskId: 'task_demo',
        turnId: turn.id,
        artifactIds: ['artifact_demo'],
        verdict: 'refine',
        reason: 'Needs refinement.',
        now: () => timestamp,
      });
      updateGoalStatus(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_demo',
        status: 'blocked',
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

      expect(byId.get(`pending-input:ws_demo:${thread.id}:req_pending`)).toMatchObject({
        kind: 'pending_input',
        severity: 'info',
        source: { type: 'pending_user_turn', queueMode: 'safe_point_steering' },
        actions: [
          expect.objectContaining({ kind: 'open_thread' }),
          expect.objectContaining({
            href: `/api/app/workspaces/ws_demo/threads/${thread.id}/recovery/pending-user-turns/req_pending/edit`,
            kind: 'edit_pending_input',
            method: 'POST',
          }),
          expect.objectContaining({
            href: `/api/app/workspaces/ws_demo/threads/${thread.id}/recovery/pending-user-turns/req_pending/follow-up`,
            kind: 'convert_pending_input_to_follow_up',
            method: 'POST',
          }),
          expect.objectContaining({
            href: `/api/app/workspaces/ws_demo/threads/${thread.id}/recovery/pending-user-turns/req_pending/interrupt`,
            kind: 'promote_pending_input_to_interrupt',
            method: 'POST',
          }),
          expect.objectContaining({
            href: `/api/app/workspaces/ws_demo/threads/${thread.id}/recovery/pending-user-turns/req_pending/cancel`,
            kind: 'cancel_pending_input',
            method: 'POST',
          }),
        ],
      });
      expect(byId.get(`checkpoint:ws_demo:${thread.id}:${turn.id}`)).toMatchObject({
        kind: 'checkpoint_recovery',
        severity: 'blocked',
        source: { type: 'worker_checkpoint', stage: 'running_worker' },
        actions: expect.arrayContaining([
          expect.objectContaining({
            href: `/api/app/workspaces/ws_demo/threads/${thread.id}/recovery/interrupted-worker/${turn.id}/retry`,
            kind: 'retry_from_checkpoint',
            method: 'POST',
          }),
          expect.objectContaining({
            href: `/api/app/workspaces/ws_demo/threads/${thread.id}/recovery/interrupted-worker/${turn.id}/terminal`,
            kind: 'clear_checkpoint',
            method: 'POST',
          }),
        ]),
      });
      expect(byId.get(`checkpoint:ws_demo:${thread.id}:${turn.id}`)?.actions).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'resume_from_checkpoint' })])
      );
      expect(byId.get(`goal:ws_demo:${thread.id}:goal_demo`)).toMatchObject({
        kind: 'budget',
        severity: 'risk',
        source: { type: 'goal', status: 'blocked' },
      });
      expect(byId.get(`goal-review:ws_demo:${thread.id}:goal_demo:review_demo`)).toMatchObject({
        kind: 'artifact_review',
        severity: 'needs_input',
        artifactId: 'artifact_demo',
        source: { type: 'goal_review', verdict: 'refine' },
      });
      expect(byId.get('agent-readiness:agent_codex_host')).toMatchObject({
        kind: 'agent_readiness',
        severity: 'blocked',
      });
      expect(byId.get('artifact:artifact_demo')).toMatchObject({
        kind: 'artifact_review',
        severity: 'needs_input',
        source: { type: 'artifact', reviewStatus: 'pending' },
      });
      expect(byId.get('artifact:ar_workspace_changes_turn_1_swr_1')).toMatchObject({
        kind: 'workspace_review',
        severity: 'needs_input',
        source: { type: 'artifact', reviewStatus: 'pending' },
      });
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
    store.createItem({
      id: 'it_question_route',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-input-request',
      status: 'in_progress',
      userInputRequestId: 'ui_question_route',
      prompt: 'Choose the next action.',
      questions: [],
      createdAt: timestamp,
      completedAt: null,
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

  it('scopes goal and goal review row ids by workspace, thread, and goal', async () => {
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
          status: 'blocked',
          terminalStopReason: 'error',
          now: () => timestamp,
        });
        createGoalTask(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_duplicate',
          taskId: 'task_duplicate',
          title: 'Review duplicated task',
          objective: 'Persist a review with a repeated id.',
          orderIndex: 0,
          dependsOnTaskIds: [],
          acceptanceCriteria: ['Rows are distinct.'],
          contextBudgetTokens: 1024,
          status: 'reviewing',
          now: () => timestamp,
        });
        createGoalReviewRecord(workspaceDb, {
          reviewId: 'review_duplicate',
          workspaceId: 'ws_demo',
          threadId: thread.id,
          goalId: 'goal_duplicate',
          taskId: 'task_duplicate',
          turnId: turn.id,
          verdict: 'retry',
          reason: 'Retry within the duplicated scope.',
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
          `goal:ws_demo:${firstThread.id}:goal_duplicate`,
          `goal:ws_demo:${secondThread.id}:goal_duplicate`,
          `goal-review:ws_demo:${firstThread.id}:goal_duplicate:review_duplicate`,
          `goal-review:ws_demo:${secondThread.id}:goal_duplicate:review_duplicate`,
        ])
      );
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
      createGoalRecord(workspaceDb, {
        workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
        goalId: 'goal_resolved_review',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        title: 'Resolved review goal',
        objective: 'Hide resolved review attention.',
        status: 'reviewing',
        now: () => timestamp,
      });
      createGoalTask(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_resolved_review',
        taskId: 'task_resolved_review',
        title: 'Resolved review task',
        objective: 'Resolve the review row.',
        orderIndex: 0,
        dependsOnTaskIds: [],
        acceptanceCriteria: ['Resolved rows are hidden.'],
        contextBudgetTokens: 1024,
        status: 'reviewing',
        now: () => timestamp,
      });
      createGoalReviewRecord(workspaceDb, {
        reviewId: 'review_resolved_attention',
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_resolved_review',
        taskId: 'task_resolved_review',
        turnId: turn.id,
        verdict: 'retry',
        reason: 'Retry was already accepted.',
        now: () => timestamp,
      });
      resolveGoalReviewRecord(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        goalId: 'goal_resolved_review',
        reviewId: 'review_resolved_attention',
        requestId: 'resolution-request-1',
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

    try {
      const workspaceDb = openTestWorkspaceDb(coreDb, workspace.id);
      try {
        recordWorkspaceSyncReview(workspaceDb, {
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
              patch: { ref: 'artifact://patch', digest: 'sha256:patch', bytes: 42 },
              bundle: null,
              artifactIds: ['ar_missing_workspace_review'],
              evidenceRefs: [{ kind: 'worker', ref: 'turn_durable_review' }],
              redaction: { status: 'redacted', notes: [] },
              createdAt: timestamp,
            },
            patchPayload: {
              mediaType: 'text/x-diff',
              text: 'diff --git a/docs/loop.md b/docs/loop.md\n',
              digest: 'sha256:patch',
              bytes: 42,
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
      expect(row?.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'open_artifact',
            href: `/api/app/workspaces/${workspace.id}/workspace-sync/reviews/swr_durable_review`,
          }),
          expect.objectContaining({
            kind: 'accept_review',
            href: `/api/app/workspaces/${workspace.id}/workspace-sync/reviews/swr_durable_review/decision`,
          }),
          expect.objectContaining({
            kind: 'defer',
            label: 'Block',
            href: `/api/app/workspaces/${workspace.id}/workspace-sync/reviews/swr_durable_review/decision`,
          }),
        ])
      );
      expect(row?.actions.some((action) => action.disabled)).toBe(false);
    } finally {
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
