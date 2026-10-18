import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readWorkObservationBody } from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { readWorkObservations } from '../storage/work-observations.js';
import { ModelCapture, withTurnModelCapture } from './model-capture.js';

it.each([
  'on',
  'off',
] as const)('retains Server model evidence with capture %s and no Workspace anchor', async (value) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-capture-'));
  let coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    const store = new FsStore({ dataRoot });
    const thread = store.createServerThread('Maintenance');
    const turn = store.createServerTurn(
      thread.id,
      'Maintain Server Knowledge',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      { captureCoverage: { scope: 'server', value } }
    );
    const path = join(dataRoot, 'server', 'threads', thread.id, 'turns', turn.id, 'turn.json');
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), annotation: 'retained' })
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
        expect(
          readWorkObservations(coreDb, { threadId: thread.id, turnId: turn.id })[0]
        ).toMatchObject({ type: 'env.bound', payload: { owner: { kind: 'server' } } });
        const capture = new ModelCapture(
          {
            ...context,
            corr: 'maintenance',
            capabilityCallId: 'cap_00000000-0000-7000-8000-000000000001',
          },
          [],
          'provider_test'
        );
        capture.request({
          model: 'maintenance',
          instructions: 'Maintain shared Server Knowledge.',
          input: 'Review current pages.',
        });
        capture.event({ type: 'text_delta', delta: 'Maintenance complete.' });
        capture.event({ type: 'done' });
      }
    );
    expect(called).toBe(true);
    expect(coreDb.sqlite.open).toBe(true);
    const rows = readWorkObservations(coreDb, { threadId: thread.id, turnId: turn.id });
    const refs = rows.flatMap((row) => (row.refs ?? []).map((ref) => ({ row, ref })));
    expect(
      refs.every(({ ref }) => ref.scope.owner === 'server' && !('workspaceId' in ref.scope))
    ).toBe(true);
    const published = refs.filter(({ ref }) => ref.edge === 'publication');
    expect(published).toHaveLength(value === 'on' ? 3 : 0);
    if (value === 'on')
      expect(() =>
        coreDb.sqlite
          .prepare('UPDATE evidence_bundles SET workspace_id = ?')
          .run('ws_00000000-0000-7000-8000-000000000001')
      ).toThrow('CHECK constraint failed');
    for (const { row, ref } of published) {
      expect(
        readWorkObservationBody(coreDb, {
          bundleId: ref.locator,
          threadId: thread.id,
          turnId: turn.id,
          createdAt: row.ts,
          sha256: ref.digest!,
        })
      ).not.toBeNull();
    }
    expect(readdirSync(join(dataRoot, 'workspaces'))).toEqual([]);
    expect(JSON.parse(readFileSync(path, 'utf8')).annotation).toBe('retained');
    expect(JSON.stringify(rows)).not.toContain('workspaceId');
    coreDb.sqlite.close();
    coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    expect(readWorkObservations(coreDb, { threadId: thread.id, turnId: turn.id })).toEqual(rows);
    expect(new FsStore({ dataRoot }).getServerTurnById(turn.id).owner).toEqual({ kind: 'server' });
    if (published[0]) {
      const { row, ref } = published[0];
      coreDb.sqlite
        .prepare(
          "UPDATE evidence_bundles SET import_status = 'expired' WHERE evidence_bundle_id = ?"
        )
        .run(ref.locator);
      expect(
        readWorkObservationBody(coreDb, {
          bundleId: ref.locator,
          threadId: thread.id,
          turnId: turn.id,
          createdAt: row.ts,
          sha256: ref.digest!,
        })
      ).toBeNull();
    }
  } finally {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
