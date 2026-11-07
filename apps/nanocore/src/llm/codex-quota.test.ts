import type { CredentialStore } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeCodexReset, proveCodexCredentialCurrent, readCodexQuota } from './codex-quota.js';

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

/** Supplies a weekly duration independently of the primary window position. */
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

    const quota = await readCodexQuota(store);
    expect(quota).toMatchObject({
      availability: 'available',
      planType: 'pro',
      windows: [
        {
          id: 'primary',
          limitWindowSeconds: 604800,
          remainingPercent: 75,
          resetsAt: '2026-10-20T00:00:00.000Z',
          usedPercent: 25,
        },
      ],
    });
    if (quota.availability !== 'available') throw new Error('Expected available quota.');
    expect(quota.windows[0]).not.toHaveProperty('label');
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
    expect(result).toMatchObject({
      availability: 'available',
      heldReason: 'spend_control_reached',
    });
    expect(JSON.stringify(result)).not.toContain('held-private-canary');
  });

  it.each([
    {
      name: 'overage limit',
      patch: {
        credits: { has_credits: true, unlimited: false, overage_limit_reached: true },
      },
      heldReason: 'overage_limit_reached',
    },
    {
      name: 'rate limit',
      patch: {
        rate_limit: {
          ...usage().rate_limit,
          allowed: false,
          limit_reached: true,
        },
      },
      heldReason: 'rate_limit_reached',
    },
    {
      name: 'disallowed window',
      patch: {
        rate_limit: {
          ...usage().rate_limit,
          allowed: false,
          limit_reached: false,
        },
      },
      heldReason: 'not_allowed',
    },
  ])('projects held reason $name', async ({ patch, heldReason }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...usage(), ...patch })));
    expect(await readCodexQuota(credentials())).toMatchObject({
      availability: 'available',
      heldReason,
    });
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

const presented = {
  type: 'oauth' as const,
  access: 'synthetic-access',
  accountId: 'synthetic-account',
};
const redeemRequestId = '00000000-0000-4000-8000-000000000001';

describe('proveCodexCredentialCurrent', () => {
  it.each([
    ['not a finite instant', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['already elapsed', 0],
  ] as const)(
    'returns false before reading when the deadline is %s',
    async (_label, absoluteDeadline) => {
      const read = vi.fn();
      await expect(
        proveCodexCredentialCurrent({ read }, presented, absoluteDeadline)
      ).resolves.toBe(false);
      expect(read).not.toHaveBeenCalled();
    }
  );

  it.each([
    { type: 'api-key', access: presented.access, accountId: presented.accountId },
    { type: 'oauth', access: 'other-access', accountId: presented.accountId },
    { type: 'oauth', access: presented.access, accountId: 'other-account' },
  ])('returns false when the current credential does not match %j', async (current) => {
    await expect(
      proveCodexCredentialCurrent(
        { read: vi.fn().mockResolvedValue(current) },
        presented,
        Date.now() + 5_000
      )
    ).resolves.toBe(false);
  });

  it('returns true only while the same credential and version proof remain current', async () => {
    const read = vi.fn().mockResolvedValue(presented);
    const verifyVersion = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      proveCodexCredentialCurrent({ read }, presented, Date.now() + 5_000, verifyVersion)
    ).resolves.toBe(true);
    await expect(
      proveCodexCredentialCurrent({ read }, presented, Date.now() + 5_000, verifyVersion)
    ).resolves.toBe(false);
  });

  it('returns false when the credential read fails', async () => {
    await expect(
      proveCodexCredentialCurrent(
        { read: vi.fn().mockRejectedValue(new Error('unreadable')) },
        presented,
        Date.now() + 5_000
      )
    ).resolves.toBe(false);
  });

  it('returns false when the credential read does not finish before the deadline', async () => {
    vi.useFakeTimers();
    try {
      const pending = proveCodexCredentialCurrent(
        { read: vi.fn(() => new Promise(() => undefined)) },
        presented,
        Date.now() + 1_000
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('consumeCodexReset', () => {
  it.each([
    { access: ' ', accountId: presented.accountId, creditId: 'credit', redeemRequestId },
    { access: presented.access, accountId: ' ', creditId: 'credit', redeemRequestId },
    { access: presented.access, accountId: presented.accountId, creditId: ' ', redeemRequestId },
    {
      access: presented.access,
      accountId: presented.accountId,
      creditId: 'credit',
      redeemRequestId: 'not-a-uuid',
    },
    {
      access: presented.access,
      accountId: presented.accountId,
      creditId: 'x'.repeat(70_000),
      redeemRequestId,
    },
  ])('refuses invalid reset input before dispatch', async (input) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      consumeCodexReset(
        { type: 'oauth', access: input.access, accountId: input.accountId },
        { creditId: input.creditId, redeemRequestId: input.redeemRequestId }
      )
    ).rejects.toThrow(new TypeError('Invalid Codex reset input.'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns unknown when the consume transport is not ok or throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 503 })));
    await expect(
      consumeCodexReset(presented, { creditId: 'credit', redeemRequestId })
    ).resolves.toEqual({ outcome: 'unknown' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket closed')));
    await expect(
      consumeCodexReset(presented, { creditId: 'credit', redeemRequestId })
    ).resolves.toEqual({ outcome: 'unknown' });
  });

  it('returns unknown when the consume response exceeds the body ceiling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(new Uint8Array(70_000), { status: 200 }))
    );
    await expect(
      consumeCodexReset(presented, { creditId: 'credit', redeemRequestId })
    ).resolves.toEqual({ outcome: 'unknown' });
  });

  it('projects a validated consume result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ code: 'reset', windows_reset: true }))
    );
    await expect(
      consumeCodexReset(presented, { creditId: 'credit', redeemRequestId })
    ).resolves.toEqual({ outcome: 'reset', windowsReset: true });
  });
});
