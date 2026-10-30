import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRetainedV1 } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createTestStore } from '../test-support/store.js';
import {
  ControlStoreWorkerError,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';

const partialWriteState = vi.hoisted(() => {
  const nativeWrites = new Int32Array(new SharedArrayBuffer(8));
  return {
    calls: 0,
    failSync: false,
    fullReads: 0,
    nativeRoot: '',
    nativeWrites,
    get nativeCalls() {
      return Atomics.load(nativeWrites, 0);
    },
    set nativeCalls(value: number) {
      Atomics.store(nativeWrites, 0, value);
    },
    get failNativeWrite() {
      return Atomics.load(nativeWrites, 1) !== 0;
    },
    set failNativeWrite(value: boolean) {
      Atomics.store(nativeWrites, 1, Number(value));
    },
  };
});

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

// Wrap the actual native entry so the fault reaches its immutable FileHandle writes.
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (!partialWriteState.nativeRoot) {
          super(filename, options);
          return;
        }
        const prelude = `
          const {workerData} = require('node:worker_threads');
          const state = new Int32Array(workerData.nativeWrites);
          const fs = require('node:fs/promises'), open = fs.open;
          fs.open = async (...args) => {
            const file = await open(...args);
            if (typeof args[0] === 'string' && args[0].startsWith(workerData.nativeRoot) && args[0].endsWith('.tmp')) {
              const write = file.write.bind(file);
              file.write = async (buffer, offset, length, position) => {
                const calls = Atomics.add(state, 0, 1) + 1;
                if (Atomics.load(state, 1) && calls === 2)
                  throw new Error('injected immutable write failure');
                return write(buffer, offset, Math.max(1, Math.ceil(length / 2)), position);
              };
            }
            return file;
          };
          require('node:module').syncBuiltinESMExports();
        `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            nativeRoot: partialWriteState.nativeRoot,
            nativeWrites: partialWriteState.nativeWrites.buffer,
          },
        });
      }
    },
  };
});

import { openWorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';
import { appendWorkObservation, readWorkObservations } from './work-observations.js';
import {
  appendCanonicalTextFile,
  nativeProductScope,
  readNativeProductEntries,
} from './workspace-file-records.js';

describe('canonical append writes', () => {
  it('does not acknowledge a failed observation commit through cached state or replay', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-observation-sync-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Durability');
    const thread = await store.createThread(workspace.id, 'Durability');
    const turn = await store.createTurn(
      workspace.id,
      thread.id,
      'Durability',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
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
        obs: 'llm-gateway' as const,
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
      await appendWorkObservation(db, input);
      input.observation.id = 'next';
      // The observation owner is native SQL; a Main fsync mock cannot fault its commit.
      db.sqlite.exec(
        `CREATE TRIGGER refuse_next_observation BEFORE INSERT ON control_work_observations
         WHEN NEW.id = 'next' BEGIN SELECT RAISE(ABORT, 'injected observation commit failure'); END`
      );
      await expect(appendWorkObservation(db, input)).rejects.toThrow();
      await expect(appendWorkObservation(db, input)).rejects.toThrow();
      expect(readWorkObservations(db, input).map((row) => row.id)).toEqual(['warm']);
      db.sqlite.exec('DROP TRIGGER refuse_next_observation');
      expect((await appendWorkObservation(db, input)).disposition).toBe('committed');
      expect((await appendWorkObservation(db, input)).disposition).toBe('duplicate');
      expect(readWorkObservations(db, input).map((row) => row.id)).toEqual(['warm', 'next']);
    } finally {
      partialWriteState.failSync = false;
      db.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('retains full recovery validation for incomplete append boundaries', async () => {
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
      await shutdownControlStoreWorkerClient();
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
  it('finishes one immutable Item body when the filesystem reports partial writes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-partial-append-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Partial immutable write');
    const threadId = 'th_00000000-0000-7855-a199-a72329fa45c0';
    const thread = await store.createThread(workspace.id, 'Partial immutable write', threadId);
    const turn = await store.createTurn(workspace.id, thread.id, 'Partial immutable write', {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    });
    const item = {
      id: 'it_00000000-0000-7399-9fe3-0b3d37002502',
      owner: { kind: 'workspace', workspaceId: workspace.id },
      threadId,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      // Keep this partial-write subject on the real immutable-file branch.
      text: 'The complete row must reach the append log.'.padEnd(70_000, '.'),
      createdAt: '2026-07-07T00:00:00.000Z',
      completedAt: '2026-07-07T00:00:00.000Z',
    } as const;

    const scope = nativeProductScope(dataRoot, item.owner);
    const before = store.getTurnById(turn.id);
    const entriesBefore = readNativeProductEntries(scope, turn.id, 'item');
    // Restart only the native host to install this scope's real FileHandle fault.
    await shutdownControlStoreWorkerClient();
    partialWriteState.nativeRoot = `${scope.contentMount.root}/`;
    partialWriteState.nativeCalls = 0;
    partialWriteState.failNativeWrite = true;
    try {
      const failed = store.createItem(item);
      // The native protocol returns closed failure facts, never the injected exception text.
      await expect(failed).rejects.toBeInstanceOf(ControlStoreWorkerError);
      await expect(failed).rejects.toMatchObject({
        code: 'sql-failed',
        commit: 'not-committed',
        message: 'Control database writer operation failed.',
      });
      expect(partialWriteState.nativeCalls).toBe(2);
      expect(store.getTurnById(turn.id)).toEqual(before);
      expect(readNativeProductEntries(scope, turn.id, 'item')).toEqual(entriesBefore);
      partialWriteState.failNativeWrite = false;
      partialWriteState.nativeCalls = 0;
      await store.createItem(item);
      expect(readNativeProductEntries(scope, turn.id, 'item').map((row) => row.value)).toEqual([
        writeRetainedV1(item),
      ]);
      expect(partialWriteState.nativeCalls).toBeGreaterThan(1);
      await shutdownControlStoreWorkerClient();
      expect(createTestStore({ dataRoot }).getTurnById(turn.id).items).toEqual([item]);
    } finally {
      partialWriteState.nativeRoot = '';
      partialWriteState.failNativeWrite = false;
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
