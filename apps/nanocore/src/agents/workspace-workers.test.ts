import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceWorkersResponseSchema } from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { WorkspaceResourcesResponseSchema } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import * as usageLedger from '../capability/usage-ledger.js';
import { recordUsage, startCapabilityCall } from '../capability/usage-ledger.js';
import type { FsStore } from '../lib/store.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from '../runtime/agent-environment.js';
import * as goalStore from '../runtime/goal-store.js';
import * as workerCheckpoints from '../runtime/worker-checkpoints.js';
import { clearWorkerCheckpoint, upsertWorkerCheckpoint } from '../runtime/worker-checkpoints.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';

const timestamp = '2026-09-17T02:00:00.000Z';
const digest = `sha256:${'a'.repeat(64)}`;

/**
 * Opens a migrated Core database for current Worker route tests.
 *
 * @returns Migrated Core database handle.
 */
function createCoreDb(): CoreDb {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-workspace-workers-')));
  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Opens a migrated workspace database for current Worker route tests.
 *
 * @param coreDb Core database whose data root owns the workspace database.
 * @returns Migrated workspace database handle.
 */
function openTestWorkspaceDb(coreDb: CoreDb): WorkspaceDb {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/**
 * Authorizes the local actor and returns a NanoCore app for the fixture store.
 *
 * @param coreDb Core database that owns authorization facts.
 * @param store Test store whose Workspaces need canonical owner membership.
 * @param agentId Optional catalog Agent id to project as configured supply.
 * @returns NanoCore test app with local Workspace access.
 */
function createAuthorizedApp(
  coreDb: CoreDb,
  store: FsStore,
  agentId = 'agent_codex_host'
): ReturnType<typeof createApp> {
  ensureLocalUser(coreDb);
  for (const workspace of store.listWorkspaces()) {
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
  }
  return createApp({
    agentManifests: [
      createTestAgentSetup({
        agentId,
        displayName: 'Codex',
        logicalModelId: 'openai/gpt-catalog',
      }).manifest,
    ],
    coreDb,
    store,
  });
}

/**
 * Creates one current AgentSession bound to a Thread and Turn.
 *
 * @param store Product store that owns sessions and Turns.
 * @param input Thread, Turn, Agent, and session identity.
 * @returns Created AgentSession.
 */
function createCurrentWorkerSession(
  store: FsStore,
  input: {
    readonly agentId: string;
    readonly sessionId: string;
    readonly status?: 'busy' | 'idle';
    readonly threadId: string;
    readonly turnId: string;
  }
) {
  const turn = store.createTurn(
    'ws_demo',
    input.threadId,
    'Worker turn',
    {
      kind: 'user',
      id: 'user_local',
    },
    null,
    { startedAt: timestamp, turnId: input.turnId }
  );
  const session = store.createAgentSession({
    agentId: input.agentId,
    createdAt: timestamp,
    id: input.sessionId,
    message: null,
    status: input.status ?? 'busy',
    threadId: input.threadId,
    updatedAt: timestamp,
    workspaceId: 'ws_demo',
  });
  store.updateTurn(turn.id, { agentId: input.agentId, agentSessionId: session.id });
  return session;
}

/**
 * Records one exact current package snapshot for a Worker session.
 *
 * @param workspaceDb Workspace database that owns the snapshot.
 * @param input Session, Turn, and product-safe package fields.
 * @returns Recorded package snapshot id.
 */
function recordWorkerPackage(
  workspaceDb: WorkspaceDb,
  input: {
    readonly agentId: string;
    readonly displayName: string;
    readonly omitProcess?: boolean;
    readonly preferredLogicalModelId: string;
    readonly sessionId: string;
    readonly threadId: string;
    readonly turnId: string;
  }
): string {
  const setup = createTestAgentSetup({
    agentId: input.agentId,
    displayName: input.displayName,
    logicalModelId: input.preferredLogicalModelId,
  });
  const environmentPackage = AgentEnvironmentPackageSchema.parse({
    ...resolveAgentEnvironmentPackage({
      agent: {
        capabilities: [],
        config: {
          adapterType: 'codex',
          baseUrl: null,
          capabilities: [],
          command: null,
          environment: { OPENAI_API_KEY: 'sk-secret-must-not-leak' },
          workspaceRoot: '/secret/host/path',
        },
        defaultProfileId: 'default',
        health: { checkedAt: null, message: null, status: 'unknown' },
        id: input.agentId,
        kind: 'coder',
        modelId: 'openai/gpt-catalog',
        name: input.displayName,
        profiles: [
          {
            capabilityIds: [],
            displayName: 'Default',
            id: 'default',
            instructionsRef: null,
            modelId: null,
            skillIds: [],
          },
        ],
        sandboxSummary: null,
        skillIds: [],
        status: 'enabled',
      },
      agentSetup: setup,
      agentSessionId: input.sessionId,
      backend: { kind: 'openshell' },
      requestId: `req_${input.turnId}`,
      triggerActor: { kind: 'user', id: 'user_local' },
      turn: {
        completedAt: null,
        configVersion: null,
        durationMs: null,
        error: null,
        humanGate: null,
        id: input.turnId,
        items: [],
        startedAt: timestamp,
        status: 'running',
        threadId: input.threadId,
        triggerActor: { kind: 'user', id: 'user_local' },
        workspaceId: 'ws_demo',
      },
      turnInput: 'Run the Worker',
      workspaceCwd: '/secret/host/path',
      workspaceRoots: [],
    }),
    supply: {
      mcpServers: [
        {
          allowedTools: ['list_issues'],
          approvalRequiredTools: ['create_issue'],
          catalogDigest: digest,
          deniedTools: ['delete_repo'],
          id: 'github',
          pinnedSchemaSnapshotId: null,
          schemaPolicy: 'pinned',
        },
      ],
      services: [],
      skills: [],
    },
  } satisfies AgentEnvironmentPackage);
  if (input.omitProcess) {
    delete environmentPackage.policy.process;
  }
  recordAgentEnvironmentPackageSnapshot(workspaceDb, {
    createdAt: timestamp,
    environmentPackage,
  });
  return environmentPackage.snapshotId;
}

/**
 * Records one LLM usage row for a Worker session.
 *
 * @param workspaceDb Workspace database that owns the ledger.
 * @param input Session, Turn, and model attribution.
 */
function recordSessionLlmUsage(
  workspaceDb: WorkspaceDb,
  input: {
    readonly agentId: string;
    readonly callId: string;
    readonly family?: 'llm' | 'mcp';
    readonly modelId: string | null;
    readonly recordedAt: string;
    readonly requestId: string;
    readonly sessionId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly usageId: string;
  }
): void {
  const call = startCapabilityCall({
    agentId: input.agentId,
    agentSessionId: input.sessionId,
    authorityActor: { kind: 'user', id: 'user_local' },
    callId: input.callId,
    capabilityId: 'llm.responses',
    family: input.family ?? 'llm',
    now: new Date(input.recordedAt),
    operation: 'responses.create',
    redactionClass: 'metadata-only',
    requestId: input.requestId,
    threadId: input.threadId,
    turnId: input.turnId,
    workspaceDb,
    workspaceId: 'ws_demo',
  });
  recordUsage({
    call,
    now: new Date(input.recordedAt),
    records: [
      {
        category: 'llm',
        modelId: input.modelId,
        quantity: 8,
        source: 'provider-reported',
        unit: 'tokens',
        usageId: input.usageId,
      },
    ],
    workspaceDb,
  });
}

describe('workspace workers route', () => {
  it('keeps catalog-only supply and internal-role Turns out of current Worker inventory', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const thread = store.createThread('ws_demo', 'Assistant conversation');
    const turn = store.createTurn('ws_demo', thread.id, 'Hello', {
      kind: 'user',
      id: 'user_local',
    });
    store.updateTurn(turn.id, { agentId: 'quick-chat' });
    const app = createAuthorizedApp(coreDb, store);

    try {
      const workersRes = await app.request('/api/app/workspaces/ws_demo/workers');
      const resourcesRes = await app.request('/api/workspaces/ws_demo/resources');
      const workers = WorkspaceWorkersResponseSchema.parse(await workersRes.json());
      const resources = WorkspaceResourcesResponseSchema.parse(await resourcesRes.json());

      expect(workersRes.status).toBe(200);
      expect(workers).toEqual({ workspaceId: 'ws_demo', items: [] });
      expect(resources.agents.map((agent) => agent.id)).toContain('agent_codex_host');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('projects Thread-keyed current Workers with exact checkpoint Task and Goal and omits hidden Threads before dependent reads', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const goalThread = store.createThread('ws_demo', 'Goal Worker');
    const taskThread = store.createThread('ws_demo', 'Task Worker');
    const hiddenThread = store.createThread(
      'ws_demo',
      'SECRET_PRIVATE_WORKER',
      undefined,
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'user_outsider' }
    );
    const goalSession = createCurrentWorkerSession(store, {
      agentId: 'agent_codex_host',
      sessionId: 'as_goal_worker',
      threadId: goalThread.id,
      turnId: 'turn_goal_worker',
    });
    const taskSession = createCurrentWorkerSession(store, {
      agentId: 'agent_codex_host',
      sessionId: 'as_task_worker',
      threadId: taskThread.id,
      turnId: 'turn_task_worker',
    });
    createCurrentWorkerSession(store, {
      agentId: 'agent_codex_host',
      sessionId: 'as_hidden_worker',
      threadId: hiddenThread.id,
      turnId: 'turn_hidden_worker',
    });
    const workspaceDb = openTestWorkspaceDb(coreDb);
    try {
      upsertWorkerCheckpoint(workspaceDb, {
        goalId: 'goal_exact',
        iteration: 1,
        now: () => timestamp,
        requestId: '00000000-0000-4000-8000-000000000301',
        requestInputHash: digest,
        stage: 'running_worker',
        taskId: 'task_exact',
        threadId: goalThread.id,
        turnId: 'turn_goal_worker',
        workerSessionId: goalSession.id,
        workspaceId: 'ws_demo',
      });
      upsertWorkerCheckpoint(workspaceDb, {
        goalId: null,
        iteration: 1,
        now: () => timestamp,
        requestId: '00000000-0000-4000-8000-000000000302',
        requestInputHash: digest,
        stage: 'running_worker',
        taskId: null,
        threadId: taskThread.id,
        turnId: 'turn_task_worker',
        workerSessionId: taskSession.id,
        workspaceId: 'ws_demo',
      });
      upsertWorkerCheckpoint(workspaceDb, {
        goalId: 'goal_hidden',
        iteration: 1,
        now: () => timestamp,
        requestId: '00000000-0000-4000-8000-000000000303',
        requestInputHash: digest,
        stage: 'running_worker',
        taskId: 'task_hidden',
        threadId: hiddenThread.id,
        turnId: 'turn_hidden_worker',
        workerSessionId: 'as_hidden_worker',
        workspaceId: 'ws_demo',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    const app = createAuthorizedApp(coreDb, store);
    const listedGoals = vi.spyOn(goalStore, 'listGoalRecordsForThread');
    const exportCheckpoints = vi.spyOn(workerCheckpoints, 'listExportableWorkerCheckpoints');
    const listCheckpoints = vi.spyOn(workerCheckpoints, 'listThreadWorkerCheckpoints');

    try {
      const response = await app.request('/api/app/workspaces/ws_demo/workers');
      const body = WorkspaceWorkersResponseSchema.parse(await response.json());
      const publicJson = JSON.stringify(body);

      expect(response.status).toBe(200);
      expect(body.items.map((item) => item.threadId).sort()).toEqual(
        [goalThread.id, taskThread.id].sort()
      );
      expect(body.items.find((item) => item.threadId === goalThread.id)).toMatchObject({
        agentId: 'agent_codex_host',
        agentName: 'Codex',
        status: 'busy',
        threadTitle: 'Goal Worker',
        work: {
          goalId: 'goal_exact',
          kind: 'goal',
          taskId: 'task_exact',
          turnId: 'turn_goal_worker',
        },
      });
      expect(body.items.find((item) => item.threadId === taskThread.id)?.work).toEqual({
        kind: 'task',
        turnId: 'turn_task_worker',
      });
      expect(publicJson).not.toContain('SECRET_PRIVATE_WORKER');
      expect(publicJson).not.toContain('as_goal_worker');
      expect(publicJson).not.toContain('agentSessionId');
      expect(listedGoals).not.toHaveBeenCalled();
      expect(exportCheckpoints).not.toHaveBeenCalled();
      expect(listCheckpoints.mock.calls.some((call) => call[2] === hiddenThread.id)).toBe(false);

      const secondTurn = store.createTurn('ws_demo', goalThread.id, 'Another turn', {
        kind: 'user',
        id: 'user_local',
      });
      store.updateTurn(secondTurn.id, {
        agentId: goalSession.agentId,
        agentSessionId: goalSession.id,
      });
      const duplicateDb = openTestWorkspaceDb(coreDb);
      try {
        upsertWorkerCheckpoint(duplicateDb, {
          goalId: 'goal_exact',
          taskId: 'task_exact',
          iteration: 1,
          requestId: '00000000-0000-4000-8000-000000000399',
          requestInputHash: digest,
          stage: 'running_worker',
          threadId: goalThread.id,
          turnId: secondTurn.id,
          workerSessionId: goalSession.id,
          workspaceId: 'ws_demo',
        });
      } finally {
        duplicateDb.sqlite.close();
      }
      const ambiguous = await app.request('/api/app/workspaces/ws_demo/workers');
      expect(ambiguous.status).toBe(200);
      const ambiguousBody = WorkspaceWorkersResponseSchema.parse(await ambiguous.json());
      expect(ambiguousBody.items.find((item) => item.threadId === goalThread.id)?.work).toEqual({
        kind: 'unavailable',
      });
    } finally {
      listedGoals.mockRestore();
      exportCheckpoints.mockRestore();
      listCheckpoints.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('keeps a removed-catalog Agent visible and omits terminal predecessors, prelaunch, idle history, and incomplete lineage', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const liveThread = store.createThread('ws_demo', 'Removed catalog Worker');
    const closedThread = store.createThread('ws_demo', 'Closed predecessor');
    const idleThread = store.createThread('ws_demo', 'Idle Worker');
    const prelaunchThread = store.createThread('ws_demo', 'Prelaunch Worker');
    const halfNullThread = store.createThread('ws_demo', 'Half null Worker');
    const liveSession = createCurrentWorkerSession(store, {
      agentId: 'agent_removed_codex',
      sessionId: 'as_removed_live',
      threadId: liveThread.id,
      turnId: 'turn_removed_live',
    });
    store.createAgentSession({
      agentId: 'agent_removed_codex',
      createdAt: timestamp,
      id: 'as_closed_predecessor',
      message: null,
      status: 'closed',
      threadId: closedThread.id,
      updatedAt: timestamp,
      workspaceId: 'ws_demo',
    });
    const idleSession = createCurrentWorkerSession(store, {
      agentId: 'agent_removed_codex',
      sessionId: 'as_idle_worker',
      status: 'idle',
      threadId: idleThread.id,
      turnId: 'turn_idle_worker',
    });
    const prelaunchSession = createCurrentWorkerSession(store, {
      agentId: 'agent_removed_codex',
      sessionId: 'as_prelaunch_worker',
      threadId: prelaunchThread.id,
      turnId: 'turn_prelaunch_worker',
    });
    const halfNullSession = createCurrentWorkerSession(store, {
      agentId: 'agent_removed_codex',
      sessionId: 'as_half_null_worker',
      threadId: halfNullThread.id,
      turnId: 'turn_half_null_worker',
    });
    const workspaceDb = openTestWorkspaceDb(coreDb);
    try {
      const snapshotId = recordWorkerPackage(workspaceDb, {
        agentId: 'agent_removed_codex',
        displayName: 'Retired Codex',
        omitProcess: true,
        preferredLogicalModelId: 'openai/gpt-preferred',
        sessionId: liveSession.id,
        threadId: liveThread.id,
        turnId: 'turn_removed_live',
      });
      store.updateAgentSession(liveSession.id, { environmentPackageSnapshotId: snapshotId });
      upsertWorkerCheckpoint(workspaceDb, {
        goalId: 'goal_removed',
        iteration: 1,
        now: () => timestamp,
        requestId: '00000000-0000-4000-8000-000000000304',
        requestInputHash: digest,
        stage: 'running_worker',
        taskId: 'task_removed',
        threadId: liveThread.id,
        turnId: 'turn_removed_live',
        workerSessionId: liveSession.id,
        workspaceId: 'ws_demo',
      });
      upsertWorkerCheckpoint(workspaceDb, {
        goalId: 'goal_prelaunch',
        iteration: 1,
        now: () => timestamp,
        requestId: '00000000-0000-4000-8000-000000000305',
        requestInputHash: digest,
        stage: 'preparing',
        taskId: 'task_prelaunch',
        threadId: prelaunchThread.id,
        turnId: 'turn_prelaunch_worker',
        workerSessionId: null,
        workspaceId: 'ws_demo',
      });
      upsertWorkerCheckpoint(workspaceDb, {
        goalId: 'goal_half',
        iteration: 1,
        now: () => timestamp,
        requestId: '00000000-0000-4000-8000-000000000306',
        requestInputHash: digest,
        stage: 'running_worker',
        taskId: null,
        threadId: halfNullThread.id,
        turnId: 'turn_half_null_worker',
        workerSessionId: halfNullSession.id,
        workspaceId: 'ws_demo',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    const app = createApp({
      agentManifests: [
        createTestAgentSetup({
          agentId: 'agent_other_supply',
          displayName: 'Other Supply',
        }).manifest,
      ],
      coreDb,
      store,
    });

    try {
      const response = await app.request('/api/app/workspaces/ws_demo/workers');
      const body = WorkspaceWorkersResponseSchema.parse(await response.json());
      const byThread = Object.fromEntries(body.items.map((item) => [item.threadId, item]));

      expect(response.status).toBe(200);
      expect(byThread[liveThread.id]).toMatchObject({
        agentId: 'agent_removed_codex',
        agentName: 'Retired Codex',
        work: {
          goalId: 'goal_removed',
          kind: 'goal',
          taskId: 'task_removed',
          turnId: 'turn_removed_live',
        },
      });
      expect(byThread[closedThread.id]).toBeUndefined();
      expect(byThread[liveThread.id]?.packageDetails).toMatchObject({
        kind: 'available',
        process: null,
      });
      expect(byThread[idleThread.id]?.work).toEqual({ kind: 'none' });
      expect(byThread[prelaunchThread.id]?.work).toEqual({ kind: 'none' });
      expect(byThread[halfNullThread.id]?.work).toEqual({ kind: 'unavailable' });
      expect(idleSession.id).toBe('as_idle_worker');
      expect(prelaunchSession.id).toBe('as_prelaunch_worker');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('reports missing Turns and conflicting checkpoint session lineage as unavailable', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const thread = store.createThread('ws_demo', 'Incomplete worker');
    const session = createCurrentWorkerSession(store, {
      agentId: 'agent_codex_host',
      sessionId: 'as_incomplete',
      threadId: thread.id,
      turnId: 'turn_incomplete',
    });
    const app = createAuthorizedApp(coreDb, store);
    const workspaceDb = openTestWorkspaceDb(coreDb);
    try {
      for (const [turnId, workerSessionId] of [
        ['turn_missing', session.id],
        ['turn_incomplete', 'as_other'],
      ]) {
        upsertWorkerCheckpoint(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: thread.id,
          turnId: turnId!,
          workerSessionId: workerSessionId!,
          goalId: null,
          taskId: null,
          iteration: 1,
          stage: 'running_worker',
          requestId: '00000000-0000-4000-8000-000000000398',
          requestInputHash: digest,
        });
        const response = await app.request('/api/app/workspaces/ws_demo/workers');
        expect(response.status).toBe(200);
        const body = WorkspaceWorkersResponseSchema.parse(await response.json());
        expect(body.items.find((item) => item.threadId === thread.id)?.work).toEqual({
          kind: 'unavailable',
        });
        clearWorkerCheckpoint(workspaceDb, 'ws_demo', thread.id, turnId!);
      }
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('labels package preference and last-used model separately and restricts usage without audit.read', async () => {
    const coreDb = createCoreDb();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const thread = store.createThread('ws_demo', 'Model Worker');
    const predecessorThread = store.createThread('ws_demo', 'Predecessor Worker');
    const session = createCurrentWorkerSession(store, {
      agentId: 'agent_codex_host',
      sessionId: 'as_model_current',
      status: 'idle',
      threadId: thread.id,
      turnId: 'turn_model_current',
    });
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: timestamp,
      id: 'as_model_predecessor',
      message: null,
      status: 'closed',
      threadId: predecessorThread.id,
      updatedAt: timestamp,
      workspaceId: 'ws_demo',
    });
    const predecessorTurn = store.createTurn(
      'ws_demo',
      predecessorThread.id,
      'Predecessor turn',
      { kind: 'user', id: 'user_local' },
      null,
      { startedAt: timestamp, turnId: 'turn_model_predecessor' }
    );
    store.updateTurn(predecessorTurn.id, {
      agentId: 'agent_codex_host',
      agentSessionId: 'as_model_predecessor',
    });
    const workspaceDb = openTestWorkspaceDb(coreDb);
    try {
      const snapshotId = recordWorkerPackage(workspaceDb, {
        agentId: 'agent_codex_host',
        displayName: 'Codex',
        preferredLogicalModelId: 'openai/gpt-preferred',
        sessionId: session.id,
        threadId: thread.id,
        turnId: 'turn_model_current',
      });
      store.updateAgentSession(session.id, { environmentPackageSnapshotId: snapshotId });
      recordSessionLlmUsage(workspaceDb, {
        agentId: 'agent_codex_host',
        callId: 'cap_current_llm',
        modelId: 'openai/gpt-last-used',
        recordedAt: '2026-09-17T02:01:00.000Z',
        requestId: '00000000-0000-4000-8000-000000000201',
        sessionId: session.id,
        threadId: thread.id,
        turnId: 'turn_model_current',
        usageId: 'use_current_llm',
      });
      recordSessionLlmUsage(workspaceDb, {
        agentId: 'agent_codex_host',
        callId: 'cap_predecessor_llm',
        modelId: 'openai/gpt-predecessor',
        recordedAt: '2026-09-17T02:02:00.000Z',
        requestId: '00000000-0000-4000-8000-000000000202',
        sessionId: 'as_model_predecessor',
        threadId: predecessorThread.id,
        turnId: 'turn_model_predecessor',
        usageId: 'use_predecessor_llm',
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    const ownerApp = createAuthorizedApp(coreDb, store);
    const now = Date.now();
    coreDb.sqlite
      .prepare(
        `INSERT INTO users
          (id, display_name, email, email_verified, created_at, updated_at, kind)
         VALUES ('user_viewer', 'Viewer', 'viewer-workers@example.com', false, ?, ?, 'human')`
      )
      .run(now, now);
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, access_level, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES ('ws_demo', 'user_viewer', 'active', 'viewer', NULL, ?, NULL, 1, ?, ?)`
      )
      .run(new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString());
    const viewerToken = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_viewer',
      scope: 'workspace-readonly',
      workspaceIds: ['ws_demo'],
    });
    const viewerApp = createApp({
      agentManifests: [
        createTestAgentSetup({
          agentId: 'agent_codex_host',
          displayName: 'Codex',
        }).manifest,
      ],
      auth: {
        api: { getSession: async () => null },
        handler: async () => new Response(null, { status: 404 }),
      },
      coreDb,
      dataRoot: coreDb.dataRoot,
      mode: 'server',
      store,
    });
    const usageSpy = vi.spyOn(usageLedger, 'readLatestCurrentAgentSessionLlmUsage');

    try {
      const ownerRes = await ownerApp.request('/api/app/workspaces/ws_demo/workers');
      const ownerBody = WorkspaceWorkersResponseSchema.parse(await ownerRes.json());
      const ownerWorker = ownerBody.items.find((item) => item.threadId === thread.id);
      const publicJson = JSON.stringify(ownerBody);
      usageSpy.mockClear();
      const viewerRes = await viewerApp.request('/api/app/workspaces/ws_demo/workers', {
        headers: { authorization: `Bearer ${viewerToken.secret}` },
      });
      const viewerBody = WorkspaceWorkersResponseSchema.parse(await viewerRes.json());
      const viewerWorker = viewerBody.items.find((item) => item.threadId === thread.id);

      expect(ownerRes.status).toBe(200);
      expect(ownerWorker?.packageDetails).toMatchObject({
        kind: 'available',
        preferredLogicalModelId: 'openai/gpt-preferred',
        mcpServers: [
          {
            allowedTools: ['list_issues'],
            approvalRequiredTools: ['create_issue'],
            deniedTools: ['delete_repo'],
            id: 'github',
          },
        ],
        filesystem: { default: 'deny', enforcement: 'openshell' },
        network: { default: 'deny', enforcement: 'openshell' },
        process: { default: 'allow', enforcement: 'openshell', ruleCount: 0 },
      });
      expect(ownerWorker?.lastUsedModel).toEqual({
        kind: 'available',
        modelId: 'openai/gpt-last-used',
        recordedAt: '2026-09-17T02:01:00.000Z',
      });
      expect(publicJson).not.toContain('openai/gpt-catalog');
      expect(publicJson).not.toContain('openai/gpt-predecessor');
      expect(publicJson).not.toContain('sk-secret-must-not-leak');
      expect(publicJson).not.toContain('/secret/host/path');
      expect(publicJson).not.toContain('catalogDigest');
      expect(publicJson).not.toContain('schemaPolicy');
      expect(viewerRes.status).toBe(200);
      expect(viewerWorker?.lastUsedModel).toEqual({ kind: 'restricted' });
      expect(usageSpy).not.toHaveBeenCalled();
    } finally {
      usageSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });
});
