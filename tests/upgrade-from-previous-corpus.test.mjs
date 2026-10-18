import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  FILE_CORPUS_FAMILIES,
  readFileCorpus,
  seedFileCorpus,
} from '../scripts/upgrade-from-previous-corpus.mjs';

const appRoot = resolve('apps/nanocore');

/** Loads only the compiled product owner selected by this test checkout. */
function owner(path) {
  return import(pathToFileURL(join(appRoot, 'dist', path)).href);
}

/** Builds ordinary synthetic User authority without starting a service or using a credential. */
async function fixture(t, serverUser = false) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-previous-corpus-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'data');
  const retainedRoot = join(root, 'retained');
  const { ensureLayout } = await owner('storage/fs-layout.js');
  const { openCoreDb } = await owner('storage/db.js');
  const { applyMigrations } = await owner('storage/migrate.js');
  const { ensureLocalUser } = await owner('test-support/local-user.js');
  ensureLayout(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  let userId;
  try {
    applyMigrations(coreDb);
    userId = ensureLocalUser(coreDb);
    if (serverUser) {
      coreDb.sqlite.prepare("UPDATE users SET kind = 'human' WHERE id = ?").run(userId);
      const { createOpenKitAccessTokenRecord } = await owner('auth/access-token-store.js');
      createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: userId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
    }
  } finally {
    coreDb.sqlite.close();
  }
  return { appRoot, dataRoot, retainedRoot, userId };
}

test('old producers seed a nonempty B01 file corpus that old readers reopen exactly', async (t) => {
  const input = await fixture(t, true);
  const selectors = await seedFileCorpus(input);
  assert.match(selectors.workspaceId, /^ws_/);
  assert.match(selectors.threadId, /^th_/);
  assert.match(selectors.turnId, /^tu_/);
  const first = await readFileCorpus({ ...input, selectors });
  const second = await readFileCorpus({ ...input, selectors });
  assert.deepEqual(first, second);
  assert.deepEqual(first, JSON.parse(JSON.stringify(first)));
  const report = JSON.stringify({ selectors, first });
  const vaultKey = readFileSync(join(input.retainedRoot, 'file-corpus', 'vault-key.bin'));
  assert.ok(!report.includes(vaultKey.toString('hex')));
  assert.ok(!report.includes(vaultKey.toString('base64')));
  assert.ok(!report.includes(input.dataRoot));
  assert.ok(!report.includes(input.retainedRoot));
  assert.deepEqual(Object.keys(first).sort(), [...FILE_CORPUS_FAMILIES].sort());
  assert.ok(first['Conversation original file inputs'].values[0].length > 0);
  for (const [family, observed] of Object.entries(first)) {
    assert.ok(observed.values.length > 0, `${family}: no native reader result`);
    assert.ok(observed.bytes.length > 0, `${family}: no retained bytes`);
    for (const entry of observed.bytes) {
      assert.ok(!entry.path.startsWith('/'), `${family}: absolute path leaked`);
      assert.ok(entry.byteLength >= 0, `${family}: invalid byte length`);
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    }
    assert.ok(
      observed.bytes.some((entry) => entry.byteLength > 0),
      `${family}: no nonempty retained sample`
    );
  }
});

test('file reader fails on retained history corruption instead of accepting a boot-only result', async (t) => {
  const input = await fixture(t);
  const selectors = await seedFileCorpus(input);
  const path = join(
    input.dataRoot,
    'workspaces',
    selectors.workspaceId,
    'threads',
    selectors.threadId,
    'turns',
    selectors.turnId,
    'items.jsonl'
  );
  const bytes = readFileSync(path);
  writeFileSync(path, '{"invalid":"retained-history"}\n');
  await assert.rejects(readFileCorpus({ ...input, selectors }));
  writeFileSync(path, bytes);
  assert.ok((await readFileCorpus({ ...input, selectors }))['Item revision log'].values.length);
});

test('seeding refuses a second corpus instead of changing an existing baseline', async (t) => {
  const input = await fixture(t);
  const selectors = await seedFileCorpus(input);
  const before = await readFileCorpus({ ...input, selectors });
  await assert.rejects(seedFileCorpus(input), /already|exists|empty/i);
  assert.deepEqual(await readFileCorpus({ ...input, selectors }), before);
});
