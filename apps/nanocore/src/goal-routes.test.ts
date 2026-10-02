import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { asCommandError } from './api-errors.js';
import { classifyGoalStepCheckpointAfterSchedulerRecovery } from './goal-routes.js';
import { commandInputHash } from './runtime/idempotent-command.js';
import type { WorkerCheckpointRecord } from './runtime/worker-checkpoints.js';
import * as recovery from './runtime/worker-recovery.js';
import * as scheduler from './scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';

it.each([
  'launch',
  'tuple',
] as const)('keeps the %s Goal recovery prefix without copying decoder bytes', async (site) => {
  const marker = 'ROW_SECRET_X9';
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-publication-'));
  const store = createDemoStore({ dataRoot });
  const coreDb = openCoreDb(dataRoot);
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  applyMigrations(coreDb);
  applyScopedMigrations(workspaceDb);
  const requestId = '00000000-0000-4000-8000-000000000001';
  const turnId = `tu_goal_step_${createHash('sha256')
    .update(JSON.stringify(['goal.step', 'user_local', 'ws_demo', 'th_demo', requestId]))
    .digest('hex')
    .slice(0, 24)}`;
  const checkpoint: WorkerCheckpointRecord = {
    checkpointId: 'checkpoint_demo',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    turnId,
    goalId: 'goal_demo',
    taskId: 'task_demo',
    requestId,
    requestInputHash: commandInputHash({}),
    stage: site === 'launch' ? 'failed' : 'running_worker',
    iteration: 0,
    workerSessionId: site === 'launch' ? null : 'as_demo',
    contextDigest: 'sha256:context',
    stopReason: site === 'launch' ? 'error' : null,
    diagnosticsSummary: null,
    replayInstruction: false,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
  vi.spyOn(scheduler, 'listSchedulerSessionLeasesForTurn').mockReturnValue([
    {
      leaseId: 'lease_demo',
      agentSessionId: 'as_demo',
      status: 'failed',
      releaseReason: 'turn-start-failed',
      recoveryState: 'needs-evidence',
      lastAcceptedHeartbeatAt: null,
      lastWorkerSequence: null,
    } as ReturnType<typeof scheduler.listSchedulerSessionLeasesForTurn>[number],
  ]);
  vi.spyOn(scheduler, 'requireSchedulerSessionLeaseAdmissionContext').mockReturnValue({
    requestId,
    triggerActor: { kind: 'user', id: 'user_local' },
  } as ReturnType<typeof scheduler.requireSchedulerSessionLeaseAdmissionContext>);
  if (site === 'launch')
    vi.spyOn(store, 'getTurn').mockImplementation(() => {
      throw new SyntaxError(marker);
    });
  else {
    vi.spyOn(store, 'getCommandRequest').mockReturnValue(null);
    vi.spyOn(recovery, 'resolveInterruptedWorkerRetryDecision').mockReturnValue({
      status: 'recovery-required',
      checkpoint,
    });
    vi.spyOn(recovery, 'recoverWorkerCheckpointStopReason').mockImplementation(() => {
      throw new SyntaxError(marker);
    });
  }
  try {
    const error = await classifyGoalStepCheckpointAfterSchedulerRecovery({
      coreDb,
      workspaceDb,
      store,
      checkpoint,
    }).catch((caught: unknown) => caught);
    const prefix =
      site === 'launch'
        ? 'The Goal checkpoint launch evidence could not be read'
        : 'The boot Goal checkpoint has no complete worker owner tuple';
    expect(error).toMatchObject({
      code: 'recovery_required',
      status: 409,
      message: expect.stringContaining(prefix),
    });
    const response = asCommandError(error, 'fallback', 500);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({
      code: 'recovery_required',
      message: expect.stringContaining(prefix),
    });
    expect(JSON.stringify(body)).not.toContain(marker);
  } finally {
    vi.restoreAllMocks();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  }
});
