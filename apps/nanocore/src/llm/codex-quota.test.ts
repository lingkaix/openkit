import type { CredentialStore } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCodexQuota } from './codex-quota.js';

const usageUrl = 'https://chatgpt.com/backend-api/wham/usage';
const resetsUrl = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';

/** Supplies synthetic credentials only; no host credential source is read. */
function credentials(): CredentialStore {
  return {
    read: vi.fn().mockResolvedValue({
      type: 'oauth',
      access: 'synthetic-access',
      accountId: 'synthetic-account',
    }),
  } as unknown as CredentialStore;
}

/** Gives the primary position a weekly duration to catch fixed-position labels. */
function usage() {
  return {
    plan_type: 'pro',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 25,
        limit_window_seconds: 604800,
        reset_at: 1792454400,
        reset_after_seconds: 3600,
      },
      secondary_window: null,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Codex subscription quota management', () => {
  it('keeps a healthy duration-based weekly window without acquiring another token', async () => {
    const store = credentials();
    const fetchMock = vi.fn().mockResolvedValue(Response.json(usage()));
    vi.stubGlobal('fetch', fetchMock);

    expect(await readCodexQuota(store)).toMatchObject({
      availability: 'available',
      planType: 'pro',
      windows: [{ id: 'primary', limitWindowSeconds: 604800, usedPercent: 25 }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(usageUrl);
    expect(store.read).toHaveBeenCalledWith('openai-codex');
  });

  it('preserves a credit balance decimal string without rounding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ...usage(),
          credits: {
            has_credits: true,
            unlimited: false,
            balance: '9007199254740993.000000000000000001',
          },
        })
      )
    );

    expect(await readCodexQuota(credentials())).toMatchObject({
      availability: 'available',
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: '9007199254740993.000000000000000001',
      },
    });
  });

  it('reads only available resets and projects the earliest finite expiry', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === usageUrl) {
        return Response.json({ ...usage(), rate_limit_reset_credits: { available_count: 2 } });
      }
      expect(String(url)).toBe(resetsUrl);
      return Response.json({
        available_count: 2,
        credits: [
          { id: 'never', reset_type: 'weekly', status: 'available', expires_at: null },
          {
            id: 'spent',
            reset_type: 'weekly',
            status: 'redeemed',
            expires_at: '2026-10-19T00:00:00.000Z',
          },
          {
            id: 'soon',
            reset_type: 'weekly',
            status: 'available',
            expires_at: '2026-10-20T00:00:00.000Z',
            provider_private: 'reset-private-canary',
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await readCodexQuota(credentials());
    expect(result).toMatchObject({
      resetCredits: {
        availableCount: 2,
        available: expect.arrayContaining([
          { id: 'never', resetType: 'weekly', expiresAt: null },
          { id: 'soon', resetType: 'weekly', expiresAt: '2026-10-20T00:00:00.000Z' },
        ]),
        soonestExpiresAt: '2026-10-20T00:00:00.000Z',
      },
    });
    expect(JSON.stringify(result)).not.toContain('spent');
    expect(JSON.stringify(result)).not.toContain('reset-private-canary');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not fetch the reset list when the available count is zero', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ ...usage(), rate_limit_reset_credits: { available_count: 0 } })
      );
    vi.stubGlobal('fetch', fetchMock);
    expect(await readCodexQuota(credentials())).toMatchObject({
      resetCredits: { availableCount: 0, available: [] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('projects a bounded held reason without publishing provider detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ...usage(),
          spend_control: { reached: true },
          rate_limit_reached_type: { type: 'held-private-canary' },
        })
      )
    );
    const result = await readCodexQuota(credentials());
    expect(result).toMatchObject({ availability: 'available', heldReason: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('held-private-canary');
  });

  it('fails closed on a malformed consumed credit balance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ...usage(),
          credits: { has_credits: true, unlimited: false, balance: true },
        })
      )
    );
    expect(await readCodexQuota(credentials())).toBeNull();
  });
});
