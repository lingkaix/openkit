import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { ProviderProfileSchema } from './provider.js';

/** Exact HTTP or HTTPS origin accepted by browser-facing server configuration. */
const HttpOriginSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  }, 'Expected an exact HTTP or HTTPS origin.');

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
    origins: z.array(HttpOriginSchema).optional(),
  })
  .strict();

/**
 * Public server networking configuration.
 */
export const OpenKitServerRuntimeSchema = z
  .object({
    bind: OpenKitServerBindSchema.optional(),
    cors: OpenKitCorsSchema.optional(),
    publicBaseUrl: HttpOriginSchema.optional(),
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
    signup: OpenKitAuthSignupSchema.optional(),
  })
  .strict();

/**
 * Vault backend selection configuration.
 */
export const OpenKitVaultConfigSchema = z
  .object({
    encryptedFile: z
      .object({
        keyFilePath: z.string().min(1).refine(isAbsolute, 'Vault key file path must be absolute.'),
      })
      .strict()
      .optional(),
    localDefaultBackend: z.enum(['os-keychain', 'encrypted-file']).optional(),
  })
  .strict();

/**
 * Configured provider instance schema derived from the canonical provider profile.
 *
 * Server-embedded providers require an explicit vendor and cannot declare profile-derived category or readiness state.
 */
export const OpenKitProviderInstanceSchema = ProviderProfileSchema.omit({
  category: true,
  readiness: true,
})
  .extend({
    vendor: ProviderProfileSchema.shape.vendor.unwrap(),
  })
  .strict();

/**
 * OpenAI-compatible gateway configuration.
 */
export const OpenKitOpenAICompatibleGatewaySchema = z
  .object({
    allowedProviderIds: z.array(z.string().min(1)).optional(),
    enabled: z.boolean().optional(),
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
 * File-backed NanoCore configuration schema.
 */
export const OpenKitConfigSchema = z
  .object({
    auth: OpenKitAuthConfigSchema.optional(),
    defaults: OpenKitConfigDefaultsSchema.optional(),
    gateway: OpenKitGatewayConfigSchema.optional(),
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
