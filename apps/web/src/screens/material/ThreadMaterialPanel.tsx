import { ApiCallError } from '@openkit/core-client';
import { useConnection } from '../../app/core-client';
import { Button, Card, ErrorBanner, Eyebrow, Skeleton } from '../../primitives';
import { DeliveryControls } from './DeliveryControls';
import {
  useBindThreadMaterial,
  useExcludeThreadMaterial,
  useRestoreThreadMaterial,
  useThreadMaterial,
  useUnbindThreadMaterial,
} from './data';

/** Projects the authoritative Thread Material binding, queue, and inclusion facts. */
export function ThreadMaterialPanel({
  workspaceId,
  threadId,
  materialId,
}: {
  workspaceId: string | null;
  threadId: string;
  materialId: string | null;
}) {
  const { failed, checking } = useConnection();
  const disconnected = failed || checking;
  const projection = useThreadMaterial(workspaceId, threadId);
  const bind = useBindThreadMaterial(workspaceId, threadId, materialId);
  const unbind = useUnbindThreadMaterial(
    workspaceId,
    threadId,
    projection.data?.material?.resource.materialId ?? materialId
  );
  const exclude = useExcludeThreadMaterial(
    workspaceId,
    threadId,
    projection.data?.material?.resource.materialId ?? materialId
  );
  const restore = useRestoreThreadMaterial(
    workspaceId,
    threadId,
    projection.data?.material?.resource.materialId ?? materialId
  );
  const material = projection.data?.material;
  const mutationError = bind.error ?? unbind.error ?? exclude.error ?? restore.error;
  const conflict =
    mutationError instanceof ApiCallError &&
    mutationError.status === 409 &&
    mutationError.code === 'conflict';
  const busy = bind.isPending || unbind.isPending || exclude.isPending || restore.isPending;
  const retryRead = () => {
    bind.reset();
    unbind.reset();
    exclude.reset();
    restore.reset();
    void projection.refetch();
  };
  const revisionId = material?.currentRevision?.revisionId;
  const queuedRevisionId = material?.latestQueuedRevisionId;
  const canExclude = material?.inclusionState === 'included' && Boolean(queuedRevisionId);

  if (projection.isLoading && !projection.data) {
    return (
      <Card>
        <div className="flex flex-col gap-3">
          <Eyebrow>Thread Material</Eyebrow>
          <Skeleton lines={6} />
        </div>
      </Card>
    );
  }

  if (!projection.data) {
    return (
      <section aria-label="Thread Material">
        <ErrorBanner
          message="Couldn't load Thread Material."
          onRetry={() => void projection.refetch()}
        />
      </section>
    );
  }

  return (
    <section aria-label="Thread Material">
      <Card>
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Eyebrow>Thread Material</Eyebrow>
              <p className="mt-1 text-sm text-fg-muted">
                Authoritative binding and worker-context state for this Thread.
              </p>
            </div>
            <span className="font-mono text-xs text-fg-muted">{threadId}</span>
          </div>

          {projection.isError ? (
            <ErrorBanner
              message="The latest Thread Material projection could not be refreshed."
              onRetry={() => void projection.refetch()}
            />
          ) : null}
          {mutationError ? (
            <ErrorBanner
              message={
                conflict
                  ? 'This Thread Material changed since it was opened.'
                  : "Couldn't update Thread Material."
              }
              onRetry={conflict ? retryRead : undefined}
            />
          ) : null}

          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-fg-muted">Binding</dt>
              <dd className="mt-1 capitalize text-fg">{material ? 'bound' : 'unbound'}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-fg-muted">Inclusion</dt>
              <dd className="mt-1 capitalize text-fg">
                {material?.inclusionState ?? 'Unknown / none / not available'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-fg-muted">
                Current revision
              </dt>
              <dd className="mt-1 font-mono text-xs text-fg">
                {revisionId ?? 'Unknown / none / not available'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-fg-muted">
                Queued revision
              </dt>
              <dd className="mt-1 font-mono text-xs text-fg">
                {queuedRevisionId ?? 'Unknown / none / not available'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-fg-muted">
                Worker-seen revision
              </dt>
              <dd className="mt-1 font-mono text-xs text-fg">
                {material?.lastWorkerSeenRevisionId ?? 'Unknown / none / not available'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-fg-muted">
                Current-turn revision
              </dt>
              <dd className="mt-1 font-mono text-xs text-fg">
                {material?.currentTurnRevisionId ?? 'Unknown / none / not available'}
              </dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-2">
            {!material ? (
              <Button
                isDisabled={disconnected || busy || !materialId}
                onPress={() => {
                  if (materialId) {
                    void bind
                      .mutateAsync({ expectedBindingState: 'not_bound' })
                      .catch(() => undefined);
                  }
                }}
              >
                Bind Material
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  isDisabled={disconnected || busy}
                  onPress={() =>
                    void unbind
                      .mutateAsync({ expectedBindingState: 'bound' })
                      .catch(() => undefined)
                  }
                >
                  Unbind
                </Button>
                {material.inclusionState === 'included' ? (
                  <Button
                    variant="negative-outline"
                    isDisabled={disconnected || busy || !canExclude}
                    onPress={() => {
                      if (queuedRevisionId) {
                        void exclude
                          .mutateAsync({
                            expectedBindingState: 'bound',
                            expectedInclusionState: 'included',
                            expectedQueuedRevisionId: queuedRevisionId,
                          })
                          .catch(() => undefined);
                      }
                    }}
                  >
                    Exclude
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    isDisabled={disconnected || busy}
                    onPress={() =>
                      void restore
                        .mutateAsync({
                          expectedBindingState: 'bound',
                          expectedInclusionState: 'excluded',
                        })
                        .catch(() => undefined)
                    }
                  >
                    Restore
                  </Button>
                )}
              </>
            )}
          </div>

          {material ? (
            <DeliveryControls
              workspaceId={workspaceId}
              threadId={threadId}
              material={material}
              disconnected={disconnected}
            />
          ) : null}
        </div>
      </Card>
    </section>
  );
}
