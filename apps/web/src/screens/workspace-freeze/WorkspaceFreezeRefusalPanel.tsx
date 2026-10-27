import type { WorkspaceFreezeRefusal, WorkspaceQuickAction } from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useCoreClient } from '../../app/core-client';
import { Button, Card, ErrorBanner, Eyebrow } from '../../primitives';
import {
  workspaceBlockerKindLabel,
  workspaceBlockerReasonLabel,
  workspaceBlockerReferenceLabel,
  workspaceFreezeOperationLabel,
} from './labels';
import {
  inspectQuickActionHref,
  isInspectQuickAction,
  workspaceQuickActionLabel,
} from './quick-actions';

/** Renders one structured workspace lifecycle refusal with quick actions and retry guidance. */
export function WorkspaceFreezeRefusalPanel({
  refusal,
  onRetry,
}: {
  refusal: WorkspaceFreezeRefusal;
  onRetry?: () => void;
}) {
  const frozen = refusal.retryable;
  return (
    <section
      className="flex flex-col gap-4"
      aria-label={frozen ? 'Workspace temporarily frozen' : 'Workspace blocked'}
    >
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Eyebrow>{frozen ? 'Backup in progress' : 'Action blocked'}</Eyebrow>
          <p className="text-sm font-bold text-fg-strong">
            {workspaceFreezeOperationLabel(refusal.operation)} could not start for{' '}
            {refusal.workspaceId}
          </p>
          {frozen ? (
            <p className="text-sm text-fg">
              A backup is in progress. Retry this action shortly after the freeze clears.
            </p>
          ) : (
            <p className="text-sm text-fg">
              Resolve the blockers below, then retry the original action.
            </p>
          )}
        </div>
        <ul className="flex flex-col gap-3" aria-label="Blockers">
          {refusal.blockers.map((blocker, index) => (
            <li
              key={`${blocker.kind}-${index}`}
              className="flex flex-col gap-2 rounded-lg border border-border p-3"
            >
              <p className="text-sm font-bold text-fg-strong">
                {workspaceBlockerKindLabel(blocker.kind)}
              </p>
              <p className="text-sm text-fg">{workspaceBlockerReasonLabel(blocker.reason)}</p>
              {workspaceBlockerReferenceLabel(blocker) ? (
                <p className="text-xs text-fg-muted">{workspaceBlockerReferenceLabel(blocker)}</p>
              ) : null}
              {blocker.actions.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {blocker.actions.map((action, actionIndex) => (
                    <QuickActionButton
                      key={`${action.operationId}-${actionIndex}`}
                      action={action}
                    />
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {onRetry ? (
          <div>
            <Button variant="outline" onPress={onRetry}>
              {frozen ? 'Retry shortly' : 'Retry original action'}
            </Button>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

/** Invokes or routes one schema-offered quick action. */
function QuickActionButton({ action }: { action: WorkspaceQuickAction }) {
  const client = useCoreClient();
  const inspectHref = inspectQuickActionHref(action);
  const mutation = useMutation({
    mutationFn: async () => {
      const operation = client.operations[action.operationId] as (
        input: typeof action.input
      ) => Promise<unknown>;
      await operation(action.input);
    },
    retry: false,
  });
  const label = workspaceQuickActionLabel(action);

  if (inspectHref) {
    return (
      <Link
        to={inspectHref}
        className="inline-flex h-7 items-center rounded-full border border-border bg-card px-3 text-xs font-bold text-fg outline-none hover:border-border-hover hover:bg-sunken focus-visible:ring-2 focus-visible:ring-focus"
      >
        {label}
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        size="sm"
        variant="outline"
        isDisabled={mutation.isPending}
        onPress={() => mutation.mutate()}
      >
        {label}
      </Button>
      {mutation.isError ? (
        <ErrorBanner message={quickActionErrorMessage(mutation.error, action.operationId)} />
      ) : null}
    </div>
  );
}

/** Maps a quick-action failure to public copy without private server text. */
function quickActionErrorMessage(
  error: unknown,
  operationId: WorkspaceQuickAction['operationId']
): string {
  if (error instanceof ApiCallError && error.code === 'workspace_access_denied') {
    return 'Access denied.';
  }
  if (isInspectQuickAction(operationId)) {
    return "Couldn't complete that inspection.";
  }
  return "Couldn't complete that action.";
}
