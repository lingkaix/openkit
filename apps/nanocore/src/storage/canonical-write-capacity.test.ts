import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
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
/** Retained fault/isolation profile; request latency is diagnostic, not the event-loop SLO. */
const writerProfile = { threadsPerWorkspace: 8, rounds: 2, concurrency: 8, readerHoldMs: 1000 };

/** DX Write And Space Budget, amended in f6ef3fbc8; neither WAL age nor 3,040/s is a gate. */
const referenceBudget = {
  offeredPerSecond: 640,
  primaryTurns: 8,
  siblingWorkspaces: 3,
  eventLoopP99Ms: 25,
  walBytes: 32 * 1024 * 1024,
} as const;

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
  // The reference load observes the real owner; it must not checkpoint on the owner's behalf.
  if (journalMode !== 'wal' || workerData.observeOnly) return null;
  const db = new Database(workerData.paths[0], { fileMustExist: true, timeout: 0 });
  try { return db.pragma('wal_checkpoint(' + mode + ')')[0]; }
  catch (error) { if (error.code === 'SQLITE_BUSY') return { busy: 1 }; throw error; }
  finally { db.close(); }
};
let timer, offerTimer, releasedAt = null, startedAt, pinnedCount, checkpointHeld, finishRequested = false;
const release = () => {
  if (releasedAt !== null) return;
  pinnedCount = count(); checkpointHeld = checkpoint('PASSIVE');
  reader.exec('ROLLBACK'); reader.close(); releasedAt = clock();
  if (finishRequested) finish();
};
const finish = () => {
  if (releasedAt === null) { finishRequested = true; return; }
  sample(); clearInterval(timer); clearInterval(offerTimer);
  const checkpointReleased = checkpoint('TRUNCATE');
  parentPort.postMessage({ journalMode, initialCount, pinnedCount, startedAt, releasedAt,
    checkpointHeld, checkpointReleased, wal: samples.map(({ firstSeen, ...row }) => row) });
  parentPort.close();
};
parentPort.on('message', (message) => {
  if (message === 'start') {
    startedAt = clock(); sample(); timer = setInterval(sample, 10);
    if (workerData.holdMs !== null) setTimeout(release, workerData.holdMs);
    if (workerData.offered) {
      // Ten batches of 64 in one second. Pacing does not wait for the Core event loop or replies.
      let next = 0, firstOfferAt;
      const offer = () => {
        const offeredAt = clock(); firstOfferAt ??= offeredAt;
        const indexes = Array.from({ length: Math.min(64, workerData.offered - next) }, () => next++);
        parentPort.postMessage({ offer: indexes, offeredAt });
        if (next === workerData.offered) {
          clearInterval(offerTimer);
          const lastOfferAt = clock();
          setTimeout(() => parentPort.postMessage({ offered: next, firstOfferAt, lastOfferAt,
            windowEndedAt: clock() }), Math.max(0, 1000 - (clock() - startedAt)));
        }
      };
      offerTimer = setInterval(offer, 100); offer();
    }
  } else if (message === 'release') release();
  else if (message === 'finish') finish();
});
parentPort.postMessage({ held: true, journalMode, initialCount });
`;

/** Seeds the reference topology without starting Native effects; the external traffic source is controlled. */
function referenceFixture() {
  const dataRoot = root();
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspaces = Array.from({ length: 1 + referenceBudget.siblingWorkspaces }, (_, i) =>
      store.createWorkspace(`Reference scope ${i}`)
    );
    const sources = workspaces.flatMap((workspace, index) => {
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
      return Array.from({ length: index === 0 ? referenceBudget.primaryTurns : 1 }, (_, i) => {
        const thread = store.createThread(workspace.id, `Producer ${index}-${i}`);
        const turn = store.createTurn(workspace.id, thread.id, 'Controlled commit load', {
          kind: 'user',
          id: 'usr_00000000-0000-7000-8000-000000000001',
        });
        expect(turn.status).toBe('running');
        return { workspaceId: workspace.id, turnId: turn.id };
      });
    });
    const paths = workspaces.map((workspace) => workspaceDbPath(dataRoot, workspace.id));
    const app = createApp({ coreDb, dataRoot, store });
    return { dataRoot, coreDb, store, workspaces, sources, paths, app };
  } catch (error) {
    coreDb.sqlite.close();
    throw error;
  }
}

/** Sends one ordinary command and retains error bytes without treating non-JSON refusal as a parser failure. */
async function offerCreation(
  f: ReturnType<typeof referenceFixture>,
  job: { workspaceId: string; requestId: string; name: string }
) {
  const response = await f.app.request(
    ...operationRequest(
      'thread.create',
      { workspaceId: job.workspaceId },
      // Private creation reuses an assistant timeline; explicit Workspace visibility makes each job a new record.
      { body: JSON.stringify({ ...job, visibility: 'workspace' }) }
    )
  );
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const id =
    body && typeof body === 'object' && 'id' in body && typeof body.id === 'string'
      ? body.id
      : null;
  if (response.status === 200) {
    expect(id).toEqual(expect.any(String));
    const name = body && typeof body === 'object' && 'name' in body ? body.name : undefined;
    expect(typeof name).toBe('string');
    expect(createHash('sha256').update(String(name)).digest('hex')).toBe(
      createHash('sha256').update(job.name).digest('hex')
    );
  }
  return { ...job, status: response.status, id, body };
}

type CreationOutcome = Awaited<ReturnType<typeof offerCreation>>;

/** Reopens the real owners and compares every acknowledged mutation and exact receipt set, including refused absence. */
function assertReopenedCreations(
  f: ReturnType<typeof referenceFixture>,
  before: readonly { workspaceId: string; id: string; name: string | null }[],
  outcomes: readonly CreationOutcome[]
) {
  if (f.coreDb.sqlite.open) f.coreDb.sqlite.close();
  const cold = new FsStore({ dataRoot: f.dataRoot });
  const acknowledged = outcomes.filter((row) => row.status === 200);
  const order = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  // Hash exact authored bytes so a failed large-payload assertion does not dump megabytes of fixture text.
  const summarize = ({
    name,
    ...identity
  }: {
    workspaceId: string;
    id: string;
    name: string | null;
  }) => ({
    ...identity,
    nameDigest: name === null ? null : createHash('sha256').update(name).digest('hex'),
  });
  expect
    .soft(
      f.workspaces
        .flatMap((workspace) =>
          cold
            .listThreads(workspace.id)
            .map(({ id, name }) => summarize({ workspaceId: workspace.id, id, name }))
        )
        .sort(order)
    )
    .toEqual(
      [
        ...before,
        ...acknowledged.map(({ workspaceId, id, name }) => ({ workspaceId, id: id!, name })),
      ]
        .map(summarize)
        .sort(order)
    );
  const offeredIds = new Set(outcomes.map((row) => row.requestId));
  const receipts = f.paths.flatMap((path, index) => {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return (
        db
          .prepare('SELECT request_id, response_id, command_name FROM idempotency_requests')
          .all() as {
          request_id: string;
          response_id: string;
          command_name: string;
        }[]
      )
        .filter((row) => offeredIds.has(row.request_id))
        .map((row) => ({
          ...row,
          workspaceId: f.workspaces[index]!.id,
        }));
    } finally {
      db.close();
    }
  });
  const byRequest = (a: { request_id: string }, b: { request_id: string }) =>
    a.request_id.localeCompare(b.request_id);
  expect.soft(receipts.sort(byRequest)).toEqual(
    acknowledged
      .map((row) => ({
        workspaceId: row.workspaceId,
        request_id: row.requestId,
        response_id: row.id,
        command_name: 'thread.create',
      }))
      .sort(byRequest)
  );
}

/** Reads actual journal modes without setting policy or opening another writable owner. */
function ownedJournalModes(paths: readonly string[]) {
  return paths.map((path) => {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return db.pragma('journal_mode', { simple: true });
    } finally {
      db.close();
    }
  });
}

it('keeps the 640/s reference envelope within event-loop and WAL budgets with exact reopened acknowledgements', async () => {
  const f = referenceFixture();
  let worker: Worker | undefined;
  const pending: Promise<void>[] = [],
    errors: unknown[] = [];
  const outcomes: CreationOutcome[] = [];
  const lag = monitorEventLoopDelay({ resolution: 1 });
  try {
    // Warm route construction before measuring the steady offered window; retain this real mutation in the cold oracle.
    const warm = await offerCreation(f, {
      workspaceId: f.workspaces[0]!.id,
      requestId: randomUUID(),
      name: 'Warm reference route',
    });
    expect(warm.status, JSON.stringify(warm.body)).toBe(200);
    const before = f.workspaces.flatMap((workspace) =>
      f.store
        .listThreads(workspace.id)
        .map(({ id, name }) => ({ workspaceId: workspace.id, id, name }))
    );
    const jobs = Array.from({ length: referenceBudget.offeredPerSecond }, (_, i) => ({
      workspaceId: f.sources[i % f.sources.length]!.workspaceId,
      requestId: randomUUID(),
      name: `reference-${i}`,
    }));
    const paths = [...f.paths, f.coreDb.sqlite.name];
    worker = new Worker(heldReaderSource, {
      eval: true,
      workerData: {
        databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
        paths,
        holdMs: 0,
        observeOnly: true,
        offered: jobs.length,
      },
    });
    await once(worker, 'message', { signal: AbortSignal.timeout(60_000) });
    const offered = new Promise<{ offered: number; firstOfferAt: number; lastOfferAt: number }>(
      (resolve, reject) => {
        worker!.on('error', reject);
        worker!.on('message', (message) => {
          if (message.offer)
            for (const index of message.offer as number[]) {
              pending.push(
                offerCreation(f, jobs[index]!).then(
                  (row) => {
                    outcomes.push(row);
                  },
                  (error) => {
                    errors.push(error);
                  }
                )
              );
            }
          if (message.offered) resolve(message);
        });
      }
    );
    lag.enable();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    lag.reset();
    worker.postMessage('start');
    const pacing = await offered;
    await Promise.all(pending);
    // Give the monitor a timer turn to record the final blocked interval, before any cold-read instrumentation.
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    lag.disable();
    const finished = once(worker, 'message', { signal: AbortSignal.timeout(60_000) });
    worker.postMessage('finish');
    const [sample] = await finished;
    const modes = ownedJournalModes(paths);
    const eventLoopP99Ms = lag.percentile(99) / 1e6;
    console.info(
      'writer-reference',
      JSON.stringify({
        profile: 'thread-create-reference-v1',
        ...referenceBudget,
        sourceTurnsPerWorkspace: [8, 1, 1, 1],
        pacing,
        eventLoopP99Ms,
        eventLoopSamples: lag.count,
        acknowledged: outcomes.filter((row) => row.status === 200).length,
        refusals: outcomes
          .filter((row) => row.status !== 200)
          .map(({ requestId, status }) => ({ requestId, status })),
        modes,
        wal: sample.wal,
      })
    );
    expect(errors, 'all offered requests must drain without instrument errors').toEqual([]);
    expect(pacing.offered).toBe(referenceBudget.offeredPerSecond);
    // Source qualification, not a product latency bound: all 640 offers must actually occur in one second.
    expect(
      pacing.lastOfferAt - pacing.firstOfferAt,
      'independent source missed its offered window; this is not behavioral RED'
    ).toBeLessThanOrEqual(1000);
    expect(lag.count, 'event-loop instrument must sample the offered window').toBeGreaterThan(0);
    expect(outcomes).toHaveLength(jobs.length);
    expect
      .soft(
        outcomes.filter((row) => row.status !== 200).map(({ status, body }) => ({ status, body }))
      )
      .toEqual([]);
    expect.soft(eventLoopP99Ms).toBeLessThanOrEqual(referenceBudget.eventLoopP99Ms);
    expect.soft(modes).toEqual(paths.map(() => 'wal'));
    for (const row of sample.wal)
      expect.soft(row.peakBytes).toBeLessThanOrEqual(referenceBudget.walBytes);
    // maxNonemptyObservedMs remains diagnostic only; it is not WAL frame age or an SLO.
    assertReopenedCreations(f, before, outcomes);
  } finally {
    lag.disable();
    await worker?.terminate();
    await Promise.allSettled(pending);
    if (f.coreDb.sqlite.open) f.coreDb.sqlite.close();
  }
}, 180_000);

it('refuses oversized WAL demand explicitly while a real reader prevents reclamation, without losing acknowledgements', async () => {
  const f = referenceFixture();
  let worker: Worker | undefined;
  try {
    const workspaceId = f.workspaces[0]!.id;
    const warm = await offerCreation(f, {
      workspaceId,
      requestId: randomUUID(),
      name: 'Warm pressure route',
    });
    expect(warm.status, JSON.stringify(warm.body)).toBe(200);
    const paths = [...f.paths, f.coreDb.sqlite.name];
    const modes = ownedJournalModes(paths);
    // Fail closed rather than call zero-byte DELETE observations WAL-pressure qualification.
    // A failure here is a missing prerequisite, NOT evidence that the pressure fault was reached.
    expect(modes, 'WAL pressure not exercised: actual owned databases must use WAL').toEqual(
      paths.map(() => 'wal')
    );
    const before = f.workspaces.flatMap((workspace) =>
      f.store
        .listThreads(workspace.id)
        .map(({ id, name }) => ({ workspaceId: workspace.id, id, name }))
    );
    worker = new Worker(heldReaderSource, {
      eval: true,
      workerData: {
        databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
        paths,
        holdMs: null,
        observeOnly: true,
      },
    });
    const [held] = await once(worker, 'message', { signal: AbortSignal.timeout(60_000) });
    worker.postMessage('start');
    const outcomes: CreationOutcome[] = [];
    let peakAfterAck = 0;
    // Bounded byte-pressure probe, not a 3,040/s stress gate or an invented queue-size limit.
    // Each unique ordinary metadata creation retains its own bytes; 128 * 512 KiB exceeds the WAL budget.
    for (let i = 0; i < 128; i++) {
      const row = await offerCreation(f, {
        workspaceId,
        requestId: randomUUID(),
        name: `pressure-${i}-${'x'.repeat(512 * 1024)}`,
      });
      outcomes.push(row);
      if (i === 0)
        expect(
          row.status,
          'large command must reach a healthy writer before pressure; otherwise this is not pressure RED'
        ).toBe(200);
      peakAfterAck = Math.max(peakAfterAck, statSync(`${f.paths[0]}-wal`).size);
      if (row.status !== 200) break;
    }
    expect(peakAfterAck, 'pressure probe must observe the actual WAL').toBeGreaterThan(0);
    const refused = outcomes.filter((row) => row.status !== 200);
    expect
      .soft(
        refused,
        'bounded overload must have an explicit refusal, not silent loss or unlimited WAL growth'
      )
      .toHaveLength(1);
    for (const row of refused) {
      expect.soft(row.status).toBeGreaterThanOrEqual(400);
      expect
        .soft(row.body, 'refusal must be structured, not an unclassified server exception')
        .toBeTypeOf('object');
      expect.soft(row.body, 'refusal detail must not be null').not.toBeNull();
    }
    const finished = once(worker, 'message', { signal: AbortSignal.timeout(60_000) });
    worker.postMessage('release');
    worker.postMessage('finish');
    const [sample] = await finished;
    console.info(
      'writer-wal-pressure',
      JSON.stringify({
        offered: outcomes.length,
        refused: refused.map(({ status, body }) => ({ status, body })),
        peakAfterAck,
        wal: sample.wal,
      })
    );
    expect.soft(sample.pinnedCount).toBe(held.initialCount);
    expect.soft(peakAfterAck).toBeLessThanOrEqual(referenceBudget.walBytes);
    for (const row of sample.wal)
      expect.soft(row.peakBytes).toBeLessThanOrEqual(referenceBudget.walBytes);
    assertReopenedCreations(f, before, outcomes);
  } finally {
    await worker?.terminate();
    if (f.coreDb.sqlite.open) f.coreDb.sqlite.close();
  }
}, 180_000);

it('qualifies the held-reader WAL instrument without claiming a Core checkpoint policy', async () => {
  const path = join(root(), 'reader-control.sqlite');
  const writer = new Database(path);
  writer.pragma('journal_mode = WAL');
  writer.pragma('synchronous = FULL');
  // Reuse the owned journal from a37139a1f's worker fixture, not a shadow schema.
  writer.exec(readFileSync(new URL('../../drizzle/user/0000_setup.sql', import.meta.url), 'utf8'));
  const insertReceipt = writer.prepare(
    "INSERT INTO idempotency_requests (request_key, command_name, request_id, scope_json, input_hash, response_kind, response_id, created_at, expires_at) VALUES (?, 'fixture', ?, '{}', 'fixture', 'thread', ?, 'fixture', 'fixture')"
  );
  insertReceipt.run('first', 'first', 'first');
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
    insertReceipt.run('second', 'second', 'second');
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
        requestP99Ms: ordered[Math.ceil(ordered.length * 0.99) - 1],
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
