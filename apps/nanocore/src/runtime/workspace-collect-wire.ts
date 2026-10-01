import { z } from 'zod';

/** Private-store references always use SHA-1, independently of the transport digest. */
export const WorkspaceSnapshotPairSchema = z.object({
  tree: z.string().regex(/^[0-9a-f]{40}$/),
  manifest: z.string().regex(/^[0-9a-f]{40}$/),
});
/** Captured tree and full-permission manifest in NanoHost's private store. */
export type WorkspaceSnapshotPair = z.infer<typeof WorkspaceSnapshotPairSchema>;
/** Closed recovery vocabulary owned by Workspace Synchronization. */
export const WorkspaceCollectionRecoveryCauseSchema = z.enum([
  'accepted_base_unknown',
  'previous_head_mismatch',
  'snapshot_unavailable',
  'malformed_manifest',
  'unsafe_path',
  'metadata_unavailable',
  'tree_manifest_disagreement',
  'check_values_unavailable',
  'command_too_large',
  'baseline_unstable',
  'baseline_mismatch',
  'baseline_source_unavailable',
]);
const IdentitySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const RequestIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
const AssociationSchema = z.object({
  requestId: RequestIdSchema,
  storageRef: z
    .string()
    .min(1)
    .refine(
      (value) => Buffer.byteLength(value) <= 512 && value.trim() === value && !/\p{Cc}/u.test(value)
    ),
  scopeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  attachmentGeneration: z.number().int().positive(),
  sandboxId: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= 512 && !/\p{Cc}/u.test(value)),
  workSlot: IdentitySchema,
  collectionId: IdentitySchema,
  checkValues: z.object({
    runtimeEnv: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => !value.includes('\0') && Buffer.byteLength(value) <= 65536)
      )
      .max(128),
    loopbackDigests: z.tuple([RequestIdSchema, RequestIdSchema]),
  }),
});
/** Admits the closed command core while dropping additive untrusted members. */
export const WorkspaceCollectCommandSchema = z.discriminatedUnion('mode', [
  AssociationSchema.extend({
    mode: z.literal('baseline'),
    acceptedBase: z.null(),
    previousHead: z.null(),
  }),
  AssociationSchema.extend({
    mode: z.literal('capture'),
    acceptedBase: WorkspaceSnapshotPairSchema,
    previousHead: WorkspaceSnapshotPairSchema,
  }),
]);
/** Already admitted collection command. */
export type WorkspaceCollectCommand = z.infer<typeof WorkspaceCollectCommandSchema>;
const ResultSchema = z.object({ requestId: RequestIdSchema });
/** Collection JSON results have no file-export absence or failureCode aliases. */
export const WorkspaceCollectJsonResultSchema = z.discriminatedUnion('outcome', [
  ResultSchema.extend({ outcome: z.literal('baseline'), head: WorkspaceSnapshotPairSchema }),
  ResultSchema.extend({ outcome: z.literal('no_new_head'), unstable: z.boolean() }),
  ResultSchema.extend({
    outcome: z.literal('empty'),
    head: WorkspaceSnapshotPairSchema,
    previousHead: WorkspaceSnapshotPairSchema,
    acceptedBase: WorkspaceSnapshotPairSchema,
    unstable: z.boolean(),
  }),
  ResultSchema.extend({ outcome: z.literal('credential_hit') }),
  ResultSchema.extend({ outcome: z.literal('effect_failed') }),
  ResultSchema.extend({
    outcome: z.literal('recovery_required'),
    cause: WorkspaceCollectionRecoveryCauseSchema,
  }),
]);
/** Closed JSON result admitted by the private transport boundary. */
export type WorkspaceCollectJsonResult = z.infer<typeof WorkspaceCollectJsonResultSchema>;

/** Compares both snapshot components; tree equality alone loses permission-only captures. */
export function sameWorkspaceSnapshot(
  left: WorkspaceSnapshotPair,
  right: WorkspaceSnapshotPair
): boolean {
  return left.tree === right.tree && left.manifest === right.manifest;
}

/** Validates correlation and command form before acknowledging a collection JSON result. */
export function admitWorkspaceCollectJsonResult(
  value: unknown,
  command: WorkspaceCollectCommand
): WorkspaceCollectJsonResult {
  const result = WorkspaceCollectJsonResultSchema.parse(value);
  if (result.requestId !== command.requestId)
    throw new Error('Workspace collection request identity disagrees.');
  if (result.outcome === 'baseline' && command.mode !== 'baseline')
    throw new Error('Workspace collection baseline result disagrees with capture mode.');
  if (
    (result.outcome === 'empty' || result.outcome === 'no_new_head') &&
    command.mode !== 'capture'
  )
    throw new Error('Workspace collection capture result disagrees with baseline mode.');
  if (
    result.outcome === 'empty' &&
    command.mode === 'capture' &&
    (!sameWorkspaceSnapshot(result.previousHead, command.previousHead) ||
      !sameWorkspaceSnapshot(result.acceptedBase, command.acceptedBase) ||
      sameWorkspaceSnapshot(result.head, command.previousHead) ||
      !sameWorkspaceSnapshot(result.head, command.acceptedBase))
  )
    throw new Error('Workspace collection empty result disagrees with its snapshot chain.');
  return result;
}

/** Closed collection failure propagated without converting it into an empty capture or apply conflict. */
export class WorkspaceCollectionError extends Error {
  /** Definite collection outcome; lost delivery is separately unknown. */
  public readonly outcome: 'recovery_required' | 'credential_hit' | 'effect_failed';
  /** Closed recovery distinction when the collection requires recovery. */
  public override readonly cause:
    | z.infer<typeof WorkspaceCollectionRecoveryCauseSchema>
    | undefined;
  public constructor(result: {
    outcome: 'recovery_required' | 'credential_hit' | 'effect_failed';
    cause?: unknown;
  }) {
    const cause =
      result.outcome === 'recovery_required'
        ? WorkspaceCollectionRecoveryCauseSchema.parse(result.cause)
        : undefined;
    super(`Workspace collection ${result.outcome}${cause ? `:${cause}` : ''}.`);
    this.name = 'WorkspaceCollectionError';
    this.outcome = result.outcome;
    this.cause = cause;
  }
}
