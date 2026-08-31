import { z } from 'zod';

/** One private Provider route member behind a worker-visible logical model. */
export const GatewayRouteMemberSchema = z
  .object({
    id: z.string().min(1),
    providerProfileId: z.string().min(1),
    providerModel: z.string().min(1),
  })
  .strict();

/** One logical model and its ordered private route members. */
export const GatewayLogicalModelSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().trim().min(1),
    routes: z.array(GatewayRouteMemberSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => addDuplicateIdIssues(value.routes, ctx, ['routes']));

/** Strict Server-scoped Gateway configuration. */
export const GatewayConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean().default(true),
    defaultLogicalModelId: z.string().min(1).optional(),
    logicalModels: z.array(GatewayLogicalModelSchema).default([]),
    requiredFeatures: z.array(z.string().min(1)).default([]),
    extensions: z.record(z.string().min(1), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addDuplicateIdIssues(value.logicalModels, ctx, ['logicalModels']);
    if (
      value.defaultLogicalModelId &&
      !value.logicalModels.some((model) => model.id === value.defaultLogicalModelId)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `Default logical model is not declared: ${value.defaultLogicalModelId}.`,
        path: ['defaultLogicalModelId'],
      });
    }
  });

/** Authored Gateway configuration. */
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

/** Authored logical model. */
export type GatewayLogicalModel = z.infer<typeof GatewayLogicalModelSchema>;

function addDuplicateIdIssues(
  values: readonly { id: string }[],
  ctx: z.RefinementCtx,
  path: Array<string | number>
): void {
  const ids = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (ids.has(value.id)) {
      ctx.addIssue({
        code: 'custom',
        message: `Duplicate id: ${value.id}.`,
        path: [...path, index, 'id'],
      });
    }
    ids.add(value.id);
  }
}
