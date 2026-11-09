import { AccessTokenIdSchema, UserIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

/** Public Human name upper bound only; each entry retains its existing minimum and type policy. */
export const HumanDisplayNameInputLimitSchema = z
  .string()
  .max(256, 'Display name must contain at most 256 Unicode code points.')
  .describe('Human display name: at most 256 Unicode code points.');

/** Public Human email byte bound only; each entry retains its existing email grammar. */
export const HumanEmailInputLimitSchema = z
  .string()
  .max(254, 'Email must contain at most 254 UTF-8 bytes.')
  .refine(
    (value) => value.length <= 254 && new TextEncoder().encode(value).byteLength <= 254,
    'Email must contain at most 254 UTF-8 bytes.'
  )
  .describe('Human email: at most 254 UTF-8 bytes.');

/** New password upper bound only; verification and retained credentials remain uncapped. */
export const HumanCreationPasswordInputLimitSchema = z
  .string()
  .refine(
    (value) => value.length <= 128,
    'New password must contain at most 128 UTF-16 code units.'
  )
  .meta({ maxLength: 128, description: 'New password: at most 128 UTF-16 code units.' });

/** OpenKit access-token scope. */
export const OpenKitAccessTokenScopeSchema = z.enum([
  'server-admin',
  'workspace',
  'workspace-readonly',
]);

/** OpenKit access-token lifecycle status. */
export const OpenKitAccessTokenStatusSchema = z.enum(['active', 'expired', 'revoked', 'rotated']);

/** Redacted OpenKit access-token read model. */
export const OpenKitAccessTokenRecordSchema = z
  .object({
    tokenId: AccessTokenIdSchema,
    ownerUserId: UserIdSchema,
    scope: OpenKitAccessTokenScopeSchema,
    workspaceIds: z.array(WorkspaceIdSchema),
    status: OpenKitAccessTokenStatusSchema,
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
    predecessorTokenId: AccessTokenIdSchema.nullable(),
    rotatedGraceExpiresAt: z.string().datetime().nullable(),
    lastUsedAt: z.string().datetime().nullable(),
    lastUsedChannel: z.string().min(1).nullable(),
    lastUsedSource: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** OpenKit access-token issue request. */
export const CreateOpenKitAccessTokenRequestSchema = z
  .object({
    scope: OpenKitAccessTokenScopeSchema,
    workspaceIds: z
      .array(WorkspaceIdSchema)
      .max(1000, 'Workspace bindings must contain at most 1,000 entries before normalization.')
      .default([]),
    expiresAt: z
      .string()
      .datetime()
      .max(64, 'Token expiration must contain at most 64 ISO-text characters.'),
    ownerUserId: UserIdSchema.optional(),
  })
  .strict();

/** OpenKit access-token issue response with the one-time plaintext token. */
export const CreateOpenKitAccessTokenResponseSchema = z
  .object({
    token: z.string().regex(/^okt_[A-Za-z0-9_-]+$/),
    record: OpenKitAccessTokenRecordSchema,
  })
  .strict();

/** OpenKit access-token list response. */
export const ListOpenKitAccessTokensResponseSchema = z
  .object({
    items: z.array(OpenKitAccessTokenRecordSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** OpenKit access-token revocation response. */
export const RevokeOpenKitAccessTokenResponseSchema = z
  .object({
    record: OpenKitAccessTokenRecordSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** OpenKit access-token rotation request. */
export const RotateOpenKitAccessTokenRequestSchema = z
  .object({
    graceSeconds: z.number().int().min(0).default(86_400),
  })
  .strict();

/** OpenKit access-token rotation response with the one-time plaintext token. */
export const RotateOpenKitAccessTokenResponseSchema = z
  .object({
    token: z.string().regex(/^okt_[A-Za-z0-9_-]+$/),
    record: OpenKitAccessTokenRecordSchema,
    rotatedRecord: OpenKitAccessTokenRecordSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value.record, ctx, ['record']);
    addRawSecretIssues(value.rotatedRecord, ctx, ['rotatedRecord']);
  });

/** Signed-in user's redacted server-admin tokens plus the effective default. */
export const ListMyAdminAccessTokensResponseSchema = z
  .object({
    items: z.array(OpenKitAccessTokenRecordSchema),
    defaultTokenId: AccessTokenIdSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Request to select one owned usable server-admin token as the effective default. */
export const SetMyAdminAccessTokenDefaultRequestSchema = z
  .object({
    tokenId: AccessTokenIdSchema,
  })
  .strict();

/** Response after selecting the signed-in user's effective default server-admin token. */
export const SetMyAdminAccessTokenDefaultResponseSchema = ListMyAdminAccessTokensResponseSchema;

/** OpenKit server bootstrap token consumption request. */
export const ConsumeOpenKitBootstrapTokenRequestSchema = z
  .object({
    token: z
      .string()
      .regex(/^okt_[A-Za-z0-9_-]+$/)
      .max(256),
    ownerUserId: UserIdSchema,
    displayName: HumanDisplayNameInputLimitSchema.min(1),
    email: HumanEmailInputLimitSchema.email(),
    password: HumanCreationPasswordInputLimitSchema.min(8),
    tokenExpiresAt: z.string().datetime().max(64),
  })
  .strict();

/** OpenKit server bootstrap token consumption response. */
export const ConsumeOpenKitBootstrapTokenResponseSchema = CreateOpenKitAccessTokenResponseSchema;

/** Email/password auth request body. */
export const AuthEmailRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/** Email/password sign-up request body. */
export const AuthSignUpEmailRequestSchema = AuthEmailRequestSchema.extend({
  email: HumanEmailInputLimitSchema.email(),
  name: HumanDisplayNameInputLimitSchema.min(1),
  password: HumanCreationPasswordInputLimitSchema.min(1),
});

/** Better Auth user payload returned to the browser. */
export const AuthUserSchema = z
  .object({
    id: UserIdSchema,
    email: z.string().email(),
    name: z.string().min(1),
    image: z.string().nullable().optional(),
    emailVerified: z.boolean(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough();

/** Browser auth response for email sign-up. */
export const AuthSignUpEmailResponseSchema = z
  .object({
    token: z.string().min(1).nullable(),
    user: AuthUserSchema,
  })
  .strict();

/** Browser auth response for email sign-in. */
export const AuthSignInEmailResponseSchema = z
  .object({
    redirect: z.boolean(),
    token: z.string().min(1),
    url: z.string().min(1).nullable().optional(),
    user: AuthUserSchema,
  })
  .strict();

/** Browser auth response for sign-out. */
export const AuthSignOutResponseSchema = z
  .object({
    success: z.literal(true),
  })
  .strict();

/**
 * Signed-in Better Auth session read.
 *
 * The route returns this object for an active session and JSON null when no session is present. Extra session fields stay ignored.
 */
export const AuthGetSessionResponseSchema = z
  .object({
    user: AuthUserSchema,
  })
  .passthrough();

/** Active session body, or null when the browser has no session. */
export const AuthGetSessionResultSchema = z.union([AuthGetSessionResponseSchema, z.null()]);

/** Email/password auth request body. */
export type AuthEmailRequest = z.infer<typeof AuthEmailRequestSchema>;
/** Email/password sign-up request body. */
export type AuthSignUpEmailRequest = z.infer<typeof AuthSignUpEmailRequestSchema>;
/** OpenKit access-token scope. */
export type OpenKitAccessTokenScope = z.infer<typeof OpenKitAccessTokenScopeSchema>;
/** OpenKit access-token lifecycle status. */
export type OpenKitAccessTokenStatus = z.infer<typeof OpenKitAccessTokenStatusSchema>;
/** Redacted OpenKit access-token read model. */
export type OpenKitAccessTokenRecord = z.infer<typeof OpenKitAccessTokenRecordSchema>;
/** OpenKit access-token issue request. */
export type CreateOpenKitAccessTokenRequest = z.infer<typeof CreateOpenKitAccessTokenRequestSchema>;
/** OpenKit access-token issue response. */
export type CreateOpenKitAccessTokenResponse = z.infer<
  typeof CreateOpenKitAccessTokenResponseSchema
>;
/** OpenKit access-token list response. */
export type ListOpenKitAccessTokensResponse = z.infer<typeof ListOpenKitAccessTokensResponseSchema>;
/** OpenKit access-token revocation response. */
export type RevokeOpenKitAccessTokenResponse = z.infer<
  typeof RevokeOpenKitAccessTokenResponseSchema
>;
/** OpenKit access-token rotation request. */
export type RotateOpenKitAccessTokenRequest = z.infer<typeof RotateOpenKitAccessTokenRequestSchema>;
/** OpenKit access-token rotation response. */
export type RotateOpenKitAccessTokenResponse = z.infer<
  typeof RotateOpenKitAccessTokenResponseSchema
>;
/** Signed-in user's redacted server-admin token list. */
export type ListMyAdminAccessTokensResponse = z.infer<typeof ListMyAdminAccessTokensResponseSchema>;
/** Request to select the signed-in user's default server-admin token. */
export type SetMyAdminAccessTokenDefaultRequest = z.infer<
  typeof SetMyAdminAccessTokenDefaultRequestSchema
>;
/** Response after selecting the signed-in user's default server-admin token. */
export type SetMyAdminAccessTokenDefaultResponse = z.infer<
  typeof SetMyAdminAccessTokenDefaultResponseSchema
>;
/** OpenKit server bootstrap token consumption request. */
export type ConsumeOpenKitBootstrapTokenRequest = z.infer<
  typeof ConsumeOpenKitBootstrapTokenRequestSchema
>;
/** OpenKit server bootstrap token consumption response. */
export type ConsumeOpenKitBootstrapTokenResponse = z.infer<
  typeof ConsumeOpenKitBootstrapTokenResponseSchema
>;
/** Browser auth response for email sign-up. */
export type AuthSignUpEmailResponse = z.infer<typeof AuthSignUpEmailResponseSchema>;
/** Browser auth response for email sign-in. */
export type AuthSignInEmailResponse = z.infer<typeof AuthSignInEmailResponseSchema>;
/** Browser auth response for sign-out. */
export type AuthSignOutResponse = z.infer<typeof AuthSignOutResponseSchema>;
/** Signed-in Better Auth session read. */
export type AuthGetSessionResponse = z.infer<typeof AuthGetSessionResponseSchema>;
