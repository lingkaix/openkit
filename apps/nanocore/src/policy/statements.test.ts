import type { PolicyBindingV1, PolicyDocumentV1 } from '@openkit/protocol';
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
  workspaceId,
  capabilityCallId: 'cap_00000000-0000-7000-8000-000000000001',
  resource: {
    kind: 'mcp-tool' as const,
    workspaceId: workspaceId,
    serverId: 'issues',
    toolName: 'read',
  },
  inputReferences: {
    argumentsDigest: `sha256:${'2'.repeat(64)}`,
    catalogRevision: 'catalog-fixture',
    packageSnapshotId: 'package-fixture',
    schemaDigest: null,
  },
  inputAttributes: {},
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
    expect(select({ ...proposal, resource: { ...proposal.resource, toolName: 'write' } })).toEqual(
      []
    );
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

// User consent uses the existing statement owner with one exact User home and deterministic participants only.
describe('exact User Policy statement scope', () => {
  const foreignUserId = 'usr_00000000-0000-7000-8000-000000000002';
  const resource = {
    kind: 'container' as const,
    container: { kind: 'user', id: userId, owner: { kind: 'user' as const, userId } },
  };
  const userScope = { subjects: [principal], actions: ['vault.use'], resources: [resource] };
  const userBinding: PolicyBindingV1 = {
    ...binding,
    id: 'user-consent',
    operation: 'vault.binding-replace',
    scope: userScope,
    inputDisclosure: userScope,
    failure: 'error',
    lifetime: { anchor: resource.container, uses: 1 },
  };
  const userProposal = {
    ...proposal,
    operation: 'vault.binding-replace',
    workspaceId: null,
    resource,
    capabilityCallId: null,
    subject: {
      ...proposal.subject,
      actor: { kind: 'user' as const, id: userId },
      process: null,
      credentialKind: 'local' as const,
    },
  };

  it.each(['gate', 'observe'] as const)(
    'admits and selects an exact deterministic User %s',
    (mode) => {
      const statement: PolicyBindingV1 =
        mode === 'gate'
          ? userBinding
          : {
              ...userBinding,
              mode,
              stage: 'completed',
              failure: 'continue',
              lifetime: { anchor: resource.container },
            };
      const document = validatePolicyDocument({ schemaVersion: 1, statements: [statement] });
      expect(document.statements).toEqual([statement]);
      expect(
        selectPolicyBindings({
          document,
          proposal: userProposal,
          stage: mode === 'gate' ? 'decide' : 'completed',
          now: Date.parse('2026-10-18T01:00:00Z'),
          authorCurrent: (id) => id === userId,
          anchorCurrent: (anchor) => policyDigest(anchor) === policyDigest(resource.container),
        })
      ).toEqual([statement]);
    }
  );

  it('selects the User owner independently of descriptive Workspace process lineage and rechecks current predicates', () => {
    const document = validatePolicyDocument({ schemaVersion: 1, statements: [userBinding] });
    const input = {
      document,
      proposal: { ...userProposal, subject: proposal.subject },
      stage: 'decide' as const,
      now: Date.parse('2026-10-18T01:00:00Z'),
      authorCurrent: () => true,
      anchorCurrent: () => true,
    };
    expect(selectPolicyBindings(input)).toEqual([userBinding]);
    expect(selectPolicyBindings({ ...input, authorCurrent: () => false })).toEqual([]);
    expect(selectPolicyBindings({ ...input, anchorCurrent: () => false })).toEqual([]);
    expect(
      selectPolicyBindings({
        ...input,
        document: {
          schemaVersion: 1,
          statements: [
            {
              ...userBinding,
              lifetime: { ...userBinding.lifetime, notAfter: '2026-10-18T00:30:00Z' },
            },
          ],
        },
      })
    ).toEqual([]);
    expect(
      selectPolicyBindings({
        ...input,
        proposal: {
          ...userProposal,
          resource: {
            kind: 'container',
            container: {
              kind: 'user',
              id: foreignUserId,
              owner: { kind: 'user', userId: foreignUserId },
            },
          },
        },
      })
    ).toEqual([]);
  });

  it.each([
    'mixed-home',
    'foreign-anchor',
    'contradictory-resource',
    'foreign-disclosure',
  ] as const)('refuses %s before User statement activation', (mismatch) => {
    const foreignResource = {
      kind: 'container' as const,
      container: {
        kind: 'user',
        id: foreignUserId,
        owner: { kind: 'user' as const, userId: foreignUserId },
      },
    };
    let candidate = userBinding;
    if (mismatch === 'mixed-home')
      candidate = {
        ...userBinding,
        scope: {
          ...userScope,
          resources: [
            resource,
            {
              kind: 'container',
              container: {
                kind: 'workspace',
                id: workspaceId,
                owner: { kind: 'workspace', workspaceId },
              },
            },
          ],
        },
      };
    if (mismatch === 'foreign-anchor')
      candidate = { ...userBinding, lifetime: { anchor: foreignResource.container } };
    if (mismatch === 'contradictory-resource')
      candidate = {
        ...userBinding,
        scope: {
          ...userScope,
          resources: [{ ...resource, container: { ...resource.container, id: foreignUserId } }],
        },
      };
    if (mismatch === 'foreign-disclosure')
      candidate = {
        ...userBinding,
        inputDisclosure: { ...userScope, resources: [foreignResource] },
      };
    expect(() => validatePolicyDocument({ schemaVersion: 1, statements: [candidate] })).toThrow();
  });

  it('keeps an admitted Workspace agent gate available while refusing User agent activation', () => {
    const declaration = {
      id: 'principal:reviewer',
      kind: 'agent-principal' as const,
      agentId: 'reviewer',
      author: principal,
      authority: binding.authority,
      authoredAt: binding.authoredAt,
      state: 'active' as const,
      creator: principal,
      responsibleHumanId: userId,
      responsibility: principal,
      scope: { ...scope, subjects: [{ kind: 'agent' as const, id: 'reviewer' }] },
      lifetime: {
        anchor: {
          owner: { kind: 'workspace' as const, workspaceId },
          kind: 'workspace',
          id: workspaceId,
        },
      },
    };
    const agentBinding: PolicyBindingV1 = {
      ...binding,
      participant: { kind: 'agent', id: 'reviewer', version: policyDigest(declaration) },
    };
    expect(
      validatePolicyDocument({ schemaVersion: 1, statements: [declaration, agentBinding] })
        .statements
    ).toEqual([declaration, agentBinding]);
    const userAgentScope = { ...userScope, actions: ['tool.use'] };
    expect(() =>
      validatePolicyDocument({
        schemaVersion: 1,
        statements: [
          declaration,
          {
            ...agentBinding,
            scope: userAgentScope,
            inputDisclosure: userAgentScope,
            lifetime: { anchor: resource.container },
          },
        ],
      })
    ).toThrow();
    const userDeclaration = {
      ...declaration,
      scope: { ...userAgentScope, subjects: declaration.scope.subjects },
      lifetime: { anchor: resource.container },
    };
    expect(() =>
      validatePolicyDocument({
        schemaVersion: 1,
        statements: [
          userDeclaration,
          {
            ...agentBinding,
            participant: { ...agentBinding.participant, version: policyDigest(userDeclaration) },
            scope: userAgentScope,
            inputDisclosure: userAgentScope,
            lifetime: { anchor: resource.container },
          },
        ],
      })
    ).toThrow();
  });
});
