import { randomBytes, randomUUID } from 'node:crypto';
import {
  AnswerUserInputRequestSchema,
  isUserId,
  RequestIdSchema,
  RespondToApprovalRequestSchema,
} from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { prepareAuditEvent, prepareAuditEventStatement } from '../audit-events.js';
import { resolveSessionDeploymentAdminTokenId } from '../auth/access-token-store.js';
import { type Actor, getLocalUserId } from '../auth/identity.js';
import { evaluateOwnedUserOperation } from '../auth/operation-authorizer.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import type { CoreMode } from '../config/mode.js';
import { OperationError } from '../operation-error.js';
import { presentControlFacts } from '../storage/control-store-input.js';
import { assertControlProductWriter } from '../storage/control-store-products.js';
import { ControlStoreWorkerError } from '../storage/control-store-worker-error.js';
import type { CoreDb } from '../storage/db.js';
import {
  publishDiscordInboundOrigin,
  reconcileDiscordInboundCommands,
  reserveDiscordInboundCommand,
  settleDiscordInboundCommand,
} from '../storage/discord-inbound-commands.js';
import type { ControlDiscordChannelInput, ControlDiscordChannelResult } from './discord-codecs.js';
import {
  type DiscordPendingView,
  type DiscordReply,
  discordDigest,
  discordFreshnessMs,
  discordPrivateReply,
  discordTransportSnowflake,
  discordViewDigest,
  readVerifiedDiscordCommand,
  type VerifiedDiscordInteraction,
  verifyDiscordInteraction,
} from './discord-interaction.js';
import { DISCORD_AUTOMATION_NOTICE } from './discord-rest.js';

export {
  type DiscordPendingView,
  type DiscordReply,
  discordPrivateReply,
  type VerifiedDiscordInteraction,
  verifyDiscordInteraction,
} from './discord-interaction.js';

