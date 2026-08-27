import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { Button, ErrorBanner, Eyebrow, StatusChip } from '../../primitives';
import {
  useCancelThreadMaterialDelivery,
  useConvertThreadMaterialDeliveryToFollowUp,
  useSendThreadMaterialDelivery,
} from './data';

/** The bound Material projection that carries current revision and active delivery truth. */
type ThreadMaterial = NonNullable<
  Awaited<ReturnType<CoreClient['app']['getThreadMaterial']>>['material']
>;

/**
 * Projects exact active-turn delivery truth and invokes the existing steering commands.
 *
 * @param props Authoritative Thread Material state and route scope.
 * @param props.workspaceId Workspace that owns the Thread and Material.
 * @param props.threadId Thread receiving the exact Material revision.
 * @param props.material Current bound Material projection.
 * @param props.disconnected Whether connection state currently forbids writes.
 * @returns Accessible delivery status and controls without owning delivery lifecycle state.
 */
export function DeliveryControls({
  workspaceId,
  threadId,
  material,
  disconnected,
}: {
  workspaceId: string | null;
  threadId: string;
  material: ThreadMaterial;
  disconnected: boolean;
}) {
  const activeDelivery = material.activeDelivery;
  const send = useSendThreadMaterialDelivery(workspaceId, threadId);
  const followUp = useConvertThreadMaterialDeliveryToFollowUp(
    workspaceId,
    threadId,
    activeDelivery?.pendingTurnId ?? null
  );
  const cancel = useCancelThreadMaterialDelivery(
    workspaceId,
    threadId,
    activeDelivery?.pendingTurnId ?? null
  );
  const busy = send.isPending || followUp.isPending || cancel.isPending;
  const terminalState = followUp.data?.state ?? cancel.data?.state;
  const visibleState = activeDelivery?.state ?? terminalState;
  const error = send.error ?? followUp.error ?? cancel.error;
  const currentRevision = material.currentRevision;
  const deliveryProhibited = material.resource.sensitivity === 'restricted';

  return (
    <section aria-label="Active-turn delivery" className="border-t border-border pt-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Eyebrow>Active-turn delivery</Eyebrow>
          <dl className="mt-2 text-sm">
            <dt className="text-xs font-bold uppercase tracking-wide text-fg-muted">Status</dt>
            <dd role="status" className="mt-1">
              <StatusChip
                tone={
                  visibleState === 'applied' || visibleState === 'follow-up'
                    ? 'positive'
                    : 'neutral'
                }
              >
                {visibleState ?? 'Unknown / none / not available'}
              </StatusChip>
            </dd>
          </dl>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            isDisabled={
              disconnected ||
              busy ||
              deliveryProhibited ||
              !currentRevision ||
              Boolean(activeDelivery)
            }
            onPress={() => {
              if (!currentRevision || deliveryProhibited || activeDelivery) return;
              followUp.reset();
              cancel.reset();
              void send
                .mutateAsync({
                  materialId: material.resource.materialId,
                  revisionId: currentRevision.revisionId,
                  contentDigest: currentRevision.contentDigest,
                })
                .catch(() => undefined);
            }}
          >
            Send current revision now
          </Button>
          {activeDelivery?.state === 'queued' ? (
            <>
              <Button
                variant="outline"
                isDisabled={disconnected || busy}
                onPress={() => {
                  cancel.reset();
                  void followUp.mutateAsync().catch(() => undefined);
                }}
              >
                Convert to follow-up
              </Button>
              <Button
                variant="negative-outline"
                isDisabled={disconnected || busy}
                onPress={() => {
                  followUp.reset();
                  void cancel.mutateAsync().catch(() => undefined);
                }}
              >
                Cancel delivery
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {deliveryProhibited ? (
        <p className="mt-2 text-xs text-fg-muted">
          Restricted Material cannot be delivered to a worker.
        </p>
      ) : null}
      {error ? (
        <div className="mt-3">
          <ErrorBanner
            message={
              error instanceof ApiCallError && error.code
                ? `Delivery command rejected: ${error.code.replaceAll('_', ' ')}.`
                : "Couldn't update active-turn delivery."
            }
          />
        </div>
      ) : null}
    </section>
  );
}
