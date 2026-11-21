import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { readWorkObservationBody } from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, serverStoragePath } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { openServerWorkProductReadHandle } from '../storage/server-work-product-reads.js';
import { serverWorkStorageDescriptor } from '../storage/server-work-schema.js';
import { readControlWorkObservations } from '../storage/work-observations.js';
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
