import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  finishCapabilityCall,
  importWorkspaceCapabilityUsageLedger,
  listWorkspaceCapabilityCalls,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { clearWorkerCheckpoint, upsertWorkerCheckpoint } from './worker-checkpoints.js';
import {
  assertWorkerRawOutputFinalStatus,
  initializeWorkerRawOutput,
  invalidateWorkerRawOutputProof,
  MAX_WORKER_RAW_OUTPUT_BYTES,
  observeWorkerRawOutput,
  readWorkerRawOutput,
  settleWorkerRawOutput,
} from './worker-raw-output.js';

const roots: string[] = [];
const databases: WorkspaceDb[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once('exit', () => resolve());
          child.kill('SIGKILL');
        })
    )
  );
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real migrated ledger and inference calls, including Turns that never had a checkpoint. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'worker-raw-output-'));
  roots.push(root);
  const scope = { workspaceId: randomUUID(), threadId: randomUUID(), turnId: randomUUID() };
  const db = openWorkspaceDb(root, scope.workspaceId);
  databases.push(db);
  applyScopedMigrations(db);
  const newCall = (database = db, initialize = true) => {
    const call = startCapabilityCall({
      workspaceDb: database,
      ...scope,
      authorityActor: null,
      family: 'llm',
      operation: 'chat_completions',
      capabilityId: 'llm.gateway.use',
      redactionClass: 'metadata-only',
      serviceRef: 'worker-inference-gateway',
    });
    if (initialize) initializeWorkerRawOutput(database, call, scope);
    return call;
  };
  const call = newCall();
  const identity = {
    ...scope,
    callId: call.id,
    attemptId: randomUUID(),
    partId: 0,
    field: 'text' as const,
    fromBytePosition: 0,
  };
  return { root, db, scope, call, identity, newCall };
}

