import { z } from 'zod';

const INLINE_SECRET_FIELDS = ['apiKey', 'clientSecret', 'secret', 'token'] as const;

/**
 * Rejects raw provider secret fields in otherwise extensible provider objects.
 *
 * @param value Provider object being parsed.
 * @param ctx Zod refinement context used to report field-specific issues.
 */
function rejectInlineSecretFields(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  for (const field of INLINE_SECRET_FIELDS) {
    if (Object.hasOwn(value, field)) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} is not supported; use secretRef instead.`,
      });
    }
  }
}

/**
 * Supported provider profile kinds.
 */
export const ProviderKindSchema = z.enum(['direct', 'gateway', 'local', 'oauth', 'custom']);

/**
 * Supported provider profile kind.
 */
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/**
 * Server-owned Codex OAuth account slot identifier.
 */
export const CodexOAuthAccountSlotIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/**
 * Codex OAuth provider extension schema.
 */
export const CodexOAuthProviderExtensionSchema = z
  .object({
    accountSlotId: CodexOAuthAccountSlotIdSchema,
  })
  .strict();

/**
 * OpenKit-owned provider extension namespace schema.
 */
export const OpenKitProviderExtensionSchema = z
  .object({
    codexOAuth: CodexOAuthProviderExtensionSchema.optional(),
  })
  .passthrough();

/**
 * Provider extension schema with typed OpenKit-owned extensions and open vendor namespaces.
 */
export const ProviderExtensionsSchema = z
  .object({
    openkit: OpenKitProviderExtensionSchema.optional(),
  })
  .catchall(z.unknown());

/**
 * Provider readiness status.
 */
export const ProviderReadinessStatusSchema = z.enum([
  'ready',
  'degraded',
  'blocked',
  'disabled',
  'unknown',
]);

/**
 * Provider readiness payload.
 */
export const ProviderReadinessSchema = z
  .object({
    message: z.string().optional(),
    status: ProviderReadinessStatusSchema,
  })
  .strict();

/**
 * Provider retry policy.
 */
export const ProviderRetrySchema = z
  .object({
    attempts: z.number().int().min(0).optional(),
    backoffMs: z.number().int().min(0).optional(),
  })
  .strict();

/**
 * File-backed provider profile schema.
 */
export const ProviderProfileSchema = z
  .object({
    baseUrl: z.string().url().optional(),
    defaultModel: z.string().min(1).optional(),
    displayName: z.string().min(1),
    extensions: ProviderExtensionsSchema.optional(),
    id: z.string().min(1),
    kind: ProviderKindSchema,
    models: z.array(z.string().min(1)).min(1),
    readiness: ProviderReadinessSchema.optional(),
    retry: ProviderRetrySchema.optional(),
    secretRef: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .passthrough()
  .superRefine(rejectInlineSecretFields);

/**
 * File-backed provider profile.
 */
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
