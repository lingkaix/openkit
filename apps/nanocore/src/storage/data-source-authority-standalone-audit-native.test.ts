/// <reference lib="es2024.sharedmemory" />
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import type { WorkspaceDataSource } from '@openkit/config-schema';
import { type AuditEvent, isEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createApp } from '../app.js';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { ensureLocalUser } from '../auth/identity.js';
import { disableCanonicalUser, isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { submitWorkspaceSkillCandidate } from '../catalog/resource-catalog.js';
import { FsStore } from '../lib/store.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb, openWorkspaceReadDb } from './db.js';
import { applyMigrations } from './migrate.js';

// L2: real public config operation -> atomic authored file -> original Workspace Audit.
// Owners: Core Storage, SQLite Layers; Core Evidence, Audit Data Safety; Workspace
// Data Source Catalog, Contract / Expected Behavior. File and Audit are separate effects.
const fault = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  messages: [] as unknown[],
  gate: new SharedArrayBuffer(15 * Int32Array.BYTES_PER_ELEMENT),
  targets: new SharedArrayBuffer(2048),
}));

vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const index = fault.workers.length;
        // Call through real SAVEPOINT/INSERT/COMMIT; hold only a newly inserted exact row.
        // String.raw preserves the COMMIT expression in the actual Worker program.
        const prelude = String.raw`
          const {workerData} = require('node:worker_threads');
          const Database = require(workerData.auditSqlModule);
          const originalExec = Database.prototype.exec;
          const gate = workerData.auditGate;
          const before = new WeakMap();
          const inserted = new WeakMap();
          const fileBeforeInsert = new WeakMap();
          const {readFileSync} = require('node:fs');
          const {createHash} = require('node:crypto');
          function targets() {
            return JSON.parse(Buffer.from(workerData.auditTargets).toString('utf8').split('\0')[0]);
          }
          function ids(db, target) {
            if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='audit_events' AND type='table'").get()) return [];
            return db.prepare('SELECT audit_event_id FROM audit_events WHERE action=? AND resource=?').all(target.action, target.resource).map(row => row.audit_event_id);
          }
          Database.prototype.exec = function(sql) {
            const selected = targets();
            if (sql === 'SAVEPOINT control_transition') {
              before.set(this, selected.map(target => new Set(ids(this, target))));
              fileBeforeInsert.set(this, selected.map(target => {
                if (!target.publication) return false;
                try {
                  return createHash('sha256').update(readFileSync(target.publication.path)).digest('hex') === target.publication.sha256;
                } catch { return false; }
              }));
            }
            const result = originalExec.call(this, sql);
            if (sql === 'RELEASE control_transition' && before.has(this)) {
              const prior = before.get(this);
              inserted.set(this, selected.map((target, slot) => ids(this, target).some(id => !prior[slot].has(id))));
            }
            if (/^COMMIT$/i.test(sql) && inserted.has(this)) {
              const changed = inserted.get(this);
              inserted.delete(this);
              for (let slot = 0; slot < selected.length; slot++) {
                const base = slot * 5;
                if (changed[slot] && Atomics.compareExchange(gate, base + 1, 1, 0) === 1) {
                  Atomics.store(gate, base + 3, this.pragma('synchronous', {simple:true}));
                  Atomics.store(gate, base + 4, workerData.auditWorkerIndex);
                  Atomics.store(gate, base, fileBeforeInsert.get(this)?.[slot] === true ? 1 : -2);
                  Atomics.notify(gate, base);
                  Atomics.wait(gate, base + 2, 0);
                }
              }
            }
            return result;
          };
        `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            auditSqlModule: require.resolve('better-sqlite3'),
            auditGate: new Int32Array(fault.gate),
            auditTargets: new Uint8Array(fault.targets),
            auditWorkerIndex: index,
          },
        });
        fault.workers.push(this);
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        fault.messages.push(args[0]);
        return super.postMessage(...args);
      }
    },
  };
});