/** Current identity, Pending owner and native invocation dependencies supplied by Core composition. */
export interface DiscordChannelOptions {
  readonly sqlite: Database.Database;
  /** Canonical live composition; raw databases remain explicit fixture owners. */
  readonly nativeCoreDb?: CoreDb;
  /** Current deployment mode supplies the original local-User restriction. */
  readonly mode?: CoreMode;
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
      discordUserId: discordTransportSnowflake,
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
function revokeDiscordAccountBindingInDb(
  sqlite: Database.Database,
  userId: string,
  now = Date.now(),
  administratorAtEvent = false
): void {
  sqlite
    .transaction(() => {
      const previous = readDiscordAccountBinding(sqlite, userId);
      if (previous)
        recordPairingAudit(sqlite, 'channel.pairing.unbind', previous, administratorAtEvent, now);
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

/** Retains the exact binding mutation facts inside its owning SQLite transaction. */
function recordPairingAudit(
  sqlite: Database.Database,
  action: 'channel.pairing.bind' | 'channel.pairing.unbind',
  binding: DiscordAccountBinding,
  administratorAtEvent: boolean,
  now: number
): void {
  const statement = prepareAuditEventStatement(
    prepareAuditEvent({
      workspaceId: null,
      action,
      actor: { kind: 'user', id: binding.userId },
      subject: { kind: 'user', id: binding.userId },
      resource: `channel:discord:${binding.userId}`,
      outcome: 'succeeded',
      now: new Date(now),
      summary: JSON.stringify({
        channelKind: 'discord',
        userId: binding.userId,
        bindingRevision: binding.revision,
        administratorAtEvent,
      }),
    })
  );
  sqlite.prepare(statement.sql).run(...statement.parameters);
}

/** Original stage dependencies stay local to their SQL owner, never on the native wire. */
interface DiscordSqlContext {
  readonly now: () => number;
  readonly newRequestId: () => string;
  readonly resolveActor: (userId: string) => Actor | null;
  readonly administratorAtEvent: (userId: string) => boolean;
}

/** Shares each original complete SQL stage without joining its separate effect boundaries. */
function applyDiscordStageInDb(
  sqlite: Database.Database,
  input: ControlDiscordChannelInput,
  context: DiscordSqlContext
): ControlDiscordChannelResult {
  switch (input.stage) {
    case 'reconcile-incomplete':
      return {
        stage: input.stage,
        changes: reconcileDiscordInboundCommands(sqlite),
      };
    case 'revoke-binding':
      revokeDiscordAccountBindingInDb(
        sqlite,
        input.userId,
        context.now(),
        context.administratorAtEvent(input.userId)
      );
      return { stage: input.stage };
    case 'issue-challenge':
      sqlite
        .transaction(() => {
          sqlite
            .prepare(
              'UPDATE discord_pairing_challenges SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL'
            )
            .run(context.now(), input.userId);
          sqlite
            .prepare(
              'INSERT INTO discord_pairing_challenges(digest,user_id,expires_at) VALUES(?,?,?)'
            )
            .run(input.digest, input.userId, input.expiresAt);
        })
        .immediate();
      return { stage: input.stage };
    case 'consume-challenge': {
      const text = sqlite
        .transaction(() => {
          const row = sqlite
            .prepare(
              'SELECT user_id AS userId FROM discord_pairing_challenges WHERE digest = ? AND consumed_at IS NULL AND expires_at > ?'
            )
            .get(input.digest, context.now()) as { userId: string } | undefined;
          if (!row || context.resolveActor(row.userId)?.userId !== row.userId)
            return 'Pairing challenge unavailable. Start pairing in OpenKit.' as const;
          const existing = sqlite
            .prepare(
              'SELECT user_id AS userId,revoked_at AS revokedAt FROM discord_account_bindings WHERE discord_user_id = ?'
            )
            .get(input.discordUserId) as { userId: string; revokedAt: number | null } | undefined;
          if (
            (existing && existing.revokedAt === null) ||
            readDiscordAccountBinding(sqlite, row.userId)
          )
            return 'An active binding exists. Revoke it in OpenKit before pairing again.' as const;
          sqlite
            .prepare(
              'UPDATE discord_pairing_challenges SET consumed_at = ? WHERE digest = ? AND consumed_at IS NULL'
            )
            .run(context.now(), input.digest);
          const revision = RequestIdSchema.parse(context.newRequestId());
          const pairedAt = context.now();
          sqlite
            .prepare(`INSERT INTO discord_account_bindings(discord_user_id,user_id,revision,paired_at,revoked_at) VALUES(?,?,?,?,NULL)
          ON CONFLICT(discord_user_id) DO UPDATE SET user_id = excluded.user_id,revision = excluded.revision,paired_at = excluded.paired_at,revoked_at = NULL`)
            .run(input.discordUserId, row.userId, revision, pairedAt);
          recordPairingAudit(
            sqlite,
            'channel.pairing.bind',
            { discordUserId: input.discordUserId, userId: row.userId, revision, pairedAt },
            context.administratorAtEvent(row.userId),
            pairedAt
          );
          return 'Discord account paired. Current Core authority is checked for each response.' as const;
        })
        .immediate();
      return { stage: input.stage, text };
    }
    case 'reserve-inbound': {
      const receipt = sqlite
        .transaction(() =>
          reserveDiscordInboundCommand(sqlite, {
            eventId: input.eventId,
            payloadDigest: input.payloadDigest,
            discordUserId: input.discordUserId,
            requestId: RequestIdSchema.parse(context.newRequestId()),
            now: context.now(),
          })
        )
        .immediate();
      return { stage: input.stage, receipt };
    }
    case 'publish-origin':
      return {
        stage: input.stage,
        changes: publishDiscordInboundOrigin(sqlite, {
          eventId: input.eventId,
          requestId: input.requestId,
          origin: {
            coreUserId: input.userId,
            bindingRevision: input.bindingRevision,
            operationId: input.operationId,
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            pendingRequestId: input.pendingRequestId,
            turnId: input.turnId,
          },
        }),
      };
    case 'publish-disclosure':
      sqlite
        .prepare(`INSERT INTO discord_disclosures(token_digest,discord_user_id,binding_revision,workspace_id,thread_id,pending_request_id,kind,content_digest,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(
          input.tokenDigest,
          input.discordUserId,
          input.bindingRevision,
          input.workspaceId,
          input.threadId,
          input.pendingRequestId,
          input.kind,
          input.contentDigest,
          input.expiresAt
        );
      return { stage: input.stage };
    case 'settle-inbound':
      settleDiscordInboundCommand(sqlite, input.eventId, input.state);
      return { stage: input.stage };
  }
}

/** Decides current Core actor/binding facts and the original stage in the admitted writer. */
export function applyControlDiscordChannel(
  coreDb: CoreDb,
  input: ControlDiscordChannelInput
): ControlDiscordChannelResult {
  assertControlProductWriter(coreDb.sqlite);
  const resolveActor = (userId: string): Actor | null => {
    if (!isCanonicalUserActive(coreDb, userId)) return null;
    if ('mode' in input && input.mode === 'local' && getLocalUserId(coreDb) !== userId) return null;
    if (input.stage === 'consume-challenge' && input.admittedUserId !== userId) return null;
    return { kind: 'session', userId };
  };
  if (input.stage === 'issue-challenge' && !resolveActor(input.userId))
    throw new OperationError(
      'channel_actor_unavailable',
      'Current actor authority is unavailable.',
      403
    );
  if (input.stage === 'publish-origin' || input.stage === 'publish-disclosure') {
    if (!resolveActor(input.userId))
      throw new OperationError(
        'channel_authority_unavailable',
        'Current authority unavailable.',
        403
      );
    const binding = readDiscordAccountBinding(coreDb.sqlite, input.userId);
    if (
      !binding ||
      binding.discordUserId !== input.discordUserId ||
      binding.revision !== input.bindingRevision
    )
      throw new OperationError('channel_binding_unavailable', 'Current binding unavailable.', 403);
  }
  if (input.stage === 'revoke-binding' && input.selected) {
    const actor = presentControlFacts(input.selected.actor);
    if (
      actor.userId !== input.userId ||
      (actor.kind === 'token' && actor.tokenScope !== 'server-admin') ||
      evaluateOwnedUserOperation(coreDb, actor, input.userId, 'api.call', true).effect !== 'allow'
    )
      throw new OperationError(
        'channel_authority_unavailable',
        'Current authority unavailable.',
        403
      );
    if (
      readDiscordAccountBinding(coreDb.sqlite, input.userId)?.revision !== input.selected.revision
    )
      throw new OperationError('channel_binding_unavailable', 'Current binding unavailable.', 409);
  }
  // The same production clock and UUID source stay at their original SQL expression points.
  return applyDiscordStageInDb(coreDb.sqlite, input, {
    now: Date.now,
    newRequestId: randomUUID,
    resolveActor,
    administratorAtEvent: (userId) => {
      if (!isCanonicalUserActive(coreDb, userId)) return false;
      const user = coreDb.sqlite.prepare('SELECT kind FROM users WHERE id=?').get(userId) as {
        kind: string;
      };
      // The canonical local administrator has no required bearer-token grant.
      return user.kind === 'local'
        ? getLocalUserId(coreDb) === userId
        : user.kind === 'human' && resolveSessionDeploymentAdminTokenId(coreDb, userId) !== null;
    },
  });
}

/** Sends one closed original stage to the existing Core owner with no Main write fallback. */
async function publishDiscordStage(coreDb: CoreDb, input: ControlDiscordChannelInput) {
  const { getControlStoreWorkerClient } = await import('../storage/control-store-worker-client.js');
  return getControlStoreWorkerClient().discordChannel(coreDb, input);
}

/** Boot joins the original incomplete-dispatch reconciliation before the configured adapter serves. */
export async function reconcileIncompleteDiscordInteractions(coreDb: CoreDb): Promise<number> {
  const result = await publishDiscordStage(coreDb, { stage: 'reconcile-incomplete' });
  if (result.stage !== 'reconcile-incomplete') throw new Error('Discord stage reply differs.');
  return result.changes;
}

/** Revokes the original binding/challenge tuple even when no adapter is configured. */
export async function revokeDiscordAccountBinding(
  coreDb: CoreDb,
  userId: string,
  selected?: Extract<ControlDiscordChannelInput, { stage: 'revoke-binding' }>['selected']
): Promise<void> {
  await publishDiscordStage(coreDb, {
    stage: 'revoke-binding',
    userId,
    ...(selected ? { selected } : {}),
  });
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
  const coreDb = options.nativeCoreDb;
  if (coreDb && (coreDb.sqlite !== sqlite || options.mode === undefined))
    throw new ControlStoreWorkerError('invalid-request', 'not-committed');
  const mode = options.mode ?? 'server';

  /** One family dispatch preserves the distinct original SQL stage and its acknowledgement. */
  async function writeStage<S extends ControlDiscordChannelInput['stage']>(
    input: Extract<ControlDiscordChannelInput, { stage: S }>
  ): Promise<Extract<ControlDiscordChannelResult, { stage: S }>> {
    const result = coreDb
      ? await publishDiscordStage(coreDb, input)
      : applyDiscordStageInDb(sqlite, input, {
          now,
          newRequestId: options.newRequestId,
          resolveActor: options.resolveActor,
          administratorAtEvent: () => false,
        });
    if (result.stage !== input.stage)
      throw new ControlStoreWorkerError('invalid-request', 'unknown');
    return result as Extract<ControlDiscordChannelResult, { stage: S }>;
  }

  /** A prior unfinished dispatch is uncertain; boot joins this before serving, never replaying it. */
  async function reconcileIncompleteInteractions(): Promise<number> {
    return (await writeStage({ stage: 'reconcile-incomplete' })).changes;
  }

  /** Reads the current active account binding for a Core user. */
  function binding(actor: Actor): DiscordAccountBinding | null {
    return readDiscordAccountBinding(sqlite, actor.userId);
  }

  /** Starts a one-use, five-minute challenge for the authenticated Core user, storing only its digest. */
  async function beginPairing(actor: Actor): Promise<{ challenge: string; expiresAt: number }> {
    if (options.resolveActor(actor.userId)?.userId !== actor.userId)
      throw new OperationError(
        'channel_actor_unavailable',
        'Current actor authority is unavailable.',
        403
      );
    const challenge = randomBytes(32).toString('base64url');
    const expiresAt = now() + discordFreshnessMs;
    await writeStage({
      stage: 'issue-challenge',
      mode,
      userId: actor.userId,
      digest: discordDigest(challenge),
      expiresAt,
    });
    if (options.resolveActor(actor.userId)?.userId !== actor.userId)
      throw new OperationError(
        'channel_actor_unavailable',
        'Current actor authority is unavailable.',
        403
      );
    return { challenge, expiresAt };
  }

  /** Revokes the binding and every unused challenge before later responses or sends can use them. */
  async function revoke(actor: Actor): Promise<void> {
    await writeStage({ stage: 'revoke-binding', userId: actor.userId });
  }

  /** Atomically consumes external account proof and the Core-issued pairing challenge. */
  async function pair(discordUserId: string, challenge: string): Promise<string> {
    let admittedUserId: string | null = null;
    if (coreDb) {
      // Current Main admission remains before post; native deciding authority rereads it.
      const row = sqlite
        .prepare(
          'SELECT user_id AS userId FROM discord_pairing_challenges WHERE digest = ? AND consumed_at IS NULL AND expires_at > ?'
        )
        .get(discordDigest(challenge), now()) as { userId: string } | undefined;
      if (row && options.resolveActor(row.userId)?.userId === row.userId)
        admittedUserId = row.userId;
    }
    return (
      await writeStage({
        stage: 'consume-challenge',
        mode,
        discordUserId,
        digest: discordDigest(challenge),
        admittedUserId,
      })
    ).text;
  }

  /** Dispatches exactly one verified event after its durable deduplication fence commits. */
  async function handleVerified(input: VerifiedDiscordInteraction): Promise<DiscordReply> {
    const verified = readVerifiedDiscordCommand(input, options);
    if (verified.state === 'ping') return { type: 1 };
    if (verified.state === 'outside-dm')
      return reply(
        'Use a private DM with the OpenKit bot. Unsupported input must be handled in OpenKit.'
      );
    if (verified.state === 'unsupported')
      return reply('This interaction is unsupported. Use OpenKit.');
    const { eventId, command } = verified;
    const { receipt } = await writeStage({
      stage: 'reserve-inbound',
      eventId,
      payloadDigest: input.payloadDigest,
      discordUserId: command.user.id,
    });
    if ('existing' in receipt) {
      if (receipt.existing.payloadDigest !== input.payloadDigest)
        return reply('Interaction identity conflict. Inspect the request in OpenKit.');
      return reply(
        receipt.existing.state === 'settled'
          ? 'This interaction was already handled. Inspect the request in OpenKit or inspect it again in Discord.'
          : 'The response outcome is unknown. Inspect the request in OpenKit before a new attempt.'
      );
    }
    let submitted = false;
    let settlementStarted = false;
    let settlementFinished = false;
    let protectedReplyAdmission: (() => void) | undefined;
    /** Never repost settlement when its own acknowledgement is unavailable. */
    async function settleReceipt(state: 'settled' | 'response-unknown') {
      settlementStarted = true;
      await settle(eventId, state);
      settlementFinished = true;
    }
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
            ? await pair(command.user.id, values.challenge!)
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
          kind: 'session',
        };
        const target = {
          workspaceId: values.workspace!,
          threadId: values.thread!,
          pendingRequestId: values.request!,
        };
        if (subcommand.name === 'approve') {
          text = 'Approval grants require the complete App confirmation.';
          await settleReceipt('settled');
          const link =
            options.resolveActor(actor.userId)?.userId === actor.userId &&
            binding(actor)?.revision === row.revision
              ? options.requestLink({ actor, ...target })
              : null;
          return reply(text, link ?? appUrl.origin);
        }
        if (options.inspectPending({ actor, ...target }).status === 'app-only') {
          await settleReceipt('settled');
          // Repeat current source and binding admission after the acknowledgement gap.
          const link =
            options.resolveActor(actor.userId)?.userId === actor.userId &&
            binding(actor)?.revision === row.revision &&
            options.inspectPending({ actor, ...target }).status === 'app-only'
              ? options.requestLink({ actor, ...target })
              : null;
          return reply(DISCORD_AUTOMATION_NOTICE, link ?? appUrl.origin);
        }
        if (subcommand.name !== 'inspect') {
          const readCurrentDisclosure = () =>
            sqlite
              .prepare(`SELECT content_digest AS contentDigest,kind FROM discord_disclosures
            WHERE token_digest = ? AND discord_user_id = ? AND binding_revision = ? AND workspace_id = ? AND thread_id = ? AND pending_request_id = ? AND expires_at > ?`)
              .get(
                discordDigest(values.disclosure!),
                command.user.id,
                row.revision,
                target.workspaceId,
                target.threadId,
                target.pendingRequestId,
                now()
              ) as { contentDigest: string; kind: string } | undefined;
          const disclosure = readCurrentDisclosure();
          if (!disclosure)
            throw new OperationError(
              'channel_disclosure_unavailable',
              'Current disclosure unavailable.',
              409
            );
          const view = currentView(actor, target);
          if (view.kind !== disclosure.kind || discordViewDigest(view) !== disclosure.contentDigest)
            throw new OperationError(
              'channel_disclosure_changed',
              'The exact effect or question changed.',
              409
            );
          if ((subcommand.name === 'answer') !== (view.kind === 'user-input'))
            throw new OperationError('unsupported_request_kind', 'Unsupported request kind.', 400);
          // Preserve the original initial source/disclosure checks before origin publication.
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
          const origin = await writeStage({
            stage: 'publish-origin',
            mode,
            userId: actor.userId,
            discordUserId: command.user.id,
            bindingRevision: row.revision,
            operationId,
            workspaceId: view.workspaceId,
            threadId: view.threadId,
            pendingRequestId: view.pendingRequestId,
            turnId: view.turnId,
            eventId,
            requestId: receipt.requestId,
          });
          if (origin.changes !== 1)
            throw new OperationError(
              'channel_origin_unavailable',
              'The required channel response origin could not be retained.',
              503
            );
          admitAfterStage(actor, target, row.revision, view);
          // The original expiring proof must still be current after the new acknowledgement gap.
          const currentDisclosure = readCurrentDisclosure();
          if (!currentDisclosure)
            throw new OperationError(
              'channel_disclosure_unavailable',
              'Current disclosure unavailable.',
              409
            );
          if (
            currentDisclosure.kind !== view.kind ||
            currentDisclosure.contentDigest !== discordViewDigest(view)
          )
            throw new OperationError(
              'channel_disclosure_changed',
              'The exact effect or question changed.',
              409
            );
          // No await separates these repeated current checks from native invocation.
          submitted = true;
          await options.invoke(operationId, input, actor);
          text =
            'OpenKit accepted the response. Inspect the request in OpenKit for its current decision and execution outcome.';
        } else {
          const view = currentView(actor, target);
          const token = randomBytes(32).toString('base64url');
          text = `${view.content}\nDigest: ${discordViewDigest(view)}\nDisclosure: ${token}\nUse this disclosure only for this exact request. It expires in five minutes.`;
          if (text.length + appLink.length + 1 > 2_000)
            throw new OperationError(
              'channel_disclosure_too_large',
              'The complete request requires OpenKit.',
              400
            );
          await writeStage({
            stage: 'publish-disclosure',
            mode,
            userId: actor.userId,
            tokenDigest: discordDigest(token),
            discordUserId: command.user.id,
            bindingRevision: row.revision,
            workspaceId: target.workspaceId,
            threadId: target.threadId,
            pendingRequestId: target.pendingRequestId,
            kind: view.kind,
            contentDigest: discordViewDigest(view),
            expiresAt: now() + discordFreshnessMs,
          });
          protectedReplyAdmission = () => admitAfterStage(actor, target, row.revision, view);
          protectedReplyAdmission();
        }
      }
      await settleReceipt('settled');
      protectedReplyAdmission?.();
      return reply(text);
    } catch (error) {
      if (settlementStarted && !settlementFinished) throw error;
      if (error instanceof ControlStoreWorkerError && error.commit === 'unknown')
        return reply(
          'The response outcome is unknown. Inspect the request in OpenKit before a new attempt.'
        );
      const unknown = submitted && (!(error instanceof OperationError) || error.status >= 500);
      if (!settlementStarted) await settleReceipt(unknown ? 'response-unknown' : 'settled');
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
      throw new OperationError(
        view.status === 'app-only' ? 'channel_response_not_admitted' : view.code,
        'The request is unavailable.',
        409
      );
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

  /** Rechecks the original actor, binding, source and exact content after a native acknowledgement. */
  function admitAfterStage(
    actor: Actor,
    target: { workspaceId: string; threadId: string; pendingRequestId: string },
    revision: string,
    original: Extract<DiscordPendingView, { status: 'available' }>
  ): void {
    if (options.resolveActor(actor.userId)?.userId !== actor.userId)
      throw new OperationError(
        'channel_authority_unavailable',
        'Current authority unavailable.',
        403
      );
    if (binding(actor)?.revision !== revision)
      throw new OperationError('channel_binding_unavailable', 'Current binding unavailable.', 403);
    const current = currentView(actor, target);
    if (
      current.kind !== original.kind ||
      discordViewDigest(current) !== discordViewDigest(original)
    )
      throw new OperationError(
        'channel_disclosure_changed',
        'The exact effect or question changed.',
        409
      );
  }

  /** Stores no request content, answers, captured arguments or interaction tokens. */
  async function settle(eventId: string, state: 'settled' | 'response-unknown'): Promise<void> {
    await writeStage({ stage: 'settle-inbound', eventId, state });
  }

  return {
    reconcileIncompleteInteractions,
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
