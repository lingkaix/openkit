// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireAdministratorOperation } from '../auth/operation-authorizer.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceReadDb } from './db.js';
import { readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import { createWorkspaceBackup, WORKSPACE_BACKUP_POLICY } from './workspace-backup.js';
import { withVerifiedWorkspaceSnapshotSource } from './workspace-backup-bundle.js';
import { inspectCapture, type WorkspaceCaptureRecord } from './workspace-capture-protection.js';

const probe = vi.hoisted(() => ({
  facts: undefined as undefined | { canonical: string; captureId: string; gate: SharedArrayBuffer },
  events: [] as Record<string, unknown>[],
  onPhase: undefined as undefined | ((phase: string) => Promise<void>),
  errors: [] as string[],
  mainPhase: 'setup',
  workerOrdinal: 0,
  sourceHashes: new Set<string>(),
}));

// This wraps actual Workers, not their producer, SQL, replies or physical owners.
// Test observations are consumed here and never reach a product protocol parser.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const selected = probe.facts;
        if (!selected) {
          super(filename, options);
          return;
        }
        const role = String(filename).includes('workspace-backup-worker') ? 'capture' : 'native';
        const workerOrdinal = ++probe.workerOrdinal;
        const prelude = String.raw`
          const threads = require('node:worker_threads');
          const facts = threads.workerData.__q06;
          delete threads.workerData.__q06;
          const fs = require('node:fs');
          const crypto = require('node:crypto');
          const Driver = require(facts.sqliteModule);
          const gate = new Int32Array(facts.gate);
          const post = threads.parentPort.postMessage.bind(threads.parentPort);
          let phase = 'startup';
          const connections = new WeakMap();
          const pending = new WeakMap();
          let nextConnection = 0;
          function observe(kind, fields = {}) {
            post({__q06: true, kind, role: facts.role, workerOrdinal: facts.workerOrdinal,
              threadId: threads.threadId, isMainThread: threads.isMainThread, phase,
              order: Atomics.add(gate, 0, 1), hold: Atomics.load(gate, 1), ...fields});
          }
          threads.parentPort.postMessage = function(message, ...args) {
            if (typeof message?.phase === 'string') phase = message.phase;
            return post(message, ...args);
          };
          const pragma = Driver.prototype.pragma;
          const prepare = Driver.prototype.prepare;
          const close = Driver.prototype.close;
          const execute = Driver.prototype.exec;
          function identity(db) {
            if (db.name !== facts.canonical || !db.open) return;
            const stat = fs.statSync(db.name);
            if (!connections.has(db)) connections.set(db, ++nextConnection);
            return {path: db.name, inode: stat.dev + ':' + stat.ino,
              connection: connections.get(db), readonly: db.readonly};
          }
          function policy(db) {
            return {queryOnly: pragma.call(db, 'query_only', {simple: true}),
              synchronous: pragma.call(db, 'synchronous', {simple: true}),
              busyTimeout: pragma.call(db, 'busy_timeout', {simple: true}),
              inTransaction: db.inTransaction};
          }
          function committed(db) {
            const selected = identity(db);
            if (!selected) return;
            observe('commit', {...selected, ...policy(db), captureDecision: pending.get(db)});
            pending.delete(db);
          }
          // The real driver completes each native open by installing this exact
          // cppdb Symbol and its getters. Observing that completion also covers
          // cached ESM constructor references without replacing their exports.
          const cppdb = require(require('node:path').join(require('node:path').dirname(facts.sqliteModule), 'util')).cppdb;
          const defineProperties = Object.defineProperties;
          let observedConstructors = 0;
          Object.defineProperties = function(db, descriptors) {
            const result = defineProperties(db, descriptors);
            if (Object.prototype.hasOwnProperty.call(descriptors, cppdb)) {
              observedConstructors += 1;
              const selected = identity(db);
              if (selected) observe('constructor', {...selected, ...policy(db),
                origin: new Error().stack.split('\n').slice(1, 7)});
            }
            return result;
          };
          const calibration = new Driver(':memory:');
          const prototype = Object.getPrototypeOf(prepare.call(calibration, 'SELECT 1'));
          const run = prototype.run;
          prototype.run = function(...values) {
            const db = this.database;
            const selected = identity(db);
            const sql = this.source;
            const insertion = /INSERT\s+INTO\s+workspace_capture_records/i.test(sql);
            const completion = /UPDATE\s+workspace_capture_records\s+SET\s+state/i.test(sql);
            const selectedCapture = selected && ((insertion && values[0] === facts.captureId) ||
              (completion && values[2] === facts.captureId));
            let result;
            try { result = run.apply(this, values); }
            catch (error) {
              if (selectedCapture) observe('capture-sql-error', {...selected, code: error.code});
              throw error;
            }
            if (selectedCapture) {
              const decision = insertion ? 'pin' : values[0];
              observe('capture-sql', {...selected, ...policy(db), decision, sql,
                captureId: facts.captureId, workspaceId: insertion ? values[1] : values[3],
                changes: result.changes});
              pending.set(db, decision);
            } else if (selected && /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql)) {
              observe('native-dml', {...selected, ...policy(db),
                sqlSha256: crypto.createHash('sha256').update(sql).digest('hex'), changes: result.changes});
            }
            if (/^\s*COMMIT\s*;?\s*$/i.test(sql)) committed(db);
            return result;
          };
          Driver.prototype.exec = function(sql) {
            const result = execute.call(this, sql);
            if (/^\s*COMMIT\s*;?\s*$/i.test(sql)) committed(this);
            return result;
          };
          Driver.prototype.close = function(...args) {
            const selected = identity(this);
            const before = selected && {...selected, ...policy(this)};
            const result = close.apply(this, args);
            if (before) observe('close', {...before, openAfter: this.open});
            return result;
          };
          const integrity = pragma.call(calibration, 'integrity_check', {simple: true});
          calibration.close();
          observe('calibration', {integrity, constructorObserved: observedConstructors > 0});
        `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        const constructedSource = `${prelude}\n${entry}`;
        const modulePath = createRequire(import.meta.url).resolve('better-sqlite3');
        super(constructedSource, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            __q06: { ...selected, role, workerOrdinal, sqliteModule: modulePath },
          },
        });
        const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
        const originalBytes = options?.eval
          ? Buffer.from(String(filename))
          : readFileSync(
              String(filename).startsWith('file:') ? fileURLToPath(filename) : String(filename)
            );
        const sourceSha256 = sha(originalBytes);
        const provenance = {
          kind: 'worker-construction',
          role,
          workerOrdinal,
          entry: String(filename),
          sourceSha256,
          sourceBytes: originalBytes.length,
          constructedSha256: sha(constructedSource),
          constructedSource,
          threadId: this.threadId,
          canonical: selected.canonical,
          captureId: selected.captureId,
          sqliteModule: modulePath,
        };
        probe.events.push(provenance);
        console.log('Q06_CONSTRUCTION ' + JSON.stringify(provenance));
        if (!probe.sourceHashes.has(sourceSha256)) {
          probe.sourceHashes.add(sourceSha256);
          console.log(
            'Q06_SOURCE ' +
              JSON.stringify({
                sourceSha256,
                gzipBase64: gzipSync(originalBytes).toString('base64'),
              })
          );
        }
        const post = this.postMessage.bind(this);
        this.postMessage = (message, ...args) => {
          if (message?.operation && 'id' in message)
            record('native-post', {
              role,
              workerOrdinal,
              id: message.id,
              operation: message.operation,
              database: message.database,
            });
          return post(message, ...args);
        };
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const message = args[0];
        if (event === 'message' && message !== null && typeof message === 'object') {
          const value = message as Record<string, unknown>;
          if (value.__q06) {
            probe.events.push(value);
            return true;
          }
          if (typeof value.phase === 'string') {
            probe.mainPhase = value.phase;
            record('phase-request', { phase: value.phase });
            const boundary = probe.onPhase?.(value.phase);
            if (boundary) {
              void boundary.then(
                () => super.emit(event, ...args),
                (error: unknown) => {
                  probe.errors.push(String(error));
                  super.emit(event, ...args);
                }
              );
              return true;
            }
          }
          if (value.status === 'ok' || value.status === 'error')
            record('native-reply', {
              id: value.id,
              operation: value.operation,
              status: value.status,
            });
        }
        return super.emit(event, ...args);
      }
    },
  };
});