const ACTION = 'data_source_catalog.authority.update';
const FIELDS = 'kind, access, sensitivity, vaultGrantRef';
const OLD_GRANT = 'grant_00000000-0000-7000-8000-000000000001';
const NEW_GRANT = 'grant_00000000-0000-7000-8000-000000000002';

/** Release all exact slots, including a losing wait during failed-test cleanup. */
function release(slot?: number) {
  const gate = new Int32Array(fault.gate);
  for (const index of slot === undefined ? [0, 1, 2] : [slot]) {
    const base = index * 5;
    Atomics.store(gate, base + 1, 0);
    Atomics.store(gate, base + 2, 1);
    Atomics.notify(gate, base + 2);
    if (Atomics.compareExchange(gate, base, 0, -1) === 0) Atomics.notify(gate, base);
  }
}

/** Bind target position and armed slot together; the positive control uses this same selector. */
function arm(
  targets: Array<{
    action: string;
    resource: string;
    publication?: { path: string; sha256: string };
  }>,
  slots: number[]
) {
  new Int32Array(fault.gate).fill(0);
  const bytes = new Uint8Array(fault.targets);
  bytes.fill(0);
  bytes.set(new TextEncoder().encode(JSON.stringify(targets)));
  for (const slot of slots) Atomics.store(new Int32Array(fault.gate), slot * 5 + 1, 1);
}

/** Fail on genuine early public completion, not a missing-stage timeout. */
async function held(
  slot: number,
  result: Promise<Response>,
  publication?: { path: string; content: string; rows: () => unknown[] }
) {
  const gate = new Int32Array(fault.gate);
  const base = slot * 5;
  const ready = Promise.resolve(Atomics.waitAsync(gate, base, 0).value).then(() => 'held');
  const outcome = await Promise.race([
    ready,
    result.then((response) => `HTTP ${response.status} before native Audit ACK hold`),
  ]);
  if (outcome !== 'held') {
    const response = await result;
    console.info(
      JSON.stringify({
        observation: 'early-public-result',
        slot,
        status: response.status,
        body: await response.clone().text(),
      })
    );
  }
  if (publication) {
    const bytes = readFileSync(publication.path, 'utf8');
    expect(bytes).toBe(publication.content);
    console.info(
      JSON.stringify({
        observation: 'post-file-native-audit',
        slot,
        outcome,
        publishedSha256: createHash('sha256').update(bytes).digest('hex'),
        exactPublishedBytes: bytes === publication.content,
        auditRows: publication.rows().length,
        full: Atomics.load(gate, base + 3),
        nativeHeld: Atomics.load(gate, base) === 1,
      })
    );
  }
  expect(
    outcome,
    'Published file must precede native FULL Audit; public success must follow its ACK.'
  ).toBe('held');
  expect(
    Atomics.load(gate, base),
    'Exact canonical file bytes must exist before native SAVEPOINT/INSERT, not merely after COMMIT.'
  ).toBe(1);
  expect(Atomics.load(gate, base + 3)).toBe(2);
  const worker = fault.workers[Atomics.load(gate, base + 4)];
  expect(worker).toBeDefined();
  return worker!;
}

/** Synthetic authored input has no real locator, credential, account or external effect. */
function source(id: string, changed = false): WorkspaceDataSource {
  return {
    id,
    kind: changed ? 'r2' : 's3',
    displayName: `Synthetic ${id}`,
    locator: {
      bucket: 'synthetic-private-locator-never-in-audit',
      prefix: 'synthetic-private-body',
    },
    access: changed ? 'read-write' : 'read-only',
    sensitivity: changed ? 'restricted' : 'internal',
    vaultGrantRef: changed ? NEW_GRANT : OLD_GRANT,
    allowedSlotKinds: ['data'],
    status: 'active',
    syncHints: {},
    requiredFeatures: [],
    extensions: {},
  };
}

