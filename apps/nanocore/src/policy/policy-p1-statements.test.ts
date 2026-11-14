import {
  allocateEntityId,
  PolicyDocumentV1Schema,
  PolicyPrincipalV1Schema,
  PolicyScopeV1Schema,
  PolicySubjectV1Schema,
} from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { validatePolicyDocument } from './statements.js';
import { evaluatePolicyKernel } from './workspace-access.js';

const userId = 'usr_00000000-0000-7000-8000-000000000001';
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const threadId = 'th_00000000-0000-7000-8000-000000000001';
const turnId = 'tu_00000000-0000-7000-8000-000000000001';
const human = { kind: 'human' as const, id: userId };
const process = { kind: 'process' as const, workspaceId, threadId, turnId };
const scope = {
  subjects: [process],
  actions: ['tool.use'],
  resources: [{ kind: 'mcp-tool' as const, workspaceId, serverId: 'issues', toolName: 'read' }],
};
const fields = {
  id: 'p1-process-restriction',
  author: human,
  authority: { kind: 'human' as const, userId },
  authoredAt: '2026-11-14T00:00:00Z',
  state: 'active' as const,
  scope,
  lifetime: {
    anchor: {
      owner: { kind: 'workspace' as const, workspaceId },
      kind: 'workspace',
      id: workspaceId,
    },
  },
};
const permission = {
  ...fields,
  kind: 'permission',
  effect: 'prohibit',
  grant: { kind: 'ordinary' },
};
const document = (statement: unknown) => ({ schemaVersion: 1, statements: [statement] });
const delegation = {
  ...fields,
  kind: 'delegation',
  state: 'inactive',
  delegate: { kind: 'agent', id: 'policy-reviewer' },
  purpose: 'goal-domain',
  source: {
    workspaceId,
    goalId: 'p1-goal',
    planVersionId: 'p1-plan',
    planDigest: `sha256:${'1'.repeat(64)}`,
    approvalRequestId: 'p1-approval',
  },
};
const binding = {
  ...fields,
  kind: 'binding',
  state: 'inactive',
  operation: 'mcp.call-tool',
  stage: 'decide',
  mode: 'gate',
  participant: { kind: 'agent', id: 'policy-reviewer', version: `sha256:${'1'.repeat(64)}` },
  inputDisclosure: { ...scope, subjects: [human] },
  order: 0,
  timeoutMs: 2_000,
  failure: 'escalate-to-human',
  circuit: { failures: 1, recoveryAfterMs: 60_000 },
};

// P1 extends selectors, never accountable principals or positive authority.
describe('P1 process selectors through the public Policy statement owner', () => {
  it('admits an exact process selector and its ordinary prohibit statement', () => {
    expect(PolicyScopeV1Schema.safeParse(scope).success).toBe(true);
    expect(validatePolicyDocument(document(permission)).statements[0]).toMatchObject({
      effect: 'prohibit',
      scope: { subjects: [process] },
    });
  });

  it.each([
    ['allow', { ...permission, effect: 'allow' }],
    ['require_approval', { ...permission, effect: 'require_approval' }],
    ['inactive allow', { ...permission, state: 'inactive', effect: 'allow' }],
    ['binding', binding],
    ['delegation', delegation],
    [
      'agent-principal',
      {
        ...fields,
        kind: 'agent-principal',
        state: 'inactive',
        agentId: 'policy-reviewer',
        creator: human,
        responsibleHumanId: userId,
        responsibility: human,
      },
    ],
  ])('does not admit a process selector on %s', (_name, statement) => {
    // This positive control prevents an unknown-selector parser from masquerading as the restriction.
    expect(() => validatePolicyDocument(document(permission))).not.toThrow();
    expect(() => validatePolicyDocument(document(statement))).toThrow();
  });

  it('does not make a process an accountable principal, statement author or delegation recipient', () => {
    expect(PolicyPrincipalV1Schema.safeParse(human).success).toBe(true);
    expect(
      PolicyPrincipalV1Schema.safeParse({ kind: 'agent', id: 'policy-reviewer' }).success
    ).toBe(true);
    expect(PolicyPrincipalV1Schema.safeParse(process).success).toBe(false);
    const humanScope = { ...scope, subjects: [human] };
    const inactive = { ...permission, state: 'inactive', scope: humanScope };
    expect(PolicyDocumentV1Schema.safeParse(document(inactive)).success).toBe(true);
    expect(
      PolicyDocumentV1Schema.safeParse(document({ ...inactive, author: process })).success
    ).toBe(false);
    const ordinaryDelegation = { ...delegation, scope: humanScope };
    expect(PolicyDocumentV1Schema.safeParse(document(ordinaryDelegation)).success).toBe(true);
    expect(
      PolicyDocumentV1Schema.safeParse(document({ ...ordinaryDelegation, delegate: process }))
        .success
    ).toBe(false);
  });
});

