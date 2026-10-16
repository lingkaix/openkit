import { randomUUID } from 'node:crypto';
import type { CHANNEL_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import type { OpenKitConfig } from '@openkit/config-schema';
import type { Actor } from './auth/identity.js';
import { currentWorkspaceAuthority } from './auth/operation-authorizer.js';
import { isThreadIdVisible } from './auth/thread-visibility.js';
import { isCanonicalUserActive } from './auth/user-lifecycle.js';
import {
  createDiscordChannel,
  type DiscordPendingView,
  readDiscordAccountBinding,
  revokeDiscordAccountBinding,
} from './channels/discord.js';
import type { createDiscordRestTransport } from './channels/discord-rest.js';
import type { CoreMode } from './config/mode.js';
import type { FsStore } from './lib/store.js';
import {
  type AttentionDelivery,
  AttentionError,
  AttentionNotifications,
} from './notifications/attention.js';
import { type FamilyImplementations, publicOperationActor } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { projectApprovalEffect } from './runtime/pending-request-disclosure.js';
import { requireUsableRecord } from './runtime/pending-request-flow.js';
import {
  canonicalJsonText,
  listThreadPendingRequests,
  type PendingRequestRecord,
} from './runtime/pending-requests.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';

/** Private Discord transport injected by startup or deterministic external-boundary tests. */
export type DiscordAttentionTransport = ReturnType<typeof createDiscordRestTransport>;

/** Binds external delivery to current Core request owners, without granting channel-specific decision authority. */
export function createChannelServices(input: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly mode: CoreMode;
  readonly publicBaseUrl?: string;
  readonly discordConfig?: NonNullable<OpenKitConfig['channels']>['discord'];
  readonly transport?: DiscordAttentionTransport;
  readonly openWorkspace: (workspaceId: string) => WorkspaceDb;
  readonly invokePending: (
    id: 'approval.respond' | 'question.answer',
    value: unknown,
    actor: Actor
  ) => Promise<unknown>;
}) {
  const { coreDb, store } = input;
  const ordinaryActor = (userId: string): Actor | null =>
    isCanonicalUserActive(coreDb, userId) && (input.mode !== 'local' || userId === LOCAL_USER_ID)
      ? { kind: input.mode === 'local' ? 'local' : 'session', userId }
      : null;

  /** Loads one exact, currently visible source before disclosure, decision, or external attention. */
  function currentRequest(
    actor: Actor,
    source: { workspaceId: string; threadId: string; requestId: string },
    pendingOnly = true
  ): PendingRequestRecord | null {
    if (
      !ordinaryActor(actor.userId) ||
      !currentWorkspaceAuthority(
        coreDb,
        source.workspaceId,
        { kind: 'user', id: actor.userId },
        'thread.read',
        true,
        ordinaryActor(actor.userId)!
      ) ||
      !isThreadIdVisible(store, source.workspaceId, source.threadId, actor.userId)
    )
      return null;
    const db = input.openWorkspace(source.workspaceId);
    try {
      const record = requireUsableRecord(
        store,
        db.sqlite,
        source.requestId,
        source.workspaceId,
        source.threadId
      );
      return (!pendingOnly || record.state === 'pending') &&
        record.responsibleUserId === actor.userId &&
        store.getThread(source.workspaceId, source.threadId).status !== 'archived'
        ? record
        : null;
    } finally {
      db.sqlite.close();
    }
  }

  /** Complete effect and question projection; unsupported or stale requests never become a channel command. */
  function inspectPending(query: {
    actor: Actor;
    workspaceId: string;
    threadId: string;
    pendingRequestId: string;
  }): DiscordPendingView {
    try {
      const record = currentRequest(query.actor, { ...query, requestId: query.pendingRequestId });
      if (!record) return { status: 'unavailable', code: 'request_unavailable' };
      if (record.kind === 'approval') {
        const effect = projectApprovalEffect({ record, store, coreDb, actor: query.actor });
        if (effect.status !== 'available')
          return { status: 'unavailable', code: 'effect_unavailable' };
        return {
          status: 'available',
          kind: 'approval',
          workspaceId: record.workspaceId,
          threadId: record.threadId,
          pendingRequestId: record.requestId,
          turnId: record.raisingTurnId,
          content: effect.detail,
          responseAllowed: true,
        };
      }
      const questions = record.questions;
      if (!questions?.length || questions.some((question) => question.isSecret !== false))
        return { status: 'unavailable', code: 'secret_input_not_supported' };
      return {
        status: 'available',
        kind: 'user-input',
        workspaceId: record.workspaceId,
        threadId: record.threadId,
        pendingRequestId: record.requestId,
        turnId: record.raisingTurnId,
        content: canonicalJsonText(questions),
        responseAllowed: true,
      };
    } catch {
      return { status: 'unavailable', code: 'request_unavailable' };
    }
  }

  const attentionPath = (source: { workspaceId: string; threadId: string; requestId: string }) => {
    const thread = store.getThread(source.workspaceId, source.threadId);
    const route = thread.visibility === 'private' ? 'chat' : 'tasks';
    return `/${route}/${encodeURIComponent(source.workspaceId)}/${encodeURIComponent(source.threadId)}?requestId=${encodeURIComponent(source.requestId)}`;
  };
  const notifications = new AttentionNotifications(coreDb.sqlite, { buildAppPath: attentionPath });
  notifications.reconcileIncompleteAttempts();
  if (input.discordConfig && !input.publicBaseUrl)
    throw new OperationError(
      'channel_configuration_invalid',
      'A public HTTPS App origin is required.',
      503
    );
  const discord = input.discordConfig
    ? createDiscordChannel({
        sqlite: coreDb.sqlite,
        ...input.discordConfig,
        newRequestId: randomUUID,
        appBaseUrl: input.publicBaseUrl!,
        requestLink: (query) => {
          try {
            const record = currentRequest(
              query.actor,
              { ...query, requestId: query.pendingRequestId },
              false
            );
            return record ? new URL(attentionPath(record), input.publicBaseUrl!).href : null;
          } catch {
            return null;
          }
        },
        resolveActor: ordinaryActor,
        inspectPending,
        invoke: input.invokePending,
      })
    : null;

  /** Retains readable transport history after a Core decision without granting a later send. */
  function readableDelivery(delivery: AttentionDelivery): boolean {
    try {
      const actor = ordinaryActor(delivery.recipientUserId);
      const record = actor && currentRequest(actor, delivery.source, false);
      return Boolean(
        record &&
          delivery.source.kind ===
            (record.kind === 'approval' ? 'approval-request' : 'user-input-request')
      );
    } catch {
      return false;
    }
  }

  /** Rechecks the recipient and source; transport also calls it after asynchronous DM preparation. */
  function eligible(delivery: AttentionDelivery): boolean {
    try {
      const actor = ordinaryActor(delivery.recipientUserId);
      const record = actor && currentRequest(actor, delivery.source);
      return Boolean(
        record &&
          delivery.source.kind ===
            (record.kind === 'approval' ? 'approval-request' : 'user-input-request')
      );
    } catch {
      return false;
    }
  }

  /** Sends one conditional attempt, with a second authority check at the actual message boundary. */
  async function send(actor: Actor, deliveryId: string, expectedAttemptId: number | null) {
    const delivery = notifications.getForActor(deliveryId, actor.userId, eligible);
    if (!delivery)
      throw new OperationError('notification_unavailable', 'The notification is unavailable.', 404);
    const bound = discord?.binding(actor);
    if (!bound || !input.transport)
      throw new OperationError('channel_unavailable', 'Discord sending is unavailable.', 503);
    try {
      const result = await notifications.deliver(
        {
          deliveryId,
          recipientUserId: actor.userId,
          channel: 'discord',
          expectedAttemptId,
          retry: expectedAttemptId !== null,
        },
        {
          isEligible: (candidate) =>
            eligible(candidate) && discord?.binding(actor)?.revision === bound.revision,
          transport: async (payload) => {
            const result = await input.transport!.sendAttention({
              discordUserId: bound.discordUserId,
              appPath: payload.appPath,
              beforeSend: () =>
                eligible(delivery) && discord?.binding(actor)?.revision === bound.revision,
            });
            return { status: result.status };
          },
        }
      );
      return { ...result, appPath: attentionPath(result.source) };
    } catch (error) {
      if (error instanceof AttentionError)
        throw new OperationError(
          error.code,
          'The delivery attempt is unavailable or changed. Refresh before retrying.',
          409,
          { cause: error }
        );
      throw error;
    }
  }

  /** Publishes only an exact source reference; a notification write cannot change the Core request. */
  function attentionRaised(record: PendingRequestRecord): void {
    if (record.state !== 'pending') return;
    const actor = ordinaryActor(record.responsibleUserId);
    if (!actor || !currentRequest(actor, record)) return;
    const delivery = notifications.enqueue({
      source: {
        workspaceId: record.workspaceId,
        threadId: record.threadId,
        requestId: record.requestId,
        kind: record.kind === 'approval' ? 'approval-request' : 'user-input-request',
      },
      recipientUserId: record.responsibleUserId,
    });
    if (delivery.status === 'queued' && discord?.binding(actor) && input.transport)
      void send(actor, delivery.id, null).catch(() => undefined);
  }

  /** Re-enumerates the request authority at boot or binding change, without a notification runner or implicit retry. */
  function recoverAttention(): void {
    for (const workspace of store.listWorkspaces()) {
      try {
        const db = input.openWorkspace(workspace.id);
        try {
          for (const thread of store.listThreads(workspace.id)) {
            for (const record of listThreadPendingRequests(db.sqlite, workspace.id, thread.id)) {
              try {
                attentionRaised(record);
              } catch {
                /* An unavailable projection never settles or blocks a Core request. */
              }
            }
          }
        } finally {
          db.sqlite.close();
        }
      } catch {
        /* Missing source storage skips this projection; a later recovery can inspect it again. */
      }
    }
  }

  return {
    discord,
    binding: (actor: Actor) => readDiscordAccountBinding(coreDb.sqlite, actor.userId),
    revokeBinding: (actor: Actor) => revokeDiscordAccountBinding(coreDb.sqlite, actor.userId),
    notifications,
    inspectPending,
    eligible,
    send,
    attentionRaised,
    recoverAttention,
    attentionPath,
    readableDelivery,
    sendingAvailable: Boolean(discord && input.transport),
  };
}

