// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestStore } from '../test-support/store.js';
import { publishWorkspaceOwnerMembership } from '../workspace-membership.js';
import { commandRequestExpiresAt, commandRequestKey } from './command-request-records.js';
import { commandInputHash } from './control-store-input.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { nativeProductScope } from './workspace-file-records.js';
import { ControlCoreSharingSchema } from './workspace-sharing-codecs.js';

it('ORACLE S7 owns explicit Core sharing before input preparation and through its actual ACK', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-core-sharing-enrollment-'));
  const store = createTestStore({ dataRoot });
  const coreDb = openCoreDb(dataRoot);
  const client = getControlStoreWorkerClient();
  const gate = client.workspaceMutations(dataRoot);
  const posts = vi.spyOn(Worker.prototype, 'postMessage');
  const emit = Worker.prototype.emit;
  const reached = Promise.withResolvers<void>();
  const cuts: (() => void)[] = [];
  let replies: ReturnType<typeof vi.spyOn> | undefined;
  let forward: (() => void) | undefined;
  let publication: ReturnType<typeof client.coreSharing> | undefined;
  try {
    const ownerUserId = ensureLocalUser(coreDb);
    const target = await store.createWorkspace('Explicit sharing target');
    const original = await store.createWorkspace('Original accepted scope');
    await publishWorkspaceOwnerMembership({ coreDb, workspaceId: target.id, ownerUserId });
    await publishWorkspaceOwnerMembership({ coreDb, workspaceId: original.id, ownerUserId });
    const invitee = 'usr_00000000-0000-7011-88df-c2b1e8466001';
    const email = 'sharing-enrollment@example.com';
    const now = Date.now();
    coreDb.sqlite
      .prepare(`INSERT INTO users
      (id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at)
      VALUES (?, ?, ?, false, ?, ?, 'human', 'active', NULL)`)
      .run(invitee, 'Invitee', email, now, now);
    const scope = nativeProductScope(dataRoot, { kind: 'server' });
    const database = `core:${scope.path}`;
    await client.open({
      database,
      path: scope.path,
      dataRoot,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    const commandFor = (workspaceId: string) => {
      const request = { requestId: randomUUID(), inviteeEmail: email };
      const command = 'workspace.invitation.create' as const;
      const receiptScope = {
        coreId: 'server',
        actorId: ownerUserId,
        targetWorkspaceId: workspaceId,
      };
      const createdAt = new Date().toISOString();
      return ControlCoreSharingSchema.parse({
        command,
        workspaceId,
        actor: { userId: ownerUserId, kind: 'local' },
        request,
        receipt: {
          key: commandRequestKey(command, request.requestId, receiptScope),
          command,
          requestId: request.requestId,
          scope: receiptScope,
          inputHash: commandInputHash(request),
          responseKind: 'workspace_invitation',
          createdAt,
          expiresAt: commandRequestExpiresAt(createdAt),
        },
      });
    };
    const input = commandFor(target.id);
    if (!('receipt' in input)) throw new Error('Expected the actual invitation tuple.');
    const receipt = input.receipt;
    const preparation: string[] = [];
    Object.defineProperty(input, 'receipt', {
      enumerable: true,
      get: () => {
        const cut = gate.tryFreeze(target.id, () => []);
        preparation.push(cut.status);
        if (cut.status === 'frozen') cut.release();
        return receipt;
      },
    });
    replies = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (event, ...args) {
      const request = posts.mock.calls.find(
        ([message]) =>
          message.operation === 'core-sharing' && message.input.workspaceId === target.id
      )?.[0];
      if (event === 'message' && request && args[0]?.id === request.id && !forward) {
        forward = () => {
          emit.call(this, event, ...args);
        };
        reached.resolve();
        return true;
      }
      return emit.call(this, event, ...args);
    });
    coreDb.sqlite.pragma('query_only = ON');
    const parent = gate.runWorkerCloseout(original.id, async () => {
      publication = client.coreSharing(database, input);
      void publication.catch(reached.reject);
      await reached.promise;
    });
    expect(parent).not.toBeNull();
    await parent;
    expect(preparation.length).toBeGreaterThan(0);
    expect(preparation.every((status) => status === 'busy')).toBe(true);
    for (const workspaceId of [target.id, original.id]) {
      const cut = gate.tryFreeze(workspaceId, () => []);
      if (cut.status === 'frozen') cuts.push(cut.release);
      expect(cut.status).toBe('busy');
    }
    forward!();
    await expect(publication).resolves.toMatchObject({
      kind: 'invitation',
      value: { workspaceId: target.id },
    });
    const retargeted = commandFor(target.id);
    let targetReads = 0;
    Object.defineProperty(retargeted, 'workspaceId', {
      enumerable: true,
      get: () => (++targetReads === 1 ? target.id : original.id),
    });
    const postedBeforeRetarget = posts.mock.calls.length;
    await expect(client.coreSharing(database, retargeted)).rejects.toMatchObject({
      code: 'invalid-request',
      commit: 'not-committed',
    });
    expect(posts.mock.calls).toHaveLength(postedBeforeRetarget);
    const uncloneable = commandFor(target.id);
    Object.defineProperty(uncloneable, 'unexpected', { enumerable: true, value: () => undefined });
    await expect(client.coreSharing(database, uncloneable)).rejects.toMatchObject({
      code: 'invalid-request',
      commit: 'not-committed',
    });
    expect(posts.mock.calls).toHaveLength(postedBeforeRetarget);
    const originalCut = gate.tryFreeze(original.id, () => []);
    if (originalCut.status === 'frozen') cuts.push(originalCut.release);
    expect(originalCut.status).toBe('frozen');
    if (originalCut.status === 'frozen') originalCut.release();
    const frozen = gate.tryFreeze(target.id, () => []);
    if (frozen.status === 'frozen') cuts.push(frozen.release);
    expect(frozen.status).toBe('frozen');
    const observedBeforeRefusal = preparation.length;
    await expect(client.coreSharing(database, input)).rejects.toMatchObject({
      code: 'workspace_frozen',
      status: 409,
    });
    expect(preparation).toHaveLength(observedBeforeRefusal);
    await expect(client.coreSharing(database, commandFor(original.id))).resolves.toMatchObject({
      kind: 'invitation',
      value: { workspaceId: original.id },
    });
    expect(
      coreDb.sqlite
        .prepare('SELECT COUNT(*) FROM workspace_invitations WHERE workspace_id=?')
        .pluck()
        .get(target.id)
    ).toBe(1);
  } finally {
    for (const release of cuts) release();
    forward?.();
    await publication?.catch(() => undefined);
    replies?.mockRestore();
    posts.mockRestore();
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}, 120_000);

it('ORACLE S7 retains the immutable invitation target before preparation and through native ACK', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-invitation-row-enrollment-'));
  const store = createTestStore({ dataRoot });
  const coreDb = openCoreDb(dataRoot);
  const client = getControlStoreWorkerClient();
  const gate = client.workspaceMutations(dataRoot);
  const posts = vi.spyOn(Worker.prototype, 'postMessage');
  const emit = Worker.prototype.emit;
  const reached = Promise.withResolvers<void>();
  const cuts: (() => void)[] = [];
  let replies: ReturnType<typeof vi.spyOn> | undefined;
  let forward: (() => void) | undefined;
  let publication: ReturnType<typeof client.coreSharing> | undefined;
  try {
    const ownerUserId = ensureLocalUser(coreDb);
    const target = await store.createWorkspace('Explicit sharing target');
    const original = await store.createWorkspace('Original accepted scope');
    await publishWorkspaceOwnerMembership({ coreDb, workspaceId: target.id, ownerUserId });
    await publishWorkspaceOwnerMembership({ coreDb, workspaceId: original.id, ownerUserId });
    const invitee = 'usr_00000000-0000-7011-88df-c2b1e8466001';
    const email = 'sharing-enrollment@example.com';
    const now = Date.now();
    coreDb.sqlite
      .prepare(`INSERT INTO users
      (id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at)
      VALUES (?, ?, ?, false, ?, ?, 'human', 'active', NULL)`)
      .run(invitee, 'Invitee', email, now, now);
    const scope = nativeProductScope(dataRoot, { kind: 'server' });
    const database = `core:${scope.path}`;
    await client.open({
      database,
      path: scope.path,
      dataRoot,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    const commandFor = (workspaceId: string) => {
      const request = { requestId: randomUUID(), inviteeEmail: email };
      const command = 'workspace.invitation.create' as const;
      const receiptScope = {
        coreId: 'server',
        actorId: ownerUserId,
        targetWorkspaceId: workspaceId,
      };
      const createdAt = new Date().toISOString();
      return ControlCoreSharingSchema.parse({
        command,
        workspaceId,
        actor: { userId: ownerUserId, kind: 'local' },
        request,
        receipt: {
          key: commandRequestKey(command, request.requestId, receiptScope),
          command,
          requestId: request.requestId,
          scope: receiptScope,
          inputHash: commandInputHash(request),
          responseKind: 'workspace_invitation',
          createdAt,
          expiresAt: commandRequestExpiresAt(createdAt),
        },
      });
    };
    const created = await client.coreSharing(database, commandFor(target.id));
    if (created.kind !== 'invitation') throw new Error('Expected the native invitation.');
    const request = { requestId: randomUUID(), expectedRevision: created.value.revision };
    const command = 'workspace.invitation.decline';
    const receiptScope = {
      coreId: 'server',
      actorId: invitee,
      targetInvitationId: created.value.invitationId,
    };
    const createdAt = new Date().toISOString();
    const input = ControlCoreSharingSchema.parse({
      command,
      invitationId: created.value.invitationId,
      actor: { userId: invitee, kind: 'local' },
      request,
      receipt: {
        key: commandRequestKey(command, request.requestId, receiptScope),
        command,
        requestId: request.requestId,
        scope: receiptScope,
        inputHash: commandInputHash(request),
        responseKind: 'workspace_invitation',
        createdAt,
        expiresAt: commandRequestExpiresAt(createdAt),
      },
    });
    if (!('receipt' in input)) throw new Error('Expected the native receipt.');
    const receipt = input.receipt;
    const preparation: string[] = [];
    Object.defineProperty(input, 'receipt', {
      enumerable: true,
      get: () => {
        const cut = gate.tryFreeze(target.id, () => []);
        preparation.push(cut.status);
        if (cut.status === 'frozen') cut.release();
        return receipt;
      },
    });
    replies = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (event, ...args) {
      const packet = posts.mock.calls.find(
        ([message]) =>
          message.operation === 'core-sharing' &&
          message.input.command === command &&
          message.input.invitationId === created.value.invitationId
      )?.[0];
      if (event === 'message' && packet && args[0]?.id === packet.id && !forward) {
        forward = () => {
          emit.call(this, event, ...args);
        };
        reached.resolve();
        return true;
      }
      return emit.call(this, event, ...args);
    });
    coreDb.sqlite.pragma('query_only = ON');
    const parent = gate.runWorkerCloseout(original.id, async () => {
      publication = client.coreSharing(database, input);
      void publication.catch(reached.reject);
      await reached.promise;
    });
    expect(parent).not.toBeNull();
    await parent;
    expect(preparation.length).toBeGreaterThan(0);
    expect(preparation.every((status) => status === 'busy')).toBe(true);
    for (const workspaceId of [original.id, target.id]) {
      const cut = gate.tryFreeze(workspaceId, () => []);
      if (cut.status === 'frozen') cuts.push(cut.release);
      expect(cut.status).toBe('busy');
    }
    forward!();
    await expect(publication).resolves.toMatchObject({
      kind: 'invitation',
      value: {
        invitationId: created.value.invitationId,
        workspaceId: target.id,
        effectiveStatus: 'declined',
        revision: created.value.revision + 1,
      },
    });
    const retargeted = { ...input, receipt };
    let invitationReads = 0;
    Object.defineProperty(retargeted, 'invitationId', {
      enumerable: true,
      get: () => (++invitationReads === 1 ? created.value.invitationId : 'missing-invitation'),
    });
    const changedCommand = { ...input, receipt };
    let commandReads = 0;
    Object.defineProperty(changedCommand, 'command', {
      enumerable: true,
      get: () => (++commandReads === 1 ? 'user.disable' : command),
    });
    const beforeCommandChange = posts.mock.calls.length;
    await expect(client.coreSharing(database, changedCommand)).rejects.toMatchObject({
      code: 'invalid-request',
      commit: 'not-committed',
    });
    expect(posts.mock.calls).toHaveLength(beforeCommandChange);
    const changedScope = commandFor(target.id);
    let scopeReads = 0;
    Object.defineProperty(changedScope, 'workspaceId', {
      enumerable: true,
      get: () => (++scopeReads === 1 ? undefined : target.id),
    });
    const beforeScopeChange = posts.mock.calls.length;
    await expect(client.coreSharing(database, changedScope)).rejects.toMatchObject({
      code: 'invalid-request',
      commit: 'not-committed',
    });
    expect(posts.mock.calls).toHaveLength(beforeScopeChange);
    const changedMissingId = { ...input, receipt };
    let missingIdReads = 0;
    Object.defineProperty(changedMissingId, 'invitationId', {
      enumerable: true,
      get: () => (++missingIdReads === 1 ? undefined : created.value.invitationId),
    });
    const beforeMissingIdChange = posts.mock.calls.length;
    await expect(client.coreSharing(database, changedMissingId)).rejects.toMatchObject({
      code: 'invalid-request',
      commit: 'not-committed',
    });
    expect(posts.mock.calls).toHaveLength(beforeMissingIdChange);
    const beforeRetarget = posts.mock.calls.length;
    await expect(client.coreSharing(database, retargeted)).rejects.toMatchObject({
      code: 'invalid-request',
      commit: 'not-committed',
    });
    expect(posts.mock.calls).toHaveLength(beforeRetarget);
    for (const workspaceId of [original.id, target.id]) {
      const cut = gate.tryFreeze(workspaceId, () => []);
      if (cut.status === 'frozen') cuts.push(cut.release);
      expect(cut.status).toBe('frozen');
      if (workspaceId === original.id && cut.status === 'frozen') cut.release();
    }
    const beforeRefusal = posts.mock.calls.length;
    await expect(client.coreSharing(database, input)).rejects.toMatchObject({
      code: 'workspace_frozen',
      status: 409,
    });
    expect(posts.mock.calls).toHaveLength(beforeRefusal);
    await expect(client.coreSharing(database, commandFor(original.id))).resolves.toMatchObject({
      kind: 'invitation',
      value: { workspaceId: original.id },
    });
    expect(
      coreDb.sqlite
        .prepare('SELECT revision FROM workspace_invitations WHERE invitation_id=?')
        .pluck()
        .get(created.value.invitationId)
    ).toBe(2);
  } finally {
    for (const release of cuts) release();
    forward?.();
    await publication?.catch(() => undefined);
    replies?.mockRestore();
    posts.mockRestore();
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}, 120_000);
