import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  OPERATION_DEFINITIONS,
  type OperationDefinition,
  operationMcpEligible,
} from './operation-definitions.js';

describe('User owner grant withdrawal contract', () => {
  it('declares fixed User admission and the existing explicit Workspace mutation fence', () => {
    // Harness Subscription Logins and Operation Definition: departed owners need User admission.
    const definition = (OPERATION_DEFINITIONS as Record<string, OperationDefinition>)[
      'vault.grant-withdraw'
    ];
    expect(definition, 'User owner withdrawal is missing from the public registry.').toBeDefined();
    expect(definition).toMatchObject({
      binding: 'json',
      returnsOneTimeSecret: false,
      successStatus: 200,
      scope: { kind: 'user' },
      target: { kind: 'user' },
      mutationTarget: { kind: 'body-workspace', field: 'workspaceId' },
      policyOperation: 'vault.admin',
      mutating: true,
    });
    expect(definition!.credentials).toEqual(
      expect.arrayContaining(['local-user', 'user-session', 'deployment-administrator'])
    );
    expect(definition!.credentials).not.toContain('worker-package');
    expect(definition!.credentials).not.toContain('coordinator');
    expect(definition!.insertionPoints?.stages).toEqual(
      expect.arrayContaining(['propose', 'decide', 'commit', 'completed'])
    );
    expect(operationMcpEligible(definition!)).toBe(true);
    const input = { workspaceId: allocateEntityId('ws'), grantId: allocateEntityId('grant') };
    expect(definition!.inputSchema.parse(input)).toEqual(input);
    for (const field of [
      'userId',
      'ownerUserId',
      'actor',
      'referenceId',
      'policyDecisionId',
      'material',
      'credentialValue',
    ])
      expect(definition!.inputSchema.safeParse({ ...input, [field]: 'synthetic' }).success).toBe(
        false
      );
    expect(definition!.inputSchema.safeParse({ grantId: input.grantId }).success).toBe(false);
    expect(
      definition!.inputSchema.safeParse({ ...input, grantId: allocateEntityId('vault') }).success
    ).toBe(false);
  });

  it('keeps current Workspace grant administration and Server MCP admission scopes', () => {
    for (const id of ['vault.grant-create', 'vault.grant-narrow', 'vault.grant-revoke'] as const)
      expect(OPERATION_DEFINITIONS[id]).toMatchObject({
        scope: { kind: 'body-workspace', field: 'workspaceId' },
        target: { kind: 'workspace' },
        policyOperation: 'vault.admin',
      });
    expect(OPERATION_DEFINITIONS['vault.server-mcp-grant-revoke'].scope).toEqual({
      kind: 'server',
    });
  });
});
