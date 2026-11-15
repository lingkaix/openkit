import { RequestIdSchema } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { commandRequestValues, parseCommandScope } from './command-request-codecs.js';
import { commandRequestKey } from './command-request-records.js';

const EVENT_COMMAND = 'channel.discord.inbound' as const;
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Responder facts stamped before dispatch; later bindings never relabel them. */
const DiscordInboundOriginSchema = z
  .object({
    coreUserId: z.string().min(1),
    bindingRevision: RequestIdSchema,
    operationId: z.enum(['approval.respond', 'question.answer']),
    workspaceId: z.string(),
    threadId: z.string(),
    pendingRequestId: z.string(),
    turnId: z.string(),
  })
  .strict();

/** The only mutable part of the permanent event row. */
const DiscordInboundStateSchema = z
  .object({
    state: z.enum(['dispatching', 'settled', 'response-unknown']),
    origin: DiscordInboundOriginSchema.optional(),
  })
  .strict();

const SELECT_EVENT = `SELECT input_hash AS inputHash, response_json AS responseJson
  FROM idempotency_requests WHERE command_name = '${EVENT_COMMAND}' AND request_id = ?`;
const DISPATCHING = `command_name = '${EVENT_COMMAND}' AND json_extract(response_json,'$.state') = 'dispatching'`;

/** Reserves one signed event in the Core command log, or returns the retained duplicate. */
export function reserveDiscordInboundCommand(
  sqlite: Database.Database,
  input: {
    readonly eventId: string;
    readonly payloadDigest: string;
    readonly discordUserId: string;
    readonly requestId: string;
    readonly now: number;
  }
):
  | { readonly existing: { readonly payloadDigest: string; readonly state: string } }
  | { readonly requestId: string } {
  const row = sqlite.prepare(SELECT_EVENT).get(input.eventId) as
    | { inputHash: string; responseJson: string }
    | undefined;
  if (row)
    return {
      existing: {
        payloadDigest: row.inputHash.slice('sha256:'.length),
        state: DiscordInboundStateSchema.parse(JSON.parse(row.responseJson)).state,
      },
    };
  const scope = parseCommandScope(EVENT_COMMAND, {
    coreId: 'server',
    discordUserId: input.discordUserId,
  });
  const values = commandRequestValues({
    command: EVENT_COMMAND,
    key: commandRequestKey(EVENT_COMMAND, input.eventId, scope),
    requestId: input.eventId,
    scope,
    inputHash: `sha256:${DigestSchema.parse(input.payloadDigest)}`,
    response: { kind: 'discord_inbound', id: input.requestId },
    createdAt: new Date(input.now).toISOString(),
    expiresAt: null,
  });
  values.response_json = JSON.stringify(DiscordInboundStateSchema.parse({ state: 'dispatching' }));
  const columns = Object.keys(values) as (keyof typeof values)[];
  sqlite
    .prepare(
      `INSERT INTO idempotency_requests (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((column) => values[column]));
  return { requestId: input.requestId };
}

/** Stamps the admitted responder once, only while its own dispatch is still open. */
export function publishDiscordInboundOrigin(
  sqlite: Database.Database,
  input: {
    readonly eventId: string;
    readonly requestId: string;
    readonly origin: z.input<typeof DiscordInboundOriginSchema>;
  }
): number {
  const origin = DiscordInboundOriginSchema.parse(input.origin);
  return sqlite
    .prepare(
      `UPDATE idempotency_requests SET response_json = json_set(response_json,'$.origin',json(?))
       WHERE ${DISPATCHING} AND request_id = ? AND response_id = ?
         AND json_extract(response_json,'$.origin') IS NULL`
    )
    .run(JSON.stringify(origin), input.eventId, input.requestId).changes;
}

/** Closes one open dispatch with its observed outcome; a closed event never changes again. */
export function settleDiscordInboundCommand(
  sqlite: Database.Database,
  eventId: string,
  state: 'settled' | 'response-unknown'
): void {
  sqlite
    .prepare(
      `UPDATE idempotency_requests SET response_json = json_set(response_json,'$.state',?)
       WHERE ${DISPATCHING} AND request_id = ?`
    )
    .run(state, eventId);
}

/** Marks every dispatch left open by a stopped process as unknown; nothing is retried. */
export function reconcileDiscordInboundCommands(sqlite: Database.Database): number {
  return sqlite
    .prepare(
      `UPDATE idempotency_requests SET response_json = json_set(response_json,'$.state','response-unknown')
       WHERE ${DISPATCHING}`
    )
    .run().changes;
}
