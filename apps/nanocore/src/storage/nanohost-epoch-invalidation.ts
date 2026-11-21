import { isDeepStrictEqual } from 'node:util';
import { canonicalIdentifierName } from '@openkit/protocol';
import { sha256CanonicalJson } from '@openkit/protocol/digest';
import type { ControlKernelStore } from './control-kernel-port.js';
import type { NanoHostRuntimeTargetTransition } from './nanohost-epoch-invalidation-codecs.js';
import type {
  NanoHostEpochInvalidation,
  NanoHostEpochReceipt,
  NanoHostStore,
} from './nanohost-port.js';
import type { ControlRuntimeTargetResult } from './runtime-target-codecs.js';
import {
  type StorageDecision,
  type StorageOccurrence,
  type StorageResult,
  storageRequestId,
} from './storage-owner.js';

/** Physical writer scope of one original NanoHost target generation. */
export interface NanoHostEpochPlacement {
  readonly deploymentId: string;
  readonly runtimeTargetId: string;
  readonly physicalEpoch: string;
  readonly generation: string;
}

/** The original holder fence is addressed by the retiring target, Epoch and generation. */
export function vaultEpochFenceOccurrence(placement: NanoHostEpochPlacement) {
  return {
    deploymentId: placement.deploymentId,
    sourceOwner: 'nanohost',
    verb: 'fence-vault-epoch',
    occurrenceKey: canonicalIdentifierName([
      placement.runtimeTargetId,
      placement.physicalEpoch,
      placement.generation,
    ]),
  } as const;
}

type ReserveHolderIntent = (
  placement: NanoHostEpochPlacement
) => Promise<StorageResult<'control-kernel', NanoHostEpochInvalidation | null>>;

interface NanoHostEpochRetirementStore extends Pick<NanoHostStore, 'readEpochInvalidation'> {
  beginEpochRetirement(placement: NanoHostEpochPlacement): Promise<StorageResult<'nanohost', void>>;
}

/** A2 binds these calls to the admitted NanoHost reader and FULL writer. */
export interface NanoHostRuntimeTargetEpochStore
  extends NanoHostEpochRetirementStore,
    Pick<NanoHostStore, 'stageEpochInvalidation' | 'settleEpochInvalidation'> {
  inspectRuntimeTargetTransition(
    original: NanoHostRuntimeTargetTransition
  ): Promise<
    StorageResult<
      'nanohost',
      { state: 'pending' } | { state: 'committed'; result: ControlRuntimeTargetResult }
    >
  >;
  mutateRuntimeTarget(
    original: NanoHostRuntimeTargetTransition
  ): Promise<StorageResult<'nanohost', ControlRuntimeTargetResult>>;
}

/** A2 binds the private reservation and the existing deciding Core ports. */
export interface NanoHostRuntimeTargetEpochKernel
  extends Pick<ControlKernelStore, 'fenceNanoHostEpoch' | 'inspectNanoHostEpochFence'> {
  reserveHolderIntent: ReserveHolderIntent;
}

/**
 * Applies an authenticated target transition after settling the original Epoch's Vault fence.
 * The caller captures one original per occurrence and retains it across retries.
 * The native target writer rechecks that predecessor and records the result atomically.
 */
export async function transitionNanoHostRuntimeTarget(
  store: NanoHostRuntimeTargetEpochStore,
  kernel: NanoHostRuntimeTargetEpochKernel,
  original: NanoHostRuntimeTargetTransition
): Promise<StorageResult<'nanohost' | 'control-kernel', ControlRuntimeTargetResult>> {
  const transition = structuredClone(original);
  const observed = await store.inspectRuntimeTargetTransition(transition);
  if (observed.state !== 'ready') return observed;
  if (observed.value.state === 'committed') {
    return { state: 'ready', value: observed.value.result };
  }
  const retirement = transition.retirement;
  if (retirement) {
    const intent = await prepareNanoHostEpochInvalidation(
      store,
      vaultEpochFenceOccurrence(retirement),
      retirement,
      (placement) => kernel.reserveHolderIntent(placement)
    );
    if (intent.state !== 'ready') return intent;
    const fence = await fenceNanoHostEpochBeforeSuccessor(store, kernel, intent.value);
    if (fence.state !== 'ready') return fence;
    if (fence.value.state !== 'settled' || fence.value.receipt.disposition !== 'applied') {
      return { state: 'unavailable', owner: 'control-kernel', reason: 'recovery-required' };
    }
  }
  return await store.mutateRuntimeTarget(transition);
}

