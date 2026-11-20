import { createHash } from 'node:crypto';
import type { DiscordReportsClaim } from '../storage/discord-reports-delivery.js';
import type { DiscordGroupSend } from './discord-group-delivery.js';
import type { DiscordSendResult } from './discord-rest.js';

/** Joins the exact reviewed action to its shared native claim and one transport call. */
export async function dispatchDiscordReportsAnswer(
  input: { readonly claim: DiscordReportsClaim; readonly text: string; readonly bodyRef: string },
  ports: {
    readonly reserve: (input: DiscordReportsClaim) => Promise<string | null>;
    readonly stillCurrent: (input: DiscordReportsClaim) => boolean;
    readonly send: (input: DiscordGroupSend) => Promise<DiscordSendResult>;
    readonly settle: (
      attemptId: string,
      claim: DiscordReportsClaim,
      result: DiscordSendResult,
      body: { text: string; bodyRef: string; acknowledgedAt: number } | null
    ) => Promise<boolean>;
  }
): Promise<'not-dispatched' | 'sent' | 'failed-no-send' | 'delivery-unknown'> {
  const { text, bodyRef } = input;
  const claim = { ...input.claim };
  if (!bodyRef || createHash('sha256').update(text).digest('hex') !== claim.postedDigest)
    return 'not-dispatched';
  const attemptId = await ports.reserve(claim).catch(() => null);
  if (!attemptId) return 'not-dispatched';
  let result: DiscordSendResult;
  try {
    result = await ports.send({
      guildId: claim.guildId,
      channelId: claim.channelId,
      botUserId: claim.botUserId,
      content: text,
      beforeSend: () => ports.stillCurrent(claim),
      stillCurrent: () => ports.stillCurrent(claim),
    });
  } catch {
    result = { status: 'delivery-unknown', code: 'discord_message_outcome_unknown' };
  }
  const body = result.status === 'sent' ? { text, bodyRef, acknowledgedAt: Date.now() } : null;
  return (await ports.settle(attemptId, claim, result, body).catch(() => false))
    ? result.status
    : 'delivery-unknown';
}
