import { describe, expect, it } from 'vitest';
import {
  type DiscordPublicationFacts,
  prepareDiscordPublication,
} from './discord-publication-intent.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const facts: DiscordPublicationFacts = {
  originId: 'origin-1',
  botUserId: '101',
  guildId: '102',
  channelId: '103',
  audienceRef: 'audience-1',
  authorityRevisionRefs: ['binding:2', 'source:7'],
  influenceDigest: 'influence-1',
  renderedBodyRef: 'body-1',
  content: 'Total: 12 entries. Dataset A, 2026-11-20.',
  review: {
    principal: { kind: 'agent', id: 'reports' },
    onBehalfOf: null,
    target: {
      kind: 'container',
      container: { kind: 'workspace', id: workspaceId, owner: { kind: 'workspace', workspaceId } },
    },
    influenceSources: ['origin-1'],
  },
};

describe('Discord publication proposal', () => {
  it('uses one exact preview, with benign Discord options, and binds changes in body or authority', () => {
    const first = prepareDiscordPublication(facts);
    if (first.kind !== 'proposal') throw new Error('Expected a proposal.');
    expect(first.preview).toEqual({
      content: facts.content,
      allowed_mentions: { parse: [] },
      flags: 4,
    });
    expect(first.securityReviewAction?.destinationAudience).toEqual([facts.audienceRef]);
    for (const change of [
      { content: `${facts.content} ` },
      { channelId: '104' },
      { authorityRevisionRefs: ['binding:3', 'source:7'] },
    ]) {
      const altered = prepareDiscordPublication({ ...facts, ...change });
      expect(altered.kind === 'proposal' && altered.governedIntent.actionDigest).not.toBe(
        first.governedIntent.actionDigest
      );
    }
  });

  it('refuses excessive answer bytes and does not clip oversized review evidence', () => {
    expect(prepareDiscordPublication({ ...facts, content: '界'.repeat(1500) })).toEqual({
      kind: 'invalid-answer',
    });
    const proposal = prepareDiscordPublication({
      ...facts,
      authorityRevisionRefs: ['x'.repeat(8192)],
    });
    expect(proposal).toMatchObject({
      kind: 'proposal',
      preview: { content: facts.content },
      securityReviewAction: null,
    });
  });
});
