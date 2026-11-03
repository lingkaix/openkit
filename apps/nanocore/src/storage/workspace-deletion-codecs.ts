import { DeleteWorkspaceRequestSchema } from '@openkit/app-api-schemas';
import { UserIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { ControlCoreSharingActorSchema } from './workspace-sharing-codecs.js';

const owner = {
  actor: ControlCoreSharingActorSchema,
  workspaceId: WorkspaceIdSchema,
  originalOwnerUserId: UserIdSchema,
  expectedRegistryRevision: z.number().int().positive().safe(),
};
/** The two existing Core deletion commits; physical lifecycle work stays between them. */
export const ControlWorkspaceDeletionInputSchema = z.discriminatedUnion('stage', [
  z.object({ ...owner, stage: z.literal('begin') }).strict(),
  z
    .object({
      ...owner,
      stage: z.literal('complete'),
      initiatingUserId: UserIdSchema,
      request: DeleteWorkspaceRequestSchema,
    })
    .strict()
    .refine(
      (value) => value.expectedRegistryRevision === value.request.expectedRegistryRevision + 1
    ),
]);
/** Exact original request and registry tuple, never an arbitrary SQL or lifecycle API. */
export type ControlWorkspaceDeletionInput = z.infer<typeof ControlWorkspaceDeletionInputSchema>;
/** Only the original Audit and receipt identities are needed for the subsequent file phase. */
export const ControlWorkspaceDeletionResultSchema = z.discriminatedUnion('stage', [
  z.object({ stage: z.literal('begin') }).strict(),
  z
    .object({
      stage: z.literal('complete'),
      auditEventId: z.string().min(1),
      commandReceiptKey: z.string().min(1),
    })
    .strict(),
]);
/** Acknowledged Core result; this grants no physical cleanup or new admission authority. */
export type ControlWorkspaceDeletionResult = z.infer<typeof ControlWorkspaceDeletionResultSchema>;
