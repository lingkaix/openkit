import { describe, expect, it } from 'vitest';
import { validateWorkspaceMoveMapping } from './workspace-move-mapping.js';

// Owner: docs/specs/20260704-workspace_backup_export_import.md, Target Admission And Rebinding.
// T1–T6: evidence/redesign/lane-d-next-piece-plan.md, with coordinator field/value corrections.
// Fixed canonical identities and expected reports are independent of the implementation.
const sourceOwner = 'usr_00000000-0000-7000-8000-000000000001';
const sourceMember = 'usr_00000000-0000-7000-8000-000000000002';
const otherMember = 'usr_00000000-0000-7000-8000-000000000003';
const administrator = 'usr_00000000-0000-7000-8000-000000000101';
const targetMember = 'usr_00000000-0000-7000-8000-000000000102';
const absentAccount = 'usr_00000000-0000-7000-8000-000000000999';
const wrongKind = 'ws_00000000-0000-7000-8000-000000000001';
const provenance = {
  sourceDeploymentId: 'dep_00000000-0000-7000-8000-000000000201',
  workspaceId: 'ws_00000000-0000-7000-8000-000000000202',
  backupId: 'wsbak_00000000-0000-7000-8000-000000000203',
  manifestDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};
const fixture = {
  manifest: {
    sourceDeploymentId: provenance.sourceDeploymentId,
    workspaceId: provenance.workspaceId,
    backupId: provenance.backupId,
    accounts: {
      ownerId: sourceOwner,
      memberIds: [otherMember, sourceOwner, sourceMember],
      privateAudienceRefs: ['opaque-source-private-audience', 'source-only/private/42'],
    },
  },
  manifestDigest: provenance.manifestDigest,
  importingAdministratorId: administrator,
  memberMappings: [] as { sourceAccountId: string; targetAccountId: string }[],
  targetAccounts: [
    { accountId: administrator, status: 'active' as const },
    { accountId: targetMember, status: 'active' as const },
  ],
};
const unmapped = {
  ...provenance,
  disposition: 'ready',
  accountMap: { resolvedTargetOwnerId: administrator, memberMappings: [] },
  droppedSourceMemberIds: [sourceOwner, sourceMember, otherMember],
};

