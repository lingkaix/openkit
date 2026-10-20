import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, vi } from 'vitest';
import { refuseScope } from '../bootstrap/readiness.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  createSchedulerAdmissionEntry,
  findNextDispatchableSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  getSchedulerPreparationClaims,
  runSchedulerDispatchLoop,
} from './scheduler-dispatch-loop.js';

it('dispatches a healthy FIFO sibling while retaining quarantined admissions and an unresolved binding', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'dispatch-scope-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const bad = store.createWorkspace('Quarantined queue');
    const good = store.createWorkspace('Healthy queue');
    for (const workspace of [bad, good])
      recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
    const manifest = createTestAgentSetup().manifest;
    admitTestNativeEnvironment(coreDb, manifest);
    recordTestNativeRuntimeTarget(coreDb);
    const executor = new SimulatedTurnExecutor({ coreDb });
    const starts = vi.spyOn(executor, 'startTurn');
    const publish = (workspaceId: string, name: string) => {
      const thread = store.createThread(workspaceId, name);
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: executor.id,
        queueEntryId: randomUUID(),
        requestId: randomUUID(),
        triggerActor: { kind: 'user', id: userId },
        serverAdminTokenId: null,
        workspaceId,
        threadId: thread.id,
        turnId: allocateEntityId('tu'),
        turnInput: 'Local scope dispatch proof',
        requestedAgentId: manifest.id,
      });
      store.createTurn(
        entry.workspaceId,
        entry.threadId,
        entry.turnInput,
        entry.triggerActor,
        undefined,
        {
          turnId: entry.turnId,
          status: 'pending',
          agentId: entry.requestedAgentId,
          executorKind: 'worker',
        }
      );
      store.recordCommandRequest({
        command: 'turn.start',
        requestId: entry.requestId,
        inputHash: `fixture:${entry.queueEntryId}`,
        scope: { actorId: userId, workspaceId, threadId: thread.id },
        response: { kind: 'turn', id: entry.turnId },
        createdAt: new Date().toISOString(),
      });
      return entry;
    };
    const first = publish(bad.id, 'Oldest queued work');
    const held = publish(bad.id, 'Unresolved predecessor binding');
    const heldAttempt = recordTestExecutionAttempt(coreDb, {
      entry: held,
      attemptId: allocateEntityId('attempt'),
      agentSessionId: allocateEntityId('as'),
      inputRef: 'scope-held-input',
      bindingRef: 'scope-held-binding',
      sessionCompatibilityKey: 'scope-held-compatible',
      operationId: 'scope-held-operation',
      now: () => new Date().toISOString(),
    });
    const healthy = publish(good.id, 'Runnable sibling');
    expect(findNextDispatchableSchedulerAdmissionEntry(coreDb)?.queueEntryId).toBe(
      first.queueEntryId
    );
    const heldBefore = coreDb.sqlite
      .prepare('SELECT * FROM scheduler_execution_attempts WHERE attempt_id = ?')
      .get(heldAttempt.attemptId);
    const admissionsBefore = coreDb.sqlite
      .prepare('SELECT * FROM scheduler_admission_entries WHERE workspace_id = ? ORDER BY rowid')
      .all(bad.id);
    refuseScope(dataRoot, { scope: 'workspace', id: bad.id, check: 'database' });
    const input = {
      coreDb,
      store,
      turnExecutor: executor,
      executionBackend: executor.executionBackend,
      agentManifests: [manifest],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Local scheduler fixture',
          kind: 'local',
          baseUrl: 'http://127.0.0.1:11434/v1',
          defaultModel: 'openai/gpt-5.2',
          models: ['openai/gpt-5.2'],
          modelMetadata: { 'openai/gpt-5.2': { temperature: false } },
        },
      ]),
    };
    const result = await runSchedulerDispatchLoop(input);
    await Promise.allSettled([...getSchedulerPreparationClaims(coreDb).values()]);
    expect(result.startedTurns.map(({ dispatch }) => dispatch.entry.queueEntryId)).toEqual([
      healthy.queueEntryId,
    ]);
    expect(starts.mock.calls.map(([, turnId]) => turnId)).toEqual([healthy.turnId]);
    expect(store.getTurnById(healthy.turnId).status).toBe('completed');
    const repeated = await runSchedulerDispatchLoop(input);
    expect(repeated.startedTurns).toEqual([]);
    expect(repeated.terminalResult).toEqual({ status: 'queued', reason: 'recovery-required' });
    expect(
      coreDb.sqlite
        .prepare('SELECT * FROM scheduler_admission_entries WHERE workspace_id = ? ORDER BY rowid')
        .all(bad.id)
    ).toEqual(admissionsBefore);
    expect(
      coreDb.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts WHERE attempt_id = ?')
        .get(heldAttempt.attemptId)
    ).toEqual(heldBefore);
    expect(
      coreDb.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts WHERE turn_id = ?')
        .all(first.turnId)
    ).toEqual([]);
    starts.mockRestore();
  } finally {
    await Promise.allSettled([...getSchedulerPreparationClaims(coreDb).values()]);
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
