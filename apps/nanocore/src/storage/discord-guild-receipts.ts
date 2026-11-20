import { randomUUID } from 'node:crypto';
import { RequestIdSchema, ThreadIdSchema, TurnIdSchema, UserIdSchema } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { DiscordInstantSchema } from '../channels/discord-instant.js';
import { DiscordSnowflakeSchema as snowflake } from '../channels/discord-snowflake.js';
import { commandRequestValues, parseCommandScope } from './command-request-codecs.js';
import {
  COMMAND_REQUEST_SELECT,
  commandRequestKey,
  mapCommandRequestRow,
} from './command-request-records.js';

const command = 'channel.discord.inbound' as const;
const id = z.string().min(1);
const refused = Symbol('guild-admission-refused');
const event = z.object({ guildId: snowflake, channelId: snowflake, messageId: snowflake });
const origin = z
  .object({
    principalId: id,
    tier: z.enum(['basic', 'expanded']),
    tierRevision: id,
    bindingId: id,
    bindingRevision: id,
    definitionId: id,
    definitionRevision: id,
    collectionSetRevision: id,
    agentId: id,
    botUserId: snowflake,
    onBehalfOf: UserIdSchema.nullable(),
    pairingRevision: RequestIdSchema.nullable(),
  })
  .refine((value) => (value.onBehalfOf === null) === (value.pairingRevision === null));
const work = z.object({ threadId: ThreadIdSchema, turnId: TurnIdSchema });
const questionDigest = z.string().regex(/^[0-9a-f]{64}$/);
const proof = {
  questionDigest: questionDigest.optional(),
  postedAt: DiscordInstantSchema.optional(),
};
const state = z.discriminatedUnion('state', [
  z.object({ state: z.literal('dispatching'), origin, ...proof }),
  z.object({ state: z.literal('response-unknown'), origin, ...proof }),
  z.object({ state: z.literal('settled'), origin, work, ...proof }),
]);
const candidate = event.extend({
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  postedAt: z.number().int(),
  postedAtExact: DiscordInstantSchema.optional(),
  questionDigest: questionDigest.optional(),
  botUserId: snowflake,
});

export type DiscordGuildReceiptOrigin = z.infer<typeof origin>;
export type DiscordGuildReceiptWork = z.infer<typeof work>;
export type DiscordGuildReceiptResult =
  | {
      readonly status: 'reserved';
      readonly originId: string;
      readonly origin: DiscordGuildReceiptOrigin;
      readonly questionDigest?: string;
      readonly postedAt?: string;
    }
  | { readonly status: 'settled'; readonly work: DiscordGuildReceiptWork }
  | { readonly status: 'conflict' | 'unknown' | 'refused' };

/** Guild keys are disjoint from numeric DM event IDs and survive Gateway connection replacement. */
function requestId(input: z.infer<typeof event>): string {
  return JSON.stringify(['guild-mention', input.guildId, input.channelId, input.messageId]);
}

const guildKey = z.tuple([z.literal('guild-mention'), snowflake, snowflake, snowflake]);

function loadGuildReceipt(sqlite: Database.Database, key: string) {
  const row = sqlite
    .prepare(`${COMMAND_REQUEST_SELECT} WHERE command_name = ? AND request_id = ?`)
    .get(command, key) as Parameters<typeof mapCommandRequestRow>[0] | undefined;
  if (!row) return undefined;
  try {
    const record = mapCommandRequestRow(row);
    const [, guildId, channelId, messageId] = guildKey.parse(JSON.parse(record.requestId));
    const identity = { guildId, channelId, messageId };
    if (
      requestId(identity) !== key ||
      record.scope.guildId !== identity.guildId ||
      record.scope.channelId !== identity.channelId ||
      !/^sha256:[a-f0-9]{64}$/.test(record.inputHash)
    )
      return null;
    return { record, identity, payload: state.parse(JSON.parse(row.responseJson ?? 'null')) };
  } catch {
    return null;
  }
}

/** Loads complete question evidence for an open, committed origin. Legacy or ambiguous rows cannot prepare a Turn. */
export function readDiscordGuildReceiptQuestion(
  sqlite: Database.Database,
  originId: string
): {
  readonly origin: DiscordGuildReceiptOrigin;
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly questionDigest: string;
  readonly postedAt: string;
} | null {
  if (!RequestIdSchema.safeParse(originId).success) return null;
  const rows = sqlite
    .prepare(`SELECT request_id AS requestId FROM idempotency_requests
    WHERE command_name = ? AND response_id = ? AND request_id GLOB '[[]*' LIMIT 2`)
    .all(command, originId) as { requestId: string }[];
  const key = rows.length === 1 ? rows[0]?.requestId : undefined;
  const saved = key ? loadGuildReceipt(sqlite, key) : null;
  if (!saved || saved.record.response.id !== originId || saved.payload.state !== 'dispatching')
    return null;
  const { origin, questionDigest, postedAt } = saved.payload;
  return questionDigest && postedAt
    ? { ...saved.identity, origin, questionDigest, postedAt }
    : null;
}

