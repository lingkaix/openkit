// openkit-test-platform: posix
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkOldWorker,
  inspectRehearsalMigration,
  REHEARSAL_MIGRATION_SQL,
  rehearseStorage,
} from '../scripts/rehearse-v010-upgrade.mjs';

const app = fileURLToPath(new URL('../apps/nanocore/', import.meta.url));
const imageDigest = `sha256:${'a'.repeat(64)}`;
const previous = { sourceCommit: 'a'.repeat(40), releaseTag: 'v0.1.0-rc.99' };
const candidate = { sourceCommit: 'b'.repeat(40), releaseTag: 'v0.1.1' };

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-g5-self-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function nextJournal(appRoot) {
  const root = join(appRoot, 'drizzle', 'core');
  const path = join(root, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8'));
  const last = journal.entries.at(-1);
  const idx = last.idx + 1;
  const tag = `${String(idx).padStart(4, '0')}_g5_rehearsal_probe`;
  journal.entries.push({ ...last, idx, tag, when: last.when + 1 });
  writeFileSync(path, JSON.stringify(journal));
  const sql = join(root, `${tag}.sql`);
  writeFileSync(sql, REHEARSAL_MIGRATION_SQL, { flag: 'wx' });
  return sql;
}

test('self-tests storage using two compiled builds with one real additive Core ledger entry', async (t) => {
  const root = temp(t);
  const next = join(root, 'synthetic-build');
  mkdirSync(next);
  for (const name of ['dist', 'drizzle', 'package.json'])
    cpSync(join(app, name), join(next, name), { recursive: true });
  for (const name of ['node_modules', 'data-templates'])
    symlinkSync(join(app, name), join(next, name), 'dir');
  nextJournal(next);
  const oldIdentity = join(root, 'old-identity.json');
  const newIdentity = join(root, 'next-identity.json');
  writeFileSync(oldIdentity, JSON.stringify(previous));
  writeFileSync(newIdentity, JSON.stringify(candidate));
  const output = join(root, 'owned-rehearsal');
  const result = await rehearseStorage({
    previous: { appRoot: app, identityFile: oldIdentity, workerPlatformImage: imageDigest },
    candidate: { appRoot: next, identityFile: newIdentity },
    output,
  });
  assert.equal(result.status, 'awaiting-worker');
  assert(result.preservedFamilies > 50);
  assert(result.backup.checkedFiles > 0);
  assert(result.futureBackup.checkedFiles > 0);
  assert(result.reopenIdempotent);
  assert.equal(result.oldOpen.code, 'migration_unsupported_core');
  assert.deepEqual(result.futureRestore, {
    code: 'migration_unsupported_core',
    destinationUnchanged: true,
    backupUnchanged: true,
  });
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'storage-result.json'), 'utf8')), result);
});

test('rejects nonadditive candidate SQL and edits to an old migration', (t) => {
  const root = temp(t);
  const prior = join(root, 'old');
  const next = join(root, 'next');
  for (const appRoot of [prior, next])
    cpSync(join(app, 'drizzle'), join(appRoot, 'drizzle'), { recursive: true });
  const sql = nextJournal(next);
  assert.match(inspectRehearsalMigration(prior, next).tag, /_g5_rehearsal_probe$/);
  writeFileSync(sql, 'DROP TABLE users;\n');
  assert.throws(() => inspectRehearsalMigration(prior, next));
  writeFileSync(sql, REHEARSAL_MIGRATION_SQL);
  const userRoot = join(next, 'drizzle', 'user');
  const oldTag = JSON.parse(readFileSync(join(userRoot, 'meta', '_journal.json'), 'utf8'))
    .entries[0].tag;
  writeFileSync(join(userRoot, `${oldTag}.sql`), 'SELECT 1;\n');
  assert.throws(() => inspectRehearsalMigration(prior, next), /old SQL changed/);
});

test('G4 qualification accepts only the typed refusal from a single old-image attempt', async () => {
  const worker = {
    agentId: 'agent_codex_host',
    agentFileId: 'agents/codex.agent.jsonc',
    administrationThreadId: 'admin-thread',
    expectedRuntime: { identityId: 'test-host', deploymentId: 'test-deployment' },
  };
  const commands = [];
  const file = { id: worker.agentFileId, revision: `sha256:${'c'.repeat(64)}` };
  const request = async (name, input, refusalCode = 'worker_release_incompatible') => {
    commands.push(name);
    if (name === 'worker-environment.prepare') {
      assert.deepEqual(input.declaration, {
        kind: 'reference',
        pullPolicy: 'never',
        ref: imageDigest,
      });
      assert.equal(input.configuration.expectedRevision, file.revision);
      return { status: 409, body: { code: refusalCode } };
    }
    const replies = {
      'diagnostics.app': { build: candidate, boot: { acceptingProductWork: true } },
      'nanohost.runtime-target': {
        ready: true,
        freshEmpty: true,
        predecessorFenced: true,
        connectionGeneration: 1,
        ...worker.expectedRuntime,
      },
      'app-update.preflight': { state: 'idle', counts: { running: 0 } },
      'runtime.file-read': { file },
    };
    assert(Object.hasOwn(replies, name), 'An unapproved operation was called.');
    return { status: 200, body: replies[name] };
  };
  const result = await checkOldWorker({ request, candidate, imageDigest, worker });
  assert.deepEqual(result, {
    code: 'worker_release_incompatible',
    status: 409,
    stage: 'image-admission',
    configurationUnchanged: true,
  });
  assert.equal(commands.filter((name) => name === 'worker-environment.prepare').length, 1);
  commands.length = 0;
  await assert.rejects(
    checkOldWorker({
      request: (name, input) => request(name, input, 'recovery_required'),
      candidate,
      imageDigest,
      worker,
    })
  );
  assert.equal(commands.filter((name) => name === 'worker-environment.prepare').length, 1);
});
