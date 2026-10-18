import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import {
  AnswerUserInputRequestSchema,
  isUserId,
  RequestIdSchema,
  RespondToApprovalRequestSchema,
} from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import { OperationError } from '../operation-error.js';

/** Discord inline response. Protected replies are private and disable mentions. */
export type DiscordReply =
  | { readonly type: 1 }
  | {
      readonly type: 4;
      readonly data: {
        readonly content: string;
        readonly flags: 64;
        readonly allowed_mentions: { readonly parse: readonly [] };
      };
    };

/** A current Pending owner projection admitted for this actor and private external audience. */
export type DiscordPendingView =
  | {
      readonly status: 'available';
      readonly kind: 'approval' | 'user-input';
      readonly workspaceId: string;
      readonly threadId: string;
      readonly pendingRequestId: string;
      readonly turnId: string;
      /** Complete exact effect or non-secret questions; never a summary in place of the effect. */
      readonly content: string;
      /** False for secret questions, unsupported decision strength, or incomplete disclosure. */
      readonly responseAllowed: boolean;
    }
  | { readonly status: 'unavailable'; readonly code: string };

/** Current identity, Pending owner and native invocation dependencies supplied by Core composition. */
export interface DiscordChannelOptions {
  readonly sqlite: Database.Database;
  readonly applicationId: string;
  readonly publicKey: string;
  /** Trusted public App origin, independent of the inbound request Host. */
  readonly appBaseUrl: string;
  /** Returns an exact App link only after current source and audience admission. */
  readonly requestLink: (input: {
    actor: Actor;
    workspaceId: string;
    threadId: string;
    pendingRequestId: string;
  }) => string | null;
  readonly newRequestId: () => string;
  readonly now?: () => number;
  /** Resolves a live ordinary actor without inheriting the pairing credential's administrator grant. */
  readonly resolveActor: (userId: string) => Actor | null;
  /** Rechecks responsible-user, exact lineage, source access and private external audience synchronously. */
  readonly inspectPending: (input: {
    readonly actor: Actor;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly pendingRequestId: string;
  }) => DiscordPendingView;
  /** Invokes the existing native engine; Pending ownership, current admission and results stay there. */
  readonly invoke: (
    id: 'question.answer' | 'approval.respond',
    input: unknown,
    actor: Actor
  ) => Promise<unknown>;
}

const verifiedInputs = new WeakSet<object>();
const freshnessMs = 300_000;
const snowflake = z.string().regex(/^[0-9]{1,20}$/);
const envelopeSchema = z
  .object({
    id: snowflake,
    application_id: snowflake,
    type: z.number().int(),
    version: z.literal(1),
  })
  .passthrough();
const commandSchema = z.object({
  user: z.object({ id: snowflake }),
  context: z.literal(1),
  channel: z.object({ id: snowflake, type: z.literal(1) }),
  data: z.object({
    name: z.literal('openkit'),
    type: z.literal(1),
    options: z
      .array(
        z
          .object({
            name: z.enum(['pair', 'inspect', 'answer', 'approve', 'deny']),
            type: z.literal(1),
            options: z
              .array(
                z
                  .object({ name: z.string(), type: z.literal(3), value: z.string().max(6_000) })
                  .strict()
              )
              .max(5),
          })
          .strict()
      )
      .length(1),
  }),
});

/** Immutable raw request admitted by this module's signature verifier. */
export interface VerifiedDiscordInteraction {
  readonly body: string;
  readonly payloadDigest: string;
  readonly applicationId: string;
  readonly publicKey: string;
}

/** Verifies Ed25519 over timestamp plus exact raw body, then checks application and freshness. */
export function verifyDiscordInteraction(input: {
  readonly body: Uint8Array;
  readonly signature: string;
  readonly timestamp: string;
  readonly publicKey: string;
  readonly applicationId: string;
  readonly now?: number;
}): VerifiedDiscordInteraction {
  const reject = () =>
    new OperationError('invalid_discord_signature', 'Discord authentication failed.', 401);
  if (
    input.body.byteLength > 65_536 ||
    !/^[0-9a-f]{128}$/i.test(input.signature) ||
    !/^[0-9a-f]{64}$/i.test(input.publicKey) ||
    !/^[0-9]{1,12}$/.test(input.timestamp) ||
    Math.abs((input.now ?? Date.now()) - Number(input.timestamp) * 1000) > freshnessMs
  )
    throw reject();
  try {
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(input.publicKey, 'hex'),
      ]),
      type: 'spki',
      format: 'der',
    });
    if (
      !verify(
        null,
        Buffer.concat([Buffer.from(input.timestamp), input.body]),
        key,
        Buffer.from(input.signature, 'hex')
      )
    )
      throw reject();
    const body = new TextDecoder('utf-8', { fatal: true }).decode(input.body);
    const envelope = envelopeSchema.parse(JSON.parse(body));
    if (envelope.application_id !== input.applicationId) throw reject();
    const value = Object.freeze({
      body,
      payloadDigest: digest(input.body),
      applicationId: input.applicationId,
      publicKey: input.publicKey.toLowerCase(),
    });
    verifiedInputs.add(value);
    return value;
  } catch {
    throw reject();
  }
}

