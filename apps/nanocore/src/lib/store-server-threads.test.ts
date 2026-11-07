import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { readWorkObservationBody, workObservationBodyBundleId } from '../evidence-bundles.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  appendWorkObservation,
  readWorkObservations,
  type WorkObservationDraft,
} from '../storage/work-observations.js';
import { disposeTestStore } from '../test-support/store.js';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION, FsStore } from './store.js';

const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

describe('Server-owned canonical history', () => {
  it('retains Server Thread, Turn, Item revisions and transcript without Workspace placement', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'server-threads-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    try {
      const store = new FsStore({ dataRoot });
      const workspace = await store.createWorkspace('Workspace');
      const workspaceThread = await store.createThread(workspace.id, 'Workspace work');
      const thread = await store.createServerThread('Server maintenance');
      const turn = await store.createServerTurn(thread.id, 'Maintain', actor);
      const item = await store.createServerItem({
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
      await store.updateServerItem(item.id, { text: 'Retained', status: 'completed' });
      const event = await store.persistServerTurnEvent(turn.id, {
        event: 'item.completed',
        threadId: thread.id,
        turnId: turn.id,
        data: { type: 'item-completed', itemId: item.id, item: store.getServerItemById(item.id) },
      });
      store.emitServerTurnEvent(turn.id, event);
      await store.updateServerTurn(turn.id, {
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
      expect(reopened.listServerThreadTurns(thread.id).flatMap((turn) => turn.items)).toEqual([
        expect.objectContaining({ text: 'Retained' }),
      ]);
      expect(reopened.getServerTurnTranscript(turn.id)).toEqual([
        event,
        expect.objectContaining({
          event: 'turn.completed',
          data: {
            type: 'turn-completed',
            stopReason: 'completed',
            turn: reopened.getServerTurnById(turn.id),
          },
        }),
      ]);
      expect(reopened.listThreads(workspace.id)).toEqual([workspaceThread]);
      expect(reopened.listWorkspaceItemRevisions(workspace.id)).toEqual([]);
      expect(reopened.getTurnCaptureCoverage(turn.id)).toEqual({ scope: 'server', value: 'off' });
      expect(() => reopened.getTurnById(turn.id)).toThrow('Turn not found');
      const retained = coreDb.sqlite
        .prepare('SELECT record_json FROM control_threads WHERE id=?')
        .get(thread.id) as { record_json: string };
      expect(retained.record_json).not.toContain('workspaceId');
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT revision FROM control_product_entries WHERE kind='item' AND id=? ORDER BY revision"
          )
          .all(item.id)
      ).toEqual([{ revision: 1 }, { revision: 2 }]);
    } finally {
      await disposeTestStore(dataRoot, coreDb);
    }
  });

  it('retains Server observations and exact bodies across rollback, terminal publication and cold reopen', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'server-observations-'));
    let coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    try {
      const store = new FsStore({ dataRoot });
      const thread = await store.createServerThread('Server capture');
      const turn = await store.createServerTurn(thread.id, 'Capture Server work', actor, null, {
        startedAt: '2026-10-20T00:00:00.000Z',
        captureCoverage: { scope: 'server', value: 'on' },
      });
      const owner = { threadId: thread.id, turnId: turn.id };
      const environment: WorkObservationDraft = {
        id: 'server-environment',
        type: 'env.bound',
        ts: '2026-10-20T00:00:01.000Z',
        obs: 'nanocore',
        payload: {
          version: '1',
          owner: { kind: 'server' },
          systemPromptDigest: `sha256:${'a'.repeat(64)}`,
          tools: [],
        },
      };
      const first = await appendWorkObservation(coreDb, {
        ...owner,
        observation: environment,
        bodies: [],
      });
      expect(first.disposition).toBe('committed');
      expect(first.observation.seq).toBe(1);
      expect(
        await appendWorkObservation(coreDb, { ...owner, observation: environment, bodies: [] })
      ).toEqual({
        ...first,
        disposition: 'duplicate',
      });
      const bytes = Buffer.from('{"prompt":"Exact Server capture"}\r\n');
      await appendWorkObservation(coreDb, {
        ...owner,
        observation: {
          id: 'server-request',
          type: 'model.observed',
          ts: '2026-10-20T00:00:02.000Z',
          obs: 'llm-gateway',
          corr: 'server-call',
          payload: {
            attempt: 0,
            direction: 'request',
            event: 'request',
            runtimeOriginRef: null,
            providerRef: 'test',
            model: 'test',
            systemPromptDigest: `sha256:${'a'.repeat(64)}`,
            sampling: {},
            content: { state: 'expected' },
          },
        },
        bodies: [
          { id: 'request', bytes, mediaType: 'application/json', boundary: 'model-request' },
        ],
      });
      const body = {
        ...owner,
        bundleId: workObservationBodyBundleId(
          { kind: 'server' },
          thread.id,
          turn.id,
          'server-request',
          'request'
        ),
        createdAt: '2026-10-20T00:00:02.000Z',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const retained = readWorkObservations(coreDb, owner);
      expect(retained.map((value) => [value.seq, value.type])).toEqual([
        [1, 'env.bound'],
        [2, 'model.observed'],
        [3, 'content.published'],
      ]);
      expect(Buffer.from(readWorkObservationBody(coreDb, body)!)).toEqual(bytes);
      await expect(
        appendWorkObservation(coreDb, {
          ...owner,
          observation: {
            ...environment,
            id: 'foreign-environment',
            payload: {
              version: '1',
              workspaceId: allocateEntityId('ws'),
              systemPromptDigest: `sha256:${'a'.repeat(64)}`,
              tools: [],
            },
          },
          bodies: [],
        })
      ).rejects.toThrow();
      expect(readWorkObservations(coreDb, owner)).toEqual(retained);
      // Deliberate native failure follows genuine public Thread, Turn and observation admission.
      coreDb.sqlite.exec(`CREATE TRIGGER refuse_server_observation BEFORE INSERT ON control_work_observations
        BEGIN SELECT RAISE(ABORT, 'injected Server observation refusal'); END`);
      try {
        await expect(
          appendWorkObservation(coreDb, {
            ...owner,
            observation: { ...environment, id: 'refused-environment' },
            bodies: [],
          })
        ).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
      } finally {
        coreDb.sqlite.exec('DROP TRIGGER refuse_server_observation');
      }
      expect(readWorkObservations(coreDb, owner)).toEqual(retained);
      expect(Buffer.from(readWorkObservationBody(coreDb, body)!)).toEqual(bytes);
      await store.updateServerTurn(turn.id, {
        status: 'completed',
        completedAt: '2026-10-20T00:00:03.000Z',
      });
      const sealed = readWorkObservations(coreDb, owner);
      expect(sealed.at(-1)).toMatchObject({ type: 'turn.reap', payload: { reason: 'completed' } });
      await getControlStoreWorkerClient().shutdown();
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      expect(new FsStore({ dataRoot }).getServerTurnById(turn.id).status).toBe('completed');
      expect(readWorkObservations(coreDb, owner)).toEqual(sealed);
      expect(Buffer.from(readWorkObservationBody(coreDb, body)!)).toEqual(bytes);
    } finally {
      await disposeTestStore(dataRoot, coreDb);
    }
  });

  it('keeps ownership immutable and refuses overlapping or archived work after reload', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'server-threads-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    try {
      const store = new FsStore({ dataRoot });
      const thread = await store.createServerThread('Server');
      const turn = await store.createServerTurn(thread.id, 'Work', actor);
      const reopened = new FsStore({ dataRoot });
      expect(reopened.getServerTurnById(turn.id).status).toBe('running');
      const skipped = await reopened.createServerTurn(thread.id, 'Skipped: busy', actor, null, {
        status: 'completed',
      });
      const skipItem = await reopened.createServerItem(
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
      const skipEvent = await reopened.persistServerTurnEvent(
        skipped.id,
        {
          event: 'item.completed',
          threadId: thread.id,
          turnId: skipped.id,
          data: { type: 'item-completed', itemId: skipItem.id, item: skipItem },
        },
        ALREADY_DECIDED_PUBLICATION_ADMISSION
      );
      reopened.emitServerTurnEvent(skipped.id, skipEvent);
      expect(reopened.getServerTurnTranscript(skipped.id)).toEqual([
        expect.objectContaining({
          event: 'turn.completed',
          data: { type: 'turn-completed', stopReason: 'completed', turn: skipped },
        }),
        skipEvent,
      ]);
      expect(skipped.durationMs).toBe(0);
      expect(reopened.getServerItemById(skipItem.id).type).toBe('status');
      expect(new FsStore({ dataRoot }).listServerThreadTurns(thread.id)).toHaveLength(2);

      await expect(reopened.createServerTurn(thread.id, 'Overlap', actor)).rejects.toThrow(
        'in flight'
      );
      await expect(
        reopened.updateServerTurn(turn.id, { workspaceId: allocateEntityId('ws') } as never)
      ).rejects.toThrow('cannot change');
      await expect(
        reopened.updateServerThread(thread.id, { owner: { kind: 'workspace' } } as never)
      ).rejects.toThrow('cannot change');
      await reopened.updateServerTurn(turn.id, {
        status: 'interrupted',
        completedAt: new Date().toISOString(),
      });
      await reopened.updateServerThread(thread.id, { status: 'archived' });
      await expect(reopened.createServerTurn(thread.id, 'After archive', actor)).rejects.toThrow(
        'archived'
      );
    } finally {
      await disposeTestStore(dataRoot, coreDb);
    }
  });
  it('preserves retained additions and refuses corrupt owner or terminal facts', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'server-threads-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    try {
      const store = new FsStore({ dataRoot });
      const thread = await store.createServerThread('Server');
      const turn = await store.createServerTurn(thread.id, 'Work', actor);
      // Add descriptive fields to the actual native authority, not retired JSON files.
      const rawThread = JSON.parse(
        (
          coreDb.sqlite
            .prepare('SELECT record_json FROM control_threads WHERE id=?')
            .get(thread.id) as { record_json: string }
        ).record_json
      );
      rawThread.note = 'retained';
      expect(
        coreDb.sqlite
          .prepare('UPDATE control_threads SET record_json=? WHERE id=?')
          .run(JSON.stringify(rawThread), thread.id).changes
      ).toBe(1);
      const rawTurn = JSON.parse(
        (
          coreDb.sqlite
            .prepare('SELECT record_json FROM control_turns WHERE id=?')
            .get(turn.id) as { record_json: string }
        ).record_json
      );
      rawTurn.triggerActor.note = 'retained actor description';
      expect(
        coreDb.sqlite
          .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
          .run(JSON.stringify(rawTurn), turn.id).changes
      ).toBe(1);
      const reopened = new FsStore({ dataRoot });
      await reopened.updateServerThread(thread.id, { name: 'Renamed' });
      await reopened.updateServerTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      expect(
        JSON.parse(
          (
            coreDb.sqlite
              .prepare('SELECT record_json FROM control_threads WHERE id=?')
              .get(thread.id) as { record_json: string }
          ).record_json
        )
      ).toMatchObject({
        note: 'retained',
        owner: { kind: 'server' },
      });
      expect(
        JSON.parse(
          (
            coreDb.sqlite
              .prepare('SELECT record_json FROM control_turns WHERE id=?')
              .get(turn.id) as { record_json: string }
          ).record_json
        ).triggerActor.note
      ).toBe('retained actor description');
      // Completion owns the terminal event; later persistence must replay its original envelope.
      const committedEvents = reopened.getServerTurnTranscript(turn.id);
      expect(committedEvents).toHaveLength(1);
      expect(committedEvents[0]?.data).toEqual({
        type: 'turn-completed',
        stopReason: 'completed',
        turn: reopened.getServerTurnById(turn.id),
      });
      const terminalEvent = await reopened.persistServerTurnEvent(turn.id, {
        event: 'turn.completed',
        threadId: thread.id,
        turnId: turn.id,
        data: {
          type: 'turn-completed',
          stopReason: 'completed',
          turn: reopened.getServerTurnById(turn.id),
        },
      });
      expect(terminalEvent).toEqual(committedEvents[0]);
      reopened.emitServerTurnEvent(turn.id, terminalEvent);
      expect(new FsStore({ dataRoot }).getServerTurnTranscript(turn.id)).toEqual(committedEvents);
      await expect(
        reopened.persistServerTurnEvent(turn.id, {
          event: 'turn.completed',
          threadId: thread.id,
          turnId: turn.id,
          data: {
            type: 'turn-completed',
            stopReason: 'error',
            turn: reopened.getServerTurnById(turn.id),
          },
        })
      ).rejects.toThrow('is terminal and does not admit this write');
      // WorkOwner carries immutable authority; unknown fields must fail closed.
      rawThread.owner.note = 'retained owner description';
      expect(
        coreDb.sqlite
          .prepare('UPDATE control_threads SET record_json=? WHERE id=?')
          .run(JSON.stringify(rawThread), thread.id).changes
      ).toBe(1);
      expect(() => new FsStore({ dataRoot })).toThrow();
      delete rawThread.owner.note;
      rawThread.owner.kind = 'workspace';
      expect(
        coreDb.sqlite
          .prepare('UPDATE control_threads SET record_json=? WHERE id=?')
          .run(JSON.stringify(rawThread), thread.id).changes
      ).toBe(1);
      expect(() => new FsStore({ dataRoot })).toThrow();
    } finally {
      await disposeTestStore(dataRoot, coreDb);
    }
  });
});

