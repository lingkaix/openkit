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
} from './nanohost-epoch-invalidation.js';
import type { NanoHostEpochInvalidation, NanoHostEpochReceipt } from './nanohost-port.js';
import { type ControlRuntimeTargetInput, RuntimeTargetRefusal } from './runtime-target-codecs.js';
import { storageRequestId } from './storage-owner.js';

const epochPlacement = z.object({
  deploymentId: z.string().min(1),
  runtimeTargetId: z.string().min(1),
  physicalEpoch: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.string().regex(/^[1-9][0-9]*$/),
});

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

const retainedEpochFence = z.object({
  schemaVersion: z.literal(1),
  placement: epochPlacement,
  intent: epochIntent.nullable(),
  receipt: epochReceipt.nullable(),
});

function matchesEpochIntent(placement: NanoHostEpochPlacement, intent: NanoHostEpochInvalidation) {
  return (
    isDeepStrictEqual(placement, epochPlacementOfIntent(intent)) &&
    intent.requestId === storageRequestId(intent) &&
    intent.inputDigest === sha256CanonicalJson(intent.target) &&
    new Set(intent.target.holderReceiptIds).size === intent.target.holderReceiptIds.length
  );
}

function readEpochFence(raw: string | null | undefined) {
  if (raw === null || raw === undefined) return null;
  const fence = retainedEpochFence.parse(JSON.parse(raw));
  if (
    (fence.intent && !matchesEpochIntent(fence.placement, fence.intent)) ||
    (fence.receipt && (!fence.intent || !matchesNanoHostEpochReceipt(fence.intent, fence.receipt)))
  )
    throw new RuntimeTargetRefusal('Retained NanoHost epoch fence conflicts.');
  return fence;
}

const targetSelection = `SELECT target_id AS targetId, deployment_id AS deploymentId,
  physical_epoch AS physicalEpoch, connection_generation AS generation, ready,
  vault_epoch_fence_json AS epochFence FROM nanohost_runtime_targets`;

type EpochTargetRow = {
  readonly targetId: string;
  readonly deploymentId: string;
  readonly physicalEpoch: string | null;
  readonly generation: number;
  readonly ready: 0 | 1;
  readonly epochFence: string | null;
};

function readTarget(sqlite: Database.Database, targetId: string) {
  return sqlite.prepare(`${targetSelection} WHERE target_id = ?`).get(targetId) as
    | EpochTargetRow
    | undefined;
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
    target.physicalEpoch !== null
  )
    throw new RuntimeTargetRefusal('NanoHost epoch retirement contradicts the current target.');
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

  const previous = readEpochFence(target.epochFence);
  if (previous && isDeepStrictEqual(previous.placement, placement)) {
    assertRetiringTarget(target, placement);
    return;
  }
  if (
    target.ready !== 1 ||
    target.physicalEpoch !== placement.physicalEpoch ||
    (previous &&
      (previous.receipt?.disposition !== 'applied' ||
        previous.placement.generation === placement.generation))
  )
    throw new RuntimeTargetRefusal('NanoHost epoch retirement conflicts with the current target.');

  const fence = { schemaVersion: 1, placement, intent: null, receipt: null };
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

function replaceEpochFence(
  sqlite: Database.Database,
  targetId: string,
  previous: string | null | undefined,
  next: z.infer<typeof retainedEpochFence>
): void {
  const changed = sqlite
    .prepare(
      `UPDATE nanohost_runtime_targets SET vault_epoch_fence_json = ?
        WHERE target_id = ? AND vault_epoch_fence_json = ?`
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
  replaceEpochFence(sqlite, intent.target.runtimeTargetId, target?.epochFence, {
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
  replaceEpochFence(sqlite, targetId, target?.epochFence, { ...fence, receipt });
}

/** Guards generation replacement and prevents a fenced generation from returning to readiness. */
function assertNanoHostEpochTransition(
  sqlite: Database.Database,
  input: ControlRuntimeTargetInput
): void {
  const target =
    input.kind === 'restart'
      ? (sqlite.prepare(targetSelection).get() as EpochTargetRow | undefined)
      : readTarget(sqlite, input.targetId);
  if (!target || (input.kind === 'close' && input.closedGeneration !== target.generation)) return;

  const fence = readEpochFence(target.epochFence);
  if (fence && fence.receipt?.disposition !== 'applied')
    throw new RuntimeTargetRefusal('NanoHost epoch fence has no applied Vault receipt.');
  if (input.kind === 'ready') {
    if (fence?.placement.generation === String(input.connectionGeneration))
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
  input: ControlRuntimeTargetInput
) {
  assertControlProductWriter(sqlite);
  assertNanoHostEpochTransition(sqlite, input);
  return mutateNanoHostRuntimeTarget({ sqlite }, input);
}
