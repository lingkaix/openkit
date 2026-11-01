import { ItemIdSchema, ThreadIdSchema, UserIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Original product-safe failure; no SQLite diagnostics cross the native boundary. */
export const THREAD_READ_RECEIPT_INVALID = 'Thread read receipt storage content is invalid.';
/** Exact canonical identities; membership has no ordinal or per-Thread count cap. */
export const ThreadReadItemIdsSchema = ItemIdSchema.array();

/** The native result is a unique, code-unit ordered membership set. */
export const ThreadReadMembershipResultSchema = ThreadReadItemIdsSchema.refine((ids) =>
  ids.every((id, index) => index === 0 || ids[index - 1]! < id)
);
/** Closed User-owned membership envelope; identifiers use the existing binary byte account. */
export const ControlThreadReadMembershipWireSchema = z
  .object({
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    byteLength: z.number().int().positive().safe(),
  })
  .strict();
/** Exact private native envelope, never a callback or SQL statement. */
export type ControlThreadReadMembershipWire = z.infer<typeof ControlThreadReadMembershipWireSchema>;
/** Main-owned snapshot before finite native admission and copying. */
export type ControlThreadReadMembership = Omit<ControlThreadReadMembershipWire, 'byteLength'> & {
  readonly itemIds: readonly string[];
};
