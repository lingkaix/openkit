import { z } from 'zod';

/** Exact configured SDK records; these private values never enter the agent operation surface. */
const user = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  kind: z.enum(['local', 'human']),
  lastSeenAt: z.string().nullable(),
  status: z.enum(['active', 'disabled']),
  disabledAt: z.string().nullable(),
  personalWorkspaceId: z.string().nullable(),
});
const session = z.object({
  id: z.string(),
  userId: z.string(),
  token: z.string(),
  expiresAt: z.date(),
  createdAt: z.date(),
  updatedAt: z.date(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
});
const account = z.object({
  id: z.string(),
  accountId: z.string(),
  providerId: z.string(),
  userId: z.string(),
  password: z.string().nullable(),
  accessToken: z.string().nullable(),
  refreshToken: z.string().nullable(),
  idToken: z.string().nullable(),
  accessTokenExpiresAt: z.date().nullable(),
  refreshTokenExpiresAt: z.date().nullable(),
  scope: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
const userCreate = user.omit({ personalWorkspaceId: true }).extend({
  image: z.string().nullable().optional(),
  lastSeenAt: z.string().nullable().optional(),
  disabledAt: z.string().nullable().optional(),
});
const accountCreate = account
  .pick({
    id: true,
    accountId: true,
    userId: true,
    password: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({ providerId: z.literal('credential') });
const sessionCreate = session.extend({
  ipAddress: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
});
// The mounted SDK permits numbers here; SQLite TEXT affinity, rather than JS String(), owns conversion.
const profileValue = z.union([z.string(), z.number()]);
const actor = z.object({ userId: z.string(), sessionToken: z.string() }).strict();
export type ControlBetterAuthActor = z.infer<typeof actor>;

/** One existing SQL commit per member, never a model/table/predicate/patch or callback protocol. */
export const ControlBetterAuthInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('human-create'),
      record: userCreate.strict(),
      requireBootstrap: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('credential-account-create'),
      record: accountCreate.strict(),
      actor: actor.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('session-create'), record: sessionCreate.strict() }).strict(),
  z
    .object({
      kind: z.literal('session-refresh'),
      requireUnexpired: z.literal(true).optional(),
      token: z.string(),
      expiresAt: z.date(),
      updatedAt: z.date(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('session-delete'),
      requireExpired: z.literal(true).optional(),
      token: z.string(),
      actor: actor.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('user-sessions-delete'),
      userId: z.string(),
      actor: actor.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('profile-update'),
      actor: actor.optional(),
      userId: z.string(),
      displayName: profileValue.optional(),
      image: profileValue.nullable().optional(),
      updatedAt: z.date(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('account-password-update'),
      actor: actor.optional(),
      accountId: z.string(),
      password: z.string(),
      updatedAt: z.date(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('user-passwords-update'),
      userId: z.string(),
      password: z.string(),
      updatedAt: z.date(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('account-unlink'),
      accountId: z.string(),
      userId: z.string(),
      sessionToken: z.string(),
      freshAgeSeconds: z.number().nonnegative(),
      allowUnlinkingAll: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('expired-verifications-delete'), before: z.date() }).strict(),
  z.object({ kind: z.literal('verification-delete'), identifier: z.string() }).strict(),
  z
    .object({ kind: z.literal('user-mark-verified'), email: z.string(), updatedAt: z.date() })
    .strict(),
  z
    .object({
      kind: z.literal('user-address-replace'),
      email: z.string(),
      nextEmail: z.string(),
      emailVerified: z.boolean(),
      updatedAt: z.date(),
    })
    .strict(),
]);
export type ControlBetterAuthInput = z.infer<typeof ControlBetterAuthInputSchema>;

/** Private, finite SDK return shapes; no rowset or cursor can escape this family. */
export const ControlBetterAuthResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), record: user.nullable() }).strict(),
  z.object({ kind: z.literal('session'), record: session.nullable() }).strict(),
  z.object({ kind: z.literal('account'), record: account.nullable() }).strict(),
  z
    .object({
      kind: z.literal('mutation'),
      changes: z.number().int().nonnegative(),
      lastInsertRowid: z.union([z.number(), z.bigint()]),
    })
    .strict(),
]);
export type ControlBetterAuthResult = z.infer<typeof ControlBetterAuthResultSchema>;

/** Closed, material-free SDK refusals that can cross the native boundary. */
export const BETTER_AUTH_REFUSALS = {
  bootstrap_incomplete: { message: 'Server bootstrap is incomplete.', status: 403 },
  user_disabled: { message: 'User is disabled.', status: 403 },
  session_invalid: { message: 'Unauthorized', status: 401, apiCode: 'UNAUTHORIZED' },
  session_not_fresh: { message: 'Session is not fresh', status: 403, apiCode: 'SESSION_NOT_FRESH' },
  last_account: {
    message: "You can't unlink your last account",
    status: 400,
    apiCode: 'FAILED_TO_UNLINK_LAST_ACCOUNT',
  },
  credential_account_not_found: {
    message: 'Credential account not found',
    status: 400,
    apiCode: 'CREDENTIAL_ACCOUNT_NOT_FOUND',
  },
  password_already_set: {
    message: 'User already has a password set',
    status: 400,
    apiCode: 'PASSWORD_ALREADY_SET',
  },
  account_not_found: { message: 'Account not found', status: 400, apiCode: 'ACCOUNT_NOT_FOUND' },
} as const;
export type BetterAuthRefusalCode = keyof typeof BETTER_AUTH_REFUSALS;

/** A declared native refusal, with no arbitrary SQLite or bound-value diagnostics. */
export class BetterAuthNativeError extends Error {
  constructor(public readonly code: BetterAuthRefusalCode) {
    super(BETTER_AUTH_REFUSALS[code].message);
    this.name = 'BetterAuthNativeError';
  }
}

/** Matches only the declared public refusal without propagating native diagnostics. */
export function isBetterAuthRefusal(
  code: unknown,
  message: unknown,
  status: unknown
): code is BetterAuthRefusalCode {
  if (typeof code !== 'string' || !Object.hasOwn(BETTER_AUTH_REFUSALS, code)) return false;
  const refusal = BETTER_AUTH_REFUSALS[code as BetterAuthRefusalCode];
  return message === refusal.message && status === refusal.status;
}