/** Reuses the retained intent or reserves the exact holder set after closing native readiness. */
export async function prepareNanoHostEpochInvalidation(
  store: NanoHostEpochRetirementStore,
  occurrence: StorageOccurrence<'nanohost', 'fence-vault-epoch'>,
  placement: NanoHostEpochPlacement,
  reserveHolderIntent: ReserveHolderIntent
): Promise<StorageResult<'nanohost' | 'control-kernel', NanoHostEpochInvalidation>> {
  const requestId = storageRequestId(occurrence);
  const original = await store.readEpochInvalidation(requestId);
  if (original.state !== 'ready') return original;
  if (original.value) {
    return matchesOriginalEpochIntent(original.value, occurrence, placement)
      ? { state: 'ready', value: original.value }
      : { state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' };
  }

  const retiring = await store.beginEpochRetirement(placement);
  if (retiring.state !== 'ready') return retiring;
  const reserved = await reserveHolderIntent(placement);
  if (reserved.state !== 'ready') return reserved;
  if (!reserved.value || !matchesOriginalEpochIntent(reserved.value, occurrence, placement))
    return { state: 'unavailable', owner: 'control-kernel', reason: 'recovery-required' };
  return { state: 'ready', value: reserved.value };
}

function matchesOriginalEpochIntent(
  intent: NanoHostEpochInvalidation,
  occurrence: StorageOccurrence<'nanohost', 'fence-vault-epoch'>,
  placement: NanoHostEpochPlacement
): boolean {
  return (
    intent.requestId === storageRequestId(occurrence) &&
    intent.occurrenceKey === occurrence.occurrenceKey &&
    isDeepStrictEqual(epochPlacementOfIntent(intent), placement) &&
    intent.inputDigest === sha256CanonicalJson(intent.target)
  );
}

/** Projects the same placement from a retained original holder intent. */
export function epochPlacementOfIntent(intent: NanoHostEpochInvalidation) {
  return {
    deploymentId: intent.deploymentId,
    runtimeTargetId: intent.target.runtimeTargetId,
    physicalEpoch: intent.target.physicalEpoch,
    generation: intent.expectedGeneration,
  };
}

/**
 * Commits the original invalidation and obtains its exact Vault fence before successor readiness.
 * The source owner stages idempotently and blocks readiness until its local settlement commits.
 * A lost kernel acknowledgement leaves the original source intent available for inspection.
 */
export async function fenceNanoHostEpochBeforeSuccessor(
  store: Pick<NanoHostStore, 'stageEpochInvalidation' | 'settleEpochInvalidation'>,
  kernel: Pick<ControlKernelStore, 'fenceNanoHostEpoch' | 'inspectNanoHostEpochFence'>,
  intent: NanoHostEpochInvalidation
): Promise<StorageResult<'nanohost' | 'control-kernel', StorageDecision<NanoHostEpochReceipt>>> {
  const original = structuredClone(intent);
  const staged = await store.stageEpochInvalidation(original);
  if (staged.state !== 'ready') return staged;

  const lookup = await kernel.inspectNanoHostEpochFence(original);
  if (lookup.state !== 'ready') return lookup;
  const decision =
    lookup.value.state === 'absent'
      ? await kernel.fenceNanoHostEpoch(original)
      : ({ state: 'ready', value: lookup.value } as const);
  if (decision.state !== 'ready' || decision.value.state !== 'settled') return decision;

  const { receipt } = decision.value;
  if (!matchesNanoHostEpochReceipt(original, receipt)) {
    return { state: 'ready', value: { state: 'conflict' } };
  }

  const settled = await store.settleEpochInvalidation(receipt);
  return settled.state === 'ready' ? decision : settled;
}

/** Matches the original staged tuple and the full holder set for an applied fence. */
export function matchesNanoHostEpochReceipt(
  intent: NanoHostEpochInvalidation,
  receipt: NanoHostEpochReceipt
): boolean {
  return (
    isDeepStrictEqual(receipt.intent, intent) &&
    (receipt.disposition === 'refused' ||
      isDeepStrictEqual(
        [...receipt.result.fencedHolderReceiptIds].sort(),
        [...intent.target.holderReceiptIds].sort()
      ))
  );
}
