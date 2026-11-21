// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateEntityId,
  CapabilityCallSchema,
  ItemSchema,
  ThreadSchema,
  TurnSchema,
} from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  finishCapabilityCall,
  listServerCapabilityCalls,
  listWorkspaceCapabilityCalls,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { openServerGatewayCall } from '../llm/gateway-server-work.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { openCoreDb, openWorkspaceDb, serverStoragePath } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { withServerWorkProducer } from '../storage/server-work-command.js';
import { createVerifiedWorkspaceExport } from '../storage/workspace-transfer-routes.js';
import { DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import {
  createTestServerThread,
  createTestServerWorkDemoStore,
  createTestServerWorkStore,
  testServerWorkOptions,
} from '../test-support/server-work-store.js';
import {
  createTestCoreDb,
  disposeTestStore,
  shutdownTestStoreWorker,
} from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FsStore } from './store.js';

const actor = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;
const roots: string[] = [];
const databases: Array<ReturnType<typeof openCoreDb> | ReturnType<typeof openWorkspaceDb>> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await disposeTestStore(root, ...databases.splice(0));
  }
});

/** Publishes acknowledged history through shared setup and the real native owners. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-owner-boundary-'));
  roots.push(dataRoot);
  const coreDb = createTestCoreDb(dataRoot);
  databases.push(coreDb);
  ensureLocalUser(coreDb);
  const store = await createTestServerWorkDemoStore(coreDb);
  const workspace = store.getWorkspace(DEMO_WORKSPACE_ID);
  const thread = store.getThread(workspace.id, DEMO_THREAD_ID);
  const turn = await store.createTurn(workspace.id, thread.id, 'Workspace input', actor);
  const serverThread = await createTestServerThread(store, coreDb, 'Server-owned history');
  const serverTurn = await store.createServerTurn(serverThread.id, 'Server input', actor);
  const owner = { kind: 'workspace', workspaceId: workspace.id } as const;
  return { dataRoot, store, workspace, thread, turn, serverThread, serverTurn, owner };
}

/** The record has no duplicate Workspace selector beside its explicit owner. */
function message(
  owner: { kind: 'workspace'; workspaceId: string } | { kind: 'server' },
  threadId: string,
  turnId: string
) {
  return ItemSchema.parse({
    id: allocateEntityId('it'),
    owner,
    threadId,
    turnId,
    type: 'assistant-message',
    text: 'Canonical owner answer',
    status: 'completed',
    createdAt: '2026-10-19T00:00:00.000Z',
    completedAt: '2026-10-19T00:00:00.000Z',
  });
}

