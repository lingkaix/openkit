import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { ARTIFACT_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { deriveEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { importArtifactFile } from '../artifact-file-commands.js';
import { isWorkspaceOperationAuthorized } from '../auth/operation-authorizer.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { commandRequestKey, FsStore } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { createApp, createAppWithLocalIdentity } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { artifactFilePayloadPath } from './artifacts/file-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

// Draft: genuine SQLite and control Worker execution; no product/receipt result doubles.
const faults = vi.hoisted(() => ({
  readonlyMain: false,
  workers: [] as NativeWorker[],
  posts: [] as unknown[],
  gate: new SharedArrayBuffer(7 * Int32Array.BYTES_PER_ELEMENT),
  request: new SharedArrayBuffer(524_288),
  holdFailure: false,
  heldFailure: undefined as unknown,
  releaseFailure: undefined as (() => void) | undefined,
  referenceGate: new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT),
  referenceTurn: new SharedArrayBuffer(64),
}));

vi.mock('./db.js', async (load) => {
  const actual = await load<typeof import('./db.js')>();
  const observe = <T extends ReturnType<typeof actual.openWorkspaceDb>>(db: T): T => {
    if (faults.readonlyMain) db.sqlite.pragma('query_only = ON');
    const prepare = db.sqlite.prepare.bind(db.sqlite);
    db.sqlite.prepare = ((sql: string) => {
      const statement = prepare(sql);
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        try {
          return run(...args);
        } catch (error) {
          const code = (error as { code?: string }).code;
          const message = (error as { message?: string }).message;
          const requestId = Buffer.from(faults.request)
            .subarray(0, Atomics.load(new Int32Array(faults.gate), 6))
            .toString('ascii');
          const record = /^\s*INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+idempotency_requests/i.test(sql);
          const maintenance = /^\s*DELETE\s+FROM\s+idempotency_requests/i.test(sql);
          const gate = new Int32Array(faults.gate);
          if (record && args.includes(requestId)) {
            if (code?.startsWith('SQLITE_CONSTRAINT') && message === 'Artifact receipt constraint')
              Atomics.or(gate, 3, 1);
            if (code === 'SQLITE_ERROR' && message === 'malformed JSON') Atomics.or(gate, 3, 2);
          }
          if (
            maintenance &&
            code?.startsWith('SQLITE_CONSTRAINT') &&
            message === 'Artifact prune constraint' &&
            prepare('SELECT 1 FROM idempotency_requests WHERE request_id=?').get(requestId)
          )
            Atomics.or(gate, 3, 4);
          if (code?.startsWith('SQLITE_READONLY'))
            console.info('Original Main Artifact receipt SQLite refused', {
              scope: db.scope,
              sqlOperation: /^\s*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase(),
              code,
            });
          throw error;
        }
      };
      return statement;
    }) as typeof db.sqlite.prepare;
    return db;
  };
  return {
    ...actual,
    openWorkspaceDb: (...args: Parameters<typeof actual.openWorkspaceDb>) =>
      observe(actual.openWorkspaceDb(...args)),
  };
});

vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      private readonly importReceiptIds = new Set<number>();
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const index = faults.workers.length;
        const prelude = `
        const { workerData } = require('node:worker_threads');
        const Database = require(workerData.receiptModule);
        const prepare = Database.prototype.prepare;
        const exec = Database.prototype.exec;
        const maintenance = new WeakSet();
        const gate = workerData.receiptGate;
        const referenceGate = workerData.referenceGate;
        const referenceTurn = () => Buffer.from(workerData.referenceTurn).subarray(0, Atomics.load(referenceGate, 3)).toString('ascii');
        const requestId = () => Buffer.from(workerData.receiptRequest).subarray(0, Atomics.load(gate, 6)).toString('ascii');
        const retained = (db) => prepare.call(db, "SELECT 1 FROM idempotency_requests WHERE request_id=? AND command_name IN ('artifact.import','artifact.version-commit','artifact.version-file-commit','artifact.introduce')").get(requestId());
        Database.prototype.prepare = function(sql) {
          const statement = prepare.call(this, sql);
          const deletion = /^DELETE\\s+FROM\\s+idempotency_requests/i.test(sql.trim());
          if (deletion || /^INSERT(?:\\s+OR\\s+REPLACE)?\\s+INTO\\s+idempotency_requests/i.test(sql.trim())) {
            const db = this, run = statement.run;
            statement.run = function(...args) {
              try {
                const value = run.apply(this, args);
                if (deletion && retained(db)) maintenance.add(db);
                return value;
              } catch (error) {
                if (!deletion && args.includes(requestId())) {
                  if (error.code?.startsWith('SQLITE_CONSTRAINT') && error.message === 'Artifact receipt constraint') Atomics.or(gate, 3, 1);
                  if (error.code === 'SQLITE_ERROR' && error.message === 'malformed JSON') Atomics.or(gate, 3, 2);
                }
                if (deletion && retained(db) && error.code?.startsWith('SQLITE_CONSTRAINT') && error.message === 'Artifact prune constraint') Atomics.or(gate, 3, 4);
                throw error;
              }
            };
          }
          return statement;
        };
        Database.prototype.exec = function(sql) {
          if (/^COMMIT$/i.test(sql) && Atomics.load(referenceGate, 0) && prepare.call(this, "SELECT 1 FROM sqlite_master WHERE name='control_turns'").get() && prepare.call(this, 'SELECT 1 FROM control_turns WHERE id=?').get(referenceTurn())) {
            Atomics.store(referenceGate, 1, 1);
            Atomics.notify(referenceGate, 1);
            Atomics.wait(referenceGate, 2, 0);
          }
          const value = exec.call(this, sql);
          if (!/^COMMIT$/i.test(sql) || !Atomics.load(gate, 1)) return value;
          if (!prepare.call(this, "SELECT 1 FROM sqlite_master WHERE name='idempotency_requests'").get()) return value;
          if (!retained(this)) return value;
          const stage = maintenance.has(this) ? 2 : 1;
          if (stage !== Atomics.load(gate, 1)) return value;
          Atomics.store(gate, 4, prepare.call(this, 'PRAGMA synchronous').get().synchronous);
          Atomics.store(gate, 5, workerData.receiptWorker);
          Atomics.store(gate, 0, 1);
          Atomics.notify(gate, 0);
          Atomics.wait(gate, 2, 0);
          return value;
        };
      `;
        super(
          prelude +
            (options?.eval ? String(filename) : `import(${JSON.stringify(String(filename))});`),
          {
            ...options,
            eval: true,
            workerData: {
              ...options?.workerData,
              receiptModule: require.resolve('better-sqlite3'),
              receiptGate: new Int32Array(faults.gate),
              receiptRequest: new Uint8Array(faults.request),
              receiptWorker: index,
              referenceGate: new Int32Array(faults.referenceGate),
              referenceTurn: new Uint8Array(faults.referenceTurn),
            },
          }
        );
        faults.workers.push(this);
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        const message = args[0] as {
          operation?: string;
          id?: number;
          content?: ArrayBuffer;
        };
        if (
          faults.holdFailure &&
          message.operation === 'workspace-command-receipt' &&
          typeof message.id === 'number' &&
          message.content instanceof ArrayBuffer
        ) {
          const input = JSON.parse(new TextDecoder().decode(message.content));
          const requestId = Buffer.from(faults.request)
            .subarray(0, Atomics.load(new Int32Array(faults.gate), 6))
            .toString('ascii');
          if (input.receipt?.command === 'artifact.import' && input.receipt.requestId === requestId)
            this.importReceiptIds.add(message.id);
        }
        faults.posts.push(args[0]);
        return super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const message = args[0] as
          | {
              id?: number;
              status?: string;
              code?: string;
              commit?: string;
            }
          | undefined;
        if (
          event === 'message' &&
          faults.holdFailure &&
          typeof message?.id === 'number' &&
          this.importReceiptIds.has(message.id) &&
          message.status === 'error' &&
          message.code === 'constraint' &&
          message.commit === 'not-committed'
        ) {
          this.importReceiptIds.delete(message.id);
          faults.heldFailure = message;
          faults.releaseFailure = () => {
            faults.releaseFailure = undefined;
            super.emit(event, ...args);
          };
          return true;
        }
        return super.emit(event, ...args);
      }
    },
  };
});

