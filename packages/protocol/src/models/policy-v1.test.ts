import { describe, expect, it } from 'vitest';
import {
  POLICY_MODE_CONTRACTS_V1,
  PolicyBindingV1Schema,
  PolicyDecisionV1Schema,
  PolicyDocumentV1Schema,
  PolicyGrantV1Schema,
  PolicyLifetimeV1Schema,
} from './policy-v1.js';

const userId = 'usr_00000000-0000-7000-8000-000000000001';
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const turnId = 'tu_00000000-0000-7000-8000-000000000001';
const threadId = 'th_00000000-0000-7000-8000-000000000001';
const digest = `sha256:${'1'.repeat(64)}`;
const principal = { kind: 'human', id: userId };
const anchor = { owner: { kind: 'workspace', workspaceId }, kind: 'turn', id: turnId };
const scope = {
  subjects: [principal],
  actions: ['tool.use'],
  resources: [{ kind: 'mcp-tool', workspaceId, serverId: 'issues', toolName: 'read' }],
};
const binding = {
  kind: 'binding',
  id: 'review-issues',
  author: principal,
  authority: { kind: 'human', userId },
  authoredAt: '2026-10-18T00:00:00Z',
  scope,
  lifetime: { anchor, uses: 1 },
  state: 'active',
  operation: 'mcp.call-tool',
  stage: 'decide',

  mode: 'gate',
  participant: { kind: 'deterministic', id: 'test-review', version: digest },

  inputDisclosure: scope,

  order: 0,
  timeoutMs: 50,
  circuit: { failures: 2, recoveryAfterMs: 100 },
};

describe('retained Policy version-one contracts', () => {
  it('separates scope from lifetime and defaults participant failure to human escalation', () => {
    const document = PolicyDocumentV1Schema.parse({ schemaVersion: 1, statements: [binding] });
    expect(document.statements[0]).toMatchObject({
      failure: 'escalate-to-human',
      lifetime: { uses: 1 },
    });
    expect(
      PolicyLifetimeV1Schema.safeParse({
        anchor: { ...anchor, kind: 'future-container', id: 'owner-selector' },
      }).success
    ).toBe(true);
    expect(PolicyLifetimeV1Schema.safeParse({ anchor, uses: 0 }).success).toBe(false);
    expect(
      PolicyLifetimeV1Schema.safeParse({ anchor: { ...anchor, id: workspaceId } }).success
    ).toBe(false);
  });

  it('refuses wrong points, neutral decisive failure, wrong contracts and duplicate selectors', () => {
    for (const change of [
      { point: 'mcp.call-tool@completed' },
      { failure: 'continue' },
      { outputContract: 'advice-v1' },
      { mode: 'react' },
      { inputDisclosure: { ...scope, subjects: [] } },
    ])
      expect(PolicyBindingV1Schema.safeParse({ ...binding, ...change }).success).toBe(false);
    expect(
      PolicyDocumentV1Schema.safeParse({ schemaVersion: 1, statements: [binding, binding] }).success
    ).toBe(false);
    expect(PolicyDocumentV1Schema.safeParse({ schemaVersion: 2, statements: [] }).success).toBe(
      false
    );
  });

  it('fixes the v1 contracts by mode without retained independent selectors', () => {
    expect(POLICY_MODE_CONTRACTS_V1).toEqual({
      observe: { input: 'mcp-tool-summary-v1', output: 'observation-v1' },
      advise: { input: 'mcp-tool-summary-v1', output: 'advice-v1' },
      gate: { input: 'mcp-tool-summary-v1', output: 'gate-v1' },
    });
    const parsed = PolicyBindingV1Schema.parse(binding);
    expect(parsed).not.toHaveProperty('point');
    expect(parsed).not.toHaveProperty('inputContract');
    expect(parsed).not.toHaveProperty('outputContract');
  });

  it('retains real Kernel evidence separately and forbids gate use consumption', () => {
    const decision = {
      operation: binding.operation,
      stage: binding.stage,

      proposalDigest: digest,
      authorizationRevision: digest,
      subject: {
        principal,
        onBehalfOf: null,
        actor: { kind: 'agent', id: 'worker', responsibleUserId: userId },
        process: { workspaceId, threadId, turnId },
        credentialKind: 'worker-package',
        responsibleHumanId: userId,
      },
      role: 'final',
      kernel: { effect: 'deny', reason: 'prohibited' },
      invocations: [],
      consumedStatements: [],
    };
    expect(PolicyDecisionV1Schema.parse(decision).kernel?.effect).toBe('deny');
    expect(PolicyDecisionV1Schema.safeParse({ ...decision, kernel: null }).success).toBe(true);
    expect(
      PolicyDecisionV1Schema.safeParse({
        ...decision,
        consumedStatements: [{ id: binding.id, digest }],
      }).success
    ).toBe(false);
    expect(PolicyDecisionV1Schema.safeParse({ ...decision, kernel: undefined }).success).toBe(
      false
    );
    expect(
      PolicyDecisionV1Schema.safeParse({
        ...decision,
        role: 'gate',
        binding: { id: binding.id, digest },
        consumedStatements: [{ id: binding.id, digest }],
      }).success
    ).toBe(false);
  });

  it('refuses deferred retained families until their activating behavior lands', () => {
    expect(
      PolicyGrantV1Schema.safeParse({
        kind: 'storage-lease',
        knowledgeBaseId: workspaceId,
        mount: 'work',
        pathPrefix: '',
        mode: 'read-only',
      }).success
    ).toBe(false);
    for (const kind of ['agent-principal', 'delegation'])
      expect(
        PolicyDocumentV1Schema.safeParse({ schemaVersion: 1, statements: [{ ...binding, kind }] })
          .success
      ).toBe(false);
  });
});
