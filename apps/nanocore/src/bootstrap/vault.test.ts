import { describe, expect, it } from 'vitest';

import { checkBootVaultBackend } from './vault.js';

describe('boot vault backend check', () => {
  it('reports a locked vault as non-critical degraded readiness', () => {
    expect(checkBootVaultBackend()).toEqual({
      status: 'degraded',
      reason: {
        code: 'vault.locked',
        message: 'Vault backend is locked until an unlock source is configured or supplied.',
        blocks: ['vault.read', 'vault.use', 'secret.inject'],
      },
    });
  });
});
