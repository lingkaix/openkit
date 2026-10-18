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

  mode: 'gate' as const,
  participant: { kind: 'deterministic' as const, id: 'test', version: `sha256:${'1'.repeat(64)}` },

  inputDisclosure: scope,

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

  it('refuses active advice and transform without a safe participant-output owner', () => {
    for (const mode of ['advise', 'transform'] as const) {
      for (const state of ['active', 'shadow'] as const)
        expect(() =>
          validatePolicyDocument({
            schemaVersion: 1,
            statements: [{ ...binding, mode, state, stage: 'propose' }],
          })
        ).toThrow(/safe participant output reference/);
    }
  });
});
