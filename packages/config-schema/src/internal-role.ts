import { z } from 'zod';

/** One Server-owned internal-role execution profile. */
export const InternalRoleExecutionProfileSchema = z
  .object({
    id: z.string().min(1),
    roleId: z.string().min(1),
    preferredLogicalModelId: z.string().min(1).optional(),
    compatibleLogicalModelIds: z.array(z.string().min(1)).default([]),
    requiredLogicalModelCapabilities: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** Strict Server-scoped internal-role profile file. */
export const InternalRoleProfilesConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    defaultLogicalModelId: z.string().min(1).optional(),
    profiles: z.array(InternalRoleExecutionProfileSchema).default([]),
    extensions: z.record(z.string().min(1), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const [index, profile] of value.profiles.entries()) {
      if (ids.has(profile.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate internal-role profile: ${profile.id}.`,
          path: ['profiles', index, 'id'],
        });
      }
      ids.add(profile.id);
    }
  });

/** Authored internal-role profile configuration. */
export type InternalRoleProfilesConfig = z.infer<typeof InternalRoleProfilesConfigSchema>;
