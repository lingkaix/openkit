import type Database from 'better-sqlite3';
import type { CommunicationCredentials } from '../auth/credential-operations.js';
import { type Actor, isDeploymentAdminActor } from '../auth/identity.js';
import type {
  CommunicationDiscordChannelOptions,
  DiscordChannelStorage,
} from '../channels/discord-owner.js';
import { OperationError } from '../operation-error-core.js';
import { readCommunicationDisclosure } from './communication-disclosure-native.js';
import { admitDiscordOwners, requireChannelStorage } from './communication-inbound.js';
import {
  type ChannelOriginClaim,
  readChannelInboundProof,
} from './communication-inbound-native.js';
import {
  readCommunicationBinding,
  readCommunicationBindingForAccount,
  readPairingChallengeUser,
} from './communication-pairing-native.js';
import type { CommunicationStore } from './communication-port.js';
import {
  type DiscordRetentionAck,
  type DiscordRetentionCommand,
  type DiscordRetentionSelection,
  DiscordRetentionSelectionSchema,
} from './communication-retention-native.js';
import type { StorageResult, StorageStatus, StorageUnavailable } from './storage-owner.js';

type Result<T> = StorageResult<'communication', T>;
type RetentionResult = Result<DiscordRetentionAck> | StorageUnavailable<'control-kernel'>;

export interface PairingAuthorityObservation {
  readonly userId: string;
  readonly administratorAtEvent: boolean;
}

/** A2 maps these authorized posting calls to the owner worker and its durable ACK. */
export interface CommunicationDiscordWrites {
  stageEnvelope: DiscordChannelStorage['stageEnvelope'];
  revokeChallenges(userId: string, authority: PairingAuthorityObservation): Promise<Result<void>>;
  issueChallenge(
    input: Parameters<DiscordChannelStorage['issueChallenge']>[0],
    authority: PairingAuthorityObservation
  ): Promise<Result<void>>;
  pair(
    input: Parameters<CommunicationStore['pair']>[0],
    authority: PairingAuthorityObservation
  ): ReturnType<CommunicationStore['pair']>;
  unbind(
    input: Parameters<CommunicationStore['unbind']>[0],
    authority: PairingAuthorityObservation
  ): ReturnType<CommunicationStore['unbind']>;
  writeDisclosure(
    input: Parameters<DiscordChannelStorage['writeDisclosure']>[0],
    authority: PairingAuthorityObservation
  ): Promise<Result<void>>;
  claimOrigin(claim: ChannelOriginClaim): Promise<Result<boolean>>;
  settleInbound: DiscordChannelStorage['settleInbound'];
  settleHandled: DiscordChannelStorage['settleHandled'];
  settleRefusal: DiscordChannelStorage['settleRefusal'];
  applyRetention(
    command: DiscordRetentionCommand,
    authority: PairingAuthorityObservation
  ): Promise<Result<DiscordRetentionAck>>;
}

/** Holds current Kernel authority over the original file-local mutation and ACK. */
export type WithPairingAuthority = <T>(
  selection: { readonly userId: string; readonly actor?: Actor },
  post: (authority: PairingAuthorityObservation) => Promise<Result<T>>
) => Promise<Result<T>>;

/** Holds one recipient's binding decision against overlapping communication effects. */
export type WithCommunicationBinding = <Result>(
  userId: string,
  effect: () => Promise<Result>
) => Promise<Result>;

