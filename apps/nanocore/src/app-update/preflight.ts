import type { AppUpdatePreflightResponse } from '@openkit/app-api-schemas';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import { OperationError } from '../operation-error.js';
import { listOpenSchedulerExecutionAttempts } from '../runtime/execution-attempt-records.js';
import { listQueuedSchedulerAdmissionEntries } from '../scheduler-records.js';
import {
  getControlStoreWorkerClient,
  readAdmittedNanoHostAttempt,
} from '../storage/control-store-worker-client.js';

/** Projects current owners synchronously without yielding between the overlapping count reads. */
export function observeAppUpdatePreflight(
  dependencies: Pick<OperationInvocationDependencies, 'coreDb' | 'store' | 'inflightCommands'>,
  now: () => number = Date.now
): AppUpdatePreflightResponse {
  const { coreDb, store, inflightCommands } = dependencies;
  if (!coreDb || !store || !inflightCommands)
    throw new OperationError(
      'app_update_unavailable',
      'Deployment work observation is unavailable.',
      503
    );
  const workspaces = store.listWorkspaces();
  const attempts = listOpenSchedulerExecutionAttempts(coreDb);
  const heldAttemptIds = new Set<string>();
  const writer = getControlStoreWorkerClient();
  for (const attempt of attempts) {
    if (attempt.backendId !== 'nanohost' || attempt.phase !== 'closing') continue;
    const evidence = writer.readAdmittedNanoHost(coreDb.dataRoot, (sqlite) =>
      sqlite.transaction(() => readAdmittedNanoHostAttempt(coreDb, sqlite, attempt))()
    );
    if (evidence.state === 'ready' && evidence.value.proof.recoveryState === 'needs-evidence')
      heldAttemptIds.add(attempt.attemptId);
  }
  const heldTurnIds = new Set(
    attempts
      .filter((attempt) => heldAttemptIds.has(attempt.attemptId))
      .map((attempt) => attempt.turnId)
  );
  // Another active owner for that Turn must still block the update.
  for (const attempt of attempts)
    if (!heldAttemptIds.has(attempt.attemptId)) heldTurnIds.delete(attempt.turnId);
  const counts = {
    runningTurns: 0,
    pendingTurns: 0,
    queuedAdmissions: listQueuedSchedulerAdmissionEntries(coreDb).length,
    openAttempts: 0,
    closingAttempts: 0,
    inFlightCommands: inflightCommands.get(store)?.size ?? 0,
  };
  for (const workspace of workspaces)
    for (const thread of store.listThreads(workspace.id))
      for (const turn of store.listThreadTurns(workspace.id, thread.id)) {
        if (heldTurnIds.has(turn.id)) continue;
        if (turn.status === 'running') counts.runningTurns += 1;
        if (turn.status === 'pending') counts.pendingTurns += 1;
      }
  for (const attempt of attempts) {
    if (heldAttemptIds.has(attempt.attemptId)) continue;
    if (attempt.phase === 'open') counts.openAttempts += 1;
    if (attempt.phase === 'closing') counts.closingAttempts += 1;
  }
  return {
    observedAt: new Date(now()).toISOString(),
    workspaceCount: workspaces.length,
    counts,
    state: Object.values(counts).every((count) => count === 0) ? 'idle' : 'busy',
  };
}
