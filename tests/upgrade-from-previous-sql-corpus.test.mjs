import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  readSqlCorpus,
  SQL_CORPUS_FAMILIES,
  seedSqlCorpus,
} from '../scripts/upgrade-from-previous-sql-corpus.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = process.env.UPGRADE_CORPUS_APP_ROOT ?? join(repositoryRoot, 'apps/nanocore');

/** Creates real owned prerequisites without an App, provider, Worker, or Host effect. */
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-upgrade-sql-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const load = (name) => import(pathToFileURL(join(appRoot, 'dist', `${name}.js`)).href);
  const { openCoreDb } = await load('storage/db');
  const { applyMigrations } = await load('storage/migrate');
  const { ensureLocalUser } = await load('auth/identity');
  const { FsStore } = await load('lib/store');
  const { recordWorkspaceOwnerMembership } = await load('workspace-membership');
  const coreDb = openCoreDb(join(root, 'data'));
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot: coreDb.dataRoot });
  const workspace = store.createWorkspace('B01 upgrade continuity');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = store.createThread(workspace.id, 'Upgrade corpus');
  const turn = store.createTurn(workspace.id, thread.id, 'Keep the synthetic corpus readable.', {
    kind: 'user',
    id: userId,
  });
  store.createItem({
    id: 'it_00000000-0000-7000-8000-000000000901',
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    type: 'user-message',
    text: 'Keep the synthetic corpus readable.',
    actor: { kind: 'user', id: userId },
    status: 'completed',
    createdAt: turn.startedAt,
    completedAt: turn.startedAt,
  });
  coreDb.sqlite.close();
  const input = {
    appRoot,
    dataRoot: join(root, 'data'),
    retainedRoot: join(root, 'retained'),
    userId,
    selectors: { workspaceId: workspace.id, threadId: thread.id, turnId: turn.id },
  };
  const additional = await seedSqlCorpus(input);
  return { ...input, selectors: { ...input.selectors, ...additional }, load };
}

test('reopens every SQL family and its linked file owners with exact readback', async (t) => {
  const input = await fixture(t);
  const original = await readSqlCorpus(input);
  assert.deepEqual(Object.keys(original).sort(), [...SQL_CORPUS_FAMILIES].sort());
  for (const [family, observed] of Object.entries(original)) {
    assert.ok(observed.values.length > 0, `${family} has actual retained records`);
    for (const bytes of observed.bytes) {
      assert.ok(!bytes.path.startsWith('/'), 'byte evidence uses a domain-relative path');
      assert.ok(bytes.byteLength > 0);
      assert.match(bytes.sha256, /^[a-f0-9]{64}$/);
    }
  }
  assert.deepEqual(await readSqlCorpus(input), original);
  assert.equal(
    original['Material content, revisions and Thread bindings'].values[1].content,
    'Synthetic upgrade continuity material.\n'
  );
  assert.equal(
    original['Light App metadata, business data, Audit and receipts'].values[1].data.note,
    'Synthetic retained business record.'
  );
  const { openCoreDb } = await input.load('storage/db');
  const db = openCoreDb(input.dataRoot);
  try {
    db.sqlite
      .prepare('DELETE FROM permission_decisions WHERE decision_id = ?')
      .run(input.selectors.sql.serverDecisionId);
  } finally {
    db.sqlite.close();
  }
  await assert.rejects(readSqlCorpus(input), /Core permission decisions.*missing/i);
});

test('verifies original Light App recovery bytes instead of accepting metadata alone', async (t) => {
  const input = await fixture(t);
  const path = join(input.dataRoot, input.selectors.sql.lightAppSnapshotPath);
  const bytes = readFileSync(path);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(path, bytes);
  await assert.rejects(readSqlCorpus(input), /snapshot digest does not match/i);
});
