import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ListVaultGrantRequestsResponseSchema,
  RequestVaultGrantSchema,
  VaultGrantRequestTermsSchema,
  VaultGrantRequestViewSchema,
} from './vault-grant-requests.js';
import { VAULT_OPERATION_DEFINITIONS } from './vault-operations.js';

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

const view = {
  approvalRequestId: 'approval_fixture',
  workspaceId: 'ws_fixture',
  threadId: 'th_fixture',
  raisingTurnId: 'tu_fixture',
  responsibleUserId: 'user_fixture',
  requesterKind: 'person',
  agentId: null,
  agentSessionId: null,
  terms,
  state: 'pending',
  resolution: null,
  ending: null,
  claim: 'unclaimed',
  disposition: null,
  delivery: 'undelivered',
  decidingActorId: null,
  grantId: null,
  createdAt: '2026-10-16T00:00:00.000Z',
  effect: { status: 'available', summary: 'Review exact terms', detail: 'Synthetic exact terms' },
  canApprove: true,
  canIssue: false,
};
describe('descriptive grant request readers', () => {
  it('discards inert additions and rejects unsupported core and authority-bearing terms', () => {
    const parsed = VaultGrantRequestViewSchema.parse({ ...view, displayHint: 'inert fixture' });
    expect(parsed).toEqual(view);
    expect(
      ListVaultGrantRequestsResponseSchema.parse({
        workspaceId: view.workspaceId,
        threadId: view.threadId,
        items: [{ ...view, displayHint: 'inert fixture' }],
        displayHint: 'inert fixture',
      })
    ).toEqual({ workspaceId: view.workspaceId, threadId: view.threadId, items: [view] });
    expect(VaultGrantRequestViewSchema.safeParse({ ...view, state: 'unsupported' }).success).toBe(
      false
    );
    expect(
      VaultGrantRequestViewSchema.safeParse({
        ...view,
        terms: { ...terms, additionalAuthority: true },
      }).success
    ).toBe(false);
    for (const operation of [
      'vault.server-mcp-injection-plan-list',
      'vault.server-mcp-injection-receipt-list',
    ] as const) {
      const schema = VAULT_OPERATION_DEFINITIONS[operation].outputSchema;
      expect(schema.parse({ items: [], displayHint: 'inert fixture' })).toEqual({ items: [] });
      expect(schema.safeParse({ items: 'unsupported' }).success).toBe(false);
    }
  });
  it('accepts opaque references issued by both supported scopes without a prefix assumption', () => {
    for (const ownerScope of ['workspace', 'server'] as const) {
      expect(
        VaultGrantRequestTermsSchema.safeParse({
          ...terms,
          referenceId: randomUUID(),
          ownerScope,
          lifetime: ownerScope,
        }).success
      ).toBe(true);
      expect(
        VaultGrantRequestTermsSchema.safeParse({
          ...terms,
          referenceId: 'ghp_synthetic_private_value',
          ownerScope,
          lifetime: ownerScope,
        }).success
      ).toBe(false);
    }
  });
});
