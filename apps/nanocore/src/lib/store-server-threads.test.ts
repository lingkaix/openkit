import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { readWorkObservationBody, workObservationBodyBundleId } from '../evidence-bundles.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { withServerWorkProducer } from '../storage/server-work-command.js';
import { openServerWorkProductReadHandle } from '../storage/server-work-product-reads.js';
import {
  type ControlWorkObservationPreparation,
  readControlWorkObservations,
  type WorkObservationDraft,
} from '../storage/work-observations.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { openTestServerWork } from '../test-support/server-work-store.js';
import { disposeTestStore } from '../test-support/store.js';
import { FsStore } from './store.js';

const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

const authority = { actor, credentialRef: null };
const serverOwner = { kind: 'server' } as const;
const held = { code: 'operation_storage_unavailable', status: 503 };

function serverFixture(coreDb: CoreDb) {
  const { dataRoot } = coreDb;
  let opening: Awaited<ReturnType<typeof openTestServerWork>> | undefined;
  const readers: Array<Awaited<ReturnType<typeof openTestServerWork>>['reader']> = [];
  const closeReaders = () => {
    for (const reader of readers.splice(0)) reader.close();
    opening = undefined;
  };
  return {
    async open() {
      ensureLocalUser(coreDb);
      opening = await openTestServerWork(coreDb);
      readers.push(opening.reader);
      return opening.store;
    },
    async reopen() {
      if (!opening) throw new Error('The Server fixture must be open.');
      const result = await openServerWorkProductReadHandle(dataRoot, getControlStoreWorkerClient());
      if (result.state !== 'ready') throw new Error(result.reason);
      readers.push(result.value);
      return new FsStore({ dataRoot, serverWorkReader: result.value, serverWork: opening.binding });
    },
    async stop() {
      closeReaders();
      await getControlStoreWorkerClient().shutdown();
    },
    async dispose() {
      closeReaders();
      await disposeTestStore(dataRoot, coreDb);
    },
  };
}