describe('durable atomic Worker raw output accounting', () => {
  it('admits exactly sixteen MiB and persists the next byte across checkpoint removal', () => {
    const { db, scope, identity } = fixture();
    upsertWorkerCheckpoint(db, {
      ...scope,
      requestId: randomUUID(),
      requestInputHash: 'input',
      stage: 'running_worker',
      iteration: 1,
    });
    expect(
      observeWorkerRawOutput(db, { ...identity, bytePosition: MAX_WORKER_RAW_OUTPUT_BYTES })
    ).toEqual({ rawOutputBytes: 16_777_216, chargedBytes: 16_777_216, exhausted: false });
    expect(clearWorkerCheckpoint(db, scope.workspaceId, scope.threadId, scope.turnId)).toBe(true);
    expect(
      observeWorkerRawOutput(db, {
        ...identity,
        fromBytePosition: 16_777_216,
        bytePosition: 16_777_217,
      })
    ).toEqual({ rawOutputBytes: 16_777_217, chargedBytes: 1, exhausted: true });
    expect(readWorkerRawOutput(db, scope)).toEqual({ rawOutputBytes: 16_777_217, exhausted: true });
  });
  it('deduplicates trusted positions and final snapshots, while new attempts and child calls count again', () => {
    const { db, identity, newCall } = fixture();
    expect(observeWorkerRawOutput(db, { ...identity, bytePosition: 7 }).chargedBytes).toBe(7);
    expect(observeWorkerRawOutput(db, { ...identity, bytePosition: 3 }).chargedBytes).toBe(0);
    expect(observeWorkerRawOutput(db, { ...identity, bytePosition: 7 }).chargedBytes).toBe(0);
    expect(
      observeWorkerRawOutput(db, { ...identity, fromBytePosition: 7, bytePosition: 11 })
        .chargedBytes
    ).toBe(4);
    expect(observeWorkerRawOutput(db, { ...identity, bytePosition: 11 }).chargedBytes).toBe(0);
    expect(
      observeWorkerRawOutput(db, { ...identity, attemptId: randomUUID(), bytePosition: 11 })
        .rawOutputBytes
    ).toBe(22);
    expect(
      observeWorkerRawOutput(db, { ...identity, callId: newCall().id, bytePosition: 11 })
        .rawOutputBytes
    ).toBe(33);
  });
  it('shares one allowance across actual simultaneous SQLite writers', async () => {
    const state = fixture();
    const second = state.newCall();
    const rawModule = fileURLToPath(new URL('./worker-raw-output.ts', import.meta.url));
    const dbModule = fileURLToPath(new URL('../storage/db.ts', import.meta.url));
    const run = (callId: string, bytePosition: number) => {
      const script = `import {openWorkspaceDb} from ${JSON.stringify(dbModule)};
        import {observeWorkerRawOutput} from ${JSON.stringify(rawModule)};
        const db=openWorkspaceDb(${JSON.stringify(state.root)},${JSON.stringify(state.scope.workspaceId)});
        process.on('message',()=>{try { const result=observeWorkerRawOutput(db,${JSON.stringify({ ...state.identity, callId, bytePosition })});
          db.sqlite.close();process.send(result,()=>process.exit(0)); } catch {process.exit(1);} });process.send('ready');`;
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
      );
      children.push(child);
      const ready = new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code !== 0) reject(new Error('Raw SQLite child setup failed.'));
        });
      });
      const result = ready.then(
        () =>
          new Promise<{ exhausted: boolean }>((resolve, reject) => {
            child.once('message', resolve);
            child.once('exit', (code) => {
              if (code !== 0) reject(new Error('Raw SQLite child failed.'));
            });
          })
      );
      return { child, ready, result };
    };
    const a = run(state.call.id, 8_388_608),
      b = run(second.id, 8_388_609);
    await Promise.all([a.ready, b.ready]);
    a.child.send('go');
    b.child.send('go');
    expect((await Promise.all([a.result, b.result])).map((r) => r.exhausted).sort()).toEqual([
      false,
      true,
    ]);
    expect(readWorkerRawOutput(state.db, state.scope)).toEqual({
      rawOutputBytes: 16_777_217,
      exhausted: true,
    });
  }, 30_000);
  it('retains proof through reopen, archive ledger codec and outcome Turns without checkpoints', () => {
    const { root, db, scope, identity, call } = fixture();
    observeWorkerRawOutput(db, { ...identity, bytePosition: 41 });
    settleWorkerRawOutput(db, scope, call.id, true);
    finishCapabilityCall({ workspaceDb: db, callId: call.id, status: 'succeeded' });
    const calls = listWorkspaceCapabilityCalls(db, scope.workspaceId);
    db.sqlite.close();
    const reopened = openWorkspaceDb(root, scope.workspaceId);
    databases.push(reopened);
    expect(observeWorkerRawOutput(reopened, { ...identity, bytePosition: 41 }).chargedBytes).toBe(
      0
    );
    expect(() => assertWorkerRawOutputFinalStatus(reopened, scope, true)).not.toThrow();
    const archiveRoot = mkdtempSync(join(tmpdir(), 'raw-archive-'));
    roots.push(archiveRoot);
    const restored = openWorkspaceDb(archiveRoot, scope.workspaceId);
    databases.push(restored);
    applyScopedMigrations(restored);
    importWorkspaceCapabilityUsageLedger({
      workspaceDb: restored,
      capabilityCalls: calls,
      usageRecords: [],
    });
    expect(readWorkerRawOutput(restored, scope)).toEqual({ rawOutputBytes: 41, exhausted: false });
    expect(() => initializeWorkerRawOutput(reopened, call, scope)).toThrow('requires recovery');
  });
  it('counts exact UTF-8, argument whitespace and visible reasoning, with value-free durable positions', () => {
    const { db, identity } = fixture();
    observeWorkerRawOutput(db, { ...identity, bytePosition: Buffer.byteLength('中文🙂') });
    observeWorkerRawOutput(db, {
      ...identity,
      field: 'tool-arguments',
      bytePosition: Buffer.byteLength('{ "body": "x" }'),
    });
    expect(
      observeWorkerRawOutput(db, {
        ...identity,
        field: 'reasoning',
        bytePosition: Buffer.byteLength('why\n'),
      }).rawOutputBytes
    ).toBe(29);
    const stored = db.sqlite.prepare('SELECT extensions_json FROM capability_calls').get() as {
      extensions_json: string;
    };
    for (const value of ['body', 'why', identity.attemptId])
      expect(stored.extensions_json).not.toContain(value);
  });
  it('refuses legacy, corrupt and gapped proof without resetting observed bytes', () => {
    const { db, identity, scope, newCall } = fixture();
    expect(() =>
      observeWorkerRawOutput(db, { ...identity, turnId: randomUUID(), bytePosition: 2 })
    ).toThrow('requires recovery');
    expect(() =>
      observeWorkerRawOutput(db, { ...identity, fromBytePosition: 1, bytePosition: 2 })
    ).toThrow('requires recovery');
    observeWorkerRawOutput(db, { ...identity, bytePosition: 2 });
    newCall(db, false);
    expect(() => readWorkerRawOutput(db, scope)).toThrow('requires recovery');
    db.sqlite.prepare('DELETE FROM capability_calls WHERE call_id <> ?').run(identity.callId);
    db.sqlite
      .prepare(
        'UPDATE capability_calls SET extensions_json = json_set(extensions_json, \'$."openkit.worker/rawOutput".byteLength\', 1)'
      )
      .run();
    expect(() => observeWorkerRawOutput(db, { ...identity, bytePosition: 3 })).toThrow(
      'requires recovery'
    );
  });
  it('keeps a delayed native observer unavailable after public cancellation', () => {
    const { db, identity, scope, call } = fixture();
    observeWorkerRawOutput(db, { ...identity, bytePosition: 5 });
    expect(() => assertWorkerRawOutputFinalStatus(db, scope, true)).toThrow('still settling');
    settleWorkerRawOutput(db, scope, call.id, false);
    finishCapabilityCall({ workspaceDb: db, callId: call.id, status: 'aborted' });
    expect(() => assertWorkerRawOutputFinalStatus(db, scope, true)).toThrow('requires recovery');
    // A late source event or later settlement cannot repair the failed coverage claim.
    expect(() =>
      observeWorkerRawOutput(db, { ...identity, fromBytePosition: 5, bytePosition: 6 })
    ).toThrow('requires recovery');
    settleWorkerRawOutput(db, scope, call.id, true);
    expect(() => assertWorkerRawOutputFinalStatus(db, scope, true)).toThrow('requires recovery');
    invalidateWorkerRawOutputProof(db, scope, call.id);
    expect(() => assertWorkerRawOutputFinalStatus(db, scope, false)).not.toThrow();
  });
});
