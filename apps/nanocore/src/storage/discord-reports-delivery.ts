import { createHash, randomUUID } from 'node:crypto';
import { PolicyDigestV1Schema } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { DiscordSendResult } from '../channels/discord-rest.js';
import { DiscordSnowflakeSchema as snowflake } from '../channels/discord-snowflake.js';

const id = z.string().min(1);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const claim = z.object({
  originId: id,
  guildId: snowflake,
  channelId: snowflake,
  botUserId: snowflake,
  actionDigest: PolicyDigestV1Schema,
  postedDigest: digest,
  permissionDecisionId: id,
  approvalRequestId: id.optional(),
});
export type DiscordReportsClaim = z.infer<typeof claim>;

/** Automatic and approval paths must invoke the same claim after native grant admission. */
export function claimDiscordReportsDelivery(
  sqlite: Database.Database,
  input: DiscordReportsClaim,
  authorizeAndConsume: (claim: DiscordReportsClaim) => boolean
): string | null {
  const exact = claim.parse(input);
  return sqlite
    .transaction(() => {
      if (
        sqlite
          .prepare('SELECT 1 FROM discord_reports_delivery WHERE origin_id = ?')
          .get(exact.originId)
      )
        return null;
      if (authorizeAndConsume(exact) !== true) return null;
      const attemptId = randomUUID();
      sqlite
        .prepare(`INSERT INTO discord_reports_delivery (origin_id,attempt_id,action_digest,permission_decision_id,
      approval_request_id,guild_id,channel_id,bot_user_id,posted_digest,state) VALUES (?,?,?,?,?,?,?,?,?,'claimed')`)
        .run(
          exact.originId,
          attemptId,
          exact.actionDigest,
          exact.permissionDecisionId,
          exact.approvalRequestId ?? null,
          exact.guildId,
          exact.channelId,
          exact.botUserId,
          exact.postedDigest
        );
      return attemptId;
    })
    .immediate();
}

/** Records one irreversible observation of the owning attempt; no result can reopen a claim. */
export function settleDiscordReportsDelivery(
  sqlite: Database.Database,
  exact: Pick<DiscordReportsClaim, 'originId' | 'actionDigest' | 'postedDigest'> & {
    readonly attemptId: string;
  },
  result: DiscordSendResult,
  sentBody: {
    readonly text: string;
    readonly bodyRef: string;
    readonly acknowledgedAt: number;
  } | null
): boolean {
  const sent =
    result.status === 'sent' &&
    sentBody &&
    snowflake.safeParse(result.externalMessageId).success &&
    Number.isSafeInteger(sentBody.acknowledgedAt) &&
    sentBody.acknowledgedAt > 0 &&
    sentBody.bodyRef &&
    createHash('sha256').update(sentBody.text).digest('hex') === exact.postedDigest;
  const state =
    result.status === 'failed-no-send' ? result.status : sent ? 'sent' : 'delivery-unknown';
  const changed =
    sqlite
      .prepare(`UPDATE discord_reports_delivery SET state = ?, discord_message_id = ?, posted_body_ref = ?, acknowledged_at = ?
    WHERE origin_id = ? AND attempt_id = ? AND action_digest = ? AND posted_digest = ? AND state = 'claimed'`)
      .run(
        state,
        sent && result.status === 'sent' ? result.externalMessageId : null,
        sent && sentBody ? sentBody.bodyRef : null,
        sent && sentBody ? sentBody.acknowledgedAt : null,
        exact.originId,
        exact.attemptId,
        exact.actionDigest,
        exact.postedDigest
      ).changes === 1;
  return changed && state === result.status;
}

/** Startup reconciliation cannot know if a claimed message reached Discord. */
export function reconcileDiscordReportsDelivery(sqlite: Database.Database): number {
  return sqlite
    .prepare(
      "UPDATE discord_reports_delivery SET state = 'delivery-unknown' WHERE state = 'claimed'"
    )
    .run().changes;
}
