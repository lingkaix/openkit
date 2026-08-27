import { describe, expect, it } from 'vitest';

import { OpenKitAccessTokenScopeSchema } from './auth.js';
import {
  EnrollNanoHostRequestSchema,
  EnrollNanoHostResponseSchema,
  IssueNanoHostTransportTokenRequestSchema,
  IssueNanoHostTransportTokenResponseSchema,
  NanoHostRuntimeTargetStatusResponseSchema,
  NanoHostTransportTokenRecordSchema,
  NanoHostTransportTokenScopeSchema,
  NanoHostTransportTokenTypeSchema,
  RotateNanoHostTransportTokenRequestSchema,
  RotateNanoHostTransportTokenResponseSchema,
} from './nanohost.js';

/**
 * S-2b-1 predicate start: NanoHost transport token class / schema surface.
 *
 * Contract: `docs/specs/20260802-nanohost_runtime_and_transport.md` requires a
 * dedicated Core Token projection with closed type and scope
 * `nanohost-transport`, distinct from human remote-access scopes owned by
 * `docs/specs/20260704-remote_auth_credential_bootstrap.md`.
 *
 * Prefer fail-on-absence: this file imports production schemas that do not
 * exist yet. Do not implement `nanohost.ts` here.
 */
describe('NanoHost transport token class schema', () => {
  it('exports a closed nanohost-transport token type', () => {
    expect(NanoHostTransportTokenTypeSchema.parse('nanohost-transport')).toBe('nanohost-transport');
    expect(() => NanoHostTransportTokenTypeSchema.parse('server-admin')).toThrow();
    expect(() => NanoHostTransportTokenTypeSchema.parse('workspace')).toThrow();
  });

  it('exports a closed nanohost-transport token scope', () => {
    expect(NanoHostTransportTokenScopeSchema.parse('nanohost-transport')).toBe(
      'nanohost-transport'
    );
    expect(() => NanoHostTransportTokenScopeSchema.parse('server-admin')).toThrow();
    expect(() => NanoHostTransportTokenScopeSchema.parse('workspace-readonly')).toThrow();
  });

  it('keeps human access-token scopes free of nanohost-transport', () => {
    expect(() => OpenKitAccessTokenScopeSchema.parse('nanohost-transport')).toThrow();
    expect(OpenKitAccessTokenScopeSchema.parse('server-admin')).toBe('server-admin');
  });

  it('defines a redacted Token record that rejects raw okt_ secret material', () => {
    const record = NanoHostTransportTokenRecordSchema.parse({
      tokenId: 'tok_nanohost_example',
      ownerNanoHostIdentityId: 'integration_nanohost_primary',
      tokenType: 'nanohost-transport',
      scope: 'nanohost-transport',
      deploymentId: 'deploy_primary',
      status: 'active',
      issuedAt: '2026-08-08T00:00:00.000Z',
      expiresAt: '2026-09-08T00:00:00.000Z',
      revokedAt: null,
      predecessorTokenId: null,
      rotationOverlapExpiresAt: null,
      responsibleServerAdminActorId: 'user_admin',
      lastUsedAt: null,
      lastUsedChannel: null,
      lastUsedSource: null,
    });

    expect(record.scope).toBe('nanohost-transport');
    expect(record.tokenType).toBe('nanohost-transport');

    expect(() =>
      NanoHostTransportTokenRecordSchema.parse({
        ...record,
        lastUsedSource: 'okt_should_never_appear_in_redacted_record',
      })
    ).toThrow();
  });
});

const redactedRecord = {
  tokenId: 'tok_nanohost_example',
  ownerNanoHostIdentityId: 'integration_nanohost_primary',
  tokenType: 'nanohost-transport' as const,
  scope: 'nanohost-transport' as const,
  deploymentId: 'deploy_primary',
  status: 'active' as const,
  issuedAt: '2026-08-08T00:00:00.000Z',
  expiresAt: '2026-09-08T00:00:00.000Z',
  revokedAt: null,
  predecessorTokenId: null,
  rotationOverlapExpiresAt: null,
  responsibleServerAdminActorId: 'user_admin',
  lastUsedAt: null,
  lastUsedChannel: null,
  lastUsedSource: null,
};

/**
 * WP-2b R1 red: Enrollment And One-Time Delivery — general App API results carry
 * only redacted identity / token-ref / slot-result metadata. Raw `okt_` MUST NOT
 * appear as a response field.
 */
