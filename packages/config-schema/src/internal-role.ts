import { ReasoningEffortSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Shared Assistant budget accommodates five observed slow model rounds and their local Tool work. */
export const ASSISTANT_RUN_DEADLINE_MS = 600_000;

/** Default KM budget leaves room for one slow Provider call without adding a retry. */
export const KNOWLEDGE_MANAGER_RUN_DEADLINE_MS = 300_000;

const InternalRoleLimitsSchema = z
  .object({
    maxModelTurns: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
    // The host timer cannot represent a longer delay.
    deadlineMs: z.number().int().positive().max(2_147_483_647),
  })
  .strict();

const InternalRoleProfileFields = {
  id: z.string().min(1),
  preferredLogicalModelId: z.string().min(1).optional(),
  /** Optional request effort; omission leaves the Provider default unchanged. */
  reasoningEffort: ReasoningEffortSchema.optional(),
  compatibleLogicalModelIds: z.array(z.string().min(1)).default([]),
  requiredLogicalModelCapabilities: z.array(z.string().min(1)).default([]),
};

/** Disjoint role branches preserve the defaults in both the reader and exported JSON Schema. */
export const InternalRoleExecutionProfileSchema = z.union([
  z
    .object({
      ...InternalRoleProfileFields,
      roleId: z.literal('knowledge-manager'),
      limits: InternalRoleLimitsSchema.default({
        maxModelTurns: 16,
        maxToolCalls: 48,
        deadlineMs: KNOWLEDGE_MANAGER_RUN_DEADLINE_MS,
      }),
    })
    .strip(),
  z
    .object({
      ...InternalRoleProfileFields,
      roleId: z.literal('assistant'),
      limits: InternalRoleLimitsSchema.default({
        maxModelTurns: 16,
        maxToolCalls: 48,
        deadlineMs: ASSISTANT_RUN_DEADLINE_MS,
      }),
    })
    .strip(),
  z
    .object({
      ...InternalRoleProfileFields,
      roleId: z
        .string()
        .min(1)
        .regex(/^(?!(?:knowledge-manager|assistant)$)/),
      limits: InternalRoleLimitsSchema.default({
        maxModelTurns: 16,
        maxToolCalls: 48,
        deadlineMs: 120_000,
      }),
    })
    .strip(),
]);

/** Server-scoped internal-role reader; descriptive additions are discarded. */
export const InternalRoleProfilesConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    defaultLogicalModelId: z.string().min(1).optional(),
    profiles: z.array(InternalRoleExecutionProfileSchema).default([]),
    extensions: z.record(z.string().min(1), z.unknown()).optional(),
  })
  .strip()
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
