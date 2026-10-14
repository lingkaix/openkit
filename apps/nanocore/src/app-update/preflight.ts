import type { AppUpdatePreflightResponse } from '@openkit/app-api-schemas';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import { OperationError } from '../operation-error.js';
import { listOpenSchedulerExecutionAttempts } from '../runtime/execution-attempt-records.js';
import { listQueuedSchedulerAdmissionEntries } from '../scheduler-records.js';

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
        if (turn.status === 'running') counts.runningTurns += 1;
        if (turn.status === 'pending') counts.pendingTurns += 1;
      }
  for (const attempt of listOpenSchedulerExecutionAttempts(coreDb)) {
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
