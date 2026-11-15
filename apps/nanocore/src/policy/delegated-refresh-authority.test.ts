import type { PolicyDocumentV1 } from '@openkit/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const kernel = vi.hoisted(() => ({
  rights: new Map<string, 'allow' | 'deny' | 'throw'>(),
  authors: new Set<string>(),
}));

vi.mock('../runtime/worker-credential-authority.js', () => ({
  readVaultRequesterAuthority: (
    _coreDb: unknown,
    workspaceId: string,
    _requester: unknown,
    operation: string
  ) => {
    const effect = kernel.rights.get(operation) ?? 'deny';
    if (effect !== 'allow') throw new Error('Current credential binding authority is unavailable.');
    return {
      decision: { effect, reasons: [] },
      facts: {
        workspaceId,
        operation,
        responsibleUserId: 'usr_00000000-0000-7000-8000-0000000000a2',
      },
    };
  },
}));
vi.mock('../auth/operation-authorizer.js', () => ({
  currentWorkspaceAuthority: (
    _coreDb: unknown,
    _workspaceId: string,
    actor: { id: string },
    operation: string
  ) => (operation === 'vault.delegate-refresh' && kernel.authors.has(actor.id) ? {} : null),
}));

const { readDelegatedRefreshAuthority } = await import('./delegated-refresh-authority.js');
const { isExactDelegatedRefreshAllowance, validatePolicyDocument } = await import(
  './statements.js'
);

const workspaceId = 'ws_00000000-0000-7000-8000-0000000000d1';
const owner = { kind: 'workspace' as const, workspaceId };
const allowance = {
  id: 'delegated-refresh-allow',
  kind: 'permission' as const,
  author: { kind: 'human' as const, id: 'usr_00000000-0000-7000-8000-0000000000a1' },
  authority: { kind: 'human' as const, userId: 'usr_00000000-0000-7000-8000-0000000000a1' },
  authoredAt: '2026-11-15T00:00:00.000Z',
  state: 'active' as const,
  lifetime: { anchor: { owner, kind: 'workspace' as const, id: workspaceId } },
  scope: {
    subjects: [{ kind: 'human' as const, id: 'usr_00000000-0000-7000-8000-0000000000a2' }],
    actions: ['vault.delegate-refresh'],
    resources: [
      {
        kind: 'container' as const,
        container: { owner, kind: 'workspace' as const, id: workspaceId },
      },
    ],
  },
  effect: 'allow' as const,
  grant: { kind: 'ordinary' as const },
};
const document = (statements: unknown[]) =>
  ({ schemaVersion: 1, statements }) as unknown as PolicyDocumentV1;
const read = (statements: unknown[], now?: Date) =>
  readDelegatedRefreshAuthority({
    coreDb: {} as never,
    workspaceId,
    requester: {
      kind: 'public',
      actor: {
        kind: 'session',
        userId: 'usr_00000000-0000-7000-8000-0000000000a2',
        sessionId: 'session',
      },
      actorRef: { kind: 'user', id: 'usr_00000000-0000-7000-8000-0000000000a2' },
    },
    document: document(statements),
    ...(now ? { now } : {}),
  });

beforeEach(() => {
  kernel.rights = new Map([['vault.use', 'allow']]);
  kernel.authors = new Set(['usr_00000000-0000-7000-8000-0000000000a1']);
});

