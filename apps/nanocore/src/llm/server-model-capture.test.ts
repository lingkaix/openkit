import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { readWorkObservationBody, workObservationBodyBundleId } from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, serverStoragePath } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { openServerWorkProductReadHandle } from '../storage/server-work-product-reads.js';
import { serverWorkStorageDescriptor } from '../storage/server-work-schema.js';
import {
  applyControlWorkObservation,
  publishControlWorkObservationBodies,
  readControlWorkObservations,
  type WorkObservationDraft,
} from '../storage/work-observations.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { openTestServerWork } from '../test-support/server-work-store.js';
import { closeTestCoreDb, createTestCoreDb } from '../test-support/store.js';
import { ModelCapture, withTurnModelCapture } from './model-capture.js';

it('holds Server model capture before the effect callback or evidence preparation', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'held-server-capture-'));
  const coreDb = createTestCoreDb(dataRoot);
  try {
    const memory = new FsStore();
    const thread = await memory.createServerThread('Maintenance');
    const turn = await memory.createServerTurn(thread.id, 'Review retained pages.', {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    });
    const run = vi.fn();
    await expect(
      withTurnModelCapture(
        {
          store: new FsStore({ dataRoot }),
          turn,
          coreDb,
          environment: { systemPrompt: 'Maintain shared Server Knowledge.', tools: [] },
        },
        run
      )
    ).rejects.toMatchObject({ code: 'operation_storage_unavailable', status: 503 });
    expect(run).not.toHaveBeenCalled();
  } finally {
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

it.each(['on', 'off'] as const)(
  'retains Server model evidence with capture %s and no Workspace anchor',
  async (value) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'server-capture-'));
    let coreDb = openCoreDb(dataRoot);
    let reader: Awaited<ReturnType<typeof openTestServerWork>>['reader'] | undefined;
    const path = serverStoragePath(dataRoot, 'server-work');
    const mutate = (sql: string, value: string) => {
      const db = new Database(path, { fileMustExist: true });
      try {
        db.prepare(sql).run(value);
      } finally {
        db.close();
      }
    };
    try {
      applyMigrations(coreDb);
      const userId = ensureLocalUser(coreDb);
      const owner = await openTestServerWork(coreDb);
      reader = owner.reader;
      const { store } = owner;
      const thread = await store.createServerThread('Maintenance', undefined, undefined, {
        actor: { kind: 'user', id: userId },
        credentialRef: null,
      });
      const turn = await store.createServerTurn(
        thread.id,
        'Maintain Server Knowledge',
        { kind: 'user', id: userId },
        null,
        { captureCoverage: { scope: 'server', value } }
      );
      const target = { threadId: thread.id, turnId: turn.id };
      const observations = () =>
        readControlWorkObservations(reader!.sqlite, { kind: 'server' }, target);
      const observationDb = () => ({
        scope: 'server-work' as const,
        dataRoot,
        sqlite: reader!.sqlite,
      });
      mutate(
        "UPDATE control_turns SET record_json=json_set(record_json, '$.annotation', 'retained') WHERE id=?",
        turn.id
      );
      let called = false;
      await withTurnModelCapture(
        {
          store,
          turn,
          coreDb,
          environment: { systemPrompt: 'Maintain shared Server Knowledge.', tools: [] },
        },
        async (context) => {
          called = true;
          expect(context.workspaceDb).toBe(coreDb);
          expect(observations()[0]).toMatchObject({
            type: 'env.bound',
            payload: { owner: { kind: 'server' } },
          });
          const capture = new ModelCapture(
            {
              ...context,
              corr: 'maintenance',
              capabilityCallId: 'cap_00000000-0000-7000-8000-000000000001',
            },
            [],
            'provider_test'
          );
          await capture.request({
            model: 'maintenance',
            instructions: 'Maintain shared Server Knowledge.',
            input: 'Review current pages.',
          });
          await capture.event({ type: 'text_delta', delta: 'Maintenance complete.' });
          await capture.event({ type: 'done' });
        }
      );
      expect(called).toBe(true);
      expect(coreDb.sqlite.open).toBe(true);
      const rows = observations();
      const refs = rows.flatMap((row) => (row.refs ?? []).map((ref) => ({ row, ref })));
      expect(
        refs.every(({ ref }) => ref.scope.owner === 'server' && !('workspaceId' in ref.scope))
      ).toBe(true);
      const published = refs.filter(({ ref }) => ref.edge === 'publication');
      expect(published).toHaveLength(value === 'on' ? 3 : 0);
      if (value === 'on')
        expect(() =>
          mutate(
            'UPDATE evidence_bundles SET workspace_id = ?',
            'ws_00000000-0000-7000-8000-000000000001'
          )
        ).toThrow('CHECK constraint failed');
      for (const { row, ref } of published) {
        expect(
          readWorkObservationBody(observationDb(), {
            bundleId: ref.locator,
            threadId: thread.id,
            turnId: turn.id,
            createdAt: row.ts,
            sha256: ref.digest!,
          })
        ).not.toBeNull();
      }
      expect(readdirSync(join(dataRoot, 'workspaces'))).toEqual([]);
      expect(
        JSON.parse(
          (
            reader.sqlite
              .prepare('SELECT record_json FROM control_turns WHERE id=?')
              .get(turn.id) as { record_json: string }
          ).record_json
        ).annotation
      ).toBe('retained');
      expect(JSON.stringify(rows)).not.toContain('workspaceId');
      reader.close();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      const worker = getControlStoreWorkerClient();
      await expect(
        worker.openServerOwner(dataRoot, serverWorkStorageDescriptor)
      ).resolves.toMatchObject({
        state: 'ready',
      });
      const reopened = await openServerWorkProductReadHandle(dataRoot, worker);
      if (reopened.state !== 'ready') throw new Error('Server capture fixture did not reopen.');
      reader = reopened.value;
      expect(observations()).toEqual(rows);
      expect(
        new FsStore({ dataRoot, serverWorkReader: reader }).getServerTurnById(turn.id).owner
      ).toEqual({
        kind: 'server',
      });
      if (published[0]) {
        const { row, ref } = published[0];
        mutate(
          "UPDATE evidence_bundles SET import_status = 'expired' WHERE evidence_bundle_id = ?",
          ref.locator
        );
        expect(
          readWorkObservationBody(observationDb(), {
            bundleId: ref.locator,
            threadId: thread.id,
            turnId: turn.id,
            createdAt: row.ts,
            sha256: ref.digest!,
          })
        ).toBeNull();
      }
    } finally {
      reader?.close();
      await shutdownControlStoreWorkerClient();
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }
);

