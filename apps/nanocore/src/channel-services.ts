import type { CHANNEL_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import type { OpenKitConfig } from '@openkit/config-schema';
import { canonicalJsonText, RequestIdSchema, UserIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { CommunicationCredentials } from './auth/credential-operations.js';
import { type Actor, getLocalUserId } from './auth/identity.js';
import { currentWorkspaceAuthority } from './auth/operation-authorizer.js';
import { isThreadIdVisible } from './auth/thread-visibility.js';
import { isCanonicalUserActive } from './auth/user-lifecycle.js';
import type { DiscordPendingView } from './channels/discord-interaction.js';
import {
  type CommunicationDiscordChannelOptions,
  openCommunicationDiscordChannel,
} from './channels/discord-owner.js';
import type { createDiscordRestTransport } from './channels/discord-rest.js';
import type { CoreMode } from './config/mode.js';
import type { FsStore } from './lib/store.js';
import {
  type AttentionDelivery,
  type AttentionNotifications,
  getAttentionForRecipientInDb,
  pageAttentionForRecipientInDb,
} from './notifications/attention.js';
import { AttentionError } from './notifications/attention-error.js';
import { type FamilyImplementations, publicOperationActor } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { projectApprovalEffect } from './runtime/pending-request-disclosure.js';
import { requireUsableRecord } from './runtime/pending-request-flow.js';
import {
  listThreadPendingRequests,
  type PendingRequestRecord,
} from './runtime/pending-requests.js';
import {
  type CommunicationAttentionOwner,
  observePublishedCommunicationAttention,
  sendCommunicationAttention,
} from './storage/communication-attention.js';
import type { createCommunicationDiscord } from './storage/communication-discord.js';
import {
  admitDiscordOwners,
  inspectPendingDecision,
  requireChannelStorage,
} from './storage/communication-inbound.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import type { StorageResult, StorageUnavailable } from './storage/storage-owner.js';

/** Private Discord transport injected by startup or deterministic external-boundary tests. */
export type DiscordAttentionTransport = ReturnType<typeof createDiscordRestTransport>;

interface ChannelServiceInputs {
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
}

/** Projects live Core and Workspace authority without giving the channel deciding authority. */
function createChannelAuthority(input: ChannelServiceInputs) {
  const { coreDb, store } = input;
  // The local User owner retains this identity; each channel action still checks its active state.
  const localUserId = input.mode === 'local' ? getLocalUserId(coreDb) : undefined;
  const ordinaryActor = (userId: string): Actor | null =>
    isCanonicalUserActive(coreDb, userId) && (input.mode !== 'local' || userId === localUserId)
      ? { kind: 'session', userId }
      : null;

  /** Loads one exact, currently visible source before disclosure, decision, or external attention. */
  function currentRequest(
    actor: Actor,
    source: { workspaceId: string; threadId: string; requestId: string },
    options: { readonly pendingOnly?: boolean } = {}
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
      // Publication decisions and their captured bodies are App-only, including DM denial.
      if (record.governedIntent?.operation === 'channel.publish') return null;
      return (options.pendingOnly === false || record.state === 'pending') &&
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
      if (record.requesterKind === 'automation') return { status: 'app-only' };
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
  const requestLink: CommunicationDiscordChannelOptions['requestLink'] = (query) => {
    try {
      const record = currentRequest(
        query.actor,
        { ...query, requestId: query.pendingRequestId },
        { pendingOnly: false }
      );
      return record ? new URL(attentionPath(record), input.publicBaseUrl!).href : null;
    } catch {
      return null;
    }
  };

  /** Checks the exact recipient and source before either an Attention read or send. */
  function admittedDelivery(delivery: AttentionDelivery, pendingOnly: boolean): boolean {
    if (delivery.source.kind === 'security-notice') return false;
    try {
      const actor = ordinaryActor(delivery.recipientUserId);
      const record = actor && currentRequest(actor, delivery.source, { pendingOnly });
      return Boolean(
        record &&
          delivery.source.kind ===
            (record.kind === 'approval' ? 'approval-request' : 'user-input-request')
      );
    } catch {
      return false;
    }
  }

  return {
    ordinaryActor,
    currentRequest,
    inspectPending,
    attentionPath,
    requestLink,
    readableDelivery: (delivery: AttentionDelivery) => admittedDelivery(delivery, false),
    eligible: (delivery: AttentionDelivery) => admittedDelivery(delivery, true),
  };
}

/** Re-enumerates current Pending Requests at boot or binding change, without implicit retry. */
async function recoverPendingAttention(
  input: Pick<ChannelServiceInputs, 'store' | 'openWorkspace'>,
  attentionRaised: (record: PendingRequestRecord) => Promise<void>
): Promise<void> {
  const { store, openWorkspace } = input;
  for (const workspace of store.listWorkspaces()) {
    try {
      const db = openWorkspace(workspace.id);
      try {
        for (const thread of store.listThreads(workspace.id)) {
          for (const record of listThreadPendingRequests(db.sqlite, workspace.id, thread.id)) {
            try {
              await attentionRaised(record);
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

type ChannelDiscordHandler = Extract<
  ReturnType<typeof openCommunicationDiscordChannel>,
  { state: 'ready' }
>['value'];

/** App operations and signed ingress consume a single selected owner. */
export interface ChannelServices {
  readonly discord: Pick<ChannelDiscordHandler, 'beginPairing' | 'handleVerified'> | null;
  readonly binding: (actor: Actor) => { discordUserId: string; pairedAt: number } | null;
  readonly notifications: Pick<AttentionNotifications, 'pageForActor'>;
  readonly send: (
    actor: Actor,
    deliveryId: string,
    expectedAttemptId: number | null
  ) => Promise<AttentionDelivery & { appPath: string }>;
  readonly attentionRaised: (record: PendingRequestRecord) => Promise<void>;
  readonly recoverAttention: () => Promise<void>;
  readonly attentionPath: (source: AttentionDelivery['source']) => string;
  readonly readableDelivery: (delivery: AttentionDelivery) => boolean;
  readonly sendingAvailable: boolean;
}

export interface DiscordChannelOwners {
  readonly deploymentId: string;
  readonly kernel?: CommunicationDiscordChannelOptions['kernel'];
  readonly communication: ReturnType<typeof createCommunicationDiscord>;
  readonly attention: CommunicationAttentionOwner;
}

export type OwnedChannelServices = ChannelServices & {
  readonly credentials: CommunicationCredentials;
  readonly runRetention: DiscordChannelOwners['communication']['runRetention'];
  readonly reconcileAttention: () => Promise<StorageResult<'communication', number>>;
};

/** Serving composition for the combined switch. Missing owners refuse before any Core fallback. */
export function createCommunicationChannelServices(
  input: ChannelServiceInputs & { readonly discordOwners?: DiscordChannelOwners }
): StorageResult<'communication', OwnedChannelServices> | StorageUnavailable<'control-kernel'> {
  const owners = input.discordOwners;
  if (!owners) return { state: 'unavailable', owner: 'communication', reason: 'missing' };
  const { communication, attention, deploymentId } = owners;
  const admission = admitDiscordOwners(communication.storage, owners.kernel);
  if (admission.state !== 'ready') return admission;
  const { kernel } = admission.value;

  const {
    ordinaryActor,
    currentRequest,
    inspectPending,
    attentionPath,
    requestLink,
    readableDelivery,
    eligible,
  } = createChannelAuthority(input);
  const { discordConfig, publicBaseUrl, transport } = input;
  if (discordConfig && !publicBaseUrl)
    throw new OperationError(
      'channel_configuration_invalid',
      'A public HTTPS App origin is required.',
      503
    );

  const result = discordConfig
    ? openCommunicationDiscordChannel({
        ...discordConfig,
        appBaseUrl: publicBaseUrl!,
        storage: communication.storage,
        deploymentId,
        kernel,
        requestLink,
        resolveActor: ordinaryActor,
        inspectPending,
        inspectPendingDecision: (origin, inputHash) => {
          const db = input.openWorkspace(origin.workspaceId);
          try {
            return inspectPendingDecision(db, origin, new Date().toISOString(), inputHash);
          } finally {
            db.sqlite.close();
          }
        },
        invoke: input.invokePending,
      })
    : null;
  if (result?.state === 'unavailable') return result;
  const discord = result?.value ?? null;

  function binding(actor: Actor) {
    if (!ordinaryActor(actor.userId)) return null;
    return requireChannelStorage(communication.storage.readBinding(actor.userId));
  }

  async function send(actor: Actor, deliveryId: string, expectedAttemptId: number | null) {
    const delivery = requireChannelStorage(
      attention.read((sqlite) =>
        getAttentionForRecipientInDb(sqlite, deliveryId, actor.userId, eligible)
      )
    );
    if (!delivery)
      throw new OperationError('notification_unavailable', 'The notification is unavailable.', 404);
    const selected = binding(actor);
    if (!discord || !transport || !selected)
      throw new OperationError('channel_unavailable', 'Discord sending is unavailable.', 503);
    const source = canonicalJsonText(delivery.source);
    try {
      const sent = requireChannelStorage(
        await attention.withWorkspace(delivery.source.workspaceId, () =>
          sendCommunicationAttention({
            selection: {
              deliveryId,
              recipientUserId: actor.userId,
              expectedAttemptId,
              retry: expectedAttemptId !== null,
            },
            withBinding: communication.withBinding,
            readBinding: (userId) => {
              const current = communication.storage.readBinding(userId);
              return current.state === 'ready' && current.value?.revision !== selected.revision
                ? { state: 'ready', value: null }
                : current;
            },
            writer: attention,
            isEligible: (candidate) =>
              canonicalJsonText(candidate.source) === source && eligible(candidate),
            buildAppPath: attentionPath,
            send: (payload) => transport.sendAttention(payload),
          })
        )
      );
      return { ...sent, appPath: attentionPath(sent.source) };
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

  async function attentionRaised(record: PendingRequestRecord): Promise<void> {
    if (record.requesterKind === 'automation' || record.state !== 'pending') return;
    const actor = ordinaryActor(record.responsibleUserId);
    if (!actor) return;
    const observed = requireChannelStorage(
      await attention.withWorkspace(record.workspaceId, () =>
        observePublishedCommunicationAttention(record, {
          isCurrent: (source) => Boolean(currentRequest(actor, source)),
          enqueue: attention.enqueue,
        })
      )
    );
    const delivery = requireChannelStorage(observed);
    if (delivery?.status === 'queued' && discord && transport && binding(actor))
      void send(actor, delivery.id, null).catch(() => undefined);
  }

  return {
    state: 'ready',
    value: {
      discord,
      binding: (actor) => {
        const selected = binding(actor);
        return (
          selected && { discordUserId: selected.externalAccountId, pairedAt: selected.pairedAt }
        );
      },
      notifications: {
        pageForActor: (userId, page, isReadable) =>
          requireChannelStorage(
            attention.read((sqlite) =>
              pageAttentionForRecipientInDb(sqlite, userId, page, isReadable)
            )
          ),
      },
      send,
      attentionRaised,
      recoverAttention: () => recoverPendingAttention(input, attentionRaised),
      attentionPath,
      readableDelivery,
      sendingAvailable: Boolean(discord && transport),
      credentials: {
        readBinding: communication.storage.readBinding,
        unbind: communication.unbindCredential,
      },
      runRetention: communication.runRetention,
      reconcileAttention: attention.reconcile,
    },
  };
}

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
    'notification.list': (input, context) => {
      const userId = publicOperationActor(context).userId;
      const position = decodeNotificationListCursor(input.cursor, userId);
      const { items: deliveries, hasMore } = requireServices().notifications.pageForActor(
        userId,
        { limit: input.limit, cursor: position },
        requireServices().readableDelivery
      );
      const items = deliveries.map((delivery) => ({
        ...delivery,
        appPath: requireServices().attentionPath(delivery.source),
      }));
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          last && hasMore
            ? Buffer.from(
                JSON.stringify(['notification.list', userId, last.createdAt, last.id])
              ).toString('base64url')
            : null,
      };
    },
    'notification.send': (input, context) =>
      requireServices().send(
        publicOperationActor(context),
        input.deliveryId,
        input.expectedAttemptId
      ),
  } satisfies FamilyImplementations<typeof CHANNEL_OPERATION_DEFINITIONS>;
}

/** A continuation is a recipient-scoped position, not a retained anchor or an authorization grant. */
const notificationListCursorSchema = z.tuple([
  z.literal('notification.list'),
  UserIdSchema,
  z.string().datetime(),
  RequestIdSchema,
]);

/** Reject malformed or foreign positions without reading an anchor or disclosing cursor content. */
function decodeNotificationListCursor(
  cursor: string | undefined,
  userId: string
): { createdAt: string; id: string } | undefined {
  if (cursor === undefined) return undefined;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    const position = notificationListCursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (bytes.toString('base64url') !== cursor || position[1] !== userId) {
      throw new Error('Invalid notification continuation.');
    }
    return { createdAt: position[2], id: position[3] };
  } catch {
    throw new OperationError('invalid_request', 'Invalid notification continuation.', 400);
  }
}
