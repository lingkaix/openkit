import { describe, expect, it } from 'vitest';

import {
  assertVaultEntryMetadata,
  createLockedVaultBackend,
  VaultBackendError,
  type VaultSecretMaterial,
} from './vault-backend.js';

describe('vault backend boundary', () => {
  it('reports locked health without blocking NanoCore boot', () => {
    const backend = createLockedVaultBackend({
      diagnostic: 'No unlock source is configured.',
      kind: 'encrypted-file',
    });

    expect(backend.health()).toEqual({
      diagnostic: 'No unlock source is configured.',
      kind: 'encrypted-file',
      state: 'locked',
    });
  });

  it('fails locked operations with typed redacted errors', () => {
    const backend = createLockedVaultBackend({
      diagnostic: 'No unlock source is configured.',
      kind: 'encrypted-file',
    });
    const material: VaultSecretMaterial = 'live_secret_value';

    expect(() => backend.resolve({ referenceId: 'vault_demo' })).toThrow(VaultBackendError);
    expect(() => backend.resolve({ referenceId: 'vault_demo' })).toThrow('vault-locked');

    try {
      backend.store({
        material,
        metadata: {
          ownerScope: 'workspace',
          workspaceId: 'ws_demo',
        },
        referenceId: 'vault_demo',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(VaultBackendError);
      expect(error).toMatchObject({ code: 'vault-locked' });
      expect(String(error)).not.toContain(material);
      return;
    }

    throw new Error('Expected locked vault store to fail.');
  });

  it.each([
    { accountSlotId: 'a', boundary: 'lowercase first character' },
    { accountSlotId: '0', boundary: 'numeric first character' },
    { accountSlotId: `a${'_'.repeat(63)}`, boundary: '64-character maximum' },
  ])('accepts the provider account slot $boundary boundary', ({ accountSlotId }) => {
    expect(() =>
      assertVaultEntryMetadata({
        ownerScope: 'server',
        providerSubscriptionAccount: {
          accountSlotId,
          subscriptionProviderId: 'openai-codex',
        },
      } as never)
    ).not.toThrow();
  });

  it.each([
    { accountSlotId: '_slot', boundary: 'underscore first character' },
    { accountSlotId: '-slot', boundary: 'hyphen first character' },
    { accountSlotId: `a${'_'.repeat(64)}`, boundary: '65-character overflow' },
  ])('rejects the provider account slot $boundary boundary', ({ accountSlotId }) => {
    expect(() =>
      assertVaultEntryMetadata({
        ownerScope: 'server',
        providerSubscriptionAccount: {
          accountSlotId,
          subscriptionProviderId: 'openai-codex',
        },
      } as never)
    ).toThrow('backend-unavailable');
  });

  it('strictly validates provider-subscription inventory metadata', () => {
    expect(() =>
      assertVaultEntryMetadata({
        ownerScope: 'server',
        providerSubscriptionAccount: {
          accountSlotId: 'slot_1',
          subscriptionProviderId: 'openai-codex',
        },
      } as never)
    ).not.toThrow();

    for (const metadata of [
      {
        ownerScope: 'workspace',
        workspaceId: 'ws_demo',
        providerSubscriptionAccount: {
          accountSlotId: 'slot_1',
          subscriptionProviderId: 'openai-codex',
        },
      },
      {
        ownerScope: 'user',
        userId: 'user_demo',
        providerSubscriptionAccount: {
          accountSlotId: 'slot_1',
          subscriptionProviderId: 'xai',
        },
      },
      {
        ownerScope: 'server',
        providerSubscriptionAccount: {
          accountSlotId: 'Slot.Invalid',
          subscriptionProviderId: 'openai-codex',
        },
      },
      {
        ownerScope: 'server',
        providerSubscriptionAccount: {
          accountSlotId: 'slot_1',
          subscriptionProviderId: 'unsupported',
        },
      },
      {
        ownerScope: 'server',
        providerSubscriptionAccount: {
          subscriptionProviderId: 'xai',
        },
      },
      {
        ownerScope: 'server',
        providerSubscriptionAccount: {
          accountSlotId: 'slot_1',
        },
      },
      {
        ownerScope: 'server',
        providerSubscriptionAccount: {
          accountSlotId: 'slot_1',
          extra: true,
          subscriptionProviderId: 'xai',
        },
      },
      {
        ownerScope: 'server',
        extra: true,
        providerSubscriptionAccount: {
          accountSlotId: 'slot_1',
          subscriptionProviderId: 'xai',
        },
      },
    ]) {
      expect(() => assertVaultEntryMetadata(metadata as never)).toThrow('backend-unavailable');
    }
  });
});