describe('Workspace MOVE account mapping (mapping readiness only)', () => {
  it('T1 — "supplies the target owner, defaulting to themself"; every target must exist and be active', () => {
    expect(validateWorkspaceMoveMapping(structuredClone(fixture))).toStrictEqual(unmapped);
    expect(
      validateWorkspaceMoveMapping({ ...structuredClone(fixture), targetOwnerId: targetMember })
    ).toStrictEqual({
      ...provenance,
      disposition: 'ready',
      accountMap: { resolvedTargetOwnerId: targetMember, memberMappings: [] },
      droppedSourceMemberIds: [sourceOwner, sourceMember, otherMember],
    });
    for (const targetAccounts of [
      [],
      [{ accountId: administrator, status: 'disabled' as const }],
    ]) {
      expect(
        validateWorkspaceMoveMapping({ ...structuredClone(fixture), targetAccounts })
      ).toStrictEqual({
        ...provenance,
        disposition: 'refused',
        refusals: [{ reason: 'target-owner-unavailable', field: 'targetOwnerId' }],
      });
    }
    for (const targetOwnerId of [absentAccount, targetMember]) {
      expect(
        validateWorkspaceMoveMapping({
          ...structuredClone(fixture),
          targetOwnerId,
          targetAccounts: [
            { accountId: administrator, status: 'active' },
            { accountId: targetMember, status: 'disabled' },
          ],
        })
      ).toStrictEqual({
        ...provenance,
        disposition: 'refused',
        refusals: [{ reason: 'target-owner-unavailable', field: 'targetOwnerId' }],
      });
    }
  });

  it('T2 — "an exact source-account-to-target-account member map"; invalid, duplicate, unknown or unavailable accounts refuse', () => {
    for (const invalid of ['not-an-account', wrongKind, `${sourceMember}\n`, ` ${sourceMember}`]) {
      for (const [sourceAccountId, targetAccountId, field] of [
        [invalid, targetMember, 'memberMappings[0].sourceAccountId'],
        [sourceMember, invalid, 'memberMappings[0].targetAccountId'],
      ] as const) {
        expect(
          validateWorkspaceMoveMapping({
            ...structuredClone(fixture),
            memberMappings: [{ sourceAccountId, targetAccountId }],
          })
        ).toStrictEqual({
          ...provenance,
          disposition: 'refused',
          refusals: [{ reason: 'invalid-account-identity', field }],
        });
      }
    }
    for (const targetAccountId of [administrator, targetMember]) {
      expect(
        validateWorkspaceMoveMapping({
          ...structuredClone(fixture),
          memberMappings: [
            { sourceAccountId: sourceMember, targetAccountId: administrator },
            { sourceAccountId: sourceMember, targetAccountId },
          ],
        })
      ).toStrictEqual({
        ...provenance,
        disposition: 'refused',
        refusals: [
          {
            reason: 'duplicate-source-account-mapping',
            field: 'memberMappings[1].sourceAccountId',
          },
        ],
      });
    }
    expect(
      validateWorkspaceMoveMapping({
        ...structuredClone(fixture),
        memberMappings: [{ sourceAccountId: absentAccount, targetAccountId: targetMember }],
      })
    ).toStrictEqual({
      ...provenance,
      disposition: 'refused',
      refusals: [{ reason: 'unknown-source-account', field: 'memberMappings[0].sourceAccountId' }],
    });
    for (const targetAccounts of [
      [{ accountId: administrator, status: 'active' as const }],
      [
        { accountId: administrator, status: 'active' as const },
        { accountId: targetMember, status: 'disabled' as const },
      ],
    ]) {
      expect(
        validateWorkspaceMoveMapping({
          ...structuredClone(fixture),
          targetAccounts,
          memberMappings: [{ sourceAccountId: sourceMember, targetAccountId: targetMember }],
        })
      ).toStrictEqual({
        ...provenance,
        disposition: 'refused',
        refusals: [
          { reason: 'target-member-unavailable', field: 'memberMappings[0].targetAccountId' },
        ],
      });
    }
    expect(
      validateWorkspaceMoveMapping({
        ...structuredClone(fixture),
        importingAdministratorId: wrongKind,
      })
    ).toStrictEqual({
      ...provenance,
      disposition: 'refused',
      refusals: [{ reason: 'invalid-account-identity', field: 'importingAdministratorId' }],
    });
  });

  it('T3 — "Unmapped members are dropped and listed"; never infer matching IDs, names or contacts; no source roles travel', () => {
    const input = {
      ...structuredClone(fixture),
      targetAccounts: [
        ...fixture.targetAccounts,
        ...[sourceOwner, sourceMember, otherMember].map((accountId) => ({
          accountId,
          status: 'active' as const,
          displayName: 'Same source name',
          contactAddress: 'same@example.invalid',
        })),
      ],
    };
    expect(validateWorkspaceMoveMapping(input)).toStrictEqual(unmapped);
    input.memberMappings = [
      { sourceAccountId: otherMember, targetAccountId: targetMember },
      { sourceAccountId: sourceMember, targetAccountId: targetMember },
    ];
    expect(validateWorkspaceMoveMapping(input)).toStrictEqual({
      ...provenance,
      disposition: 'ready',
      accountMap: {
        resolvedTargetOwnerId: administrator,
        memberMappings: [
          { sourceAccountId: sourceMember, targetAccountId: targetMember },
          { sourceAccountId: otherMember, targetAccountId: targetMember },
        ],
      },
      droppedSourceMemberIds: [sourceOwner],
    });
  });

  it('T4 — "Preserve historical ActorRef values" and "Rebind private audience access only through explicit admitted mappings"', () => {
    const input = {
      ...structuredClone(fixture),
      targetOwnerId: targetMember,
      manifest: {
        ...structuredClone(fixture.manifest),
        historicalActors: [{ kind: 'user', id: sourceOwner }],
      },
    };
    const original = structuredClone(input);
    expect(validateWorkspaceMoveMapping(input)).toStrictEqual({
      ...provenance,
      disposition: 'ready',
      accountMap: { resolvedTargetOwnerId: targetMember, memberMappings: [] },
      droppedSourceMemberIds: [sourceOwner, sourceMember, otherMember],
    });
    expect(input).toStrictEqual(original);
    expect(
      validateWorkspaceMoveMapping({
        ...input,
        memberMappings: [{ sourceAccountId: sourceOwner, targetAccountId: targetMember }],
      })
    ).toStrictEqual({
      ...provenance,
      disposition: 'ready',
      accountMap: {
        resolvedTargetOwnerId: targetMember,
        memberMappings: [{ sourceAccountId: sourceOwner, targetAccountId: targetMember }],
      },
      droppedSourceMemberIds: [sourceMember, otherMember],
    });
    expect(input).toStrictEqual(original);
  });

  it('T5 — "resolved target owner, and canonical source-account-sorted member map"; supplied facts need no live lookup', () => {
    const input = structuredClone(fixture);
    input.memberMappings = [
      { sourceAccountId: otherMember, targetAccountId: targetMember },
      { sourceAccountId: sourceMember, targetAccountId: administrator },
    ];
    const expected = {
      ...provenance,
      disposition: 'ready',
      accountMap: {
        resolvedTargetOwnerId: administrator,
        memberMappings: [
          { sourceAccountId: sourceMember, targetAccountId: administrator },
          { sourceAccountId: otherMember, targetAccountId: targetMember },
        ],
      },
      droppedSourceMemberIds: [sourceOwner],
    };
    const original = structuredClone(input);
    expect(validateWorkspaceMoveMapping(input)).toStrictEqual(expected);
    expect(
      validateWorkspaceMoveMapping({
        ...input,
        targetOwnerId: administrator,
        manifest: {
          ...input.manifest,
          accounts: {
            ...input.manifest.accounts,
            memberIds: [sourceMember, sourceOwner, otherMember],
          },
        },
        memberMappings: input.memberMappings.toReversed(),
        targetAccounts: input.targetAccounts.toReversed(),
      })
    ).toStrictEqual(expected);
    expect(input).toStrictEqual(original);
    expect(
      validateWorkspaceMoveMapping({
        ...input,
        targetOwnerId: targetMember,
        memberMappings: [{ sourceAccountId: otherMember, targetAccountId: administrator }],
      })
    ).toStrictEqual({
      ...provenance,
      disposition: 'ready',
      accountMap: {
        resolvedTargetOwnerId: targetMember,
        memberMappings: [{ sourceAccountId: otherMember, targetAccountId: administrator }],
      },
      droppedSourceMemberIds: [sourceOwner, sourceMember],
    });
  });

  it('T6 — "Record source deployment, backup identity, manifest digest"; exact reports ignore descriptive additions without echo or mutation', () => {
    const descriptive = {
      ...structuredClone(fixture),
      manifest: { ...structuredClone(fixture.manifest), description: 'Source-only annotation' },
      targetAccounts: fixture.targetAccounts.map((fact) => ({
        ...fact,
        displayName: 'Annotation',
      })),
    };
    const original = structuredClone(descriptive);
    expect(validateWorkspaceMoveMapping(descriptive)).toStrictEqual(unmapped);
    expect(descriptive).toStrictEqual(original);
    const input = {
      ...structuredClone(fixture),
      targetOwnerId: 'malformed-owner-canary',
      memberMappings: [
        { sourceAccountId: absentAccount, targetAccountId: absentAccount },
        { sourceAccountId: sourceMember, targetAccountId: 'malformed-target-canary' },
        { sourceAccountId: otherMember, targetAccountId: targetMember },
        { sourceAccountId: otherMember, targetAccountId: administrator },
      ],
    };
    const before = structuredClone(input);
    const refused = {
      ...provenance,
      disposition: 'refused',
      refusals: [
        { reason: 'invalid-account-identity', field: 'targetOwnerId' },
        { reason: 'unknown-source-account', field: 'memberMappings[0].sourceAccountId' },
        { reason: 'target-member-unavailable', field: 'memberMappings[0].targetAccountId' },
        { reason: 'invalid-account-identity', field: 'memberMappings[1].targetAccountId' },
        { reason: 'duplicate-source-account-mapping', field: 'memberMappings[3].sourceAccountId' },
      ],
    };
    expect(validateWorkspaceMoveMapping(input)).toStrictEqual(refused);
    expect(
      validateWorkspaceMoveMapping({ ...input, targetAccounts: input.targetAccounts.toReversed() })
    ).toStrictEqual(refused);
    expect(input).toStrictEqual(before);
    expect(
      validateWorkspaceMoveMapping({
        ...structuredClone(fixture),
        manifest: {
          ...structuredClone(fixture.manifest),
          sourceDeploymentId: 'dep_00000000-0000-7000-8000-000000000301',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000302',
          backupId: 'wsbak_00000000-0000-7000-8000-000000000303',
        },
        manifestDigest: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
      })
    ).toStrictEqual({
      sourceDeploymentId: 'dep_00000000-0000-7000-8000-000000000301',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000302',
      backupId: 'wsbak_00000000-0000-7000-8000-000000000303',
      manifestDigest: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
      disposition: 'ready',
      accountMap: { resolvedTargetOwnerId: administrator, memberMappings: [] },
      droppedSourceMemberIds: [sourceOwner, sourceMember, otherMember],
    });
  });
});