/** One shared counter orders observed owner boundaries without elapsed-time assumptions. */
function record(kind: string, fields: Record<string, unknown> = {}) {
  const facts = probe.facts;
  if (!facts) throw new Error('Q06 observation is not installed.');
  const gate = new Int32Array(facts.gate);
  const event = {
    kind,
    role: 'main',
    order: Atomics.add(gate, 0, 1),
    hold: Atomics.load(gate, 1),
    ...fields,
  };
  probe.events.push(event);
  return Number(event.order);
}

/** Existing-only observation; no fixture record or acknowledgement is authored by SQL. */
function retainedRows(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries(
      [
        'control_workspaces',
        'control_threads',
        'control_turns',
        'control_product_entries',
        'idempotency_requests',
        'audit_events',
        'pending_requests',
        'workspace_capture_records',
      ].map((table) => [
        table,
        db
          .prepare(`SELECT * FROM "${table}"`)
          .all()
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ])
    );
  } finally {
    db.close();
  }
}

const roots: string[] = [];
const handles: { sqlite: Database.Database }[] = [];
afterEach(async () => {
  probe.onPhase = undefined;
  for (const handle of handles.splice(0)) if (handle.sqlite.open) handle.sqlite.close();
  await shutdownControlStoreWorkerClient();
  probe.facts = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Uses the shared native Demo owner and real Store operations, as the live snapshot fixtures do. */
async function fixture(interruptFinish: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'q06-capture-owner-'));
  roots.push(root);
  const dataRoot = join(root, 'source');
  const backupId = allocateEntityId('wsbak');
  const gate = new Int32Array(new SharedArrayBuffer(8));
  probe.events = [];
  probe.errors = [];
  probe.mainPhase = 'setup';
  probe.facts = {
    canonical: workspaceDbPath(dataRoot, DEMO_WORKSPACE_ID),
    captureId: backupId,
    gate: gate.buffer as SharedArrayBuffer,
  };
  const store = await createDemoStore({ dataRoot, knowledge: [] });
  const core = openCoreDb(dataRoot);
  handles.push(core);
  const ownerId = ensureLocalUser(core);
  recordWorkspaceOwnerMembership({
    coreDb: core,
    workspaceId: DEMO_WORKSPACE_ID,
    ownerUserId: ownerId,
  });
  const actor = { kind: 'local' as const, userId: ownerId };
  const historyThread = await store.createThread(DEMO_WORKSPACE_ID, 'Q06 retained history');
  const historyTurn = await store.createTurn(
    DEMO_WORKSPACE_ID,
    historyThread.id,
    'Original captured input',
    { kind: 'user', id: ownerId }
  );
  await store.completeTurn(historyTurn.id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
  });
  const sibling = await store.createWorkspace('Q06 sibling');
  const mutationAdmission = new WorkspaceMutationAdmission();
  const stagingParent = join(root, 'staging');
  mkdirSync(stagingParent);
  const policy = {
    ...WORKSPACE_BACKUP_POLICY,
    stagingParent,
    admission: new FileStorageAdmission(root, () => 0n),
    expectedRelease: { version: '0.1.0-q06-oracle', buildId: 'independent-capture-owner' },
  };
  const fault = new Error('Q06 original finish-authority interruption');
  let authorityChecks = 0;
  const input = {
    ...policy,
    workspaceId: DEMO_WORKSPACE_ID,
    backupId,
    purpose: 'backup' as const,
    expectedSourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
    bundleRoot: join(dataRoot, 'server/backups/workspaces', DEMO_WORKSPACE_ID, backupId),
    source: {
      kind: 'live-workspace' as const,
      dataRoot,
      coreDb: core,
      store,
      mutationAdmission,
      actor,
      currentAuthority: () => {
        authorityChecks += 1;
        requireAdministratorOperation(core, actor, 'api.call');
        if (interruptFinish && probe.mainPhase === 'finish') throw fault;
      },
    },
  };
  const client = getControlStoreWorkerClient(mutationAdmission);
  const pause = client.tryPauseForWorkspaceCapture.bind(client);
  const canonical = workspaceDbPath(dataRoot, DEMO_WORKSPACE_ID);
  const database = `workspace:${canonical}`;
  vi.spyOn(client, 'tryPauseForWorkspaceCapture').mockImplementation((...args) => {
    const held = pause(...args);
    if (!held || args[0] !== database) return held;
    return held.then((resume) => {
      Atomics.store(gate, 1, 1);
      record('actual-native-hold-acquired', { database });
      return () => {
        resume();
        Atomics.store(gate, 1, 0);
        record('actual-native-hold-released', { database });
      };
    });
  });
  const stat = statSync(canonical);
  return {
    root,
    dataRoot,
    backupId,
    gate,
    store,
    core,
    sibling,
    mutationAdmission,
    historyThread,
    historyTurn,
    input,
    policy,
    fault,
    canonical,
    database,
    inode: `${stat.dev}:${stat.ino}`,
    authorityChecks: () => authorityChecks,
  };
}

