import {
  ProviderSubscriptionAccountSlotIdSchema,
  SubscriptionProviderIdSchema,
} from '@openkit/config-schema/provider-subscription';
import { z } from 'zod';

export { SubscriptionProviderIdSchema };

const TimestampSchema = z.string().datetime();
const DisplayNameSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !/[\uD800-\uDFFF]/u.test(value) && new TextEncoder().encode(value).byteLength <= 256,
    'Display name must be valid Unicode with at most 256 UTF-8 bytes.'
  );
const SortedProviderIdsSchema = z
  .array(z.string().min(1))
  .refine(
    (providerIds) =>
      providerIds.every((providerId, index) => index === 0 || providerIds[index - 1]! < providerId),
    'Bound provider ids must be duplicate-free and lexicographically ordered.'
  );
const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) {
      return false;
    }
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }, 'Expected an absolute HTTP or HTTPS URL.');

const OpenAICodexSubscriptionDescriptorSchema = z
  .object({
    subscriptionProviderId: z.literal('openai-codex'),
    displayName: z.literal('OpenAI Codex'),
    loginModes: z.tuple([z.literal('device_code')]),
    quotaCapability: z.literal('available'),
  })
  .strict();
const XaiSubscriptionDescriptorSchema = z
  .object({
    subscriptionProviderId: z.literal('xai'),
    displayName: z.literal('xAI'),
    loginModes: z.tuple([z.literal('device_code')]),
    quotaCapability: z.literal('available'),
  })
  .strict();

const AccountBaseShape = {
  subscriptionProviderId: SubscriptionProviderIdSchema,
  accountSlotId: ProviderSubscriptionAccountSlotIdSchema,
  boundProviderIds: SortedProviderIdsSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  displayName: DisplayNameSchema.optional(),
  accountLabel: z.string().min(1).optional(),
  planLabel: z.string().min(1).optional(),
};
const LoginInteractionSchema = z
  .object({
    mode: z.literal('device_code'),
    interactionId: z.string().min(1),
    verificationUrl: HttpUrlSchema,
    userCode: z.string().min(1),
    expiresAt: TimestampSchema.optional(),
  })
  .strict();

/** Strict request body for creating one provider-subscription account slot. */
export const CreateProviderSubscriptionAccountRequestSchema = z
  .object({
    accountSlotId: ProviderSubscriptionAccountSlotIdSchema,
    displayName: DisplayNameSchema.optional(),
  })
  .strict();

/** Strict request body for updating one provider-subscription account slot. */
export const UpdateProviderSubscriptionAccountRequestSchema = z
  .object({
    displayName: DisplayNameSchema,
  })
  .strict();

/** Strict device-code request body for starting provider-subscription login. */
export const StartProviderSubscriptionAccountLoginRequestSchema = z
  .object({
    mode: z.literal('device_code'),
  })
  .strict();

/** Strict request body for cancelling one provider-subscription login interaction. */
export const CancelProviderSubscriptionAccountLoginRequestSchema = z
  .object({
    interactionId: z.string().min(1),
  })
  .strict();

/** Fixed supported provider-subscription inventory response. */
export const ProviderSubscriptionsResponseSchema = z
  .object({
    providers: z.tuple([OpenAICodexSubscriptionDescriptorSchema, XaiSubscriptionDescriptorSchema]),
  })
  .strict();

/** Sanitized provider-subscription account and status projection. */
export const ProviderSubscriptionAccountSchema = z.discriminatedUnion('status', [
  z.object({ ...AccountBaseShape, status: z.literal('logged_out') }).strict(),
  z.object({ ...AccountBaseShape, status: z.literal('logged_in') }).strict(),
  z
    .object({
      ...AccountBaseShape,
      status: z.literal('pending'),
      interaction: LoginInteractionSchema,
    })
    .strict(),
  z
    .object({
      ...AccountBaseShape,
      status: z.literal('unavailable'),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...AccountBaseShape,
      status: z.literal('error'),
      message: z.string().min(1),
    })
    .strict(),
]);

/** Lexicographically ordered provider-subscription account list response. */
export const ProviderSubscriptionAccountsResponseSchema = z
  .object({
    accounts: z
      .array(ProviderSubscriptionAccountSchema)
      .refine(
        (accounts) =>
          accounts.every(
            (account, index) =>
              index === 0 || accounts[index - 1]!.accountSlotId < account.accountSlotId
          ),
        'Provider subscription accounts must be lexicographically ordered.'
      ),
  })
  .strict();

