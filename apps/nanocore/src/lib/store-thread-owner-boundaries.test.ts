import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateEntityId,
  CapabilityCallSchema,
  ItemSchema,
  ThreadSchema,
  TurnSchema,
} from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  finishCapabilityCall,
  listServerCapabilityCalls,
  listWorkspaceCapabilityCalls,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createVerifiedWorkspaceExport } from '../storage/workspace-transfer-routes.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FsStore } from './store.js';

const actor = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;
const roots: string[] = [];
const databases: Array<{ sqlite: { open: boolean; close(): void } }> = [];

afterEach(() => {
  for (const database of databases.splice(0)) if (database.sqlite.open) database.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Every check crosses the real canonical file boundary in an isolated data root. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-owner-boundary-'));
  roots.push(dataRoot);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Workspace-owned history');
  const thread = store.createThread(workspace.id, 'Workspace work');
  const turn = store.createTurn(workspace.id, thread.id, 'Workspace input', actor);
  const serverThread = store.createServerThread('Server-owned history');
  const serverTurn = store.createServerTurn(serverThread.id, 'Server input', actor);
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
  it('rejects a Server owner supplied through Workspace Thread audience fields without polluting the Workspace cache', () => {
    const store = new FsStore();
    const workspace = store.createWorkspace('Workspace');
    expect(() =>
      store.createThread(workspace.id, 'Wrong owner', undefined, 'conversation', {
        owner: { kind: 'server' },
        visibility: 'server',
      } as never)
    ).toThrow();
    expect(store.listThreads(workspace.id)).toEqual([]);
    expect(store.listServerThreads()).toEqual([]);
  });

  it('publishes explicit owners and reloads both families through the same schema', () => {
    const f = fixture();
    for (const [schema, record, owner] of [
      [ThreadSchema, f.thread, f.owner],
      [TurnSchema, f.turn, f.owner],
      [ThreadSchema, f.serverThread, { kind: 'server' }],
      [TurnSchema, f.serverTurn, { kind: 'server' }],
    ] as const) {
      expect(schema.parse(record)).toMatchObject({ owner });
      expect(record).not.toHaveProperty('workspaceId');
    }
    const item = f.store.createItem(message(f.owner, f.thread.id, f.turn.id));
    const serverItem = f.store.createServerItem(
      message({ kind: 'server' }, f.serverThread.id, f.serverTurn.id)
    );
    const reopened = new FsStore({ dataRoot: f.dataRoot });
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
    const workspacePath = join(f.dataRoot, 'workspaces', f.workspace.id, 'threads', f.thread.id);
    const serverPath = join(f.dataRoot, 'server', 'threads', f.serverThread.id);
    expect(JSON.parse(readFileSync(join(workspacePath, 'thread.json'), 'utf8'))).toMatchObject({
      owner: f.owner,
    });
    expect(JSON.parse(readFileSync(join(serverPath, 'thread.json'), 'utf8'))).toMatchObject({
      owner: { kind: 'server' },
    });
    expect(
      existsSync(join(f.dataRoot, 'workspaces', f.workspace.id, 'threads', f.serverThread.id))
    ).toBe(false);
    expect(existsSync(join(f.dataRoot, 'server', 'threads', f.thread.id))).toBe(false);
  });

  it('refuses foreign owner Items before appending and preserves the accepted owner after reopen', () => {
    const f = fixture();
    const item = f.store.createItem(message(f.owner, f.thread.id, f.turn.id));
    for (const owner of [
      { kind: 'server' },
      { kind: 'workspace', workspaceId: allocateEntityId('ws') },
    ] as const) {
      expect(() => f.store.createItem({ ...item, id: allocateEntityId('it'), owner })).toThrow();
      expect(() => f.store.updateItem(item.id, { owner } as never)).toThrow();
    }
    const serverItem = f.store.createServerItem(
      message({ kind: 'server' }, f.serverThread.id, f.serverTurn.id)
    );
    expect(() =>
      f.store.createServerItem({
        ...serverItem,
        id: allocateEntityId('it'),
        owner: f.owner,
      } as never)
    ).toThrow();
    expect(() =>
      f.store.updateThread(f.workspace.id, f.thread.id, { owner: { kind: 'server' } } as never)
    ).toThrow();
    expect(() => f.store.updateTurn(f.turn.id, { owner: { kind: 'server' } } as never)).toThrow();
    expect(() => f.store.updateServerTurn(f.serverTurn.id, { owner: f.owner } as never)).toThrow();
    const reopened = new FsStore({ dataRoot: f.dataRoot });
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
    it(`refuses retained Workspace Turn owner ${label} without rewriting its bytes`, () => {
      const f = fixture();
      const path = join(
        f.dataRoot,
        'workspaces',
        f.workspace.id,
        'threads',
        f.thread.id,
        'turns',
        f.turn.id,
        'turn.json'
      );
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      if (invalidOwner === undefined) delete raw.owner;
      else raw.owner = invalidOwner;
      const corrupted = JSON.stringify(raw);
      writeFileSync(path, corrupted);
      expect(() => new FsStore({ dataRoot: f.dataRoot })).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(corrupted);
    });
  }

  it('refuses an intact Workspace Thread moved to a different owner directory', () => {
    const f = fixture();
    const otherWorkspace = f.store.createWorkspace('Other owner');
    const source = join(f.dataRoot, 'workspaces', f.workspace.id, 'threads', f.thread.id);
    const target = join(f.dataRoot, 'workspaces', otherWorkspace.id, 'threads', f.thread.id);
    const original = readFileSync(join(source, 'thread.json'), 'utf8');
    renameSync(source, target);
    expect(() => new FsStore({ dataRoot: f.dataRoot })).toThrow();
    expect(readFileSync(join(target, 'thread.json'), 'utf8')).toBe(original);
  });

  it('reopens calls in their owning database and excludes Server history from Workspace export', () => {
    const f = fixture();
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
    const workspaceCall = startCapabilityCall({
      ...callInput,
      workspaceDb,
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      turnId: f.turn.id,
    });
    const serverCall = startCapabilityCall({
      ...callInput,
      workspaceDb: coreDb,
      owner: { kind: 'server' },
      threadId: f.serverThread.id,
      turnId: f.serverTurn.id,
    });
    finishCapabilityCall({ workspaceDb, callId: workspaceCall.id, status: 'succeeded' });
    finishCapabilityCall({ workspaceDb: coreDb, callId: serverCall.id, status: 'succeeded' });
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    workspaceDb = openWorkspaceDb(f.dataRoot, f.workspace.id);
    coreDb = openCoreDb(f.dataRoot);
    databases.push(workspaceDb, coreDb);
    const [retainedWorkspaceCall] = listWorkspaceCapabilityCalls(workspaceDb, f.workspace.id);
    const [retainedServerCall] = listServerCapabilityCalls(coreDb);
    expect(workspaceDb.sqlite.prepare('SELECT call_id FROM capability_calls').all()).toEqual([
      { call_id: workspaceCall.id },
    ]);
    expect(coreDb.sqlite.prepare('SELECT call_id FROM capability_calls').all()).toEqual([
      { call_id: serverCall.id },
    ]);
    const exported = createVerifiedWorkspaceExport({
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