/** Composes the binding admission shared by DM commands, credential unbind and Attention. */
export function createCommunicationDiscord(input: {
  readonly status: () => StorageStatus<'communication'>;
  readonly read: <T>(read: (sqlite: Database.Database) => T) => Result<T>;
  readonly writer: CommunicationDiscordWrites;
  readonly withAuthority: WithPairingAuthority;
  readonly pairingAuditReady: () => void;
  readonly kernel?: CommunicationDiscordChannelOptions['kernel'];
  readonly retention?: {
    readonly withProducerDrain: (post: () => Promise<RetentionResult>) => Promise<RetentionResult>;
    readonly readExpiryAgeMs?: () => number | undefined;
  };
  readonly now?: () => number;
}): {
  readonly storage: DiscordChannelStorage;
  readonly unbindCredential: CommunicationCredentials['unbind'];
  readonly withBinding: WithCommunicationBinding;
  readonly runRetention: (
    actor: Actor,
    requestId: string,
    selection: DiscordRetentionSelection
  ) => Promise<RetentionResult>;
} {
  const { read, writer, withAuthority } = input;
  const now = input.now ?? Date.now;
  const posting = new Set<string>();

  // Refuse overlapping work for a binding instead of queueing more side effects in Main.
  async function withBinding<T>(userId: string, effect: () => Promise<T>): Promise<T> {
    if (posting.has(userId))
      throw new OperationError(
        'channel_storage_busy',
        'The current channel effect is still being checked.',
        503
      );
    posting.add(userId);
    try {
      return await effect();
    } finally {
      posting.delete(userId);
    }
  }

  function revoke(selection: Parameters<CommunicationStore['unbind']>[0], actor: Actor) {
    return withBinding(selection.userId, async () => {
      const result = await withAuthority({ userId: selection.userId, actor }, (authority) =>
        writer.unbind(selection, authority)
      );
      if (result.state === 'ready') input.pairingAuditReady();
      return result;
    });
  }

  const storage: DiscordChannelStorage = {
    status: input.status,
    stageEnvelope: writer.stageEnvelope,
    readBinding: (userId) => read((sqlite) => readCommunicationBinding(sqlite, userId)),
    resolveBinding: (externalAccountId) =>
      read((sqlite) => readCommunicationBindingForAccount(sqlite, externalAccountId)),
    revokeChallenges: (actor) =>
      withBinding(actor.userId, () =>
        withAuthority({ userId: actor.userId, actor }, (authority) =>
          writer.revokeChallenges(actor.userId, authority)
        )
      ),
    issueChallenge: (challenge, actor) =>
      withBinding(challenge.userId, () =>
        withAuthority({ userId: challenge.userId, actor }, (authority) =>
          writer.issueChallenge(challenge, authority)
        )
      ),
    pair: async (pairing) => {
      const user = read((sqlite) =>
        readPairingChallengeUser(sqlite, pairing.challengeDigest, now())
      );
      if (user.state !== 'ready') return user;
      if (!user.value)
        throw new OperationError(
          'channel_challenge_unavailable',
          'Pairing challenge unavailable.',
          409
        );
      const userId = user.value;
      return withBinding(userId, async () => {
        const result = await withAuthority({ userId }, (authority) =>
          writer.pair(pairing, authority)
        );
        if (result.state === 'ready') input.pairingAuditReady();
        return result;
      });
    },
    unbind: revoke,
    readDisclosure: (selection) =>
      read((sqlite) => readCommunicationDisclosure(sqlite, selection, now())),
    writeDisclosure: (disclosure) =>
      withBinding(disclosure.userId, () =>
        withAuthority({ userId: disclosure.userId }, (authority) =>
          writer.writeDisclosure(disclosure, authority)
        )
      ),
    decideInbound: ({ origin, inputHash }, decide) =>
      withBinding(origin.userId, async () => {
        const binding = requireChannelStorage(storage.readBinding(origin.userId));
        if (!binding || binding.revision !== origin.bindingRevision)
          return { state: 'ready', value: { state: 'refused' } };
        const disclosure = requireChannelStorage(
          storage.readDisclosure({
            workspaceId: origin.workspaceId,
            threadId: origin.threadId,
            pendingRequestId: origin.pendingRequestId,
            userId: origin.userId,
            externalAccountId: binding.externalAccountId,
            bindingRevision: binding.revision,
            tokenDigest: origin.disclosureDigest,
          })
        );
        if (!disclosure) return { state: 'ready', value: { state: 'refused' } };
        const claim = await writer.claimOrigin({ origin, inputHash });
        if (claim.state !== 'ready') return claim;
        if (!claim.value) return { state: 'ready', value: { state: 'inspect-original' } };
        return { state: 'ready', value: { state: 'completed', reply: await decide() } };
      }),
    readInboundProof: (envelope, origin) =>
      read((sqlite) => readChannelInboundProof(sqlite, envelope, origin)),
    settleInbound: writer.settleInbound,
    settleHandled: writer.settleHandled,
    settleRefusal: writer.settleRefusal,
  };

  return {
    storage,
    withBinding,
    runRetention: async (actor, requestId, selection) => {
      if (!isDeploymentAdminActor(actor))
        throw new OperationError('forbidden', 'Current deployment administrator required.', 403);
      const retention = input.retention;
      const admission = admitDiscordOwners(storage, input.kernel);
      if (admission.state !== 'ready') return admission;
      const action = DiscordRetentionSelectionSchema.parse(selection);
      if (!retention || (action.kind === 'expire' && retention.readExpiryAgeMs?.() === undefined))
        return { state: 'unavailable', owner: 'communication', reason: 'disabled' };

      return retention.withProducerDrain(async () => {
        const current = admitDiscordOwners(storage, input.kernel);
        if (current.state !== 'ready') return current;
        return withAuthority({ userId: actor.userId, actor }, (authority) =>
          writer.applyRetention({ requestId, userId: actor.userId, action }, authority)
        );
      });
    },
    unbindCredential: async ({ actor, bindingRevision }) => {
      const result = await revoke({ userId: actor.userId, bindingRevision }, actor);
      return result.state === 'ready' ? { state: 'ready', value: undefined } : result;
    },
  };
}
