import { describe, expect, it } from 'vitest';
import { RequestVaultGrantSchema, VaultGrantRequestTermsSchema } from './vault-grant-requests.js';

const terms = {
  referenceId: 'vault_fixture',
  ownerScope: 'workspace',
  lifetime: 'workspace',
  injectionPath: 'gateway-only',
};

describe('supported secret-use request schema', () => {
  it('admits only current scope, lifetime and sink combinations', () => {
    expect(VaultGrantRequestTermsSchema.safeParse(terms).success).toBe(true);
    expect(
      VaultGrantRequestTermsSchema.safeParse({ ...terms, ownerScope: 'server', lifetime: 'server' })
        .success
    ).toBe(true);
    expect(
      VaultGrantRequestTermsSchema.safeParse({ ...terms, injectionPath: 'runtime-env' }).success
    ).toBe(true);
    for (const changed of [
      { ...terms, lifetime: 'turn' },
      { ...terms, lifetime: 'server' },
      { ...terms, ownerScope: 'server', lifetime: 'server', injectionPath: 'runtime-env' },
      { ...terms, injectionPath: 'runtime-env', targetCapabilityId: 'mcp.call_tool' },
      { ...terms, injectionPath: 'backend-provider' },
      { ...terms, targetCapabilityId: 'mcp' },
    ])
      expect(VaultGrantRequestTermsSchema.safeParse(changed).success).toBe(false);
  });
  it('rejects material, free text and raw secret-shaped identifiers before durable capture', () => {
    for (const changed of [
      { ...terms, material: 'synthetic-private-value' },
      { ...terms, reason: 'synthetic-private-value' },
      { ...terms, targetAgentId: 'ghp_synthetic_private_value' },
      { ...terms, mcpSource: { serverId: 'ghp_synthetic_private_value', slot: 'token' } },
    ])
      expect(VaultGrantRequestTermsSchema.safeParse(changed).success).toBe(false);
    expect(
      RequestVaultGrantSchema.safeParse({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: '11111111-1111-4111-8111-111111111111',
        terms,
        actorId: 'another-user',
      }).success
    ).toBe(false);
  });
});
