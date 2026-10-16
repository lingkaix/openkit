// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const trace = vi.hoisted(() => ({
  events: [] as Array<{ op: 'writeFileSync' | 'fsyncSync' | 'renameSync'; to?: string }>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      trace.events.push({ op: 'writeFileSync' });
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
    fsyncSync: ((descriptor: number) => {
      trace.events.push({ op: 'fsyncSync' });
      return actual.fsyncSync(descriptor);
    }) as typeof actual.fsyncSync,
    renameSync: ((
      from: Parameters<typeof actual.renameSync>[0],
      to: Parameters<typeof actual.renameSync>[1]
    ) => {
      trace.events.push({ op: 'renameSync', to: String(to) });
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
  };
});

import { FsStore } from '../lib/store.js';
import { migrateThreadVisibilityCutover } from './thread-visibility-cutover-migration.js';

/**
 * Requires a file fsync between the temporary write and rename, then a directory fsync.
 *
 * @param events Recorded filesystem operations.
 * @param destinationSuffix Renamed target suffix.
 */
function expectDurableRename(
  events: Array<{ op: 'writeFileSync' | 'fsyncSync' | 'renameSync'; to?: string }>,
  destinationSuffix: string
): void {
  const renameAt = events.findIndex(
    (event) => event.op === 'renameSync' && event.to?.endsWith(destinationSuffix)
  );
  expect(renameAt).toBeGreaterThan(0);
  const writeAt = events.slice(0, renameAt).findLastIndex((event) => event.op === 'writeFileSync');
  expect(writeAt).toBeGreaterThanOrEqual(0);
  expect(events.slice(writeAt + 1, renameAt).some((event) => event.op === 'fsyncSync')).toBe(true);
  expect(events.slice(renameAt + 1).some((event) => event.op === 'fsyncSync')).toBe(true);
}

/** Reads one persisted Thread record from an isolated store. */
function threadRecord(dataRoot: string, workspaceId: string, threadId: string) {
  const path = join(dataRoot, 'workspaces', workspaceId, 'threads', threadId, 'thread.json');
  return {
    path,
    value: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>,
  };
}

/** Removes only visibility-era metadata and recomputes the predecessor envelope digest. */
function predecessorRecord(value: Record<string, unknown>) {
  const predecessor = { ...value };
  delete predecessor.visibility;
  delete predecessor.privateOwnerUserId;
  predecessor.requiredFeatures = ['openkit.thread-entry.v1'];
  const { id, workspaceId, name, preview, status, entryPath, createdAt, updatedAt } = predecessor;
  predecessor.contentDigest = `sha256:${createHash('sha256').update(JSON.stringify({ id, workspaceId, name, preview, status, entryPath, createdAt, updatedAt })).digest('hex')}`;
  return predecessor;
}

describe('Thread visibility cutover durable publication', () => {
  it('fsyncs thread.json before and after the atomic rename', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-visibility-durable-'));
    const backupRoot = mkdtempSync(join(tmpdir(), 'openkit-visibility-durable-backup-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Migration workspace');
    const formal = store.createThread(workspace.id, 'Formal worker history');
    const turn = store.createTurn(workspace.id, formal.id, 'Work', {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    });
    store.updateTurn(turn.id, { agentId: 'agent_codex_host' });
    const current = threadRecord(dataRoot, workspace.id, formal.id);
    writeFileSync(current.path, `${JSON.stringify(predecessorRecord(current.value))}\n`);

    trace.events.length = 0;
    const applied = migrateThreadVisibilityCutover({
      backupRoot,
      dataRoot,
    });
    expect(applied).toMatchObject({ applied: true, outcome: 'succeeded', writtenCount: 1 });
    expectDurableRename(trace.events, '/thread.json');
  });
});
