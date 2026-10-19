import { ThreadIdSchema, UserIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { ProductOperationSchema } from './product-policy.js';

/** Existing required-feature readers must understand restrictions before exposing content. */
export const WORKSPACE_RESOURCE_POLICY_FEATURE = 'openkit.workspace-resource-policy.v1';

/** Family is part of the reference; this slice activates Threads only. */
export const WorkspacePolicyResourceSchema = z
  .object({
    family: z.literal('thread'),
    id: ThreadIdSchema,
  })
  .strict();

/** Exact human or registered Agent responsibility; runtime sessions are not Policy elements. */
export const WorkspacePolicySubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: UserIdSchema }).strict(),
  z
    .object({ kind: z.literal('agent'), userId: UserIdSchema, agentId: z.string().trim().min(1) })
    .strict(),
]);

/** An allocation or prohibition contains current rights, not a receipt or grant identity. */
export const WorkspaceResourceAllocationSchema = z
  .object({
    subject: WorkspacePolicySubjectSchema,
    operations: z
      .array(ProductOperationSchema)
      .min(1)
      .refine(
        (operations) => new Set(operations).size === operations.length,
        'Resource operations must be unique.'
      ),
  })
  .strict();

/** Presence of a resource entry is the managed boundary, including when grants is empty. */
export const WorkspaceResourceAccessEntrySchema = z
  .object({
    resource: WorkspacePolicyResourceSchema,
    grants: z.array(WorkspaceResourceAllocationSchema),
    prohibitions: z.array(WorkspaceResourceAllocationSchema),
  })
  .strict();

/** One Workspace owns the exact current managed boundaries; duplicate targets are ambiguous. */
export const WorkspaceResourceAccessSchema = z
  .array(WorkspaceResourceAccessEntrySchema)
  .superRefine((entries, ctx) => {
    const resources = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const key = JSON.stringify(entry.resource);
      if (resources.has(key))
        ctx.addIssue({
          code: 'custom',
          path: [index, 'resource'],
          message: 'Managed resources must be unique.',
        });
      resources.add(key);
    }
  });

/** Current Workspace-authored managed resource and exact allocations. */
export type WorkspaceResourceAccessEntry = z.infer<typeof WorkspaceResourceAccessEntrySchema>;
/** Current exact User or registered Agent target. */
export type WorkspacePolicySubject = z.infer<typeof WorkspacePolicySubjectSchema>;
