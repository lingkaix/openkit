import { z } from 'zod';
import { WorkspaceSnapshotPairSchema } from '../runtime/workspace-collect-wire.js';
import { WorkspaceCollectionIdentitySchema } from '../runtime/workspace-snapshot-chain.js';

/** Exact two baseline stages; external source verification remains between their acknowledgements. */
export const ControlWorkspaceBaselineSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('initialize'), identity: WorkspaceCollectionIdentitySchema })
    .strict(),
  z
    .object({
      action: z.literal('accept'),
      identity: WorkspaceCollectionIdentitySchema,
      head: WorkspaceSnapshotPairSchema,
      expectedTree: z.string().nullable(),
      acceptedCommit: z.string().nullable(),
    })
    .strict(),
]);
/** Closed existing baseline publication inputs, with no authority decision or SQL. */
export type ControlWorkspaceBaseline = z.infer<typeof ControlWorkspaceBaselineSchema>;

const CauseSchema = z.enum([
  'accepted_base_unknown',
  'baseline_source_unavailable',
  'baseline_mismatch',
]);
/** Exact original closed refusal messages, without native SQL diagnostics. */
export const ControlWorkspaceBaselineRefusalSchema = z.discriminatedUnion('code', [
  z
    .object({
      operation: z.literal('workspace-baseline'),
      code: z.literal('collection_refused'),
      cause: CauseSchema,
      message: z.string(),
      status: z.literal(409),
    })
    .strict()
    .refine((value) => value.message === `Workspace collection recovery_required:${value.cause}.`),
  z
    .object({
      operation: z.literal('workspace-baseline'),
      code: z.literal('cursor_conflict'),
      message: z.literal('Workspace baseline identity conflicts with the retained cursor.'),
      status: z.literal(409),
    })
    .strict(),
  z
    .object({
      operation: z.literal('workspace-baseline'),
      code: z.literal('unsupported_retained_format'),
      message: z.literal('Unsupported retained record format.'),
      status: z.literal(409),
    })
    .strict(),
]);
