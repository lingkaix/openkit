import type { WorkspaceBlocker, WorkspaceFreezeRefusal } from '@openkit/app-api-schemas';

const REASON_LABELS: Record<WorkspaceBlocker['reason'], string> = {
  'active-work': 'Active work',
  'pending-publication': 'Pending publication',
  'cleanup-unproved': 'Cleanup not proved',
  'unproved-effect': 'Unproved effect',
  frozen: 'Frozen',
  held: 'Held',
  unavailable: 'Unavailable',
};

const KIND_LABELS: Record<Exclude<WorkspaceBlocker['kind'], 'unavailable'>, string> = {
  turn: 'Turn',
  'worker-attempt': 'Worker attempt',
  'worker-residency': 'Worker residency',
  'pending-request': 'Pending request',
  'recurring-occurrence': 'Recurring occurrence',
  'scheduler-admission': 'Scheduler admission',
  'goal-task': 'Goal task',
  synchronization: 'Synchronization',
  publication: 'Publication',
  snapshot: 'Snapshot',
  retention: 'Retention',
};

const OPERATION_LABELS: Record<WorkspaceFreezeRefusal['operation'], string> = {
  capture: 'Backup capture',
  archive: 'Export archive',
  delete: 'Delete workspace',
  restore: 'Restore from backup',
  'move-out': 'Move out',
  'move-in': 'Move in',
};

/** Product label for one lifecycle operation named in a refusal. */
export function workspaceFreezeOperationLabel(
  operation: WorkspaceFreezeRefusal['operation']
): string {
  return OPERATION_LABELS[operation];
}

/** Product label for one blocker reason. */
export function workspaceBlockerReasonLabel(reason: WorkspaceBlocker['reason']): string {
  return REASON_LABELS[reason];
}

/** Product label for one blocker kind. */
export function workspaceBlockerKindLabel(kind: WorkspaceBlocker['kind']): string {
  return kind === 'unavailable' ? 'Unavailable obstruction' : KIND_LABELS[kind];
}

/**
 * Safe reference text derived only from schema-carried identities.
 *
 * @param blocker Authoritative blocker row from a refusal payload.
 * @returns Public label text, or null for the unavailable sentinel.
 */
export function workspaceBlockerReferenceLabel(blocker: WorkspaceBlocker): string | null {
  if (blocker.kind === 'unavailable') return null;
  switch (blocker.kind) {
    case 'turn':
      return `Thread ${blocker.reference.threadId}, Turn ${blocker.reference.turnId}`;
    case 'worker-attempt':
      return [
        `Attempt ${blocker.reference.attemptId}`,
        `Thread ${blocker.reference.threadId}`,
        `Turn ${blocker.reference.turnId}`,
        blocker.reference.agentSessionId
          ? `Agent session ${blocker.reference.agentSessionId}`
          : 'Prelaunch attempt',
      ].join(' · ');
    case 'worker-residency':
      return 'agentSessionId' in blocker.reference
        ? `Agent session ${blocker.reference.agentSessionId}`
        : `Storage ${blocker.reference.storageRef}`;
    case 'pending-request':
      return `Thread ${blocker.reference.threadId}, Request ${blocker.reference.pendingRequestId}`;
    case 'recurring-occurrence':
      return `Occurrence ${blocker.reference.occurrenceId}`;
    case 'scheduler-admission':
      return `Queue entry ${blocker.reference.queueEntryId}`;
    case 'goal-task':
      return `Goal ${blocker.reference.goalId}`;
    case 'synchronization':
      return `Review ${blocker.reference.reviewId}`;
    case 'publication':
      return `Workspace ${blocker.reference.workspaceId}`;
    case 'snapshot':
      return 'backupId' in blocker.reference
        ? `Backup ${blocker.reference.backupId}`
        : `Recovery request ${blocker.reference.recoveryRequestId}`;
    case 'retention':
      return `Workspace ${blocker.reference.workspaceId}`;
    default:
      return null;
  }
}
