import type { PolicyDocumentV1 } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  policyDigest,
  preparePolicyDocument,
  selectPolicyBindings,
  validatePolicyDocument,
} from './statements.js';

const userId = 'usr_00000000-0000-7000-8000-000000000001';
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const threadId = 'th_00000000-0000-7000-8000-000000000001';
const turnId = 'tu_00000000-0000-7000-8000-000000000001';
const principal = { kind: 'human' as const, id: userId };
const scope = {
  subjects: [principal],
  actions: ['tool.use'],
  resources: [{ kind: 'mcp-tool' as const, workspaceId, serverId: 'issues', toolName: 'read' }],
};
const binding = {
  kind: 'binding' as const,
  id: 'review',
  author: principal,
  authority: { kind: 'human' as const, userId },
  authoredAt: '2026-10-18T00:00:00Z',
  scope,
  lifetime: {
    anchor: { owner: { kind: 'workspace' as const, workspaceId }, kind: 'turn', id: turnId },
    uses: 1,
  },
  state: 'active' as const,
  operation: 'mcp.call-tool',
  stage: 'decide' as const,
  point: 'mcp.call-tool@decide',
  mode: 'gate' as const,
  participant: { kind: 'deterministic' as const, id: 'test', version: `sha256:${'1'.repeat(64)}` },
  inputContract: 'mcp-tool-summary-v1' as const,
  inputDisclosure: scope,
  outputContract: 'gate-v1' as const,
  order: 0,
  timeoutMs: 100,
  failure: 'escalate-to-human' as const,
  circuit: { failures: 2, recoveryAfterMs: 100 },
};
const document: PolicyDocumentV1 = { schemaVersion: 1, statements: [binding] };
const proposal = {
  operation: 'mcp.call-tool' as const,
  catalogRevision: 'catalog-fixture',
  packageDigest: 'package-fixture',
  workspaceId,
  serverId: 'issues',
  toolName: 'read',
  argumentsDigest: `sha256:${'2'.repeat(64)}`,
  schemaDigest: null,
  capabilityCallId: 'cap_00000000-0000-7000-8000-000000000001',
  subject: {
    principal,
    onBehalfOf: null,
    actor: { kind: 'agent' as const, id: 'worker', responsibleUserId: userId },
    process: { workspaceId, threadId, turnId },
    credentialKind: 'worker-package' as const,
    responsibleHumanId: userId,
  },
};

