import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { createDiscordGroupDelivery } from '../channels/discord-group-delivery.js';
import { dispatchDiscordReportsAnswer } from '../channels/discord-reports-dispatch.js';
import {
  claimDiscordReportsDelivery,
  reconcileDiscordReportsDelivery,
  settleDiscordReportsDelivery,
} from './discord-reports-delivery.js';

const text = 'Published total: 7';
const claim = {
  originId: 'origin',
  guildId: '100',
  channelId: '200',
  botUserId: '300',
  actionDigest: `sha256:${'a'.repeat(64)}`,
  postedDigest: createHash('sha256').update(text).digest('hex'),
  permissionDecisionId: 'permission',
};

function fixture() {
  const db = new Database(':memory:');
  db.exec(
    readFileSync(
      new URL('../../drizzle/core/0002_discord_reports_delivery.sql', import.meta.url),
      'utf8'
    )
  );
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ id: '300', bot: true }))
    .mockResolvedValueOnce(Response.json({ id: '200', guild_id: '100', type: 0 }));
  const transport = createDiscordGroupDelivery({ resolveBotToken: async () => 'fixture', fetch });
  const grant = vi.fn(() => true);
  const current = vi.fn(() => true);
  const dispatch = (approvalRequestId?: string) =>
    dispatchDiscordReportsAnswer(
      {
        claim: approvalRequestId ? { ...claim, approvalRequestId } : claim,
        text,
        bodyRef: 'body',
      },
      {
        reserve: async (action) => claimDiscordReportsDelivery(db, action, grant),
        stillCurrent: current,
        send: transport.send,
        settle: async (attemptId, action, result, body) =>
          settleDiscordReportsDelivery(db, { ...action, attemptId }, result, body),
      }
    );
  return { db, fetch, grant, current, dispatch };
}

it('shares one claim across automatic and approved delivery and records exact sent proof', async () => {
  const { db, dispatch, fetch, grant } = fixture();
  try {
    fetch.mockResolvedValueOnce(
      Response.json({
        id: '400',
        channel_id: '200',
        author: { id: '300', bot: true },
        content: text,
      })
    );
    expect(await Promise.all([dispatch(), dispatch('approval')])).toEqual([
      'sent',
      'not-dispatched',
    ]);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(
      db
        .prepare(
          'SELECT state, discord_message_id, approval_request_id, posted_digest FROM discord_reports_delivery'
        )
        .get()
    ).toEqual({
      state: 'sent',
      discord_message_id: '400',
      approval_request_id: null,
      posted_digest: claim.postedDigest,
    });
  } finally {
    db.close();
  }
});

it('withholds before grant, and after recheck loss, without contacting the outbound POST', async () => {
  const { db, dispatch, fetch, grant, current } = fixture();
  try {
    grant.mockReturnValueOnce(false);
    expect(await dispatch()).toBe('not-dispatched');
    expect(fetch).not.toHaveBeenCalled();
    current.mockReturnValue(false);
    expect(await dispatch('approval')).toBe('failed-no-send');
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it('treats lost responses and unfinished claims as unknown with no second dispatch', async () => {
  const { db, dispatch, fetch } = fixture();
  try {
    fetch.mockRejectedValueOnce(new Error('fixture lost reply'));
    expect(await dispatch()).toBe('delivery-unknown');
    expect(await dispatch('approval')).toBe('not-dispatched');
    const open = { ...claim, originId: 'other-origin' };
    expect(claimDiscordReportsDelivery(db, open, () => true)).not.toBeNull();
    expect(reconcileDiscordReportsDelivery(db)).toBe(1);
    expect(claimDiscordReportsDelivery(db, open, () => true)).toBeNull();
    expect(
      db.prepare('SELECT DISTINCT state, discord_message_id FROM discord_reports_delivery').all()
    ).toEqual([{ state: 'delivery-unknown', discord_message_id: null }]);
  } finally {
    db.close();
  }
});
