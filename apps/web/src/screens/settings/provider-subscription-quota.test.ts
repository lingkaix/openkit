import { describe, expect, it, vi } from 'vitest';
import {
  overlayConnectedAppAccount,
  overlayConnectedAppQuota,
  type ProviderSubscriptionAccountsPayload,
  type ProviderSubscriptionQuotaPayload,
  projectConnectedApps,
} from './data';

// These hooks are outside the account/quota projection under test.
vi.mock('@openkit/core-client', () => ({ createRequestId: vi.fn() }));
vi.mock('../../app/core-client', () => ({ useCoreClient: vi.fn() }));
vi.mock('../chat/data', () => ({ useCurrentWorkspaceId: vi.fn(), useWorkspaces: vi.fn() }));

const provider = {
  subscriptionProviderId: 'openai-codex' as const,
  displayName: 'OpenAI Codex' as const,
  loginModes: ['device_code'] as ['device_code'],
  quotaCapability: 'available' as const,
};
const account = {
  subscriptionProviderId: 'openai-codex' as const,
  accountSlotId: 'primary',
  status: 'logged_in' as const,
  boundProviderIds: [],
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:00:00.000Z',
};
const quota: ProviderSubscriptionQuotaPayload = {
  subscriptionProviderId: 'openai-codex',
  accountSlotId: 'primary',
  availability: 'available',
  observedAt: '2026-10-08T00:01:00.000Z',
  planType: 'plus',
  windows: [
    {
      id: 'primary',
      limitWindowSeconds: 604800,
      remainingPercent: 60,
      resetsAt: '2026-10-15T00:00:00.000Z',
    },
  ],
};
const absentQuota = {
  quotaAvailability: null,
  quotaPlanType: null,
  quotaSubscriptionActive: null,
  quotaAccountObservedAt: null,
  quotaObservedAt: null,
  quotaRetryAfter: null,
  quotaWindows: [],
  quotaBilling: null,
};

/** Public non-connected snapshots for the two reported lifecycle transitions. */
function disconnectedAccount(
  status: 'pending' | 'logged_out'
): ProviderSubscriptionAccountsPayload['accounts'][number] {
  return status === 'pending'
    ? {
        ...account,
        status,
        interaction: {
          mode: 'device_code',
          interactionId: 'test-interaction',
          verificationUrl: 'https://example.com/device',
          userCode: 'TEST-CODE',
        },
      }
    : { ...account, status };
}

describe('subscription quota lifecycle projection', () => {
  it.each([
    'pending',
    'logged_out',
  ] as const)('does not project cached quota with a %s account list', (status) => {
    const row = projectConnectedApps(provider, { accounts: [disconnectedAccount(status)] }, [quota])
      .accounts[0];
    expect(row).toMatchObject({ status, ...absentQuota });
  });

  it.each([
    'pending',
    'logged_out',
  ] as const)('does not restore quota when an old async read settles after becoming %s', async (status) => {
    let finish!: (value: ProviderSubscriptionQuotaPayload) => void;
    const response = new Promise<ProviderSubscriptionQuotaPayload>((resolve) => {
      finish = resolve;
    });
    const connected = projectConnectedApps(provider, { accounts: [account] }, [quota]);
    // The account owner advances independently of the already-started quota request.
    const current = {
      ...connected,
      accounts: connected.accounts.map((row) => ({ ...row, status })),
    };
    const late = response.then((value) => overlayConnectedAppQuota([current], value));
    finish({ ...quota, observedAt: '2026-10-08T00:03:00.000Z' });
    expect((await late)[0]?.accounts[0]).toMatchObject({ status, ...absentQuota });
  });

  it.each([
    'pending',
    'logged_out',
  ] as const)('clears cached quota when the detail snapshot becomes %s before the list refreshes', (status) => {
    const row = projectConnectedApps(provider, { accounts: [account] }, [quota]).accounts[0]!;
    const live = overlayConnectedAppAccount(row, disconnectedAccount(status));
    expect(live).toMatchObject({ status, ...absentQuota });
  });

  it('preserves supplied remaining, reset and observation time for logged_in', () => {
    const connected = projectConnectedApps(provider, { accounts: [account] }, [quota]);
    const row = overlayConnectedAppQuota([connected], quota)[0]?.accounts[0];
    expect(row).toMatchObject({
      status: 'logged_in',
      quotaAvailability: 'available',
      quotaObservedAt: '2026-10-08T00:01:00.000Z',
      quotaWindows: [
        {
          id: 'primary',
          limitWindowSeconds: 604800,
          remainingPercent: 60,
          resetsAt: '2026-10-15T00:00:00.000Z',
        },
      ],
    });
  });
});
