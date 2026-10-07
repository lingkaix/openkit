import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const partialWriteState = vi.hoisted(() => ({ calls: 0, failSync: false, fullReads: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const writeSync = ((...args: unknown[]) => {
    const descriptor = args[0] as number;
    const value = args[1];

    partialWriteState.calls += 1;
    if (typeof value === 'string') {
      const buffer = Buffer.from(value);
      return actual.writeSync(descriptor, buffer, 0, Math.max(1, Math.ceil(buffer.length / 2)));
    }

    const buffer = value as Uint8Array;
    const offset = (args[2] as number | undefined) ?? 0;
    const length = (args[3] as number | undefined) ?? buffer.byteLength - offset;
    return actual.writeSync(descriptor, buffer, offset, Math.max(1, Math.ceil(length / 2)));
  }) as typeof actual.writeSync;

  return {
    ...actual,
    writeSync,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      partialWriteState.fullReads++;
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
    fsyncSync: (descriptor: number) => {
      if (partialWriteState.failSync) throw new Error('injected durability failure');
      actual.fsyncSync(descriptor);
    },
  };
});

import { FsStore } from '../lib/store.js';
import { openWorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';
import { appendWorkObservation, readWorkObservations } from './work-observations.js';
import { appendCanonicalTextFile, appendWorkspaceItemRevision } from './workspace-file-records.js';

describe('canonical append writes', () => {
  it('does not acknowledge a failed observation commit through cached state or replay', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-observation-sync-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Durability');
    const thread = store.createThread(workspace.id, 'Durability');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Durability',
      { kind: 'user', id: 'user_local' },
      null,
      { captureCoverage: { scope: 'server', value: 'off' } }
    );
    const db = openWorkspaceDb(dataRoot, workspace.id);
    applyScopedMigrations(db);
    const input = {
      threadId: thread.id,
      turnId: turn.id,
      observation: {
        id: 'warm',
        type: 'model.observed',
        ts: '2026-10-07T00:00:00.000Z',
        obs: 'gateway' as const,
        payload: {
          direction: 'response',
          event: 'text_delta',
          attempt: 0,
          runtimeOriginRef: null,
          content: { state: 'off' },
        },
      },
      bodies: [],
    };
    try {
      appendWorkObservation(db, input);
      input.observation.id = 'next';
      partialWriteState.failSync = true;
      expect(() => appendWorkObservation(db, input)).toThrow('injected durability failure');
      expect(() => appendWorkObservation(db, input)).toThrow('injected durability failure');
      partialWriteState.failSync = false;
      expect(appendWorkObservation(db, input).disposition).toBe('duplicate');
      expect(readWorkObservations(db, input).map((row) => row.id)).toEqual(['warm', 'next']);
    } finally {
      partialWriteState.failSync = false;
      db.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('retains full recovery validation for incomplete append boundaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-append-tail-'));
    const path = join(root, 'events.jsonl');
    try {
      appendCanonicalTextFile(path, '{"id":"warm"}\n');
      appendFileSync(path, '{"id":"torn');
      appendCanonicalTextFile(path, '{"id":"next"}\n');
      expect(readFileSync(path, 'utf8')).toBe('{"id":"warm"}\n{"id":"next"}\n');
      appendFileSync(path, '{"id":"complete"}');
      appendCanonicalTextFile(path, '{"id":"last"}\n');
      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(4);
      appendFileSync(path, '{malformed}');
      expect(() => appendCanonicalTextFile(path, '{"id":"refused"}\n')).toThrow(SyntaxError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks complete append boundaries without full-file reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-append-bound-'));
    const path = join(root, 'events.jsonl');
    appendCanonicalTextFile(path, '{"id":"warm"}\n');
    partialWriteState.fullReads = 0;
    for (let index = 0; index < 20; index++)
      appendCanonicalTextFile(path, `${JSON.stringify({ id: index })}\n`);
    expect(partialWriteState.fullReads).toBe(0);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(21);
  });
  it('does not acknowledge an append when durable synchronization fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-append-sync-'));
    partialWriteState.failSync = true;
    try {
      expect(() => appendCanonicalTextFile(join(root, 'events.jsonl'), '{"id":"one"}\n')).toThrow(
        'injected durability failure'
      );
    } finally {
      partialWriteState.failSync = false;
    }
  });
  it('finishes one JSONL row when the filesystem reports partial writes', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openkit-partial-append-'));
    const threadId = 'th_partial_append';
    const turnId = 'tu_partial_append';
    const item = {
      id: 'it_partial_append',
      workspaceId: 'ws_partial_append',
      threadId,
      turnId,
      type: 'assistant-message',
      status: 'completed',
      text: 'The complete row must reach the append log.',
      createdAt: '2026-07-07T00:00:00.000Z',
      completedAt: '2026-07-07T00:00:00.000Z',
    } as const;

    mkdirSync(join(workspaceRoot, 'threads', threadId, 'turns', turnId), { recursive: true });
    appendWorkspaceItemRevision(workspaceRoot, item);

    const content = readFileSync(
      join(workspaceRoot, 'threads', threadId, 'turns', turnId, 'items.jsonl'),
      'utf8'
    );
    expect(JSON.parse(content)).toEqual(item);
    expect(partialWriteState.calls).toBeGreaterThan(1);
  });
});
