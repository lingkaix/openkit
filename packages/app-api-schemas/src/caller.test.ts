import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as schemas from './index.js';
import * as definitions from './operation-definitions.js';

/** Resolves optional baseline exports through assertions so absence is a contract failure. */
function contracts() {
  const request = Reflect.get(schemas, 'ReadCallerRequestSchema') as z.ZodType;
  const response = Reflect.get(schemas, 'ReadCallerResponseSchema') as z.ZodType;
  const family = Reflect.get(definitions, 'CALLER_OPERATION_DEFINITIONS');
  expect(request, 'The shared caller input schema must exist.').toBeDefined();
  expect(response, 'The shared caller response schema must exist.').toBeDefined();
  expect(
    family?.['caller.read'],
    'The caller read must have one operation definition.'
  ).toBeDefined();
  return { request, response, operation: family['caller.read'] };
}

const caller = {
  userId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
  credential: { kind: 'token', scope: 'server-admin' },
};
const workspace = {
  workspaceId: 'ws_00000000-0000-72e9-8139-d70c8d230fb9',
  ownerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
  membershipStatus: 'removed',
  accessCause: 'administrator',
  observedAt: '2026-10-15T00:00:00.000Z',
  counts: { threads: 3, turns: 4, items: 5, artifacts: 2 },
};

describe('caller read contracts', () => {
  it('declares one non-mutating user-scoped read with strict optional Workspace selection', () => {
    const { request, operation } = contracts();
    expect(operation).toMatchObject({ mutating: false, binding: 'json', successStatus: 200 });
    expect(operation.scope).toEqual({ kind: 'user' });
    expect(request.parse({})).toEqual({});
    expect(request.parse({ workspaceId: 'ws_00000000-0000-72e9-8139-d70c8d230fb9' })).toEqual({
      workspaceId: 'ws_00000000-0000-72e9-8139-d70c8d230fb9',
    });
    expect(
      operation.inputSchema.parse({ workspaceId: 'ws_00000000-0000-72e9-8139-d70c8d230fb9' })
    ).toEqual({
      workspaceId: 'ws_00000000-0000-72e9-8139-d70c8d230fb9',
    });
    for (const invalid of [
      { workspaceId: '' },
      { workspaceId: null },
      { userId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' },
      {
        workspaceId: 'ws_00000000-0000-72e9-8139-d70c8d230fb9',
        ownerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
      },
      { credential: { kind: 'token', scope: 'server-admin' } },
      { workspaceId: ['ws_00000000-0000-72e9-8139-d70c8d230fb9'] },
      {
        workspaceId: 'ws_00000000-0000-72e9-8139-d70c8d230fb9',
        workspaceIds: ['ws_00000000-0000-71f5-922f-6fd42f52f580'],
      },
    ])
      expect(request.safeParse(invalid).success).toBe(false);
  });

  it('accepts caller-only omission and the actual credential and Workspace relationship values', () => {
    const { response } = contracts();
    for (const kind of ['local', 'session']) {
      const value = { userId: caller.userId, credential: { kind, scope: null } };
      expect(response.parse(value)).toEqual(value);
    }
    expect(response.parse(caller)).toEqual(caller);
    for (const membershipStatus of ['active', 'removed', null]) {
      const value = { ...caller, workspace: { ...workspace, membershipStatus } };
      expect(response.parse(value)).toEqual(value);
    }
    const member = {
      userId: caller.userId,
      credential: { kind: 'session', scope: null },
      workspace: { ...workspace, membershipStatus: 'active', accessCause: 'membership' },
    };
    expect(response.parse(member)).toEqual(member);
  });

  it('discards descriptive additions throughout the caller response without forwarding them', () => {
    const { response } = contracts();
    const value = {
      ...caller,
      note: 'future description',
      credential: { ...caller.credential, annotation: 'future credential description' },
      workspace: {
        ...workspace,
        annotation: 'future Workspace description',
        counts: { ...workspace.counts, note: 9 },
      },
    };
    expect(response.parse(value)).toEqual({ ...caller, workspace });
  });

  it('does not forward contact details, credential material or content in descriptive fields', () => {
    const { response } = contracts();
    expect(
      response.parse({
        ...caller,
        email: 'private@example.invalid',
        token: 'fixture-only-secret',
        credential: {
          ...caller.credential,
          value: 'fixture-only-secret',
          location: '/private/credential',
        },
        workspace: {
          ...workspace,
          title: 'Private Workspace content',
          records: ['private record'],
        },
      })
    ).toEqual({ ...caller, workspace });
  });

  it('fails closed on missing core identity, unknown authority values and invalid counts', () => {
    const { response } = contracts();
    for (const value of [
      { credential: caller.credential },
      { ...caller, credential: { kind: 'administrator', scope: null } },
      { ...caller, credential: { kind: 'token', scope: 'unrestricted' } },
      { ...caller, credential: { kind: 'session', scope: 'server-admin' } },
      { ...caller, credential: { kind: 'token', scope: null } },
      { ...caller, credential: { kind: 'local', scope: 'server-admin' } },
      { ...caller, workspace: null },
      { ...caller, workspace: { ...workspace, workspaceId: '' } },
      { ...caller, workspace: { ...workspace, ownerUserId: undefined } },
      {
        ...caller,
        workspace: { ...workspace, ownerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' },
      },
      { ...caller, workspace: { ...workspace, membershipStatus: 'owner' } },
      { ...caller, workspace: { ...workspace, accessCause: 'filesystem' } },
      { ...caller, workspace: { ...workspace, accessCause: 'membership' } },
      { ...caller, workspace: { ...workspace, membershipStatus: undefined } },
      { ...caller, workspace: { ...workspace, observedAt: 'not-a-time' } },
      { ...caller, workspace: { ...workspace, observedAt: undefined } },
      { ...caller, workspace: { ...workspace, counts: { ...workspace.counts, threads: -1 } } },
      { ...caller, workspace: { ...workspace, counts: { ...workspace.counts, items: 1.5 } } },
      { ...caller, workspace: { ...workspace, counts: { ...workspace.counts, artifacts: null } } },
      {
        ...caller,
        workspace: {
          ...workspace,
          counts: { ...workspace.counts, turns: Number.POSITIVE_INFINITY },
        },
      },
      { ...caller, workspace: { ...workspace, counts: { threads: 0 } } },
    ])
      expect(response.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

/** Caller identity is a Core User reference, not an opaque account selector. */
describe('caller canonical User boundary', () => {
  it.each([
    'user_legacy',
    'ws_00000000-0000-7000-8000-000000000001',
    'usr_00000000-0000-5000-8000-000000000001',
    'usr_00000000-0000-7000-8000-000000000001\n',
  ])('refuses a noncanonical or wrong-kind User reference: %s', (userId) => {
    const { response } = contracts();
    expect(response.safeParse({ ...caller, userId }).success).toBe(false);
  });
});
