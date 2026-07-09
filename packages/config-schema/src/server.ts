import { z } from 'zod';

import { ProviderExtensionsSchema, ProviderKindSchema } from './provider.js';

const INLINE_SECRET_FIELDS = ['apiKey', 'clientSecret', 'secret', 'token'] as const;

/**
 * Rejects raw provider secret fields in configured server provider entries.
 *
 * @param value Server provider object being parsed.
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
 * Core deployment mode loaded from server config.
 */
export const CoreModeSchema = z.enum(['local', 'server']);

/**
 * Core deployment mode.
 */
export type CoreMode = z.infer<typeof CoreModeSchema>;

/**
 * Operator defaults loaded from OpenKit server config.
 */
export const OpenKitConfigDefaultsSchema = z
  .object({
    coreModel: z.string().min(1).optional(),
    coreProviderId: z.string().min(1).optional(),
    gatewayModel: z.string().min(1).optional(),
    gatewayProviderId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
  })
  .strict();

/**
 * HTTP bind configuration for the NanoCore server.
 */
export const OpenKitServerBindSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
  })
  .strict();

/**
 * CORS configuration for the NanoCore server.
 */
export const OpenKitCorsSchema = z
  .object({
    origins: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Public server networking configuration.
 */
export const OpenKitServerRuntimeSchema = z
  .object({
    bind: OpenKitServerBindSchema.optional(),
    cors: OpenKitCorsSchema.optional(),
    publicBaseUrl: z.string().url().optional(),
    trustedProxies: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Auth sign-up policy configuration.
 */
export const OpenKitAuthSignupSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

/**
 * Server auth configuration.
 */
export const OpenKitAuthConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    localModeUserId: z.string().min(1).optional(),
    provider: z.literal('better-auth').optional(),
    signup: OpenKitAuthSignupSchema.optional(),
  })
  .strict();

/**
 * Data-root configuration.
 */
export const OpenKitDataConfigSchema = z
  .object({
    layoutVersion: z.number().int().positive().optional(),
    root: z.string().min(1).optional(),
  })
  .strict();

/**
 * Vault backend selection configuration.
 */
export const OpenKitVaultConfigSchema = z
  .object({
    localDefaultBackend: z.enum(['os-keychain', 'encrypted-file']).optional(),
  })
  .strict();

/**
 * Configured provider instance schema.
 */
export const OpenKitProviderInstanceSchema = z
  .object({
    baseUrl: z.string().url().optional(),
    defaultModel: z.string().min(1).optional(),
    displayName: z.string().min(1),
    extensions: ProviderExtensionsSchema.optional(),
    extraBody: z.record(z.string().min(1), z.unknown()).optional(),
    extraHeaders: z.record(z.string().min(1), z.unknown()).optional(),
    id: z.string().min(1),
    kind: ProviderKindSchema,
    metadata: z.record(z.string().min(1), z.unknown()).optional(),
    models: z.array(z.string().min(1)).min(1),
    secretRef: z.string().min(1).optional(),
    vendor: z.string().min(1),
  })
  .passthrough()
  .superRefine(rejectInlineSecretFields);

/**
 * OpenAI-compatible gateway configuration.
 */
export const OpenKitOpenAICompatibleGatewaySchema = z
  .object({
    allowedProviderIds: z.array(z.string().min(1)).optional(),
    auth: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    defaultProviderId: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    route: z.string().min(1).optional(),
  })
  .strict();

/**
 * Gateway configuration.
 */
export const OpenKitGatewayConfigSchema = z
  .object({
    openaiCompatible: OpenKitOpenAICompatibleGatewaySchema.optional(),
  })
  .strict();

/**
 * Internal feature flag schema.
 */
export const OpenKitFeatureFlagsSchema = z
  .object({
    internalOpenAICompatFacade: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Diagnostics configuration.
 */
export const OpenKitDiagnosticsConfigSchema = z
  .object({
    emitConfigOrigins: z.boolean().optional(),
    redactSecrets: z.boolean().optional(),
  })
  .strict();

/**
 * Internal OpenAI-compatible facade configuration schema.
 */
export const OpenAICompatFacadeConfigSchema = z
  .object({
    defaultModel: z.string().min(1).optional(),
    defaultProviderId: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/**
 * Internal NanoCore feature configuration schema.
 */
export const OpenKitInternalConfigSchema = z
  .object({
    openaiCompatFacade: OpenAICompatFacadeConfigSchema.optional(),
  })
  .strict();

/**
 * File-backed NanoCore configuration schema.
 */
export const OpenKitConfigSchema = z
  .object({
    auth: OpenKitAuthConfigSchema.optional(),
    data: OpenKitDataConfigSchema.optional(),
    defaults: OpenKitConfigDefaultsSchema.optional(),
    diagnostics: OpenKitDiagnosticsConfigSchema.optional(),
    extensions: z.record(z.string().min(1), z.unknown()).optional(),
    features: OpenKitFeatureFlagsSchema.optional(),
    gateway: OpenKitGatewayConfigSchema.optional(),
    internal: OpenKitInternalConfigSchema.optional(),
    mode: CoreModeSchema.optional(),
    providers: z.array(OpenKitProviderInstanceSchema).optional(),
    schemaVersion: z.literal(1).optional(),
    server: OpenKitServerRuntimeSchema.optional(),
    vault: OpenKitVaultConfigSchema.optional(),
  })
  .strict();

/**
 * File-backed NanoCore configuration.
 */
export type OpenKitConfig = z.infer<typeof OpenKitConfigSchema>;