/** Private response helper also used by the HTTP entry's bounded interaction deadline. */
export function discordPrivateReply(content: string): DiscordReply {
  return { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } };
}

/** Non-secret active account binding. Revision changes after every new pairing. */
export interface DiscordAccountBinding {
  readonly discordUserId: string;
  readonly userId: string;
  readonly revision: string;
  readonly pairedAt: number;
}

/** Reads the account owner independently of whether a Discord adapter is configured. */
export function readDiscordAccountBinding(
  sqlite: Database.Database,
  userId: string
): DiscordAccountBinding | null {
  const row = sqlite
    .prepare(`SELECT discord_user_id AS discordUserId,user_id AS userId,revision,paired_at AS pairedAt
    FROM discord_account_bindings WHERE user_id = ? AND revoked_at IS NULL`)
    .get(userId);
  if (!row) return null;
  const parsed = z
    .object({
      discordUserId: snowflake,
      userId: z.string().refine(isUserId),
      revision: RequestIdSchema,
      pairedAt: z.number().int().nonnegative(),
    })
    .safeParse(row);
  if (!parsed.success)
    throw new OperationError(
      'channel_binding_unavailable',
      'The retained account binding is unavailable.',
      409
    );
  return parsed.data;
}

/** Revokes account control and outstanding challenges without contacting or configuring Discord. */
export function revokeDiscordAccountBinding(
  sqlite: Database.Database,
  userId: string,
  now = Date.now()
): void {
  sqlite
    .transaction(() => {
      sqlite
        .prepare(
          'UPDATE discord_account_bindings SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
        )
        .run(now, userId);
      sqlite
        .prepare(
          'UPDATE discord_pairing_challenges SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL'
        )
        .run(now, userId);
    })
    .immediate();
}

