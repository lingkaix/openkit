import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from './auth/identity.js';
import { createChannelServices, type DiscordAttentionTransport } from './channel-services.js';
import type { DiscordReply } from './channels/discord.js';
import { FsStore } from './lib/store.js';
import { createOperationInvocation } from './operation-composition.js';
import { raiseRecordedPendingRequest } from './runtime/pending-request-flow.js';
import { readPendingRequest } from './runtime/pending-requests.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { testEntityId } from './test-support/entity-ids.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import { removeWorkspaceMember } from './workspace-sharing.js';

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

/** Observes reply text while preserving the private Discord response predicate. */
function text(reply: DiscordReply): string {
  expect(reply.type).toBe(4);
  if (reply.type !== 4) throw new Error('Expected a private command reply');
  expect(reply.data.flags).toBe(64);
  return reply.data.content;
}

/** Composes real signed channel input, Core authority, native invocation and Pending storage. */
function fixture(kind: 'approval' | 'user-input' = 'approval') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'channel-pending-seam-'));
  directories.push(dataRoot);
  let coreDb = openCoreDb(dataRoot);
  databases.push(coreDb);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  coreDb.sqlite
    .prepare(`INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind)
    SELECT ?, 'Channel member', 'member-' || email, email_verified, created_at, updated_at, 'human' FROM users WHERE id = ?`)
    .run(actor.userId, FIXTURE_LOCAL_USER_ID);
  let store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
    workspaceId: DEMO_WORKSPACE_ID,
  });
  coreDb.sqlite
    .prepare(`INSERT INTO workspace_members (workspace_id,user_id,status,joined_at,created_at,updated_at,revision)
    SELECT workspace_id,?,status,joined_at,created_at,updated_at,revision FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
    .run(actor.userId, DEMO_WORKSPACE_ID, FIXTURE_LOCAL_USER_ID);
  const thread = store.createThread(
    DEMO_WORKSPACE_ID,
    'Exact channel request',
    undefined,
    'conversation',
    {
      visibility: 'workspace',
    }
  );
  const turn = store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Request a decision', {
    kind: 'user',
    id: actor.userId,
  });
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
    requesterKind: 'person' as const,
  };
  const workspaceDb = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
  applyScopedMigrations(workspaceDb);
  try {
    if (kind === 'approval') {
      store.createItem({
        id: itemId,
        workspaceId: DEMO_WORKSPACE_ID,
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
      raiseRecordedPendingRequest(store, workspaceDb.sqlite, {
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
      store.createItem({
        id: itemId,
        workspaceId: DEMO_WORKSPACE_ID,
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
      raiseRecordedPendingRequest(store, workspaceDb.sqlite, {
        ...common,
        kind,
        questions,
        questionDigest: 'exact-color-question',
      });
    }
  } finally {
    workspaceDb.sqlite.close();
  }

  const nativeCalls: Array<{ id: string; input: unknown; actor: Actor }> = [];
  const sendAttention = vi
    .fn<DiscordAttentionTransport['sendAttention']>()
    .mockResolvedValue({ status: 'sent', externalMessageId: '523456789012345678' });
  let workspaceAvailable = true;
  function compose(configured = true) {
    const repositoryWorkspaceDb = (workspaceId: string) => {
      if (!workspaceAvailable) throw new Error('Simulated unavailable Workspace storage');
      return openWorkspaceDb(dataRoot, workspaceId);
    };
    const inflightCommands = new WeakMap();
    const invoke = createOperationInvocation({
      coreDb,
      store,
      mode: 'server',
      repositoryWorkspaceDb,
      inflightCommands,
      pendingRequestServices: { coreDb, repositoryWorkspaceDb, inflightCommands },
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    return createChannelServices({
      publicBaseUrl: 'https://openkit.invalid',
      coreDb,
      store,
      mode: 'server',
      ...(configured
        ? { discordConfig: { applicationId, publicKey }, transport: { sendAttention } }
        : {}),
      openWorkspace: repositoryWorkspaceDb,
      invokePending: async (id, input, decidingActor) => {
        nativeCalls.push({ id, input, actor: decidingActor });
        return invoke(id, input, { kind: 'public', actor: decidingActor, delivery: 'human' });
      },
    });
  }
  let services = compose();
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
    services.discord!.handleSignedInteraction(signed(envelope(command, values)));
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
    send,
    signed,
    envelope,
    target,
    record,
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
      const { challenge } = services.discord!.beginPairing(actor);
      expect(text(await send('pair', { challenge }))).toContain('paired');
    },
    async disclose() {
      const disclosure = text(await send('inspect', target)).match(
        /Disclosure: ([A-Za-z0-9_-]+)/
      )?.[1];
      expect(disclosure).toBeTruthy();
      return disclosure!;
    },
    withoutAdapter() {
      const unconfigured = compose(false);
      const invoke = createOperationInvocation({
        coreDb,
        store,
        mode: 'server',
        channelServices: unconfigured,
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      });
      return (id: 'channel.discord.status' | 'channel.discord.revoke') =>
        invoke(id, {}, { kind: 'public', actor, delivery: 'human' });
    },
    removeMembership() {
      const result = coreDb.sqlite.transaction(() =>
        removeWorkspaceMember({
          coreDb,
          workspaceId: DEMO_WORKSPACE_ID,
          ownerUserId: FIXTURE_LOCAL_USER_ID,
          memberUserId: actor.userId,
          expectedRevision: 1,
        })
      )();
      expect(result.kind).toBe('removed');
    },
    restart() {
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      databases.push(coreDb);
      applyMigrations(coreDb);
      store = new FsStore({ dataRoot });
      services = compose();
    },
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Discord to native Pending Request seam', () => {
  it('admits only the recorded local User to pairing in local mode', () => {
    const f = fixture();
    const openWorkspace = vi.fn(() => {
      throw new Error('Pairing must not open Workspace storage');
    });
    const invokePending = vi.fn(async () => {
      throw new Error('Pairing must not invoke a Pending Request');
    });
    const services = createChannelServices({
      coreDb: f.coreDb,
      store: f.store,
      mode: 'local',
      publicBaseUrl: 'https://openkit.invalid',
      discordConfig: { applicationId, publicKey },
      openWorkspace,
      invokePending,
    });
    expect(
      services.discord!.beginPairing({ userId: FIXTURE_LOCAL_USER_ID, kind: 'local' })
    ).toEqual({ challenge: expect.any(String), expiresAt: expect.any(Number) });
    expect(() => services.discord!.beginPairing(actor)).toThrow(
      'Current actor authority is unavailable.'
    );
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(invokePending).not.toHaveBeenCalled();
  });

  it('skips unavailable Workspace recovery and later queues the exact retained request', () => {
    const f = fixture();
    const pending = f.record();
    f.setWorkspaceAvailable(false);
    expect(() => f.services.recoverAttention()).not.toThrow();
    expect(f.services.notifications.listForActor(actor.userId, {}, () => true)).toEqual([]);
    expect(f.sendAttention).not.toHaveBeenCalled();
    expect(f.record()).toEqual(pending);

    f.setWorkspaceAvailable(true);
    f.services.recoverAttention();
    expect(f.services.notifications.listForActor(actor.userId, {}, () => true)).toEqual([
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
    const f = fixture();
    await f.pair();
    f.services.discord!.beginPairing(actor);
    expect(
      f.coreDb.sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM discord_pairing_challenges WHERE user_id = ? AND consumed_at IS NULL'
        )
        .get(actor.userId)
    ).toEqual({ count: 1 });
    const pending = f.record();
    const invoke = f.withoutAdapter();
    expect(await invoke('channel.discord.status')).toEqual({
      configured: false,
      sendingAvailable: false,
      binding: { discordUserId, pairedAt: expect.any(Number) },
    });
    expect(await invoke('channel.discord.revoke')).toBeNull();
    expect(await invoke('channel.discord.status')).toMatchObject({
      configured: false,
      binding: null,
    });
    expect(
      f.coreDb.sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM discord_pairing_challenges WHERE user_id = ? AND consumed_at IS NULL'
        )
        .get(actor.userId)
    ).toEqual({ count: 0 });
    expect(f.sendAttention).not.toHaveBeenCalled();
    expect(f.record()).toEqual(pending);
  });

  it.each([
    'approval',
    'user-input',
  ] as const)('settles one exact %s response through its native owner once', async (kind) => {
    const f = fixture(kind);
    await f.pair();
    const disclosure = await f.disclose();
    const command = kind === 'approval' ? 'deny' : 'answer';
    const values = {
      ...f.target,
      disclosure,
      ...(kind === 'user-input' ? { answers: JSON.stringify({ color: ['blue'] }) } : {}),
    };
    const signed = f.signed(f.envelope(command, values));
    expect(text(await f.services.discord!.handleSignedInteraction(signed))).toContain('accepted');
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
    expect(text(await f.services.discord!.handleSignedInteraction(signed))).toContain(
      'already handled'
    );
    expect(f.nativeCalls).toHaveLength(1);
    expect(f.record()).toEqual(settled);
    expect(f.store.listThreadTurns(DEMO_WORKSPACE_ID, f.target.thread)).toHaveLength(1);
  });

  it('keeps approval grants in the App without invoking the native response owner', async () => {
    const f = fixture();
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

  it.each([
    'membership',
    'audience',
    'binding',
  ] as const)('refuses a response after current %s authority changes following disclosure', async (loss) => {
    const f = fixture();
    await f.pair();
    const disclosure = await f.disclose();
    if (loss === 'membership') {
      f.removeMembership();
    } else if (loss === 'audience') {
      // Fault the real source audience after disclosure; the real current-source reader must refuse it.
      Object.assign(f.store.getThread(DEMO_WORKSPACE_ID, f.target.thread), {
        visibility: 'private',
        privateOwnerUserId: testEntityId('usr', 'channel-other'),
      });
    } else {
      f.services.discord!.revoke(actor);
    }
    expect(text(await f.send('deny', { ...f.target, disclosure }))).toContain('refused');
    expect(f.nativeCalls).toHaveLength(0);
    expect(f.record().state).toBe('pending');
  });

  it.each([
    'membership',
    'binding',
  ] as const)('rechecks %s after asynchronous vendor preparation before sending a message', async (loss) => {
    const f = fixture();
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
    f.services.attentionRaised(pending);
    await preparing;
    try {
      if (loss === 'membership') f.removeMembership();
      else f.services.discord!.revoke(actor);
    } finally {
      release!();
    }
    await vi.waitFor(() =>
      expect(f.services.notifications.listForActor(actor.userId, {}, () => true)[0]?.status).toBe(
        'failed-no-send'
      )
    );
    expect(messageContacts).toBe(0);
    expect(f.sendAttention).toHaveBeenCalledTimes(1);
    expect(f.nativeCalls).toHaveLength(0);
    expect(f.record()).toEqual(pending);
  });

  it('keeps notification uncertainty across restart without changing or resending its Core request', async () => {
    const f = fixture();
    await f.pair();
    f.sendAttention.mockRejectedValue(new Error('simulated lost message acknowledgement'));
    const pending = f.record();
    f.services.attentionRaised(pending);
    await vi.waitFor(() =>
      expect(f.services.notifications.listForActor(actor.userId, {}, () => true)[0]?.status).toBe(
        'delivery-unknown'
      )
    );
    const delivery = f.services.notifications.listForActor(actor.userId, {}, () => true)[0]!;
    expect(f.record()).toEqual(pending);
    expect(f.sendAttention).toHaveBeenCalledTimes(1);
    f.restart();
    f.services.recoverAttention();
    await expect(f.services.send(actor, delivery.id, delivery.attempt!.id)).rejects.toThrow();
    expect(f.services.notifications.get(delivery.id)?.status).toBe('delivery-unknown');
    expect(f.sendAttention).toHaveBeenCalledTimes(1);
    expect(f.nativeCalls).toHaveLength(0);
    expect(f.record()).toEqual(pending);
  });

  it('does not send a duplicate explicit retry when its first execution also proves no-send', async () => {
    const f = fixture();
    await f.pair();
    f.sendAttention.mockResolvedValue({
      status: 'failed-no-send',
      code: 'simulated-message-refusal',
    });
    const pending = f.record();
    f.services.attentionRaised(pending);
    await vi.waitFor(() =>
      expect(f.services.notifications.listForActor(actor.userId, {}, () => true)[0]?.status).toBe(
        'failed-no-send'
      )
    );
    const delivery = f.services.notifications.listForActor(actor.userId, {}, () => true)[0]!;
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
    const f = fixture();
    await f.pair();
    const disclosure = await f.disclose();
    const event = f.envelope('deny', { ...f.target, disclosure });
    const signed = f.signed(event);
    f.coreDb.sqlite.exec(`CREATE TRIGGER refuse_channel_receipt BEFORE UPDATE ON discord_inbound_receipts
      WHEN OLD.event_id = '${event.id}' BEGIN SELECT RAISE(ABORT, 'simulated receipt publication failure'); END`);
    await expect(f.services.discord!.handleSignedInteraction(signed)).rejects.toThrow(
      'simulated receipt publication failure'
    );
    expect(f.record().state).toBe('resolved');
    expect(f.store.getApproval(f.target.request).status).toBe('denied');
    expect(f.nativeCalls).toHaveLength(1);
    f.coreDb.sqlite.exec('DROP TRIGGER refuse_channel_receipt');
    f.restart();
    expect(text(await f.services.discord!.handleSignedInteraction(signed))).toContain(
      'outcome is unknown'
    );
    expect(f.nativeCalls).toHaveLength(1);
    expect(f.store.getApproval(f.target.request).status).toBe('denied');
  });
});
