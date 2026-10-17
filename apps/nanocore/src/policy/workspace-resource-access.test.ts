import type { WorkspaceResourceAccessEntry } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  evaluateWorkspaceResourceAccess,
  type ResourcePolicyActor,
} from './workspace-resource-access.js';

const userId = allocateEntityId('usr');
const otherUserId = allocateEntityId('usr');
const resource = { family: 'thread' as const, id: allocateEntityId('th') };
const actor = { kind: 'user' as const, userId };
const entry: WorkspaceResourceAccessEntry = {
  resource,
  grants: [{ subject: actor, operations: ['thread.read'] }],
  prohibitions: [],
};
const decide = (
  resourceAccess: WorkspaceResourceAccessEntry[],
  operation = 'thread.read',
  current: ResourcePolicyActor = actor,
  eligible = true
) =>
  evaluateWorkspaceResourceAccess({
    actor: current,
    eligible,
    resource,
    operation,
    resourceAccess,
  });

describe('named Workspace resource Kernel projection', () => {
  it('requires both baseline eligibility and the additional exact resource association', () => {
    expect(decide([]).effect).toBe('allow');
    expect(decide([entry]).effect).toBe('allow');
    expect(decide([entry]).trace.policyClasses).toHaveLength(2);
    expect(decide([entry], 'turn.run').effect).toBe('deny');
    expect(decide([entry], 'thread.read', { kind: 'user', userId: otherUserId }).effect).toBe(
      'deny'
    );
    expect(decide([entry], 'thread.read', actor, false).effect).toBe('deny');
    expect(decide([{ ...entry, grants: [] }]).effect).toBe('deny');
  });

  it('honors explicit prohibitions and narrows later operations without changing unrelated Threads', () => {
    const prohibited = decide([{ ...entry, prohibitions: entry.grants }]);
    expect(prohibited.effect).toBe('deny');
    expect(prohibited.reasons).toEqual([expect.objectContaining({ code: 'restriction' })]);
    expect(
      decide([{ ...entry, resource: { ...resource, id: allocateEntityId('th') } }]).effect
    ).toBe('allow');
    expect(
      decide([{ ...entry, grants: [{ subject: actor, operations: ['turn.run'] }] }]).effect
    ).toBe('deny');
  });

  it('does not grant a human allocation or one Agent allocation to other processes sharing its User', () => {
    const agent = {
      kind: 'agent' as const,
      userId,
      agentId: 'researcher',
      processId: 'runtime-process-a',
    };
    const subject = { kind: 'agent' as const, userId, agentId: 'researcher' };
    const agentEntry = { ...entry, grants: [{ subject, operations: ['thread.read' as const] }] };
    expect(decide([entry], 'thread.read', agent).effect).toBe('deny');
    expect(decide([agentEntry], 'thread.read', agent).effect).toBe('allow');
    expect(decide([agentEntry], 'thread.read', { ...agent, agentId: 'another-agent' }).effect).toBe(
      'deny'
    );
    expect(decide([agentEntry], 'thread.read', actor).effect).toBe('deny');
    expect(
      decide([{ ...agentEntry, prohibitions: agentEntry.grants }], 'thread.read', agent).effect
    ).toBe('deny');
  });
});