type Kind = 'import' | 'version-commit' | 'version-file-commit' | 'introduce';
const kinds = ['import', 'version-commit', 'version-file-commit', 'introduce'] as const;
const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const release = () => {
  const gate = new Int32Array(faults.gate);
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
  faults.holdFailure = false;
  faults.releaseFailure?.();
  const referenceGate = new Int32Array(faults.referenceGate);
  Atomics.store(referenceGate, 0, 0);
  Atomics.store(referenceGate, 2, 1);
  Atomics.notify(referenceGate, 2);
};

async function fixture(kind: Kind, identity = `artifact-proof-${randomUUID()}`) {
  release();
  faults.readonlyMain = false;
  faults.workers.length = 0;
  faults.posts.length = 0;
  new Int32Array(faults.gate).fill(0);
  new Int32Array(faults.referenceGate).fill(0);
  faults.heldFailure = undefined;
  const dataRoot = mkdtempSync(join(tmpdir(), 'artifact-receipt-family-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  let store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Artifact receipt owner');
  const thread = await store.createThread(workspace.id, 'Artifact receiving Thread');
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId: workspace.id });
  let db = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(db);
  let app = createApp({ coreDb, dataRoot, store });
  onTestFinished(async () => {
    release();
    faults.readonlyMain = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
    await shutdownControlStoreWorkerClient();
    if (db.sqlite.open) db.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const original = Buffer.from([0, 255, 128, 13, 10]);
  const next = Buffer.from([255, 0, 128, 10, 13, 0]);
  const binary = (
    operation: string,
    requestId: string,
    bytes: Buffer,
    fields: Record<string, string>
  ) =>
    app.request(
      `/api/app/operations/${operation}?${new URLSearchParams({ workspaceId: workspace.id, ...fields })}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-openkit-request-id': requestId },
        body: bytes,
      }
    );
  const seedRequestId = randomUUID();
  const seedResponse = await binary('artifact.import', seedRequestId, original, {
    title: 'Original',
    mediaType: 'application/octet-stream',
    byteLength: String(original.length),
    contentDigest: hash(original),
  });
  expect(seedResponse.status).toBe(201);
  const { artifactId } = (await seedResponse.json()) as { artifactId: string };
  const requestId = identity,
    command = `artifact.${kind}`;
  new Uint8Array(faults.request).set(Buffer.from(requestId));
  Atomics.store(new Int32Array(faults.gate), 6, Buffer.byteLength(requestId));
  const scope =
    kind === 'import'
      ? { actorId: userId, workspaceId: workspace.id }
      : kind === 'introduce'
        ? { workspaceId: workspace.id, threadId: thread.id }
        : { actorId: userId, workspaceId: workspace.id, threadId: thread.id, artifactId };
  const call = () => {
    if (kind === 'import')
      return binary(command, requestId, next, {
        title: 'New import',
        mediaType: 'application/octet-stream',
        byteLength: String(next.length),
        contentDigest: hash(next),
      });
    if (kind === 'version-file-commit')
      return binary(command, requestId, next, {
        threadId: thread.id,
        artifactId,
        expectedArtifactVersion: '1',
        title: 'Next',
        summary: 'null',
        mediaType: 'application/octet-stream',
        byteLength: String(next.length),
        contentDigest: hash(next),
      });
    return app.request(`/api/app/operations/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
      body: JSON.stringify({
        workspaceId: workspace.id,
        threadId: thread.id,
        artifactId,
        expectedArtifactVersion: 1,
        requestId,
        ...(kind === 'version-commit'
          ? {
              title: 'Next',
              summary: null,
              content: { format: 'text', body: 'Exact next inline body.' },
            }
          : {}),
      }),
    });
  };
  const receipt = () =>
    db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=? AND command_name=?')
      .all(requestId, command);
  const retained = () => ({
    artifacts: store.listArtifacts(workspace.id).sort((a, b) => a.id.localeCompare(b.id)),
    versions: store.listArtifactVersions(workspace.id, artifactId),
    turns: store.listThreadTurns(workspace.id, thread.id),
    original: readFileSync(
      artifactFilePayloadPath(join(dataRoot, 'workspaces', workspace.id), artifactId, 1)
    ),
    payloads: store
      .listArtifacts(workspace.id)
      .sort((a, b) => a.id.localeCompare(b.id))
      .flatMap((artifact) =>
        Array.from({ length: artifact.version }, (_, index) => ({
          artifactId: artifact.id,
          version: index + 1,
          bytes: readFileSync(
            artifactFilePayloadPath(
              join(dataRoot, 'workspaces', workspace.id),
              artifact.id,
              index + 1
            )
          ),
        }))
      ),
    receipt: receipt(),
  });
  const cold = async () => {
    await shutdownControlStoreWorkerClient();
    db.sqlite.close();
    db = openWorkspaceDb(dataRoot, workspace.id);
    store = new FsStore({ dataRoot });
    // The initial fixture already installed native environment/authority. Do not redo setup under query_only.
    app = createAppWithLocalIdentity({ coreDb, dataRoot, store });
  };
  const protect = () => {
    faults.readonlyMain = true;
    db.sqlite.pragma('query_only=ON');
    coreDb.sqlite.pragma('query_only=ON');
  };
  return {
    dataRoot,
    get db() {
      return db;
    },
    coreDb,
    userId,
    store: () => store,
    workspace,
    thread,
    original,
    next,
    artifactId,
    seedRequestId,
    requestId,
    command,
    scope,
    call,
    receipt,
    retained,
    cold,
    protect,
  };
}

