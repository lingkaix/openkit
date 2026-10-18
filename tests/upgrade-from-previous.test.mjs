import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  activateWorker,
  admitPair,
  checkWorker,
  compareFamilies,
  EXTERNAL_FAMILIES,
  observeExternal,
  retainedFamilies,
  runPhase,
  summarizeFamilies,
} from '../scripts/upgrade-from-previous.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const sample = {
  values: [{ id: 'public-fixture', text: 'B01 Ω' }],
  bytes: [{ path: 'workspace/input', byteLength: 4, sha256: 'b'.repeat(64) }],
};

test('inventory follows all canonical and SQL rows but excludes disposable derivatives', () => {
  assert.deepEqual(
    retainedFamilies(
      '### Canonical Files And Retained Evidence\n| Family | Location |\n| --- | --- |\n| Files | a |\n### SQLite Authority Families\n| Family | Location |\n| --- | --- |\n| SQL | b |\n### Rebuildable And Disposable Boundary\n| Cache | c |'
    ),
    ['Files', 'SQL']
  );
});

test('readback refuses a dropped family or changed retained value even when boot passed', () => {
  const before = summarizeFamilies({ Files: sample }, ['Files']);
  assert.deepEqual(compareFamilies(before, { Files: sample }, ['Files']), before);
  assert.throws(() => compareFamilies(before, {}, ['Files']), /no reader result/);
  assert.throws(
    () =>
      compareFamilies(before, { Files: { ...sample, values: [{ text: 'lost history' }] } }, [
        'Files',
      ]),
    /retained readback changed/
  );
  assert.throws(
    () => compareFamilies(before, { Files: sample }, ['Files', 'New family']),
    /New family: no reader result/
  );
});

test('SQL authority compares selected reader values without requiring an immutable database file', () => {
  const sql = { values: [{ id: 'public-row', content: 'original' }], bytes: [] };
  const baseline = summarizeFamilies({ SQL: sql }, ['SQL']);
  assert.deepEqual(compareFamilies(baseline, { SQL: sql }, ['SQL']), baseline);
  assert.throws(
    () =>
      compareFamilies(
        baseline,
        { SQL: { ...sql, values: [{ id: 'public-row', content: 'changed' }] } },
        ['SQL']
      ),
    /retained readback changed/
  );
});

test('artifact admission accepts the selected previous RC and requires exact identities', () => {
  const previous = {
    tag: 'v0.1.0-rc.8',
    commit: 'a'.repeat(40),
    appImage: digest,
    nanoHost: digest,
    workerImage: digest,
    workerPlatformImage: digest,
  };
  const candidate = {
    commit: 'b'.repeat(40),
    appImage: digest,
    nanoHost: digest,
    workerImage: digest,
    workerPlatformImage: digest,
  };
  admitPair(previous, candidate);
  assert.throws(
    () => admitPair({ ...previous, tag: 'latest' }, candidate),
    /Previous release tag is invalid/
  );
  assert.throws(
    () => admitPair(previous, { ...candidate, nanoHost: 'unpublished-latest' }),
    /exact nanoHost digest/
  );
});

test('external retained bytes participate in exact comparison without native-format conversion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openkit-upgrade-external-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const selections = {};
  for (const [index, family] of EXTERNAL_FAMILIES.entries()) {
    const directory = `family-${index}`;
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, 'sample'), Buffer.from([0, 255, 128, index]));
    selections[family] = [directory];
  }
  const baseline = summarizeFamilies(await observeExternal(root, selections), EXTERNAL_FAMILIES);
  compareFamilies(baseline, await observeExternal(root, selections), EXTERNAL_FAMILIES);
  await writeFile(join(root, 'family-1/sample'), 'changed');
  const changed = await observeExternal(root, selections);
  assert.throws(() => compareFamilies(baseline, changed, EXTERNAL_FAMILIES), /changed/);
  await assert.rejects(
    observeExternal(root, { ...selections, [EXTERNAL_FAMILIES[0]]: [] }),
    /missing fixture selection/
  );
});