describe('Server-owned canonical history', () => {
  it('retains Server Thread, Turn, Item revisions and transcript without Workspace placement', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'server-threads-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const fixture = serverFixture(coreDb);
    try {
      const store = await fixture.open();
      const workspace = await store.createWorkspace('Workspace');
      const workspaceThread = await store.createThread(workspace.id, 'Workspace work');
      const thread = await store.createServerThread(
        'Server maintenance',
        undefined,
        undefined,
        authority
      );
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
      const reopened = await fixture.reopen();
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
      expect(reopened.getTurnCaptureCoverage(turn.id)).toEqual({ scope: 'server', value: 'on' });
      expect(() => reopened.getTurnById(turn.id)).toThrow('Turn not found');
      const sqlite = store.getServerWorkReadScope().sqlite;
      const retained = sqlite
        .prepare('SELECT record_json FROM control_threads WHERE id=?')
        .get(thread.id) as { record_json: string };
      expect(retained.record_json).not.toContain('workspaceId');
      expect(
        sqlite
          .prepare(
            "SELECT revision FROM control_product_entries WHERE kind='item' AND id=? ORDER BY revision"
          )
          .all(item.id)
      ).toEqual([{ revision: 1 }, { revision: 2 }]);
    } finally {
      await fixture.dispose();
    }
  });

  it('retains Server observations and exact bodies across rollback, terminal publication and cold reopen', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'server-observations-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const fixture = serverFixture(coreDb);
    try {
      const store = await fixture.open();
      const thread = await store.createServerThread(
        'Server capture',
        undefined,
        undefined,
        authority
      );
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
      const binding = store.getServerWorkBinding()!;
      const admission = store.getServerTurnAdmission(turn.id);
      const submit = (input: ControlWorkObservationPreparation) =>
        withServerWorkProducer(binding, () => binding.owner.appendObservation!(admission, input));
      const append = async (input: ControlWorkObservationPreparation) => {
        const result = await submit(input);
        if (result.state !== 'ready') throw new Error(result.reason);
        return result.value;
      };
      const read = (current: FsStore) =>
        readControlWorkObservations(current.getServerWorkReadScope().sqlite, serverOwner, owner);
      const first = await append({
        ...owner,
        observation: environment,
        bodies: [],
      });
      expect(first.disposition).toBe('committed');
      expect(first.observation.seq).toBe(1);
      expect(await append({ ...owner, observation: environment, bodies: [] })).toEqual({
        ...first,
        disposition: 'duplicate',
      });
      const bytes = Buffer.from('{"prompt":"Exact Server capture"}\r\n');
      await append({
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
      const readBody = (current: FsStore) =>
        readWorkObservationBody(
          { scope: 'server-work', dataRoot, sqlite: current.getServerWorkReadScope().sqlite },
          body
        );
      const retained = read(store);
      expect(retained.map((value) => [value.seq, value.type])).toEqual([
        [1, 'env.bound'],
        [2, 'model.observed'],
        [3, 'content.published'],
      ]);
      expect(Buffer.from(readBody(store)!)).toEqual(bytes);
      await expect(
        append({
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
      expect(read(store)).toEqual(retained);
      // Deliberate native failure follows genuine public Thread, Turn and observation admission.
      const mutator = new Database(store.getServerWorkReadScope().path, { fileMustExist: true });
      try {
        mutator.exec(`CREATE TRIGGER refuse_server_observation BEFORE INSERT ON control_work_observations
        BEGIN SELECT RAISE(ABORT, 'injected Server observation refusal'); END`);
        await expect(
          submit({
            ...owner,
            observation: { ...environment, id: 'refused-environment' },
            bodies: [],
          })
        ).resolves.toMatchObject({ state: 'unavailable', owner: 'server-work' });
      } finally {
        mutator.exec('DROP TRIGGER IF EXISTS refuse_server_observation');
        mutator.close();
      }
      expect(read(store)).toEqual(retained);
      expect(Buffer.from(readBody(store)!)).toEqual(bytes);
      await store.updateServerTurn(turn.id, {
        status: 'completed',
        completedAt: '2026-10-20T00:00:03.000Z',
      });
      const sealed = read(store);
      expect(sealed.at(-1)).toMatchObject({ type: 'turn.reap', payload: { reason: 'completed' } });
      await fixture.stop();
      const restarted = await fixture.open();
      expect(restarted.getServerTurnById(turn.id).status).toBe('completed');
      expect(read(restarted)).toEqual(sealed);
      expect(Buffer.from(readBody(restarted)!)).toEqual(bytes);
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps ownership immutable and refuses overlapping or archived work after reload', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'server-threads-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const fixture = serverFixture(coreDb);
    try {
      const store = await fixture.open();
      const thread = await store.createServerThread('Server', undefined, undefined, authority);
      const turn = await store.createServerTurn(thread.id, 'Work', actor);
      const reopened = await fixture.reopen();
      expect(reopened.getServerTurnById(turn.id).status).toBe('running');
      await expect(
        reopened.createServerTurn(thread.id, 'Skipped: busy', actor, null, {
          status: 'completed',
        })
      ).rejects.toMatchObject(held);
      expect(reopened.listServerThreadTurns(thread.id)).toEqual([turn]);

      await expect(reopened.createServerTurn(thread.id, 'Overlap', actor)).rejects.toThrow(
        'in flight'
      );
      await expect(
        reopened.updateServerTurn(turn.id, { workspaceId: allocateEntityId('ws') } as never)
      ).rejects.toThrow('cannot change');
      await expect(
        reopened.updateServerThread(thread.id, { owner: { kind: 'workspace' } } as never)
      ).rejects.toMatchObject(held);
      await reopened.updateServerTurn(turn.id, {
        status: 'interrupted',
        completedAt: new Date().toISOString(),
      });
      await expect(
        reopened.updateServerThread(thread.id, { status: 'archived' })
      ).rejects.toMatchObject(held);
      const mutator = new Database(reopened.getServerWorkReadScope().path, { fileMustExist: true });
      try {
        expect(
          mutator
            .prepare(
              "UPDATE control_threads SET status='archived',record_json=json_set(record_json,'$.status','archived') WHERE id=?"
            )
            .run(thread.id).changes
        ).toBe(1);
      } finally {
        mutator.close();
      }
      const archived = await fixture.reopen();
      await expect(archived.createServerTurn(thread.id, 'After archive', actor)).rejects.toThrow(
        'archived'
      );
    } finally {
      await fixture.dispose();
    }
  });
  it('preserves retained additions and refuses corrupt owner or terminal facts', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'server-threads-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const fixture = serverFixture(coreDb);
    let mutator: Database.Database | undefined;
    try {
      const store = await fixture.open();
      mutator = new Database(store.getServerWorkReadScope().path, { fileMustExist: true });
      const thread = await store.createServerThread('Server', undefined, undefined, authority);
      const turn = await store.createServerTurn(thread.id, 'Work', actor);
      // Add descriptive fields to the actual native authority, not retired JSON files.
      const rawThread = JSON.parse(
        (
          mutator.prepare('SELECT record_json FROM control_threads WHERE id=?').get(thread.id) as {
            record_json: string;
          }
        ).record_json
      );
      rawThread.note = 'retained';
      expect(
        mutator
          .prepare('UPDATE control_threads SET record_json=? WHERE id=?')
          .run(JSON.stringify(rawThread), thread.id).changes
      ).toBe(1);
      const rawTurn = JSON.parse(
        (
          mutator.prepare('SELECT record_json FROM control_turns WHERE id=?').get(turn.id) as {
            record_json: string;
          }
        ).record_json
      );
      rawTurn.triggerActor.note = 'retained actor description';
      expect(
        mutator
          .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
          .run(JSON.stringify(rawTurn), turn.id).changes
      ).toBe(1);
      const reopened = await fixture.reopen();
      await expect(
        reopened.updateServerThread(thread.id, { name: 'Renamed' })
      ).rejects.toMatchObject(held);
      await reopened.updateServerTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      expect(
        JSON.parse(
          (
            mutator
              .prepare('SELECT record_json FROM control_threads WHERE id=?')
              .get(thread.id) as { record_json: string }
          ).record_json
        )
      ).toMatchObject({
        name: thread.name,
        note: 'retained',
        owner: { kind: 'server' },
      });
      expect(
        JSON.parse(
          (
            mutator.prepare('SELECT record_json FROM control_turns WHERE id=?').get(turn.id) as {
              record_json: string;
            }
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
      expect((await fixture.reopen()).getServerTurnTranscript(turn.id)).toEqual(committedEvents);
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
        mutator
          .prepare('UPDATE control_threads SET record_json=? WHERE id=?')
          .run(JSON.stringify(rawThread), thread.id).changes
      ).toBe(1);
      await expect(fixture.reopen()).rejects.toThrow();
      delete rawThread.owner.note;
      rawThread.owner.kind = 'workspace';
      expect(
        mutator
          .prepare('UPDATE control_threads SET record_json=? WHERE id=?')
          .run(JSON.stringify(rawThread), thread.id).changes
      ).toBe(1);
      await expect(fixture.reopen()).rejects.toThrow();
    } finally {
      mutator?.close();
      await fixture.dispose();
    }
  });
});

it.each(['workspace', 'server'] as const)(
  'retains acknowledged %s history without the former product files',
  async (scope) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'sql-history-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const server = scope === 'server' ? serverFixture(coreDb) : undefined;
    const open = () => (server ? server.open() : new FsStore({ dataRoot }));
    try {
      const store = await open();
      const workspace = await store.createWorkspace('History');
      const thread =
        scope === 'server'
          ? await store.createServerThread('History', undefined, undefined, authority)
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
      if (server) await server.stop();
      else await getControlStoreWorkerClient().shutdown();
      rmSync(
        join(
          dataRoot,
          ...(scope === 'server' ? ['server', 'threads'] : ['workspaces', workspace.id, 'threads'])
        ),
        { recursive: true, force: true }
      );
      const reopened = await open();
      const threads =
        scope === 'server' ? reopened.listServerThreads() : reopened.listThreads(workspace.id);
      expect(threads.map((entry) => entry.id)).toEqual([thread.id]);
      const items =
        scope === 'server'
          ? reopened.listServerThreadTurns(thread.id).flatMap((turn) => turn.items)
          : reopened.listThreadItems(workspace.id, thread.id);
      expect(items).toEqual([item]);
    } finally {
      if (server) await server.dispose();
      else await disposeTestStore(dataRoot, coreDb);
    }
  }
);

it.each(['workspace', 'server', 'agent-session'] as const)(
  'enforces %s single flight across independently opened product readers',
  async (scope) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'sql-exclusion-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const server = scope === 'server' ? serverFixture(coreDb) : undefined;
    const open = () => (server ? server.open() : new FsStore({ dataRoot }));
    try {
      const store = await open();
      const workspace = await store.createWorkspace('Exclusion');
      const thread =
        scope === 'server'
          ? await store.createServerThread('Exclusion', undefined, undefined, authority)
          : await store.createThread(workspace.id, 'Exclusion');
      const other = server ? await server.reopen() : new FsStore({ dataRoot });
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
      if (server) await server.stop();
      else await getControlStoreWorkerClient().shutdown();
      const reopened = await open();
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
      if (server) await server.dispose();
      else await disposeTestStore(dataRoot, coreDb);
    }
  }
);
