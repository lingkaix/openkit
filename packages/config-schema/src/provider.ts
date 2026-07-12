import { z } from 'zod';

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
 * File-backed provider profile schema.
 */
export const ProviderProfileSchema = z
  .object({
    baseUrl: z.string().url().optional(),
    category: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    displayName: z.string().min(1),
    extensions: ProviderExtensionsSchema.optional(),
    extraBody: z.record(z.string().min(1), z.unknown()).optional(),
    extraHeaders: z.record(z.string().min(1), z.unknown()).optional(),
    id: z.string().min(1),
    kind: ProviderKindSchema,
    models: z.array(z.string().min(1)).min(1),
    readiness: ProviderReadinessSchema.optional(),
    secretRef: z.string().min(1).optional(),
    vendor: z.string().min(1).optional(),
  })
  .strict();

/**
 * File-backed provider profile.
 */
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
