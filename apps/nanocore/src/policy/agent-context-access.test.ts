import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import { PolicyScopeV1Schema, PolicySubjectV1Schema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  type AgentContextReadAccessInput,
  evaluateAgentContextReadAccess,
} from './agent-context-access.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const userId = 'usr_00000000-0000-7000-8000-000000000001';
const agentId = 'read-assistant';
const operation = 'thread.read';
const principal = { kind: 'agent' as const, id: agentId };
const resource = {
  kind: 'container' as const,
  container: {
    owner: { kind: 'workspace' as const, workspaceId },
    kind: 'thread',
    id: 'th_00000000-0000-7000-8000-000000000001',
  },
};
const otherResource = {
  ...resource,
  container: { ...resource.container, id: 'th_00000000-0000-7000-8000-000000000002' },
};
const conversation = {
  owner: { kind: 'workspace' as const, workspaceId },
  kind: 'thread',
  id: 'th_00000000-0000-7000-8000-000000000003',
};

/** Real current Kernel facts for the fixture's same native read and source resource. */
function kernel(subject: 'agent' | 'requester', allow = true): PolicyDecision {
  // NGAC identifiers are deliberately opaque, not Protocol principal or resource IDs.
  // The upstream owner binds these facts to the native read; this adapter must not parse trace IDs.
  const user = subject === 'agent' ? 'opaque-agent-node' : 'opaque-requester-node';
  const state: PolicyState = {
    elements: [
      { id: user, kind: 'user' },
      { id: 'readers', kind: 'userAttribute' },
      { id: 'source-node', kind: 'object' },
      { id: 'readable', kind: 'objectAttribute' },
      { id: 'current-domain', kind: 'policyClass' },
    ],
    assignments: [
      { child: user, parent: 'readers' },
      { child: 'readers', parent: 'current-domain' },
      { child: 'source-node', parent: 'readable' },
      { child: 'readable', parent: 'current-domain' },
    ],
    operations: [{ id: operation, accessRights: ['read'] }],
    associations: allow
      ? [
          {
            id: 'current-read',
            userAttribute: 'readers',
            targetAttribute: 'readable',
            accessRights: ['read'],
          },
        ]
      : [],
  };
  return evaluateAccess(state, { user, target: 'source-node', operation });
}

/** Typed transient facts, not a fabricated Turn record, grant receipt, or retained context. */
function directRead(): AgentContextReadAccessInput {
  return {
    subject: PolicySubjectV1Schema.parse({
      principal,
      onBehalfOf: userId,
      actor: { kind: 'agent', id: agentId, responsibleUserId: userId },
      process: {
        workspaceId,
        threadId: conversation.id,
        turnId: 'tu_00000000-0000-7000-8000-000000000001',
      },
      credentialKind: 'worker-package',
      responsibleHumanId: userId,
    }),
    operation,
    resource,
    agentKernel: kernel('agent'),
    initiatorKernel: kernel('requester'),
    envelope: PolicyScopeV1Schema.parse({
      subjects: [principal],
      actions: [operation],
      resources: [resource],
    }),
    context: {
      preset: 'owner-direct',
      surface: 'app',
      conversation,
      initiative: 'requested',
      audience: { kind: 'user', userId },
      resourceAudience: { kind: 'user', userId },
      trigger: null,
    },
  };
}

/** Current members receive only the canonical Workspace-shared source classification. */
function sharedRead(): AgentContextReadAccessInput {
  const input = directRead();
  return {
    ...input,
    context: {
      ...input.context,
      preset: 'workspace-members',
      audience: { kind: 'workspace', workspaceId },
      resourceAudience: { kind: 'workspace', workspaceId },
    },
  };
}

/** An established trigger is explicit current owner input, never inferred from absent initiation. */
function triggerRead(): AgentContextReadAccessInput {
  const input = sharedRead();
  return {
    ...input,
    subject: { ...input.subject, onBehalfOf: null },
    initiatorKernel: null,
    context: {
      ...input.context,
      preset: 'agent-initiated',
      initiative: 'self',
      trigger: { agentId, responsibleHumanId: userId, targets: [resource] },
    },
  };
}

// Runtime Security E10 Intersection, Self-initiated work, Audience rule and first three Presets.
// Agent accountability/domain/credentials are already in agentKernel; no runtime owner is replaced.
describe('E10 pure Kernel context read intersection', () => {
  it('admits an owner-direct read inside all current grants and its private output audience', () => {
    expect(evaluateAgentContextReadAccess(directRead()).effect).toBe('allow');
  });

  it('admits a Workspace-shared read to the current Workspace audience', () => {
    expect(evaluateAgentContextReadAccess(sharedRead()).effect).toBe('allow');
  });

  it('does not lend the wider agent grant to a requester without the read right', () => {
    const input = directRead();
    const initiatorKernel = kernel('requester', false);
    expect(input.agentKernel.effect).toBe('allow');
    expect(initiatorKernel.effect).toBe('deny');
    expect(evaluateAgentContextReadAccess({ ...input, initiatorKernel }).effect).toBe('deny');
  });

  it('refuses a read target outside the narrower context envelope', () => {
    const input = directRead();
    const envelope = PolicyScopeV1Schema.parse({ ...input.envelope, resources: [otherResource] });
    expect(evaluateAgentContextReadAccess({ ...input, envelope }).effect).toBe('deny');
  });

  it('does not carry a requester-private read into a shared room', () => {
    const input = sharedRead();
    expect(input.initiatorKernel?.effect).toBe('allow');
    expect(
      evaluateAgentContextReadAccess({
        ...input,
        context: { ...input.context, resourceAudience: { kind: 'user', userId } },
      }).effect
    ).toBe('deny');
  });

  it('refuses absent initiation outside an explicitly established trigger', () => {
    const input = triggerRead();
    expect(
      evaluateAgentContextReadAccess({
        ...input,
        context: { ...input.context, trigger: null },
      }).effect
    ).toBe('deny');
  });

  it('refuses an unresolved destination audience before supplying the read', () => {
    const input = sharedRead();
    expect(
      evaluateAgentContextReadAccess({
        ...input,
        context: { ...input.context, audience: null },
      }).effect
    ).toBe('deny');
  });

  it('admits an exact established-trigger target without inventing a requester grant', () => {
    const input = triggerRead();
    expect(input.subject.onBehalfOf).toBeNull();
    expect(input.initiatorKernel).toBeNull();
    expect(evaluateAgentContextReadAccess(input).effect).toBe('allow');
  });

  it('refuses a target not named by the established trigger', () => {
    const input = triggerRead();
    expect(
      evaluateAgentContextReadAccess({
        ...input,
        context: {
          ...input.context,
          trigger: { agentId, responsibleHumanId: userId, targets: [otherResource] },
        },
      }).effect
    ).toBe('deny');
  });
});