/** Reads only the current exact capture, through its existing typed readonly owner. */
function selectedCapture(dataRoot: string, captureId: string) {
  const reader = openWorkspaceReadDb(dataRoot, DEMO_WORKSPACE_ID);
  try {
    return inspectCapture(reader, DEMO_WORKSPACE_ID, captureId);
  } finally {
    reader.sqlite.close();
  }
}

describe('Q06 live capture finishing-write ownership', () => {
  it.each([false, true])(
    'Q06 genuine live capture preserves original completion/interruption (interrupt=%s)',
    async (interrupt) => {
      expect(isMainThread).toBe(true);
      const f = await fixture(interrupt);
      const before = retainedRows(f.canonical);
      let active: WorkspaceCaptureRecord | null = null;
      let siblingThreadId: string | undefined;
      let postCutThreadId: string | undefined;
      let progressStart = -1;
      let progressEnd = -1;
      let postPublicationRows: ReturnType<typeof retainedRows> | undefined;
      let positiveCut = false;
      let completed = false;
      let retainedVerified = false;
      probe.onPhase = async (phase) => {
        if (phase === 'pin-end') {
          expect(Atomics.load(f.gate, 1)).toBe(1);
          expect(f.mutationAdmission.isClosed(DEMO_WORKSPACE_ID)).toBe(true);
          active = selectedCapture(f.dataRoot, f.backupId);
          expect(active).toMatchObject({
            captureId: f.backupId,
            workspaceId: DEMO_WORKSPACE_ID,
            state: 'active',
            origin: 'manual',
            endedAt: null,
          });
          siblingThreadId = (
            await f.store.createThread(f.sibling.id, 'Q06 sibling during held pin')
          ).id;
        }
        if (phase === 'post-cut-validation') {
          expect(Atomics.load(f.gate, 1)).toBe(0);
          expect(f.mutationAdmission.isClosed(DEMO_WORKSPACE_ID)).toBe(false);
          progressStart = record('post-cut-publication-start');
          postCutThreadId = (
            await f.store.createThread(DEMO_WORKSPACE_ID, 'Q06 native publication after cut')
          ).id;
          progressEnd = record('post-cut-publication-acknowledged', { threadId: postCutThreadId });
          // Thread creation legitimately touches its parent in the same native
          // tuple. Freeze this exact ACKed row cut before capture can continue.
          postPublicationRows = retainedRows(f.canonical);
          record('post-cut-preservation-baseline', {
            sha256: createHash('sha256').update(JSON.stringify(postPublicationRows)).digest('hex'),
          });
          positiveCut = true;
        }
      };
      try {
        const outcome = await createWorkspaceBackup(f.input).then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        );
        expect(probe.errors).toEqual([]);
        expect(positiveCut).toBe(true);
        expect(f.authorityChecks()).toBeGreaterThan(0);
        expect(active).not.toBeNull();
        const activeRecord = active as WorkspaceCaptureRecord | null;
        if (!activeRecord) throw new Error('The actual active capture was not observed.');
        const after = selectedCapture(f.dataRoot, f.backupId);
        if (interrupt) {
          expect(outcome).toEqual({ error: f.fault });
          expect(after).toEqual(active);
          expect(existsSync(join(f.input.bundleRoot, 'seal.json'))).toBe(false);
        } else {
          if (!('value' in outcome)) throw outcome.error;
          expect(outcome.value).toMatchObject({ purpose: 'backup', disposition: 'sealed' });
          expect(after).toEqual({
            ...activeRecord,
            state: 'finished',
            endedAt: expect.any(String),
          });
          expect(Date.parse(after!.endedAt!)).toBeGreaterThanOrEqual(Date.parse(after!.createdAt));
          await withVerifiedWorkspaceSnapshotSource(
            {
              ...f.policy,
              dataRoot: f.dataRoot,
              source: {
                kind: 'local-snapshot',
                workspaceId: DEMO_WORKSPACE_ID,
                backupId: f.backupId,
              },
            },
            async (bundle) => {
              const parts: Buffer[] = [];
              for await (const part of bundle.readFile('db/workspace.sqlite'))
                parts.push(Buffer.from(part));
              const copy = join(f.root, 'verified-captured.sqlite');
              writeFileSync(copy, Buffer.concat(parts));
              const captured = retainedRows(copy);
              for (const table of [
                'control_workspaces',
                'control_threads',
                'control_turns',
                'control_product_entries',
                'idempotency_requests',
                'audit_events',
                'pending_requests',
              ])
                expect(captured[table]).toEqual(before[table]);
              expect(captured.workspace_capture_records).toHaveLength(1);
              expect(
                captured.control_threads!.some(
                  (row) => (row as { id: string }).id === postCutThreadId
                )
              ).toBe(false);
              expect(
                captured.control_turns!.some(
                  (row) => (row as { id: string }).id === f.historyTurn.id
                )
              ).toBe(true);
            }
          );
        }
        completed = true;
        const live = retainedRows(f.canonical);
        const publicationBaseline = postPublicationRows as
          | ReturnType<typeof retainedRows>
          | undefined;
        if (!publicationBaseline)
          throw new Error('The exact ACKed publication cut was not observed.');
        expect(
          live.control_threads!.filter((row) => (row as { id: string }).id !== postCutThreadId)
        ).toEqual(before.control_threads);
        expect(live.control_threads).toEqual(publicationBaseline.control_threads);
        expect(live.workspace_capture_records).toEqual(
          publicationBaseline.workspace_capture_records!.map((row) => {
            const record = row as Record<string, unknown>;
            return record.capture_id === f.backupId
              ? { ...record, state: after!.state, ended_at: after!.endedAt }
              : record;
          })
        );
        for (const table of [
          'control_workspaces',
          'control_turns',
          'control_product_entries',
          'idempotency_requests',
          'audit_events',
          'pending_requests',
        ]) {
          expect(live[table]).toEqual(publicationBaseline[table]);
          if (table !== 'control_workspaces')
            expect(publicationBaseline[table]).toEqual(before[table]);
        }
        expect(
          live.control_threads!.some((row) => (row as { id: string }).id === postCutThreadId)
        ).toBe(true);
        expect(
          retainedRows(workspaceDbPath(f.dataRoot, f.sibling.id)).control_threads!.some(
            (row) => (row as { id: string }).id === siblingThreadId
          )
        ).toBe(true);
        retainedVerified = true;
        const sameTarget = probe.events.filter(
          (event) => event.path === f.canonical && event.inode === f.inode
        );
        const progress = probe.events.filter(
          (event) => Number(event.order) > progressStart && Number(event.order) < progressEnd
        );
        expect(
          sameTarget.some(
            (event) =>
              event.role === 'native' && event.kind === 'constructor' && event.readonly === false
          )
        ).toBe(true);
        expect(
          progress.some(
            (event) =>
              event.role === 'native' &&
              event.kind === 'native-dml' &&
              event.path === f.canonical &&
              event.inode === f.inode &&
              event.hold === 0
          )
        ).toBe(true);
        expect(
          progress.some(
            (event) =>
              event.role === 'native' &&
              event.kind === 'commit' &&
              event.path === f.canonical &&
              event.synchronous === 2 &&
              event.inTransaction === false
          )
        ).toBe(true);
        const posts = progress.filter(
          (event) => event.kind === 'native-post' && event.database === f.database
        );
        expect(posts.length).toBeGreaterThan(0);
        expect(
          posts.every((post) =>
            progress.some(
              (event) =>
                event.kind === 'native-reply' && event.id === post.id && event.status === 'ok'
            )
          )
        ).toBe(true);
        expect(
          probe.events.some(
            (event) => event.kind === 'worker-construction' && event.role === 'capture'
          )
        ).toBe(true);
        expect(
          probe.events.some(
            (event) =>
              event.kind === 'calibration' &&
              event.role === 'capture' &&
              event.integrity === 'ok' &&
              event.constructorObserved === true &&
              event.isMainThread === false
          )
        ).toBe(true);
        // Pin insertion is separate from the post-cut decision. A posting pause is
        // not by itself proof of one physical owner, including the later close.
        const pin = sameTarget.filter(
          (event) => event.kind === 'capture-sql' && event.decision === 'pin'
        );
        expect(pin.length).toBeGreaterThan(0);
        expect(pin.every((event) => event.hold === 1 && event.changes === 1)).toBe(true);
        const decisions = sameTarget.filter(
          (event) =>
            event.kind === 'capture-sql' && event.decision === 'finished' && event.changes === 1
        );
        if (interrupt) expect(decisions).toEqual([]);
        else {
          // The original first-terminal effect must exist even if NEW removes all
          // capture Worker source inspection and performs it on the native owner.
          expect(decisions.length).toBeGreaterThan(0);
          expect(
            decisions.every((decision) =>
              sameTarget.some(
                (event) =>
                  event.kind === 'commit' &&
                  event.workerOrdinal === decision.workerOrdinal &&
                  event.connection === decision.connection &&
                  event.captureDecision === 'finished' &&
                  Number(event.order) > Number(decision.order) &&
                  event.synchronous === 2 &&
                  event.inTransaction === false
              )
            )
          ).toBe(true);
        }
      } finally {
        probe.onPhase = undefined;
        if (f.core.sqlite.open) f.core.sqlite.close();
        await shutdownControlStoreWorkerClient();
        console.log(
          'Q06_ORACLE ' +
            JSON.stringify({
              interrupt,
              canonical: f.canonical,
              inode: f.inode,
              captureId: f.backupId,
              completed,
              retainedVerified,
              positiveCut,
              authorityChecks: f.authorityChecks(),
              active,
              siblingThreadId,
              postCutThreadId,
              progressStart,
              progressEnd,
              errors: probe.errors,
              events: probe.events.filter((event) => event.kind !== 'worker-construction'),
            })
        );
      }
      expect(
        probe.events.some(
          (event) =>
            event.kind === 'native-reply' && event.operation === 'shutdown' && event.status === 'ok'
        )
      ).toBe(true);
      if (!interrupt) {
        // Core Storage SQLite Layers: one off-Main physical writer. The actual
        // finishing UPDATE cannot come from a second canonical capture Worker.
        expect(
          probe.events.filter(
            (event) =>
              event.role === 'capture' &&
              event.kind === 'capture-sql' &&
              event.decision === 'finished' &&
              event.path === f.canonical
          ),
          'Q06 canonical finishing UPDATE must belong to the existing native physical writer, not the post-cut capture Worker'
        ).toEqual([]);
        expect(
          probe.events.filter(
            (event) =>
              event.role === 'capture' &&
              event.kind === 'constructor' &&
              event.phase === 'finish' &&
              event.path === f.canonical &&
              event.readonly === false
          )
        ).toEqual([]);
      }
    },
    120_000
  );
});