it('keeps an over-budget Server body out of preparation and completes an earlier reservation', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-observation-budget-'));
  const coreDb = createTestCoreDb(dataRoot);
  let reader: Awaited<ReturnType<typeof openTestServerWork>>['reader'] | undefined;
  try {
    const userId = ensureLocalUser(coreDb);
    const { store, binding, reader: opened } = await openTestServerWork(coreDb);
    reader = opened;
    const actor = { kind: 'user' as const, id: userId };
    const thread = await store.createServerThread('Maintenance', undefined, undefined, {
      actor,
      credentialRef: null,
    });
    const turn = await store.createServerTurn(thread.id, 'Maintain', actor, null, {
      captureCoverage: { scope: 'server', value: 'on' },
    });
    const input = { threadId: thread.id, turnId: turn.id };
    const admission = store.getServerTurnAdmission(turn.id);
    const draft = (id: string): WorkObservationDraft => ({
      id,
      ts: '2026-09-29T00:00:00.000Z',
      type: 'model.observed',
      obs: 'llm-gateway',
      payload: {
        attempt: 0,
        direction: 'response',
        event: 'text_end',
        runtimeOriginRef: null,
        content: { state: 'expected' },
      },
    });
    const body = {
      id: 'body',
      boundary: 'assistant.text',
      mediaType: 'text/plain',
      bytes: Buffer.from('kept'),
    };
    const append = (id: string, deferBodyPublication?: true) =>
      binding.owner.appendObservation!(admission, {
        ...input,
        observation: draft(id),
        bodies: [body],
        ...(deferBodyPublication ? { deferBodyPublication } : {}),
      });
    expect(await append('reserved', true)).toMatchObject({
      state: 'ready',
      value: { disposition: 'committed', observation: { id: 'reserved' } },
    });
    const sqlite = new Database(serverStoragePath(dataRoot, 'server-work'), {
      fileMustExist: true,
    });
    try {
      sqlite.pragma('synchronous=FULL');
      // Commit exact declarations on the Server owner without allocating the unuploaded bodies.
      sqlite.transaction(() => {
        const owner = { kind: 'server' as const };
        for (let index = 0; index < 4; index++) {
          const observation = draft(`admitted-${index}`);
          expect(
            applyControlWorkObservation(sqlite, owner, {
              ...input,
              observation,
              publishBodies: false,
              bodies: [
                {
                  ...body,
                  bytes: 16 * 1024 * 1024 - (index === 3 ? body.bytes.length : 0),
                  sha256: 'a'.repeat(64),
                  bundleId: workObservationBodyBundleId(
                    owner,
                    thread.id,
                    turn.id,
                    observation.id,
                    body.id
                  ),
                },
              ],
            })
          ).toMatchObject({ disposition: 'committed', publication: null });
        }
      })();
      const backend = join(dataRoot, 'server', 'evidence', 'backend');
      const inventory = () => (existsSync(backend) ? readdirSync(backend).sort() : []);
      const before = inventory();
      expect(() =>
        publishControlWorkObservationBodies(
          { scope: 'server-work', sqlite, dataRoot },
          {
            ...input,
            observation: draft('omitted'),
            bodies: [body],
          }
        )
      ).toThrow('requires a committed declaration');
      expect(inventory()).toEqual(before);

      expect(await append('omitted')).toMatchObject({
        state: 'ready',
        value: {
          disposition: 'truncated',
          truncation: { reason: 'body-bytes', firstOmittedSequence: 6 },
        },
      });
      expect(inventory()).toEqual(before);
      expect(await append('reserved')).toMatchObject({
        state: 'ready',
        value: { disposition: 'duplicate', observation: { id: 'reserved' } },
      });
      expect(inventory()).toEqual(
        [
          ...before,
          workObservationBodyBundleId({ kind: 'server' }, thread.id, turn.id, 'reserved', body.id),
        ].sort()
      );
      expect(
        readControlWorkObservations(sqlite, { kind: 'server' }, input).map((row) => row.id)
      ).toEqual([
        'reserved',
        'admitted-0',
        'admitted-1',
        'admitted-2',
        'admitted-3',
        'reserved:publication',
      ]);
    } finally {
      sqlite.close();
    }
  } finally {
    reader?.close();
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
