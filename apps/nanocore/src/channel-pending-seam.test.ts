import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { WORKSPACE_RESOURCE_POLICY_FEATURE, WorkspaceConfigSchema } from '@openkit/config-schema';
import { isRecord } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import type { Actor } from './auth/identity.js';
import { isThreadIdVisible } from './auth/thread-visibility.js';
import {
  createCommunicationChannelServices,
  type DiscordAttentionTransport,
  type DiscordChannelOwners,
} from './channel-services.js';
import { type DiscordReply, verifyDiscordInteraction } from './channels/discord-interaction.js';
import { prepareDiscordPublication } from './channels/discord-publication-intent.js';
import { raiseDiscordPublicationFallback } from './channels/discord-publication-pending.js';
import { FsStore } from './lib/store.js';
import {
  type AttentionDelivery,
  AttentionNotifications,
  enqueueAttentionInDb,
} from './notifications/attention.js';
import { createOperationInvocation } from './operation-composition.js';
import { projectApprovalEffect } from './runtime/pending-request-disclosure.js';
import {
  raiseRecordedPendingRequest,
  requireUsableRecord,
  resolveCommandIntentApproval,
  setPendingRequestAttentionObserver,
} from './runtime/pending-request-flow.js';
import { readPendingRequest } from './runtime/pending-requests.js';
import {
  claimCommunicationAttentionInDb,
  settleCommunicationAttentionInDb,
} from './storage/communication-attention-native.js';
import { createCommunicationDiscord } from './storage/communication-discord.js';
import { inspectPendingDecision, requireChannelStorage } from './storage/communication-inbound.js';
import { readChannelInboundProof } from './storage/communication-inbound-native.js';
import {
  communicationKernelFixture,
  openCommunicationFixture,
} from './storage/communication-worker.test-support.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, serverStoragePath } from './storage/db.js';
import { ensureLayout } from './storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { testEntityId } from './test-support/entity-ids.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from './test-support/local-user.js';
import {
  managedThreadPolicy,
  workspaceMembershipDecisionFixture,
} from './test-support/resource-policy.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { removeWorkspaceMember } from './workspace-sharing.js';

// Intercept the real Worker's genuine post-commit enqueue ACK only. The
// Pending producer, Attention owner, SQLite, claim and transport caller stay real.
const enqueueAck = vi.hoisted(() => ({
  hold: false,
  inKernel: false,
  arrived: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
  worker: undefined as NativeWorker | undefined,
  enqueues: 0,
  claims: 0,
}));
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    get isMainThread() {
      return !enqueueAck.inKernel && actual.isMainThread;
    },
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        const frame: unknown = args[0];
        if (isRecord(frame) && frame.operation === 'communication-owner') {
          if (frame.stage === 'enqueue-attention') enqueueAck.enqueues += 1;
          if (frame.stage === 'claim-attention') enqueueAck.claims += 1;
        }
        return super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const reply = args[0];
        if (
          event === 'message' &&
          isRecord(reply) &&
          reply.status === 'ok' &&
          reply.operation === 'communication-owner' &&
          isRecord(reply.result)
        ) {
          if (reply.result.stage === 'enqueue-attention' && enqueueAck.hold) {
            enqueueAck.worker = this;
            enqueueAck.release = () => super.emit(event, ...args);
            enqueueAck.arrived?.();
            return true;
          }
        }
        return super.emit(event, ...args);
      }
    },
  };
});

const actor: Actor = { userId: testEntityId('usr', 'channel-member'), kind: 'session' };
const applicationId = '123456789012345678';
const discordUserId = '223456789012345678';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('hex');
const databases: CoreDb[] = [];
const directories: string[] = [];
const communicationConnections = new Set<Database.Database>();

/** Observes reply text while preserving the private Discord response predicate. */
function text(reply: DiscordReply): string {
  expect(reply.type).toBe(4);
  if (reply.type !== 4) throw new Error('Expected a private command reply');
  expect(reply.data.flags).toBe(64);
  return reply.data.content;
}

