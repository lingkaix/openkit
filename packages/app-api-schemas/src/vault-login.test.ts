import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { VAULT_OPERATION_DEFINITIONS } from './vault-operations.js';

const referenceId = 'vault_00000000-0000-7000-8000-000000000501';
const dto = {
  referenceId,
  provider: 'codex',
  status: 'active',
  currentVersion: 1,
  quarantined: false,
  observations: null,
};
const ids = ['vault.login-list', 'vault.login-quarantine', 'vault.login-release'] as const;

/** Dynamic lookup makes the missing feature a deciding assertion, never a missing named-export collection error. */
function contract(id: (typeof ids)[number]) {
  const value = Reflect.get(VAULT_OPERATION_DEFINITIONS, id) as
    | {
        inputSchema: z.ZodType;
        outputSchema: z.ZodType;
        credentials: readonly string[];
        insertionPoints?: {
          stages: readonly string[];
          modes: readonly string[];
          participantKinds: readonly string[];
          gateResults: readonly string[];
        };
      }
    | undefined;
  expect(value, `Expected baseline RED: ${id} has no definition yet.`).toBeDefined();
  return value!;
}

/** The accepted private metadata contract carries no caller-selectable authority or material. */
describe('personal Codex Login App API contracts', () => {
  it.each(ids)('declares exact fixed-User read or write posture for %s', (id) => {
    const value = contract(id);
    expect(value).toMatchObject({
      binding: 'json',
      returnsOneTimeSecret: false,
      successStatus: 200,
      scope: { kind: 'user' },
      target: { kind: 'user' },
      policyOperation: 'vault.admin',
      mutating: id !== 'vault.login-list',
    });
    expect(value.credentials).toContain('local-user');
    expect(value.credentials).toContain('user-session');
    expect(value.credentials).toContain('deployment-administrator');
    expect(value.credentials).not.toContain('worker-package');
    expect(value.credentials).not.toContain('coordinator');
    expect(value.insertionPoints?.stages).toEqual(['propose', 'decide', 'commit', 'completed']);
    expect(value.insertionPoints?.modes).toEqual(['gate', 'observe']);
    expect(value.insertionPoints?.participantKinds).toEqual(['deterministic']);
    expect(value.insertionPoints?.gateResults).toEqual(['allow', 'deny']);
  });

  it.each(ids)('accepts only the closed reference input for %s', (id) => {
    const schema = contract(id).inputSchema;
    const input = id === 'vault.login-list' ? {} : { referenceId };
    expect(schema.parse(input)).toEqual(input);
    for (const field of [
      'userId',
      'ownerUserId',
      'workspaceId',
      'accountId',
      'provider',
      'login',
      'quarantined',
      'material',
      'backendLocator',
      'policyDecisionId',
      'actor',
    ])
      expect(schema.safeParse({ ...input, [field]: 'synthetic' }).success).toBe(false);
    if (id === 'vault.login-list') expect(schema.safeParse({ referenceId }).success).toBe(false);
    else
      for (const invalid of [
        {},
        { referenceId: '' },
        { referenceId: 'untyped' },
        { referenceId: null },
      ])
        expect(schema.safeParse(invalid).success).toBe(false);
  });

  it.each(ids)(
    'preserves exact current metadata and explicit unknown observations for %s',
    (id) => {
      const schema = contract(id).outputSchema;
      const wrap = (value: unknown) => (id === 'vault.login-list' ? { items: [value] } : value);
      expect(schema.parse(wrap(dto))).toEqual(wrap(dto));
      for (const status of ['active', 'revoked', 'unbound']) {
        const currentVersion = status === 'unbound' ? 0 : 1;
        expect(schema.parse(wrap({ ...dto, status, currentVersion }))).toEqual(
          wrap({ ...dto, status, currentVersion })
        );
      }
      for (const invalid of [
        { ...dto, provider: 'unsupported' },
        { ...dto, status: 'healthy' },
        { ...dto, currentVersion: -1 },
        { ...dto, currentVersion: 1.5 },
        { ...dto, quarantined: 0 },
        { ...dto, observations: { health: 'healthy' } },
        { ...dto, observations: undefined },
      ])
        expect(schema.safeParse(wrap(invalid)).success).toBe(false);
      const extra = {
        ...dto,
        accountId: 'synthetic-upstream-equality',
        backendLocator: 'synthetic-private-locator',
        material: 'synthetic-forbidden-field',
      };
      const parsed = schema.safeParse(wrap(extra));
      // Closed rejection and descriptive stripping both exclude private fields; neither may return them.
      if (parsed.success) expect(parsed.data).toEqual(wrap(dto));
    }
  );
});

/** COORD 07:06Z: reuse the existing name and secret-stdin request for actual-human User acquisition. */
describe('human User Login acquisition contract', () => {
  it('retains the operation and request while replacing the historical Server result', () => {
    const value = VAULT_OPERATION_DEFINITIONS['vault.bootstrap-codex-auth'];
    expect(value).toMatchObject({
      binding: 'json',
      inputSensitivity: 'secret stdin',
      returnsOneTimeSecret: false,
      successStatus: 200,
      scope: { kind: 'user' },
      target: { kind: 'user' },
      policyOperation: 'vault.admin',
      mutating: true,
    });
    expect(value.credentials).not.toContain('worker-package');
    expect(value.credentials).not.toContain('coordinator');
    const input = { authJsonBase64: 'e30=' };
    expect(value.inputSchema.parse(input)).toEqual(input);
    for (const field of [
      'ownerUserId',
      'userId',
      'accountId',
      'provider',
      'login',
      'workspaceId',
      'actor',
    ])
      expect(value.inputSchema.safeParse({ ...input, [field]: 'synthetic-selector' }).success).toBe(
        false
      );
    expect(value.outputSchema.parse(dto)).toEqual(dto);
    const historical = {
      backendKind: 'encrypted-file',
      referenceId,
      grantId: 'grant_00000000-0000-7000-8000-000000000502',
      grantScope: 'agent-session',
      secretKind: 'codex-auth-json',
      targetPath: '/sandbox/.codex/auth.json',
      expiresAt: null,
    };
    expect(value.outputSchema.safeParse(historical).success).toBe(false);
  });

  it('strictly refuses retired expiresAt on the existing acquisition request', () => {
    const value = VAULT_OPERATION_DEFINITIONS['vault.bootstrap-codex-auth'];
    const input = { authJsonBase64: 'e30=' };
    expect(value.inputSchema.parse(input)).toEqual(input);
    const result = value.inputSchema.safeParse({ ...input, expiresAt: '2099-01-01T00:00:00.000Z' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ code: 'unrecognized_keys', keys: ['expiresAt'] }),
      ]);
    }
  });
});