const UsdCentsSchema = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const SubscriptionAccountObservationShape = {
  planType: z.string().min(1).optional(),
  subscriptionActive: z.boolean().optional(),
  accountObservedAt: TimestampSchema.optional(),
};
const QuotaWindowSchema = z
  .object({
    id: z.string().min(1),
    usedPercent: z.number().finite().min(0).max(100).optional(),
    remainingPercent: z.number().finite().min(0).max(100).optional(),
    periodType: z.enum(['weekly', 'monthly']).optional(),
    startsAt: TimestampSchema.optional(),
    resetsAt: TimestampSchema.optional(),
  })
  .strict();
const QuotaBillingSchema = z
  .object({
    currency: z.literal('USD'),
    prepaidBalanceCents: UsdCentsSchema.optional(),
    onDemandUsedCents: UsdCentsSchema.optional(),
    onDemandCapCents: UsdCentsSchema.optional(),
    sharedAllowance: z.boolean().optional(),
  })
  .strict();

/** Strict bounded quota projection for supported provider subscriptions. */
export const ProviderSubscriptionQuotaSchema = z.discriminatedUnion('availability', [
  z
    .object({
      subscriptionProviderId: SubscriptionProviderIdSchema,
      accountSlotId: ProviderSubscriptionAccountSlotIdSchema,
      availability: z.literal('available'),
      observedAt: TimestampSchema,
      ...SubscriptionAccountObservationShape,
      windows: z.array(QuotaWindowSchema),
      billing: QuotaBillingSchema.optional(),
    })
    .strict(),
  z
    .object({
      subscriptionProviderId: SubscriptionProviderIdSchema,
      accountSlotId: ProviderSubscriptionAccountSlotIdSchema,
      availability: z.literal('temporarily_unavailable'),
      observedAt: TimestampSchema,
      ...SubscriptionAccountObservationShape,
      retryAfter: TimestampSchema.optional(),
    })
    .strict(),
]);

/** Strict xAI-only auto-top-up observation. */
export const ProviderSubscriptionAutoTopupSchema = z.discriminatedUnion('availability', [
  z
    .object({
      subscriptionProviderId: z.literal('xai'),
      accountSlotId: ProviderSubscriptionAccountSlotIdSchema,
      observedAt: TimestampSchema,
      availability: z.literal('available'),
      currency: z.literal('USD'),
      enabled: z.boolean().optional(),
      thresholdCents: UsdCentsSchema.optional(),
      amountCents: UsdCentsSchema.optional(),
      monthlyCapCents: UsdCentsSchema.optional(),
    })
    .strict(),
  z
    .object({
      subscriptionProviderId: z.literal('xai'),
      accountSlotId: ProviderSubscriptionAccountSlotIdSchema,
      observedAt: TimestampSchema,
      availability: z.literal('temporarily_unavailable'),
    })
    .strict(),
]);

/** Request body for creating one provider-subscription account slot. */
export type CreateProviderSubscriptionAccountRequest = z.infer<
  typeof CreateProviderSubscriptionAccountRequestSchema
>;
/** Request body for updating one provider-subscription account slot. */
export type UpdateProviderSubscriptionAccountRequest = z.infer<
  typeof UpdateProviderSubscriptionAccountRequestSchema
>;
/** Request body for starting one provider-subscription login interaction. */
export type StartProviderSubscriptionAccountLoginRequest = z.infer<
  typeof StartProviderSubscriptionAccountLoginRequestSchema
>;
/** Request body for cancelling one provider-subscription login interaction. */
export type CancelProviderSubscriptionAccountLoginRequest = z.infer<
  typeof CancelProviderSubscriptionAccountLoginRequestSchema
>;
/** Fixed supported provider-subscription inventory response. */
export type ProviderSubscriptionsResponse = z.infer<typeof ProviderSubscriptionsResponseSchema>;
/** Sanitized provider-subscription account projection. */
export type ProviderSubscriptionAccount = z.infer<typeof ProviderSubscriptionAccountSchema>;
/** Provider-subscription account list response. */
export type ProviderSubscriptionAccountsResponse = z.infer<
  typeof ProviderSubscriptionAccountsResponseSchema
>;
/** Bounded provider-subscription quota projection. */
export type ProviderSubscriptionQuota = z.infer<typeof ProviderSubscriptionQuotaSchema>;
/** Bounded xAI auto-top-up observation. */
export type ProviderSubscriptionAutoTopup = z.infer<typeof ProviderSubscriptionAutoTopupSchema>;
