import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderSubscriptionAccountSchema } from './provider-subscriptions.js';

const observedAt = '2026-10-02T00:00:00.000Z';
const account = {
  subscriptionProviderId: 'xai',
  accountSlotId: 'default',
  boundProviderIds: [],
  createdAt: observedAt,
  updatedAt: observedAt,
  status: 'logged_in',
};

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
