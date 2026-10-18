import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  admitPair,
  checkWorker,
  compareFamilies,
  EXTERNAL_FAMILIES,
  observeExternal,
  retainedFamilies,
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

test('artifact admission distinguishes the P14 reset from a continuity upgrade', () => {
  const previous = {
    tag: 'v0.1.0-rc.9',
    commit: 'a'.repeat(40),
    appImage: digest,
    nanoHost: digest,
    workerImage: digest,
  };
  const candidate = {
    commit: 'b'.repeat(40),
    appImage: digest,
    nanoHost: digest,
    workerImage: digest,
  };
  admitPair(previous, candidate);
  assert.throws(() => admitPair({ ...previous, tag: 'v0.1.0-rc.8' }, candidate), /reset/);
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
