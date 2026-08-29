import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

/** Vault admin backend kinds exposed through the App API. */
export const VaultAdminBackendKindSchema = z.enum(['encrypted-file']);

/** Vault admin backend health states exposed through the App API. */
export const VaultAdminHealthStateSchema = z.enum(['available', 'locked', 'unavailable']);

/** Redacted vault admin status response payload. */
export const VaultAdminStatusResponseSchema = z
  .object({
    backendKind: VaultAdminBackendKindSchema,
    state: VaultAdminHealthStateSchema,
    diagnostic: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Vault admin unlock request payload. */
export const VaultAdminUnlockRequestSchema = z
  .object({
    masterKeyBase64: z.string().min(1),
  })
  .strict();

/** Vault admin Codex auth JSON bootstrap request payload. */
export const VaultAdminBootstrapCodexAuthJsonRequestSchema = z
  .object({
    authJsonBase64: z.string().min(1),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

/** Vault admin Codex auth JSON bootstrap response payload. */
export const VaultAdminBootstrapCodexAuthJsonResponseSchema = z
  .object({
    backendKind: VaultAdminBackendKindSchema,
    grantId: z.literal('grant_codex_auth_json'),
    grantScope: z.literal('agent-session'),
    referenceId: z.literal('vault_codex_auth_json'),
    secretKind: z.literal('codex-auth-json'),
    targetPath: z.literal('/sandbox/.codex/auth.json'),
    expiresAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Deployment-admin provider API-key input. */
export const SetProviderApiKeyRequestSchema = z
  .object({
    apiKey: z.string().min(1).max(65_536),
  })
  .strict();

/** Provider profile id that is safe for file, Vault-reference, and redacted response use. */
export const ProviderApiKeyProfileIdSchema = z
  .string()
  .min(1)
  .max(119)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Redacted provider API-key configuration result. */
export const SetProviderApiKeyResponseSchema = z
  .object({
    configured: z.literal(true),
    providerId: ProviderApiKeyProfileIdSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Vault admin workspace reference rebind request payload. */
export const VaultAdminRebindWorkspaceReferenceRequestSchema = z
  .object({
    materialBase64: z.string().min(1),
  })
  .strict();

/** Vault admin workspace reference rebind response payload. */
export const VaultAdminRebindWorkspaceReferenceResponseSchema = z
  .object({
    backendKind: VaultAdminBackendKindSchema,
    currentVersion: z.number().int().positive(),
    ownerScope: z.literal('workspace'),
    referenceId: z.string().min(1),
    secretKind: z.string().min(1),
    status: z.literal('active'),
    workspaceId: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Redacted workspace vault reference payload. */
export const VaultAdminWorkspaceReferenceSchema = z
  .object({
    backendKind: VaultAdminBackendKindSchema,
    currentVersion: z.number().int().nonnegative(),
    ownerScope: z.literal('workspace'),
    referenceId: z.string().min(1),
    secretKind: z.string().min(1),
    status: z.enum(['active', 'revoked', 'unbound']),
    workspaceId: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Redacted workspace vault reference list response payload. */
export const VaultAdminListWorkspaceReferencesResponseSchema = z
  .object({
    items: z.array(VaultAdminWorkspaceReferenceSchema),
    workspaceId: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Vault admin lock response payload. */
export const VaultAdminLockResponseSchema = VaultAdminStatusResponseSchema;

/** Vault admin unlock response payload. */
export const VaultAdminUnlockResponseSchema = VaultAdminStatusResponseSchema;

/** Vault admin backend kind. */
export type VaultAdminBackendKind = z.infer<typeof VaultAdminBackendKindSchema>;
/** Vault admin health state. */
export type VaultAdminHealthState = z.infer<typeof VaultAdminHealthStateSchema>;
/** Redacted vault admin status response. */
export type VaultAdminStatusResponse = z.infer<typeof VaultAdminStatusResponseSchema>;
/** Vault admin unlock request. */
export type VaultAdminUnlockRequest = z.infer<typeof VaultAdminUnlockRequestSchema>;
/** Vault admin Codex auth JSON bootstrap request. */
export type VaultAdminBootstrapCodexAuthJsonRequest = z.infer<
  typeof VaultAdminBootstrapCodexAuthJsonRequestSchema
>;
/** Vault admin Codex auth JSON bootstrap response. */
export type VaultAdminBootstrapCodexAuthJsonResponse = z.infer<
  typeof VaultAdminBootstrapCodexAuthJsonResponseSchema
>;
/** Deployment-admin provider API-key input. */
export type SetProviderApiKeyRequest = z.infer<typeof SetProviderApiKeyRequestSchema>;
/** Redacted provider API-key configuration result. */
export type SetProviderApiKeyResponse = z.infer<typeof SetProviderApiKeyResponseSchema>;
/** Vault admin workspace reference rebind request. */
export type VaultAdminRebindWorkspaceReferenceRequest = z.infer<
  typeof VaultAdminRebindWorkspaceReferenceRequestSchema
>;
/** Vault admin workspace reference rebind response. */
export type VaultAdminRebindWorkspaceReferenceResponse = z.infer<
  typeof VaultAdminRebindWorkspaceReferenceResponseSchema
>;
/** Redacted workspace vault reference. */
export type VaultAdminWorkspaceReference = z.infer<typeof VaultAdminWorkspaceReferenceSchema>;
/** Redacted workspace vault reference list response. */
export type VaultAdminListWorkspaceReferencesResponse = z.infer<
  typeof VaultAdminListWorkspaceReferencesResponseSchema
>;
/** Vault admin lock response. */
export type VaultAdminLockResponse = z.infer<typeof VaultAdminLockResponseSchema>;
/** Vault admin unlock response. */
export type VaultAdminUnlockResponse = z.infer<typeof VaultAdminUnlockResponseSchema>;