describe('vault.delegate-refresh authority', () => {
  it('accepts the Kernel right without an authored statement', () => {
    kernel.rights.set('vault.delegate-refresh', 'allow');
    expect(read([])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('denies by default when no exact authored allowance names the responsible human', () => {
    expect(read([])).toBeUndefined();
    expect(
      read([
        {
          ...allowance,
          scope: {
            ...allowance.scope,
            subjects: [{ kind: 'human', id: 'usr_00000000-0000-7000-8000-0000000000a3' }],
          },
        },
      ])
    ).toBeUndefined();
  });

  it('accepts one exact allowance from an author who still holds the right', () => {
    const first = read([allowance]);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Any change to the deciding statement changes the rechecked revision.
    expect(read([{ ...allowance, authoredAt: '2026-11-15T00:00:01.000Z' }])).not.toBe(first);
  });

  it('refuses when vault.use, author authority or the statement lifetime is not current', () => {
    kernel.rights.set('vault.use', 'deny');
    expect(read([allowance])).toBeUndefined();
    kernel.rights.set('vault.use', 'allow');
    kernel.authors.clear();
    expect(read([allowance])).toBeUndefined();
    kernel.authors.add('usr_00000000-0000-7000-8000-0000000000a1');
    const lifetime = { ...allowance.lifetime, notAfter: '2026-11-15T01:00:00.000Z' };
    expect(read([{ ...allowance, lifetime }], new Date('2026-11-15T00:30:00.000Z'))).toBeDefined();
    expect(
      read([{ ...allowance, lifetime }], new Date('2026-11-15T01:00:00.000Z'))
    ).toBeUndefined();
  });

  it.each([
    ['inactive', { state: 'inactive' }],
    ['prohibit', { effect: 'prohibit' }],
    ['agent author', { author: { kind: 'agent', id: 'agent' } }],
    [
      'mismatched authority',
      { authority: { kind: 'human', userId: 'usr_00000000-0000-7000-8000-0000000000a3' } },
    ],
    [
      'extra action',
      { scope: { ...allowance.scope, actions: ['vault.delegate-refresh', 'vault.use'] } },
    ],
    ['other action', { scope: { ...allowance.scope, actions: ['vault.use'] } }],
    [
      'agent subject',
      { scope: { ...allowance.scope, subjects: [{ kind: 'agent', id: 'agent' }] } },
    ],
    ['finite uses', { lifetime: { ...allowance.lifetime, uses: 1 } }],
    [
      'other Workspace resource',
      {
        scope: {
          ...allowance.scope,
          resources: [
            {
              kind: 'container',
              container: {
                owner: {
                  kind: 'workspace',
                  workspaceId: 'ws_00000000-0000-7000-8000-0000000000d2',
                },
                kind: 'workspace',
                id: 'ws_00000000-0000-7000-8000-0000000000d2',
              },
            },
          ],
        },
      },
    ],
  ])('ignores a %s statement', (_name, change) => {
    const statement = { ...allowance, ...change };
    expect(isExactDelegatedRefreshAllowance(statement as never, workspaceId)).toBe(false);
    expect(read([statement])).toBeUndefined();
  });
});

describe('human delegated-refresh allowance admission', () => {
  it('keeps every other human allow on the existing Tool-condition refusal', () => {
    expect(() =>
      validatePolicyDocument(
        document([{ ...allowance, scope: { ...allowance.scope, actions: ['workspace.read'] } }])
      )
    ).toThrow('Human Tool conditions require exact Workspace Tool scope without finite uses.');
  });

  it('admits the exact Workspace allowance', () => {
    expect(validatePolicyDocument(document([allowance])).statements).toHaveLength(1);
  });

  it.each([
    [
      'extra action',
      { scope: { ...allowance.scope, actions: ['vault.delegate-refresh', 'vault.use'] } },
    ],
    ['finite uses', { lifetime: { ...allowance.lifetime, uses: 1 } }],
    [
      'agent subject',
      { scope: { ...allowance.scope, subjects: [{ kind: 'agent', id: 'agent' }] } },
    ],
    [
      'Tool resource',
      {
        scope: {
          ...allowance.scope,
          resources: [{ kind: 'mcp-tool', workspaceId, serverId: 'server', toolName: 'tool' }],
        },
      },
    ],
  ])('refuses a human allow with %s', (_name, change) => {
    expect(() => validatePolicyDocument(document([{ ...allowance, ...change }]))).toThrow(
      'Human delegated-refresh allowance requires one exact Workspace scope.'
    );
  });
});