/** Encode exact authored bytes, retaining deliberately unsorted source input. */
function catalog(ids: string[], changed = false) {
  return `${JSON.stringify({ schemaVersion: 1, sources: ids.map((id) => source(id, changed)) }, null, 2)}\n`;
}

/** Compose only real public identity, Workspace, config and database owners. */
async function fixture(ids = ['alpha']) {
  release();
  new Uint8Array(fault.targets).fill(0);
  new Uint8Array(fault.targets).set(new TextEncoder().encode('[]'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'data-source-authority-native-'));
  const coreDb = openCoreDb(dataRoot);
  let reader: ReturnType<typeof openWorkspaceDb> | undefined;
  const pending: Promise<Response>[] = [];
  onTestFinished(async () => {
    release();
    await Promise.allSettled(pending);
    await shutdownControlStoreWorkerClient();
    if (reader?.sqlite.open) reader.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Synthetic authority Audit');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const path = join(dataRoot, 'workspaces', workspace.id, 'config', 'data-sources.jsonc');
  const original = catalog(ids);
  writeFileSync(path, original);
  const app = await createApp({ coreDb, dataRoot, store });
  reader = openWorkspaceDb(dataRoot, workspace.id);
  const workspaceDb = reader;
  const fileId = `workspaces/${workspace.id}/data-sources.jsonc`;
  const request = (operation: Parameters<typeof operationRequest>[0], input: object) => {
    const result = Promise.resolve(
      app.request(
        ...operationRequest(
          operation,
          {},
          {
            body: JSON.stringify(input),
            headers: { 'content-type': 'application/json' },
          }
        )
      )
    );
    pending.push(result);
    return result;
  };
  const read = async (id = fileId) => {
    const response = await app.request(...operationRequest('runtime.file-read', { id }));
    expect(response.status).toBe(200);
    return (await response.json()) as { file: { revision: string }; content: string };
  };
  const initial = await read();
  expect(initial.content).toBe(original);
  const rows = () =>
    workspaceDb.sqlite
      .prepare('SELECT * FROM audit_events WHERE action=? ORDER BY rowid')
      .all(ACTION);
  const events = () =>
    listWorkspaceAuditEvents(workspaceDb, workspace.id).filter((event) => event.action === ACTION);
  return {
    userId,
    dataRoot,
    disableActor() {
      const disabled = coreDb.sqlite.transaction(() => disableCanonicalUser(coreDb, userId))();
      expect(disabled?.changed).toBe(true);
      expect(isCanonicalUserActive(coreDb, userId)).toBe(false);
    },
    workspaceId: workspace.id,
    fileId,
    path,
    original,
    initial,
    workspaceDb,
    read,
    request,
    rows,
    events,
    update(content: string, expectedRevision = initial.file.revision) {
      return request('runtime.file-update', {
        id: fileId,
        kind: 'data-source',
        content,
        expectedRevision,
      });
    },
    arm(slots: number[], content: string) {
      arm(
        ['alpha', 'beta', 'gamma'].map((id) => ({
          action: ACTION,
          resource: `data-source-catalog:${id}`,
          publication: { path, sha256: createHash('sha256').update(content).digest('hex') },
        })),
        slots
      );
    },
    async coldRows() {
      await shutdownControlStoreWorkerClient();
      const cold = openWorkspaceReadDb(dataRoot, workspace.id);
      try {
        expect(cold.sqlite.pragma('query_only', { simple: true })).toBe(1);
        return cold.sqlite
          .prepare('SELECT * FROM audit_events WHERE action=? ORDER BY rowid')
          .all(ACTION);
      } finally {
        cold.sqlite.close();
      }
    },
  };
}

/** Pin the original admitted actor and redacted summary, not any future native codec. */
function expectOriginal(
  event: AuditEvent | undefined,
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  fields = FIELDS
) {
  expect(event).toEqual({
    id: expect.any(String),
    workspaceId: f.workspaceId,
    threadId: null,
    turnId: null,
    itemId: null,
    capabilityCallId: null,
    permissionDecisionId: null,
    vaultGrantId: null,
    requestId: null,
    actor: { kind: 'user', id: f.userId },
    authentication: { credentialKind: 'local', credentialId: null },
    subject: null,
    agentId: null,
    agentSessionId: null,
    category: 'system',
    action: ACTION,
    resource: `data-source-catalog:${id}`,
    resourceRevision: null,
    outcome: 'succeeded',
    severity: 'info',
    summary: `Workspace data source catalog authority changed for ${id}: ${fields}.`,
    errorCode: null,
    createdAt: expect.any(String),
    occurredAt: expect.any(String),
  });
  expect(event).toBeDefined();
  if (!event) throw new Error('Missing original Audit event.');
  expect(isEntityId('aud', event.id)).toBe(true);
  expect(typeof event.createdAt).toBe('string');
  expect(typeof event.occurredAt).toBe('string');
  if (typeof event.createdAt !== 'string' || typeof event.occurredAt !== 'string')
    throw new Error('Missing Audit timestamps.');
  expect(Number.isFinite(Date.parse(event.createdAt))).toBe(true);
  expect(Number.isFinite(Date.parse(event.occurredAt))).toBe(true);
  const encoded = JSON.stringify(event);
  for (const excluded of [
    'synthetic-private-locator',
    'synthetic-private-body',
    OLD_GRANT,
    NEW_GRANT,
  ])
    expect(encoded).not.toContain(excluded);
}

it.each([
  { label: 'positive', correctFile: true },
  { label: 'negative', correctFile: false },
])(
  '$label existing native admission calibrates the exact second selector and armed slot',
  async ({ correctFile }) => {
    const f = await fixture();
    const submitted = submitWorkspaceSkillCandidate({
      dataRoot: f.dataRoot,
      workspaceId: f.workspaceId,
      entryId: 'audit-control',
      baseDigest: null,
      expectedRevision: 0,
      createdAt: '2026-10-19T00:00:00.000Z',
      producer: { kind: 'user', id: f.userId },
      summary: 'Synthetic positive native admission control.',
      tree: [
        {
          kind: 'file',
          path: 'SKILL.md',
          contentBase64: Buffer.from(
            '---\nname: audit-control\ndescription: Native control.\n---\nSynthetic instructions.\n'
          ).toString('base64'),
        },
      ],
    });
    const candidateId = submitted.candidate.id;
    arm(
      [
        { action: ACTION, resource: 'data-source-catalog:unused-control' },
        {
          action: 'catalog.skill-candidate-decide.admit',
          resource: `skill-candidate:${candidateId}`,
          publication: {
            path: f.path,
            sha256: createHash('sha256')
              .update(correctFile ? f.original : `${f.original}not-published`)
              .digest('hex'),
          },
        },
      ],
      [1]
    );
    const result = f.request('catalog.skill-candidate-decide', {
      workspaceId: f.workspaceId,
      candidateId,
      expectedRevision: submitted.catalog.revision,
      expectedCurrentDigest: null,
      decision: 'rejected',
      requestId: randomUUID(),
    });
    if (correctFile) {
      const worker = await held(1, result);
      expect(worker.threadId).toBeGreaterThan(0);
    } else {
      await expect(held(1, result)).rejects.toThrow(
        'Exact canonical file bytes must exist before native SAVEPOINT/INSERT'
      );
      const gate = new Int32Array(fault.gate);
      expect(Atomics.load(gate, 5)).toBe(-2);
      expect(Atomics.load(gate, 8)).toBe(2);
      expect(fault.workers[Atomics.load(gate, 9)]?.threadId).toBeGreaterThan(0);
    }
    expect(new Int32Array(fault.gate)[0]).toBe(0);
    expect(f.rows()).toEqual([]);
    const admission = listWorkspaceAuditEvents(f.workspaceDb, f.workspaceId).filter(
      (event) => event.action === 'catalog.skill-candidate-decide.admit'
    );
    expect(admission).toHaveLength(1);
    expect(admission[0]?.resource).toBe(`skill-candidate:${candidateId}`);
    release(1);
    expect((await result).status).toBe(200);
  }
);

it.each(['kind', 'access', 'sensitivity', 'vaultGrantRef'] as const)(
  'publishes authority field %s before native FULL and waits for covering ACK before success',
  async (field) => {
    const f = await fixture();
    const content = `${JSON.stringify({ schemaVersion: 1, sources: [{ ...source('alpha'), [field]: source('alpha', true)[field] }] }, null, 2)}\n`;
    f.arm([0], content);
    let settled = false;
    const result = f.update(content);
    void result.then(() => {
      settled = true;
    });
    const worker = await held(0, result, { ...f, content });
    expect(worker.threadId).toBeGreaterThan(0);
    expect(settled).toBe(false);
    expect(readFileSync(f.path, 'utf8')).toBe(content);
    expect((await f.read()).file.revision).not.toBe(f.initial.file.revision);
    expect(f.events()).toHaveLength(1);
    expectOriginal(f.events()[0], f, 'alpha', field);
    const prefix = f.rows();
    release(0);
    expect((await result).status).toBe(200);
    expect(f.rows()).toEqual(prefix);
    expect(await f.coldRows()).toEqual(prefix);
  }
);

it('keeps sorted serial changed-entry ACK order despite unsorted authored sources', async () => {
  const f = await fixture(['gamma', 'alpha', 'beta']);
  const content = catalog(['gamma', 'alpha', 'beta'], true);
  f.arm([0, 1, 2], content);
  const result = f.update(content);
  for (const [slot, id] of ['alpha', 'beta', 'gamma'].entries()) {
    await held(slot, result, { ...f, content });
    expect(readFileSync(f.path, 'utf8')).toBe(content);
    const events = f.events();
    expect(events).toHaveLength(slot + 1);
    for (const [index, name] of ['alpha', 'beta', 'gamma'].slice(0, slot + 1).entries())
      expectOriginal(events[index], f, name);
    expect(events[slot]?.resource).toBe(`data-source-catalog:${id}`);
    release(slot);
  }
  expect((await result).status).toBe(200);
  expect(await f.coldRows()).toEqual(f.rows());
});

it('lost second FULL ACK preserves published bytes and cold Audit prefix without repost or repair', async () => {
  const f = await fixture(['gamma', 'alpha', 'beta']);
  const content = catalog(['gamma', 'alpha', 'beta'], true);
  f.arm([0, 1], content);
  const result = f.update(content);
  await held(0, result, { ...f, content });
  expect(f.events()).toHaveLength(1);
  release(0);
  const worker = await held(1, result, { ...f, content });
  expect(readFileSync(f.path, 'utf8')).toBe(content);
  expect(f.events()).toHaveLength(2);
  expectOriginal(f.events()[0], f, 'alpha');
  expectOriginal(f.events()[1], f, 'beta');
  const prefix = f.rows();
  const publishedStat = statSync(f.path, { bigint: true });
  const posts = fault.messages.length;
  const workers = fault.workers.length;
  await worker.terminate();
  const response = await result;
  expect(response.status).toBe(500); // Existing unclassified unknown error projection, never false rollback.
  expect(readFileSync(f.path, 'utf8')).toBe(content);
  expect(f.rows()).toEqual(prefix);
  expect(fault.messages.length).toBe(posts);
  expect(fault.workers.length).toBe(workers);
  expect(statSync(f.path, { bigint: true })).toMatchObject({
    ino: publishedStat.ino,
    mtimeNs: publishedStat.mtimeNs,
  });
  expect(await f.coldRows()).toEqual(prefix);
  expect(readFileSync(f.path, 'utf8')).toBe(content);
  const replay = await f.update(content); // Explicit new public request keeps the original stale CAS.
  expect(replay.status).toBe(409);
  await expect(replay.json()).resolves.toMatchObject({ code: 'config_revision_conflict' });
  expect(f.rows()).toEqual(prefix);
  expect(statSync(f.path, { bigint: true })).toMatchObject({
    ino: publishedStat.ino,
    mtimeNs: publishedStat.mtimeNs,
  });
});

it('real second INSERT refusal stops the Audit prefix but cannot roll back the authored file', async () => {
  const f = await fixture(['gamma', 'alpha', 'beta']);
  // Deliberate fault after valid owner setup: real SQLite rejects only beta, on either writer.
  f.workspaceDb.sqlite.exec(`CREATE TRIGGER synthetic_authority_refusal BEFORE INSERT ON audit_events
    WHEN NEW.action = '${ACTION}' AND NEW.resource = 'data-source-catalog:beta'
    BEGIN SELECT RAISE(ABORT, 'synthetic-authority-refusal'); END`);
  onTestFinished(() => {
    if (f.workspaceDb.sqlite.open)
      f.workspaceDb.sqlite.exec('DROP TRIGGER IF EXISTS synthetic_authority_refusal');
  });
  const content = catalog(['gamma', 'alpha', 'beta'], true);
  f.arm([0], content);
  const result = f.update(content);
  await held(0, result, { ...f, content });
  expect(readFileSync(f.path, 'utf8')).toBe(content);
  expectOriginal(f.events()[0], f, 'alpha');
  const prefix = f.rows();
  release(0);
  expect((await result).status).toBe(500);
  expect(f.rows()).toEqual(prefix);
  expect(readFileSync(f.path, 'utf8')).toBe(content);
  expect(await f.coldRows()).toEqual(prefix);
});

it('unchanged and non-authority source edits and non-data-source edits add no authority Audit', async () => {
  const f = await fixture();
  expect((await f.update(f.original)).status).toBe(200);
  const after = await f.read();
  const content = `${JSON.stringify({ schemaVersion: 1, sources: [{ ...source('alpha'), displayName: 'Renamed only', locator: { bucket: 'synthetic-other-locator' } }] })}\n`;
  expect((await f.update(content, after.file.revision)).status).toBe(200);
  expect(f.rows()).toEqual([]);
  const workspaceFileId = `workspaces/${f.workspaceId}/workspace.jsonc`;
  const config = await f.read(workspaceFileId);
  const response = await f.request('runtime.file-update', {
    id: workspaceFileId,
    kind: 'workspace',
    expectedRevision: config.file.revision,
    content: `${config.content}\n// Non-data-source edit.\n`,
  });
  expect(response.status).toBe(200);
  expect(f.rows()).toEqual([]);
  expect(await f.coldRows()).toEqual([]);
});

it('current canonical actor refusal precedes file publication and authority Audit', async () => {
  const f = await fixture();
  f.disableActor();
  const posts = fault.messages.length;
  const response = await f.update(catalog(['alpha'], true));
  expect(response.status).toBe(401);
  expect(readFileSync(f.path, 'utf8')).toBe(f.original);
  expect(f.rows()).toEqual([]);
  expect(fault.messages.length).toBe(posts);
});

it('stale revision refuses before file publication or authority Audit', async () => {
  const f = await fixture();
  const content = `${f.original}\n// current authored revision\n`;
  expect((await f.update(content)).status).toBe(200);
  const result = await f.update(catalog(['alpha'], true));
  expect(result.status).toBe(409);
  await expect(result.json()).resolves.toMatchObject({ code: 'config_revision_conflict' });
  expect(readFileSync(f.path, 'utf8')).toBe(content);
  expect(f.rows()).toEqual([]);
});