test('Worker acceptance requires retained tool/result and assistant output, and submits only once', async (t) => {
  const calls = [];
  let turnStatus = 'completed';
  const ready = {
    ready: true,
    freshEmpty: true,
    predecessorFenced: true,
    identityId: 'fixture-host',
    deploymentId: 'fixture-deployment',
    connectionGeneration: 4,
  };
  const server = createServer(async (request, response) => {
    const operation = request.url.split('/').at(-1);
    calls.push(operation);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const replies = {
      'nanohost.runtime-target': ready,
      'app-update.preflight': { state: 'idle', counts: { activeTurns: 0 } },
      'thread.create': { id: 'thread-fixture' },
      'turn.start': { id: 'turn-fixture' },
      'turn.read': { id: 'turn-fixture', status: turnStatus, input: 'not printed' },
      'thread.items': {
        nextCursor: null,
        items: [
          {
            turnId: 'turn-fixture',
            type: 'user-message',
            text: 'Use the shell tool to run printf UPGRADE_OK. Then reply with exactly UPGRADE_OK.',
          },
          {
            turnId: 'turn-fixture',
            type: 'command-execution',
            status: 'completed',
            output: 'UPGRADE_OK',
            exitCode: 0,
          },
          {
            turnId: 'turn-fixture',
            type: 'assistant-message',
            status: 'completed',
            text: 'UPGRADE_OK',
          },
        ],
      },
    };
    if (operation === 'thread.create') assert.equal(body.visibility, 'workspace');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(replies[operation]));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const input = {
    origin: `http://127.0.0.1:${server.address().port}`,
    token: 'synthetic-not-a-credential',
    workspaceId: 'workspace-fixture',
    agentId: 'fixture',
    modelId: 'smart',
    requestId: 'request-fixture',
    expectedRuntime: ready,
  };
  assert.equal((await checkWorker(input)).passed, true);
  assert.equal(calls.filter((operation) => operation === 'turn.start').length, 1);
  turnStatus = 'failed';
  await assert.rejects(
    checkWorker({ ...input, requestId: 'second-fixture' }),
    /Worker Turn failed/
  );
  assert.equal(calls.filter((operation) => operation === 'turn.start').length, 2);
});

test('matching Worker activation uses the prepared confirmation and checks the actual desired image', async (t) => {
  let active = false;
  let blocked = false;
  let activations = 0;
  const child = `sha256:${'d'.repeat(64)}`;
  const prepared = {
    resolvedCandidate: { imageDigest: child },
    configuration: { fileId: 'agents/fixture.agent.jsonc', expectedRevision: 2 },
    target: { kind: 'agent', agentId: 'fixture' },
    replaceNow: false,
    affectedStorage: [],
    activationConfirmation: 'Synthetic returned confirmation',
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const operation = request.url.split('/').at(-1);
    let result;
    if (operation === 'runtime.agent-environment-read')
      result = {
        desired: { imageDigest: active ? child : digest },
        reload: { matchesDesired: active },
        defaults: active ? { admitted: true } : null,
      };
    else if (operation === 'runtime.file-read')
      result = { file: { id: 'agents/fixture.agent.jsonc', revision: 2 } };
    else if (operation === 'worker-environment.prepare') {
      assert.deepEqual(body.declaration, { kind: 'reference', ref: child, pullPolicy: 'never' });
      result = {
        ...prepared,
        affectedStorage: blocked ? [{ storageRef: 'retained-fixture' }] : [],
      };
    } else if (operation === 'worker-environment.activate') {
      assert.equal(body.confirmation, prepared.activationConfirmation);
      assert.deepEqual(body.resolvedCandidate, prepared.resolvedCandidate);
      active = true;
      activations++;
      result = {};
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const input = {
    origin: `http://127.0.0.1:${server.address().port}`,
    token: 'synthetic-not-a-credential',
    agentId: 'fixture',
    agentFileId: 'agents/fixture.agent.jsonc',
    administrationThreadId: 'synthetic-admin-thread',
  };
  assert.equal((await activateWorker(input, child)).imageDigest, child);
  assert.equal(activations, 1);
  await activateWorker(input, child);
  assert.equal(activations, 1);
  active = false;
  blocked = true;
  await assert.rejects(activateWorker(input, child), /affect retained storage/);
  assert.equal(activations, 1);
});

test('revision-local corpus helpers join every current retained family before comparison passes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openkit-upgrade-joined-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = resolve('apps/nanocore');
  const dataRoot = join(root, 'data');
  const retainedRoot = join(root, 'retained');
  const load = (path) => import(pathToFileURL(join(appRoot, 'dist', path)).href);
  const { ensureLayout } = await load('storage/fs-layout.js');
  const { openCoreDb } = await load('storage/db.js');
  const { applyMigrations } = await load('storage/migrate.js');
  const { ensureLocalUser } = await load('test-support/local-user.js');
  ensureLayout(dataRoot);
  const core = openCoreDb(dataRoot);
  let userId;
  try {
    applyMigrations(core);
    userId = ensureLocalUser(core);
  } finally {
    core.sqlite.close();
  }
  const externalRoot = join(root, 'external');
  await mkdir(externalRoot);
  const externalSelections = {};
  for (const [index, family] of EXTERNAL_FAMILIES.entries()) {
    // These stand-ins exercise the join only. Actual Host/native/helper samples
    // come from the prepared disposable guest in the real release-pair run.
    const path = `synthetic-${index}`;
    await mkdir(join(externalRoot, path));
    await writeFile(join(externalRoot, path, 'sample'), `Public synthetic join sample ${index}.`);
    externalSelections[family] = [path];
  }
  const input = {
    previous: {
      tag: 'v0.1.0-rc.8',
      commit: 'a'.repeat(40),
      appImage: digest,
      nanoHost: digest,
      workerImage: digest,
      workerPlatformImage: digest,
    },
    candidate: {
      commit: 'b'.repeat(40),
      appImage: digest,
      nanoHost: digest,
      workerImage: digest,
      workerPlatformImage: digest,
    },
    checkout: resolve('.'),
    appRoot,
    dataRoot,
    retainedRoot,
    userId,
    externalRoot,
    externalSelections,
    baseline: join(root, 'baseline.json'),
    previousCheckout: resolve('.'),
    operatorFixtureRoot: join(externalRoot, 'operator-fixtures'),
  };
  const fixtures = await runPhase('fixtures', input);
  Object.assign(input.externalSelections, fixtures.externalSelections);
  assert.equal((await runPhase('seed', input)).passed, true);
  const expected = retainedFamilies(
    await readFile('docs/specs/20261017-retained_format_register.md', 'utf8')
  );
  const snapshot = await runPhase('snapshot', input);
  assert.equal(snapshot.families, expected.length);
  assert.equal((await runPhase('operator-read-before', input)).passed, true);
  assert.equal((await runPhase('operator-read', input)).passed, true);
  await writeFile(join(externalRoot, 'synthetic-1/new-candidate-file'), 'A new valid file.');
  assert.equal((await runPhase('compare', input)).passed, true);
  await writeFile(join(externalRoot, 'synthetic-1/sample'), 'Native opaque bytes lost.');
  await assert.rejects(
    runPhase('compare', input),
    /Worker volume and native resume slots: retained readback changed/
  );
});