/** Composes real signed channel input, Core authority, native invocation and Pending storage. */
async function fixture(
  kind: 'approval' | 'user-input' = 'approval',
  requesterKind: 'person' | 'automation' = 'person',
  publication = false
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'channel-pending-seam-'));
  directories.push(dataRoot);
  ensureLayout(dataRoot);
  let coreDb = openCoreDb(dataRoot);
  databases.push(coreDb);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  coreDb.sqlite
    .prepare(`INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind)
    SELECT ?, 'Channel member', 'member-' || email, email_verified, created_at, updated_at, 'human' FROM users WHERE id = ?`)
    .run(actor.userId, FIXTURE_LOCAL_USER_ID);
  let store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    workspaceId: DEMO_WORKSPACE_ID,
  });
  coreDb.sqlite
    .prepare(`INSERT INTO workspace_members (workspace_id,user_id,status,joined_at,created_at,updated_at,revision)
    SELECT workspace_id,?,status,joined_at,created_at,updated_at,revision FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
    .run(actor.userId, DEMO_WORKSPACE_ID, FIXTURE_LOCAL_USER_ID);
  const thread = await store.createThread(
    DEMO_WORKSPACE_ID,
    'Exact channel request',
    undefined,
    'conversation',
    {
      ...(requesterKind === 'automation'
        ? {
            visibility: 'private' as const,
            privateOwnerUserId: actor.userId,
            entryPath: 'administration' as const,
          }
        : { visibility: 'workspace' as const }),
    }
  );
  const turn = await store.createTurn(
    DEMO_WORKSPACE_ID,
    thread.id,
    'Request a decision',
    requesterKind === 'automation'
      ? { kind: 'system', id: 'nanocore-pending-request', responsibleUserId: actor.userId }
      : { kind: 'user', id: actor.userId },
    null,
    requesterKind === 'automation'
      ? { triggerSource: { kind: 'automation', summary: 'Security notice' } }
      : {}
  );
  const requestId = kind === 'approval' ? 'ap_channel_seam' : 'ui_channel_seam';
  const itemId = testEntityId('it', `channel-seam-${requestId}`);
  const common = {
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: thread.id,
    raisingTurnId: turn.id,
    responsibleUserId: actor.userId,
    now: turn.startedAt!,
    requestId,
    requestItemId: itemId,
    requesterKind,
  };
  const workspaceDb = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
  applyScopedMigrations(workspaceDb);
  try {
    if (publication) {
      const proposal = prepareDiscordPublication({
        originId: 'origin-fixture',
        botUserId: '101',
        guildId: '102',
        channelId: '103',
        audienceRef: 'audience-fixture',
        authorityRevisionRefs: ['binding:1'],
        influenceDigest: 'influence-fixture',
        renderedBodyRef: 'body-fixture',
        content: `${'a'.repeat(1750)} final citation`,
        review: {
          principal: { kind: 'agent', id: 'reports-fixture' },
          onBehalfOf: null,
          target: {
            kind: 'container',
            container: {
              kind: 'workspace',
              id: DEMO_WORKSPACE_ID,
              owner: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
            },
          },
          influenceSources: ['origin-fixture'],
        },
      });
      if (proposal.kind !== 'proposal') throw new Error('Expected a publication proposal.');
      await raiseDiscordPublicationFallback({
        store,
        sqlite: workspaceDb.sqlite,
        proposal,
        request: common,
        stillAuthorized: () => true,
      });
    } else if (kind === 'approval') {
      await store.createItem({
        id: itemId,
        owner: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
        threadId: thread.id,
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: requestId,
        kind: 'permission',
        title: 'Review exact publication',
        description: 'Publish the chosen page.',
        createdAt: turn.startedAt!,
        completedAt: turn.startedAt!,
      });
      await raiseRecordedPendingRequest(store, workspaceDb.sqlite, {
        ...common,
        kind,
        governedIntent: { action: 'review.apply', page: 'page_exact' },
        approval: {
          kind: 'permission',
          title: 'Review exact publication',
          description: 'Publish the chosen page.',
        },
      });
    } else {
      const questions = [
        {
          id: 'color',
          header: 'Color',
          question: 'Which color?',
          options: null,
          isOther: true,
          isSecret: false,
        },
      ];
      const requestItem = await store.createItem({
        id: itemId,
        owner: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
        threadId: thread.id,
        turnId: turn.id,
        responsibleUserId: actor.userId,
        type: 'user-input-request',
        status: 'completed',
        userInputRequestId: requestId,
        prompt: 'Which color?',
        questions,
        createdAt: turn.startedAt!,
        completedAt: turn.startedAt!,
      });
      await raiseRecordedPendingRequest(
        store,
        workspaceDb.sqlite,
        {
          ...common,
          kind,
          questions,
          questionDigest: 'exact-color-question',
        },
        requestItem
      );
    }
  } finally {
    workspaceDb.sqlite.close();
  }

  const nativeCalls: Array<{ id: string; input: unknown; actor: Actor }> = [];
  const sendAttention = vi
    .fn<DiscordAttentionTransport['sendAttention']>()
    .mockResolvedValue({ status: 'sent', externalMessageId: '523456789012345678' });
  let workspaceAvailable = true;
  const repositoryWorkspaceDb = (workspaceId: string) => {
    if (!workspaceAvailable) throw new Error('Simulated unavailable Workspace storage');
    return openWorkspaceDb(dataRoot, workspaceId);
  };
  const path = serverStoragePath(dataRoot, 'communication');
  const decideReceipt = (origin: Parameters<typeof inspectPendingDecision>[1]) => {
    const proofDb = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const proof = readChannelInboundProof(proofDb, origin.envelope, origin);
      if (!proof?.inputHash || proof.refusalCode) return null;
      const db = repositoryWorkspaceDb(origin.workspaceId);
      try {
        return inspectPendingDecision(db, origin, new Date().toISOString(), proof.inputHash);
      } finally {
        db.sqlite.close();
      }
    } finally {
      proofDb.close();
    }
  };
  let kernelDb = openCoreDb(dataRoot);
  databases.push(kernelDb);
  function openOwner(mode: 'local' | 'server' = 'server') {
    const kernel = communicationKernelFixture(kernelDb, decideReceipt, (effect) => {
      enqueueAck.inKernel = true;
      try {
        return effect();
      } finally {
        enqueueAck.inKernel = false;
      }
    });
    return openCommunicationFixture(coreDb, mode, kernel);
  }
  let owner = await openOwner();
  let communicationDb = new Database(path);
  communicationConnections.add(communicationDb);
  const compose = (configured = true) => {
    const inflightCommands = new WeakMap();
    const invoke = createOperationInvocation({
      coreDb,
      store,
      mode: 'server',
      repositoryWorkspaceDb,
      inflightCommands,
      pendingRequestServices: { coreDb, repositoryWorkspaceDb, inflightCommands },
    });
    return requireChannelStorage(
      createCommunicationChannelServices({
        publicBaseUrl: 'https://openkit.invalid',
        coreDb,
        store,
        mode: 'server',
        discordOwners: owner.owners,
        ...(configured
          ? { discordConfig: { applicationId, publicKey }, transport: { sendAttention } }
          : {}),
        openWorkspace: repositoryWorkspaceDb,
        invokePending: async (id, input, decidingActor) => {
          nativeCalls.push({ id, input, actor: decidingActor });
          return invoke(id, input, { kind: 'public', actor: decidingActor, delivery: 'human' });
        },
      })
    );
  };
  let services = compose();
  function withProducer<T>(effect: () => Promise<T>) {
    return owner.withProducer(effect).then(requireChannelStorage);
  }
  const beginPairing = () => withProducer(() => services.discord!.beginPairing(actor));
  const postSigned = (input: ReturnType<typeof signed>) =>
    withProducer(() =>
      services.discord!.handleVerified(
        verifyDiscordInteraction({ ...input, applicationId, publicKey })
      )
    );
  const retainedAttention = () =>
    new AttentionNotifications(communicationDb).listForActor(actor.userId, {}, () => true);
  const revoke = () =>
    withProducer(async () => {
      const binding = requireChannelStorage(services.credentials.readBinding(actor.userId));
      if (!binding) throw new Error('Expected the original binding.');
      return requireChannelStorage(
        await services.credentials.unbind({
          actor,
          bindingRevision: binding.revision,
        })
      );
    });
  let event = 100000000000000000n;
  const envelope = (command: string, values: Record<string, string>) => ({
    id: String(++event),
    application_id: applicationId,
    type: 2,
    version: 1,
    context: 1,
    channel: { id: '323456789012345678', type: 1 },
    user: { id: discordUserId },
    data: {
      id: '423456789012345678',
      type: 1,
      name: 'openkit',
      options: [
        {
          name: command,
          type: 1,
          options: Object.entries(values).map(([name, value]) => ({ name, value, type: 3 })),
        },
      ],
    },
  });
  const signed = (value: unknown) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = Buffer.from(JSON.stringify(value));
    return {
      body,
      timestamp,
      signature: sign(
        null,
        Buffer.concat([Buffer.from(timestamp), body]),
        keys.privateKey
      ).toString('hex'),
    };
  };
  const send = (command: string, values: Record<string, string>) =>
    postSigned(signed(envelope(command, values)));
  const target = { workspace: DEMO_WORKSPACE_ID, thread: thread.id, request: requestId };
  const record = () => {
    const db = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
    try {
      return readPendingRequest(db.sqlite, requestId)!;
    } finally {
      db.sqlite.close();
    }
  };
  return {
    nativeCalls,
    sendAttention,
    beginPairing,
    postSigned,
    revoke,
    retainedAttention,
    get communicationDb() {
      return communicationDb;
    },
    get owners() {
      return owner.owners;
    },
    withProducer,
    async openLocalOwner() {
      await shutdownControlStoreWorkerClient();
      owner = await openOwner('local');
      services = compose();
    },
    send,
    signed,
    envelope,
    target,
    record,
    async grantInApp() {
      const db = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
      try {
        return await resolveCommandIntentApproval({
          store,
          sqlite: db.sqlite,
          record: record(),
          decision: 'granted',
          actor,
          coreDb,
        });
      } finally {
        db.sqlite.close();
      }
    },
    get coreDb() {
      return coreDb;
    },
    get store() {
      return store;
    },
    get services() {
      return services;
    },
    setWorkspaceAvailable(available: boolean) {
      workspaceAvailable = available;
    },
    async pair() {
      const { challenge } = await beginPairing();
      expect(text(await send('pair', { challenge }))).toContain('paired');
    },
    async disclose() {
      const disclosure = text(await send('inspect', target)).match(
        /Disclosure: ([A-Za-z0-9_-]+)/
      )?.[1];
      expect(disclosure).toBeTruthy();
      return disclosure!;
    },
    async withoutAdapter() {
      const unconfigured = compose(false);
      const invoke = createOperationInvocation({
        coreDb,
        store,
        mode: 'server',
        channelServices: unconfigured,
        communicationCredentialBinding: { communicationCredentials: unconfigured.credentials },
      });
      return async (id: 'channel.discord.status' | 'credential.revoke') => {
        const context = { kind: 'public' as const, actor, delivery: 'human' as const };
        const input =
          id === 'credential.revoke'
            ? {
                kind: 'discord-pairing',
                id: (await invoke('credential.list', {}, context)).items.find(
                  (row) => row.kind === 'discord-pairing'
                )!.id,
              }
            : {};
        return withProducer(() => invoke(id, input, context));
      };
    },
    removeMembership() {
      const result = coreDb.sqlite.transaction(() =>
        removeWorkspaceMember({
          authorization: workspaceMembershipDecisionFixture(
            coreDb,
            FIXTURE_LOCAL_USER_ID,
            DEMO_WORKSPACE_ID
          ),
          coreDb,
          workspaceId: DEMO_WORKSPACE_ID,
          actorUserId: FIXTURE_LOCAL_USER_ID,
          memberUserId: actor.userId,
          expectedRevision: 1,
        })
      )();
      expect(result.kind).toBe('removed');
    },
    /** Removes the current read grant through the standalone store's authored Policy owner. */
    revokeThreadAudience() {
      const config = WorkspaceConfigSchema.parse({
        schemaVersion: 1,
        requiredFeatures: [WORKSPACE_RESOURCE_POLICY_FEATURE],
        workspace: {
          name: store.getWorkspace(DEMO_WORKSPACE_ID).name,
          policy: {
            mediation: managedThreadPolicy({
              workspaceId: DEMO_WORKSPACE_ID,
              threadId: thread.id,
              userId: actor.userId,
            }),
          },
        },
      });
      const directory = join(dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'config');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'workspace.jsonc'), JSON.stringify(config));
    },
    async restart() {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      kernelDb.sqlite.close();
      communicationDb.close();
      coreDb = openCoreDb(dataRoot);
      databases.push(coreDb);
      kernelDb = openCoreDb(dataRoot);
      databases.push(kernelDb);
      communicationDb = new Database(path);
      communicationConnections.add(communicationDb);
      owner = await openOwner();
      store = new FsStore({ dataRoot });
      services = compose();
    },
  };
}

afterEach(async () => {
  enqueueAck.hold = false;
  enqueueAck.release?.();
  enqueueAck.release = undefined;
  enqueueAck.arrived = undefined;
  enqueueAck.worker = undefined;
  await shutdownControlStoreWorkerClient();
  enqueueAck.enqueues = 0;
  enqueueAck.claims = 0;
  for (const db of communicationConnections) if (db.open) db.close();
  communicationConnections.clear();
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Discord to native Pending Request seam', () => {
  it('retains the person publication request and fences App and Discord disclosure without its exact body', async () => {
    const f = await fixture('approval', 'person', true);
    const first = f.record();
    expect(first).toMatchObject({
      requesterKind: 'person',
      responsibleUserId: actor.userId,
      state: 'pending',
      governedIntent: { operation: 'channel.publish' },
    });
    expect(
      f.store.getTurn(first.workspaceId, first.threadId, first.raisingTurnId).items
    ).toContainEqual(
      expect.objectContaining({ id: first.requestItemId, approvalRequestId: first.requestId })
    );
    expect(projectApprovalEffect({ store: f.store, actor, record: first })).toEqual({
      status: 'unavailable',
      reason: 'The exact Discord publication body is unavailable.',
    });
    await expect(f.grantInApp()).rejects.toMatchObject({ code: 'approval_preview_unavailable' });
    await f.pair();
    const view = text(await f.send('inspect', f.target));
    expect(view).not.toContain('Disclosure:');
    expect(view).not.toContain('final citation');
    for (const command of ['deny', 'approve'])
      await f.send(command, { ...f.target, disclosure: 'untrusted-token' });
    expect(f.nativeCalls).toEqual([]);
    await f.restart();
    expect(f.record()).toEqual(first);
  });
  it('keeps automation inspection and answers in the App without a disclosure or native answer', async () => {
    const f = await fixture('user-input', 'automation');
    await f.pair();
    const expected = `OpenKit security: action needed within 24 hours.\nOpen OpenKit: https://openkit.invalid${f.services.attentionPath(f.record())}`;
    expect(text(await f.send('inspect', f.target))).toBe(expected);
    expect(
      text(
        await f.send('answer', {
          ...f.target,
          disclosure: 'untrusted-token',
          answers: '{"color":["blue"]}',
        })
      )
    ).toBe(expected);
    expect(
      f.communicationDb.prepare('SELECT COUNT(*) AS n FROM channel_disclosures').get()
    ).toEqual({
      n: 0,
    });
    expect(f.nativeCalls).toEqual([]);
    expect(f.record().state).toBe('pending');
  });

  it('refuses the deferred security attention flow before reading its legacy notice', async () => {
    const f = await fixture('user-input', 'automation');
    createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: actor.userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    await f.pair();
    const record = f.record();
    const delivery = enqueueAttentionInDb(
      f.communicationDb,
      {
        source: {
          workspaceId: record.workspaceId,
          threadId: record.threadId,
          requestId: record.requestId,
          kind: 'security-notice',
        },
        recipientUserId: actor.userId,
      },
      () => new Date().toISOString()
    );
    const originalEnqueues = enqueueAck.enqueues;
    const readLegacy = vi.spyOn(
      await import('./storage/security-trigger-native.js'),
      'readSecurityAlarmNoticeInDb'
    );
    try {
      expect(f.services.readableDelivery(delivery)).toBe(false);
      await f.services.attentionRaised(record);
      await expect(f.services.send(actor, delivery.id, null)).rejects.toMatchObject({
        code: 'notification_unavailable',
      });
      expect(readLegacy).not.toHaveBeenCalled();
      expect(enqueueAck.enqueues).toBe(originalEnqueues);
      expect(enqueueAck.claims).toBe(0);
      expect(f.sendAttention).not.toHaveBeenCalled();
    } finally {
      readLegacy.mockRestore();
    }
  });

  it('serves admitted Attention with the five Core tables absent and fences its Workspace', async () => {
    const f = await fixture();
    const legacy =
      /discord_account_bindings|discord_pairing_challenges|discord_disclosures|notification_attention|notification_delivery_attempts/;
    expect(
      (
        f.coreDb.sqlite
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
          .pluck()
          .all() as string[]
      ).filter((name) => legacy.test(name))
    ).toEqual([]);
    const sqlite = new Database(':memory:');
    try {
      migrate(drizzle(sqlite), {
        migrationsFolder: fileURLToPath(
          new URL('../drizzle/services/communication/', import.meta.url)
        ),
      });
      const revision = randomUUID();
      sqlite
        .prepare(`
          INSERT INTO channel_account_bindings(revision, channel_kind, external_account_id, user_id, paired_at)
          VALUES (?, 'discord', ?, ?, ?)
        `)
        .run(revision, discordUserId, actor.userId, Date.now());
      const ready = <T>(value: T) => ({ state: 'ready' as const, value });
      const unexpected = async (): Promise<never> => {
        throw new Error('Unexpected Discord writer call.');
      };
      const communication = createCommunicationDiscord({
        read: (read) => ready(read(sqlite)),
        status: () => ({ state: 'ready', owner: 'communication' }),
        withAuthority: unexpected,
        pairingAuditReady: () => {},
        writer: {
          stageEnvelope: unexpected,
          revokeChallenges: unexpected,
          issueChallenge: unexpected,
          pair: unexpected,
          unbind: unexpected,
          writeDisclosure: unexpected,
          claimOrigin: unexpected,
          settleInbound: unexpected,
          settleHandled: unexpected,
          settleRefusal: unexpected,
          applyRetention: unexpected,
        },
      });
      let fenced = true;
      const clock = () => new Date().toISOString();
      const input = {
        coreDb: f.coreDb,
        store: f.store,
        mode: 'server' as const,
        openWorkspace: (workspaceId: string) => openWorkspaceDb(f.coreDb.dataRoot, workspaceId),
        invokePending: unexpected,
      };
      const owners: DiscordChannelOwners = {
        deploymentId: 'communication-serving-fixture',
        communication,
        kernel: {
          status: () => ({ state: 'ready', owner: 'control-kernel' }),
          reserveChannelInbound: unexpected,
          inspectChannelInbound: unexpected,
          bindChannelInboundOrigin: unexpected,
          settleChannelInbound: unexpected,
        },
        attention: {
          read: (read) => ready(read(sqlite)),
          enqueue: async (selection) => ready(enqueueAttentionInDb(sqlite, selection, clock)),
          claim: async (selection) =>
            ready(claimCommunicationAttentionInDb(sqlite, selection, clock)),
          settle: async (selection) => {
            settleCommunicationAttentionInDb(sqlite, selection);
            return ready(undefined);
          },
          reconcile: async () => ready(0),
          withWorkspace: async (_workspaceId, effect) =>
            fenced
              ? { state: 'unavailable', owner: 'communication', reason: 'recovery-required' }
              : ready(await effect()),
        },
      };
      expect(createCommunicationChannelServices(input)).toEqual({
        state: 'unavailable',
        owner: 'communication',
        reason: 'missing',
      });
      expect(
        createCommunicationChannelServices({
          ...input,
          discordOwners: {
            deploymentId: owners.deploymentId,
            communication,
            attention: owners.attention,
          },
        })
      ).toEqual({
        state: 'unavailable',
        owner: 'control-kernel',
        reason: 'missing',
      });
      const opened = createCommunicationChannelServices({ ...input, discordOwners: owners });
      if (opened.state !== 'ready') throw new Error('Expected both owners ready.');
      const services = opened.value;
      const coreQuery = vi.spyOn(f.coreDb.sqlite, 'prepare');
      try {
        expect(services.discord).toBeNull();
        expect(services.credentials.readBinding(actor.userId)).toEqual(
          ready(expect.objectContaining({ revision, externalAccountId: discordUserId }))
        );
        await expect(services.attentionRaised(f.record())).rejects.toMatchObject({
          code: 'channel_storage_unavailable',
        });
        expect(
          services.notifications.pageForActor(actor.userId, {}, services.readableDelivery)
        ).toEqual({
          items: [],
          hasMore: false,
        });
        fenced = false;
        await services.attentionRaised(f.record());
        await services.recoverAttention();
        const page = services.notifications.pageForActor(
          actor.userId,
          {},
          services.readableDelivery
        );
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({
          source: { requestId: f.target.request, kind: 'approval-request' },
          recipientUserId: actor.userId,
          status: 'queued',
        });
        const transport = {
          sendAttention: vi.fn<DiscordAttentionTransport['sendAttention']>().mockResolvedValue({
            status: 'sent',
            externalMessageId: '523456789012345678',
          }),
        };
        const discordInputs = {
          ...input,
          publicBaseUrl: 'https://openkit.invalid',
          discordConfig: { applicationId, publicKey },
          transport,
        };
        expect(createCommunicationChannelServices(discordInputs)).toEqual({
          state: 'unavailable',
          owner: 'communication',
          reason: 'missing',
        });
        expect(transport.sendAttention).not.toHaveBeenCalled();
        const sending = createCommunicationChannelServices({
          ...discordInputs,
          discordOwners: owners,
        });
        if (sending.state !== 'ready') throw new Error('Expected both owners ready for send.');
        fenced = true;
        await expect(sending.value.send(actor, page.items[0]!.id, null)).rejects.toMatchObject({
          code: 'channel_storage_unavailable',
        });
        expect(transport.sendAttention).not.toHaveBeenCalled();
        fenced = false;
        await expect(sending.value.send(actor, page.items[0]!.id, null)).resolves.toMatchObject({
          status: 'sent',
          attempt: { status: 'sent' },
        });
        expect(transport.sendAttention).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            discordUserId,
            appPath: expect.stringContaining(f.target.request),
          })
        );
        expect(coreQuery.mock.calls.filter(([sql]) => legacy.test(sql))).toEqual([]);
      } finally {
        coreQuery.mockRestore();
      }
    } finally {
      sqlite.close();
    }
  });

  it('does not enqueue or send after the responsible recipient loses current membership', async () => {
    const f = await fixture();
    await f.pair();
    const pending = f.record();
    f.removeMembership();
    await f.services.attentionRaised(pending);
    expect(f.retainedAttention()).toEqual([]);
    expect(enqueueAck.enqueues).toBe(0);
    expect(f.sendAttention).not.toHaveBeenCalled();
    expect(f.record()).toEqual(pending);
  });

  it('retains a raised Pending Request when its real asynchronous Attention observer refuses', async () => {
    const f = await fixture();
    const original = f.record();
    setPendingRequestAttentionObserver(f.store, f.services.attentionRaised);
    f.communicationDb.exec(`CREATE TRIGGER refuse_attention_enqueue BEFORE INSERT ON notification_attention
      BEGIN SELECT RAISE(ABORT, 'simulated attention projection refusal'); END`);
    const workspaceDb = openWorkspaceDb(f.coreDb.dataRoot, f.target.workspace);
    try {
      const raised = await raiseRecordedPendingRequest(f.store, workspaceDb.sqlite, {
        workspaceId: f.target.workspace,
        threadId: f.target.thread,
        raisingTurnId: original.raisingTurnId,
        responsibleUserId: actor.userId,
        now: original.createdAt,
        requestId: 'ap_channel_observer_refusal',
        requestItemId: testEntityId('it', 'channel-observer-refusal'),
        requesterKind: 'person',
        kind: 'approval',
        governedIntent: { action: 'review.apply', page: 'page_observer_refusal' },
        approval: {
          kind: 'permission',
          title: 'Review exact publication',
          description: 'Publish the chosen page.',
        },
      });
      expect(raised).toMatchObject({
        requestId: 'ap_channel_observer_refusal',
        state: 'pending',
        claim: 'unclaimed',
      });
      expect(readPendingRequest(workspaceDb.sqlite, raised.requestId)).toEqual(raised);
      expect(
        requireUsableRecord(
          f.store,
          workspaceDb.sqlite,
          raised.requestId,
          f.target.workspace,
          f.target.thread
        )
      ).toEqual(raised);
      expect(f.retainedAttention()).toEqual([]);
      expect(enqueueAck.enqueues).toBe(1);
      expect(f.sendAttention).not.toHaveBeenCalled();
      expect(f.nativeCalls).toEqual([]);
      expect(f.record()).toEqual(original);
    } finally {
      workspaceDb.sqlite.close();
      f.communicationDb.exec('DROP TRIGGER refuse_attention_enqueue');
    }
  });

  it.each(['acknowledged', 'membership-loss', 'source-unavailable', 'lost-ack'] as const)(
    'joins native enqueue before sending and preserves current authority after %s',
    async (outcome) => {
      const f = await fixture();
      await f.pair();
      const pending = f.record();
      enqueueAck.hold = true;
      const committed = new Promise<void>((resolve) => {
        enqueueAck.arrived = resolve;
      });
      let completed = false;
      const publication = f.services.attentionRaised(pending).then(() => {
        completed = true;
      });
      // Retain the original rejection for assertions while holding its ACK.
      void publication.catch(() => undefined);
      try {
        await Promise.race([
          committed,
          publication.then(() => {
            throw new Error('Attention publication completed before its native enqueue ACK.');
          }),
        ]);
        const coldDb = new Database(f.communicationDb.name, { readonly: true });
        let retained: AttentionDelivery;
        try {
          const cold = new AttentionNotifications(coldDb);
          const rows = cold.listForActor(actor.userId, {}, () => true);
          expect(rows).toHaveLength(1);
          retained = rows[0]!;
          expect(retained).toMatchObject({
            source: {
              workspaceId: f.target.workspace,
              threadId: f.target.thread,
              requestId: f.target.request,
              kind: 'approval-request',
            },
            recipientUserId: actor.userId,
            status: 'queued',
            channel: null,
            attempt: null,
          });
        } finally {
          coldDb.close();
        }
        expect(completed).toBe(false);
        expect(enqueueAck.enqueues).toBe(1);
        expect(enqueueAck.claims).toBe(0);
        expect(f.sendAttention).not.toHaveBeenCalled();
        expect(f.record()).toEqual(pending);

        if (outcome === 'membership-loss') f.removeMembership();
        if (outcome === 'source-unavailable') f.setWorkspaceAvailable(false);
        enqueueAck.hold = false;
        if (outcome === 'lost-ack') {
          await enqueueAck.worker!.terminate();
          enqueueAck.release = undefined;
          await expect(publication).rejects.toMatchObject({ code: 'channel_storage_unavailable' });
        } else {
          enqueueAck.release!();
          enqueueAck.release = undefined;
          await publication;
        }
        if (outcome === 'acknowledged') {
          await vi.waitFor(
            () =>
              expect(
                f.retainedAttention().find((delivery) => delivery.id === retained.id)?.status
              ).toBe('sent'),
            { timeout: 15_000 }
          );
          expect(f.sendAttention).toHaveBeenCalledTimes(1);
          expect(enqueueAck.claims).toBe(1);
        } else {
          expect(f.retainedAttention().find((delivery) => delivery.id === retained.id)).toEqual(
            retained
          );
          expect(f.sendAttention).not.toHaveBeenCalled();
          expect(enqueueAck.claims).toBe(0);
        }
        expect(enqueueAck.enqueues).toBe(1);
        expect(f.nativeCalls).toEqual([]);
        expect(f.record()).toEqual(pending);
      } finally {
        enqueueAck.hold = false;
        enqueueAck.release?.();
        enqueueAck.release = undefined;
        await publication.catch(() => undefined);
      }
    }
  );

  it('admits only the recorded local User to pairing in local mode', async () => {
    const f = await fixture();
    const openWorkspace = vi.fn(() => {
      throw new Error('Pairing must not open Workspace storage');
    });
    const invokePending = vi.fn(async () => {
      throw new Error('Pairing must not invoke a Pending Request');
    });
    await f.openLocalOwner();
    const services = requireChannelStorage(
      createCommunicationChannelServices({
        coreDb: f.coreDb,
        store: f.store,
        mode: 'local',
        discordOwners: f.owners,
        publicBaseUrl: 'https://openkit.invalid',
        discordConfig: { applicationId, publicKey },
        openWorkspace,
        invokePending,
      })
    );
    await expect(
      f.withProducer(() =>
        services.discord!.beginPairing({ userId: FIXTURE_LOCAL_USER_ID, kind: 'local' })
      )
    ).resolves.toEqual({ challenge: expect.any(String), expiresAt: expect.any(Number) });
    await expect(f.withProducer(() => services.discord!.beginPairing(actor))).rejects.toMatchObject(
      {
        code: 'channel_authority_unavailable',
      }
    );
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(invokePending).not.toHaveBeenCalled();
  });

  it('skips unavailable Workspace recovery and later queues the exact retained request', async () => {
    const f = await fixture();
    const pending = f.record();
    f.setWorkspaceAvailable(false);
    await expect(f.services.recoverAttention()).resolves.toBeUndefined();
    expect(f.retainedAttention()).toEqual([]);
    expect(f.sendAttention).not.toHaveBeenCalled();
    expect(f.record()).toEqual(pending);

    f.setWorkspaceAvailable(true);
    f.communicationDb.exec(`CREATE TRIGGER refuse_attention_enqueue BEFORE INSERT ON notification_attention
      BEGIN SELECT RAISE(ABORT, 'simulated attention projection refusal'); END`);
    await expect(f.services.recoverAttention()).resolves.toBeUndefined();
    expect(f.retainedAttention()).toEqual([]);
    expect(f.record()).toEqual(pending);
    f.communicationDb.exec('DROP TRIGGER refuse_attention_enqueue');
    await f.services.recoverAttention();
    expect(f.retainedAttention()).toEqual([
      expect.objectContaining({
        source: {
          workspaceId: f.target.workspace,
          threadId: f.target.thread,
          requestId: f.target.request,
          kind: 'approval-request',
        },
        recipientUserId: actor.userId,
        status: 'queued',
        channel: null,
        attempt: null,
      }),
    ]);
    expect(f.sendAttention).not.toHaveBeenCalled();
    expect(f.nativeCalls).toEqual([]);
    expect(f.record()).toEqual(pending);
  });

  it('retains native binding status and revocation after Discord configuration is removed', async () => {
    const f = await fixture();
    await f.pair();
    await f.beginPairing();
    expect(
      f.communicationDb
        .prepare(
          'SELECT COUNT(*) AS count FROM channel_pairing_challenges WHERE user_id = ? AND consumed_at IS NULL'
        )
        .get(actor.userId)
    ).toEqual({ count: 1 });
    const pending = f.record();
    const invoke = await f.withoutAdapter();
    expect(await invoke('channel.discord.status')).toEqual({
      configured: false,
      sendingAvailable: false,
      binding: { discordUserId, pairedAt: expect.any(Number) },
    });
    expect(await invoke('credential.revoke')).toEqual({ status: 'revoked' });
    expect(await invoke('channel.discord.status')).toMatchObject({
      configured: false,
      binding: null,
    });
    expect(
      f.communicationDb
        .prepare(
          'SELECT COUNT(*) AS count FROM channel_pairing_challenges WHERE user_id = ? AND consumed_at IS NULL'
        )
        .get(actor.userId)
    ).toEqual({ count: 0 });
    expect(f.sendAttention).not.toHaveBeenCalled();
    expect(f.record()).toEqual(pending);
  });

  it.each(['approval', 'user-input'] as const)(
    'settles one exact %s response through its native owner once',
    async (kind) => {
      const f = await fixture(kind);
      await f.pair();
      const disclosure = await f.disclose();
      const command = kind === 'approval' ? 'deny' : 'answer';
      const values = {
        ...f.target,
        disclosure,
        ...(kind === 'user-input' ? { answers: JSON.stringify({ color: ['blue'] }) } : {}),
      };
      const signed = f.signed(f.envelope(command, values));
      expect(text(await f.postSigned(signed))).toContain('accepted');
      expect(f.nativeCalls).toHaveLength(1);
      expect(f.nativeCalls[0]).toMatchObject({
        id: kind === 'approval' ? 'approval.respond' : 'question.answer',
        actor,
      });
      expect(f.record()).toMatchObject({ state: 'resolved', claim: 'unclaimed' });
      if (kind === 'approval') {
        expect(f.store.getApproval(f.target.request).status).toBe('denied');
        expect(f.record()).toMatchObject({
          resolution: 'denied',
          decidingActor: { kind: 'user', id: actor.userId },
        });
      } else {
        expect(f.record()).toMatchObject({
          resolution: 'answered',
          answerMap: { color: ['blue'] },
          decidingActor: { kind: 'user', id: actor.userId },
        });
      }
      const settled = f.record();
      expect(text(await f.postSigned(signed))).toContain('already handled');
      expect(f.nativeCalls).toHaveLength(1);
      expect(f.record()).toEqual(settled);
      expect(f.store.listThreadTurns(DEMO_WORKSPACE_ID, f.target.thread)).toHaveLength(1);
    }
  );

  it('does not carry session administrator authority through a real signed Discord response', async () => {
    const f = await fixture();
    const admin = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: actor.userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const invoke = createOperationInvocation({
      coreDb: f.coreDb,
      store: f.store,
      mode: 'server',
    });
    // Ordinary authenticated session administration remains valid for this same user.
    await expect(
      invoke(
        'credential.list',
        {},
        {
          kind: 'public',
          actor: { ...actor, adminTokenId: admin.record.tokenId },
          delivery: 'human',
        }
      )
    ).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ kind: 'access-token', id: admin.record.tokenId }),
      ]),
    });

    await f.pair();
    const disclosure = await f.disclose();
    expect(text(await f.send('deny', { ...f.target, disclosure }))).toContain('accepted');
    expect(f.nativeCalls).toHaveLength(1);
    const channelActor = f.nativeCalls[0]!.actor;
    expect(channelActor.userId).toBe(actor.userId);
    await expect(
      invoke(
        'token.create',
        { scope: 'server-admin', workspaceIds: [], expiresAt: '2999-01-01T00:00:00.000Z' },
        { kind: 'public', actor: channelActor, delivery: 'human' }
      )
    ).rejects.toMatchObject({ code: 'deployment_admin_required', status: 403 });
    expect(f.record()).toMatchObject({ state: 'resolved', resolution: 'denied' });
  });

  it('keeps approval grants in the App without invoking the native response owner', async () => {
    const f = await fixture();
    await f.pair();
    const reply = text(await f.send('approve', f.target));
    const link = reply.match(/https:\/\/\S+/)?.[0];
    expect(link).toBeTruthy();
    const destination = new URL(link!);
    expect(destination.origin).toBe('https://openkit.invalid');
    expect(destination.pathname).toBe(`/tasks/${DEMO_WORKSPACE_ID}/${f.target.thread}`);
    expect(destination.searchParams.get('requestId')).toBe(f.target.request);
    expect(reply).not.toContain('page_exact');
    expect(reply).not.toContain('Disclosure:');
    expect(f.nativeCalls).toHaveLength(0);
    expect(f.record().state).toBe('pending');
  });

  it.each(['membership', 'audience', 'binding'] as const)(
    'refuses a response after current %s authority changes following disclosure',
    async (loss) => {
      const f = await fixture();
      await f.pair();
      const disclosure = await f.disclose();
      const pending = f.record();
      if (loss === 'membership') {
        f.removeMembership();
      } else if (loss === 'audience') {
        const thread = f.store.getThread(DEMO_WORKSPACE_ID, f.target.thread);
        expect(isThreadIdVisible(f.store, DEMO_WORKSPACE_ID, thread.id, actor.userId)).toBe(true);
        // Visibility is creation-fixed; current managed Policy removes access without conversion.
        f.revokeThreadAudience();
        expect(isThreadIdVisible(f.store, DEMO_WORKSPACE_ID, thread.id, actor.userId)).toBe(false);
        expect(f.store.getThread(DEMO_WORKSPACE_ID, thread.id)).toEqual(thread);
      } else {
        await f.revoke();
      }
      expect(text(await f.send('deny', { ...f.target, disclosure }))).toContain('refused');
      expect(f.nativeCalls).toHaveLength(0);
      expect(f.record().state).toBe('pending');
      expect(f.record()).toEqual(pending);
      expect(f.record().claim).toBe('unclaimed');
    }
  );

  it.each(['membership', 'binding'] as const)(
    'rechecks %s after asynchronous vendor preparation before sending a message',
    async (loss) => {
      const f = await fixture();
      await f.pair();
      let entered: (() => void) | undefined;
      let release: (() => void) | undefined;
      const preparing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const prepared = new Promise<void>((resolve) => {
        release = resolve;
      });
      let messageContacts = 0;
      f.sendAttention.mockImplementation(async (input) => {
        entered!();
        await prepared;
        if (!input.beforeSend())
          return { status: 'failed-no-send', code: 'simulated-current-authority-refusal' };
        messageContacts++;
        return { status: 'sent', externalMessageId: '523456789012345678' };
      });
      const pending = f.record();
      await f.services.attentionRaised(pending);
      await preparing;
      try {
        if (loss === 'membership') f.removeMembership();
        else {
          // An out-of-band change invalidates the snapshot even while the local send owns the binding.
          f.communicationDb
            .prepare('UPDATE channel_account_bindings SET revoked_at = ? WHERE user_id = ?')
            .run(Date.now(), actor.userId);
        }
      } finally {
        release!();
      }
      await vi.waitFor(() => expect(f.retainedAttention()[0]?.status).toBe('failed-no-send'), {
        timeout: 15_000,
      });
      expect(messageContacts).toBe(0);
      expect(f.sendAttention).toHaveBeenCalledTimes(1);
      expect(f.nativeCalls).toHaveLength(0);
      expect(f.record()).toEqual(pending);
    }
  );

  it('keeps notification uncertainty across restart without changing or resending its Core request', async () => {
    const f = await fixture();
    await f.pair();
    f.sendAttention.mockRejectedValue(new Error('simulated lost message acknowledgement'));
    const pending = f.record();
    await f.services.attentionRaised(pending);
    await vi.waitFor(() => expect(f.retainedAttention()[0]?.status).toBe('delivery-unknown'), {
      timeout: 15_000,
    });
    const delivery = f.retainedAttention()[0]!;
    expect(f.record()).toEqual(pending);
    expect(f.sendAttention).toHaveBeenCalledTimes(1);
    await f.restart();
    await f.services.recoverAttention();
    await expect(f.services.send(actor, delivery.id, delivery.attempt!.id)).rejects.toThrow();
    expect(f.retainedAttention().find((row) => row.id === delivery.id)?.status).toBe(
      'delivery-unknown'
    );
    expect(f.sendAttention).toHaveBeenCalledTimes(1);
    expect(f.nativeCalls).toHaveLength(0);
    expect(f.record()).toEqual(pending);
  });

  it('does not send a duplicate explicit retry when its first execution also proves no-send', async () => {
    const f = await fixture();
    await f.pair();
    f.sendAttention.mockResolvedValue({
      status: 'failed-no-send',
      code: 'simulated-message-refusal',
    });
    const pending = f.record();
    await f.services.attentionRaised(pending);
    await vi.waitFor(() => expect(f.retainedAttention()[0]?.status).toBe('failed-no-send'), {
      timeout: 15_000,
    });
    const delivery = f.retainedAttention()[0]!;
    const expectedAttemptId = delivery.attempt!.id;
    expect((await f.services.send(actor, delivery.id, expectedAttemptId)).status).toBe(
      'failed-no-send'
    );
    await expect(f.services.send(actor, delivery.id, expectedAttemptId)).rejects.toThrow(
      'Refresh before retrying'
    );
    expect(f.sendAttention).toHaveBeenCalledTimes(2);
    expect(f.record()).toEqual(pending);
  });

  it('does not redispatch after Core denial commits but channel receipt publication fails', async () => {
    const f = await fixture();
    await f.pair();
    const disclosure = await f.disclose();
    const event = f.envelope('deny', { ...f.target, disclosure });
    const signed = f.signed(event);
    // Keep the exact origin writable and fail only local receipt publication after native dispatch.
    f.communicationDb.exec(`CREATE TRIGGER refuse_channel_receipt BEFORE UPDATE OF receipt_digest ON communication_intents
      WHEN OLD.kind = 'channel.inbound' BEGIN SELECT RAISE(ABORT, 'simulated receipt publication failure'); END`);
    expect(text(await f.postSigned(signed))).toContain('outcome is unknown');
    expect(f.record().state).toBe('resolved');
    expect(f.store.getApproval(f.target.request).status).toBe('denied');
    expect(f.nativeCalls).toHaveLength(1);
    f.communicationDb.exec('DROP TRIGGER refuse_channel_receipt');
    await f.restart();
    expect(text(await f.postSigned(signed))).toContain('already handled');
    expect(f.nativeCalls).toHaveLength(1);
    expect(f.store.getApproval(f.target.request).status).toBe('denied');
  });
});