/** App-owned channel services shared by native settings, the signed Discord entry, and request attention. */
export type ChannelServices = ReturnType<typeof createChannelServices>;

/** Joins user settings and transport observations to their existing domain owners. */
export function createChannelOperationImplementations(services: ChannelServices | undefined) {
  const requireServices = () => {
    if (!services)
      throw new OperationError('channel_unavailable', 'Channel storage is unavailable.', 503);
    return services;
  };
  return {
    'channel.discord.status': (_input, context) => {
      const actor = publicOperationActor(context);
      return {
        configured: Boolean(services?.discord),
        sendingAvailable: services?.sendingAvailable ?? false,
        binding: services?.binding(actor) ?? null,
      };
    },
    'channel.discord.pair': (_input, context) => {
      const discord = requireServices().discord;
      if (!discord)
        throw new OperationError('channel_unavailable', 'Discord is not configured.', 503);
      return discord.beginPairing(publicOperationActor(context));
    },
    'channel.discord.revoke': (_input, context) => {
      requireServices().revokeBinding(publicOperationActor(context));
      return null;
    },
    'notification.list': (input, context) => ({
      items: requireServices()
        .notifications.listForActor(
          publicOperationActor(context).userId,
          input,
          requireServices().readableDelivery
        )
        .map((delivery) => ({
          ...delivery,
          appPath: requireServices().attentionPath(delivery.source),
        })),
    }),
    'notification.send': (input, context) =>
      requireServices().send(
        publicOperationActor(context),
        input.deliveryId,
        input.expectedAttemptId
      ),
  } satisfies FamilyImplementations<typeof CHANNEL_OPERATION_DEFINITIONS>;
}
