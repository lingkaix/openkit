import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId, isEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createApp } from '../app.js';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  getOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import {
  loadWorkspaceResourceCatalog,
  readWorkspaceSkillSnapshot,
  validateCatalogTree,
} from '../catalog/resource-catalog.js';
import { FsStore } from '../lib/store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { stageArtifactPayload } from './artifacts/file-payload.js';
import { artifactFilePayloadPath } from './artifacts/file-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { STANDALONE_AUDIT_STAGES } from './standalone-audit-codecs.js';

// L2: real public submission, retained Artifact source, native Workspace Audit and physical Catalog.
// Skill Catalog, Candidates And Review / Storage, Publication, And Recovery; Core Storage, SQLite Layers.
const fault = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  messages: [] as unknown[],
  gate: new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
  request: new SharedArrayBuffer(36),
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
        // Reuse the real standalone-Audit COMMIT observer, excluding rows inserted earlier on Main.
        const prelude = `
          const {workerData} = require('node:worker_threads');
          const Database = require(workerData.auditSqlModule);
          const originalExec = Database.prototype.exec;
          const gate = workerData.auditGate;
          const before = new WeakMap();
          const inserted = new WeakSet();
          function hasAdmission(db) {
            if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='audit_events' AND type='table'").get()) return false;
            return !!db.prepare('SELECT 1 FROM audit_events WHERE request_id=? AND action=?').get(
              Buffer.from(workerData.auditRequest).toString('ascii'), 'catalog.skill-candidate-submit.admit');
          }
          Database.prototype.exec = function(sql) {
            const armed = Atomics.load(gate, 1) === 1;
            if (armed && sql === 'SAVEPOINT control_transition') before.set(this, hasAdmission(this));
            const result = originalExec.call(this, sql);
            if (armed && sql === 'RELEASE control_transition' && before.get(this) === false && hasAdmission(this))
              inserted.add(this);
            if (/^COMMIT$/i.test(sql) && inserted.has(this) &&
                Atomics.compareExchange(gate, 1, 1, 0) === 1) {
              Atomics.store(gate, 3, this.pragma('synchronous', {simple:true}));
              Atomics.store(gate, 4, workerData.auditWorkerIndex);
              Atomics.store(gate, 0, 1);
              Atomics.notify(gate, 0);
              Atomics.wait(gate, 2, 0);
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
            auditRequest: new Uint8Array(fault.request),
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

const tree = [
  {
    kind: 'file' as const,
    path: 'SKILL.md',
    executable: false,
    contentBase64: Buffer.from(
      '---\nname: native-candidate\ndescription: Synthetic native candidate.\n---\nExact synthetic instructions.\n'
    ).toString('base64'),
  },
];

/** Always release the real native hold and cancel a losing pending observer during cleanup. */
function release() {
  const gate = new Int32Array(fault.gate);
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
  if (Atomics.compareExchange(gate, 0, 0, -1) === 0) Atomics.notify(gate, 0);
}

/** Reuse the real public Artifact-origin fixture; file mode uses its existing physical payload owner. */
async function fixture(file = false) {
  release();
  const dataRoot = mkdtempSync(join(tmpdir(), 'catalog-submit-native-audit-'));
  const coreDb = openCoreDb(dataRoot);
  let pending: Promise<Response> | undefined;
  let reader: ReturnType<typeof openWorkspaceDb> | undefined;
  onTestFinished(async () => {
    release();
    await pending?.catch(() => undefined);
    await shutdownControlStoreWorkerClient();
    if (reader?.sqlite.open) reader.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Synthetic native Skill');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = await store.createThread(
    workspace.id,
    'Synthetic producing work',
    undefined,
    'conversation',
    { visibility: 'workspace' }
  );
  const turn = await store.createTurn(
    workspace.id,
    thread.id,
    'Prepare a candidate only.',
    { kind: 'user', id: userId },
    null,
    { agentId: 'ag_synthetic_native' }
  );
  const body = JSON.stringify(tree);
  const contentDigest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  const admission = new FileStorageAdmission(dataRoot, () => 0n);
  const reservation = file
    ? admission.reserve({
        stagingBytes: BigInt(Buffer.byteLength(body)),
        extractionBytes: 0n,
        derivativeBytes: 0n,
        publicationBytes: BigInt(Buffer.byteLength(body)),
      })
    : undefined;
  const staged = reservation
    ? await stageArtifactPayload({
        workspaceRoot,
        reservation,
        source: Readable.from([Buffer.from(body)]),
        expectedByteLength: Buffer.byteLength(body),
        expectedDigest: contentDigest,
      })
    : undefined;
  const artifact = await (async () => {
    try {
      return await store.createArtifact(
        {
          id: allocateEntityId('ar'),
          workspaceId: workspace.id,
          threadId: thread.id,
          turnId: turn.id,
          kind: 'file',
          title: 'Synthetic candidate',
          status: 'ready',
          summary: null,
          version: 1,
          content: file
            ? { format: 'file', mediaType: 'application/json', byteLength: Buffer.byteLength(body) }
            : { format: 'json', body },
          contentDigest,
          lastMutationRequestId: 'synthetic-output',
          origin: {
            kind: 'turn-output',
            threadId: thread.id,
            turnId: turn.id,
            requestId: 'synthetic-output',
          },
          createdAt: '2026-10-16T00:00:00Z',
          updatedAt: '2026-10-16T00:00:00Z',
        },
        staged
      );
    } finally {
      await staged?.remove();
      reservation?.release();
    }
  })();
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'workspace',
    workspaceIds: [workspace.id],
    expiresAt: '2099-01-01T00:00:00Z',
  });
  const app = await createApp({
    coreDb,
    dataRoot,
    store,
    mode: 'server',
    auth: {
      api: { getSession: async () => null },
      handler: async () => new Response(null, { status: 404 }),
    },
  });
  const input = {
    workspaceId: workspace.id,
    skillId: 'native-candidate',
    expectedRevision: 0,
    baseDigest: null,
    requestId: randomUUID(),
    summary: 'Synthetic native submission.',
    artifact: { artifactId: artifact.id, version: artifact.version, contentDigest },
  };
  reader = openWorkspaceDb(dataRoot, workspace.id);
  const db = reader;
  const rows = (connection = db) => ({
    audits: connection.sqlite
      .prepare('SELECT * FROM audit_events WHERE request_id=? ORDER BY audit_event_id')
      .all(input.requestId),
    receipts: connection.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .all(input.requestId),
  });
  return {
    coreDb,
    dataRoot,
    workspace,
    thread,
    turn,
    artifact,
    token,
    userId,
    store,
    input,
    db,
    rows,
    payload: file ? artifactFilePayloadPath(workspaceRoot, artifact.id, artifact.version) : null,
    digest: validateCatalogTree(tree).digest,
    catalog: () => loadWorkspaceResourceCatalog(dataRoot, workspace.id),
    events: () =>
      listWorkspaceAuditEvents(db, workspace.id).filter(
        (event) => event.requestId === input.requestId
      ),
    start() {
      const gate = new Int32Array(fault.gate);
      gate.fill(0);
      new Uint8Array(fault.request).set(new TextEncoder().encode(input.requestId));
      Atomics.store(gate, 1, 1);
      pending = Promise.resolve(
        app.request(
          ...operationRequest(
            'catalog.skill-candidate-submit',
            {},
            {
              headers: { authorization: `Bearer ${token.secret}` },
              body: JSON.stringify(input),
            }
          )
        )
      );
      return pending;
    },
    async cold() {
      await shutdownControlStoreWorkerClient();
      const cold = openWorkspaceDb(dataRoot, workspace.id);
      try {
        cold.sqlite.pragma('query_only = ON');
        return rows(cold);
      } finally {
        cold.sqlite.close();
      }
    },
  };
}

/** An actual early OLD public result beats the native wait; no gate timeout is used as RED. */
async function held(result: Promise<Response>) {
  const gate = new Int32Array(fault.gate);
  const outcome = await Promise.race([
    Promise.resolve(Atomics.waitAsync(gate, 0, 0).value).then(() => 'held'),
    result.then((response) => `HTTP ${response.status} before native admission`),
  ]);
  expect(
    outcome,
    'Native admission must precede candidate publication and public completion.'
  ).toBe('held');
  expect(Atomics.load(gate, 0)).toBe(1);
  expect(Atomics.load(gate, 3)).toBe(2);
  return fault.workers[Atomics.load(gate, 4)]!;
}

/** Fix the complete original admission and selected producer lineage independently of the future codec. */
function admission(f: Awaited<ReturnType<typeof fixture>>) {
  const events = f.events();
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({
    id: expect.any(String),
    workspaceId: f.workspace.id,
    threadId: f.thread.id,
    turnId: f.turn.id,
    itemId: null,
    capabilityCallId: null,
    permissionDecisionId: null,
    vaultGrantId: null,
    requestId: f.input.requestId,
    actor: { kind: 'user', id: f.userId },
    subject: null,
    agentId: 'ag_synthetic_native',
    agentSessionId: null,
    category: 'system',
    action: 'catalog.skill-candidate-submit.admit',
    resource: `skill:${f.input.skillId}@${f.digest}`,
    resourceRevision: null,
    outcome: 'succeeded',
    severity: 'info',
    summary: `Skill candidate admission from none to ${f.digest}.`,
    errorCode: null,
    createdAt: expect.any(String),
    occurredAt: expect.any(String),
  });
  expect(isEntityId('aud', events[0]!.id)).toBe(true);
  expect(Number.isFinite(Date.parse(events[0]!.createdAt))).toBe(true);
  expect(Number.isFinite(Date.parse(events[0]!.occurredAt))).toBe(true);
  expect(f.rows().receipts).toEqual([]);
  return events[0]!;
}

it('acknowledges exact native admission before publishing the inactive candidate and original evidence', async () => {
  const f = await fixture();
  const before = f.catalog();
  let settled = false;
  const result = f.start();
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await held(result);
  expect(settled).toBe(false);
  const original = admission(f);
  expect(f.catalog()).toEqual(before);
  release();
  const response = await result;
  expect(response.status).toBe(201);
  const submitted = await response.json();
  const catalog = f.catalog();
  expect(catalog.skills.candidates).toHaveLength(1);
  const candidate = catalog.skills.candidates[0]!;
  expect(candidate).toMatchObject({
    id: submitted.candidate.id,
    disposition: 'proposed',
    decision: null,
    candidateDigest: f.digest,
    producer: { kind: 'agent', id: 'ag_synthetic_native' },
    submitter: { kind: 'user', id: f.userId },
  });
  expect(candidate.evidenceRefs).toEqual([
    `artifact:${JSON.stringify({ workspaceId: f.workspace.id, ...f.input.artifact })}`,
    `turn:${JSON.stringify({
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      turnId: f.turn.id,
      agentId: 'ag_synthetic_native',
      triggerActor: { kind: 'user', id: f.userId },
    })}`,
  ]);
  expect(catalog.revision).toBe(before.revision + 1);
  expect(catalog.skills.entries[0]?.currentDigest).toBeNull();
  expect(catalog.skills.pins).toEqual([]);
  expect(f.events()).toHaveLength(2);
  expect(f.events().find((event) => event.action === original.action)).toEqual(original);
  expect(
    f.events().find((event) => event.action === 'catalog.skill-candidate-submit')
  ).toMatchObject({
    actor: { kind: 'user', id: f.userId },
    resource: `skill-candidate:${candidate.id}`,
    resourceRevision: catalog.revision,
    outcome: 'succeeded',
  });
  expect(f.rows().receipts).toHaveLength(1);
  expect(
    f.store.getCommandRequest(
      'catalog.skill-candidate-submit',
      f.input.requestId,
      { workspaceId: f.workspace.id, actorId: f.userId },
      f.db
    )?.response
  ).toEqual({
    kind: 'skill_candidate',
    id: candidate.id,
  });
  const rows = f.rows();
  expect(await f.cold()).toEqual(rows);
  expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(catalog);
  expect(
    readWorkspaceSkillSnapshot({
      dataRoot: f.dataRoot,
      workspaceId: f.workspace.id,
      entryId: f.input.skillId,
      digest: f.digest,
    }).entries[0]?.content?.toString('base64')
  ).toBe(tree[0]!.contentBase64);
  expect([...STANDALONE_AUDIT_STAGES].sort()).toEqual([
    'administration.configuration.apply',
    'administration.server-mcp-create',
    'administration.server-mcp-remove',
    'administration.server-mcp-select-version',
    'administration.server-mcp-stage-version',
    'administration.server-mcp-update-binding',
    'app.update.start',
    'app.update.start.handoff',
    'auth.bootstrap.consume',
    'auth.token.issue',
    'auth.token.revoke',
    'auth.token.rotate',
    'catalog.light-app-history-import',
    'catalog.light-app-import',
    'catalog.light-app-pin',
    'catalog.light-app-select',
    'catalog.mcp-binding',
    'catalog.mcp-create',
    'catalog.mcp-remove',
    'catalog.mcp-select',
    'catalog.mcp-stage-version',
    'catalog.plugin-import',
    'catalog.shared-mcp-set-disabled',
    'catalog.skill-candidate-decide',
    'catalog.skill-candidate-decide.admit',
    'catalog.skill-candidate-submit',
    'catalog.skill-candidate-submit.admit',
    'catalog.skill-candidate-withdraw',
    'catalog.skill-candidate-withdraw.admit',
    'catalog.skill-import',
    'catalog.skill-import.admit',
    'catalog.skill-pin',
    'catalog.skill-pin.admit',
    'catalog.skill-purge',
    'catalog.skill-purge.admit',
    'catalog.skill-remove',
    'catalog.skill-remove.admit',
    'catalog.skill-select',
    'catalog.skill-select.admit',
    'data_source_catalog.authority.update',
    'mcp.server.lifecycle.degraded',
    'mcp.server.lifecycle.failed',
    'mcp.server.lifecycle.inactive',
    'mcp.server.lifecycle.ready',
    'mcp.server.lifecycle.starting',
    'policy.write',
    'scheduler.admission.cancel',
    'scheduler.admission.retry',
  ]);
});

it('retains actual committed admission after lost ACK without a candidate, receipt or repost', async () => {
  const f = await fixture();
  const before = f.catalog();
  const result = f.start();
  const worker = await held(result);
  admission(f);
  expect(f.catalog()).toEqual(before);
  const prefix = f.rows();
  const posts = fault.messages.length;
  const workers = fault.workers.length;
  await worker.terminate();
  expect((await result).status).toBe(500);
  expect(fault.messages.length).toBe(posts);
  expect(fault.workers.length).toBe(workers);
  expect(f.catalog()).toEqual(before);
  expect(f.rows()).toEqual(prefix);
  expect(await f.cold()).toEqual(prefix);
});

it('refuses authority revoked during admission ACK before physical candidate publication', async () => {
  const f = await fixture();
  const before = f.catalog();
  const result = f.start();
  await held(result);
  admission(f);
  const prefix = f.rows();
  revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
  expect(getOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId)?.status).toBe('revoked');
  const posts = fault.messages.length;
  release();
  const response = await result;
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({ code: 'catalog_forbidden' });
  expect(fault.messages.length).toBe(posts);
  expect(f.catalog()).toEqual(before);
  expect(f.rows()).toEqual(prefix);
  expect(await f.cold()).toEqual(prefix);
});

it('revalidates actual selected file bytes after admission ACK rather than publishing cached input', async () => {
  const f = await fixture(true);
  const before = f.catalog();
  const result = f.start();
  await held(result);
  admission(f);
  const prefix = f.rows();
  const original = readFileSync(f.payload!);
  const changed = Buffer.from(original);
  const index = original.indexOf(Buffer.from('SKILL.md'));
  expect(index).toBeGreaterThanOrEqual(0);
  changed[index] = 's'.charCodeAt(0);
  writeFileSync(f.payload!, changed); // Deliberate corruption only after valid owner publication/admission.
  expect(readFileSync(f.payload!)).toEqual(changed);
  expect(changed.byteLength).toBe(original.byteLength);
  expect(changed.equals(original)).toBe(false);
  expect(() => JSON.parse(changed.toString('utf8'))).not.toThrow();
  const posts = fault.messages.length;
  release();
  const response = await result;
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toMatchObject({ code: 'source_unavailable' });
  expect(fault.messages.length).toBe(posts);
  expect(f.catalog()).toEqual(before);
  expect(f.rows()).toEqual(prefix);
  expect(await f.cold()).toEqual(prefix);
});
