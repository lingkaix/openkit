import { describe, expect, it } from 'vitest';
import { allocateEntityId, deriveEntityId } from '../common/entity-id.js';
import {
  InterceptionBindingSchema,
  InterceptionInvocationSchema,
  InterceptionStatementSchema,
} from './interception.js';

const user = { kind: 'user' as const, id: allocateEntityId('usr') };
const owner = {
  kind: 'workspace' as const,
  workspaceId: deriveEntityId('ws', 'interception-scope'),
};
const reference = {
  kind: 'record' as const,
  owner,
  family: 'mcp-rule',
  id: 'school/update',
  version: 'sha256:rules',
};
const statement = {
  schemaVersion: 1,
  id: 'school-update',
  point: 'P3',
  mode: 'gate',
  participant: { id: 'tool-policy', version: '1' },
  owner,
  subject: user,
  action: 'tool.use',
  resource: reference,
  inputContract: { id: 'mcp-call', version: '1' },
  outputContract: { id: 'gate-result', version: '1' },
  order: 0,
  timeoutMs: 100,
  circuit: { failureThreshold: 2, resetAfterMs: 100 },
  onUnavailable: 'error',
  author: user,
  delegation: null,
};

describe('interception retained formats', () => {
  it('separates an authored statement from its trusted resolved source version', () => {
    expect(InterceptionStatementSchema.parse(statement)).toEqual(statement);
    expect(InterceptionBindingSchema.safeParse(statement).success).toBe(false);
    expect(
      InterceptionBindingSchema.parse({
        ...statement,
        source: reference,
        version: `sha256:${'a'.repeat(64)}`,
      }).source
    ).toEqual(reference);
  });

  it('rejects unknown authority semantics and decisive continuation on unavailable input', () => {
    for (const extra of [
      { mode: 'approve-everything' },
      { point: 'P9' },
      { onUnavailable: 'continue' },
      { timeoutMs: 0 },
      { unrecognizedGrant: true },
    ])
      expect(InterceptionStatementSchema.safeParse({ ...statement, ...extra }).success).toBe(false);
    expect(
      InterceptionStatementSchema.safeParse({
        ...statement,
        mode: 'advise',
        onUnavailable: 'continue',
      }).success
    ).toBe(true);
  });

  it('requires scoped safe version references and preserves unavailable as a distinct observation', () => {
    const invocation = {
      schemaVersion: 1,
      binding: { ...statement, source: reference, version: `sha256:${'a'.repeat(64)}` },
      input: reference,
      output: null,
      actor: user,
      outcome: 'unavailable',
      reasonCode: 'timeout',
      startedAt: '2026-10-18T00:00:00.000Z',
      finishedAt: '2026-10-18T00:00:00.100Z',
    };
    expect(InterceptionInvocationSchema.parse(invocation).outcome).toBe('unavailable');
    expect(
      InterceptionInvocationSchema.safeParse({ ...invocation, outcome: 'advised' }).success
    ).toBe(false);
    expect(
      InterceptionInvocationSchema.safeParse({
        ...invocation,
        binding: { ...invocation.binding, mode: 'transform' },
        outcome: 'transformed',
      }).success
    ).toBe(false);
    expect(
      InterceptionInvocationSchema.safeParse({
        ...invocation,
        input: { kind: 'record', family: 'page', id: 'admissions', version: '1' },
      }).success
    ).toBe(false);
    expect(
      InterceptionInvocationSchema.safeParse({
        ...invocation,
        input: {
          kind: 'content',
          reference: { scopeId: 'page/server', objectId: 'admissions' },
          version: 'commit-1',
        },
      }).success
    ).toBe(true);
  });

  it('carries a Gateway per-Agent tool rule without treating the requester as the rule author', () => {
    const binding = InterceptionStatementSchema.parse({
      ...statement,
      owner: { kind: 'server' },
      subject: { kind: 'agent', id: 'meta-skill-agent', responsibleUserId: user.id },
      action: 'gateway.tool.use',
      resource: {
        ...reference,
        owner: { kind: 'server' },
        family: 'gateway-tool',
        id: 'knowledge/read',
      },
      inputContract: { id: 'gateway.agent-tool-rule', version: '1' },
    });
    expect(binding.subject).toEqual({
      kind: 'agent',
      id: 'meta-skill-agent',
      responsibleUserId: user.id,
    });
    expect(binding.author).toEqual(user);
    expect(binding.resource.id).toBe('knowledge/read');
  });

  it('carries a storage-grant input contract without taking ownership of the lease payload', () => {
    const grant = {
      ...reference,
      owner: { kind: 'server' as const },
      family: 'policy-grant',
      id: 'storage-admissions',
    };
    const binding = InterceptionStatementSchema.parse({
      ...statement,
      point: 'P6',
      action: 'storage.lease',
      resource: grant,
      inputContract: { id: 'policy.storage-lease', version: '1' },
    });
    expect(binding.resource).toEqual(grant);
    expect(binding.inputContract.id).toBe('policy.storage-lease');
  });
});
