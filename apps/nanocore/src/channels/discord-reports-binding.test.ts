import { describe, expect, it, vi } from 'vitest';
import {
  changeDiscordReportsBinding,
  changeDiscordReportsTier,
  createDiscordReportsDraft,
} from './discord-reports-binding.js';

const role = {
  definitionId: 'reports',
  definitionRevision: 'd1',
  slotCollections: {
    facts: { collectionId: 'published-facts', collectionRevision: 'c1' },
    brief: { collectionId: 'published-brief', collectionRevision: 'c2' },
  },
};
const target = {
  botUserId: '123',
  guildId: '234',
  channelId: '345',
  audienceRef: 'channel',
  workspaceId: 'workspace',
  accountableUserId: 'member',
  roles: [role],
  collectionSetRevision: 'collections-v1',
  bindingId: 'installation',
  bindingRevision: 'draft-1',
};
const fixture = () => ({
  manage: vi.fn(() => true),
  publish: vi.fn(() => true),
  routeIsFree: vi.fn(() => true),
});
const activate = {
  operation: 'activate',
  expectedRevision: 'draft-1',
  nextRevision: 'active-2',
} as const;

describe('Reports binding mutation rules', () => {
  it('rejects an unknown nested collection authority in draft input, stored activation, and narrowing', () => {
    const authority = fixture();
    const restricted = {
      ...role,
      slotCollections: { facts: { ...role.slotCollections.facts, authority: 'restricted' } },
    };
    expect(createDiscordReportsDraft({ ...target, roles: [restricted] }, authority)).toBeNull();
    const draft = createDiscordReportsDraft(target, authority);
    expect(
      changeDiscordReportsBinding({ ...draft, roles: [restricted] }, activate, authority)
    ).toBeNull();
    const active = changeDiscordReportsBinding(draft, activate, authority);
    expect(
      changeDiscordReportsBinding(
        active,
        {
          operation: 'narrow',
          expectedRevision: 'active-2',
          nextRevision: 'active-3',
          collectionSetRevision: 'c2',
          roles: [restricted],
        },
        authority
      )
    ).toBeNull();
  });
  it('only activates an exact draft at its current revision and one free route', () => {
    const authority = fixture();
    const draft = createDiscordReportsDraft(target, authority);
    expect(draft).toEqual({ ...target, state: 'draft' });
    expect(
      changeDiscordReportsBinding(draft, { ...activate, expectedRevision: 'stale' }, authority)
    ).toBeNull();
    authority.publish.mockReturnValueOnce(false);
    expect(changeDiscordReportsBinding(draft, activate, authority)).toBeNull();
    authority.routeIsFree.mockReturnValueOnce(false);
    expect(changeDiscordReportsBinding(draft, activate, authority)).toBeNull();
    expect(changeDiscordReportsBinding(draft, activate, authority)).toEqual({
      ...target,
      state: 'active',
      bindingRevision: 'active-2',
    });
  });

  it('narrows selected exact collections without changing definition or route', () => {
    const authority = fixture();
    const active = changeDiscordReportsBinding(
      createDiscordReportsDraft(target, authority),
      activate,
      authority
    );
    const narrow = {
      operation: 'narrow',
      expectedRevision: 'active-2',
      nextRevision: 'active-3',
      collectionSetRevision: 'collections-v2',
    } as const;
    for (const changed of [
      { ...role, slotCollections: { other: role.slotCollections.facts } },
      {
        ...role,
        slotCollections: { facts: { ...role.slotCollections.facts, collectionRevision: 'other' } },
      },
      {
        ...role,
        definitionRevision: 'other',
        slotCollections: { facts: role.slotCollections.facts },
      },
      role,
    ])
      expect(
        changeDiscordReportsBinding(active, { ...narrow, roles: [changed] }, authority)
      ).toBeNull();
    const roles = [{ ...role, slotCollections: { facts: role.slotCollections.facts } }];
    authority.publish.mockReturnValueOnce(false);
    expect(changeDiscordReportsBinding(active, { ...narrow, roles }, authority)).toBeNull();
    expect(changeDiscordReportsBinding(active, { ...narrow, roles }, authority)).toEqual({
      ...active,
      roles,
      bindingRevision: 'active-3',
      collectionSetRevision: 'collections-v2',
    });
  });

  it('revokes with current management authority despite unavailable source and cannot reactivate the identity', () => {
    const authority = fixture();
    const draft = createDiscordReportsDraft(target, authority);
    const revoke = {
      operation: 'revoke',
      expectedRevision: 'draft-1',
      nextRevision: 'stopped-2',
    } as const;
    authority.manage.mockReturnValueOnce(false);
    authority.publish.mockReturnValue(false);
    expect(changeDiscordReportsBinding(draft, revoke, authority)).toBeNull();
    expect(
      changeDiscordReportsBinding({ ...draft, state: 'future' }, revoke, authority)
    ).toBeNull();
    const stopped = changeDiscordReportsBinding(draft, revoke, authority);
    expect(stopped).toMatchObject({ bindingId: target.bindingId, state: 'revoked' });
    authority.publish.mockReturnValue(true);
    expect(
      changeDiscordReportsBinding(
        stopped,
        { ...activate, expectedRevision: 'stopped-2' },
        authority
      )
    ).toBeNull();
  });

  it('changes only the tier and tier revision of an existing principal, with both CAS revisions', () => {
    const authority = fixture();
    const active = changeDiscordReportsBinding(
      createDiscordReportsDraft(target, authority),
      activate,
      authority
    );
    const basic = {
      bindingId: target.bindingId,
      principalId: 'external-principal',
      tier: 'basic',
      tierRevision: 'basic-1',
    };
    const increase = {
      expectedBindingRevision: 'active-2',
      expectedTierRevision: 'basic-1',
      nextTierRevision: 'expanded-2',
      tier: 'expanded',
    } as const;
    expect(changeDiscordReportsTier(active, null, increase, authority)).toBeNull();
    expect(
      changeDiscordReportsTier(
        active,
        basic,
        { ...increase, expectedBindingRevision: 'stale' },
        authority
      )
    ).toBeNull();
    expect(
      changeDiscordReportsTier(
        active,
        basic,
        { ...increase, expectedTierRevision: 'stale' },
        authority
      )
    ).toBeNull();
    expect(
      changeDiscordReportsTier(
        active,
        { ...basic, bindingId: 'previous-installation' },
        increase,
        authority
      )
    ).toBeNull();
    authority.publish.mockReturnValueOnce(false);
    expect(changeDiscordReportsTier(active, basic, increase, authority)).toBeNull();
    const expanded = changeDiscordReportsTier(active, basic, increase, authority);
    expect(expanded).toEqual({ ...basic, tier: 'expanded', tierRevision: 'expanded-2' });
    expect(
      changeDiscordReportsTier(
        active,
        expanded,
        {
          ...increase,
          expectedTierRevision: 'expanded-2',
          nextTierRevision: 'basic-3',
          tier: 'basic',
        },
        authority
      )
    ).toEqual({ ...basic, tierRevision: 'basic-3' });
  });
});
