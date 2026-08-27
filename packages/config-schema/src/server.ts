import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { OpenKitProviderInstanceSchema } from './provider.js';

export { OpenKitProviderInstanceSchema } from './provider.js';

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

/** Fixed file-backed credential paths for one configured NanoHost slot. */
export const OpenKitNanoHostCredentialSlotSchema = z
  .object({
    companionPath: z.string().min(1).refine(isAbsolute, 'Companion path must be absolute.'),
    secretPath: z.string().min(1).refine(isAbsolute, 'Secret path must be absolute.'),
  })
  .strict()
  .refine(
    (value) => value.companionPath !== value.secretPath,
    'NanoHost credential secret and companion paths must be distinct.'
  );

/** Dedicated native HTTP/2 listener bind for one configured NanoHost. */
export const OpenKitNanoHostBindSchema = z
  .object({
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65_535),
  })
  .strict();

const RawSecretPattern =
  /(^|[^A-Za-z0-9_])(sk-[A-Za-z0-9_-]+|hf_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|okt_[A-Za-z0-9_-]+)/;

/**
 * Rejects raw-secret-shaped strings in NanoHost deployment configuration.
 *
 * @param value Candidate value.
 * @param ctx Zod refinement context.
 * @param path Path to the value.
 */
function addRawSecretIssues(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number>
): void {
  if (typeof value === 'string') {
    if (RawSecretPattern.test(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'NanoHost deployment configuration must not contain raw-secret-shaped strings.',
        path,
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      addRawSecretIssues(item, ctx, [...path, index]);
    }
    return;
  }

  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      addRawSecretIssues(item, ctx, [...path, key]);
    }
  }
}

/**
 * Secret-free NanoHost deployment projection loaded from server config.
 *
 * Carries exactly one configured NanoHost identity, NanoCore rendezvous endpoint,
 * and non-secret credential reference. Raw `okt_` material, Cell topology keys,
 * and unknown fields are rejected.
 */
export const OpenKitNanoHostConfigSchema = z
  .object({
    bind: OpenKitNanoHostBindSchema,
    credentialRef: z.string().min(1),
    credentialSlots: z
      .object({
        A: OpenKitNanoHostCredentialSlotSchema,
        B: OpenKitNanoHostCredentialSlotSchema,
      })
      .strict(),
    deploymentId: z.string().min(1),
    identityId: z.string().min(1),
    rendezvousUrl: HttpOriginSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
    const paths = [
      value.credentialSlots.A.secretPath,
      value.credentialSlots.A.companionPath,
      value.credentialSlots.B.secretPath,
      value.credentialSlots.B.companionPath,
    ];
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'NanoHost credential slot paths must be distinct.',
        path: ['credentialSlots'],
      });
    }
  });

/**
 * File-backed NanoCore configuration schema.
 */
export const OpenKitConfigSchema = z
  .object({
    auth: OpenKitAuthConfigSchema.optional(),
    defaults: OpenKitConfigDefaultsSchema.optional(),
    gateway: OpenKitGatewayConfigSchema.optional(),
    mode: CoreModeSchema.optional(),
    nanohost: OpenKitNanoHostConfigSchema.optional(),
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

/**
 * Secret-free NanoHost deployment projection.
 */
export type OpenKitNanoHostConfig = z.infer<typeof OpenKitNanoHostConfigSchema>;