describe('native Policy statement owner', () => {
  it('recognizes an author reducing or withdrawing passive observation disclosure', () => {
    const secondPrincipal = {
      kind: 'human' as const,
      id: 'usr_00000000-0000-7000-8000-000000000002',
    };
    const widerScope = { ...scope, subjects: [principal, secondPrincipal] };
    const observer = {
      ...binding,
      mode: 'observe' as const,
      stage: 'completed' as const,
      point: 'mcp.call-tool@completed',
      outputContract: 'observation-v1' as const,
      scope: widerScope,
      inputDisclosure: widerScope,
      lifetime: { anchor: binding.lifetime.anchor, notAfter: '2026-12-31T00:00:00Z' },
    };
    const current: PolicyDocumentV1 = { schemaVersion: 1, statements: [observer] };
    const reduced = preparePolicyDocument({
      current,
      proposed: {
        schemaVersion: 1,
        statements: [
          {
            ...observer,
            scope,
            inputDisclosure: scope,
            lifetime: { ...observer.lifetime, notAfter: '2026-11-30T00:00:00Z' },
          },
        ],
      },
      userId,
      now: '2026-10-18T01:00:00Z',
    });
    expect(reduced.classification).toBe('narrowing');
    expect(reduced.document.statements[0]?.lifetime.notAfter).toBe('2026-11-30T00:00:00Z');
    expect(
      preparePolicyDocument({
        current,
        proposed: { schemaVersion: 1, statements: [] },
        userId,
        now: '2026-10-18T01:00:00Z',
      }).classification
    ).toBe('narrowing');
  });

  it('keeps constraint withdrawal and changes to disclosure authority under widening review', () => {
    const observer = {
      ...binding,
      mode: 'observe' as const,
      stage: 'completed' as const,
      point: 'mcp.call-tool@completed',
      outputContract: 'observation-v1' as const,
      lifetime: { anchor: binding.lifetime.anchor, notAfter: '2026-12-31T00:00:00Z' },
    };
    const prepare = (current: PolicyDocumentV1, statements: unknown[], author = userId) =>
      preparePolicyDocument({
        current,
        proposed: { schemaVersion: 1, statements },
        userId: author,
        now: '2026-10-18T01:00:00Z',
      }).classification;
    expect(prepare(document, [])).toBe('widening');
    const observed: PolicyDocumentV1 = { schemaVersion: 1, statements: [observer] };
    expect(
      prepare(observed, [{ ...observer, lifetime: { anchor: observer.lifetime.anchor } }])
    ).toBe('widening');
    expect(
      prepare(observed, [
        {
          ...observer,
          participant: { ...observer.participant, version: `sha256:${'2'.repeat(64)}` },
        },
      ])
    ).toBe('widening');
    expect(prepare(observed, [], 'usr_00000000-0000-7000-8000-000000000002')).toBe('widening');
  });

  it('pins content independently of object key order and preserves unrelated statement versions', () => {
    expect(policyDigest({ b: 1, a: 2 })).toBe(policyDigest({ a: 2, b: 1 }));
    const original = policyDigest(binding);
    const prepared = preparePolicyDocument({
      current: document,
      proposed: {
        schemaVersion: 1,
        statements: [
          binding,
          {
            ...binding,
            id: 'future-binding',
            state: 'inactive',
            order: 1,
            author: { kind: 'human', id: 'usr_00000000-0000-7000-8000-000000000002' },
          },
        ],
      },
      userId,
      now: '2026-10-18T01:00:00Z',
    });
    expect(policyDigest(prepared.document.statements[0])).toBe(original);
    expect(policyDigest(prepared.document)).not.toBe(policyDigest(document));
    expect(prepared.document.statements[1]?.author).toEqual(principal);
    expect(prepared.diff).toEqual({ added: ['future-binding'], changed: [], removed: [] });
    expect(prepared.classification).toBe('widening');
  });

  it('retains an inactive delegation reference through the native candidate writer and checks its exact envelope', () => {
    const envelope = {
      id: 'domain',
      kind: 'delegation' as const,
      state: 'inactive' as const,
      author: principal,
      authority: { kind: 'human' as const, userId },
      authoredAt: binding.authoredAt,
      scope,
      lifetime: binding.lifetime,
      delegate: principal,
      purpose: 'participant-envelope' as const,
    };
    const current = preparePolicyDocument({
      current: { schemaVersion: 1, statements: [] },
      proposed: { schemaVersion: 1, statements: [envelope] },
      userId,
      now: binding.authoredAt,
    }).document;
    const authority = {
      kind: 'delegation' as const,
      statement: { id: 'domain', digest: policyDigest(current.statements[0]) },
    };
    const prepared = preparePolicyDocument({
      current,
      proposed: {
        schemaVersion: 1,
        statements: [
          ...current.statements,
          { ...binding, id: 'proposed-review', state: 'inactive', authority },
        ],
      },
      userId,
      now: '2026-10-18T01:00:00Z',
    });
    expect(prepared.document.statements[1]?.authority).toEqual(authority);
    expect(() =>
      validatePolicyDocument({
        schemaVersion: 1,
        statements: [
          current.statements[0],
          {
            ...binding,
            state: 'inactive',
            authority: {
              ...authority,
              statement: { ...authority.statement, digest: policyDigest('wrong') },
            },
          },
        ],
      })
    ).toThrow(/exact enclosing statement/);
  });

  it('uses exact current subject, target, process, expiry and author facts for selection', () => {
    const select = (currentProposal = proposal, authorCurrent = true, currentDocument = document) =>
      selectPolicyBindings({
        document: currentDocument,
        proposal: currentProposal,
        now: Date.parse('2026-10-18T01:00:00Z'),
        authorCurrent: () => authorCurrent,
        anchorCurrent: () => true,
      });
    expect(select()).toHaveLength(1);
    expect(select({ ...proposal, toolName: 'write' })).toEqual([]);
    expect(select(proposal, false)).toEqual([]);
    expect(
      select({
        ...proposal,
        subject: {
          ...proposal.subject,
          process: { workspaceId, threadId, turnId: 'tu_00000000-0000-7000-8000-000000000002' },
        },
      })
    ).toEqual([]);
    expect(
      select(proposal, true, {
        schemaVersion: 1,
        statements: [
          { ...binding, lifetime: { ...binding.lifetime, notAfter: '2026-10-18T00:30:00Z' } },
        ],
      })
    ).toEqual([]);
  });

  it('refuses unsupported activation and disclosure widening rather than treating it as a grant', () => {
    expect(() =>
      validatePolicyDocument({
        schemaVersion: 1,
        statements: [{ ...binding, inputDisclosure: { ...scope, actions: ['vault.use'] } }],
      })
    ).toThrow(/disclosure/);
    expect(() =>
      validatePolicyDocument({
        schemaVersion: 1,
        statements: [
          { ...binding, scope: { ...scope, subjects: [{ kind: 'agent', id: 'worker' }] } },
        ],
      })
    ).toThrow(/Agent principal/);
    expect(() =>
      validatePolicyDocument({
        schemaVersion: 1,
        statements: [
          {
            ...binding,
            lifetime: {
              ...binding.lifetime,
              anchor: { owner: { kind: 'server' }, kind: 'server', id: 'server' },
            },
          },
        ],
      })
    ).toThrow(/Workspace transaction/);
  });

  it('rejects cycles in inactive agent declarations without activating any agent authority', () => {
    const base = { ...binding, kind: 'agent-principal', state: 'inactive' };
    const principalStatement = (id: string, responsible: string) => ({
      id,
      kind: base.kind,
      state: base.state,
      author: base.author,
      authority: base.authority,
      authoredAt: base.authoredAt,
      scope: base.scope,
      lifetime: base.lifetime,
      principal: { kind: 'agent', id },
      creator: principal,
      responsiblePrincipal: { kind: 'agent', id: responsible },
    });
    expect(() =>
      validatePolicyDocument({
        schemaVersion: 1,
        statements: [principalStatement('a', 'b'), principalStatement('b', 'a')],
      })
    ).toThrow(/acyclic/);
  });
});
