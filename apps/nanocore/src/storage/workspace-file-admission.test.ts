import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, ItemSchema, readRetainedV1, WorkOwnerSchema } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createTestStore } from '../test-support/store.js';
import { openWorkspaceDb } from './db.js';
import { WorkOwnershipViolationError } from './fs-layout.js';

const roots: string[] = [];
const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Publishes real history before fault injection; the later Thread sorts after both append logs. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-file-admission-'));
  roots.push(root);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Damaged source');
  const healthy = await store.createWorkspace('Healthy source');
  const [first, later] = [
    await store.createThread(workspace.id, 'First'),
    await store.createThread(workspace.id, 'Later'),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const turn = await store.createTurn(workspace.id, first.id, 'Retained input', actor);
  const item = store.createItem({
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: first.id,
    turnId: turn.id,
    type: 'assistant-message',
    status: 'in_progress',
    text: 'Retained output.',
    createdAt: turn.startedAt ?? new Date().toISOString(),
    completedAt: null,
  });
  store.emitTurnEvent(turn.id, {
    event: 'turn.started',
    workspaceId: workspace.id,
    threadId: first.id,
    turnId: turn.id,
    data: { type: 'turn-started', turnId: turn.id, status: 'running' },
  });
  const workspaceRoot = join(root, 'workspaces', workspace.id);
  const turnRoot = join(workspaceRoot, 'threads', first.id, 'turns', turn.id);
  return {
    root,
    store,
    workspace,
    healthy,
    item,
    workspaceRoot,
    itemsPath: join(turnRoot, 'items.jsonl'),
    eventsPath: join(turnRoot, 'runtime', 'events.jsonl'),
    laterPath: join(workspaceRoot, 'threads', later.id, 'thread.json'),
  };
}

/** Captures every entry and regular-file byte in the refused tree, including missing-file evidence. */
function tree(root: string): Record<string, Buffer | string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true })
      .sort()
      .map((path) => {
        const full = join(root, path);
        return [path, lstatSync(full).isDirectory() ? 'directory' : readFileSync(full)];
      })
  );
}

describe('Workspace file admission preservation', () => {
  for (const log of ['items', 'events'] as const) {
    it.each([
      'no-newline',
      'incomplete-fragment',
    ] as const)(`preserves ${log} %s bytes when later history refuses the scope`, async (fault) => {
      const f = await fixture();
      const path = log === 'items' ? f.itemsPath : f.eventsPath;
      const complete = readFileSync(path);
      expect(complete.at(-1)).toBe(0x0a);
      writeFileSync(
        path,
        fault === 'no-newline'
          ? complete.subarray(0, -1)
          : Buffer.concat([complete, Buffer.from('{"incomplete":')])
      );
      rmSync(f.laterPath);
      const before = tree(f.workspaceRoot);
      expect(() => FsStore.validateFileAuthority(f.root)).not.toThrow();
      const reopened = new FsStore({ dataRoot: f.root });
      expect(() => reopened.getWorkspace(f.workspace.id)).toThrow(
        expect.objectContaining({ code: 'recovery_required' })
      );
      expect(reopened.getWorkspace(f.healthy.id)).toEqual(f.healthy);
      await reopened.createThread(f.healthy.id, 'Still writable');
      expect(tree(f.workspaceRoot)).toEqual(before);
    });
  }

  it('does not normalize file tails before a later approval SQL-reader refusal', async () => {
    const f = await fixture();
    const complete = readFileSync(f.itemsPath);
    writeFileSync(f.itemsPath, complete.subarray(0, -1));
    const db = openWorkspaceDb(f.root, f.workspace.id);
    db.sqlite.exec('DROP TABLE pending_requests');
    db.sqlite.close();
    const before = tree(f.workspaceRoot);
    const reopened = new FsStore({ dataRoot: f.root });
    expect(() => reopened.getWorkspace(f.workspace.id)).toThrow(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(reopened.getWorkspace(f.healthy.id)).toEqual(f.healthy);
    expect(tree(f.workspaceRoot)).toEqual(before);
  });

  it.each([
    'server',
    'workspace',
    'missing',
    'unsupported',
  ] as const)('keeps the required refusal boundary for %s Item ownership', async (kind) => {
    const f = await fixture();
    const raw = JSON.parse(readFileSync(f.itemsPath, 'utf8').trimEnd());
    if (kind === 'missing') delete raw.owner;
    else
      raw.owner =
        kind === 'server'
          ? { kind: 'server' }
          : kind === 'workspace'
            ? { kind: 'workspace', workspaceId: f.healthy.id }
            : { kind: 'user', userId: actor.id };
    const foreign = kind === 'server' || kind === 'workspace';
    if (foreign) {
      expect(WorkOwnerSchema.safeParse(raw.owner).success).toBe(true);
      expect(() => readRetainedV1(raw, ItemSchema.parse)).not.toThrow();
    }
    writeFileSync(f.itemsPath, `${JSON.stringify(raw)}\n`);
    const before = tree(f.workspaceRoot);
    if (foreign) {
      expect(() => FsStore.validateFileAuthority(f.root)).toThrow(WorkOwnershipViolationError);
      expect(() => new FsStore({ dataRoot: f.root })).toThrow(WorkOwnershipViolationError);
    } else {
      expect(() => FsStore.validateFileAuthority(f.root)).not.toThrow();
      const reopened = new FsStore({ dataRoot: f.root });
      expect(() => reopened.getWorkspace(f.workspace.id)).toThrow(
        expect.objectContaining({ code: 'recovery_required' })
      );
      expect(reopened.getWorkspace(f.healthy.id)).toEqual(f.healthy);
    }
    expect(tree(f.workspaceRoot)).toEqual(before);
  });
});
