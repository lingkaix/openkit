import type { Models } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readXaiAutoTopup, readXaiQuota } from './xai-quota.js';

const NOW = '2026-09-18T00:00:00.000Z';
const API_KEY = 'xai-access-canary';
const USER_ID = 'xai-user-canary';
const USER_URL = 'https://cli-chat-proxy.grok.com/v1/user?include=subscription';
const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const AUTO_TOPUP_URL = 'https://cli-chat-proxy.grok.com/v1/auto-topup-rule';
const DISCOVERY_HEADERS = {
  Authorization: `Bearer ${API_KEY}`,
  'X-XAI-Token-Auth': 'xai-grok-cli',
  'x-grok-client-mode': 'headless',
  'x-grok-client-version': '1.0.12',
} as const;

/**
 * Builds a pair-scoped Models stub that resolves one xAI bearer snapshot.
 *
 * @param apiKey Resolved api key, or undefined when auth is absent.
 * @returns Stock Models surface used by the private reader.
 */
function models(apiKey: string | undefined = API_KEY): Models {
  return {
    getAuth: vi.fn(async () =>
      apiKey === undefined ? undefined : { auth: { apiKey }, source: 'OAuth' }
    ),
  } as unknown as Models;
}

/**
 * Stubs the exact xAI quota and auto-top-up URLs.
 *
 * @param bodies Optional JSON bodies per URL.
 * @returns Fetch spy.
 */
