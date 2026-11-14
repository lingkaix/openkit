import { deriveEntityId } from '@openkit/protocol';
import { z } from 'zod';
import { uuidv5 } from '../generative-kernel/uuid.js';
import { artifactReferenceItemId } from '../lib/artifact-reference-id.js';

const Text = z.string().min(1);
const AssignedCounter = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SecurityKeySchema = z.union([
  z.tuple([z.literal('finding'), Text, Text, Text]),
  z.tuple([z.literal('event'), Text]),
  z.tuple([z.literal('gap'), AssignedCounter, Text, Text]),
]);
const RequestIdentitySchema = z
  .object({
    key: SecurityKeySchema,
    recipientUserId: Text,
    occurrence: z
      .object({
        kind: z.enum(['initial', 'reopen', 'reminder', 'renotice', 'conflict']),
        n: AssignedCounter,
      })
      .strict(),
  })
  .strict();

/** Exact declared E4 item key; the native trigger owns its meaning and counter allocation. */
export type SecurityItemKey =
  | readonly ['finding', string, string, string]
  | readonly ['event', string]
  | readonly ['gap', number, string, string];

/**
 * Recomputes an E4 request from its already assigned native occurrence inputs.
 * Object member order is the owner-declared UUID name, not sorted canonical JSON.
 * No normalization, allocation, retained write or publication authority is supplied.
 *
 * @param input Exact item, recipient and already allocated occurrence.
 * @returns Bare URL-namespace UUIDv5, without an entity prefix.
 */
export function securityRequestId(input: {
  readonly key: SecurityItemKey;
  readonly recipientUserId: string;
  readonly occurrence: {
    readonly kind: 'initial' | 'reopen' | 'reminder' | 'renotice' | 'conflict';
    readonly n: number;
  };
}): string {
  const value = RequestIdentitySchema.parse(input);
  return uuidv5(
    JSON.stringify({
      kind: 'security-request',
      key: value.key,
      recipientUserId: value.recipientUserId,
      occurrence: { kind: value.occurrence.kind, n: value.occurrence.n },
    })
  );
}

/**
 * Recomputes the recipient's already assigned private security Thread generation.
 *
 * @param recipientUserId Exact recipient; current eligibility remains the caller's obligation.
 * @param generation Existing native generation, starting at one; never incremented here.
 * @returns Shared Protocol-derived Thread identity.
 */
export function securityThreadId(recipientUserId: string, generation: number): string {
  return deriveEntityId('th', [
    'security',
    Text.parse(recipientUserId),
    AssignedCounter.parse(generation),
  ]);
}

/** Derives the original report Artifact identity from the exact E4 request. */
export function securityReportArtifactId(requestId: string): string {
  return deriveEntityId('ar', ['security-report', Text.parse(requestId)]);
}

/**
 * Recomputes the closed E4 publication tuple using the existing entity-id owner.
 * Pending Request capability identity remains with Pending Requests, not this helper.
 *
 * @param requestId Exact retained request identity.
 * @returns The two Turn and three Item identities; no tuple is written or repaired.
 */
export function securityPublicationIds(requestId: string): {
  raiseTurnId: string;
  statusTurnId: string;
  reportItemId: string;
  requestItemId: string;
  statusItemId: string;
} {
  Text.parse(requestId);
  return {
    raiseTurnId: deriveEntityId('tu', ['security-raise', requestId]),
    statusTurnId: deriveEntityId('tu', ['security-status', requestId]),
    reportItemId: artifactReferenceItemId(
      securityReportArtifactId(requestId),
      deriveEntityId('tu', ['security-raise', requestId])
    ),
    requestItemId: deriveEntityId('it', [requestId, 'request']),
    statusItemId: deriveEntityId('it', [requestId, 'status']),
  };
}