it.each(['workspace', 'server'] as const)(
  'retains acknowledged %s history without the former product files',
  async (scope) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'sql-history-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    try {
      const store = new FsStore({ dataRoot });
      const workspace = await store.createWorkspace('History');
      const thread =
        scope === 'server'
          ? await store.createServerThread('History')
          : await store.createThread(workspace.id, 'History');
      const turn =
        scope === 'server'
          ? await store.createServerTurn(thread.id, 'Recorded', actor)
          : await store.createTurn(workspace.id, thread.id, 'Recorded', actor);
      const item = {
        id: allocateEntityId('it'),
        owner: thread.owner,
        threadId: thread.id,
        turnId: turn.id,
        type: 'assistant-message' as const,
        text: 'Original bytes',
        status: 'in_progress' as const,
        createdAt: turn.startedAt!,
        completedAt: null,
      };
      if (scope === 'server') await store.createServerItem(item);
      else await store.createItem(item);
      await getControlStoreWorkerClient().shutdown();
      rmSync(
        join(
          dataRoot,
          ...(scope === 'server' ? ['server', 'threads'] : ['workspaces', workspace.id, 'threads'])
        ),
        { recursive: true, force: true }
      );
      const reopened = new FsStore({ dataRoot });
      const threads =
        scope === 'server' ? reopened.listServerThreads() : reopened.listThreads(workspace.id);
      expect(threads.map((entry) => entry.id)).toEqual([thread.id]);
      const items =
        scope === 'server'
          ? reopened.listServerThreadTurns(thread.id).flatMap((turn) => turn.items)
          : reopened.listThreadItems(workspace.id, thread.id);
      expect(items).toEqual([item]);
    } finally {
      await disposeTestStore(dataRoot, coreDb);
    }
  }
);

