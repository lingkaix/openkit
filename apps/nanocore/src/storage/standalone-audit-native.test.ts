import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listWorkspaceAuditEvents, prepareWorkspaceAuditEvent } from '../audit-events.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import {
  createCatalogOperationImplementations,
  prepareCatalogSkillDecision,
} from '../catalog/catalog-operations.js';
import {
  loadWorkspaceResourceCatalog,
  submitWorkspaceSkillCandidate,
} from '../catalog/resource-catalog.js';
import { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import type { InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import {
  ControlStandaloneAuditInputSchema,
  STANDALONE_AUDIT_STAGES,
} from './standalone-audit-codecs.js';

// L2: real catalog admission -> physical Workspace DatabaseOwner -> actual FULL COMMIT.
// Owners: Storage, SQLite Layers; Durable Execution, Commit Rule and Scope Layout;
// Skill Catalog, Storage, Publication, And Recovery. A refusal alone cannot prove the durable prefix.
const fault = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  messages: [] as Array<{ operation?: string }>,
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
        // Execute the real SQL first, then withhold only its return to the Worker acknowledgement path.
        const prelude = `
          const {workerData} = require('node:worker_threads');
          const Database = require(workerData.auditSqlModule);
          const originalExec = Database.prototype.exec;
          const gate = workerData.auditGate;
          Database.prototype.exec = function(sql) {
            const result = originalExec.call(this, sql);
            if (!/^COMMIT$/i.test(sql) || Atomics.load(gate, 1) === 0) return result;
            if (!this.prepare("SELECT 1 FROM sqlite_master WHERE name='audit_events' AND type='table'").get()) return result;
            const request = Buffer.from(workerData.auditRequest).toString('ascii');
            const rows = this.prepare('SELECT action FROM audit_events WHERE request_id=?').all(request);
            if (rows.some(row => row.action === 'catalog.skill-candidate-decide.admit'
                || row.action === 'catalog.skill-candidate-withdraw.admit')
                && Atomics.compareExchange(gate, 0, 0, 1) === 0) {
              Atomics.store(gate, 3, this.pragma('synchronous', {simple:true}));
              Atomics.store(gate, 4, workerData.auditWorkerIndex);
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

const cases = [
  { operation: 'catalog.skill-candidate-decide', decision: 'rejected' },
  { operation: 'catalog.skill-candidate-withdraw', decision: 'withdrawn' },
] as const;

/** Release the native COMMIT hold even when an assertion fails. */
function release() {
  const gate = new Int32Array(fault.gate);
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
}

/** Initialize canonical identity, membership, catalog and databases through their real owners. */
async function fixture() {
  release();
  const dataRoot = mkdtempSync(join(tmpdir(), 'standalone-audit-native-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Standalone Audit');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const connections: ReturnType<typeof openWorkspaceDb>[] = [];
  let readOnly = false;
  const repositoryWorkspaceDb = (workspaceId: string) => {
    const db = openWorkspaceDb(dataRoot, workspaceId);
    if (readOnly) db.sqlite.pragma('query_only = ON');
    connections.push(db);
    return db;
  };
  const workspaceDb = repositoryWorkspaceDb(workspace.id);
  applyScopedMigrations(workspaceDb);
  const context: AdmittedOperationContext = {
    kind: 'public',
    actor: { kind: 'local', userId },
    actorRef: { kind: 'user', id: userId },
    scope: { kind: 'workspace', workspaceId: workspace.id },
  };
  const dependencies = {
    dataRoot,
    coreDb,
    store,
    repositoryWorkspaceDb,
    inflightCommands: new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>(),
  };
  const implementations = createCatalogOperationImplementations(dependencies, {
    prepareSkillDecision: (input, admitted) =>
      prepareCatalogSkillDecision(dependencies, input, admitted),
  });
  onTestFinished(async () => {
    release();
    await shutdownControlStoreWorkerClient();
    for (const db of connections) if (db.sqlite.open) db.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const rows = (requestId: string) => ({
    audits: workspaceDb.sqlite
      .prepare('SELECT * FROM audit_events WHERE request_id=?')
      .all(requestId),
    receipts: workspaceDb.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .all(requestId),
  });
  return {
    dataRoot,
    coreDb,
    store,
    userId,
    workspaceDb,
    workspaceId: workspace.id,
    context,
    dependencies,
    implementations,
    repositoryWorkspaceDb,
    rows,
    queryOnly() {
      readOnly = true;
      for (const db of [coreDb, ...connections]) {
        db.sqlite.pragma('query_only = ON');
        expect(db.sqlite.pragma('query_only', { simple: true })).toBe(1);
      }
    },
  };
}

/** Catch rejection before deliberately terminating the real native host. */
function observed<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
}

it.each(
  cases
)('preserves original $operation admission facts with Main query-only and cold reopen', async ({
  operation,
  decision,
}) => {
  const f = await fixture();
  f.queryOnly();
  const requestId = randomUUID();
  const candidateId = allocateEntityId('cand');
  const result = await prepareCatalogSkillDecision(
    f.dependencies,
    {
      operation,
      decision,
      requestId,
      candidateId,
      workspaceId: f.workspaceId,
      expectedRevision: 7,
    },
    f.context
  );
  const events = listWorkspaceAuditEvents(f.workspaceDb, f.workspaceId).filter(
    (event) => event.requestId === requestId
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({
    id: result.auditRef,
    workspaceId: f.workspaceId,
    threadId: null,
    turnId: null,
    itemId: null,
    capabilityCallId: null,
    permissionDecisionId: null,
    vaultGrantId: null,
    requestId,
    actor: { kind: 'user', id: f.userId },
    subject: null,
    agentId: null,
    agentSessionId: null,
    category: 'system',
    action: `${operation}.admit`,
    resource: `skill-candidate:${candidateId}`,
    resourceRevision: 7,
    outcome: 'succeeded',
    severity: 'info',
    summary: `Human Skill candidate ${decision} admission.`,
    errorCode: null,
    createdAt: expect.any(String),
    occurredAt: expect.any(String),
  });
  expect(result.actor).toEqual({ kind: 'user', id: f.userId });
  expect(Date.parse(result.decidedAt)).toBeGreaterThanOrEqual(Date.parse(events[0]!.createdAt));
  const original = f.rows(requestId);
  expect(original.receipts).toEqual([]); // This original standalone stage owns no command receipt.
  await shutdownControlStoreWorkerClient();
  const cold = f.repositoryWorkspaceDb(f.workspaceId);
  expect(cold.sqlite.pragma('query_only', { simple: true })).toBe(1);
  expect(
    listWorkspaceAuditEvents(cold, f.workspaceId).filter((event) => event.requestId === requestId)
  ).toEqual(events);
  expect(
    cold.sqlite.prepare('SELECT * FROM audit_events WHERE request_id=?').all(requestId)
  ).toEqual(original.audits);
});

it('publishes the original Audit identity and timestamps without adding a receipt', async () => {
  expect(STANDALONE_AUDIT_STAGES).toEqual([
    'catalog.skill-candidate-decide.admit',
    'catalog.skill-candidate-withdraw.admit',
    'catalog.skill-candidate-submit.admit',
    'catalog.skill-candidate-submit',
    'catalog.skill-candidate-decide',
    'catalog.skill-candidate-withdraw',
    'catalog.light-app-import',
    'catalog.light-app-history-import',
    'catalog.light-app-select',
    'catalog.light-app-pin',
    'data_source_catalog.authority.update',
    'app.update.start',
    'app.update.start.handoff',
    'administration.server-mcp-create',
    'administration.server-mcp-stage-version',
    'administration.server-mcp-select-version',
    'administration.server-mcp-update-binding',
    'administration.server-mcp-remove',
    'catalog.mcp-create',
    'catalog.mcp-stage-version',
    'catalog.mcp-remove',
    'catalog.mcp-select',
    'catalog.mcp-binding',
    'catalog.plugin-import',
    'auth.bootstrap.consume',
    'auth.token.issue',
    'auth.token.revoke',
    'auth.token.rotate',
    'policy.write',
    'administration.configuration.apply',
    'mcp.server.lifecycle.degraded',
    'mcp.server.lifecycle.failed',
    'mcp.server.lifecycle.inactive',
    'mcp.server.lifecycle.ready',
    'mcp.server.lifecycle.starting',
  ]);
  const f = await fixture();
  f.queryOnly();
  const auditEventId = allocateEntityId('aud');
  const requestId = randomUUID();
  const now = new Date('2026-10-19T01:02:03.000Z');
  const occurredAt = new Date('2026-10-19T00:02:03.000Z');
  const event = prepareWorkspaceAuditEvent({
    workspaceDb: f.workspaceDb,
    workspaceId: f.workspaceId,
    action: 'catalog.skill-candidate-decide.admit',
    auditEventId,
    requestId,
    actor: f.context.actorRef,
    resource: 'skill-candidate:cand_original',
    resourceRevision: null,
    outcome: 'succeeded',
    summary: 'Human Skill candidate rejected admission.',
    now,
    occurredAt,
  });
  await getControlStoreWorkerClient().standaloneAudit(f.workspaceDb, {
    workspaceId: f.workspaceId,
    stage: 'catalog.skill-candidate-decide.admit',
    event,
  });
  expect(event).toMatchObject({
    id: auditEventId,
    requestId,
    createdAt: now.toISOString(),
    occurredAt: occurredAt.toISOString(),
    resourceRevision: null,
  });
  expect(
    listWorkspaceAuditEvents(f.workspaceDb, f.workspaceId).filter(
      (stored) => stored.requestId === requestId
    )
  ).toEqual([event]);
  expect(f.rows(requestId).receipts).toEqual([]);
});

it.each([
  'unknown-stage',
  'mismatched-action',
  'wrong-workspace',
  'forged-physical-owner',
] as const)('refuses $0 without any Audit or receipt', async (invalid) => {
  const f = await fixture();
  const sibling = await f.store.createWorkspace('Sibling');
  const siblingDb = f.repositoryWorkspaceDb(sibling.id);
  applyScopedMigrations(siblingDb);
  const siblingBefore = listWorkspaceAuditEvents(siblingDb, sibling.id);
  const requestId = randomUUID();
  const event = prepareWorkspaceAuditEvent({
    workspaceDb: f.workspaceDb,
    workspaceId: f.workspaceId,
    action: 'catalog.skill-candidate-decide.admit',
    requestId,
    actor: { kind: 'user', id: f.userId },
    resource: `skill-candidate:${allocateEntityId('cand')}`,
    outcome: 'succeeded' as const,
    summary: 'Human Skill candidate rejected admission.',
  });
  const base = {
    workspaceId: f.workspaceId,
    stage: 'catalog.skill-candidate-decide.admit' as const,
    event,
  };
  expect(ControlStandaloneAuditInputSchema.safeParse(base).success).toBe(true);
  // Runtime refusal must protect the owner even from an untyped in-process caller.
  const attempt = {
    ...base,
    ...(invalid === 'unknown-stage' ? { stage: 'catalog.mcp-create' } : {}),
    ...(invalid === 'mismatched-action'
      ? { event: { ...event, action: 'catalog.skill-candidate-withdraw.admit' } }
      : {}),
    ...(invalid === 'wrong-workspace' ? { workspaceId: sibling.id } : {}),
  };
  const owner =
    invalid === 'forged-physical-owner'
      ? { ...siblingDb, workspaceId: f.workspaceId }
      : f.workspaceDb;
  await expect(
    getControlStoreWorkerClient().standaloneAudit(
      owner,
      attempt as Parameters<ReturnType<typeof getControlStoreWorkerClient>['standaloneAudit']>[1]
    )
  ).rejects.toThrow();
  expect(f.rows(requestId)).toEqual({ audits: [], receipts: [] });
  expect(listWorkspaceAuditEvents(siblingDb, sibling.id)).toEqual(siblingBefore);
});

it.each(cases)('keeps current authority checks before $operation publication', async ({
  operation,
  decision,
}) => {
  const f = await fixture();
  f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.userId))();
  const requestId = randomUUID();
  const posts = fault.messages.length;
  await expect(
    Promise.resolve().then(() =>
      prepareCatalogSkillDecision(
        f.dependencies,
        {
          operation,
          decision,
          requestId,
          candidateId: allocateEntityId('cand'),
          workspaceId: f.workspaceId,
          expectedRevision: 1,
        },
        f.context
      )
    )
  ).rejects.toThrow('Current Skill decision authority is unavailable.');
  expect(f.rows(requestId)).toEqual({ audits: [], receipts: [] });
  expect(fault.messages).toHaveLength(posts);
});

it.each(
  cases
)('lost admission FULL ACK suppresses $operation candidate publication and any repost', async ({
  operation,
}) => {
  const f = await fixture();
  const submitted = submitWorkspaceSkillCandidate({
    dataRoot: f.dataRoot,
    workspaceId: f.workspaceId,
    entryId: 'audit-only',
    baseDigest: null,
    expectedRevision: 0,
    createdAt: '2026-10-19T00:00:00.000Z',
    producer: { kind: 'user', id: f.userId },
    summary: 'An inactive candidate for admission failure.',
    tree: [
      {
        kind: 'file',
        path: 'SKILL.md',
        contentBase64: Buffer.from(
          '---\nname: audit-only\ndescription: Audit admission fixture.\n---\nKeep candidate inactive.\n'
        ).toString('base64'),
      },
    ],
  });
  const before = loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId);
  const requestId = randomUUID();
  const gate = new Int32Array(fault.gate);
  gate.fill(0);
  new Uint8Array(fault.request).set(new TextEncoder().encode(requestId));
  Atomics.store(gate, 1, 1);
  const input = {
    workspaceId: f.workspaceId,
    candidateId: submitted.candidate.id,
    expectedRevision: 1,
    requestId,
  };
  const result = observed(
    operation === 'catalog.skill-candidate-decide'
      ? f.implementations[operation]({ ...input, decision: 'rejected' }, f.context)
      : f.implementations[operation](input, f.context)
  );
  await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
  expect(Atomics.load(gate, 3)).toBe(2); // SQLite FULL after actual COMMIT, before any ACK.
  const prefix = f.rows(requestId);
  expect(prefix.audits).toHaveLength(1);
  expect(prefix.audits[0]).toMatchObject({ action: `${operation}.admit`, request_id: requestId });
  expect(prefix.receipts).toEqual([]);
  expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toEqual(before);
  const posts = fault.messages.length;
  const workers = fault.workers.length;
  await fault.workers[Atomics.load(gate, 4)]!.terminate();
  expect(await result).toMatchObject({ ok: false, error: { commit: 'unknown' } });
  expect(fault.messages).toHaveLength(posts);
  expect(fault.workers).toHaveLength(workers);
  expect(f.rows(requestId)).toEqual(prefix);
  expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toEqual(before);
  await shutdownControlStoreWorkerClient();
  const cold = f.repositoryWorkspaceDb(f.workspaceId);
  expect(
    cold.sqlite.prepare('SELECT * FROM audit_events WHERE request_id=?').all(requestId)
  ).toEqual(prefix.audits);
  expect(
    cold.sqlite.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').all(requestId)
  ).toEqual([]);
});

it.each(
  cases
)('refuses $operation when current authority is lost during admission FULL acknowledgement', async ({
  operation,
}) => {
  const f = await fixture();
  const submitted = submitWorkspaceSkillCandidate({
    dataRoot: f.dataRoot,
    workspaceId: f.workspaceId,
    entryId: 'audit-authority',
    baseDigest: null,
    expectedRevision: 0,
    createdAt: '2026-10-19T00:00:00.000Z',
    producer: { kind: 'user', id: f.userId },
    summary: 'An inactive candidate for current authority loss.',
    tree: [
      {
        kind: 'file',
        path: 'SKILL.md',
        contentBase64: Buffer.from(
          '---\nname: audit-authority\ndescription: Current authority fixture.\n---\nKeep candidate inactive.\n'
        ).toString('base64'),
      },
    ],
  });
  const before = loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId);
  const requestId = randomUUID();
  const gate = new Int32Array(fault.gate);
  gate.fill(0);
  new Uint8Array(fault.request).set(new TextEncoder().encode(requestId));
  Atomics.store(gate, 1, 1);
  const input = {
    workspaceId: f.workspaceId,
    candidateId: submitted.candidate.id,
    expectedRevision: 1,
    requestId,
  };
  const result = observed(
    operation === 'catalog.skill-candidate-decide'
      ? f.implementations[operation]({ ...input, decision: 'rejected' }, f.context)
      : f.implementations[operation](input, f.context)
  );
  await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
  expect(Atomics.load(gate, 3)).toBe(2);
  const prefix = f.rows(requestId);
  expect(prefix.audits).toHaveLength(1);
  expect(prefix.audits[0]).toMatchObject({ action: `${operation}.admit`, request_id: requestId });
  expect(prefix.receipts).toEqual([]);
  expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toEqual(before);
  // Cross-scope authority changes after durable admission, while its real ACK is still withheld.
  f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.userId))();
  const posts = fault.messages.length;
  const workers = fault.workers.length;
  release();
  expect(await result).toMatchObject({ ok: false, error: { code: 'catalog_forbidden' } });
  expect(fault.messages).toHaveLength(posts);
  expect(fault.workers).toHaveLength(workers);
  expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toEqual(before);
  expect(f.rows(requestId)).toEqual(prefix);
});