describe('NanoHost safe-sink App API schemas', () => {
  it('defines the strict configured RuntimeTarget observation response', () => {
    const response = NanoHostRuntimeTargetStatusResponseSchema.parse({
      identityId: 'integration_nanohost_primary',
      deploymentId: 'deploy_primary',
      connectionGeneration: 3,
      predecessorFenced: true,
      ready: true,
      freshEmpty: true,
      observedAt: '2026-08-15T01:02:03.000Z',
    });

    expect(Object.keys(response).sort()).toEqual(
      [
        'identityId',
        'deploymentId',
        'connectionGeneration',
        'predecessorFenced',
        'ready',
        'freshEmpty',
        'observedAt',
      ].sort()
    );
    expect(() =>
      NanoHostRuntimeTargetStatusResponseSchema.parse({ ...response, targetId: 'caller-selected' })
    ).toThrow();
    expect(() =>
      NanoHostRuntimeTargetStatusResponseSchema.parse({ ...response, connectionGeneration: 0 })
    ).toThrow();
    expect(() =>
      NanoHostRuntimeTargetStatusResponseSchema.parse({ ...response, observedAt: 'not-a-time' })
    ).toThrow();
  });

  it('keeps configured identity, deployment, and filesystem targets out of App API input', () => {
    expect(
      EnrollNanoHostRequestSchema.parse({
        targetSlot: 'A',
        expiresAt: '2026-09-08T00:00:00.000Z',
      })
    ).toEqual({
      targetSlot: 'A',
      expiresAt: '2026-09-08T00:00:00.000Z',
    });

    expect(() =>
      EnrollNanoHostRequestSchema.parse({
        identityId: 'integration_attacker_selected',
        deploymentId: 'deploy_attacker_selected',
        targetSlot: 'A',
        expiresAt: '2026-09-08T00:00:00.000Z',
        sink: {
          secretPath: '/tmp/attacker-selected.token',
          companionPath: '/tmp/attacker-selected.meta',
        },
      })
    ).toThrow();

    expect(() =>
      IssueNanoHostTransportTokenRequestSchema.parse({
        ownerNanoHostIdentityId: 'integration_attacker_selected',
        deploymentId: 'deploy_attacker_selected',
        targetSlot: 'B',
        expiresAt: '2026-09-08T00:00:00.000Z',
        sink: {
          secretPath: '/tmp/attacker-selected.token',
          companionPath: '/tmp/attacker-selected.meta',
        },
      })
    ).toThrow();

    expect(() =>
      RotateNanoHostTransportTokenRequestSchema.parse({
        overlapSeconds: 60,
        targetSlot: 'B',
      })
    ).toThrow();
  });

  it('rejects raw okt_ fields on enroll, issue, and rotate responses', () => {
    const slotResult = { slot: 'A' as const, status: 'written' as const, issuanceGeneration: 1 };

    const enroll = EnrollNanoHostResponseSchema.parse({
      identityId: 'integration_nanohost_primary',
      deploymentId: 'deploy_primary',
      credentialRef: 'nanohost-token:tok_nanohost_example',
      targetSlot: 'A',
      slotResult,
      record: redactedRecord,
    });
    expect(enroll.slotResult).toEqual(slotResult);
    expect(enroll).not.toHaveProperty('token');

    const issued = IssueNanoHostTransportTokenResponseSchema.parse({
      credentialRef: 'nanohost-token:tok_nanohost_example',
      targetSlot: 'A',
      slotResult,
      record: redactedRecord,
    });
    expect(issued).not.toHaveProperty('token');
    expect(JSON.stringify(issued)).not.toContain('okt_');

    const rotated = RotateNanoHostTransportTokenResponseSchema.parse({
      credentialRef: 'nanohost-token:tok_nanohost_successor',
      targetSlot: 'B',
      slotResult: { slot: 'B', status: 'written', issuanceGeneration: 2 },
      record: { ...redactedRecord, tokenId: 'tok_nanohost_successor', predecessorTokenId: 'tok_a' },
      rotatedRecord: { ...redactedRecord, status: 'rotated', tokenId: 'tok_a' },
    });
    expect(rotated).not.toHaveProperty('token');
    expect(JSON.stringify(rotated)).not.toContain('okt_');

    expect(() =>
      IssueNanoHostTransportTokenResponseSchema.parse({
        token: 'okt_must_not_appear_in_general_api_result_aaaaaaaaaaaaaaaa',
        targetSlot: 'A',
        slotResult,
        record: redactedRecord,
      })
    ).toThrow();

    expect(() =>
      RotateNanoHostTransportTokenResponseSchema.parse({
        token: 'okt_must_not_appear_in_general_api_result_bbbbbbbbbbbbbbbb',
        targetSlot: 'B',
        slotResult: { slot: 'B', status: 'written', issuanceGeneration: 2 },
        record: redactedRecord,
        rotatedRecord: redactedRecord,
      })
    ).toThrow();
  });
});
