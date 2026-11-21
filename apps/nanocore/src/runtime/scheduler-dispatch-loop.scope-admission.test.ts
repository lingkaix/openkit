import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, vi } from 'vitest';
import { refuseScope } from '../bootstrap/readiness.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { commandRequestExpiresAt, commandRequestKey } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  createSchedulerAdmissionEntry,
  findNextDispatchableSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { reopenAdmittedTestNanoHost } from '../test-support/admitted-nanohost.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  admitTestNativeEnvironmentForRoot,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { commandInputHash } from './idempotent-command.js';
import {
  getSchedulerPreparationClaims,
  runSchedulerDispatchLoop,
} from './scheduler-dispatch-loop.js';
import { stageSchedulerStartInput } from './scheduler-input-staging.js';

const faults = [
  'quarantined Workspace',
  'missing input',
  'mismatched input bytes',
  'missing input after claim',
] as const;
it.each(faults)('holds %s and dispatches the healthy FIFO sibling', async (hold) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'dispatch-scope-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const store = createTestStore({ dataRoot });
    const bad = await store.createWorkspace('Quarantined queue');
    const good = await store.createWorkspace('Healthy queue');
    for (const workspace of [bad, good])
      recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
    const manifest = createTestAgentSetup().manifest;
    await admitTestNativeEnvironmentForRoot(coreDb, manifest);
    await recordTestNativeRuntimeTarget(coreDb);
    const executor = new SimulatedTurnExecutor({ coreDb });
    const starts = vi.spyOn(executor, 'startTurn');
    const preparations = vi.spyOn(executor, 'prepareAgentSessionForTurn');
    const publish = async (workspaceId: string, name: string) => {
      const thread = await store.createThread(workspaceId, name);
      const requestId = randomUUID();
      const turnId = allocateEntityId('tu');
      const work = { workspaceId, threadId: thread.id, turnId };
      const text = 'Local scope dispatch proof';
      const inputRef = await stageSchedulerStartInput(dataRoot, work, requestId, text);
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: executor.id,
        queueEntryId: randomUUID(),
        requestId,
        triggerActor: { kind: 'user', id: userId },
        serverAdminTokenId: null,
        ...work,
        inputRef,
        requestedAgentId: manifest.id,
      });
      const scope = { actorId: userId, workspaceId, threadId: thread.id };
      const createdAt = new Date().toISOString();
      await store.createTurn(
        entry.workspaceId,
        entry.threadId,
        text,
        entry.triggerActor,
        undefined,
        {
          turnId: entry.turnId,
          status: 'pending',
          agentId: entry.requestedAgentId,
          executorKind: 'worker',
          commandReceipt: {
            key: commandRequestKey('turn.start', requestId, scope),
            command: 'turn.start',
            requestId,
            inputHash: commandInputHash({ input: text }),
            scope,
            responseKind: 'turn',
            createdAt,
            expiresAt: commandRequestExpiresAt(createdAt),
          },
        }
      );
      return entry;
    };
    const first = await publish(bad.id, 'Oldest queued work');
    const held = await publish(bad.id, 'Unresolved predecessor binding');
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
    const healthy = await publish(good.id, 'Runnable sibling');
    expect(findNextDispatchableSchedulerAdmissionEntry(coreDb)?.queueEntryId).toBe(
      first.queueEntryId
    );
    const heldBefore = coreDb.sqlite
      .prepare('SELECT * FROM scheduler_execution_attempts WHERE attempt_id = ?')
      .get(heldAttempt.attemptId);
    const admissionsBefore = coreDb.sqlite
      .prepare('SELECT * FROM scheduler_admission_entries WHERE workspace_id = ? ORDER BY rowid')
      .all(bad.id);
    const faultOriginalInput = (missing: boolean) => {
      const owner = openWorkspaceDb(dataRoot, bad.id);
      try {
        const changed = missing
          ? owner.sqlite
              .prepare('DELETE FROM workspace_work_inputs WHERE input_id = ?')
              .run(first.inputRef.inputId)
          : owner.sqlite
              .prepare('UPDATE workspace_work_inputs SET input_bytes = ? WHERE input_id = ?')
              .run(Buffer.from('Contradictory bytes'), first.inputRef.inputId);
        expect(changed.changes).toBe(1);
      } finally {
        owner.sqlite.close();
      }
    };
    if (hold === 'quarantined Workspace') {
      refuseScope(dataRoot, { scope: 'workspace', id: bad.id, check: 'database' });
    } else if (hold !== 'missing input after claim') {
      await shutdownControlStoreWorkerClient();
      faultOriginalInput(hold === 'missing input');
      await reopenAdmittedTestNanoHost(coreDb);
    }
    let deletedAfterClaim = false;
    const input = {
      createAgentSessionId: () => {
        if (hold === 'missing input after claim' && !deletedAfterClaim) {
          expect(requireSchedulerAdmissionEntry(coreDb, first.queueEntryId).status).toBe(
            'admitted'
          );
          faultOriginalInput(true);
          deletedAfterClaim = true;
        }
        return allocateEntityId('as');
      },
      coreDb,
      store,
      maxDispatches: 2,
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
    expect(deletedAfterClaim).toBe(hold === 'missing input after claim');
    await Promise.allSettled([...getSchedulerPreparationClaims(coreDb).values()]);
    expect(result.startedTurns.map(({ dispatch }) => dispatch.entry.queueEntryId)).toEqual([
      healthy.queueEntryId,
    ]);
    expect(starts.mock.calls.map(([, turnId]) => turnId)).toEqual([healthy.turnId]);
    expect(preparations.mock.calls.map(([, preparation]) => preparation.turn.id)).toEqual([
      healthy.turnId,
    ]);
    expect(store.getTurnById(healthy.turnId).status).toBe('completed');
    expect(result.terminalResult).toEqual({ status: 'queued', reason: 'recovery-required' });
    const repeated = await runSchedulerDispatchLoop(input);
    expect(repeated.startedTurns).toEqual([]);
    const attempts = coreDb.sqlite
      .prepare('SELECT * FROM scheduler_execution_attempts WHERE turn_id = ?')
      .all(first.turnId);
    if (hold === 'missing input after claim') {
      expect(store.getTurnById(first.turnId).status).toBe('pending');
      expect(requireSchedulerAdmissionEntry(coreDb, first.queueEntryId)).toMatchObject({
        status: 'admitted',
        inputRef: first.inputRef,
      });
      expect(attempts).toEqual([
        expect.objectContaining({ phase: 'open', operation_id: null, terminal_cause: null }),
      ]);
    } else {
      expect(repeated.terminalResult).toEqual({ status: 'queued', reason: 'recovery-required' });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT * FROM scheduler_admission_entries WHERE workspace_id = ? ORDER BY rowid'
          )
          .all(bad.id)
      ).toEqual(admissionsBefore);
      expect(attempts).toEqual([]);
    }
    expect(
      coreDb.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts WHERE attempt_id = ?')
        .get(heldAttempt.attemptId)
    ).toEqual(heldBefore);
    starts.mockRestore();
  } finally {
    await Promise.allSettled([...getSchedulerPreparationClaims(coreDb).values()]);
    coreDb.sqlite.close();
    await disposeTestStore(dataRoot);
  }
});
