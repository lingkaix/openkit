import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS } from './provider-subscription-operations.js';
import {
  ProviderSubscriptionAccountSchema,
  ProviderSubscriptionQuotaSchema,
  UpdateProviderSubscriptionAccountRequestSchema,
} from './provider-subscriptions.js';

const observedAt = '2026-10-02T00:00:00.000Z';
const account = {
  subscriptionProviderId: 'xai',
  accountSlotId: 'default',
  boundProviderIds: [],
  createdAt: observedAt,
  updatedAt: observedAt,
  status: 'logged_in',
};

describe('Codex subscription management operations', () => {
  it('declares manual reset and separate Codex settings mutations', () => {
    expect(Object.keys(PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS)).toEqual(
      expect.arrayContaining([
        'provider-subscription.account-use-reset',
        'provider-subscription.codex-settings',
      ])
    );
  });
});

/** Looks up a public definition without importing a new, not-yet-existing symbol. */
function managementDefinition(id: string) {
  const definitions: Record<
    string,
    { inputSchema: z.ZodType; outputSchema: z.ZodType; mutating: boolean }
  > = PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS;
  const definition = definitions[id];
  expect(definition, `Missing operation: ${id}`).toBeDefined();
  return definition!;
}

describe('Codex subscription management contracts', () => {
  const pair = { subscriptionProviderId: 'openai-codex', accountSlotId: 'default' };
  const redeemRequestId = 'd98c622b-90e0-4f0e-b526-c03fdc8e5312';

  it('admits a UUIDv4 reset identity but no caller-selected credit or invalid identity', () => {
    const definition = managementDefinition('provider-subscription.account-use-reset');
    const input = { ...pair, redeemRequestId };
    expect(definition.mutating).toBe(true);
    expect(definition.inputSchema.parse(input)).toEqual(input);
    expect(
      definition.inputSchema.safeParse({ ...input, redeemRequestId: 'not-a-uuid' }).success
    ).toBe(false);
    expect(
      definition.inputSchema.safeParse({ ...input, redeemRequestId: observedAt }).success
    ).toBe(false);
    expect(definition.inputSchema.safeParse({ ...input, creditId: 'caller-credit' }).success).toBe(
      false
    );
    expect(
      definition.inputSchema.safeParse({
        ...input,
        redeemRequestId: 'd98c622b-90e0-1f0e-b526-c03fdc8e5312',
      }).success
    ).toBe(false);
  });

  it('admits partial boolean settings through their separate operation, not label update', () => {
    const definition = managementDefinition('provider-subscription.codex-settings');
    const input = { ...pair, settings: { codexAutoUseWeeklyReset: true, codexUseCredits: false } };
    expect(definition.mutating).toBe(true);
    expect(definition.inputSchema.parse(input)).toEqual(input);
    expect(
      definition.inputSchema.safeParse({ ...pair, settings: { codexUseCredits: 'false' } }).success
    ).toBe(false);
    expect(
      definition.inputSchema.safeParse({ ...input, settings: { billingEnabled: true } }).success
    ).toBe(false);
    expect(
      UpdateProviderSubscriptionAccountRequestSchema.safeParse({
        displayName: 'Codex',
        codexUseCredits: false,
      }).success
    ).toBe(false);
  });

  it('projects optional top-level Codex booleans and rejects them for xAI', () => {
    const codex = {
      ...account,
      ...pair,
      codexAutoUseWeeklyReset: true,
      codexAutoUseExpiringReset: true,
      codexUseCredits: false,
    };
    expect(ProviderSubscriptionAccountSchema.parse(codex)).toEqual(codex);
    expect(
      ProviderSubscriptionAccountSchema.safeParse({ ...account, codexUseCredits: false }).success
    ).toBe(false);
  });

  it('keeps rich quota exact and redacted through the public schema', () => {
    const quota = {
      ...pair,
      availability: 'available',
      observedAt,
      windows: [{ id: 'primary', limitWindowSeconds: 604800, usedPercent: 100 }],
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: '9007199254740993.000000000000000001',
      },
      resetCredits: {
        availableCount: 1,
        available: [{ id: 'reset-credit', resetType: 'weekly', expiresAt: null }],
      },
      activeUntil: '2026-11-01T00:00:00.000Z',
    };
    expect(ProviderSubscriptionQuotaSchema.parse(quota)).toEqual(quota);
    expect(
      ProviderSubscriptionQuotaSchema.safeParse({ ...quota, accessToken: 'private' }).success
    ).toBe(false);
  });

  it('keeps an unknown reset result distinct from confirmed vendor codes', () => {
    const definition = managementDefinition('provider-subscription.account-use-reset');
    const result = { ...pair, redeemRequestId, outcome: 'unknown', creditId: 'saved-credit' };
    expect(definition.outputSchema.parse(result)).toEqual(result);
    expect(definition.outputSchema.safeParse({ ...result, outcome: 'failed' }).success).toBe(false);
    expect(definition.outputSchema.safeParse({ ...result, upstreamBody: 'private' }).success).toBe(
      false
    );
  });
});

describe('account inference observation projection', () => {
  it.each([
    { accessRejected: { observedAt } },
    { quotaExhausted: { observedAt } },
    { accessRejected: { observedAt }, quotaExhausted: { observedAt } },
  ])('accepts observed parts with their own timestamps: %j', (inferenceObservation) => {
    expect(ProviderSubscriptionAccountSchema.parse({ ...account, inferenceObservation })).toEqual({
      ...account,
      inferenceObservation,
    });
  });

  it('preserves the nonempty observation constraint in JSON Schema', () => {
    const schema = z.toJSONSchema(ProviderSubscriptionAccountSchema);
    const branches = schema.oneOf as Array<{
      properties: { inferenceObservation: { minProperties: number } };
    }>;
    expect(
      branches.every((branch) => branch.properties.inferenceObservation.minProperties === 1)
    ).toBe(true);
  });

  it('omits unknown posture and rejects empty, malformed or extra observation data', () => {
    expect(ProviderSubscriptionAccountSchema.parse(account)).toEqual(account);
    for (const inferenceObservation of [
      {},
      null,
      { accessRejected: {} },
      { quotaExhausted: { observedAt: 'yesterday' } },
      { accessRejected: { observedAt, bearer: 'secret' } },
      { accessRejected: { observedAt }, version: 'private' },
    ]) {
      expect(
        ProviderSubscriptionAccountSchema.safeParse({ ...account, inferenceObservation }).success
      ).toBe(false);
    }
  });
});
