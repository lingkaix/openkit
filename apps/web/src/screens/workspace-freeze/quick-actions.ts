import type { WorkspaceQuickAction } from '@openkit/app-api-schemas';

/** Quick actions that open an existing read surface instead of invoking the operation here. */
export function isInspectQuickAction(operationId: WorkspaceQuickAction['operationId']): boolean {
  return (
    operationId === 'administration.cleanup-read' ||
    operationId === 'worker.list' ||
    operationId === 'sync.review-read'
  );
}

/** Product label for one offered quick action button. */
export function workspaceQuickActionLabel(action: WorkspaceQuickAction): string {
  switch (action.operationId) {
    case 'turn.interrupt':
      return 'Interrupt turn';
    case 'goal.cancel':
      return 'Cancel goal';
    case 'goal.card.cancel':
      return 'Cancel goal card';
    case 'scheduler.cancel':
      return 'Cancel scheduler admission';
    case 'pending-request.withdraw':
      return 'Withdraw pending request';
    case 'administration.cleanup-read':
      return 'Open server operations';
    case 'worker.list':
      return 'Open agents';
    case 'sync.review-read':
      return 'Open workspace changes';
    case 'sync.recovery-decide':
      return 'Decide recovery';
  }
}

/**
 * Route for an inspect-only quick action, when the Web app exposes a matching surface.
 *
 * @param action Offered quick action from a refusal payload.
 * @returns In-app path, or null when the action must be invoked directly.
 */
export function inspectQuickActionHref(action: WorkspaceQuickAction): string | null {
  if (!isInspectQuickAction(action.operationId)) return null;
  switch (action.operationId) {
    case 'administration.cleanup-read':
      return '/settings/server-operations';
    case 'worker.list':
      return '/agents';
    case 'sync.review-read':
      return '/workspace-changes';
    default:
      return null;
  }
}