// The review deadline belongs to the consumer journal, not an expiring prohibition.
describe('P1 quarantine lifetime through the public Policy statement owner', () => {
  it('keeps exact process quarantine after author disablement and anchor closure without denying a sibling', () => {
    const authorId = 'usr_00000000-0000-7000-8000-000000000002';
    const admitted = validatePolicyDocument(
      document({
        ...permission,
        author: { kind: 'human', id: authorId },
        authority: { kind: 'human', userId: authorId },
        scope: {
          ...scope,
          resources: [
            {
              kind: 'container',
              container: {
                owner: { kind: 'workspace', workspaceId },
                kind: 'workspace',
                id: workspaceId,
              },
            },
          ],
        },
        lifetime: {
          anchor: { owner: { kind: 'server' }, kind: 'quarantine', id: allocateEntityId('aud') },
        },
      })
    );
    const subject = PolicySubjectV1Schema.parse({
      principal: human,
      onBehalfOf: null,
      actor: { kind: 'user', id: userId },
      process: { workspaceId, threadId, turnId },
      credentialKind: 'session',
      responsibleHumanId: userId,
    });
    const request = {
      facts: {
        userId,
        activeUser: true,
        administrator: false,
        credential: {
          kind: 'session' as const,
          current: true,
          workspaceBound: true,
          readOnly: false,
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
        document: admitted,
        subject,
        now: Date.parse('2026-11-14T12:00:00Z'),
        authorCurrent: (_id: string) => false,
        anchorCurrent: () => false,
      },
    };
    const unrestricted = {
      ...request,
      policy: {
        ...request.policy,
        document: validatePolicyDocument({ schemaVersion: 1, statements: [] }),
      },
    };
    expect(evaluatePolicyKernel(unrestricted).effect).toBe('allow');
    expect(evaluatePolicyKernel(request).effect).toBe('deny');
    const currentAuthor = {
      ...request,
      policy: { ...request.policy, authorCurrent: () => true, anchorCurrent: () => true },
    };
    expect(evaluatePolicyKernel(currentAuthor).effect).toBe('deny');
    const sibling = {
      ...request,
      policy: {
        ...request.policy,
        subject: { ...subject, process: { workspaceId, threadId, turnId: allocateEntityId('tu') } },
      },
    };
    expect(evaluatePolicyKernel(sibling).effect).toBe('allow');
  });
  it('admits a durable quarantine prohibition anchored to the original sensor Audit identity', () => {
    const quarantine = {
      ...permission,
      lifetime: {
        anchor: { owner: { kind: 'server' }, kind: 'quarantine', id: allocateEntityId('aud') },
      },
    };
    expect(validatePolicyDocument(document(quarantine)).statements[0]).toMatchObject({
      state: 'active',
      effect: 'prohibit',
      lifetime: { anchor: quarantine.lifetime.anchor },
    });
  });

  it.each([
    ['notAfter', { notAfter: '2026-11-15T00:00:00Z' }],
    ['uses', { uses: 1 }],
  ])('refuses quarantine with %s rather than allowing automatic release', (_name, expiry) => {
    const anchor = { owner: { kind: 'server' }, kind: 'quarantine', id: allocateEntityId('aud') };
    expect(() =>
      validatePolicyDocument(document({ ...permission, lifetime: { anchor } }))
    ).not.toThrow();
    expect(() =>
      validatePolicyDocument(document({ ...permission, lifetime: { anchor, ...expiry } }))
    ).toThrow();
  });
});