function mockUpstream(bodies: { autoTopup?: unknown; billing?: unknown; user?: unknown } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === USER_URL) {
      return new Response(
        JSON.stringify(bodies.user ?? { subscriptionTier: 'SuperGrok', userId: USER_ID })
      );
    }
    if (url === BILLING_URL) {
      if (bodies.billing === undefined && !('billing' in bodies)) {
        return new Response(
          JSON.stringify({
            config: {
              creditUsagePercent: 42.5,
              currentPeriod: {
                end: '2026-09-01T00:00:00.000Z',
                start: '2026-08-01T00:00:00.000Z',
                type: 'USAGE_PERIOD_TYPE_MONTHLY',
              },
              prepaidBalance: { val: 12 },
            },
          })
        );
      }
      if (bodies.billing instanceof Error) {
        throw bodies.billing;
      }
      return new Response(JSON.stringify(bodies.billing));
    }
    if (url === AUTO_TOPUP_URL) {
      return new Response(JSON.stringify(bodies.autoTopup ?? {}));
    }
    throw new Error(`unexpected provider url ${url}`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readXaiQuota', () => {
  it('projects nonempty exact !=Free eligibility, true-zero meters, and signed cents', async () => {
    const fetchSpy = mockUpstream({
      billing: {
        config: {
          creditUsagePercent: 0,
          currentPeriod: {
            end: '2026-09-01T10:00:00+10:00',
            start: '2026-08-01T00:00:00.000Z',
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
          },
          isUnifiedBillingUser: true,
          onDemandCap: {},
          onDemandUsed: { val: -3 },
          prepaidBalance: { val: 12 },
        },
      },
      user: { subscriptionTier: 'SuperGrok', userId: USER_ID },
    });

    await expect(readXaiQuota(models(), () => NOW)).resolves.toEqual({
      accountObservedAt: NOW,
      availability: 'available',
      billing: {
        currency: 'USD',
        onDemandCapCents: 0,
        onDemandUsedCents: -3,
        prepaidBalanceCents: 12,
        sharedAllowance: true,
      },
      planType: 'SuperGrok',
      subscriptionActive: true,
      windows: [
        {
          id: 'included',
          periodType: 'weekly',
          remainingPercent: 100,
          resetsAt: '2026-09-01T00:00:00.000Z',
          startsAt: '2026-08-01T00:00:00.000Z',
          usedPercent: 0,
        },
      ],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(USER_URL);
    expect(fetchSpy.mock.calls[0]?.[1]).toEqual({
      headers: DISCOVERY_HEADERS,
      method: 'GET',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(BILLING_URL);
  });

  it.each([
    { expected: false, name: 'exact Free', subscriptionTier: 'Free' },
    { expected: false, name: 'empty string', subscriptionTier: '' },
    { expected: false, name: 'null tier', subscriptionTier: null },
    { expected: false, name: 'absent tier', subscriptionTier: undefined },
    { expected: true, name: 'lowercase free', subscriptionTier: 'free' },
    { expected: true, name: 'padded Free', subscriptionTier: ' Free' },
  ])('treats $name as subscriptionActive=$expected without trimming', async (testCase) => {
    mockUpstream({
      billing: { config: { creditUsagePercent: 1 } },
      user: {
        userId: USER_ID,
        ...(testCase.subscriptionTier === undefined
          ? {}
          : { subscriptionTier: testCase.subscriptionTier }),
      },
    });

    const quota = await readXaiQuota(models(), () => NOW);

    expect(quota).toMatchObject({
      accountObservedAt: NOW,
      availability: 'available',
      subscriptionActive: testCase.expected,
    });
    if (typeof testCase.subscriptionTier === 'string' && testCase.subscriptionTier.length > 0) {
      expect(quota).toMatchObject({ planType: testCase.subscriptionTier });
    } else {
      expect(quota).not.toHaveProperty('planType');
    }
  });

  it('omits null money and missing usage instead of inventing a zero meter', async () => {
    mockUpstream({
      billing: {
        config: {
          currentPeriod: { end: '2026-09-01T00:00:00.000Z' },
          prepaidBalance: null,
        },
      },
    });

    await expect(readXaiQuota(models(), () => NOW)).resolves.toEqual({
      accountObservedAt: NOW,
      availability: 'available',
      planType: 'SuperGrok',
      subscriptionActive: true,
      windows: [{ id: 'included', resetsAt: '2026-09-01T00:00:00.000Z' }],
    });
  });

  it('emits a money-only observation without a synthetic included window', async () => {
    mockUpstream({
      billing: { config: { prepaidBalance: {} } },
    });

    await expect(readXaiQuota(models(), () => NOW)).resolves.toEqual({
      accountObservedAt: NOW,
      availability: 'available',
      billing: { currency: 'USD', prepaidBalanceCents: 0 },
      planType: 'SuperGrok',
      subscriptionActive: true,
      windows: [],
    });
  });

  it('rejects explicit null Cent.val because the vendor default applies only to an absent key', async () => {
    mockUpstream({ billing: { config: { prepaidBalance: { val: null } } } });
    expect(await readXaiQuota(models(), () => NOW)).toMatchObject({
      availability: 'temporarily_unavailable',
    });
  });

  it('preserves same-call discovery when billing fails and never issues a third request', async () => {
    const fetchSpy = mockUpstream({
      billing: new Error('billing unavailable'),
    });

    await expect(readXaiQuota(models(), () => NOW)).resolves.toEqual({
      accountObservedAt: NOW,
      availability: 'temporarily_unavailable',
      planType: 'SuperGrok',
      subscriptionActive: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([USER_URL, BILLING_URL]);
  });

  it('returns null without requests when auth is unusable', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('xAI quota must not perform a network request.'));

    await expect(readXaiQuota(models(''), () => NOW)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-safe cent value as a billing failure that keeps discovery', async () => {
    mockUpstream({
      billing: { config: { prepaidBalance: { val: Number.MAX_SAFE_INTEGER + 1 } } },
    });

    await expect(readXaiQuota(models(), () => NOW)).resolves.toEqual({
      accountObservedAt: NOW,
      availability: 'temporarily_unavailable',
      planType: 'SuperGrok',
      subscriptionActive: true,
    });
  });
});

describe('readXaiAutoTopup', () => {
  it('discovers the user then reads the rule without a billing call', async () => {
    const fetchSpy = mockUpstream({
      autoTopup: {
        rule: {
          maxAmountPerMonth: { val: 50 },
          minBeforeHittingSl: {},
          topupAmount: { val: 25 },
        },
      },
    });

    await expect(readXaiAutoTopup(models())).resolves.toEqual({
      amountCents: 25,
      availability: 'available',
      currency: 'USD',
      enabled: false,
      monthlyCapCents: 50,
      thresholdCents: 0,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([USER_URL, AUTO_TOPUP_URL]);
    expect(fetchSpy.mock.calls[1]?.[1]).toEqual({
      headers: { ...DISCOVERY_HEADERS, 'x-userid': USER_ID },
      method: 'GET',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects explicit null enabled because the vendor boolean default applies only to an absent key', async () => {
    mockUpstream({ autoTopup: { rule: { enabled: null } } });
    expect(await readXaiAutoTopup(models())).toBeNull();
  });

  it('treats a missing rule as available with unknown enabled state', async () => {
    mockUpstream({ autoTopup: { rule: null } });

    await expect(readXaiAutoTopup(models())).resolves.toEqual({
      availability: 'available',
      currency: 'USD',
    });
  });
});