describe('canonical work owner and retained storage boundaries', () => {
  it('rejects a Server owner supplied through Workspace Thread audience fields without publishing history', async () => {
    const { store, workspace } = await fixture();
    const threads = store.listThreads(workspace.id);
    const serverThreads = store.listServerThreads();
    await expect(
      store.createThread(workspace.id, 'Wrong owner', undefined, 'conversation', {
        owner: { kind: 'server' },
        visibility: 'server',
      } as never)
    ).rejects.toThrow();
    expect(store.listThreads(workspace.id)).toEqual(threads);
    expect(store.listServerThreads()).toEqual(serverThreads);
  });

  it('publishes explicit owners and reloads both families through the same schema', async () => {
    const f = await fixture();
    for (const [schema, record, owner] of [
      [ThreadSchema, f.thread, f.owner],
      [TurnSchema, f.turn, f.owner],
      [ThreadSchema, f.serverThread, { kind: 'server' }],
      [TurnSchema, f.serverTurn, { kind: 'server' }],
    ] as const) {
      expect(schema.parse(record)).toMatchObject({ owner });
      expect(record).not.toHaveProperty('workspaceId');
    }
    const item = await f.store.createItem(message(f.owner, f.thread.id, f.turn.id));
    const serverItem = await f.store.createServerItem(
      message({ kind: 'server' }, f.serverThread.id, f.serverTurn.id)
    );
    const reopened = await createTestServerWorkStore(f.dataRoot);
    expect(TurnSchema.parse(reopened.getTurnById(f.turn.id))).toMatchObject({
      owner: f.owner,
      items: [item],
    });
    expect(TurnSchema.parse(reopened.getServerTurnById(f.serverTurn.id))).toMatchObject({
      owner: { kind: 'server' },
      items: [serverItem],
    });
    expect(reopened.listThreads(f.workspace.id).map(({ id }) => id)).toEqual([f.thread.id]);
    expect(() => reopened.getTurnById(f.serverTurn.id)).toThrow();
    expect(() => reopened.getServerTurnById(f.turn.id)).toThrow();
  });

  it('refuses foreign owner Items before appending and preserves the accepted owner after reopen', async () => {
    const f = await fixture();
    const item = await f.store.createItem(message(f.owner, f.thread.id, f.turn.id));
    for (const owner of [
      { kind: 'server' },
      { kind: 'workspace', workspaceId: allocateEntityId('ws') },
    ] as const) {
      await expect(
        f.store.createItem({ ...item, id: allocateEntityId('it'), owner })
      ).rejects.toThrow();
      await expect(f.store.updateItem(item.id, { owner } as never)).rejects.toThrow();
    }
    const serverItem = await f.store.createServerItem(
      message({ kind: 'server' }, f.serverThread.id, f.serverTurn.id)
    );
    await expect(
      f.store.createServerItem({
        ...serverItem,
        id: allocateEntityId('it'),
        owner: f.owner,
      } as never)
    ).rejects.toThrow();
    await expect(
      f.store.updateThread(f.workspace.id, f.thread.id, { owner: { kind: 'server' } } as never)
    ).rejects.toThrow();
    await expect(
      f.store.updateTurn(f.turn.id, { owner: { kind: 'server' } } as never)
    ).rejects.toThrow();
    await expect(
      f.store.updateServerTurn(f.serverTurn.id, { owner: f.owner } as never)
    ).rejects.toThrow();
    const reopened = await createTestServerWorkStore(f.dataRoot);
    expect(reopened.getTurnById(f.turn.id).items).toEqual([item]);
    expect(reopened.getServerTurnById(f.serverTurn.id).items).toEqual([serverItem]);
  });

  for (const invalidOwner of [
    undefined,
    { kind: 'server' },
    { kind: 'workspace', workspaceId: allocateEntityId('ws') },
    { kind: 'user', userId: actor.id },
  ]) {
    // Generated ids stay out of the name so every collection yields the same case inventory.
    const label =
      invalidOwner === undefined
        ? 'missing'
        : invalidOwner.kind === 'workspace'
          ? 'of another Workspace'
          : invalidOwner.kind;
    it(`refuses retained Workspace Turn owner ${label} without rewriting its bytes`, async () => {
      const f = await fixture();
      const healthy =
        invalidOwner === undefined || invalidOwner.kind === 'user'
          ? await f.store.createWorkspace('Healthy unsupported-owner sibling')
          : undefined;
      await shutdownTestStoreWorker();
      const database = openWorkspaceDb(f.dataRoot, f.workspace.id);
      databases.push(database);
      // Deliberately damage acknowledged authority after stopping its live writer.
      const raw = JSON.parse(
        (
          database.sqlite
            .prepare('SELECT record_json FROM control_turns WHERE id=?')
            .get(f.turn.id) as { record_json: string }
        ).record_json
      );
      if (invalidOwner === undefined) delete raw.owner;
      else raw.owner = invalidOwner;
      const corrupted = JSON.stringify(raw);
      database.sqlite
        .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
        .run(corrupted, f.turn.id);
      if (healthy) {
        const workspaceRoot = join(f.dataRoot, 'workspaces', f.workspace.id);
        const entries = readdirSync(workspaceRoot, { recursive: true }).sort();
        const before = database.sqlite.serialize();
        const reopened = await createTestServerWorkStore(f.dataRoot);
        const refusal = expect.objectContaining({ code: 'recovery_required' });
        expect(() => reopened.getWorkspace(f.workspace.id)).toThrow(refusal);
        expect(() => reopened.getTurn(f.workspace.id, f.thread.id, f.turn.id)).toThrow(refusal);
        await expect(reopened.createThread(f.workspace.id, 'Must not publish')).rejects.toThrow(
          refusal
        );
        expect(reopened.getServerTurnById(f.serverTurn.id)).toEqual(f.serverTurn);
        expect(reopened.getWorkspace(healthy.id)).toEqual(f.store.getWorkspace(healthy.id));
        const added = await reopened.createThread(healthy.id, 'New sibling history');
        expect(new FsStore({ dataRoot: f.dataRoot }).getThread(healthy.id, added.id)).toEqual(
          added
        );
        expect(database.sqlite.serialize()).toEqual(before);
        expect(readdirSync(workspaceRoot, { recursive: true }).sort()).toEqual(entries);
      } else {
        expect(() => new FsStore({ dataRoot: f.dataRoot })).toThrow();
      }
      expect(
        database.sqlite.prepare('SELECT record_json FROM control_turns WHERE id=?').get(f.turn.id)
      ).toEqual({ record_json: corrupted });
    });
  }

  it('refuses malformed Server Turn authority globally without rewriting its bytes', async () => {
    const f = await fixture();
    await shutdownTestStoreWorker();
    const sqlite = new Database(serverStoragePath(f.dataRoot, 'server-work'), {
      fileMustExist: true,
    });
    try {
      // The missing owner is a retained authority fault, not a successful publication.
      const raw = JSON.parse(
        (
          sqlite
            .prepare('SELECT record_json FROM control_turns WHERE id=?')
            .get(f.serverTurn.id) as { record_json: string }
        ).record_json
      );
      delete raw.owner;
      const corrupted = JSON.stringify(raw);
      sqlite
        .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
        .run(corrupted, f.serverTurn.id);
      await expect(createTestServerWorkStore(f.dataRoot)).rejects.toThrow();
      expect(
        sqlite.prepare('SELECT record_json FROM control_turns WHERE id=?').get(f.serverTurn.id)
      ).toEqual({ record_json: corrupted });
    } finally {
      sqlite.close();
    }
  });

  it('reopens calls in their owning database and excludes Server history from Workspace export', async () => {
    const f = await fixture();
    let coreDb = openCoreDb(f.dataRoot);
    databases.push(coreDb);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: f.workspace.id, ownerUserId: actor.id });
    let workspaceDb = openWorkspaceDb(f.dataRoot, f.workspace.id);
    databases.push(workspaceDb);
    const callInput = {
      authorityActor: actor,
      capabilityId: 'llm.responses',
      family: 'llm' as const,
      operation: 'responses.create',
      providerRef: 'owner-boundary-fixture',
      redactionClass: 'metadata-only',
    };
    const workspaceCall = await startCapabilityCall({
      ...callInput,
      workspaceDb,
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      turnId: f.turn.id,
    });
    const binding = f.store.getServerWorkBinding()!;
    const serverCall = await withServerWorkProducer(binding, async () => {
      const native = await openServerGatewayCall(binding, {
        context: {
          ...callInput,
          owner: { kind: 'server' },
          requestId: randomUUID(),
          threadId: f.serverThread.id,
          turnId: f.serverTurn.id,
        },
        logicalModelId: 'openai/gpt-5.2',
      });
      await native.claimContact();
      await native.finish({ status: 'succeeded' });
      return native.call;
    });
    await finishCapabilityCall({ workspaceDb, callId: workspaceCall.id, status: 'succeeded' });
    await shutdownTestStoreWorker();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    workspaceDb = openWorkspaceDb(f.dataRoot, f.workspace.id);
    coreDb = openCoreDb(f.dataRoot);
    databases.push(workspaceDb, coreDb);
    const workspaceCalls = listWorkspaceCapabilityCalls(workspaceDb, f.workspace.id);
    const server = await testServerWorkOptions(coreDb);
    const serverCalls = listServerCapabilityCalls(coreDb, server.serverWorkReader);
    const [retainedWorkspaceCall] = workspaceCalls;
    const [retainedServerCall] = serverCalls;
    // Audit Usage Evidence Records: CapabilityCall has one home in its admitted scope.
    expect(workspaceCalls.map(({ id }) => id)).toEqual([workspaceCall.id]);
    expect(serverCalls.map(({ id }) => id)).toEqual([serverCall.id]);
    const exported = await createVerifiedWorkspaceExport({
      fileAdmission: new FileStorageAdmission(f.dataRoot, () => 0n),
      authorityUserId: actor.id,
      authorityActor: actor,
      requestActor: { kind: 'local', userId: actor.id },
      coreDb,
      dataRoot: f.dataRoot,
      repositoryWorkspaceDb: (workspaceId) => openWorkspaceDb(f.dataRoot, workspaceId),
      store: new FsStore({ dataRoot: f.dataRoot }),
      workspaceId: f.workspace.id,
    });
    const exportedThreads = exported.verified.fileContents.get('records/threads.jsonl');
    const exportedTurns = exported.verified.fileContents.get('records/turns.jsonl');
    const exportedCalls = exported.verified.fileContents.get('records/capability-calls.jsonl');
    expect(exportedThreads).toContain(f.thread.id);
    expect(exportedThreads).not.toContain(f.serverThread.id);
    expect(exportedTurns).toContain(f.turn.id);
    expect(exportedTurns).not.toContain(f.serverTurn.id);
    expect(exportedCalls).toContain(workspaceCall.id);
    expect(exportedCalls).not.toContain(serverCall.id);
    expect(CapabilityCallSchema.parse(retainedWorkspaceCall)).toMatchObject({
      id: workspaceCall.id,
      owner: f.owner,
      threadId: f.thread.id,
      turnId: f.turn.id,
    });
    expect(CapabilityCallSchema.parse(retainedServerCall)).toMatchObject({
      id: serverCall.id,
      owner: { kind: 'server' },
      threadId: f.serverThread.id,
      turnId: f.serverTurn.id,
    });
  });
});
