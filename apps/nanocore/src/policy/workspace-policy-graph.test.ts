import { allocateEntityId, PolicySubjectV1Schema } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { validatePolicyDocument } from './statements.js';
import { evaluatePolicyKernel } from './workspace-access.js';

const userId = 'usr_00000000-0000-7000-8000-000000000001';
const authorId = 'usr_00000000-0000-7000-8000-000000000002';
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const process = {
  workspaceId,
  threadId: 'th_00000000-0000-7000-8000-000000000001',
  turnId: 'tu_00000000-0000-7000-8000-000000000001',
};
const subject = PolicySubjectV1Schema.parse({
  principal: { kind: 'human', id: userId },
  onBehalfOf: null,
  actor: { kind: 'user', id: userId },
  process,
  credentialKind: 'session',
  responsibleHumanId: userId,
});
const workspace = { owner: { kind: 'workspace', workspaceId }, kind: 'workspace', id: workspaceId };
const prohibition = {
  id: 'process-restriction',
  kind: 'permission',
  state: 'active',
  author: { kind: 'human', id: authorId },
  authority: { kind: 'human', userId: authorId },
  authoredAt: '2026-11-14T00:00:00Z',
  effect: 'prohibit',
  grant: { kind: 'ordinary' },
  scope: {
    subjects: [{ kind: 'process', ...process }],
    actions: ['tool.use'],
    resources: [{ kind: 'container', container: workspace }],
  },
  lifetime: { anchor: workspace },
};

function request(statement?: unknown) {
  return {
    facts: {
      userId,
      activeUser: true,
      administrator: false,
      credential: {
        current: true,
        workspaceBound: true,
        readOnly: false,
        kind: 'session' as const,
      },
    },
    target: {
      kind: 'workspace' as const,
      workspaceId,
      active: true,
      membership: 'member' as const,
    },
    operation: 'tool.use',
    mutating: false,
    policy: {
      subject,
      document: validatePolicyDocument({
        schemaVersion: 1,
        statements: statement ? [statement] : [],
      }),
      now: Date.parse('2026-11-14T12:00:00Z'),
      authorCurrent: vi.fn(() => true),
      anchorCurrent: vi.fn(() => true),
    },
  };
}

describe('shared primary graph restriction composition', () => {
  it('applies exact native Tool restrictions inside the original Workspace graph', () => {
    const resource = {
      kind: 'mcp-tool' as const,
      workspaceId,
      serverId: 'fixture',
      toolName: 'read',
    };
    const current = request({
      ...prohibition,
      id: 'exact-tool-restriction',
      scope: {
        subjects: [subject.principal],
        actions: ['tool.use'],
        resources: [resource],
      },
      lifetime: { anchor: workspace },
    });
    expect(evaluatePolicyKernel(current).effect).toBe('allow');
    const exact = { ...current, policy: { ...current.policy, resource } };
    expect(evaluatePolicyKernel(exact).reasons).toContainEqual({
      code: 'restriction',
      prohibitionId: 'exact-tool-restriction',
    });
    const sibling = {
      ...current,
      policy: { ...current.policy, resource: { ...resource, toolName: 'other' } },
    };
    expect(evaluatePolicyKernel(sibling).effect).toBe('allow');
    expect(
      evaluatePolicyKernel({
        ...sibling,
        facts: { ...sibling.facts, credential: { ...sibling.facts.credential, current: false } },
      }).effect
    ).toBe('deny');
    const inherited = request(prohibition);
    expect(
      evaluatePolicyKernel({ ...inherited, policy: { ...inherited.policy, resource } }).effect
    ).toBe('deny');
  });

  it('keeps ordinary author, anchor, state and expiry termination separate from quarantine', () => {
    expect(evaluatePolicyKernel(request()).effect).toBe('allow');
    const current = request(prohibition);
    expect(evaluatePolicyKernel(current).reasons).toContainEqual({
      code: 'restriction',
      prohibitionId: prohibition.id,
    });
    for (const policy of [
      { ...current.policy, authorCurrent: () => false },
      { ...current.policy, anchorCurrent: () => false },
    ])
      expect(evaluatePolicyKernel({ ...current, policy }).effect).toBe('allow');
    expect(
      evaluatePolicyKernel(
        request({
          ...prohibition,
          lifetime: { ...prohibition.lifetime, notAfter: '2026-11-14T12:00:00Z' },
        })
      ).effect
    ).toBe('allow');
    expect(evaluatePolicyKernel(request({ ...prohibition, state: 'inactive' })).effect).toBe(
      'allow'
    );
  });

  it('does not read revocable author or anchor facts for a committed quarantine', () => {
    const current = request({
      ...prohibition,
      lifetime: {
        anchor: { owner: { kind: 'server' }, kind: 'quarantine', id: allocateEntityId('aud') },
      },
    });
    current.policy.authorCurrent.mockImplementation(() => {
      throw new Error('The original author is no longer available.');
    });
    current.policy.anchorCurrent.mockImplementation(() => {
      throw new Error('The source run is closed.');
    });
    expect(evaluatePolicyKernel(current).effect).toBe('deny');
    current.policy.now = Date.parse('2030-01-01T00:00:00Z');
    expect(evaluatePolicyKernel(current).effect).toBe('deny');
    expect(current.policy.authorCurrent).not.toHaveBeenCalled();
    expect(current.policy.anchorCurrent).not.toHaveBeenCalled();
    for (const sibling of [
      null,
      { ...process, workspaceId: allocateEntityId('ws') },
      { ...process, threadId: allocateEntityId('th') },
      { ...process, turnId: allocateEntityId('tu') },
    ])
      expect(
        evaluatePolicyKernel({
          ...current,
          policy: { ...current.policy, subject: { ...subject, process: sibling } },
        }).effect
      ).toBe('allow');
  });

  it('does not turn one human membership into another principal grant', () => {
    const current = request();
    expect(evaluatePolicyKernel(current).effect).toBe('allow');
    for (const principal of [
      { kind: 'human' as const, id: authorId },
      { kind: 'agent' as const, id: 'fixture-agent' },
    ]) {
      const decision = evaluatePolicyKernel({
        ...current,
        policy: { ...current.policy, subject: { ...subject, principal } },
      });
      expect(decision.effect).toBe('deny');
      expect(decision.reasons).toContainEqual(
        expect.objectContaining({ code: 'missing-privilege' })
      );
      expect(decision.reasons).not.toContainEqual(
        expect.objectContaining({ code: 'invalid-policy' })
      );
    }
  });
});