it.each(kinds)(
  'preserves the original %s known receipt INSERT constraint prefix after reopen',
  async (kind) => {
    const f = await fixture(kind);
    const before = f.retained();
    f.db.sqlite.exec(
      `CREATE TRIGGER reject_artifact_receipt BEFORE INSERT ON idempotency_requests WHEN NEW.request_id='${f.requestId}' BEGIN SELECT RAISE(ABORT,'Artifact receipt constraint'); END`
    );
    expect((await f.call()).status).toBeGreaterThanOrEqual(400);
    expect(Atomics.load(new Int32Array(faults.gate), 3)).toBe(1);
    expect(f.receipt()).toEqual([]);
    if (kind === 'import') expect(f.retained()).toEqual(before);
    else {
      expect(f.retained().original).toEqual(f.original);
      if (kind === 'introduce') expect(f.retained().turns).toHaveLength(1);
      else expect(f.store().getArtifact(f.workspace.id, f.artifactId).version).toBe(2);
    }
    f.db.sqlite.exec('DROP TRIGGER reject_artifact_receipt');
    const completed = f.retained();
    await f.cold();
    expect(f.retained()).toEqual(completed);
    if (kind === 'import') expect((await f.call()).status).toBe(201);
    else {
      expect((await f.call()).status).toBe(409);
      expect(f.retained()).toEqual(completed);
    }
  }
);

it.each(kinds)(
  'preserves the original %s non-constraint missing receipt without recapture after reopen',
  async (kind) => {
    const f = await fixture(kind);
    f.db.sqlite.exec(
      `CREATE TRIGGER interrupt_artifact_receipt BEFORE INSERT ON idempotency_requests WHEN NEW.request_id='${f.requestId}' BEGIN SELECT json('not-json'); END`
    );
    expect((await f.call()).status).toBeGreaterThanOrEqual(400);
    expect(Atomics.load(new Int32Array(faults.gate), 3)).toBe(2);
    expect(f.receipt()).toEqual([]);
    expect(f.retained().original).toEqual(f.original);
    expect(f.retained().artifacts).toHaveLength(kind === 'import' ? 2 : 1);
    if (kind === 'introduce') expect(f.retained().turns).toHaveLength(1);
    else if (kind !== 'import')
      expect(f.store().getArtifact(f.workspace.id, f.artifactId).version).toBe(2);
    f.db.sqlite.exec('DROP TRIGGER interrupt_artifact_receipt');
    const completed = f.retained();
    await f.cold();
    expect(f.retained()).toEqual(completed);
    expect((await f.call()).status).toBe(409);
    expect(f.retained()).toEqual(completed);
  }
);

