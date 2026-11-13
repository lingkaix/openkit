import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { PRODUCT_OPERATION_ACCESS_RIGHTS } from '@openkit/config-schema';
import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import { describe, expect, it } from 'vitest';
import {
  evaluateMcpClientAccess,
  type IntegrationPrincipal,
  type McpClientAccessInput,
} from './mcp-client-access.js';

const userId = 'usr_00000000-0000-7000-8000-000000000001';
const otherUserId = 'usr_00000000-0000-7000-8000-000000000002';
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const otherWorkspaceId = 'ws_00000000-0000-7000-8000-000000000002';
const client: IntegrationPrincipal = {
  kind: 'integration',
  id: 'fixture-mcp-client',
  responsibleUserId: userId,
};

/** Real NGAC decisions for this fixture's native operation/target; IDs are not Protocol identities. */
function kernel(
  label: string,
  operation: keyof typeof PRODUCT_OPERATION_ACCESS_RIGHTS,
  allow = true
): PolicyDecision {
  const user = `opaque-${label}`;
  const accessRights = [PRODUCT_OPERATION_ACCESS_RIGHTS[operation]];
  const state: PolicyState = {
    elements: [
      { id: user, kind: 'user' },
      { id: 'grant', kind: 'userAttribute' },
      { id: 'requested-resource', kind: 'object' },
      { id: 'resources', kind: 'objectAttribute' },
      { id: 'current-domain', kind: 'policyClass' },
    ],
    assignments: [
      { child: user, parent: 'grant' },
      { child: 'grant', parent: 'current-domain' },
      { child: 'requested-resource', parent: 'resources' },
      { child: 'resources', parent: 'current-domain' },
    ],
    operations: [{ id: operation, accessRights }],
    associations: allow
      ? [
          {
            id: 'current-grant',
            userAttribute: 'grant',
            targetAttribute: 'resources',
            accessRights,
          },
        ]
      : [],
  };
  return evaluateAccess(state, { user, target: 'requested-resource', operation });
}

/** Transient verified-owner projections, not issued Tokens, stored bindings or invented verifier fields. */
function fixture(
  operationId: 'workspace.read' | 'workspace.update' = 'workspace.read',
  targetWorkspaceId = workspaceId
) {
  const operation = OPERATION_DEFINITIONS[operationId].policyOperation;
  return {
    binding: {
      principal: client,
      principalOwnerUserId: userId,
      token: {
        tokenId: 'fixture-credential-id',
        ownerUserId: userId,
        scope: 'workspace' as const,
        workspaceIds: [workspaceId],
      },
    },
    operationId,
    target: {
      kind: 'workspace' as const,
      workspaceId: targetWorkspaceId,
      active: true,
      membership: 'member' as const,
    },
    userKernel: kernel('owner', operation),
    issuerChain: [
      {
        principal: {
          kind: 'integration' as const,
          id: 'fixture-issuer',
          responsibleUserId: userId,
        },
        active: true,
        kernel: kernel('intermediate-issuer', operation),
      },
      {
        principal: { kind: 'user' as const, id: userId },
        active: true,
        kernel: kernel('terminal-human', operation),
      },
    ],
  } satisfies McpClientAccessInput;
}

/** Refusal does not erase a verified principal or invent a User from conflicting ownership. */
function expectRefusal(
  input: McpClientAccessInput,
  onBehalfOfUserId: string | null = userId,
  principal: IntegrationPrincipal | null = client
) {
  const result = evaluateMcpClientAccess(input);
  expect(result.kernel.effect).toBe('deny');
  expect(result.principal).toEqual(principal);
  expect(result.onBehalfOfUserId).toBe(onBehalfOfUserId);
}

// Runtime Security E11: one principal, mandatory Token scope, attenuation and current issuers.
// Native binding, crypto, list, mutation and cascade joins remain unavailable and are not simulated.
describe('E11 dormant MCP-client scope and attenuation', () => {
  it('grants an exact own Workspace read under each existing client scope without relabeling the client', () => {
    for (const scope of ['workspace', 'workspace-readonly'] as const) {
      const input = fixture();
      const result = evaluateMcpClientAccess({
        ...input,
        binding: { ...input.binding, token: { ...input.binding.token, scope } },
      });
      expect(result.kernel.effect).toBe('allow');
      expect(result.principal).toEqual(client);
      expect(result.onBehalfOfUserId).toBe(userId);
    }
  });

  it('does not lend a wider client default grant to a User whose current Kernel denies', () => {
    const input = fixture();
    expectRefusal({ ...input, userKernel: kernel('owner', 'workspace.read', false) });
  });

  it('requires every issuer Kernel, not just the immediate issuer or terminal User', () => {
    const input = fixture();
    for (const deniedIndex of [0, 1]) {
      expectRefusal({
        ...input,
        issuerChain: input.issuerChain.map((issuer, index) =>
          index === deniedIndex
            ? { ...issuer, kernel: kernel('restricted-issuer', 'workspace.read', false) }
            : issuer
        ),
      });
    }
  });

  it('keeps a read-only Token restrictive for the exact registered mutation', () => {
    const input = fixture('workspace.update');
    expect(OPERATION_DEFINITIONS['workspace.update'].mutating).toBe(true);
    expect(input.userKernel.effect).toBe('allow');
    expectRefusal({
      ...input,
      binding: { ...input.binding, token: { ...input.binding.token, scope: 'workspace-readonly' } },
    });
  });

  it('refuses another Workspace even when the current User and issuers allow that target', () => {
    expectRefusal(fixture('workspace.read', otherWorkspaceId));
  });

  it('refuses an inactive intermediate credential or disabled terminal issuer despite remaining grants', () => {
    const input = fixture();
    // These authoritative inactive facts must win even if a captured grant still says allow.
    for (const inactiveIndex of [0, 1]) {
      expectRefusal({
        ...input,
        issuerChain: input.issuerChain.map((issuer, index) =>
          index === inactiveIndex ? { ...issuer, active: false } : issuer
        ),
      });
    }
  });

  it('refuses unknown binding and absent or empty verified issuer sequences', () => {
    const input = fixture();
    expectRefusal({ ...input, binding: null }, null, null);
    expectRefusal({ ...input, issuerChain: null });
    expectRefusal({ ...input, issuerChain: [] });
  });

  it('retains the known client but derives no on-behalf User from mismatched ownership', () => {
    const input = fixture();
    expectRefusal(
      {
        ...input,
        binding: { ...input.binding, token: { ...input.binding.token, ownerUserId: otherUserId } },
      },
      null
    );
  });

  it('never accepts the existing server-admin scope as an MCP-client default grant', () => {
    const input = fixture();
    expectRefusal({
      ...input,
      binding: { ...input.binding, token: { ...input.binding.token, scope: 'server-admin' } },
    });
  });

  it('does not infer a registered operation from a matching name prefix', () => {
    // Unknown input cannot borrow the known read operation's metadata or allowing Kernel facts.
    expectRefusal({ ...fixture(), operationId: 'workspace.read.unregistered' });
  });
});
