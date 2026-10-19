import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { FsStore } from '../lib/store.js';
import { createAppWithWorkspaceAuthority as createApp } from '../test-support/app.js';
import { knowledgeOperationRequest } from '../test-support/knowledge-operation.js';
import { knowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { withCanonicalFileWriteAdmission } from './canonical-write-capacity.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import {
  appendCanonicalTextFile,
  loadWorkspaceFileRecords,
  writeFileAtomic,
  writeWorkspaceFileRecords,
} from './workspace-file-records.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), 'canonical-capacity-'));
  roots.push(path);
  return path;
}
/** Frozen offered load; numeric acceptance limits require separate measured approval. */
const writerProfile = { threadsPerWorkspace: 8, rounds: 2, concurrency: 8, readerHoldMs: 1000 };

/** A real reader needs an independent event loop so a synchronous writer cannot block its release. */
const heldReaderSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { statSync } = require('node:fs');
const Database = require(workerData.databaseModule);
const clock = () => Number(process.hrtime.bigint()) / 1e6;
const reader = new Database(workerData.paths[0], { readonly: true, fileMustExist: true });
const journalMode = reader.pragma('journal_mode', { simple: true });
reader.exec('BEGIN');
const count = () => reader.prepare('SELECT count(*) FROM idempotency_requests').pluck().get();
const initialCount = count();
const samples = workerData.paths.map(() => ({ peakBytes: 0, maxNonemptyObservedMs: 0, firstSeen: null }));
const sample = () => workerData.paths.forEach((path, i) => {
  let size = 0;
  try { size = statSync(path + '-wal').size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const row = samples[i], now = clock();
  row.peakBytes = Math.max(row.peakBytes, size);
  if (size > 0) {
    row.firstSeen ??= now;
    row.maxNonemptyObservedMs = Math.max(row.maxNonemptyObservedMs, now - row.firstSeen);
  } else row.firstSeen = null;
});
const checkpoint = (mode) => {
  if (journalMode !== 'wal') return null;
  const db = new Database(workerData.paths[0], { fileMustExist: true, timeout: 0 });
  try { return db.pragma('wal_checkpoint(' + mode + ')')[0]; }
  catch (error) { if (error.code === 'SQLITE_BUSY') return { busy: 1 }; throw error; }
  finally { db.close(); }
};
let timer, releasedAt = null, startedAt, pinnedCount, checkpointHeld, finishRequested = false;
const finish = () => {
  if (releasedAt === null) { finishRequested = true; return; }
  sample(); clearInterval(timer);
  const checkpointReleased = checkpoint('TRUNCATE');
  parentPort.postMessage({ journalMode, initialCount, pinnedCount, startedAt, releasedAt,
    checkpointHeld, checkpointReleased, wal: samples.map(({ firstSeen, ...row }) => row) });
  parentPort.close();
};
parentPort.on('message', (message) => {
  if (message === 'start') {
    startedAt = clock(); sample(); timer = setInterval(sample, 10);
    setTimeout(() => {
      pinnedCount = count(); checkpointHeld = checkpoint('PASSIVE');
      reader.exec('ROLLBACK'); reader.close(); releasedAt = clock();
      if (finishRequested) finish();
    }, workerData.holdMs);
  } else if (message === 'finish') finish();
});
parentPort.postMessage({ held: true, journalMode, initialCount });
`;

it('qualifies the held-reader WAL instrument without claiming a Core checkpoint policy', async () => {
  const path = join(root(), 'reader-control.sqlite');
  const writer = new Database(path);
  writer.pragma('journal_mode = WAL');
  writer.pragma('synchronous = FULL');
  writer.exec(
    'CREATE TABLE idempotency_requests (id INTEGER); INSERT INTO idempotency_requests VALUES (1)'
  );
  const worker = new Worker(heldReaderSource, {
    eval: true,
    workerData: {
      databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
      paths: [path],
      holdMs: writerProfile.readerHoldMs,
    },
  });
  try {
    const [held] = await once(worker, 'message', { signal: AbortSignal.timeout(60_000) });
    expect(held).toMatchObject({ held: true, journalMode: 'wal', initialCount: 1 });
    const finished = once(worker, 'message', { signal: AbortSignal.timeout(60_000) });
    worker.postMessage('start');
    writer.exec('INSERT INTO idempotency_requests VALUES (2)');
    worker.postMessage('finish');
    const [result] = await finished;
    expect(result.pinnedCount).toBe(1);
    expect(result.checkpointHeld.log).toBeGreaterThan(result.checkpointHeld.checkpointed);
    expect(result.checkpointReleased).toEqual({ busy: 0, log: 0, checkpointed: 0 });
    expect(result.wal[0].peakBytes).toBeGreaterThan(0);
    expect(result.wal[0].maxNonemptyObservedMs).toBeGreaterThan(0);
    expect(writer.prepare('SELECT count(*) FROM idempotency_requests').pluck().get()).toBe(2);
  } finally {
    await worker.terminate();
    writer.close();
  }
}, 90_000);

it.each([
  1, 3,
])('isolates concurrent local commit failures across %i Workspace(s) under the frozen writer load', async (workspaceCount) => {
  const dataRoot = root();
  const coreDb = openCoreDb(dataRoot);
  const statementPrototype = Object.getPrototypeOf(
    coreDb.sqlite.prepare('SELECT 1')
  ) as Database.Statement;
  const run = statementPrototype.run,
    exec = Database.prototype.exec;
  let worker: Worker | undefined;
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspaces = Array.from({ length: workspaceCount }, (_, i) =>
      store.createWorkspace(`Writer scope ${i}`)
    );
    for (const workspace of workspaces) {
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        workspaceId: workspace.id,
      });
      const db = openWorkspaceDb(dataRoot, workspace.id);
      try {
        applyScopedMigrations(db);
      } finally {
        db.sqlite.close();
      }
    }
    const threads = Array.from({ length: writerProfile.threadsPerWorkspace }, (_, i) =>
      workspaces.map((workspace) => ({
        ...store.createThread(workspace.id, `Initial ${i}`),
        workspaceId: workspace.id,
      }))
    ).flat();
    const app = createApp({ coreDb, dataRoot, store });
    const paths = workspaces.map((workspace) => workspaceDbPath(dataRoot, workspace.id));
    const selectedPaths = new Set(paths);
    const requestId = (round: number, index: number) =>
      `10000000-0000-4000-8000-${String(round * 1000 + index + 201).padStart(12, '0')}`;
    const failedRequest = requestId(1, 0);
    const offeredIds = new Set(
      Array.from({ length: writerProfile.rounds }, (_, round) =>
        threads.map((_, i) => requestId(round, i))
      ).flat()
    );
    const expectedNames = new Map(
      workspaces
        .flatMap((workspace) => store.listThreads(workspace.id))
        .map((thread) => [thread.id, thread.name])
    );
    const expectedReceipts: { request_id: string; response_id: string }[] = [];
    const pending = new Set<Database.Database>();
    const synchronousModes = new Set<unknown>();
    let receiptCommits = 0,
      faultHits = 0,
      inFlight = 0,
      maximumOffered = 0;
    const latencies: number[] = [];
    const acknowledgeTimes: number[] = [];
    /** Counts receipt-bearing commits, not transactions in unrelated owners or physical flushes. */
    const transactionEnded = (db: Database.Database, source: string) => {
      if (/^\s*(COMMIT|END)\b/i.test(source) && pending.delete(db)) receiptCommits++;
      if (/^\s*ROLLBACK\b/i.test(source) && !/\bTO\b/i.test(source)) pending.delete(db);
    };
    statementPrototype.run = function (...parameters) {
      const receipt =
        selectedPaths.has(this.database.name) &&
        /^\s*INSERT\b/i.test(this.source) &&
        this.source.includes('idempotency_requests') &&
        parameters.some((value) => typeof value === 'string' && offeredIds.has(value));
      if (receipt) {
        synchronousModes.add(this.database.pragma('synchronous', { simple: true }));
        if (parameters.includes(failedRequest)) {
          faultHits++;
          throw new Error('Injected concurrent receipt failure.');
        }
      }
      const result = run.apply(this, parameters);
      if (receipt) {
        if (this.database.inTransaction) pending.add(this.database);
        else receiptCommits++;
      }
      transactionEnded(this.database, this.source);
      return result;
    };
    Database.prototype.exec = function (source) {
      const result = exec.call(this, source);
      transactionEnded(this, source);
      return result;
    };
    worker = new Worker(heldReaderSource, {
      eval: true,
      workerData: {
        databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
        paths,
        holdMs: writerProfile.readerHoldMs,
      },
    });
    let workerFailure: Error | undefined;
    worker.on('error', (error) => {
      workerFailure = error;
    });
    const [held] = await once(worker, 'message', { signal: AbortSignal.timeout(60_000) });
    expect(held.held).toBe(true);
    worker.postMessage('start');
    for (let round = 0; round < writerProfile.rounds; round++) {
      const jobs = threads.map((thread, i) => ({
        thread,
        requestId: requestId(round, i),
        name: `load-${round}-${String(i).padStart(2, '0')}`,
        kind: requestId(round, i) === failedRequest ? 'failure' : 'success',
      }));
      if (round === 1)
        jobs.splice(1, 0, {
          thread: threads[0]!,
          requestId: requestId(0, 0),
          name: 'different-input',
          kind: 'conflict',
        });
      for (let offset = 0; offset < jobs.length; offset += writerProfile.concurrency) {
        const outcomes = await Promise.allSettled(
          jobs.slice(offset, offset + writerProfile.concurrency).map(async (job) => {
            const workspaceId = job.thread.workspaceId;
            const started = performance.now();
            maximumOffered = Math.max(maximumOffered, ++inFlight);
            try {
              const response = await app.request(
                ...operationRequest(
                  'thread.update',
                  { workspaceId, threadId: job.thread.id },
                  {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                      workspaceId,
                      threadId: job.thread.id,
                      requestId: job.requestId,
                      name: job.name,
                    }),
                  }
                )
              );
              latencies.push(performance.now() - started);
              if (job.kind === 'conflict') {
                expect.soft(response.status).toBe(409);
                return;
              }
              if (job.kind === 'failure') {
                expect.soft(response.status).toBeGreaterThanOrEqual(400);
                return;
              }
              expect.soft(response.status, await response.clone().text()).toBe(200);
              expectedNames.set(job.thread.id, job.name);
              expectedReceipts.push({ request_id: job.requestId, response_id: job.thread.id });
              acknowledgeTimes.push(Number(process.hrtime.bigint()) / 1e6);
              const independent = new Database(workspaceDbPath(dataRoot, workspaceId), {
                readonly: true,
                fileMustExist: true,
              });
              try {
                expect
                  .soft(
                    independent
                      .prepare('SELECT response_id FROM idempotency_requests WHERE request_id = ?')
                      .pluck()
                      .all(job.requestId)
                  )
                  .toEqual([job.thread.id]);
                expect
                  .soft(new FsStore({ dataRoot }).getThread(workspaceId, job.thread.id).name)
                  .toBe(job.name);
              } finally {
                independent.close();
              }
            } finally {
              inFlight--;
            }
          })
        );
        // Drain every offered command before cleanup even if one observer unexpectedly throws.
        for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
      }
    }
    if (workerFailure) throw workerFailure;
    const finished = once(worker, 'message', { signal: AbortSignal.timeout(60_000) });
    worker.postMessage('finish');
    const [reader] = await finished;
    const ordered = [...latencies].sort((a, b) => a - b);
    console.info(
      'writer-load',
      JSON.stringify({
        profile: 'thread-update-v1',
        workspaceCount,
        ...writerProfile,
        offered: latencies.length,
        maximumOffered,
        p99Ms: ordered[Math.ceil(ordered.length * 0.99) - 1],
        receiptCommits,
        synchronousModes: [...synchronousModes],
        faultHits,
        acknowledgedWhileReaderHeld: acknowledgeTimes.filter((time) => time < reader.releasedAt)
          .length,
        reader,
      })
    );
    expect(faultHits).toBeGreaterThan(0);
    expect(maximumOffered).toBe(writerProfile.concurrency);
    expect(latencies).toHaveLength(
      writerProfile.threadsPerWorkspace * workspaceCount * writerProfile.rounds + 1
    );
    expect([...synchronousModes]).toEqual([2]);
    expect(receiptCommits).toBeGreaterThan(0);
    expect(reader.pinnedCount).toBe(reader.initialCount);
    const cold = new FsStore({ dataRoot });
    const expected = [...expectedNames]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const reader of [store, cold]) {
      const actual = workspaces
        .flatMap((workspace) => reader.listThreads(workspace.id))
        .map(({ id, name }) => ({ id, name }))
        .sort((a, b) => a.id.localeCompare(b.id));
      expect.soft(actual).toEqual(expected);
    }
    const receipts = paths.flatMap((path) => {
      const db = new Database(path, { readonly: true, fileMustExist: true });
      try {
        return (
          db.prepare('SELECT request_id, response_id FROM idempotency_requests').all() as {
            request_id: string;
            response_id: string;
          }[]
        ).filter((row) => offeredIds.has(row.request_id));
      } finally {
        db.close();
      }
    });
    const order = (a: { request_id: string }, b: { request_id: string }) =>
      a.request_id.localeCompare(b.request_id);
    expect(receipts.sort(order)).toEqual(expectedReceipts.sort(order));
  } finally {
    statementPrototype.run = run;
    Database.prototype.exec = exec;
    await worker?.terminate();
    coreDb.sqlite.close();
  }
}, 90_000);

/** Retained inline records exercise the existing writer; new uploads use file descriptors. */
function fixture(content = 'prior original') {
  const dataRoot = root(),
    store = new FsStore({ dataRoot }),
    workspace = store.createWorkspace('Canonical capacity');
  const bytes = content;
  const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const artifactId = allocateEntityId('ar');
  const requestId = randomUUID(),
    time = new Date().toISOString();
  store.createArtifact({
    id: artifactId,
    workspaceId: workspace.id,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: 'Retained original',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'text', body: bytes },
    contentDigest,
    lastMutationRequestId: requestId,
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: requestId,
      sourceDigest: contentDigest,
      actor: { kind: 'user', id: allocateEntityId('usr') },
      requestId,
      recordedAt: time,
    },
    createdAt: time,
    updatedAt: time,
  });
  return {
    dataRoot,
    store,
    workspace,
    artifactId,
    workspaceRoot: join(dataRoot, 'workspaces', workspace.id),
  };
}
it('reserves the full pending UTF-8 replacement before any file effect and includes concurrent future writes', () => {
  const path = root(),
    target = join(path, 'canonical');
  writeFileSync(target, 'prior');
  const bytes = '界🙂'.repeat(10000),
    reserve = 1_000_000n;
  const admission = new FileStorageAdmission(
    path,
    () => reserve,
    () => reserve + BigInt(Buffer.byteLength(bytes)) + 65536n
  );
  const competing = admission.reserve({
    stagingBytes: 1n,
    extractionBytes: 0n,
    derivativeBytes: 0n,
    publicationBytes: 0n,
  });
  expect(() =>
    withCanonicalFileWriteAdmission(admission, () => writeFileAtomic(target, bytes))
  ).toThrow('capacity');
  expect(readFileSync(target, 'utf8')).toBe('prior');
  expect(readdirSync(path)).toEqual(['canonical']);
  competing.release();
  withCanonicalFileWriteAdmission(admission, () => writeFileAtomic(target, bytes));
  expect(readFileSync(target, 'utf8')).toBe(bytes);
});
it('accounts for exact reference/event append bytes and restores the scope after a refusal', () => {
  const path = root(),
    target = join(path, 'events');
  writeFileSync(target, '{"prior":true}\n');
  const admission = new FileStorageAdmission(
    path,
    () => 100n,
    () => 100n + 65536n
  );
  expect(() =>
    withCanonicalFileWriteAdmission(admission, () =>
      appendCanonicalTextFile(target, '{"next":true}\n')
    )
  ).toThrow('capacity');
  expect(readFileSync(target, 'utf8')).toBe('{"prior":true}\n');
  appendCanonicalTextFile(target, '{"outside":"unchanged owner"}\n');
  expect(readFileSync(target, 'utf8')).toContain('outside');
});
it('refuses a retained large inline body copy while preserving its original bytes', () => {
  const f = fixture('x'.repeat(1024 * 1024));
  const records = loadWorkspaceFileRecords(f.dataRoot).find(
    (r) => r.workspace.id === f.workspace.id
  )!;
  const payload = join(f.workspaceRoot, 'artifacts', f.artifactId, 'files', 'content.txt'),
    before = readFileSync(payload);
  const admission = new FileStorageAdmission(
    f.dataRoot,
    () => 1_000_000n,
    () => 1_000_000n + 128n * 1024n
  );
  // Prove a healthy capacity source before the deciding large-write refusal.
  admission
    .reserve({ stagingBytes: 0n, extractionBytes: 0n, derivativeBytes: 0n, publicationBytes: 0n })
    .release();
  expect(() =>
    withCanonicalFileWriteAdmission(admission, () =>
      writeWorkspaceFileRecords(f.workspaceRoot, records)
    )
  ).toThrow('capacity');
  expect(readFileSync(payload)).toEqual(before);
});
it('does not rewrite canonical Notebook pages during record persistence under capacity pressure', async () => {
  const f = fixture();
  const coreDb = openCoreDb(f.dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: f.workspace.id,
  });
  try {
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(f.workspaceRoot, 'knowledge', 'notebook.git'),
    });
    const app = createApp({ coreDb, dataRoot: f.dataRoot, store: f.store });
    const timestamp = new Date().toISOString();
    const page = knowledgePageFixture(
      {
        id: 'retained-knowledge',
        title: 'Retained Knowledge',
        content: 'k'.repeat(1024 * 1024),
        sourceReferences: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      { kind: 'workspace', workspaceId: f.workspace.id }
    );
    const response = await app.request(
      ...knowledgeOperationRequest(
        'knowledge.notebook.create',
        { workspaceId: f.workspace.id },
        {
          body: JSON.stringify({
            requestId: randomUUID(),
            baseRevision: notebook.publishedRevision(),
            path: page.path,
            content: page.content,
            summary: 'Create the canonical page before record persistence.',
          }),
        }
      )
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const revision = notebook.publishedRevision();
    const path = page.path;
    const before = Buffer.from(notebook.readRevision(revision, [path]).files[path]!);
    const digest = createHash('sha256').update(before).digest('hex');
    const records = loadWorkspaceFileRecords(f.dataRoot).find(
      (r) => r.workspace.id === f.workspace.id
    )!;
    // A stale projection cannot replace the Git-owned canonical page.
    records.knowledge.find((entry) => entry.id === page.id)!.content = 'Stale projected content.';
    const admission = new FileStorageAdmission(
      f.dataRoot,
      () => 1_000_000n,
      () => 1_000_000n + 128n * 1024n
    );
    // Prove a healthy capacity source before persistence under the small budget.
    admission
      .reserve({ stagingBytes: 0n, extractionBytes: 0n, derivativeBytes: 0n, publicationBytes: 0n })
      .release();
    expect(() =>
      withCanonicalFileWriteAdmission(admission, () =>
        writeWorkspaceFileRecords(f.workspaceRoot, records)
      )
    ).not.toThrow();
    expect(notebook.publishedRevision()).toBe(revision);
    const after = Buffer.from(
      notebook.readRevision(notebook.publishedRevision(), [path]).files[path]!
    );
    expect(after).toEqual(before);
    expect(createHash('sha256').update(after).digest('hex')).toBe(digest);
  } finally {
    coreDb.sqlite.close();
  }
});
it('skips equal JSON cores but reserves retained additive fields when the core changes', () => {
  const f = fixture(),
    target = join(f.workspaceRoot, 'artifacts', f.artifactId, 'artifact.json');
  const json = JSON.parse(readFileSync(target, 'utf8'));
  json.futureMetadata = 'u'.repeat(1024 * 1024);
  writeFileSync(target, JSON.stringify(json));
  const records = loadWorkspaceFileRecords(f.dataRoot).find(
    (r) => r.workspace.id === f.workspace.id
  )!;
  const admission = new FileStorageAdmission(
    f.dataRoot,
    () => 1_000_000n,
    () => 1_000_000n + 128n * 1024n
  );
  // Prove a healthy capacity source before the deciding large-write refusal.
  admission
    .reserve({ stagingBytes: 0n, extractionBytes: 0n, derivativeBytes: 0n, publicationBytes: 0n })
    .release();
  expect(() =>
    withCanonicalFileWriteAdmission(admission, () =>
      writeWorkspaceFileRecords(f.workspaceRoot, records)
    )
  ).not.toThrow();
  const before = readFileSync(target);
  // Lifecycle status is mutable without changing the retained content version.
  records.artifacts[0]!.status = 'archived';
  expect(() =>
    withCanonicalFileWriteAdmission(admission, () =>
      writeWorkspaceFileRecords(f.workspaceRoot, records)
    )
  ).toThrow('capacity');
  expect(readFileSync(target)).toEqual(before);
  expect(existsSync(target)).toBe(true);
});