/** Creates the Discord projection over migration-owned tables, without network or schema creation. */
export function createDiscordChannel(options: DiscordChannelOptions) {
  const { sqlite } = options;
  const now = options.now ?? Date.now;
  const appUrl = new URL(options.appBaseUrl);
  if (
    appUrl.protocol !== 'https:' ||
    appUrl.origin !== options.appBaseUrl ||
    appUrl.username ||
    appUrl.password
  )
    throw new OperationError(
      'channel_configuration_invalid',
      'A public HTTPS App origin is required.',
      503
    );
  const appLink = `Open OpenKit: ${appUrl.origin}`;
  const reply = (text: string, link = appUrl.origin) =>
    discordPrivateReply(`${text}\nOpen OpenKit: ${link}`);
  // A prior unfinished dispatch is uncertain. Never replay it, even if Core's receipt is absent.
  sqlite
    .prepare(
      "UPDATE discord_inbound_receipts SET state = 'response-unknown' WHERE state = 'dispatching'"
    )
    .run();

  /** Reads the current active account binding for a Core user. */
  function binding(actor: Actor): DiscordAccountBinding | null {
    return readDiscordAccountBinding(sqlite, actor.userId);
  }

  /** Starts a one-use, five-minute challenge for the authenticated Core user, storing only its digest. */
  function beginPairing(actor: Actor): { challenge: string; expiresAt: number } {
    if (options.resolveActor(actor.userId)?.userId !== actor.userId)
      throw new OperationError(
        'channel_actor_unavailable',
        'Current actor authority is unavailable.',
        403
      );
    const challenge = randomBytes(32).toString('base64url');
    const expiresAt = now() + freshnessMs;
    sqlite
      .transaction(() => {
        sqlite
          .prepare(
            'UPDATE discord_pairing_challenges SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL'
          )
          .run(now(), actor.userId);
        sqlite
          .prepare(
            'INSERT INTO discord_pairing_challenges(digest,user_id,expires_at) VALUES(?,?,?)'
          )
          .run(digest(challenge), actor.userId, expiresAt);
      })
      .immediate();
    return { challenge, expiresAt };
  }

  /** Revokes the binding and every unused challenge before later responses or sends can use them. */
  function revoke(actor: Actor): void {
    revokeDiscordAccountBinding(sqlite, actor.userId, now());
  }

  /** Atomically consumes external account proof and the Core-issued pairing challenge. */
  function pair(discordUserId: string, challenge: string): string {
    return sqlite
      .transaction(() => {
        const row = sqlite
          .prepare(
            'SELECT user_id AS userId FROM discord_pairing_challenges WHERE digest = ? AND consumed_at IS NULL AND expires_at > ?'
          )
          .get(digest(challenge), now()) as { userId: string } | undefined;
        if (!row || options.resolveActor(row.userId)?.userId !== row.userId)
          return 'Pairing challenge unavailable. Start pairing in OpenKit.';
        const existing = sqlite
          .prepare(
            'SELECT user_id AS userId,revoked_at AS revokedAt FROM discord_account_bindings WHERE discord_user_id = ?'
          )
          .get(discordUserId) as { userId: string; revokedAt: number | null } | undefined;
        if (
          (existing && existing.revokedAt === null) ||
          binding({ userId: row.userId, kind: 'session' })
        )
          return 'An active binding exists. Revoke it in OpenKit before pairing again.';
        sqlite
          .prepare(
            'UPDATE discord_pairing_challenges SET consumed_at = ? WHERE digest = ? AND consumed_at IS NULL'
          )
          .run(now(), digest(challenge));
        sqlite
          .prepare(`INSERT INTO discord_account_bindings(discord_user_id,user_id,revision,paired_at,revoked_at) VALUES(?,?,?,?,NULL)
        ON CONFLICT(discord_user_id) DO UPDATE SET user_id = excluded.user_id,revision = excluded.revision,paired_at = excluded.paired_at,revoked_at = NULL`)
          .run(discordUserId, row.userId, RequestIdSchema.parse(options.newRequestId()), now());
        return 'Discord account paired. Current Core authority is checked for each response.';
      })
      .immediate();
  }

  /** Dispatches exactly one verified event after its durable deduplication fence commits. */
  async function handleVerified(input: VerifiedDiscordInteraction): Promise<DiscordReply> {
    if (
      !verifiedInputs.has(input) ||
      input.applicationId !== options.applicationId ||
      input.publicKey !== options.publicKey.toLowerCase()
    )
      throw new OperationError('invalid_discord_signature', 'Discord authentication failed.', 401);
    const envelope = envelopeSchema.parse(JSON.parse(input.body));
    if (envelope.type === 1) return { type: 1 };
    if (
      envelope.guild_id !== undefined ||
      envelope.guild !== undefined ||
      envelope.member !== undefined ||
      envelope.context !== 1 ||
      !commandSchema.safeParse(envelope).success
    )
      return reply(
        'Use a private DM with the OpenKit bot. Unsupported input must be handled in OpenKit.'
      );
    const command = commandSchema.parse(envelope);
    if (envelope.type !== 2) return reply('This interaction is unsupported. Use OpenKit.');
    const receipt = sqlite
      .transaction(() => {
        const existing = sqlite
          .prepare(
            'SELECT payload_digest AS payloadDigest,state FROM discord_inbound_receipts WHERE event_id = ?'
          )
          .get(envelope.id) as { payloadDigest: string; state: string } | undefined;
        if (existing) return { existing };
        const requestId = RequestIdSchema.parse(options.newRequestId());
        sqlite
          .prepare(
            "INSERT INTO discord_inbound_receipts(event_id,payload_digest,request_id,state,created_at,discord_user_id) VALUES(?,?,?,'dispatching',?,?)"
          )
          .run(envelope.id, input.payloadDigest, requestId, now(), command.user.id);
        return { requestId };
      })
      .immediate();
    if (receipt.existing) {
      if (receipt.existing.payloadDigest !== input.payloadDigest)
        return reply('Interaction identity conflict. Inspect the request in OpenKit.');
      return reply(
        receipt.existing.state === 'settled'
          ? 'This interaction was already handled. Inspect the request in OpenKit or inspect it again in Discord.'
          : 'The response outcome is unknown. Inspect the request in OpenKit before a new attempt.'
      );
    }
    let submitted = false;
    try {
      const subcommand = command.data.options[0]!;
      const values = Object.create(null) as Record<string, string>;
      for (const option of subcommand.options) {
        if (Object.hasOwn(values, option.name))
          throw new OperationError('unsupported_input', 'Duplicate input.', 400);
        values[option.name] = option.value;
      }
      let text: string;
      const names = Object.keys(values).sort().join(',');
      if (subcommand.name === 'pair') {
        text =
          names === 'challenge'
            ? pair(command.user.id, values.challenge!)
            : 'This pairing input is unsupported. Start pairing in OpenKit.';
      } else {
        const expectedNames =
          subcommand.name === 'inspect' || subcommand.name === 'approve'
            ? 'request,thread,workspace'
            : subcommand.name === 'answer'
              ? 'answers,disclosure,request,thread,workspace'
              : 'disclosure,request,thread,workspace';
        if (names !== expectedNames)
          throw new OperationError('unsupported_input', 'Unsupported input.', 400);
        const row = sqlite
          .prepare(`SELECT discord_user_id AS discordUserId,user_id AS userId,revision,paired_at AS pairedAt
          FROM discord_account_bindings WHERE discord_user_id = ? AND revoked_at IS NULL`)
          .get(command.user.id) as DiscordAccountBinding | undefined;
        if (!row)
          throw new OperationError(
            'channel_binding_unavailable',
            'Current binding unavailable.',
            403
          );
        const resolvedActor = options.resolveActor(row.userId);
        if (!resolvedActor || resolvedActor.userId !== row.userId)
          throw new OperationError(
            'channel_authority_unavailable',
            'Current authority unavailable.',
            403
          );
        // The proof binds an account, never a bearer or selected administrator credential.
        const actor: Actor = {
          userId: resolvedActor.userId,
          kind: resolvedActor.kind === 'local' ? 'local' : 'session',
        };
        const target = {
          workspaceId: values.workspace!,
          threadId: values.thread!,
          pendingRequestId: values.request!,
        };
        if (subcommand.name === 'approve') {
          const link = options.requestLink({ actor, ...target });
          text = 'Approval grants require the complete App confirmation.';
          settle(envelope.id, 'settled');
          return reply(text, link ?? appUrl.origin);
        }
        if (subcommand.name !== 'inspect') {
          const disclosure = sqlite
            .prepare(`SELECT content_digest AS contentDigest,kind FROM discord_disclosures
            WHERE token_digest = ? AND discord_user_id = ? AND binding_revision = ? AND workspace_id = ? AND thread_id = ? AND pending_request_id = ? AND expires_at > ?`)
            .get(
              digest(values.disclosure!),
              command.user.id,
              row.revision,
              target.workspaceId,
              target.threadId,
              target.pendingRequestId,
              now()
            ) as { contentDigest: string; kind: string } | undefined;
          if (!disclosure)
            throw new OperationError(
              'channel_disclosure_unavailable',
              'Current disclosure unavailable.',
              409
            );
          const view = currentView(actor, target);
          if (view.kind !== disclosure.kind || viewDigest(view) !== disclosure.contentDigest)
            throw new OperationError(
              'channel_disclosure_changed',
              'The exact effect or question changed.',
              409
            );
          if ((subcommand.name === 'answer') !== (view.kind === 'user-input'))
            throw new OperationError('unsupported_request_kind', 'Unsupported request kind.', 400);
          // No await separates the fresh authority, audience, binding and exact-content checks from native invocation.
          if (binding(actor)?.revision !== row.revision)
            throw new OperationError(
              'channel_binding_unavailable',
              'Current binding unavailable.',
              403
            );
          const input =
            subcommand.name === 'answer'
              ? AnswerUserInputRequestSchema.parse({
                  ...target,
                  userInputRequestId: target.pendingRequestId,
                  answers: JSON.parse(values.answers!),
                  requestId: receipt.requestId,
                })
              : RespondToApprovalRequestSchema.parse({
                  workspaceId: target.workspaceId,
                  threadId: target.threadId,
                  turnId: view.turnId,
                  approvalRequestId: target.pendingRequestId,
                  decision: 'denied',
                  requestId: receipt.requestId,
                });
          const operationId = subcommand.name === 'answer' ? 'question.answer' : 'approval.respond';
          // The receipt owns the admitted responder and source, even if native acceptance stays unknown.
          // Commit these facts before dispatch; later bindings must never relabel this event.
          const origin = sqlite
            .prepare(`UPDATE discord_inbound_receipts SET core_user_id = ?,binding_revision = ?,operation_id = ?,workspace_id = ?,thread_id = ?,pending_request_id = ?,turn_id = ?
            WHERE event_id = ? AND request_id = ? AND state = 'dispatching' AND operation_id IS NULL`)
            .run(
              actor.userId,
              row.revision,
              operationId,
              view.workspaceId,
              view.threadId,
              view.pendingRequestId,
              view.turnId,
              envelope.id,
              receipt.requestId
            );
          if (origin.changes !== 1)
            throw new OperationError(
              'channel_origin_unavailable',
              'The required channel response origin could not be retained.',
              503
            );
          submitted = true;
          await options.invoke(operationId, input, actor);
          text =
            'OpenKit accepted the response. Inspect the request in OpenKit for its current decision and execution outcome.';
        } else {
          const view = currentView(actor, target);
          const token = randomBytes(32).toString('base64url');
          text = `${view.content}\nDigest: ${viewDigest(view)}\nDisclosure: ${token}\nUse this disclosure only for this exact request. It expires in five minutes.`;
          if (text.length + appLink.length + 1 > 2_000)
            throw new OperationError(
              'channel_disclosure_too_large',
              'The complete request requires OpenKit.',
              400
            );
          sqlite
            .prepare(`INSERT INTO discord_disclosures(token_digest,discord_user_id,binding_revision,workspace_id,thread_id,pending_request_id,kind,content_digest,expires_at)
            VALUES(?,?,?,?,?,?,?,?,?)`)
            .run(
              digest(token),
              command.user.id,
              row.revision,
              target.workspaceId,
              target.threadId,
              target.pendingRequestId,
              view.kind,
              viewDigest(view),
              now() + freshnessMs
            );
        }
      }
      settle(envelope.id, 'settled');
      return reply(text);
    } catch (error) {
      const unknown = submitted && (!(error instanceof OperationError) || error.status >= 500);
      settle(envelope.id, unknown ? 'response-unknown' : 'settled');
      if (unknown)
        return reply(
          'The response outcome is unknown. Inspect the request in OpenKit before a new attempt.'
        );
      const code =
        error instanceof OperationError && /^[a-z0-9_-]{1,80}$/.test(error.code)
          ? error.code
          : 'unsupported_input';
      return reply(
        `OpenKit refused this input: ${code}. Inspect the request in OpenKit. Unsupported input must be handled there.`
      );
    }
  }

  /** Reads only fresh exact owner data admitted for direct private response. */
  function currentView(
    actor: Actor,
    target: { workspaceId: string; threadId: string; pendingRequestId: string }
  ) {
    const view = options.inspectPending({ actor, ...target });
    if (view.status !== 'available')
      throw new OperationError(view.code, 'The request is unavailable.', 409);
    if (!view.responseAllowed)
      throw new OperationError('channel_response_not_admitted', 'Use the request in OpenKit.', 403);
    if (
      view.workspaceId !== target.workspaceId ||
      view.threadId !== target.threadId ||
      view.pendingRequestId !== target.pendingRequestId
    )
      throw new OperationError('channel_lineage_conflict', 'Exact request lineage differs.', 409);
    return view;
  }

  /** Stores no request content, answers, captured arguments or interaction tokens. */
  function settle(eventId: string, state: 'settled' | 'response-unknown') {
    sqlite
      .prepare(
        "UPDATE discord_inbound_receipts SET state = ? WHERE event_id = ? AND state = 'dispatching'"
      )
      .run(state, eventId);
  }

  return {
    beginPairing,
    binding,
    revoke,
    handleVerified,
    /** Authenticates raw input before its external account or event identity is used. */
    handleSignedInteraction(input: { body: Uint8Array; signature: string; timestamp: string }) {
      return handleVerified(
        verifyDiscordInteraction({
          ...input,
          applicationId: options.applicationId,
          publicKey: options.publicKey,
          now: now(),
        })
      );
    },
  };
}

/** Hashes boundary bytes without retaining their sensitive content. */
function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Binds disclosure bytes to exact current Pending lineage as well as content. */
function viewDigest(view: Extract<DiscordPendingView, { status: 'available' }>): string {
  return digest(
    JSON.stringify([
      view.kind,
      view.workspaceId,
      view.threadId,
      view.pendingRequestId,
      view.turnId,
      view.content,
    ])
  );
}
