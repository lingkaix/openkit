import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import { FsStore } from './store.js';

const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

describe('one nonterminal Turn per Thread', () => {
  it.each(['pending', 'running'] as const)(
    'refuses a second native admission after cold %s reconstruction',
    async (status) => {
      const dataRoot = mkdtempSync(join(tmpdir(), 'thread-admission-'));
      onTestFinished(() => disposeTestStore(dataRoot));
      const store = createTestStore({ dataRoot });
      const workspace = await store.createWorkspace('Admission');
      const thread = await store.createThread(workspace.id, 'Origin');
      const first = await store.createTurn(workspace.id, thread.id, 'First', actor, null, {
        status,
      });
      const cold = new FsStore({ dataRoot });
      await expect(cold.createTurn(workspace.id, thread.id, 'Second', actor)).rejects.toMatchObject(
        { code: 'thread_busy' }
      );
      expect(store.listThreadTurns(workspace.id, thread.id).map((turn) => turn.id)).toEqual([
        first.id,
      ]);
    }
  );

  it('admits exactly one of two simultaneous native submissions', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'thread-race-'));
    onTestFinished(() => disposeTestStore(dataRoot));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Race');
    const thread = await store.createThread(workspace.id, 'Origin');
    const peer = new FsStore({ dataRoot });
    const results = await Promise.allSettled([
      store.createTurn(workspace.id, thread.id, 'First', actor),
      peer.createTurn(workspace.id, thread.id, 'Second', actor),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'thread_busy' },
    });
    expect(store.listThreadTurns(workspace.id, thread.id)).toHaveLength(1);
  });
});
