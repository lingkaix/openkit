import { canonicalIdentifierName, canonicalJsonText } from '@openkit/protocol';
import { sha256CanonicalJson } from '@openkit/protocol/digest';
import { OperationError } from '../operation-error-core.js';
import { readPendingRequest } from '../runtime/pending-requests.js';
import { commandRequestKey, getCommandRequestRecordFromDb } from './command-request-records.js';
import type {
  ChannelInboundEnvelope,
  ChannelInboundOrigin,
  ChannelInboundState,
  CommunicationStore,
} from './communication-port.js';
import { hasOriginalReceiptDigest } from './communication-receipt.js';
import type { ControlKernelStore } from './control-kernel-port.js';
import type { WorkspaceDb } from './db.js';
import {
  type StorageOwner,
  type StorageResult,
  type StorageUnavailable,
  storageRequestId,
} from './storage-owner.js';

/** Both owners must be admitted before serving a Discord effect or retention. */
export function admitDiscordOwners<
  Communication extends Pick<CommunicationStore, 'status'>,
  Kernel extends Pick<ControlKernelStore, 'status'>,
>(
  storage: Communication | undefined,
  kernel: Kernel | undefined
):
  | StorageResult<'communication', { storage: Communication; kernel: Kernel }>
  | StorageUnavailable<'control-kernel'> {
  if (!storage) return { state: 'unavailable', owner: 'communication', reason: 'missing' };
  if (!kernel) return { state: 'unavailable', owner: 'control-kernel', reason: 'missing' };
  const storageStatus = storage.status();
  if (storageStatus.state !== 'ready') return storageStatus;
  const kernelStatus = kernel.status();
  if (kernelStatus.state !== 'ready') return kernelStatus;
  return { state: 'ready', value: { storage, kernel } };
}

/** Forms the permanent key before any user, binding or request can be resolved. */
export function discordInteractionEnvelope(
  deploymentId: string,
  eventId: string,
  inputDigest: string
): ChannelInboundEnvelope {
  const occurrence = {
    deploymentId,
    sourceOwner: 'communication',
    verb: 'channel.inbound',
    occurrenceKey: canonicalIdentifierName(['discord', 'interaction', eventId]),
  } as const;
  return { ...occurrence, requestId: storageRequestId(occurrence), inputDigest };
}

/** Exposes only the original inspection lineage on duplicate delivery, never a new admission. */
export async function reserveDiscordInteraction(
  kernel: Pick<ControlKernelStore, 'reserveChannelInbound' | 'inspectChannelInbound'>,
  envelope: ChannelInboundEnvelope,
  admission: 'staged-now' | 'inspect-original' | 'conflict'
): Promise<
  | { readonly state: 'reserved-now' | 'conflict' | 'unknown' }
  | { readonly state: 'inspect-original'; readonly original: ChannelInboundState }
> {
  if (admission === 'conflict') return { state: 'conflict' };
  if (admission === 'staged-now') {
    const reserved = requireChannelStorage(await kernel.reserveChannelInbound(envelope));
    if (reserved.state !== 'inspect-original') return { state: reserved.state };
  }

  const { deploymentId, sourceOwner, verb, occurrenceKey } = envelope;
  const original = requireChannelStorage(
    await kernel.inspectChannelInbound({ deploymentId, sourceOwner, verb, occurrenceKey })
  );
  const originalEnvelope =
    original.state === 'reserved'
      ? original.envelope
      : original.state === 'origin-bound'
        ? original.origin.envelope
        : original.state === 'settled'
          ? original.receipt.intent
          : null;
  if (!originalEnvelope) return { state: 'unknown' };
  if (canonicalJsonText(originalEnvelope) !== canonicalJsonText(envelope)) {
    return { state: 'conflict' };
  }
  if (original.state === 'settled' && !hasOriginalReceiptDigest(original.receipt)) {
    return { state: 'unknown' };
  }
  return { state: 'inspect-original', original };
}

/** Reads the exact original Workspace receipt; missing or expired proof leaves the effect unknown. */
export function inspectPendingDecision(
  db: WorkspaceDb,
  origin: ChannelInboundOrigin,
  referenceTime: string,
  inputHash: string
): string | null {
  if (db.workspaceId !== origin.workspaceId) return null;
  const commonScope = { workspaceId: origin.workspaceId, threadId: origin.threadId };
  const approval = origin.operation === 'approval.respond';
  const command = approval ? 'approval.respond' : 'user_input.answer';
  const scope = approval
    ? { ...commonScope, turnId: origin.turnId, approvalRequestId: origin.pendingRequestId }
    : { ...commonScope, userInputRequestId: origin.pendingRequestId };
  const key = commandRequestKey(command, origin.envelope.requestId, scope);
  return db.sqlite
    .transaction(() => {
      const record = getCommandRequestRecordFromDb(db, key, referenceTime);
      if (
        !record ||
        record.inputHash !== inputHash ||
        record.requestId !== origin.envelope.requestId ||
        record.command !== command ||
        canonicalJsonText(record.scope) !== canonicalJsonText(scope) ||
        record.response.kind !== (approval ? 'approval' : 'pending_request') ||
        record.response.id !== origin.pendingRequestId
      )
        return null;

      const pending = readPendingRequest(db.sqlite, origin.pendingRequestId);
      if (
        !pending ||
        pending.workspaceId !== origin.workspaceId ||
        pending.threadId !== origin.threadId ||
        pending.raisingTurnId !== origin.turnId ||
        pending.responsibleUserId !== origin.userId ||
        pending.decidingActor?.kind !== 'user' ||
        pending.decidingActor.id !== origin.userId ||
        pending.resolution !== (approval ? 'denied' : 'answered')
      )
        return null;

      return sha256CanonicalJson(record);
    })
    .deferred();
}

/** Keeps store degradation distinct from a missing or declined row. */
export function requireChannelStorage<Owner extends StorageOwner, Result>(
  result: StorageResult<Owner, Result>
): Result {
  if (result.state !== 'ready') {
    throw new OperationError(
      'channel_storage_unavailable',
      'Communication storage is unavailable.',
      503
    );
  }
  return result.value;
}
