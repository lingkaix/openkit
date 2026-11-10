import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  canonicalIdentifierName,
  compareCodeUnits,
  PolicyDigestV1Schema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { z } from 'zod';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';

/** Loaded authority content only; unrelated snapshot versions and preferences supply no lifetime. */
export const RuntimePolicyIdentitySchema = z
  .object({
    serverRevision: PolicyDigestV1Schema,
    workspaceRevisions: z.array(
      z.object({ workspaceId: WorkspaceIdSchema, revision: PolicyDigestV1Schema }).strict()
    ),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.workspaceRevisions.map((entry) => entry.workspaceId)).size ===
      value.workspaceRevisions.length
  );

/** Disposable identity, never retained Policy or an authorization decision. */
export type RuntimePolicyIdentity = z.infer<typeof RuntimePolicyIdentitySchema>;

const transition = {
  openingId: z.uuid(),
  publisherId: z.uuid(),
  transitionId: z.uuid(),
};

/** Only the bound runtime-config owner publishes; effect packets cannot select loaded state. */
export const RuntimePolicyPublicationInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inspect') }).strict(),
  z
    .object({
      kind: z.literal('close'),
      ...transition,
      expectedTransitionId: z.uuid().nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal('activate'), ...transition, identity: RuntimePolicyIdentitySchema })
    .strict(),
]);

/** Private, non-retained publication commands for one canonical Core opening. */
export type RuntimePolicyPublicationInput = z.infer<typeof RuntimePolicyPublicationInputSchema>;

/** Inspect reports native state, including unavailability, without granting an effect. */
export const RuntimePolicyPublicationResultSchema = z
  .object({
    openingId: z.uuid(),
    state: z.enum(['unavailable', 'closed', 'active']),
    publisherId: z.uuid().nullable(),
    transitionId: z.uuid().nullable(),
    identity: RuntimePolicyIdentitySchema.nullable(),
  })
  .strict()
  .refine((value) =>
    value.state === 'unavailable'
      ? value.publisherId === null && value.transitionId === null && value.identity === null
      : value.publisherId !== null &&
        value.transitionId !== null &&
        (value.state === 'active' ? value.identity !== null : value.identity === null)
  );

/** Actual native-owner observation, not a Main remembered acknowledgement. */
export type RuntimePolicyPublicationResult = z.infer<typeof RuntimePolicyPublicationResultSchema>;

/** OwnedDatabase owns this state and discards it at close; there is no module-level authority map. */
export type NativeRuntimePolicyPublication = RuntimePolicyPublicationResult;

/** Each physical opening starts unavailable, including a reopen of the same retained database. */
export function createNativeRuntimePolicyPublication(): NativeRuntimePolicyPublication {
  return {
    openingId: randomUUID(),
    state: 'unavailable',
    publisherId: null,
    transitionId: null,
    identity: null,
  };
}

// Empty content has an identity, never a grant. The wire owner uses Protocol's canonical digest
// without importing the Policy engine or operation registry into the native publication ABI.
const emptyDocument = { schemaVersion: 1, statements: [] };

/** Derives identities from the manager's installed snapshot, never from an operation's document. */
export function runtimePolicyIdentityForSnapshot(
  snapshot: Pick<RuntimeConfigSnapshot, 'openKitConfig' | 'workspaceConfigs'>
): RuntimePolicyIdentity {
  return RuntimePolicyIdentitySchema.parse({
    serverRevision: `sha256:${sha256Hex(canonicalIdentifierName(snapshot.openKitConfig.policy?.mediation ?? emptyDocument))}`,
    workspaceRevisions: snapshot.workspaceConfigs
      .map((entry) => ({
        workspaceId: entry.workspaceId,
        revision: `sha256:${sha256Hex(canonicalIdentifierName(entry.config.workspace.policy?.mediation ?? emptyDocument))}`,
      }))
      .sort((left, right) => compareCodeUnits(left.workspaceId, right.workspaceId)),
  });
}

/**
 * Applies one transient transition at the owner-wide FIFO head, outside any SQL batch.
 * The caller must serialize this action with the real owner's earlier and later effects.
 * Its acknowledgement proves publication readiness, never a durable Policy commit.
 */
export function applyRuntimePolicyPublication(
  state: NativeRuntimePolicyPublication,
  value: RuntimePolicyPublicationInput
): RuntimePolicyPublicationResult {
  const input = RuntimePolicyPublicationInputSchema.parse(value);
  if (input.kind === 'inspect') return RuntimePolicyPublicationResultSchema.parse(state);
  if (input.openingId !== state.openingId) throw new ControlProductPreconditionError();
  if (input.kind === 'close') {
    if (
      input.expectedTransitionId !== state.transitionId ||
      input.transitionId === state.transitionId ||
      (state.publisherId !== null && input.publisherId !== state.publisherId)
    )
      throw new ControlProductPreconditionError();
    // A fresh explicit transition may supersede this publisher's closed failed handoff.
    // It removes no fence until the new installed identity is separately activated.
    state.state = 'closed';
    state.publisherId = input.publisherId;
    state.transitionId = input.transitionId;
    state.identity = null;
  } else {
    if (
      state.state !== 'closed' ||
      input.publisherId !== state.publisherId ||
      input.transitionId !== state.transitionId
    )
      throw new ControlProductPreconditionError();
    state.identity = structuredClone(input.identity);
    state.state = 'active';
  }
  return RuntimePolicyPublicationResultSchema.parse(state);
}

/** Snapshot equality is content-based; no unrelated reload invalidates unchanged Policy. */
export function sameRuntimePolicyIdentity(
  left: RuntimePolicyIdentity,
  right: RuntimePolicyIdentity
): boolean {
  return isDeepStrictEqual(left, right);
}
