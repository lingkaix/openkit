import { z } from 'zod';
import type { Actor } from './identity.js';
import type {
  NANOHOST_TRANSPORT_TOKEN_SCOPE,
  NANOHOST_TRANSPORT_TOKEN_TYPE,
  NanoHostTransportTokenStatus,
} from './nanohost-transport-token.js';
import type { NanoHostTransportTokenRecord } from './nanohost-transport-token-store.js';

/** Complete original redacted row; strings retain the existing SQL owner’s acceptance. */
export const NanoHostTransportTokenRecordSchema = z.object({
  tokenId: z.string(),
  ownerNanoHostIdentityId: z.string(),
  tokenType: z.literal('nanohost-transport'),
  scope: z.literal('nanohost-transport'),
  deploymentId: z.string(),
  status: z.enum(['active', 'expired', 'rotated', 'revoked']),
  issuedAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  predecessorTokenId: z.string().nullable(),
  rotationOverlapExpiresAt: z.string().nullable(),
  responsibleServerAdminActorId: z.string(),
  lastUsedAt: z.string().nullable(),
  lastUsedChannel: z.string().nullable(),
  lastUsedSource: z.string().nullable(),
}) satisfies z.ZodType<NanoHostTransportTokenRecord>;

/** Existing current-admin facts only; neither secret nor a new authority witness. */
const actor = z
  .object({
    kind: z.enum(['local', 'session', 'token']),
    userId: z.string(),
    tokenId: z.string().optional(),
    adminTokenId: z.string().optional(),
    tokenScope: z.enum(['server-admin', 'workspace', 'workspace-readonly']).optional(),
  })
  .strict();
const clock = z.date().optional();
const issuance = z
  .object({
    tokenId: z.string(),
    tokenHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    ownerNanoHostIdentityId: z.string(),
    deploymentId: z.string(),
    responsibleServerAdminActorId: z.string(),
    expiresAt: z.string(),
    predecessorTokenId: z.string().nullable().optional(),
    now: clock,
  })
  .strict();

/** Closed existing credential tuples and separate successful Audit stages, without material. */
export const ControlNanoHostTransportInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('issue'), record: issuance, actor: actor.optional() }).strict(),
  z.object({ kind: z.literal('enroll'), record: issuance, actor: actor.optional() }).strict(),
  z
    .object({
      kind: z.literal('verify'),
      tokenHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      channel: z.string().optional(),
      source: z.string().optional(),
      now: clock,
    })
    .strict(),
  z
    .object({ kind: z.literal('revoke'), tokenId: z.string(), now: clock, actor: actor.optional() })
    .strict(),
  z
    .object({
      kind: z.literal('cutover'),
      tokenId: z.string(),
      now: clock,
      actor: actor.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('rotate'),
      tokenId: z.string(),
      successorTokenId: z.string(),
      successorTokenHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      overlapSeconds: z.number(),
      now: clock,
      actor: actor.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('abort'),
      predecessorTokenId: z.string(),
      successorTokenId: z.string(),
      now: clock,
      actor: actor.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('decommission'),
      identityId: z.string(),
      deploymentId: z.string(),
      now: clock,
      actor: actor.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('lifecycle-audit'),
      action: z.enum([
        'nanohost.transport.enroll',
        'nanohost.transport.issue',
        'nanohost.transport.revoke',
        'nanohost.transport.rotate',
      ]),
      record: NanoHostTransportTokenRecordSchema,
      actorUserId: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('decommission-audit'),
      identityId: z.string(),
      deploymentId: z.string(),
      actorUserId: z.string(),
      newlyRevokedCount: z.number().int().nonnegative(),
      retainedTokenCount: z.number().int().nonnegative(),
      tokenLineage: z.string(),
    })
    .strict(),
]);
export type ControlNanoHostTransportInput = z.infer<typeof ControlNanoHostTransportInputSchema>;

/** Complete results fixed inside the original savepoint and returned after covering FULL ACK. */
export const ControlNanoHostTransportResultSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('record'), record: NanoHostTransportTokenRecordSchema.nullable() })
    .strict(),
  z
    .object({
      kind: z.literal('rotation'),
      result: z
        .object({
          record: NanoHostTransportTokenRecordSchema,
          rotatedRecord: NanoHostTransportTokenRecordSchema,
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('abort'),
      result: z
        .object({
          predecessor: NanoHostTransportTokenRecordSchema,
          successor: NanoHostTransportTokenRecordSchema,
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('decommission'),
      records: z.array(NanoHostTransportTokenRecordSchema),
    })
    .strict(),
  z.object({ kind: z.literal('audit') }).strict(),
]);
export type ControlNanoHostTransportResult = z.infer<typeof ControlNanoHostTransportResultSchema>;

/** Projects the existing actor’s current-admin inputs without copying unrelated request facts. */
export function nanoHostTransportAdminFacts(value: z.infer<typeof actor>): Actor {
  return {
    kind: value.kind,
    userId: value.userId,
    ...(value.tokenId === undefined ? {} : { tokenId: value.tokenId }),
    ...(value.tokenScope === undefined ? {} : { tokenScope: value.tokenScope }),
    ...(value.adminTokenId === undefined ? {} : { adminTokenId: value.adminTokenId }),
  };
}

/** Exact retained SQL row; the decoder alone projects public non-secret fields. */
export interface NanoHostTransportTokenRow {
  token_id: string;
  token_hash: string;
  owner_nanohost_identity_id: string;
  token_type: typeof NANOHOST_TRANSPORT_TOKEN_TYPE;
  scope: typeof NANOHOST_TRANSPORT_TOKEN_SCOPE;
  deployment_id: string;
  status: NanoHostTransportTokenStatus;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  predecessor_token_id: string | null;
  rotation_overlap_expires_at: string | null;
  responsible_server_admin_actor_id: string;
  last_used_at: string | null;
  last_used_channel: string | null;
  last_used_source: string | null;
}

/** Converts one existing SQL row without re-reading or truncating its committed values. */
export function readNanoHostTransportTokenRecord(
  row: NanoHostTransportTokenRow
): NanoHostTransportTokenRecord {
  return {
    deploymentId: row.deployment_id,
    expiresAt: row.expires_at,
    issuedAt: row.issued_at,
    lastUsedAt: row.last_used_at,
    lastUsedChannel: row.last_used_channel,
    lastUsedSource: row.last_used_source,
    ownerNanoHostIdentityId: row.owner_nanohost_identity_id,
    predecessorTokenId: row.predecessor_token_id,
    responsibleServerAdminActorId: row.responsible_server_admin_actor_id,
    revokedAt: row.revoked_at,
    rotationOverlapExpiresAt: row.rotation_overlap_expires_at,
    scope: row.scope,
    status: row.status,
    tokenId: row.token_id,
    tokenType: row.token_type,
  };
}

/** The existing public administrator-loss refusal; transport accepts only this exact owned projection. */
export const NANOHOST_TRANSPORT_ADMIN_REFUSAL = {
  code: 'deployment_admin_required',
  message: 'Current deployment administrator authority is required.',
  status: 403,
} as const;

/** Whitelists the existing refusal without projecting native SQL diagnostics. */
export function isNanoHostTransportAdminRefusal(
  code: unknown,
  message: unknown,
  status: unknown
): boolean {
  return (
    code === NANOHOST_TRANSPORT_ADMIN_REFUSAL.code &&
    message === NANOHOST_TRANSPORT_ADMIN_REFUSAL.message &&
    status === NANOHOST_TRANSPORT_ADMIN_REFUSAL.status
  );
}