/** Reserves only an unseen, fresh and currently admitted event. The caller must join FULL before dispatch. */
export function reserveDiscordGuildReceipt(
  sqlite: Database.Database,
  input: z.input<typeof candidate>,
  options: {
    readonly now: number;
    /** Runs within the same native transaction; obtain binding, account/pair and capacity from current owners. */
    readonly admit: () => DiscordGuildReceiptOrigin | null;
  }
): DiscordGuildReceiptResult {
  const seen = candidate.parse(input);
  const key = requestId(seen);
  const hash = `sha256:${seen.inputHash}`;
  try {
    return sqlite
      .transaction((): DiscordGuildReceiptResult => {
        const saved = loadGuildReceipt(sqlite, key);
        if (saved === null) return { status: 'unknown' };
        if (saved) {
          if (saved.record.inputHash !== hash) return { status: 'conflict' };
          if (saved.payload.state === 'settled')
            return { status: 'settled', work: saved.payload.work };
          return { status: 'unknown' };
        }
        const age = options.now - seen.postedAt;
        if (!Number.isSafeInteger(age) || age < 0 || age > 300_000) return { status: 'refused' };
        if (
          (seen.questionDigest === undefined) !== (seen.postedAtExact === undefined) ||
          (seen.postedAtExact !== undefined && Date.parse(seen.postedAtExact) !== seen.postedAt)
        )
          return { status: 'refused' };
        const bindings =
          seen.questionDigest && seen.postedAtExact
            ? { questionDigest: seen.questionDigest, postedAt: seen.postedAtExact }
            : {};
        const admitted = origin.safeParse(options.admit());
        if (!admitted.success || admitted.data.botUserId !== seen.botUserId) throw refused;
        const originId = randomUUID();
        const scope = parseCommandScope(command, {
          coreId: 'server',
          guildId: seen.guildId,
          channelId: seen.channelId,
        });
        const values = commandRequestValues({
          command,
          key: commandRequestKey(command, key, scope),
          requestId: key,
          scope,
          inputHash: hash,
          response: { kind: 'discord_inbound', id: originId },
          createdAt: new Date(options.now).toISOString(),
          expiresAt: null,
        });
        values.response_json = JSON.stringify({
          state: 'dispatching',
          origin: admitted.data,
          ...bindings,
        });
        const columns = Object.keys(values) as (keyof typeof values)[];
        sqlite
          .prepare(
            `INSERT INTO idempotency_requests (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
          )
          .run(...columns.map((column) => values[column]));
        return { status: 'reserved', originId, origin: admitted.data, ...bindings };
      })
      .immediate();
  } catch (failure) {
    if (failure === refused) return { status: 'refused' };
    throw failure;
  }
}

/** Unknown future rows survive startup unchanged; only validated open guild attempts become unknown. */
export function reconcileDiscordGuildReceipts(sqlite: Database.Database): number {
  const open = sqlite
    .prepare(`SELECT request_id AS requestId, response_id AS responseId FROM idempotency_requests
    WHERE command_name = ? AND request_id GLOB '[[]*'`)
    .all(command) as { requestId: string; responseId: string }[];
  let changes = 0;
  for (const row of open) {
    let parsed: z.infer<typeof guildKey>;
    try {
      parsed = guildKey.parse(JSON.parse(row.requestId));
    } catch {
      continue;
    }
    const responseId = RequestIdSchema.safeParse(row.responseId);
    const [, guildId, channelId, messageId] = parsed;
    if (!responseId.success || requestId({ guildId, channelId, messageId }) !== row.requestId)
      continue;
    if (settleDiscordGuildReceipt(sqlite, { guildId, channelId, messageId }, responseId.data, null))
      changes++;
  }
  return changes;
}

/** Closes only the originating open reservation; restart uses the same retained identity checks. */
export function settleDiscordGuildReceipt(
  sqlite: Database.Database,
  identity: z.input<typeof event>,
  originId: string,
  outcome: DiscordGuildReceiptWork | null
): boolean {
  const parsed = event.parse(identity);
  const key = requestId(parsed);
  const owner = RequestIdSchema.parse(originId);
  const update = outcome
    ? `json_set(response_json, '$.state', 'settled', '$.work', json(?))`
    : `json_set(response_json, '$.state', 'response-unknown')`;
  return sqlite
    .transaction(() => {
      const saved = loadGuildReceipt(sqlite, key);
      if (!saved || saved.payload.state !== 'dispatching' || saved.record.response.id !== owner)
        return false;
      return (
        sqlite
          .prepare(`UPDATE idempotency_requests SET response_json = ${update}
    WHERE command_name = ? AND request_id = ? AND response_id = ?
      AND json_extract(response_json, '$.state') = 'dispatching'`)
          .run(...(outcome ? [JSON.stringify(work.parse(outcome))] : []), command, key, owner)
          .changes === 1
      );
    })
    .immediate();
}