it.each(['workspace', 'server', 'agent-session'] as const)(
  'enforces %s single flight across independently opened product readers',
  async (scope) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'sql-exclusion-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    try {
      const store = new FsStore({ dataRoot });
      const workspace = await store.createWorkspace('Exclusion');
      const thread =
        scope === 'server'
          ? await store.createServerThread('Exclusion')
          : await store.createThread(workspace.id, 'Exclusion');
      const other = new FsStore({ dataRoot });
      const results = await Promise.allSettled(
        [store, other].map(async (producer) => {
          if (scope === 'server') return await producer.createServerTurn(thread.id, 'Work', actor);
          if (scope === 'workspace')
            return await producer.createTurn(workspace.id, thread.id, 'Work', actor);
          const timestamp = new Date().toISOString();
          return await producer.createAgentSession({
            id: allocateEntityId('as'),
            workspaceId: workspace.id,
            threadId: thread.id,
            agentId: 'agent_codex_host',
            status: 'idle',
            message: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        })
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      await getControlStoreWorkerClient().shutdown();
      const reopened = new FsStore({ dataRoot });
      const retained =
        scope === 'server'
          ? reopened.listServerThreadTurns(thread.id)
          : scope === 'workspace'
            ? reopened.listThreadTurns(workspace.id, thread.id)
            : reopened.listThreadAgentSessions(workspace.id, thread.id);
      expect(retained.map((entry) => entry.id)).toEqual(
        results.flatMap((result) => (result.status === 'fulfilled' ? [result.value.id] : []))
      );
    } finally {
      await disposeTestStore(dataRoot, coreDb);
    }
  }
);
