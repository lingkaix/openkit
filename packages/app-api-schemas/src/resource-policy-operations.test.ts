import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  RESOURCE_POLICY_OPERATION_DEFINITIONS,
  WorkspaceResourcePolicyChangeSchema,
  WorkspaceResourcePolicyRequestSchema,
  WorkspaceResourcePolicyTermsSchema,
} from './index.js';

const workspaceId = allocateEntityId('ws');
const threadId = allocateEntityId('th');
const otherThreadId = allocateEntityId('th');
const turnId = allocateEntityId('tu');
const userId = allocateEntityId('usr');
const approvalRequestId = 'approval_1';
const requestId = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-10-16T00:00:00.000Z';

const threadContainer = {
  owner: { kind: 'workspace' as const, workspaceId },
  kind: 'thread',
  id: threadId,
};

const activeBoundaryStatement = {
  id: 'stmt-boundary',
  author: { kind: 'human' as const, id: userId },
  authority: { kind: 'human' as const, userId },
  authoredAt: timestamp,
  scope: {
    subjects: [],
    actions: [],
    resources: [{ kind: 'container' as const, container: threadContainer }],
  },
  lifetime: {
    anchor: threadContainer,
  },
  kind: 'managed-boundary' as const,
  state: 'active' as const,
};

const permissionStatement = {
  id: 'stmt-permission',
  author: { kind: 'human' as const, id: userId },
  authority: { kind: 'human' as const, userId },
  authoredAt: timestamp,
  scope: {
    subjects: [{ kind: 'human' as const, id: userId }],
    actions: ['thread.read'],
    resources: [{ kind: 'container' as const, container: threadContainer }],
  },
  lifetime: {
    anchor: threadContainer,
  },
  kind: 'permission' as const,
  state: 'active' as const,
  effect: 'allow' as const,
  grant: { kind: 'ordinary' as const },
};

describe('workspace resource policy operation schemas', () => {
  it('admits null removal or a replacement document that retains an active managed-boundary targeting the exact thread', () => {
    const resource = { family: 'thread' as const, id: threadId };

    expect(
      WorkspaceResourcePolicyTermsSchema.parse({
        resource,
        replacement: null,
      }).replacement
    ).toBeNull();

    const validReplacement = {
      schemaVersion: 1 as const,
      statements: [activeBoundaryStatement, permissionStatement],
    };
    expect(
      WorkspaceResourcePolicyTermsSchema.parse({
        resource,
        replacement: validReplacement,
      }).replacement?.statements
    ).toHaveLength(2);
  });

  it('refuses replacements missing an active managed-boundary or targeting a different resource container', () => {
    const resource = { family: 'thread' as const, id: threadId };

    const inactiveBoundaryOnly = {
      schemaVersion: 1 as const,
      statements: [{ ...activeBoundaryStatement, state: 'inactive' as const }],
    };
    expect(
      WorkspaceResourcePolicyTermsSchema.safeParse({
        resource,
        replacement: inactiveBoundaryOnly,
      }).success
    ).toBe(false);

    const mismatchedThreadTarget = {
      schemaVersion: 1 as const,
      statements: [
        activeBoundaryStatement,
        {
          ...permissionStatement,
          scope: {
            ...permissionStatement.scope,
            resources: [
              {
                kind: 'container' as const,
                container: { ...threadContainer, id: otherThreadId },
              },
            ],
          },
        },
      ],
    };
    expect(
      WorkspaceResourcePolicyTermsSchema.safeParse({
        resource,
        replacement: mismatchedThreadTarget,
      }).success
    ).toBe(false);

    const multiResourceStatement = {
      schemaVersion: 1 as const,
      statements: [
        activeBoundaryStatement,
        {
          ...permissionStatement,
          scope: {
            ...permissionStatement.scope,
            resources: [
              { kind: 'container' as const, container: threadContainer },
              { kind: 'container' as const, container: threadContainer },
            ],
          },
        },
      ],
    };
    expect(
      WorkspaceResourcePolicyTermsSchema.safeParse({
        resource,
        replacement: multiResourceStatement,
      }).success
    ).toBe(false);
  });

  it('validates expectedRevision on WorkspaceResourcePolicyChangeSchema and exact confirmation on workspace.resource-access-apply', () => {
    const change = {
      resource: { family: 'thread' as const, id: threadId },
      replacement: null,
      expectedRevision: 'rev-1',
    };
    expect(WorkspaceResourcePolicyChangeSchema.parse(change)).toEqual(change);

    const requestReadback = {
      id: approvalRequestId,
      workspaceId,
      threadId,
      turnId,
      kind: 'permission' as const,
      status: 'pending' as const,
      title: 'Remove thread policy boundary',
      description: 'Remove managed thread policy',
      createdAt: timestamp,
      resolvedAt: null,
      change,
    };
    expect(
      WorkspaceResourcePolicyRequestSchema.parse(requestReadback).change.expectedRevision
    ).toBe('rev-1');

    const requestInputSchema =
      RESOURCE_POLICY_OPERATION_DEFINITIONS['workspace.resource-access-request'].inputSchema;
    expect(
      requestInputSchema.parse({
        workspaceId,
        threadId,
        requestId,
        change: { resource: change.resource, replacement: null },
      }).threadId
    ).toBe(threadId);

    const applyInputSchema =
      RESOURCE_POLICY_OPERATION_DEFINITIONS['workspace.resource-access-apply'].inputSchema;
    expect(
      applyInputSchema.parse({
        workspaceId,
        threadId,
        approvalRequestId,
        confirmation: 'APPLY WORKSPACE RESOURCE POLICY',
      }).confirmation
    ).toBe('APPLY WORKSPACE RESOURCE POLICY');

    expect(
      applyInputSchema.safeParse({
        workspaceId,
        threadId,
        approvalRequestId,
        confirmation: 'APPLY',
      }).success
    ).toBe(false);
  });
});
