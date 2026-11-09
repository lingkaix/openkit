import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { canonicalJsonText } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { currentWorkerLineageWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import {
  exportWorkspaceLightAppDefinition,
  importWorkspaceLightAppDefinition,
} from '../catalog/light-app-catalog.js';
import { catalogDocumentPath, loadWorkspaceResourceCatalog } from '../catalog/resource-catalog.js';
import { commandRequestKey, FsStore } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { dispatchOpenkitGenerativeTool } from '../runtime/openkit-generative-mcp.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';

// Independent receipt seam: original catalog bytes -> original result Audit ->
// receipt INSERT -> separate later prune. Native SQL and COMMIT are never replaced.
const fault = vi.hoisted(() => ({
  readonlyMain: false,
  workers: [] as NativeWorker[],
  posts: [] as unknown[],
  // armed stage, reached, release, actual synchronous, Worker index, SQL cause bits.
  gate: new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT),
  request: new SharedArrayBuffer(36),
}));

vi.mock('./db.js', async (load) => {
  const actual = await load<typeof import('./db.js')>();
  return {
    ...actual,
    openWorkspaceDb: (...args: Parameters<typeof actual.openWorkspaceDb>) => {
      const db = actual.openWorkspaceDb(...args);
      if (fault.readonlyMain) db.sqlite.pragma('query_only=ON');
      const prepare = db.sqlite.prepare.bind(db.sqlite);
      db.sqlite.prepare = ((sql: string) => {
        const statement = prepare(sql);
        const run = statement.run.bind(statement);
        statement.run = (...parameters) => {
          try {
            return run(...parameters);
          } catch (error) {
            const request = Buffer.from(fault.request).toString('ascii');
            const code = (error as { code?: string }).code;
            const message = (error as { message?: string }).message;
            if (
              /^\s*INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+idempotency_requests/i.test(sql) &&
              parameters.includes(request) &&
              code?.startsWith('SQLITE_CONSTRAINT') &&
              message === 'Definition receipt constraint'
            )
              Atomics.or(new Int32Array(fault.gate), 5, 1);
            if (
              /^\s*DELETE\s+FROM\s+idempotency_requests/i.test(sql) &&
              code?.startsWith('SQLITE_CONSTRAINT') &&
              message === 'Definition prune constraint' &&
              prepare('SELECT 1 FROM idempotency_requests WHERE request_id=?').get(request)
            )
              Atomics.or(new Int32Array(fault.gate), 5, 2);
            if (code?.startsWith('SQLITE_READONLY'))
              console.info('Original Main definition receipt SQLite refused', {
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
    },
  };
});

vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const index = fault.workers.length;
        const prelude = String.raw`
          const {workerData} = require('node:worker_threads');
          const Database = require(workerData.definitionModule);
          const prepare = Database.prototype.prepare, exec = Database.prototype.exec;
          const gate = workerData.definitionGate;
          const stages = new WeakMap();
          const request = () => Buffer.from(workerData.definitionRequest).toString('ascii');
          const hasReceipt = db => !!prepare.call(db,
            'SELECT 1 FROM idempotency_requests WHERE request_id=?').get(request());
          Database.prototype.prepare = function(sql) {
            const statement = prepare.call(this, sql), db = this;
            const record = /^\s*INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+idempotency_requests/i.test(sql);
            const prune = /^\s*DELETE\s+FROM\s+idempotency_requests/i.test(sql);
            const audit = /^\s*INSERT\s+INTO\s+audit_events/i.test(sql);
            if (!record && !prune && !audit) return statement;
            const run = statement.run;
            statement.run = function(...parameters) {
              try {
                const result = run.apply(this, parameters);
                if (record && parameters.includes(request())) stages.set(db, 1);
                if (prune && hasReceipt(db)) stages.set(db, 2);
                if (audit && parameters.includes(request())) stages.set(db, 3);
                return result;
              } catch (error) {
                if (record && parameters.includes(request()) && error.code?.startsWith('SQLITE_CONSTRAINT') && error.message === 'Definition receipt constraint') Atomics.or(gate, 5, 1);
                if (prune && error.code?.startsWith('SQLITE_CONSTRAINT') && error.message === 'Definition prune constraint' && hasReceipt(db)) Atomics.or(gate, 5, 2);
                throw error;
              }
            };
            return statement;
          };
          Database.prototype.exec = function(sql) {
            const result = exec.call(this, sql);
            if (!/^COMMIT$/i.test(sql)) return result;
            const stage = stages.get(this);
            stages.delete(this);
            if (!stage || Atomics.compareExchange(gate, 0, stage, 0) !== stage) return result;
            Atomics.store(gate, 3, this.pragma('synchronous', {simple:true}));
            Atomics.store(gate, 4, workerData.definitionWorker);
            Atomics.store(gate, 1, stage);
            Atomics.notify(gate, 1);
            Atomics.wait(gate, 2, 0);
            return result;
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
              definitionModule: require.resolve('better-sqlite3'),
              definitionGate: new Int32Array(fault.gate),
              definitionRequest: new Uint8Array(fault.request),
              definitionWorker: index,
            },
          }
        );
        fault.workers.push(this);
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        fault.posts.push(args[0]);
        return super.postMessage(...args);
      }
    },
  };
});

const commands = [
  'catalog.light-app-import',
  'catalog.light-app-history-import',
  'catalog.light-app-select',
  'catalog.light-app-pin',
] as const;
type Command = (typeof commands)[number];
const release = () => {
  const gate = new Int32Array(fault.gate);
  Atomics.store(gate, 0, 0);
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
};
const arm = (stage: number) => {
  const gate = new Int32Array(fault.gate);
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 2, 0);
  Atomics.store(gate, 0, stage);
};
const held = async (stage: number) => {
  const gate = new Int32Array(fault.gate);
  await vi.waitFor(() => expect(Atomics.load(gate, 1)).toBe(stage), { timeout: 5000 });
  expect(Atomics.load(gate, 3)).toBe(2);
};
const definition = (): LightAppSchemaInput => ({
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Notes',
  purpose: 'Exact reusable notes.',
  collections: [
    {
      name: 'records',
      type: 'base',
      description: 'Notes.',
      fields: [{ name: 'value', type: 'text', required: false, description: 'Exact value.' }],
      indexes: [],
    },
  ],
});

async function fixture(command: Command) {
  release();
  fault.readonlyMain = false;
  fault.workers.length = 0;
  fault.posts.length = 0;
  new Int32Array(fault.gate).fill(0);
  const dataRoot = mkdtempSync(join(tmpdir(), 'definition-receipts-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  let store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Definition receipt authority');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  let app = createAppWithLocalIdentity({ coreDb, dataRoot, store });
  let db = openWorkspaceDb(dataRoot, workspace.id);
  onTestFinished(async () => {
    release();
    fault.readonlyMain = false;
    vi.useRealTimers();
    await shutdownControlStoreWorkerClient();
    if (db.sqlite.open) db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const request = (operation: string, body: object) =>
    app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openkit-request-id': (body as { requestId: string }).requestId,
      },
      body: JSON.stringify(body),
    });
  const peerRequestId = randomUUID();
  const seeded = await request('catalog.light-app-import', {
    workspaceId: workspace.id,
    requestId: peerRequestId,
    expectedRevision: 0,
    entryId: 'notes',
    displayName: 'Notes',
    definition: definition(),
    selectDefault: true,
  });
  expect(seeded.status, await seeded.clone().text()).toBe(201);
  const first = (await seeded.json()).version;
  const second = importWorkspaceLightAppDefinition({
    dataRoot,
    workspaceId: workspace.id,
    expectedRevision: 1,
    entryId: 'notes',
    displayName: 'Notes',
    definition: { ...JSON.parse(first.definitionJson), title: 'Revised' },
    parentDigest: first.digest,
    producer: { kind: 'user', id: userId },
    createdAt: new Date().toISOString(),
  }).version;
  const finalDefinition = { ...JSON.parse(second.definitionJson), title: 'Final' };
  const definitionJson = canonicalJsonText(finalDefinition);
  const digest = `sha256:${createHash('sha256').update(definitionJson).digest('hex')}`;
  const specific =
    command === commands[0]
      ? {
          entryId: 'notes',
          displayName: 'Notes',
          definition: finalDefinition,
          parentDigest: second.digest,
          selectDefault: true,
        }
      : command === commands[1]
        ? {
            entryId: 'copy',
            export: exportWorkspaceLightAppDefinition({
              dataRoot,
              workspaceId: workspace.id,
              entryId: 'notes',
            }),
          }
        : command === commands[2]
          ? { entryId: 'notes', digest: second.digest, expectedCurrentDigest: first.digest }
          : { entryId: 'notes', digest: second.digest, expectedPinDigest: null };
  const requestId = randomUUID();
  new Uint8Array(fault.request).set(Buffer.from(requestId));
  const input = { workspaceId: workspace.id, requestId, expectedRevision: 2, ...specific };
  const rows = (id = requestId) =>
    db.sqlite.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').all(id);
  const audits = () =>
    db.sqlite
      .prepare('SELECT * FROM audit_events WHERE request_id=? ORDER BY audit_event_id')
      .all(requestId);
  const bytes = () => readFileSync(catalogDocumentPath(dataRoot, workspace.id), 'utf8');
  const snapshot = () => ({
    bytes: bytes(),
    audits: audits(),
    receipts: db.sqlite.prepare('SELECT * FROM idempotency_requests ORDER BY request_key').all(),
    apps: readdirSync(join(dataRoot, 'workspaces', workspace.id, 'light-apps')).sort(),
  });
  return {
    dataRoot,
    coreDb,
    userId,
    workspaceId: workspace.id,
    first,
    second,
    digest,
    definitionJson,
    command,
    input,
    requestId,
    peerRequestId,
    request,
    rows,
    audits,
    bytes,
    snapshot,
    get db() {
      return db;
    },
    store: () => store,
    call: () => request(command, input),
    protect() {
      fault.readonlyMain = true;
      db.sqlite.pragma('query_only=ON');
      coreDb.sqlite.pragma('query_only=ON');
    },
    async cold() {
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      db = openWorkspaceDb(dataRoot, workspace.id);
      store = new FsStore({ dataRoot });
      app = createAppWithLocalIdentity({ coreDb, dataRoot, store });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function receipt(f: Fixture) {
  const rows = f.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    request_key: commandRequestKey(f.command, f.requestId, {
      workspaceId: f.workspaceId,
      actorId: f.userId,
    }),
    request_id: f.requestId,
    command_name: f.command,
    scope_json: JSON.stringify({ workspaceId: f.workspaceId, actorId: f.userId }),
    input_hash: commandInputHash(f.input),
    response_kind: f.command === commands[0] ? 'light_app_definition' : 'light_app_catalog',
    response_id: f.command === commands[0] ? f.digest : f.workspaceId,
  });
  return rows;
}
function effect(f: Fixture) {
  const catalog = loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId);
  expect(catalog.revision).toBe(3);
  expect(catalog.lightApps.versions.slice(0, 2)).toEqual([f.first, f.second]);
  if (f.command === commands[0]) {
    expect(catalog.lightApps.versions).toHaveLength(3);
    expect(catalog.lightApps.versions[2]).toMatchObject({
      entryId: 'notes',
      digest: f.digest,
      definitionJson: f.definitionJson,
      parentDigest: f.second.digest,
      producer: { kind: 'user', id: f.userId },
    });
  } else if (f.command === commands[1]) {
    expect(catalog.lightApps.versions).toEqual([
      f.first,
      f.second,
      { ...f.first, entryId: 'copy' },
      { ...f.second, entryId: 'copy' },
    ]);
    expect(catalog.lightApps.entries.find((entry) => entry.id === 'copy')).toEqual({
      id: 'copy',
      displayName: 'Notes',
      availability: 'available',
      currentDigest: null,
    });
  } else expect(catalog.lightApps.versions).toEqual([f.first, f.second]);
  expect(catalog.lightApps.entries.find((entry) => entry.id === 'notes')?.currentDigest).toBe(
    f.command === commands[0]
      ? f.digest
      : f.command === commands[2]
        ? f.second.digest
        : f.first.digest
  );
  expect(catalog.lightApps.pins).toEqual(
    f.command === commands[3] ? [{ entryId: 'notes', digest: f.second.digest }] : []
  );
  expect(f.audits()).toHaveLength(1);
  expect(f.snapshot().apps).toEqual([]);
}
function successStatus(command: Command) {
  return command === commands[0] || command === commands[1] ? 201 : 200;
}

it.each(commands)(
  'preserves original %s file/Audit prefix after a genuine receipt INSERT refusal and cold retry',
  async (command) => {
    const f = await fixture(command);
    f.db.sqlite.exec(
      `CREATE TRIGGER reject_definition_receipt BEFORE INSERT ON idempotency_requests WHEN NEW.request_id='${f.requestId}' BEGIN SELECT RAISE(ABORT,'Definition receipt constraint'); END`
    );
    const response = await f.call();
    expect(Atomics.load(new Int32Array(fault.gate), 5)).toBe(1);
    effect(f);
    expect(f.rows()).toEqual([]);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'recovery_required' });
    const retained = f.snapshot();
    f.db.sqlite.exec('DROP TRIGGER reject_definition_receipt');
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    expect((await f.call()).status).toBe(409);
    expect(f.snapshot()).toEqual(retained);
  }
);

it.each(commands)(
  'preserves original %s committed receipt after genuine late prune refusal and cold replay',
  async (command) => {
    const f = await fixture(command);
    const peer = f.rows(f.peerRequestId)[0] as { expires_at: string };
    arm(3);
    const pending = f.call();
    await held(3);
    effect(f);
    expect(f.rows()).toEqual([]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(peer.expires_at) + 1);
    // Initial lookup has already completed. Install the fault at the authentic result-Audit ACK boundary.
    f.db.sqlite.exec(
      `CREATE TRIGGER reject_definition_prune BEFORE DELETE ON idempotency_requests WHEN OLD.request_id='${f.peerRequestId}' BEGIN SELECT RAISE(ABORT,'Definition prune constraint'); END`
    );
    release();
    const response = await pending;
    expect(Atomics.load(new Int32Array(fault.gate), 5)).toBe(2);
    receipt(f);
    expect(f.rows(f.peerRequestId)).toEqual([peer]);
    effect(f);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'recovery_required' });
    const retained = f.snapshot();
    f.db.sqlite.exec('DROP TRIGGER reject_definition_prune');
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    expect((await f.call()).status).toBe(successStatus(command));
    expect(f.snapshot()).toEqual(retained);
  }
);

it('samples original receipt maintenance time after actual result Audit ACK', async () => {
  const f = await fixture(commands[0]);
  const peer = f.rows(f.peerRequestId)[0] as { expires_at: string };
  arm(3);
  const pending = f.call();
  await held(3);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(peer.expires_at) + 1);
  release();
  expect((await pending).status).toBe(201);
  receipt(f);
  effect(f);
  expect(f.rows(f.peerRequestId)).toEqual([]);
  expect(Date.parse((f.rows()[0] as { created_at: string }).created_at)).toBeLessThan(
    Date.parse(peer.expires_at)
  );
  const retained = f.snapshot();
  await f.cold();
  expect(f.snapshot()).toEqual(retained);
});

it.each(commands)(
  'natively publishes %s receipt with Main query-only and exact cold tuple',
  async (command) => {
    const f = await fixture(command);
    f.protect();
    const response = await f.call();
    expect(response.status, await response.clone().text()).toBe(successStatus(command));
    receipt(f);
    effect(f);
    const retained = f.snapshot();
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    expect((await f.call()).status).toBe(successStatus(command));
    expect(f.snapshot()).toEqual(retained);
  }
);

it.each(commands.flatMap((command) => [1, 2].map((stage) => ({ command, stage }))))(
  'natively preserves $command stage $stage FULL across lost ACK, warm and cold replay',
  async ({ command, stage }) => {
    const f = await fixture(command);
    f.protect();
    arm(stage);
    const pending = f.call();
    await held(stage);
    receipt(f);
    effect(f);
    const retained = f.snapshot();
    const count = fault.posts.length;
    await fault.workers[Atomics.load(new Int32Array(fault.gate), 4)]!.terminate();
    release();
    expect((await pending).status).toBe(409);
    expect(f.snapshot()).toEqual(retained);
    expect(fault.posts).toHaveLength(count);
    expect((await f.call()).status).toBe(successStatus(command));
    expect(f.snapshot()).toEqual(retained);
    expect(fault.posts).toHaveLength(count);
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    expect((await f.call()).status).toBe(successStatus(command));
    expect(f.snapshot()).toEqual(retained);
  }
);

it.each(commands)(
  'natively retains %s historical receipt before refusing disclosure after receipt ACK crosses authority loss',
  async (command) => {
    const f = await fixture(command);
    f.protect();
    arm(1);
    const pending = f.call();
    await held(1);
    receipt(f);
    effect(f);
    const retained = f.snapshot();
    const revoker = openCoreDb(f.dataRoot);
    try {
      revoker.sqlite.transaction(() => disableCanonicalUser(revoker, f.userId))();
    } finally {
      revoker.sqlite.close();
    }
    release();
    const response = await pending;
    receipt(f);
    expect(f.snapshot()).toEqual(retained);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'catalog_forbidden' });
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
  }
);

it('natively maintains actual Artifact and Light App receipts in both directions without pruning another physical Workspace', async () => {
  const f = await fixture(commands[0]);
  const other = await f.store().createWorkspace('Other receipt partition');
  recordWorkspaceOwnerMembership({
    coreDb: f.coreDb,
    workspaceId: other.id,
    ownerUserId: f.userId,
  });
  const otherRequest = randomUUID();
  expect(
    (
      await f.request(commands[0], {
        workspaceId: other.id,
        requestId: otherRequest,
        expectedRevision: 0,
        entryId: 'other',
        displayName: 'Other',
        selectDefault: true,
        definition: definition(),
      })
    ).status
  ).toBe(201);
  const otherDb = openWorkspaceDb(f.dataRoot, other.id);
  try {
    const otherRows = otherDb.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .all(otherRequest);
    expect(otherRows).toHaveLength(1);
    const peer = f.rows(f.peerRequestId)[0] as { expires_at: string };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(
      Math.max(
        Date.parse(peer.expires_at),
        Date.parse((otherRows[0] as { expires_at: string }).expires_at)
      ) + 1
    );
    const artifactRequest = randomUUID();
    const bytes = Buffer.from([0, 255, 128, 10]);
    const app = createAppWithLocalIdentity({
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      store: f.store(),
    });
    const imported = await app.request(
      `/api/app/operations/artifact.import?${new URLSearchParams({ workspaceId: f.workspaceId, title: 'Native receipt peer', mediaType: 'application/octet-stream', byteLength: String(bytes.length), contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-openkit-request-id': artifactRequest,
        },
        body: bytes,
      }
    );
    expect(imported.status, await imported.clone().text()).toBe(201);
    expect(f.rows(f.peerRequestId)).toEqual([]);
    expect(
      otherDb.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
        .all(otherRequest)
    ).toEqual(otherRows);
    const artifact = f.rows(artifactRequest)[0] as { expires_at: string };
    expect(artifact).toBeDefined();
    vi.setSystemTime(Date.parse(artifact.expires_at) + 1);
    expect((await f.call()).status).toBe(201);
    receipt(f);
    effect(f);
    expect(f.rows(artifactRequest)).toEqual([]);
    expect(
      otherDb.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
        .all(otherRequest)
    ).toEqual(otherRows);
    const retained = f.snapshot();
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    expect(
      otherDb.sqlite
        .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
        .all(otherRequest)
    ).toEqual(otherRows);
  } finally {
    otherDb.sqlite.close();
  }
});

it('preserves the real admitted Worker agent actor in both original definition receipt kinds', async () => {
  const f = await fixture(commands[0]);
  // Reuse the existing openkit-generative MCP owner fixture: real admitted
  // Turn/session/Scheduler attempt below the dispatcher, not backend acceptance.
  const agentId = 'agent_codex_host';
  const actor = { kind: 'agent' as const, id: agentId, responsibleUserId: f.userId };
  const thread = await f.store().createThread(f.workspaceId, 'Worker definition receipt');
  const turn = await f.store().createTurn(f.workspaceId, thread.id, 'Publish a definition', actor);
  const agentSessionId = testEntityId('as', randomUUID());
  const now = new Date().toISOString();
  await f.store().createAgentSession({
    id: agentSessionId,
    agentId,
    workspaceId: f.workspaceId,
    threadId: thread.id,
    status: 'created',
    message: null,
    createdAt: now,
    updatedAt: now,
  });
  await f.store().updateTurn(turn.id, { agentId, agentSessionId });
  const requestId = randomUUID();
  const packageSnapshotId = `definition-package-${randomUUID()}`;
  const entry = createSchedulerAdmissionEntry(f.coreDb, {
    backendId: 'nanohost',
    queueEntryId: `queue_${turn.id}`,
    requestId,
    triggerActor: actor,
    workspaceId: f.workspaceId,
    threadId: thread.id,
    turnId: turn.id,
    turnInput: 'Publish a definition',
    requestedAgentId: agentId,
  });
  recordTestExecutionAttempt(f.coreDb, {
    entry,
    attemptId: testEntityId('attempt', randomUUID()),
    agentSessionId,
    inputRef: packageSnapshotId,
    bindingRef: `binding_${turn.id}`,
    sessionCompatibilityKey: 'definition-receipt-owner',
    now: () => new Date().toISOString(),
  });
  const scope = {
    workspaceId: f.workspaceId,
    threadId: thread.id,
    turnId: turn.id,
    agentSessionId,
    triggerActor: actor,
  };
  expect(
    currentWorkerLineageWorkspaceAuthority(
      f.coreDb,
      { ...scope, packageSnapshotId },
      'workspace.configure',
      true
    )
  ).not.toBeNull();
  const context = {
    coreDb: f.coreDb,
    packageSnapshotId,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    protocolRequestId: requestId,
    store: f.store(),
    inflightCommands: new WeakMap(),
    dataRoot: f.dataRoot,
    workspaceId: f.workspaceId,
    actor,
    workspaceDb: f.db,
    scope,
  };
  const imported = await dispatchOpenkitGenerativeTool(context, 'catalog_light-app-import', {
    expectedRevision: 2,
    entryId: 'worker-notes',
    displayName: 'Worker notes',
    definition: definition(),
    selectDefault: true,
  });
  const result = imported.structuredContent as {
    revision: number;
    version: { digest: string; producer: typeof actor };
  };
  expect(result.revision).toBe(3);
  expect(result.version.producer).toEqual({ kind: 'agent', id: agentId });
  const pinRequestId = randomUUID();
  const pinned = await dispatchOpenkitGenerativeTool(
    { ...context, protocolRequestId: pinRequestId },
    'catalog_light-app-pin',
    {
      expectedRevision: 3,
      entryId: 'worker-notes',
      digest: result.version.digest,
      expectedPinDigest: null,
    }
  );
  expect(pinned.structuredContent).toEqual({ revision: 4 });
  const actorScope = { workspaceId: f.workspaceId, actorId: agentId };
  const importedRows = f.rows(requestId),
    pinnedRows = f.rows(pinRequestId);
  expect(importedRows).toHaveLength(1);
  expect(pinnedRows).toHaveLength(1);
  expect(importedRows[0]).toMatchObject({
    request_key: commandRequestKey(commands[0], requestId, actorScope),
    request_id: requestId,
    command_name: commands[0],
    scope_json: JSON.stringify(actorScope),
    response_kind: 'light_app_definition',
    response_id: result.version.digest,
  });
  expect(pinnedRows[0]).toMatchObject({
    request_key: commandRequestKey(commands[3], pinRequestId, actorScope),
    request_id: pinRequestId,
    command_name: commands[3],
    scope_json: JSON.stringify(actorScope),
    response_kind: 'light_app_catalog',
    response_id: f.workspaceId,
  });
  const retained = f.snapshot();
  await f.cold();
  expect(f.snapshot()).toEqual(retained);
  expect(f.rows(requestId)).toEqual(importedRows);
  expect(f.rows(pinRequestId)).toEqual(pinnedRows);
});