it.each(kinds)(
  'preserves the original %s escaped request identity and tuple across cold replay',
  async (kind) => {
    const identity = `artifact-opaque-${'a"\\/|'.repeat(768)}`;
    const f = await fixture(kind, identity);
    expect((await f.call()).status).toBe(201);
    const rows = f.receipt();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      request_id: identity,
      request_key: commandRequestKey(f.command, identity, f.scope),
      scope_json: JSON.stringify(f.scope),
      response_kind: 'artifact',
    });
    const retained = f.retained();
    expect((await f.call()).status).toBe(201);
    expect(f.retained()).toEqual(retained);
    await f.cold();
    expect((await f.call()).status).toBe(201);
    expect(f.retained()).toEqual(retained);
  }
);

it.each(kinds)(
  'publishes %s receipt with Main query-only and exact original scope/response after reopen',
  async (kind) => {
    const f = await fixture(kind);
    f.protect();
    expect((await f.call()).status).toBe(201);
    const rows = f.receipt();
    expect(rows).toHaveLength(1);
    const expectedArtifactId =
      kind === 'import'
        ? f
            .store()
            .listArtifacts(f.workspace.id)
            .find((a) => a.lastMutationRequestId === f.requestId)!.id
        : f.artifactId;
    expect(rows[0]).toMatchObject({ response_id: expectedArtifactId });
    expect(rows[0]).toMatchObject({
      command_name: f.command,
      request_id: f.requestId,
      scope_json: JSON.stringify(f.scope),
      response_kind: 'artifact',
    });
    const retained = f.retained();
    const count = faults.posts.length;
    expect((await f.call()).status).toBe(201);
    expect(f.retained()).toEqual(retained);
    expect(faults.posts).toHaveLength(count);
    await f.cold();
    expect((await f.call()).status).toBe(201);
    expect(f.retained()).toEqual(retained);
  }
);

it('preserves an admitted original escaped Artifact identity beyond the structured receipt limit', async () => {
  const f = await fixture('import');
  const requestId = `artifact-escaped-${'\\"'.repeat(131_072)}`;
  const scope = { actorId: f.userId, workspaceId: f.workspace.id };
  const key = commandRequestKey('artifact.import', requestId, scope);
  expect(Buffer.byteLength(requestId)).toBeGreaterThanOrEqual(262_144);
  // These two mandatory original receipt fields alone exceed the structured frame.
  expect(Buffer.byteLength(JSON.stringify({ key, requestId }))).toBeGreaterThan(1_048_576);
  new Uint8Array(faults.request).set(Buffer.from(requestId));
  Atomics.store(new Int32Array(faults.gate), 6, Buffer.byteLength(requestId));
  const actor = { kind: 'local' as const, userId: f.userId };
  const metadata = {
    workspaceId: f.workspace.id,
    requestId,
    title: 'Exact large opaque identity',
    mediaType: 'application/octet-stream',
    byteLength: f.next.length,
    contentDigest: hash(f.next),
  };
  const inputHash = commandInputHash({
    title: metadata.title,
    mediaType: metadata.mediaType,
    contentDigest: metadata.contentDigest,
    byteLength: metadata.byteLength,
  });
  const admission = new FileStorageAdmission(f.dataRoot, () => 0n);
  const inflightCommands = new WeakMap();
  // Invoke the existing public command owner directly: this is not an HTTP-header
  // or physical-network capacity claim. Authority and storage remain genuine.
  const call = (source: Readable) =>
    importArtifactFile({
      store: f.store(),
      workspaceDb: f.db,
      inflightCommands,
      admission,
      metadata,
      context: {
        kind: 'public',
        actor,
        actorRef: { kind: 'user', id: f.userId },
        scope: { kind: 'workspace', workspaceId: f.workspace.id },
      },
      source,
      assertAuthorized: () => {
        if (
          !isWorkspaceOperationAuthorized(
            f.coreDb,
            actor,
            f.workspace.id,
            ARTIFACT_OPERATION_DEFINITIONS['artifact.import']
          )
        )
          throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
      },
    });
  const before = f.retained();
  const peer = f.db.sqlite
    .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
    .get(f.seedRequestId);
  const result = await call(Readable.from([f.next])).catch((error: unknown) => {
    expect(f.retained().original).toEqual(before.original);
    expect(f.store().getArtifact(f.workspace.id, f.artifactId)).toEqual(
      before.artifacts.find((artifact) => artifact.id === f.artifactId)
    );
    expect(f.retained().versions).toEqual(before.versions);
    expect(f.retained().turns).toEqual(before.turns);
    expect(
      f.db.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
        .get(f.seedRequestId)
    ).toEqual(peer);
    throw error;
  });
  const row = () =>
    f.db.sqlite.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').get(requestId);
  const retainedRow = row();
  expect(retainedRow).toMatchObject({
    request_key: key,
    command_name: 'artifact.import',
    request_id: requestId,
    scope_json: JSON.stringify(scope),
    input_hash: inputHash,
    response_kind: 'artifact',
    response_id: result.artifactId,
  });
  expect(
    f.db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .get(f.seedRequestId)
  ).toEqual(peer);
  expect(f.retained().original).toEqual(f.original);
  const retained = f.retained();
  expect(
    readFileSync(
      artifactFilePayloadPath(join(f.dataRoot, 'workspaces', f.workspace.id), result.artifactId, 1)
    )
  ).toEqual(f.next);
  await f.cold();
  expect(row()).toEqual(retainedRow);
  expect(f.retained()).toEqual(retained);
  let consumed = false;
  const retry = new Readable({
    read() {
      consumed = true;
      this.push(Buffer.from('changed retry'));
      this.push(null);
    },
  });
  expect(await call(retry)).toEqual(result);
  expect(consumed).toBe(false);
  expect(row()).toEqual(retainedRow);
  expect(f.retained()).toEqual(retained);
});

