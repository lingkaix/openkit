import { isDeepStrictEqual } from 'node:util';
import { sha256CanonicalJson } from '@openkit/protocol/digest';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { mutateNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import {
  epochPlacementOfIntent,
  matchesNanoHostEpochReceipt,
  type NanoHostEpochPlacement,
  vaultEpochFenceOccurrence,
} from './nanohost-epoch-invalidation.js';
import {
  NanoHostEpochPlacementSchema as epochPlacement,
  type NanoHostRuntimeTargetTransition,
  NanoHostRuntimeTargetTransitionSchema,
} from './nanohost-epoch-invalidation-codecs.js';
import type { NanoHostEpochInvalidation, NanoHostEpochReceipt } from './nanohost-port.js';
import {
  type ControlRuntimeTargetInput,
  type ControlRuntimeTargetResult,
  ControlRuntimeTargetResultSchema,
  RuntimeTargetRefusal,
} from './runtime-target-codecs.js';
import { type StorageResult, storageRequestId } from './storage-owner.js';

export type { NanoHostRuntimeTargetTransition } from './nanohost-epoch-invalidation-codecs.js';

const epochIntent = z.object({
  deploymentId: epochPlacement.shape.deploymentId,
  sourceOwner: z.literal('nanohost'),
  verb: z.literal('fence-vault-epoch'),
  occurrenceKey: z.string().min(1),
  requestId: z.string().min(1),
  expectedGeneration: epochPlacement.shape.generation,
  inputDigest: z.string().min(1),
  target: epochPlacement.omit({ deploymentId: true, generation: true }).extend({
    holderReceiptIds: z.array(z.string().min(1)),
  }),
});

const epochReceipt = z.intersection(
  z.object({ intent: epochIntent, receiptDigest: z.string().min(1) }),
  z.discriminatedUnion('disposition', [
    z.object({
      disposition: z.literal('applied'),
      result: z.object({ fencedHolderReceiptIds: z.array(z.string().min(1)) }),
    }),
    z.object({ disposition: z.literal('refused'), reason: z.string().min(1) }),
  ])
);

const retainedTargetState = z.object({
  schemaVersion: z.literal(1),
  placement: epochPlacement.nullable(),
  intent: epochIntent.nullable(),
  receipt: epochReceipt.nullable(),
  lastTransition: z
    .object({
      occurrenceId: NanoHostRuntimeTargetTransitionSchema.shape.occurrenceId,
      originalDigest: z.string().regex(/^[a-f0-9]{64}$/),
      result: ControlRuntimeTargetResultSchema.unwrap(),
    })
    .optional(),
});

const recoveryRequired = {
  state: 'unavailable',
  owner: 'nanohost',
  reason: 'recovery-required',
} as const;

function matchesEpochIntent(placement: NanoHostEpochPlacement, intent: NanoHostEpochInvalidation) {
  const occurrence = vaultEpochFenceOccurrence(placement);
  return (
    isDeepStrictEqual(placement, epochPlacementOfIntent(intent)) &&
    intent.occurrenceKey === occurrence.occurrenceKey &&
    intent.requestId === storageRequestId(occurrence) &&
    intent.inputDigest === sha256CanonicalJson(intent.target) &&
    new Set(intent.target.holderReceiptIds).size === intent.target.holderReceiptIds.length
  );
}

function readRetainedTargetState(raw: string | null | undefined) {
  if (raw === null || raw === undefined) return null;
  const state = retainedTargetState.parse(JSON.parse(raw));
  if (
    (state.intent && (!state.placement || !matchesEpochIntent(state.placement, state.intent))) ||
    (state.receipt && (!state.intent || !matchesNanoHostEpochReceipt(state.intent, state.receipt)))
  )
    throw new RuntimeTargetRefusal('Retained NanoHost epoch fence conflicts.');
  return state;
}

function readEpochFence(raw: string | null | undefined) {
  const state = readRetainedTargetState(raw);
  return state?.placement ? { ...state, placement: state.placement } : null;
}

const targetSelection = `SELECT target_id AS targetId, identity_id AS identityId,
  deployment_id AS deploymentId, physical_epoch AS physicalEpoch,
  connection_generation AS generation, ready, fresh_empty AS freshEmpty,
  vault_epoch_fence_json AS epochFence FROM nanohost_runtime_targets`;

type EpochTargetRow = {
  readonly targetId: string;
  readonly identityId: string;
  readonly deploymentId: string;
  readonly physicalEpoch: string | null;
  readonly generation: number;
  readonly ready: 0 | 1;
  readonly freshEmpty: 0 | 1;
  readonly epochFence: string | null;
};

function readTarget(sqlite: Database.Database, targetId: string) {
  return sqlite.prepare(`${targetSelection} WHERE target_id = ?`).get(targetId) as
    | EpochTargetRow
    | undefined;
}

function readTransitionTarget(sqlite: Database.Database, input: ControlRuntimeTargetInput) {
  if (input.kind !== 'restart') return readTarget(sqlite, input.targetId);
  const targets = sqlite.prepare(`${targetSelection} LIMIT 2`).all() as EpochTargetRow[];
  if (targets.length > 1)
    throw new RuntimeTargetRefusal('NanoHost restart found multiple configured RuntimeTargets.');
  return targets[0];
}

function assertRetiringTarget(
  target: EpochTargetRow | undefined,
  placement: NanoHostEpochPlacement
) {
  if (
    !target ||
    target.targetId !== placement.runtimeTargetId ||
    target.deploymentId !== placement.deploymentId ||
    String(target.generation) !== placement.generation ||
    target.ready !== 0 ||
    target.freshEmpty !== 0 ||
    target.physicalEpoch !== null
  )
    throw new RuntimeTargetRefusal('NanoHost epoch retirement contradicts the current target.');
}

function readRetirement(
  target: EpochTargetRow | undefined,
  input: ControlRuntimeTargetInput,
  fence: ReturnType<typeof readEpochFence>
): NanoHostEpochPlacement | null {
  if (!target) return null;
  if (
    (input.kind === 'allocate' || input.kind === 'ready') &&
    (input.deploymentId !== target.deploymentId || input.identityId !== target.identityId)
  )
    throw new RuntimeTargetRefusal(
      'NanoHost RuntimeTarget transition identity or deployment conflicts.'
    );
  if (input.kind === 'allocate' && target.generation >= Number.MAX_SAFE_INTEGER)
    throw new RuntimeTargetRefusal('NanoHost RuntimeTarget connection generation overflow.');
  if (input.kind === 'close') {
    if (
      input.closedGeneration > target.generation ||
      (input.authoritativeGeneration !== null && input.authoritativeGeneration > target.generation)
    )
      throw new RuntimeTargetRefusal(
        'NanoHost RuntimeTarget close generation exceeds durable high-water.'
      );
    if (input.closedGeneration !== target.generation) return null;
  }

  if (input.kind === 'ready') {
    if (
      input.connectionGeneration !== target.generation ||
      fence?.placement.generation === String(target.generation)
    ) {
      throw new RuntimeTargetRefusal('The NanoHost RuntimeTarget generation cannot become ready.');
    }
    return target.ready === 0 ? (fence?.placement ?? null) : null;
  }
  if (fence && fence.receipt?.disposition !== 'applied') {
    assertRetiringTarget(target, fence.placement);
    return fence.placement;
  }
  if (!target.ready && !target.freshEmpty && target.physicalEpoch === null)
    return fence?.placement ?? null;
  if (!target.ready || !target.freshEmpty || target.physicalEpoch === null)
    throw new RuntimeTargetRefusal('NanoHost RuntimeTarget readiness facts conflict.');
  return epochPlacement.parse({
    deploymentId: target.deploymentId,
    runtimeTargetId: target.targetId,
    physicalEpoch: target.physicalEpoch,
    generation: String(target.generation),
  });
}

/** Captures the predecessor and its fence on one admitted read before any Core request. */
export function prepareNanoHostRuntimeTargetTransition(
  sqlite: Database.Database,
  input: ControlRuntimeTargetInput,
  occurrenceId: string
): NanoHostRuntimeTargetTransition {
  const target = readTransitionTarget(sqlite, input);
  const fence = readEpochFence(target?.epochFence);
  return NanoHostRuntimeTargetTransitionSchema.parse({
    occurrenceId,
    input,
    predecessor: target
      ? {
          targetId: target.targetId,
          generation: target.generation,
          fence: fence?.placement ?? null,
        }
      : null,
    retirement: readRetirement(target, input, fence),
  });
}

function matchesTransitionPredecessor(
  original: NanoHostRuntimeTargetTransition,
  target: EpochTargetRow | undefined
) {
  const { predecessor } = original;
  return predecessor === null
    ? !target
    : target?.targetId === predecessor.targetId && target.generation === predecessor.generation;
}

function readExactTransitionOutcome(
  original: NanoHostRuntimeTargetTransition,
  state: z.infer<typeof retainedTargetState> | null
) {
  const last = state?.lastTransition;
  if (last?.occurrenceId !== original.occurrenceId) return null;
  return last.originalDigest === sha256CanonicalJson(original)
    ? ({ state: 'ready', value: last.result } as const)
    : recoveryRequired;
}

/** Recovers the exact outcome or checks that the original is still pending before Core contact. */
export function inspectNanoHostRuntimeTargetTransition(
  sqlite: Database.Database,
  input: NanoHostRuntimeTargetTransition
): StorageResult<
  'nanohost',
  { state: 'pending' } | { state: 'committed'; result: ControlRuntimeTargetResult }
> {
  const original = NanoHostRuntimeTargetTransitionSchema.parse(input);
  const target = readTransitionTarget(sqlite, original.input);
  const retained = readRetainedTargetState(target?.epochFence);
  const outcome = readExactTransitionOutcome(original, retained);
  if (outcome)
    return outcome.state === 'ready'
      ? { state: 'ready', value: { state: 'committed', result: outcome.value } }
      : outcome;

  const fence = retained?.placement ?? null;
  if (
    !matchesTransitionPredecessor(original, target) ||
    (!isDeepStrictEqual(fence, original.predecessor?.fence ?? null) &&
      !isDeepStrictEqual(fence, original.retirement))
  ) {
    return recoveryRequired;
  }
  return { state: 'ready', value: { state: 'pending' } };
}

/** Independently verifies the exact durable readiness hold from an admitted existing-only read. */
export function verifyNanoHostRetiringPlacement(
  sqlite: Database.Database,
  placement: NanoHostEpochPlacement
): boolean {
  const target = readTarget(sqlite, placement.runtimeTargetId);
  const fence = readEpochFence(target?.epochFence);
  if (
    !fence ||
    fence.receipt?.disposition === 'applied' ||
    !isDeepStrictEqual(fence.placement, placement)
  )
    return false;
  assertRetiringTarget(target, placement);
  return true;
}

/** Independently verifies the exact original intent under the native readiness hold. */
export function verifyNanoHostStagedEpochInvalidation(
  sqlite: Database.Database,
  intent: NanoHostEpochInvalidation
): boolean {
  const target = readTarget(sqlite, intent.target.runtimeTargetId);
  const fence = readEpochFence(target?.epochFence);
  if (!fence || fence.receipt || !isDeepStrictEqual(fence.intent, intent)) return false;
  assertRetiringTarget(target, fence.placement);
  return true;
}

/** Closes readiness and retains the exact retiring placement before Core reserves its holder set. */
export function beginNanoHostEpochRetirement(
  sqlite: Database.Database,
  input: NanoHostEpochPlacement
): void {
  assertControlProductWriter(sqlite);
  const placement = epochPlacement.parse(input);
  const target = readTarget(sqlite, placement.runtimeTargetId);
  if (
    !target ||
    target.deploymentId !== placement.deploymentId ||
    String(target.generation) !== placement.generation
  )
    throw new RuntimeTargetRefusal('NanoHost epoch retirement has no exact target generation.');

  const previous = readRetainedTargetState(target.epochFence);
  if (previous?.placement && isDeepStrictEqual(previous.placement, placement)) {
    assertRetiringTarget(target, placement);
    return;
  }
  if (
    target.ready !== 1 ||
    target.freshEmpty !== 1 ||
    target.physicalEpoch !== placement.physicalEpoch ||
    (previous?.placement &&
      (previous.receipt?.disposition !== 'applied' ||
        previous.placement.generation === placement.generation))
  )
    throw new RuntimeTargetRefusal('NanoHost epoch retirement conflicts with the current target.');

  const fence = {
    schemaVersion: 1,
    placement,
    intent: null,
    receipt: null,
    lastTransition: previous?.lastTransition,
  };
  const changed = sqlite
    .prepare(
      `UPDATE nanohost_runtime_targets SET ready = 0, fresh_empty = 0, physical_epoch = NULL,
        vault_epoch_fence_json = ? WHERE target_id = ? AND connection_generation = ?
        AND physical_epoch = ? AND vault_epoch_fence_json IS ?`
    )
    .run(
      JSON.stringify(fence),
      placement.runtimeTargetId,
      target.generation,
      target.physicalEpoch,
      target.epochFence
    );
  if (changed.changes !== 1)
    throw new RuntimeTargetRefusal('NanoHost epoch retirement lost its original target.');
}

function replaceTargetState(
  sqlite: Database.Database,
  targetId: string,
  previous: string | null,
  next: z.infer<typeof retainedTargetState>
): void {
  const changed = sqlite
    .prepare(
      `UPDATE nanohost_runtime_targets SET vault_epoch_fence_json = ?
        WHERE target_id = ? AND vault_epoch_fence_json IS ?`
    )
    .run(JSON.stringify(next), targetId, previous);
  if (changed.changes !== 1)
    throw new RuntimeTargetRefusal('NanoHost epoch fence lost its original record.');
}

/** Stages the exact intent returned by the Core holder reservation. */
export function stageNanoHostEpochInvalidation(
  sqlite: Database.Database,
  input: NanoHostEpochInvalidation
): void {
  assertControlProductWriter(sqlite);
  const intent = epochIntent.parse(input);
  const target = readTarget(sqlite, intent.target.runtimeTargetId);
  const fence = readEpochFence(target?.epochFence);
  if (!fence || !matchesEpochIntent(fence.placement, intent))
    throw new RuntimeTargetRefusal('NanoHost epoch fence intent has no exact retiring placement.');
  if (fence.intent) {
    if (!isDeepStrictEqual(fence.intent, intent))
      throw new RuntimeTargetRefusal('NanoHost epoch fence intent replay conflicts.');
    return;
  }
  replaceTargetState(sqlite, intent.target.runtimeTargetId, target?.epochFence ?? null, {
    ...fence,
    intent,
  });
}

function readCurrentEpochFence(sqlite: Database.Database) {
  const targets = sqlite
    .prepare(`${targetSelection} WHERE vault_epoch_fence_json IS NOT NULL LIMIT 2`)
    .all() as EpochTargetRow[];
  if (targets.length > 1)
    throw new RuntimeTargetRefusal('NanoHost epoch fence target is ambiguous.');
  const target = targets[0];
  const fence = readEpochFence(target?.epochFence);
  if (fence && fence.receipt?.disposition !== 'applied')
    assertRetiringTarget(target, fence.placement);
  return fence;
}

/** Recovers the original intent by ID after restart or a lost acknowledgement. */
export function readNanoHostEpochInvalidation(
  sqlite: Database.Database,
  requestId: string
): NanoHostEpochInvalidation | null {
  const intent = readCurrentEpochFence(sqlite)?.intent;
  return intent?.requestId === requestId ? intent : null;
}

/** Recovers an unresolved retirement before or after the holder reservation. */
export function readPendingNanoHostEpochRetirement(
  sqlite: Database.Database
): NanoHostEpochPlacement | null {
  const fence = readCurrentEpochFence(sqlite);
  return fence && fence.receipt?.disposition !== 'applied' ? fence.placement : null;
}

/** Records the deciding receipt exactly once against the staged native generation. */
export function settleNanoHostEpochInvalidation(
  sqlite: Database.Database,
  input: NanoHostEpochReceipt
): void {
  assertControlProductWriter(sqlite);
  const receipt = epochReceipt.parse(input);
  const targetId = receipt.intent.target.runtimeTargetId;
  const target = readTarget(sqlite, targetId);
  const fence = readEpochFence(target?.epochFence);
  if (!fence?.intent || !matchesNanoHostEpochReceipt(fence.intent, receipt))
    throw new RuntimeTargetRefusal('NanoHost epoch fence receipt has no exact original intent.');
  if (fence.receipt) {
    if (!isDeepStrictEqual(fence.receipt, receipt))
      throw new RuntimeTargetRefusal('NanoHost epoch fence receipt replay conflicts.');
    return;
  }
  assertRetiringTarget(target, fence.placement);
  replaceTargetState(sqlite, targetId, target?.epochFence ?? null, { ...fence, receipt });
}

/** Guards generation replacement and prevents a fenced generation from returning to readiness. */
function assertNanoHostEpochTransition(
  target: EpochTargetRow | undefined,
  retained: z.infer<typeof retainedTargetState> | null,
  input: ControlRuntimeTargetInput
): void {
  if (!target || (input.kind === 'close' && input.closedGeneration !== target.generation)) return;

  const fence = retained?.placement;
  if (fence && retained?.receipt?.disposition !== 'applied')
    throw new RuntimeTargetRefusal('NanoHost epoch fence has no applied Vault receipt.');
  if (input.kind === 'ready') {
    if (fence?.generation === String(input.connectionGeneration))
      throw new RuntimeTargetRefusal('The invalidated NanoHost generation cannot become ready.');
    return;
  }
  if (target.physicalEpoch !== null)
    throw new RuntimeTargetRefusal(
      'The current NanoHost epoch must be fenced before invalidation.'
    );
}

/** Applies a target mutation on the extension owner with its required Vault epoch fence. */
export function applyNanoHostRuntimeTargetMutation(
  sqlite: Database.Database,
  input: NanoHostRuntimeTargetTransition
): StorageResult<'nanohost', ControlRuntimeTargetResult> {
  assertControlProductWriter(sqlite);
  const original = NanoHostRuntimeTargetTransitionSchema.parse(input);
  const target = readTransitionTarget(sqlite, original.input);
  const retained = readRetainedTargetState(target?.epochFence);

  const outcome = readExactTransitionOutcome(original, retained);
  if (outcome) return outcome;

  const fence = retained?.placement ?? null;
  const expectedFence = original.retirement ?? original.predecessor?.fence ?? null;
  if (!matchesTransitionPredecessor(original, target) || !isDeepStrictEqual(fence, expectedFence)) {
    return recoveryRequired;
  }

  assertNanoHostEpochTransition(target, retained, original.input);
  const value = mutateNanoHostRuntimeTarget({ sqlite }, original.input);
  if (value) {
    replaceTargetState(sqlite, value.targetId, target?.epochFence ?? null, {
      schemaVersion: 1,
      placement: fence,
      intent: retained?.intent ?? null,
      receipt: retained?.receipt ?? null,
      lastTransition: {
        occurrenceId: original.occurrenceId,
        originalDigest: sha256CanonicalJson(original),
        result: value,
      },
    });
  }
  return { state: 'ready', value };
}
