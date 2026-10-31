import { describe, expect, it } from 'vitest';
import * as protocol from '../index.js';
import {
  POLICY_MODE_CONTRACTS_V1,
  PolicyBindingV1Schema,
  PolicyDecisionV1Schema,
  PolicyDelegationV1Schema,
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
  it('retains scope-owned non-grant Thread boundaries and exact Agent-process permissions', () => {
    const owner = { kind: 'workspace', workspaceId };
    const resource = { kind: 'container', container: { owner, kind: 'thread', id: threadId } };
    const envelope = {
      author: principal,
      authority: { kind: 'human', userId },
      authoredAt: binding.authoredAt,
      state: 'active',
      lifetime: { anchor: { owner, kind: 'workspace', id: workspaceId } },
    };
    const boundary = {
      ...envelope,
      kind: 'managed-boundary',
      id: 'managed-thread',
      scope: { subjects: [], actions: [], resources: [resource] },
    };
    const permission = {
      ...envelope,
      kind: 'permission',
      id: 'exact-worker',
      scope: { subjects: [principal], actions: ['thread.read'], resources: [resource] },
      effect: 'allow',
      grant: { kind: 'agent-process', agentId: 'registered-worker' },
    };
    for (const effect of ['allow', 'prohibit']) {
      const statements = [boundary, { ...permission, effect }];
      expect(PolicyDocumentV1Schema.parse({ schemaVersion: 1, statements }).statements).toEqual(
        statements
      );
    }
    for (const change of [{ grant: { kind: 'ordinary' } }, { scope: permission.scope }])
      expect(
        PolicyDocumentV1Schema.safeParse({
          schemaVersion: 1,
          statements: [{ ...boundary, ...change }],
        }).success
      ).toBe(false);
    expect(PolicyGrantV1Schema.safeParse({ kind: 'agent-process', agentId: '' }).success).toBe(
      false
    );
    expect(
      PolicyGrantV1Schema.safeParse({ kind: 'agent-process', agentId: 'registered-worker', userId })
        .success
    ).toBe(false);
  });

  it('retains scope-owned finite Git constraints with sole statement expiry and Agent identity', () => {
    const container = { owner: { kind: 'server' }, kind: 'agent', id: 'registered-worker' };
    const statement = {
      kind: 'permission',
      id: 'finite-git-read',
      author: principal,
      authority: { kind: 'human', userId },
      authoredAt: binding.authoredAt,
      state: 'active',
      scope: {
        subjects: [principal],
        actions: ['administration.configuration.apply'],
        resources: [{ kind: 'container', container }],
      },
      lifetime: { anchor: container, notAfter: '2026-10-20T00:00:00.000Z' },
      effect: 'allow',
      grant: {
        kind: 'worker-git-read-maintenance',
        networkGrantId: 'repository-read',
        host: 'git.example.test',
        port: 443,
        protocol: 'rest',
        repositoryPaths: ['/team/project.git'],
        binaries: ['/usr/bin/git'],
        validFrom: '2026-10-19T00:00:00.000Z',
      },
    };
    expect(
      PolicyDocumentV1Schema.parse({ schemaVersion: 1, statements: [statement] }).statements
    ).toEqual([statement]);
    for (const lifetime of [
      { anchor: container },
      { anchor: container, notAfter: statement.grant.validFrom },
    ])
      expect(
        PolicyDocumentV1Schema.safeParse({
          schemaVersion: 1,
          statements: [{ ...statement, lifetime }],
        }).success
      ).toBe(false);
    for (const extra of [
      { agentId: container.id },
      { responsibleUserId: userId },
      { expiresAt: statement.lifetime.notAfter },
      { enabled: true },
    ])
      expect(PolicyGrantV1Schema.safeParse({ ...statement.grant, ...extra }).success).toBe(false);
  });

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

  it('labels reference-only operation proposals without changing the original I16 mode contracts', () => {
    const exported = protocol as unknown as Record<string, unknown>;
    expect(exported.POLICY_OPERATION_REFERENCE_INPUT_V1).toBe('operation-reference-summary-v1');
    expect(exported.POLICY_MODE_CONTRACTS_V1).toEqual({
      observe: { input: 'mcp-tool-summary-v1', output: 'observation-v1' },
      advise: { input: 'mcp-tool-summary-v1', output: 'advice-v1' },
      gate: { input: 'mcp-tool-summary-v1', output: 'gate-v1' },
    });
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

  it('keeps Tool permission targets in exact MCP resources without a second grant selector', () => {
    const permission = {
      kind: 'permission',
      id: 'read-issues',
      author: principal,
      authority: { kind: 'human', userId },
      authoredAt: binding.authoredAt,
      scope,
      lifetime: { anchor, uses: 1 },
      state: 'inactive',
      grant: { kind: 'ordinary' },
    };
    for (const effect of ['allow', 'prohibit', 'require_approval']) {
      const statement = { ...permission, effect };
      expect(
        PolicyDocumentV1Schema.parse({ schemaVersion: 1, statements: [statement] }).statements
      ).toEqual([statement]);
    }
    expect(PolicyGrantV1Schema.safeParse({ kind: 'ordinary', toolNames: ['read'] }).success).toBe(
      false
    );
    expect(
      PolicyDocumentV1Schema.safeParse({
        schemaVersion: 1,
        statements: [
          {
            ...permission,
            effect: 'require_approval',
            grant: { kind: 'gateway-tool-rule', toolNames: ['read', 'write'] },
          },
        ],
      }).success
    ).toBe(false);
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

  it('retains one typed Goal domain for joint Plan approval without Plan or card fields', () => {
    const statement = {
      id: 'goal-domain',
      kind: 'delegation',
      state: 'inactive',
      author: principal,
      authority: { kind: 'human', userId },
      authoredAt: binding.authoredAt,
      scope,
      lifetime: { anchor: { owner: { kind: 'workspace', workspaceId }, kind: 'goal', id: 'goal' } },
      delegate: { kind: 'agent', id: 'goal-coordinator' },
      purpose: 'goal-domain',
      source: {
        workspaceId,
        goalId: 'goal',
        planVersionId: 'plan',
        planDigest: digest,
        approvalRequestId: 'request',
      },
    };
    expect(
      PolicyDocumentV1Schema.parse({ schemaVersion: 1, statements: [statement] }).statements
    ).toEqual([statement]);
    expect(PolicyDelegationV1Schema.safeParse({ ...statement, source: undefined }).success).toBe(
      false
    );
    expect(
      PolicyDelegationV1Schema.safeParse({ ...statement, purpose: 'participant-envelope' }).success
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
    for (const kind of ['agent-principal'])
      expect(
        PolicyDocumentV1Schema.safeParse({ schemaVersion: 1, statements: [{ ...binding, kind }] })
          .success
      ).toBe(false);
  });

  it('retains storage leases with normalized prefixes and the statement expiry only', () => {
    const grant = {
      kind: 'storage-lease',
      knowledgeBaseId: 'kb_00000000-0000-7000-8000-000000000001',
      mount: 'local',
      pathPrefix: '',
      mode: 'read-only',
    };
    const statement = {
      kind: 'permission',
      id: 'read-originals',
      state: 'inactive',
      author: principal,
      authority: { kind: 'human', userId },
      authoredAt: binding.authoredAt,
      scope: {
        subjects: [principal],
        actions: ['knowledge.read'],
        resources: [{ kind: 'container', container: anchor }],
      },
      lifetime: { anchor, notAfter: '2026-10-19T00:00:00Z' },
      effect: 'allow',
      grant,
    };
    expect(
      PolicyDocumentV1Schema.parse({ schemaVersion: 1, statements: [statement] }).statements
    ).toEqual([statement]);
    expect(
      PolicyGrantV1Schema.parse({ ...grant, pathPrefix: 'docs/chapter', mode: 'staged-write' })
    ).toEqual({ ...grant, pathPrefix: 'docs/chapter', mode: 'staged-write' });
    expect(
      PolicyDocumentV1Schema.safeParse({
        schemaVersion: 1,
        statements: [{ ...statement, lifetime: { anchor } }],
      }).success
    ).toBe(false);
    for (const pathPrefix of ['/docs', '../docs', 'docs//chapter'])
      expect(PolicyGrantV1Schema.safeParse({ ...grant, pathPrefix }).success).toBe(false);
    for (const extra of [{ audience: [principal] }, { expiresAt: statement.lifetime.notAfter }])
      expect(PolicyGrantV1Schema.safeParse({ ...grant, ...extra }).success).toBe(false);
  });
});