it.each(kinds.flatMap((kind) => ([1, 2] as const).map((stage) => ({ kind, stage }))))(
  'retains $kind receipt and original files across stage $stage FULL lost ACK',
  async ({ kind, stage }) => {
    const f = await fixture(kind);
    f.protect();
    const gate = new Int32Array(faults.gate);
    Atomics.store(gate, 1, stage);
    const pending = f.call();
    await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
    expect(Atomics.load(gate, 4)).toBe(2);
    const receipt = f.receipt();
    expect(receipt).toHaveLength(1);
    const retained = f.retained();
    const count = faults.posts.length;
    await faults.workers[Atomics.load(gate, 5)]!.terminate();
    release();
    expect((await pending).status).toBeGreaterThanOrEqual(400);
    expect(f.retained()).toEqual(retained);
    expect(faults.posts).toHaveLength(count);
    expect((await f.call()).status).toBe(201);
    expect(f.retained()).toEqual(retained);
    expect(faults.posts).toHaveLength(count);
    await f.cold();
    expect((await f.call()).status).toBe(201);
    expect(f.retained()).toEqual(retained);
  }
);

it.each(kinds)(
  'preserves the original %s receipt before a late prune fault after reopen',
  async (kind) => {
    const f = await fixture(kind);
    const peer = f.db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .get(f.seedRequestId) as { expires_at: string };
    const later = new Date(Date.parse(peer.expires_at) + 1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(later);
    // Explicit Workspace receipt lookup reads only: this DELETE occurs after the product and new receipt.
    f.db.sqlite.exec(
      `CREATE TRIGGER reject_artifact_prune BEFORE DELETE ON idempotency_requests WHEN OLD.request_id='${f.seedRequestId}' BEGIN SELECT RAISE(ABORT,'Artifact prune constraint'); END`
    );
    expect((await f.call()).status).toBeGreaterThanOrEqual(400);
    expect(Atomics.load(new Int32Array(faults.gate), 3)).toBe(4);
    expect(f.receipt()).toHaveLength(1);
    expect(
      f.db.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
        .get(f.seedRequestId)
    ).toEqual(peer);
    const retained = f.retained();
    f.db.sqlite.exec('DROP TRIGGER reject_artifact_prune');
    await f.cold();
    expect(f.retained()).toEqual(retained);
    expect((await f.call()).status).toBe(201);
    expect(f.retained()).toEqual(retained);
  }
);

it('samples original Artifact prune time after the actual synchronous imported-file publication', async () => {
  const f = await fixture('import');
  const peer = f.db.sqlite
    .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
    .get(f.seedRequestId) as { expires_at: string };
  const later = new Date(Date.parse(peer.expires_at) + 1);
  vi.useFakeTimers({ toFake: ['Date'] });
  const original = f.store().createArtifact.bind(f.store());
  const published = vi.spyOn(f.store(), 'createArtifact').mockImplementation((...args) => {
    const artifact = original(...args);
    vi.setSystemTime(later);
    return artifact;
  });
  expect((await f.call()).status).toBe(201);
  expect(published).toHaveBeenCalledOnce();
  expect(
    f.db.sqlite
      .prepare('SELECT 1 FROM idempotency_requests WHERE request_id=?')
      .get(f.seedRequestId)
  ).toBeUndefined();
  const rows = f.receipt();
  expect(rows).toHaveLength(1);
  expect(Date.parse((rows[0] as { created_at: string }).created_at)).toBeLessThan(
    Date.parse(peer.expires_at)
  );
  const retained = f.retained();
  await f.cold();
  expect(f.retained()).toEqual(retained);
});

it.each(kinds)(
  'settles historical %s receipt before refusing disclosure after a real receipt ACK crosses current authority loss',
  async (kind) => {
    const f = await fixture(kind);
    f.protect();
    const gate = new Int32Array(faults.gate);
    Atomics.store(gate, 1, 1);
    const pending = f.call();
    await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
    expect(Atomics.load(gate, 4)).toBe(2);
    expect(f.receipt()).toHaveLength(1);
    const retained = f.retained();
    const revoker = openCoreDb(f.dataRoot);
    try {
      revoker.sqlite.transaction(() => disableCanonicalUser(revoker, f.userId))();
    } finally {
      revoker.sqlite.close();
    }
    release();
    expect((await pending).status).toBe(403);
    expect(f.retained()).toEqual(retained);
    const count = faults.posts.length;
    // A fresh HTTP request authenticates the now-disabled account again.
    expect((await f.call()).status).toBe(401);
    expect(f.retained()).toEqual(retained);
    expect(faults.posts).toHaveLength(count);
    await f.cold();
    expect(f.retained()).toEqual(retained);
  }
);

it.each(['acknowledged same Store', 'pending second Store'] as const)(
  'retains imported file authority after a real receipt refusal with an %s introduction',
  async (referenceState) => {
    const f = await fixture('import');
    const before = f.retained();
    f.db.sqlite.exec(
      `CREATE TRIGGER reject_artifact_receipt BEFORE INSERT ON idempotency_requests WHEN NEW.request_id='${f.requestId}' BEGIN SELECT RAISE(ABORT,'Artifact receipt constraint'); END`
    );
    f.protect();
    faults.holdFailure = true;
    const failedImport = f.call();
    await vi.waitFor(() => expect(faults.heldFailure).toBeDefined(), { timeout: 5000 });
    expect(Atomics.load(new Int32Array(faults.gate), 3)).toBe(1);
    expect(faults.heldFailure).toMatchObject({
      status: 'error',
      code: 'constraint',
      commit: 'not-committed',
    });
    expect(f.receipt()).toEqual([]);
    const imported = f
      .store()
      .listArtifacts(f.workspace.id)
      .filter((artifact) => !before.artifacts.some((prior) => prior.id === artifact.id));
    expect(imported).toHaveLength(1);
    const artifact = imported[0]!;
    const payloadPath = artifactFilePayloadPath(
      join(f.dataRoot, 'workspaces', f.workspace.id),
      artifact.id,
      1
    );
    expect(readFileSync(payloadPath)).toEqual(f.next);
    const versions = f.store().listArtifactVersions(f.workspace.id, artifact.id);
    const requestId = randomUUID();
    const actor = { kind: 'user' as const, id: f.userId };
    const turnId = deriveEntityId('tu', [
      actor,
      f.workspace.id,
      f.thread.id,
      'artifact.introduce',
      requestId,
    ]);
    const secondStore = referenceState === 'pending second Store';
    const app = createAppWithLocalIdentity({
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      store: secondStore ? new FsStore({ dataRoot: f.dataRoot }) : f.store(),
    });
    const referenceGate = new Int32Array(faults.referenceGate);
    if (secondStore) {
      new Uint8Array(faults.referenceTurn).set(Buffer.from(turnId));
      Atomics.store(referenceGate, 3, Buffer.byteLength(turnId));
      Atomics.store(referenceGate, 0, 1);
    }
    const introduction = app.request('/api/app/operations/artifact.introduce', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
      body: JSON.stringify({
        workspaceId: f.workspace.id,
        threadId: f.thread.id,
        artifactId: artifact.id,
        expectedArtifactVersion: 1,
        requestId,
      }),
    });
    let introduced: Response | undefined;
    try {
      if (secondStore) {
        await vi.waitFor(() => expect(Atomics.load(referenceGate, 1)).toBe(1), {
          timeout: 5000,
        });
        // The real Worker wrote the Turn but has not executed its COMMIT.
        expect(f.store().listThreadTurns(f.workspace.id, f.thread.id)).toEqual(before.turns);
      } else {
        introduced = await introduction;
        expect(introduced.status, await introduced.clone().text()).toBe(201);
      }
      console.info('Artifact compensation regression reached real native boundary', {
        receiptConstraint: Atomics.load(new Int32Array(faults.gate), 3) === 1,
        referenceCommitted: !secondStore,
        referenceBeforeCommit: Atomics.load(referenceGate, 1) === 1,
      });
      expect(faults.releaseFailure).toBeTypeOf('function');
      faults.releaseFailure!();
      const refusal = await failedImport;
      // Check retained authority before the error projection: a genuine other
      // request owns the acknowledged or already-posted native reference.
      expect(f.store().listArtifacts(f.workspace.id)).toContainEqual(artifact);
      expect(f.store().listArtifactVersions(f.workspace.id, artifact.id)).toEqual(versions);
      expect(readFileSync(payloadPath)).toEqual(f.next);
      expect(f.receipt()).toEqual([]);
      expect(refusal.status).toBeGreaterThanOrEqual(400);
    } finally {
      Atomics.store(referenceGate, 0, 0);
      Atomics.store(referenceGate, 2, 1);
      Atomics.notify(referenceGate, 2);
      introduced ??= await introduction;
    }
    expect(introduced.status, await introduced.clone().text()).toBe(201);
    const result = (await introduced.json()) as {
      artifactId: string;
      artifactVersion: number;
      turnId: string;
      itemId: string;
    };
    expect(result).toMatchObject({ artifactId: artifact.id, artifactVersion: 1, turnId });
    const turn = f.store().getTurn(f.workspace.id, f.thread.id, turnId);
    expect(turn).toMatchObject({
      id: turnId,
      status: 'completed',
      items: [
        {
          id: result.itemId,
          type: 'artifact-reference',
          artifactId: artifact.id,
          artifactVersion: 1,
          lastMutationRequestId: requestId,
        },
      ],
    });
    const receipt = () =>
      f.db.sqlite.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').all(requestId);
    const rows = receipt();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      request_key: commandRequestKey('artifact.introduce', requestId, {
        workspaceId: f.workspace.id,
        threadId: f.thread.id,
      }),
      command_name: 'artifact.introduce',
      request_id: requestId,
      scope_json: JSON.stringify({ workspaceId: f.workspace.id, threadId: f.thread.id }),
      input_hash: commandInputHash({ artifactId: artifact.id, expectedArtifactVersion: 1 }),
      response_kind: 'artifact',
      response_id: artifact.id,
    });
    const retained = f.retained();
    await f.cold();
    expect(f.retained()).toEqual(retained);
    expect(f.store().getArtifact(f.workspace.id, artifact.id)).toEqual(artifact);
    expect(f.store().listArtifactVersions(f.workspace.id, artifact.id)).toEqual(versions);
    expect(f.store().getTurn(f.workspace.id, f.thread.id, turnId)).toEqual(turn);
    expect(receipt()).toEqual(rows);
    expect(readFileSync(payloadPath)).toEqual(f.next);
    expect(f.receipt()).toEqual([]);
  }
);
