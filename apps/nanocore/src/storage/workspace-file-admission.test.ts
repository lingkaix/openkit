// openkit-test-platform: posix
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, ItemSchema, readRetainedV1, WorkOwnerSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createTestStore } from '../test-support/store.js';
import { openControlStoreProductReadHandle } from './control-store-products.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb } from './db.js';
import { WorkOwnershipViolationError } from './fs-layout.js';
import { publishImmutableProductJson } from './immutable-content.js';
import { nativeProductScope } from './workspace-file-records.js';

const roots: string[] = [];
const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Publishes acknowledged native history; a later referenced Thread supplies an independent admission fault. */
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
  const item = await store.createItem({
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
  await store.persistTurnEvent(turn.id, {
    event: 'turn.started',
    workspaceId: workspace.id,
    threadId: first.id,
    turnId: turn.id,
    data: { type: 'turn-started', turnId: turn.id, status: 'running' },
  });
  await store.createTurn(workspace.id, later.id, 'Later retained input', actor);
  await shutdownControlStoreWorkerClient();
  const workspaceRoot = join(root, 'workspaces', workspace.id);
  const scope = nativeProductScope(root, { kind: 'workspace', workspaceId: workspace.id });
  const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
  let itemContent: ReturnType<typeof reader.entries>[number]['content'];
  let eventContent: typeof itemContent;
  try {
    itemContent = reader.entries(turn.id, 'item')[0]!.content;
    eventContent = reader.entries(turn.id, 'event')[0]!.content;
  } finally {
    reader.close();
  }
  return {
    root,
    store,
    workspace,
    healthy,
    item,
    workspaceRoot,
    scope,
    turn,
    laterThreadId: later.id,
    itemsPath: join(scope.contentMount.root, itemContent.reference.locator.path),
    eventsPath: join(scope.contentMount.root, eventContent.reference.locator.path),
  };
}

/** Preserves native SQL schema/raw values and all other bytes; only its regular WAL/SHM are bookkeeping. */
function tree(root: string): Record<string, Buffer | string> {
  const entries: Record<string, Buffer | string> = {};
  const visit = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const key = join(prefix, entry.name);
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        entries[key] = `link:${readlinkSync(path)}`;
      } else if (entry.isDirectory()) {
        entries[key] = 'directory';
        visit(path, key);
      } else if (entry.isFile()) {
        if (key === join('db', 'workspace.sqlite')) {
          const sqlite = new Database(path, { readonly: true, fileMustExist: true });
          try {
            entries[key] = sqlite.transaction(() => {
              const schema = sqlite
                .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
                .all();
              const tables = sqlite
                .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
                .all() as { name: string }[];
              const rows = tables.map(({ name }) => [
                name,
                sqlite
                  .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
                  .raw(true)
                  .safeIntegers(true)
                  .all()
                  .map((row) =>
                    JSON.stringify(row, (_key, value) =>
                      typeof value === 'bigint' ? { integer: value.toString() } : value
                    )
                  )
                  .sort(),
              ]);
              return Buffer.from(JSON.stringify({ schema, rows }));
            })();
          } finally {
            sqlite.close();
          }
        } else if (
          key !== join('db', 'workspace.sqlite-wal') &&
          key !== join('db', 'workspace.sqlite-shm')
        ) {
          entries[key] = readFileSync(path);
        }
      } else {
        throw new Error('Retained snapshot requires a directory, regular file or symbolic link.');
      }
    }
  };
  visit(root);
  return entries;
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
      expect(complete.at(-1)).not.toBe(0x0a);
      if (fault === 'incomplete-fragment') {
        chmodSync(path, 0o600);
        writeFileSync(path, Buffer.concat([complete, Buffer.from('{"incomplete":')]));
        chmodSync(path, 0o444);
      }
      const db = openWorkspaceDb(f.root, f.workspace.id);
      try {
        // Keep the later Turn's durable reference, so the missing Thread remains detectable authority loss.
        db.sqlite.pragma('foreign_keys = OFF');
        db.sqlite.prepare('DELETE FROM control_threads WHERE id=?').run(f.laterThreadId);
        db.sqlite.pragma('foreign_keys = ON');
      } finally {
        db.sqlite.close();
      }
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
    expect(complete.at(-1)).not.toBe(0x0a);
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
    const content = await publishImmutableProductJson(
      f.scope.contentMount,
      f.scope.owner,
      join(f.workspaceRoot, 'runtime', 'staging'),
      raw
    );
    const db = openWorkspaceDb(f.root, f.workspace.id);
    try {
      db.sqlite
        .prepare(
          "UPDATE control_product_entries SET content_json=? WHERE kind='item' AND turn_id=? AND sequence=1"
        )
        .run(JSON.stringify(content), f.turn.id);
    } finally {
      db.sqlite.close();
    }
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
