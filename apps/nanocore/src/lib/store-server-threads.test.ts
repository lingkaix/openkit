import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION, FsStore } from './store.js';

const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

describe('Server-owned canonical history', () => {
  it('retains Server Thread, Turn, Item revisions and transcript without Workspace placement', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'server-threads-'));
    try {
      const store = new FsStore({ dataRoot });
      const workspace = store.createWorkspace('Workspace');
      const workspaceThread = store.createThread(workspace.id, 'Workspace work');
      const thread = store.createServerThread('Server maintenance');
      const turn = store.createServerTurn(thread.id, 'Maintain', actor);
      const item = store.createServerItem({
        id: allocateEntityId('it'),
        owner: { kind: 'server' },
        threadId: thread.id,
        turnId: turn.id,
        type: 'assistant-message',
        text: 'Initial',
        status: 'in_progress',
        createdAt: turn.startedAt!,
        completedAt: null,
      });
      store.updateServerItem(item.id, { text: 'Retained', status: 'completed' });
      store.emitServerTurnEvent(turn.id, {
        event: 'item.completed',
        threadId: thread.id,
        turnId: turn.id,
        data: { type: 'item-completed', itemId: item.id, item: store.getServerItemById(item.id) },
      });
      store.updateServerTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      const reopened = new FsStore({ dataRoot });
      expect(reopened.getServerThread(thread.id)).toMatchObject({
        ...thread,
        preview: 'Maintain',
        updatedAt: turn.startedAt,
      });
      expect(reopened.getServerTurn(thread.id, turn.id).status).toBe('completed');
      expect(reopened.listServerThreadItems(thread.id)).toEqual([
        expect.objectContaining({ text: 'Retained' }),
      ]);
      expect(reopened.getServerTurnEvents(turn.id)).toHaveLength(1);
      expect(reopened.listThreads(workspace.id)).toEqual([workspaceThread]);
      expect(reopened.listWorkspaceItemRevisions(workspace.id)).toEqual([]);
      expect(reopened.getTurnCaptureCoverage(turn.id)).toEqual({ scope: 'server', value: 'off' });
      expect(() => reopened.getTurnById(turn.id)).toThrow('Turn not found');
      const root = join(dataRoot, 'server', 'threads', thread.id);
      expect(readFileSync(join(root, 'thread.json'), 'utf8')).not.toContain('workspaceId');
      expect(
        readFileSync(join(root, 'turns', turn.id, 'items.jsonl'), 'utf8')
          .trim()
          .split('\n')
      ).toHaveLength(2);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('keeps ownership immutable and refuses overlapping or archived work after reload', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'server-threads-'));
    try {
      const store = new FsStore({ dataRoot });
      const thread = store.createServerThread('Server');
      const turn = store.createServerTurn(thread.id, 'Work', actor);
      const reopened = new FsStore({ dataRoot });
      expect(reopened.getServerTurnById(turn.id).status).toBe('running');
      const skipped = reopened.createServerTurn(thread.id, 'Skipped: busy', actor, null, {
        status: 'completed',
      });
      const skipItem = reopened.createServerItem(
        {
          id: allocateEntityId('it'),
          owner: { kind: 'server' },
          threadId: thread.id,
          turnId: skipped.id,
          type: 'status',
          level: 'info',
          title: 'Skipped: busy',
          summary: null,
          status: 'completed',
          createdAt: skipped.startedAt!,
          completedAt: skipped.completedAt,
        },
        ALREADY_DECIDED_PUBLICATION_ADMISSION
      );
      reopened.emitServerTurnEvent(
        skipped.id,
        {
          event: 'item.completed',
          threadId: thread.id,
          turnId: skipped.id,
          data: { type: 'item-completed', itemId: skipItem.id, item: skipItem },
        },
        ALREADY_DECIDED_PUBLICATION_ADMISSION
      );
      expect(reopened.getServerTurnTranscript(skipped.id)).toHaveLength(1);
      expect(skipped.durationMs).toBe(0);
      expect(reopened.getServerItemById(skipItem.id).type).toBe('status');
      expect(new FsStore({ dataRoot }).listServerThreadTurns(thread.id)).toHaveLength(2);

      expect(() => reopened.createServerTurn(thread.id, 'Overlap', actor)).toThrow('in flight');
      expect(() =>
        reopened.updateServerTurn(turn.id, { workspaceId: allocateEntityId('ws') } as never)
      ).toThrow('cannot change');
      expect(() =>
        reopened.updateServerThread(thread.id, { owner: { kind: 'workspace' } } as never)
      ).toThrow('cannot change');
      reopened.updateServerTurn(turn.id, {
        status: 'interrupted',
        completedAt: new Date().toISOString(),
      });
      reopened.updateServerThread(thread.id, { status: 'archived' });
      expect(() => reopened.createServerTurn(thread.id, 'After archive', actor)).toThrow(
        'archived'
      );
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
  it('preserves retained additions and refuses corrupt owner or transcript lineage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'server-threads-'));
    try {
      const store = new FsStore({ dataRoot });
      const thread = store.createServerThread('Server');
      const turn = store.createServerTurn(thread.id, 'Work', actor);
      const threadPath = join(dataRoot, 'server', 'threads', thread.id, 'thread.json');
      const turnPath = join(
        dataRoot,
        'server',
        'threads',
        thread.id,
        'turns',
        turn.id,
        'turn.json'
      );
      const rawThread = JSON.parse(readFileSync(threadPath, 'utf8'));
      rawThread.note = 'retained';
      rawThread.owner.note = 'retained owner description';
      writeFileSync(threadPath, JSON.stringify(rawThread));
      const rawTurn = JSON.parse(readFileSync(turnPath, 'utf8'));
      rawTurn.triggerActor.note = 'retained actor description';
      writeFileSync(turnPath, JSON.stringify(rawTurn));
      const reopened = new FsStore({ dataRoot });
      reopened.updateServerThread(thread.id, { name: 'Renamed' });
      reopened.updateServerTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      expect(JSON.parse(readFileSync(threadPath, 'utf8'))).toMatchObject({
        note: 'retained',
        owner: { note: 'retained owner description' },
      });
      expect(JSON.parse(readFileSync(turnPath, 'utf8')).triggerActor.note).toBe(
        'retained actor description'
      );
      reopened.emitServerTurnEvent(turn.id, {
        event: 'turn.completed',
        threadId: thread.id,
        turnId: turn.id,
        data: {
          type: 'turn-completed',
          stopReason: 'completed',
          turn: reopened.getServerTurnById(turn.id),
        },
      });
      expect(new FsStore({ dataRoot }).getServerTurnTranscript(turn.id)).toHaveLength(1);
      rawThread.owner.kind = 'workspace';
      writeFileSync(threadPath, JSON.stringify(rawThread));
      expect(() => new FsStore({ dataRoot })).toThrow();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
