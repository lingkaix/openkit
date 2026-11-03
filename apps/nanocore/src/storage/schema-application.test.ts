import { randomBytes, randomUUID } from 'node:crypto';
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
import type { WorkerOptions } from 'node:worker_threads';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { canonicalJsonText, writeRetainedV1 } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import Database from 'better-sqlite3';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listSqliteAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  type OpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import {
  currentWorkspaceAuthority,
  isCurrentServerPolicyAuthor,
  readCurrentWorkspacePolicy,
} from '../auth/operation-authorizer.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { isScopeAdmitted, refuseScope, scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createRuntimeConfigManager, findWorkspaceConfig } from '../config/runtime-config.js';
import { readWorkspaceNotebookSelection } from '../knowledge/notebook-workspace-selection.js';
import { commandRequestExpiresAt, commandRequestKey } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  workspaceMembershipDecisionFixture,
  writeManagedThreadPolicyFixture,
} from '../test-support/resource-policy.js';
import { closeTestCoreDb, createTestCoreDb, createTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  getWorkspaceMember,
  leaveWorkspace,
} from '../workspace-sharing.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  controlKnowledgeHeadStatements,
  prepareWorkspaceKnowledgeSelection,
  readControlKnowledgeHead,
} from './control-store-knowledge.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { isControlWorkerRequest } from './control-store-worker-protocol.js';
import { openWorkspaceDb, openWorkspaceReadDb } from './db.js';

/** Test-only custody of genuine native frames; it stores no Actor, credential or command payload. */
const schemaFreshness = vi.hoisted(() => ({
  database: undefined as string | undefined,
  historyRoot: undefined as string | undefined,
  mutate: undefined as (() => void | Promise<void>) | undefined,
  beforeDecision: undefined as (() => void) | undefined,
  holdPost: undefined as ((value: unknown, forward: () => void) => boolean) | undefined,
  dropAck: false,
  droppedAcks: [] as Array<{ id: number; operation: string }>,
  sqlFaultGate: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  sqlFaults: [] as Array<{ id: number; code: string }>,
  commitGate: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  commits: [] as Array<{
    id: number;
    phase: 'before' | 'after' | 'ack';
    synchronous?: number;
    files?: Array<{ path: string; hex: string }>;
  }>,
  phase: 'idle' as 'idle' | 'armed' | 'held' | 'receiving' | 'decided',
  injectionError: undefined as unknown,
  injections: 0,
  forecasts: [] as Array<{
    id: number;
    database: string;
    files: Array<{ path: string; publicationBytes: number }>;
  }>,
  posts: [] as Array<{ id: number; database: string; operation: string }>,
  decisions: [] as Array<{ id: number; database: string; decision: string; keys: string[] }>,
  failures: [] as Array<{ id: number; code: string; commit: string }>,
}));

// Hold the real forecast event before Main receives it. Owner reload can be asynchronous;
// all original requests, forecast objects, decisions, SQLite work and replies are forwarded.
vi.mock('node:worker_threads', async (load) => {
  const native = await load<typeof import('node:worker_threads')>();
  return {
    ...native,
    Worker: class extends native.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        // One real Worker hook also observes the original SQLite COMMIT. This is disabled
        // for the freshness rows; it adds no request, decision, wait or acknowledgement.
        const prelude = `
          const {parentPort,workerData}=require('node:worker_threads');
          const Database=require(workerData.schemaCapacityDatabaseModule);
          const readFileSync=require('node:fs').readFileSync;
          const gate=new Int32Array(workerData.schemaCapacityCommitGate);
          const sqlFaultGate=new Int32Array(workerData.schemaSqlFaultGate);
          const post=parentPort.postMessage.bind(parentPort);
          let forecast;
          parentPort.postMessage=function(value,...args) {
            if((Atomics.load(gate,0)===1 || Atomics.load(sqlFaultGate,0)===1) &&
              value && value.status==='physical-forecast') forecast=value;
            return post(value,...args);
          };
          // Observe only a genuine targeted SQLite trigger failure; execute the original
          // statement and rethrow its actual error. No synthetic SQL failure is returned.
          const prepare=Database.prototype.prepare;
          Database.prototype.prepare=function(sql) {
            const statement=prepare.call(this,sql);
            if(!/INSERT INTO idempotency_requests/.test(sql)) return statement;
            const run=statement.run;
            statement.run=function(...parameters) {
              try { return run.apply(this,parameters); }
              catch(error) {
                if(Atomics.load(sqlFaultGate,0)===1 && forecast &&
                  error.code==='SQLITE_CONSTRAINT_TRIGGER' &&
                  error.message==='schema-boundary-original-receipt')
                  post({schemaSqlFault:true,id:forecast.id,code:error.code});
                throw error;
              }
            };
            return statement;
          };
          const exec=Database.prototype.exec;
          Database.prototype.exec=function(sql) {
            const observed=Atomics.load(gate,0)===1 && forecast && /^COMMIT$/i.test(sql);
            if(!observed) return exec.call(this,sql);
            const selected=forecast; forecast=undefined;
            const files=selected.files.filter(file=>file.path.includes('/knowledge/schema/history/'))
              .map(file=>({path:file.path,hex:readFileSync(file.path).toString('hex')}));
            post({schemaCapacityCommit:true,id:selected.id,phase:'before',
              synchronous:Number(this.pragma('synchronous',{simple:true})),files});
            const result=exec.call(this,sql);
            post({schemaCapacityCommit:true,id:selected.id,phase:'after'});
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
            ...((options?.workerData ?? {}) as object),
            schemaCapacityDatabaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
            schemaCapacityCommitGate: schemaFreshness.commitGate,
            schemaSqlFaultGate: schemaFreshness.sqlFaultGate,
          },
        });
        const emit = this.emit.bind(this);
        this.emit = ((event: string | symbol, ...args: unknown[]) => {
          const value = args[0];
          if (event === 'message' && value !== null && typeof value === 'object') {
            const row = value as Record<string, unknown>;
            if (row.schemaSqlFault === true) {
              schemaFreshness.sqlFaults.push({ id: row.id as number, code: row.code as string });
              return true;
            }
            if (
              schemaFreshness.dropAck &&
              row.status === 'ok' &&
              typeof row.id === 'number' &&
              typeof row.operation === 'string' &&
              schemaFreshness.forecasts.some((forecast) => forecast.id === row.id)
            ) {
              schemaFreshness.droppedAcks.push({ id: row.id, operation: row.operation });
              schemaFreshness.dropAck = false;
              // Drop only this genuine post-COMMIT ACK, then cause the real channel exit.
              // Main must classify its original pending request; no reply is fabricated.
              void this.terminate();
              return true;
            }
            if (row.schemaCapacityCommit === true) {
              schemaFreshness.commits.push({
                id: row.id as number,
                phase: row.phase as 'before' | 'after',
                ...(row.synchronous === undefined
                  ? {}
                  : { synchronous: row.synchronous as number }),
                ...(row.files === undefined
                  ? {}
                  : {
                      files: row.files as Array<{ path: string; hex: string }>,
                    }),
              });
              return true;
            }
            if (
              row.status === 'ok' &&
              typeof row.id === 'number' &&
              Atomics.load(new Int32Array(schemaFreshness.commitGate), 0) === 1 &&
              schemaFreshness.forecasts.some((forecast) => forecast.id === row.id)
            )
              schemaFreshness.commits.push({ id: row.id, phase: 'ack' });
            if (
              schemaFreshness.phase === 'armed' &&
              row.status === 'physical-forecast' &&
              row.database === schemaFreshness.database &&
              typeof row.id === 'number' &&
              Array.isArray(row.files) &&
              row.files.some(
                (file: { path?: unknown }) =>
                  typeof file.path === 'string' &&
                  schemaFreshness.historyRoot !== undefined &&
                  file.path.startsWith(`${schemaFreshness.historyRoot}/`)
              )
            ) {
              schemaFreshness.forecasts.push({
                id: row.id,
                database: row.database as string,
                files: structuredClone(row.files),
              });
              schemaFreshness.phase = 'held';
              void Promise.resolve()
                .then(async () => {
                  schemaFreshness.injections += 1;
                  await schemaFreshness.mutate?.();
                })
                .catch((error: unknown) => {
                  schemaFreshness.injectionError = error;
                })
                .then(() => {
                  schemaFreshness.phase = 'receiving';
                  emit(event, ...args);
                });
              return true;
            }
            if (
              row.status === 'physical-forecast' &&
              row.database === schemaFreshness.database &&
              schemaFreshness.forecasts.some((forecast) => forecast.id === row.id)
            ) {
              // A second genuine forecast is observable, and must fail the one-exchange oracle.
              schemaFreshness.forecasts.push({
                id: row.id as number,
                database: row.database as string,
                files: structuredClone(
                  row.files as Array<{ path: string; publicationBytes: number }>
                ),
              });
            }
            if (
              row.status === 'error' &&
              schemaFreshness.forecasts.some((forecast) => forecast.id === row.id) &&
              typeof row.id === 'number' &&
              typeof row.code === 'string' &&
              typeof row.commit === 'string'
            )
              schemaFreshness.failures.push({ id: row.id, code: row.code, commit: row.commit });
          }
          return emit(event, ...args);
        }) as native.Worker['emit'];
        const postMessage = this.postMessage.bind(this);
        this.postMessage = ((...args: Parameters<native.Worker['postMessage']>) => {
          const value = args[0];
          if (value !== null && typeof value === 'object') {
            const row = value as Record<string, unknown>;
            if (
              schemaFreshness.phase !== 'idle' &&
              row.database === schemaFreshness.database &&
              typeof row.id === 'number' &&
              typeof row.operation === 'string'
            ) {
              if (row.operation === 'physical-forecast' && typeof row.decision === 'string') {
                schemaFreshness.decisions.push({
                  id: row.id,
                  database: row.database as string,
                  decision: row.decision,
                  keys: Object.keys(row).sort(),
                });
                try {
                  schemaFreshness.beforeDecision?.();
                } catch (error: unknown) {
                  schemaFreshness.injectionError = error;
                }
                schemaFreshness.phase = 'decided';
              } else {
                schemaFreshness.posts.push({
                  id: row.id,
                  database: row.database as string,
                  operation: row.operation,
                });
              }
            }
          }
          if (schemaFreshness.holdPost?.(value, () => postMessage(...args))) return;
          return postMessage(...args);
        }) as native.Worker['postMessage'];
      }
    },
  };
});

it('applies only a reviewed complete schema report and respects an existing external freeze', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'schema-application-'));
  const coreDb = createTestCoreDb(dataRoot);
  const userId = ensureLocalUser(coreDb);
  let store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Reviewed schema application');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const admission = new WorkspaceMutationAdmission();
  let app = createAppWithLocalIdentity({
    mode: 'server',
    coreDb,
    dataRoot,
    store,
    workspaceMutationAdmission: admission,
  });
  let db = openWorkspaceDb(dataRoot, workspace.id);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    if (db.sqlite.open) db.sqlite.close();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  const owner = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'workspace',
    workspaceIds: [workspace.id],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const reader = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'workspace-readonly',
    workspaceIds: [workspace.id],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const request = (
    operation: string,
    token: Pick<OpenKitAccessTokenRecord, 'secret'>,
    input: Record<string, unknown>
  ) => {
    const requestId = typeof input.requestId === 'string' ? input.requestId : randomUUID();
    return app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.secret}`,
        'content-type': 'application/json',
        'x-openkit-request-id': requestId,
      },
      body: JSON.stringify({ workspaceId: workspace.id, ...input, requestId }),
    });
  };
  const call = async (
    operation: string,
    token: Pick<OpenKitAccessTokenRecord, 'secret'>,
    input: Record<string, unknown>
  ) => {
    const response = await request(operation, token, input);
    const text = await response.clone().text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // The baseline has no apply projection; retain its transport response for the deciding RED.
    }
    return { response, body };
  };

  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  const knowledgeRoot = join(workspaceRoot, 'knowledge');
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot,
    scope: { kind: 'workspace', workspaceId: workspace.id },
  });
  const initialSelection = readWorkspaceNotebookSelection({
    workspaceDb: db,
    workspaceRoot,
    knowledgeBaseId,
  });
  const originalSchema = initialSelection.scopeSchemaText;
  const firstRevision = initialSelection.notebook.publishedRevision();
  const content = serializeKnowledgePageFixture(
    {
      title: 'Existing observation',
      content: 'A retained record that the review must classify.',
      createdAt: '2026-10-31T00:00:00.000Z',
      updatedAt: '2026-10-31T00:00:00.000Z',
    },
    { kind: 'workspace', workspaceId: workspace.id }
  );
  const created = await call('knowledge.notebook.create', owner, {
    baseRevision: firstRevision,
    path: 'existing-observation.md',
    content,
    summary: 'Create one real schema review member.',
  });
  expect(created.response.status, JSON.stringify(created.body)).toBe(200);
  const baseRevision = readWorkspaceNotebookSelection({
    workspaceDb: db,
    workspaceRoot,
    knowledgeBaseId,
  }).notebook.publishedRevision();

  const preview = async (schemaText: string) => {
    const result = await call('knowledge.schema.preview', owner, { baseRevision, schemaText });
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    return result.body as Record<string, unknown>;
  };
  const restrictiveSchema = originalSchema.replace(/^allowed_types:.*$/m, 'allowed_types: [Claim]');
  const unrepaired = await preview(restrictiveSchema);
  expect(unrepaired.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'existing-observation.md', status: 'needs-review' }),
    ])
  );
  const unrepairedRefusal = await call('knowledge.schema.apply', owner, {
    requestId: randomUUID(),
    baseRevision,
    schemaText: restrictiveSchema,
    reviewedReport: unrepaired,
  });
  expect(unrepairedRefusal.response.status, JSON.stringify(unrepairedRefusal.body)).toBe(400);

  const candidateSchema = `${originalSchema.trimEnd()}\n# reviewed schema candidate\n`;
  const reviewedReport = await preview(candidateSchema);
  expect(reviewedReport).toMatchObject({
    workspaceId: workspace.id,
    notebookRevision: baseRevision,
    inventoryComplete: true,
  });
  expect(
    (reviewedReport.records as Array<{ status: string }>).every((row) => row.status === 'valid')
  ).toBe(true);
  // This fixture has no post-review inventory change; both required snapshots are exact.
  const retainedReport = canonicalJsonText(
    writeRetainedV1({ requiredFeatures: [], reviewedReport, actualReport: reviewedReport })
  );
  const reportDigest = `sha256:${sha256Hex(retainedReport)}`;
  const requestId = randomUUID();
  const applyInput = {
    requestId,
    baseRevision,
    schemaText: candidateSchema,
    reviewedReport,
  };
  const initialHead = readControlKnowledgeHead(db, knowledgeBaseId);
  const initialAudits = listSqliteAuditEvents(db.sqlite, workspace.id);
  const initialReceipt = store.getCommandRequest(
    'knowledge.schema.apply',
    requestId,
    { workspaceId: workspace.id, actorId: userId },
    db
  );

  const changedCandidate = await call('knowledge.schema.apply', owner, {
    ...applyInput,
    requestId: randomUUID(),
    schemaText: `${candidateSchema}# not reviewed\n`,
  });
  expect(changedCandidate.response.status).toBe(409);
  const incomplete = structuredClone(reviewedReport) as {
    inventoryComplete: boolean;
    dependencyInventory: Array<Record<string, unknown>>;
  };
  incomplete.inventoryComplete = false;
  incomplete.dependencyInventory[0] = {
    ...incomplete.dependencyInventory[0],
    complete: false,
    inventoryDigest: undefined,
  };
  const incompleteRefusal = await call('knowledge.schema.apply', owner, {
    ...applyInput,
    requestId: randomUUID(),
    reviewedReport: incomplete,
  });
  expect(incompleteRefusal.response.status).toBe(400);
  const unauthorized = await call('knowledge.schema.apply', reader, applyInput);
  expect(unauthorized.response.status).toBe(403);

  const competing = admission.tryFreeze(workspace.id, () => []);
  expect(competing.status).toBe('frozen');
  if (competing.status !== 'frozen') throw new Error('Expected a real competing freeze.');
  const busy = await call('knowledge.schema.apply', owner, applyInput);
  expect(busy.response.status).toBe(409);
  expect(busy.body).toMatchObject({
    code: 'workspace_frozen',
    details: {
      workspaceId: workspace.id,
      retryable: true,
      blockers: expect.any(Array),
    },
  });
  expect(
    (busy.body as { details: { blockers: unknown[] } }).details.blockers.length
  ).toBeGreaterThan(0);
  competing.release();

  expect(readControlKnowledgeHead(db, knowledgeBaseId)).toEqual(initialHead);
  expect(listSqliteAuditEvents(db.sqlite, workspace.id)).toEqual(initialAudits);
  expect(
    store.getCommandRequest(
      'knowledge.schema.apply',
      requestId,
      { workspaceId: workspace.id, actorId: userId },
      db
    )
  ).toEqual(initialReceipt);
  const applied = await call('knowledge.schema.apply', owner, applyInput);
  expect(applied.response.status, JSON.stringify(applied.body)).toBe(200);
  expect(applied.body).toMatchObject({
    workspaceId: workspace.id,
    notebookRevision: baseRevision,
    baseSchemaDigest: reviewedReport.baseSchemaDigest,
    candidateSchemaDigest: reviewedReport.candidateSchemaDigest,
    reportDigest,
  });
  const head = readControlKnowledgeHead(db, knowledgeBaseId);
  expect(head).toMatchObject({ notebookCommit: baseRevision });
  expect(head?.schemaContent.reference.contentDigest).toBe(reviewedReport.candidateSchemaDigest);
  const receipt = store.getCommandRequest(
    'knowledge.schema.apply',
    requestId,
    { workspaceId: workspace.id, actorId: userId },
    db
  );
  expect(receipt).not.toBeNull();
  expect(new Date(receipt!.createdAt).toISOString()).toBe(receipt!.createdAt);
  expect(receipt).toEqual({
    key: commandRequestKey('knowledge.schema.apply', requestId, {
      workspaceId: workspace.id,
      actorId: userId,
    }),
    command: 'knowledge.schema.apply',
    requestId,
    scope: { workspaceId: workspace.id, actorId: userId },
    inputHash: commandInputHash({ workspaceId: workspace.id, ...applyInput }),
    response: { kind: 'knowledge_schema_report', id: reportDigest },
    createdAt: receipt!.createdAt,
    expiresAt: commandRequestExpiresAt(receipt!.createdAt),
  });
  const audits = listSqliteAuditEvents(db.sqlite, workspace.id).filter(
    (event) => event.requestId === requestId
  );
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ outcome: 'succeeded' });

  const historyRoot = join(knowledgeRoot, 'schema', 'history');
  const historyBytes = readdirSync(historyRoot, { recursive: true })
    .map(String)
    .map((entry) => join(historyRoot, entry))
    .filter((entry) => statSync(entry).isFile())
    .map((entry) => readFileSync(entry, 'utf8'));
  expect(historyBytes).toEqual(expect.arrayContaining([originalSchema, candidateSchema]));
  expect(historyBytes).toContain(retainedReport);

  await shutdownControlStoreWorkerClient();
  db.sqlite.close();
  store = createTestStore({ dataRoot });
  app = createAppWithLocalIdentity({
    mode: 'server',
    coreDb,
    dataRoot,
    store,
    workspaceMutationAdmission: admission,
  });
  db = openWorkspaceDb(dataRoot, workspace.id);
  const replay = await call('knowledge.schema.apply', owner, applyInput);
  expect(replay.response.status, JSON.stringify(replay.body)).toBe(200);
  expect(replay.body).toEqual(applied.body);
  expect(readControlKnowledgeHead(db, knowledgeBaseId)).toEqual(head);
  expect(
    store.getCommandRequest(
      'knowledge.schema.apply',
      requestId,
      { workspaceId: workspace.id, actorId: userId },
      db
    )
  ).toEqual(receipt);
  expect(
    listSqliteAuditEvents(db.sqlite, workspace.id).filter((event) => event.requestId === requestId)
  ).toEqual(audits);
  expect(
    readdirSync(historyRoot, { recursive: true })
      .map(String)
      .map((entry) => join(historyRoot, entry))
      .filter((entry) => statSync(entry).isFile())
      .map((entry) => readFileSync(entry, 'utf8'))
  ).toEqual(historyBytes);
});

/** Composes public schema operations with real membership, Source publication and native Store. */
async function nativeSchemaReviewFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'native-schema-review-'));
  const coreDb = createTestCoreDb(dataRoot);
  const userId = ensureLocalUser(coreDb);
  const store = createTestStore({ dataRoot });
  let db: ReturnType<typeof openWorkspaceDb> | undefined;
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    if (db?.sqlite.open) db.sqlite.close();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const workspace = await store.createWorkspace('Native schema review');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const admission = new WorkspaceMutationAdmission();
  const runtimeConfigManager = createRuntimeConfigManager({ dataRoot, captureCoverage: store });
  const fileAdmission = new FileStorageAdmission(
    dataRoot,
    () => 0n,
    () => 1_000_000_000_000n
  );
  const app = createAppWithLocalIdentity({
    mode: 'server',
    coreDb,
    dataRoot,
    store,
    workspaceMutationAdmission: admission,
    runtimeConfigManager,
    fileAdmission,
  });
  const owner = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'workspace',
    workspaceIds: [workspace.id],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const workspaceDb = openWorkspaceReadDb(dataRoot, workspace.id);
  db = workspaceDb;
  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot,
    scope: { kind: 'workspace', workspaceId: workspace.id },
  });
  const select = () =>
    readWorkspaceNotebookSelection({ workspaceDb, workspaceRoot, knowledgeBaseId });
  const call = async (operation: string, input: Record<string, unknown>) => {
    const requestId = typeof input.requestId === 'string' ? input.requestId : randomUUID();
    const response = await app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${owner.secret}`,
        'content-type': 'application/json',
        'x-openkit-request-id': requestId,
      },
      body: JSON.stringify({ workspaceId: workspace.id, ...input, requestId }),
    });
    return { status: response.status, body: await response.json() };
  };
  const source = await call('knowledge.source.register', {
    kind: 'document',
    title: 'Schema review evidence',
    content: 'A real captured original shared by the reviewed Pages.',
  });
  expect(source.status, JSON.stringify(source.body)).toBe(200);
  const sourcePin = `source:${source.body.source.id}@${source.body.source.contentDigest}`;
  const sourcePath = `@sources/${source.body.source.id}.md`;
  const publish = async (path: string, type: 'KnowledgePage' | 'Observation' = 'KnowledgePage') => {
    const content = serializeKnowledgePageFixture(
      {
        title: path,
        content: 'An explicit human-authored Page with admitted Source evidence.',
        sourceReferences: [sourcePin],
        createdAt: '2026-11-03T00:00:00.000Z',
        updatedAt: '2026-11-03T00:00:00.000Z',
      },
      { kind: 'workspace', workspaceId: workspace.id }
    ).replace('type: "KnowledgePage"', `type: "${type}"`);
    const result = await call('knowledge.notebook.create', {
      baseRevision: select().head.notebookCommit,
      path,
      content,
      summary: 'Publish one current schema inventory member.',
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(select().notebook.readContent(select().head.notebookCommit)[path]).toBe(content);
    return content;
  };
  const preview = async (schemaText: string) => {
    const result = await call('knowledge.schema.preview', {
      baseRevision: select().head.notebookCommit,
      schemaText,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const report = result.body as import('@openkit/app-api-schemas').PreviewKnowledgeSchemaResponse;
    expect(report.inventoryComplete).toBe(true);
    expect(report.dependencyInventory.map((row) => row.family).sort()).toEqual([
      'indexes',
      'maintenance',
      'proposals',
      'trace-references',
    ]);
    expect(report.records).toContainEqual(
      expect.objectContaining({ path: sourcePath, status: 'valid' })
    );
    return report;
  };
  const receipt = (requestId: string) =>
    store.getCommandRequest(
      'knowledge.schema.apply',
      requestId,
      { workspaceId: workspace.id, actorId: userId },
      workspaceDb
    );
  const audits = (requestId: string) =>
    listSqliteAuditEvents(workspaceDb.sqlite, workspace.id).filter(
      (row) => row.requestId === requestId
    );
  await publish('first.md');
  return {
    store,
    workspace,
    userId,
    admission,
    workspaceRoot,
    select,
    call,
    publish,
    preview,
    receipt,
    audits,
    sourcePath,
    dataRoot,
    coreDb,
    workspaceDb,
    runtimeConfigManager,
    fileAdmission,
    requestActor: {
      kind: 'token' as const,
      userId,
      tokenId: owner.tokenId,
      tokenScope: owner.record.scope,
      tokenWorkspaceIds: [...owner.record.workspaceIds],
    },
  };
}

/** Complete immutable-history byte inventory; an absent history directory is an empty inventory. */
function schemaHistoryBytes(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  return Object.fromEntries(
    readdirSync(root, { recursive: true })
      .map(String)
      .sort()
      .filter((path) => statSync(join(root, path)).isFile())
      .map((path) => [path, readFileSync(join(root, path)).toString('hex')])
  );
}

it.each([
  { change: 'active-policy', refused: true },
  { change: 'review-required-pages', refused: true },
  { change: 'authority-refusal', refused: true },
  { change: 'unchanged', refused: false },
  { change: 'authored-policy-only', refused: false },
  { change: 'index-degradation-only', refused: false },
] as const)('checks current Main facts before forecast reservations: $change', async ({
  change,
  refused,
}) => {
  const f = await nativeSchemaReviewFixture();
  // Existing test-support authors this real Thread Policy; an applied document changes effective
  // Policy even though it does not itself revoke Workspace knowledge.write. Any captured change
  // must refuse the old computation under the accepted COORD 04:51 discipline.
  const thread = await f.store.createThread(f.workspace.id, 'Main Policy refresh subject');
  const originalSchema = f.select().scopeSchemaText;
  const candidate = `${originalSchema.trimEnd()}\n# Main fact freshness candidate.\n`;
  const reviewed = await f.preview(candidate);
  expect(reviewed.records.every((row) => row.status === 'valid')).toBe(true);
  const before = f.select();
  const initialHead = before.head;
  const initialPages = before.notebook.readContent(initialHead.notebookCommit);
  const requestId = randomUUID();
  const initialReceipt = f.receipt(requestId);
  const initialAudits = f.audits(requestId);
  expect(initialReceipt).toBeNull();
  expect(initialAudits).toEqual([]);
  const historyRoot = join(f.workspaceRoot, 'knowledge', 'schema', 'history');
  const initialHistory = schemaHistoryBytes(historyRoot);
  const initialPolicy = structuredClone(f.store.getWorkspaceResourceAccess(f.workspace.id));
  const initialReviewIds = structuredClone(
    findWorkspaceConfig(f.runtimeConfigManager.current(), f.workspace.id)?.config.workspace
      .knowledgeMaintenance?.reviewRequiredPageIds ?? []
  );
  expect(initialReviewIds).not.toContain('first');
  expect(isScopeAdmitted(f.dataRoot, 'workspace', f.workspace.id)).toBe(true);

  const forecastPaths: string[] = [];
  const reservations: Array<{ priority: string; releases: number }> = [];
  const forPath = FileStorageAdmission.prototype.forPath;
  const reserve = FileStorageAdmission.prototype.reserve;
  vi.spyOn(FileStorageAdmission.prototype, 'forPath').mockImplementation(function (
    this: FileStorageAdmission,
    path
  ) {
    if (schemaFreshness.phase === 'receiving') forecastPaths.push(path);
    return forPath.call(this, path);
  });
  vi.spyOn(FileStorageAdmission.prototype, 'reserve').mockImplementation(function (
    this: FileStorageAdmission,
    writes,
    priority
  ) {
    const reservation = reserve.call(this, writes, priority);
    if (schemaFreshness.phase === 'receiving') {
      const observed = { priority: priority ?? 'ordinary', releases: 0 };
      reservations.push(observed);
      const release = reservation.release.bind(reservation);
      reservation.release = () => {
        observed.releases += 1;
        release();
      };
    }
    return reservation;
  });
  onTestFinished(() => {
    schemaFreshness.phase = 'idle';
    schemaFreshness.mutate = undefined;
    vi.restoreAllMocks();
  });

  schemaFreshness.database = `workspace:${f.workspaceDb.sqlite.name}`;
  schemaFreshness.historyRoot = historyRoot;
  schemaFreshness.injectionError = undefined;
  schemaFreshness.injections = 0;
  schemaFreshness.forecasts = [];
  schemaFreshness.posts = [];
  schemaFreshness.decisions = [];
  schemaFreshness.failures = [];
  schemaFreshness.mutate = async () => {
    // This runs after the original real request has reached native read/compute and emitted its
    // actual forecast. Main has not received that event or selected any forecast filesystem.
    expect(schemaFreshness.posts.some((row) => row.id === schemaFreshness.forecasts[0]!.id)).toBe(
      true
    );
    expect(schemaFreshness.decisions).toEqual([]);
    expect(forecastPaths).toEqual([]);
    expect(reservations).toEqual([]);
    if (change === 'active-policy' || change === 'authored-policy-only') {
      writeManagedThreadPolicyFixture({
        dataRoot: f.dataRoot,
        workspaceId: f.workspace.id,
        threadId: thread.id,
        userId: f.userId,
      });
      // Authored configuration is inactive until its original runtime owner applies it.
      expect(f.store.getWorkspaceResourceAccess(f.workspace.id)).toEqual(initialPolicy);
      if (change === 'active-policy') {
        expect((await f.runtimeConfigManager.reload({ dryRun: false, mode: 'safe' })).status).toBe(
          'applied'
        );
        const loaded = findWorkspaceConfig(f.runtimeConfigManager.current(), f.workspace.id)!.config
          .workspace.policy!.mediation;
        expect(loaded.statements).not.toEqual(initialPolicy.statements);
        expect(f.store.getWorkspaceResourceAccess(f.workspace.id)).not.toEqual(initialPolicy);
      }
    } else if (change === 'review-required-pages') {
      const path = join(f.workspaceRoot, 'config', 'workspace.jsonc');
      const authored = readFileSync(path, 'utf8');
      writeFileSync(
        path,
        applyEdits(
          authored,
          modify(
            authored,
            ['workspace', 'knowledgeMaintenance'],
            { enabled: false, schedule: { enabled: false }, reviewRequiredPageIds: ['first'] },
            {}
          )
        )
      );
      expect(
        findWorkspaceConfig(f.runtimeConfigManager.current(), f.workspace.id)?.config.workspace
          .knowledgeMaintenance?.reviewRequiredPageIds ?? []
      ).toEqual(initialReviewIds);
      expect((await f.runtimeConfigManager.reload({ dryRun: false, mode: 'safe' })).status).toBe(
        'applied'
      );
      expect(
        findWorkspaceConfig(f.runtimeConfigManager.current(), f.workspace.id)?.config.workspace
          .knowledgeMaintenance?.reviewRequiredPageIds
      ).toEqual(['first']);
      expect(f.store.getWorkspaceResourceAccess(f.workspace.id)).toEqual(initialPolicy);
    } else if (change === 'authority-refusal' || change === 'index-degradation-only') {
      // Fault the existing Main readiness owner after valid setup; no retained row is fabricated.
      const check = change === 'authority-refusal' ? 'records' : 'index';
      refuseScope(f.dataRoot, { scope: 'workspace', id: f.workspace.id, check });
      expect(scopeAdmissionFailures(f.dataRoot)).toContainEqual({
        scope: 'workspace',
        id: f.workspace.id,
        check,
      });
      expect(isScopeAdmitted(f.dataRoot, 'workspace', f.workspace.id)).toBe(
        change === 'index-degradation-only'
      );
    }
  };
  schemaFreshness.phase = 'armed';
  try {
    // No native schema method or request discriminator is guessed. The existing public producer
    // must emit its genuine request and its one genuine exact forecast.
    const result = await f.call('knowledge.schema.apply', {
      requestId,
      baseRevision: reviewed.notebookRevision,
      schemaText: candidate,
      reviewedReport: reviewed,
    });
    expect(schemaFreshness.injectionError).toBeUndefined();
    expect(schemaFreshness.injections).toBe(1);
    expect(schemaFreshness.forecasts).toHaveLength(1);
    const forecast = schemaFreshness.forecasts[0]!;
    const producer = schemaFreshness.posts.filter((row) => row.id === forecast.id);
    expect(producer).toHaveLength(1);
    // Discover the real producer from exact forecast correlation, then count all its submissions.
    // A Core retry with a new native id cannot hide behind the final response.
    expect(
      schemaFreshness.posts.filter(
        (row) => row.operation === producer[0]!.operation && row.database === forecast.database
      )
    ).toHaveLength(1);
    expect(schemaFreshness.decisions).toEqual([
      {
        id: forecast.id,
        database: forecast.database,
        decision: refused ? 'precondition' : 'admitted',
        keys: ['database', 'decision', 'id', 'operation', 'version'],
      },
    ]);
    if (refused) {
      // Native known non-commit is the deciding error oracle; this dispatch does not invent an
      // unowned public field name or HTTP mapping for the new precondition projection.
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(schemaFreshness.failures).toEqual([
        { id: forecast.id, code: 'precondition', commit: 'not-committed' },
      ]);
      expect(forecastPaths).toEqual([]);
      expect(reservations).toEqual([]);
      expect(f.select().head).toEqual(initialHead);
      expect(f.select().scopeSchemaText).toBe(originalSchema);
      expect(f.select().notebook.readContent(initialHead.notebookCommit)).toEqual(initialPages);
      expect(schemaHistoryBytes(historyRoot)).toEqual(initialHistory);
      expect(f.receipt(requestId)).toEqual(initialReceipt);
      expect(f.audits(requestId)).toEqual(initialAudits);
    } else {
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(schemaFreshness.failures).toEqual([]);
      expect(reservations.length).toBeGreaterThan(0);
      expect(reservations.every((row) => row.priority === 'ordinary' && row.releases === 1)).toBe(
        true
      );
      const packet = canonicalJsonText(
        writeRetainedV1({ requiredFeatures: [], reviewedReport: reviewed, actualReport: reviewed })
      );
      const reportDigest = `sha256:${sha256Hex(packet)}`;
      const expectedFiles = [
        {
          path: join(historyRoot, `${reviewed.baseSchemaDigest.slice(7)}.yaml`),
          publicationBytes: Buffer.byteLength(originalSchema),
        },
        {
          path: join(historyRoot, `${reviewed.candidateSchemaDigest.slice(7)}.yaml`),
          publicationBytes: Buffer.byteLength(candidate),
        },
        {
          path: join(historyRoot, `${reportDigest.slice(7)}.json`),
          publicationBytes: Buffer.byteLength(packet),
        },
      ];
      for (const file of expectedFiles) {
        expect(forecast.files).toContainEqual(file);
        expect(forecastPaths).toContain(file.path);
      }
      expect(readFileSync(expectedFiles[0]!.path, 'utf8')).toBe(originalSchema);
      expect(readFileSync(expectedFiles[1]!.path, 'utf8')).toBe(candidate);
      expect(readFileSync(expectedFiles[2]!.path, 'utf8')).toBe(packet);
      expect(result.body.reportDigest).toBe(reportDigest);
      expect(f.select().head.notebookCommit).toBe(initialHead.notebookCommit);
      expect(f.select().scopeSchemaText).toBe(candidate);
      expect(f.select().notebook.readContent(initialHead.notebookCommit)).toEqual(initialPages);
      expect(f.receipt(requestId)?.response).toEqual({
        kind: 'knowledge_schema_report',
        id: reportDigest,
      });
      expect(f.audits(requestId)).toHaveLength(1);
      expect(f.audits(requestId)[0]).toMatchObject({
        outcome: 'succeeded',
        resource: `knowledge-schema-report:${reportDigest}`,
      });
    }
  } finally {
    schemaFreshness.phase = 'idle';
    schemaFreshness.mutate = undefined;
  }
});

it.each([
  'no-space',
  'competing-writer',
  'success',
] as const)('decides native schema history capacity and CAS before publication: %s', async (scenario) => {
  const f = await nativeSchemaReviewFixture();
  // Keep the original Main read connection; the injected writer never replaces it.
  const originalMainSqlite = f.workspaceDb.sqlite;
  expect(originalMainSqlite.readonly).toBe(true);
  expect(originalMainSqlite.pragma('query_only', { simple: true })).toBe(1);
  const selected = f.select();
  const originalSchema = selected.scopeSchemaText;
  const candidate = `${originalSchema.trimEnd()}
# Exact native history capacity candidate.
`;
  const reviewed = await f.preview(candidate);
  expect(reviewed.records.every((row) => row.status === 'valid')).toBe(true);
  const packet = canonicalJsonText(
    writeRetainedV1({ requiredFeatures: [], reviewedReport: reviewed, actualReport: reviewed })
  );
  const reportDigest = `sha256:${sha256Hex(packet)}`;
  const historyRoot = join(f.workspaceRoot, 'knowledge', 'schema', 'history');
  const expected = [
    { path: join(historyRoot, `${reviewed.baseSchemaDigest.slice(7)}.yaml`), text: originalSchema },
    { path: join(historyRoot, `${reviewed.candidateSchemaDigest.slice(7)}.yaml`), text: candidate },
    { path: join(historyRoot, `${reportDigest.slice(7)}.json`), text: packet },
  ];
  // The competing descriptor is created by the real immutable-content owner before the
  // deciding window. No valid retained row, receipt or Storage reference is hand-built.
  const competitorText = `${originalSchema.trimEnd()}
# A distinct valid competing schema.
`;
  const competingHead =
    scenario === 'competing-writer'
      ? await prepareWorkspaceKnowledgeSelection({
          db: f.workspaceDb,
          workspaceRoot: f.workspaceRoot,
          notebook: selected.notebook,
          knowledgeBaseId: selected.head.knowledgeBaseId,
          notebookCommit: selected.head.notebookCommit,
          schemaText: competitorText,
        })
      : undefined;
  const competingStatements = competingHead
    ? controlKnowledgeHeadStatements(competingHead, selected.head)
    : [];
  const initialHistory = schemaHistoryBytes(historyRoot);
  const initialAudits = listSqliteAuditEvents(originalMainSqlite, f.workspace.id);
  const initialPages = selected.notebook.readContent(selected.head.notebookCommit);
  const requestId = randomUUID();
  expect(f.receipt(requestId)).toBeNull();
  expect(f.audits(requestId)).toEqual([]);
  let available = 1_000_000_000_000n;
  const admission = new FileStorageAdmission(
    f.dataRoot,
    () => 0n,
    () => available
  );
  getControlStoreWorkerClient().setFileStorageAdmission(f.dataRoot, admission);
  const forecastPaths: string[] = [];
  const reservations: Array<{ path: string; bytes: bigint; priority: string; releases: number }> =
    [];
  const selectedPaths = new WeakMap<FileStorageAdmission, string>();
  const forPath = FileStorageAdmission.prototype.forPath;
  const reserve = FileStorageAdmission.prototype.reserve;
  vi.spyOn(FileStorageAdmission.prototype, 'forPath').mockImplementation(function (
    this: FileStorageAdmission,
    path
  ) {
    const target = forPath.call(this, path);
    if (schemaFreshness.phase === 'receiving') {
      forecastPaths.push(path);
      selectedPaths.set(target, path);
    }
    return target;
  });
  vi.spyOn(FileStorageAdmission.prototype, 'reserve').mockImplementation(function (
    this: FileStorageAdmission,
    writes,
    priority
  ) {
    const reservation = reserve.call(this, writes, priority);
    const path = selectedPaths.get(this);
    if (schemaFreshness.phase === 'receiving' && path !== undefined) {
      expect(writes.stagingBytes).toBe(0n);
      expect(writes.extractionBytes).toBe(0n);
      expect(writes.derivativeBytes).toBe(0n);
      const observed = {
        path,
        bytes: writes.publicationBytes,
        priority: priority ?? 'ordinary',
        releases: 0,
      };
      reservations.push(observed);
      const release = reservation.release.bind(reservation);
      reservation.release = () => {
        observed.releases += 1;
        release();
      };
    }
    return reservation;
  });
  let competingCommits = 0;
  const competingChanges: number[] = [];
  schemaFreshness.database = `workspace:${originalMainSqlite.name}`;
  schemaFreshness.historyRoot = historyRoot;
  schemaFreshness.injectionError = undefined;
  schemaFreshness.injections = 0;
  schemaFreshness.forecasts = [];
  schemaFreshness.posts = [];
  schemaFreshness.decisions = [];
  schemaFreshness.failures = [];
  schemaFreshness.commits = [];
  schemaFreshness.beforeDecision =
    scenario === 'competing-writer'
      ? () => {
          // Main has reserved this actual forecast, and native is still awaiting its original
          // admitted decision. This deliberate fault is a real separate physical writer.
          expect(schemaFreshness.decisions.at(-1)?.decision).toBe('admitted');
          expect(reservations.length).toBeGreaterThanOrEqual(3);
          expect(reservations.every((row) => row.releases === 0)).toBe(true);
          expect(schemaHistoryBytes(historyRoot)).toEqual(initialHistory);
          expect(f.select().head).toEqual(selected.head);
          const writer = new Database(originalMainSqlite.name, {
            fileMustExist: true,
            timeout: 1_000,
          });
          try {
            writer.transaction(() => {
              for (const statement of competingStatements) {
                const result = writer.prepare(statement.sql).run(...statement.parameters);
                const changes = Number(result.changes);
                competingChanges.push(changes);
                expect(changes).toBe(statement.expectChanges);
              }
            })();
            competingCommits += 1;
          } finally {
            writer.close();
          }
          expect(competingChanges).toEqual([1]);
          expect(f.select().head).toEqual(competingHead);
          expect(f.select().scopeSchemaText).toBe(competitorText);
          expect(f.workspaceDb.sqlite).toBe(originalMainSqlite);
          expect(originalMainSqlite.readonly).toBe(true);
        }
      : undefined;
  schemaFreshness.mutate = () => {
    expect(schemaFreshness.decisions).toEqual([]);
    expect(forecastPaths).toEqual([]);
    expect(reservations).toEqual([]);
    expect(schemaHistoryBytes(historyRoot)).toEqual(initialHistory);
    // Initial command/WAL capacity was already admitted. Only the genuine forecast
    // flips this real admission source, so an early unrelated refusal cannot pass.
    if (scenario === 'no-space') available = 0n;
  };
  Atomics.store(new Int32Array(schemaFreshness.commitGate), 0, scenario === 'success' ? 1 : 0);
  schemaFreshness.phase = 'armed';
  onTestFinished(() => {
    available = 1_000_000_000_000n;
    Atomics.store(new Int32Array(schemaFreshness.commitGate), 0, 0);
    schemaFreshness.phase = 'idle';
    schemaFreshness.mutate = undefined;
    schemaFreshness.beforeDecision = undefined;
    vi.restoreAllMocks();
  });
  try {
    const result = await f.call('knowledge.schema.apply', {
      requestId,
      baseRevision: reviewed.notebookRevision,
      schemaText: candidate,
      reviewedReport: reviewed,
    });
    expect(schemaFreshness.injectionError).toBeUndefined();
    expect(schemaFreshness.injections).toBe(1);
    expect(schemaFreshness.forecasts).toHaveLength(1);
    const forecast = schemaFreshness.forecasts[0]!;
    const producer = schemaFreshness.posts.filter((row) => row.id === forecast.id);
    expect(producer).toHaveLength(1);
    expect(
      schemaFreshness.posts.filter(
        (row) => row.database === forecast.database && row.operation === producer[0]!.operation
      )
    ).toHaveLength(1);
    const expectedForecasts = expected.map(({ path, text }) => ({
      path,
      publicationBytes: Buffer.byteLength(text),
    }));
    const byPath = (a: { path: string }, b: { path: string }) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    expect(
      forecast.files.filter((file) => file.path.startsWith(`${historyRoot}/`)).sort(byPath)
    ).toEqual(expectedForecasts.sort(byPath));
    expect(schemaFreshness.decisions).toEqual([
      {
        id: forecast.id,
        database: forecast.database,
        decision: scenario === 'no-space' ? 'no-space' : 'admitted',
        keys: ['database', 'decision', 'id', 'operation', 'version'],
      },
    ]);
    expect(f.workspaceDb.sqlite).toBe(originalMainSqlite);
    expect(originalMainSqlite.readonly).toBe(true);
    expect(originalMainSqlite.pragma('query_only', { simple: true })).toBe(1);
    expect(f.select().notebook.readContent(selected.head.notebookCommit)).toEqual(initialPages);
    if (scenario !== 'success') {
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(schemaFreshness.failures).toEqual([
        {
          id: forecast.id,
          code: scenario === 'no-space' ? 'no-space' : 'precondition',
          commit: 'not-committed',
        },
      ]);
      expect(schemaHistoryBytes(historyRoot)).toEqual(initialHistory);
      expect(listSqliteAuditEvents(originalMainSqlite, f.workspace.id)).toEqual(initialAudits);
      expect(f.receipt(requestId)).toBeNull();
      expect(f.audits(requestId)).toEqual([]);
      if (scenario === 'no-space') {
        expect(forecastPaths.length).toBeGreaterThan(0);
        expect(reservations).toEqual([]);
        expect(f.select().head).toEqual(selected.head);
        expect(f.select().scopeSchemaText).toBe(originalSchema);
        expect(competingCommits).toBe(0);
      } else {
        expect(result.status, JSON.stringify(result.body)).toBe(409);
        expect(result.body).toMatchObject({ code: 'conflict' });
        expect(competingCommits).toBe(1);
        expect(competingChanges).toEqual([1]);
        expect(f.select().head).toEqual(competingHead);
        expect(f.select().scopeSchemaText).toBe(competitorText);
        expect(reservations.map((row) => row.path).sort()).toEqual(
          forecast.files.map((row) => row.path).sort()
        );
        expect(reservations.every((row) => row.priority === 'ordinary' && row.releases === 1)).toBe(
          true
        );
      }
    } else {
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(schemaFreshness.failures).toEqual([]);
      expect(schemaFreshness.commits).toEqual([
        {
          id: forecast.id,
          phase: 'before',
          synchronous: 2,
          files: expected.map(({ path, text }) => ({
            path,
            hex: Buffer.from(text).toString('hex'),
          })),
        },
        { id: forecast.id, phase: 'after' },
        { id: forecast.id, phase: 'ack' },
      ]);
      expect(reservations.map((row) => row.path).sort()).toEqual(
        forecast.files.map((row) => row.path).sort()
      );
      for (const file of forecast.files)
        expect(reservations).toContainEqual({
          path: file.path,
          bytes: BigInt(file.publicationBytes),
          priority: 'ordinary',
          releases: 1,
        });
      for (const file of expected) expect(readFileSync(file.path, 'utf8')).toBe(file.text);
      expect(result.body).toEqual({
        workspaceId: f.workspace.id,
        notebookRevision: selected.head.notebookCommit,
        baseSchemaDigest: reviewed.baseSchemaDigest,
        candidateSchemaDigest: reviewed.candidateSchemaDigest,
        reportDigest,
      });
      expect(f.select().head.notebookCommit).toBe(selected.head.notebookCommit);
      expect(f.select().scopeSchemaText).toBe(candidate);
      const receipt = f.receipt(requestId);
      expect(receipt).not.toBeNull();
      expect(receipt).toEqual({
        key: commandRequestKey('knowledge.schema.apply', requestId, {
          workspaceId: f.workspace.id,
          actorId: f.userId,
        }),
        command: 'knowledge.schema.apply',
        requestId,
        scope: { workspaceId: f.workspace.id, actorId: f.userId },
        inputHash: commandInputHash({
          workspaceId: f.workspace.id,
          requestId,
          baseRevision: reviewed.notebookRevision,
          schemaText: candidate,
          reviewedReport: reviewed,
        }),
        response: { kind: 'knowledge_schema_report', id: reportDigest },
        createdAt: receipt!.createdAt,
        expiresAt: commandRequestExpiresAt(receipt!.createdAt),
      });
      expect(f.audits(requestId)).toHaveLength(1);
      expect(f.audits(requestId)[0]).toMatchObject({
        outcome: 'succeeded',
        resource: `knowledge-schema-report:${reportDigest}`,
      });
      // This request publishes exactly the three immutable history files. Its SQL/WAL
      // capacity already belongs to initial native request admission; it publishes no DB copy.
      expect([...forecast.files].sort(byPath)).toEqual(expectedForecasts.sort(byPath));
    }
  } finally {
    available = 1_000_000_000_000n;
    Atomics.store(new Int32Array(schemaFreshness.commitGate), 0, 0);
    schemaFreshness.phase = 'idle';
    schemaFreshness.mutate = undefined;
    schemaFreshness.beforeDecision = undefined;
  }
});

/** Observes structured delta facts without prescribing an unowned error-envelope field name. */
function schemaDeltaObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(schemaDeltaObjects);
  if (!value || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  return [row, ...Object.values(row).flatMap(schemaDeltaObjects)];
}

/** Observes exact scalar identities in an error delta; message substrings do not qualify. */
function schemaDeltaScalars(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(schemaDeltaScalars);
  if (value && typeof value === 'object') return Object.values(value).flatMap(schemaDeltaScalars);
  return [value];
}

it('applies a review after benign Notebook advance with more instances of its valid class', async () => {
  const f = await nativeSchemaReviewFixture();
  const originalSchema = f.select().scopeSchemaText;
  const candidate = `${originalSchema.trimEnd()}\n# Reviewed compatible schema.\n`;
  const reviewed = await f.preview(candidate);
  expect(reviewed.records).toContainEqual({ path: 'first.md', status: 'valid', diagnostics: [] });
  expect(reviewed.records.every((row) => row.status === 'valid')).toBe(true);
  const secondBytes = await f.publish('second.md');
  // This public preview is an observation for the oracle only; apply receives the original review.
  const actual = await f.preview(candidate);
  expect(actual.baseSchemaDigest).toBe(reviewed.baseSchemaDigest);
  expect(actual.candidateSchemaDigest).toBe(reviewed.candidateSchemaDigest);
  expect(actual.notebookRevision).not.toBe(reviewed.notebookRevision);
  expect(actual.records).toContainEqual({ path: 'second.md', status: 'valid', diagnostics: [] });
  const before = f.select();
  const pages = before.notebook.readContent(before.head.notebookCommit);
  const requestId = randomUUID();
  const input = {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  };
  const applied = await f.call('knowledge.schema.apply', input);
  // Reviewed Workspace Schema Application permits more instances of a reviewed impact class.
  // Expected baseline failure: the old inspection refuses the moved Notebook revision.
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  expect(applied.body).toMatchObject({
    notebookRevision: actual.notebookRevision,
    baseSchemaDigest: reviewed.baseSchemaDigest,
    candidateSchemaDigest: reviewed.candidateSchemaDigest,
  });
  expect(f.select().head.notebookCommit).toBe(before.head.notebookCommit);
  expect(f.select().scopeSchemaText).toBe(candidate);
  expect(f.select().notebook.readContent(before.head.notebookCommit)).toEqual(pages);
  expect(pages['second.md']).toBe(secondBytes);
  // The owner requires exact reviewed/actual reports, exact candidate bytes and original receipt.
  const packet = canonicalJsonText(
    writeRetainedV1({ requiredFeatures: [], reviewedReport: reviewed, actualReport: actual })
  );
  const reportDigest = `sha256:${sha256Hex(packet)}`;
  expect(applied.body.reportDigest).toBe(reportDigest);
  const history = join(f.workspaceRoot, 'knowledge', 'schema', 'history');
  expect(readFileSync(join(history, `${reportDigest.slice(7)}.json`), 'utf8')).toBe(packet);
  expect(readFileSync(join(history, `${reviewed.baseSchemaDigest.slice(7)}.yaml`), 'utf8')).toBe(
    originalSchema
  );
  expect(
    readFileSync(join(history, `${reviewed.candidateSchemaDigest.slice(7)}.yaml`), 'utf8')
  ).toBe(candidate);
  expect(f.receipt(requestId)?.response).toEqual({
    kind: 'knowledge_schema_report',
    id: reportDigest,
  });
  expect(f.audits(requestId)).toHaveLength(1);
  expect(f.audits(requestId)[0]).toMatchObject({
    outcome: 'succeeded',
    resource: `knowledge-schema-report:${reportDigest}`,
  });
  const head = f.select().head;
  const receipt = f.receipt(requestId);
  const audits = f.audits(requestId);
  expect(await f.call('knowledge.schema.apply', input)).toEqual(applied);
  expect(f.select().head).toEqual(head);
  expect(f.receipt(requestId)).toEqual(receipt);
  expect(f.audits(requestId)).toEqual(audits);
});

it('applies a compatible review while real native pending work remains live', async () => {
  const f = await nativeSchemaReviewFixture();
  const thread = await f.store.createThread(f.workspace.id, 'Live pending work');
  const turn = await f.store.createTurn(
    f.workspace.id,
    thread.id,
    'Keep this admitted work live.',
    { kind: 'user', id: f.userId },
    null,
    { status: 'pending' }
  );
  const before = f.store.getTurn(f.workspace.id, thread.id, turn.id);
  expect(before.status).toBe('pending');
  const candidate = `${f.select().scopeSchemaText.trimEnd()}\n# Compatible with live work.\n`;
  const reviewed = await f.preview(candidate);
  // This is the actual lifecycle owner. Observe it without replacing its behavior.
  const freeze = vi.spyOn(f.admission, 'tryFreeze');
  onTestFinished(() => freeze.mockRestore());
  const requestId = randomUUID();
  const applied = await f.call('knowledge.schema.apply', {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  });
  // The owner forbids an idle requirement. A persisted pending Turn is not a launched Worker.
  // Expected baseline failure: the real blocker reader returns the nonterminal Turn.
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  expect(freeze).not.toHaveBeenCalled();
  expect(f.store.getTurn(f.workspace.id, thread.id, turn.id)).toEqual(before);
  expect(f.admission.isClosed(f.workspace.id)).toBe(false);
  expect(f.select().scopeSchemaText).toBe(candidate);
  expect(f.receipt(requestId)?.response).toEqual({
    kind: 'knowledge_schema_report',
    id: applied.body.reportDigest,
  });
  expect(f.audits(requestId)).toHaveLength(1);
  // Native product progress can still be admitted after application, on another Thread.
  const nextThread = await f.store.createThread(f.workspace.id, 'Later product progress');
  const nextTurn = await f.store.createTurn(
    f.workspace.id,
    nextThread.id,
    'Continue work.',
    { kind: 'user', id: f.userId },
    null,
    { status: 'pending' }
  );
  expect(f.store.getTurn(f.workspace.id, nextThread.id, nextTurn.id).status).toBe('pending');
});

it('refuses a new invalid impact with its truthful delta and no schema tuple', async () => {
  const f = await nativeSchemaReviewFixture();
  // Retain the actual SourceSummary class while excluding only the later Observation fixture.
  const candidate = f
    .select()
    .scopeSchemaText.replace(
      /^allowed_types:.*$/m,
      'allowed_types: [KnowledgePage, SourceSummary]'
    );
  const reviewed = await f.preview(candidate);
  expect(reviewed.records.every((row) => row.status === 'valid')).toBe(true);
  await f.publish('late-observation.md', 'Observation');
  const actual = await f.preview(candidate);
  const changed = actual.records.find((row) => row.path === 'late-observation.md');
  expect(changed).toEqual({
    path: 'late-observation.md',
    status: 'needs-review',
    diagnostics: [{ code: 'scope_schema.type_not_allowed', field: 'type' }],
  });
  const before = f.select().head;
  const schema = f.select().scopeSchemaText;
  const requestId = randomUUID();
  const refused = await f.call('knowledge.schema.apply', {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  });
  expect(refused.status, JSON.stringify(refused.body)).toBe(409);
  // The owner requires the new impact for re-review. A bare stale-Notebook conflict cannot decide it.
  // Expected baseline failure: no structured new-impact delta is returned.
  expect(schemaDeltaObjects(refused.body.details)).toEqual(
    expect.arrayContaining([expect.objectContaining(changed!)])
  );
  expect(f.select().head).toEqual(before);
  expect(f.select().scopeSchemaText).toBe(schema);
  expect(f.receipt(requestId)).toBeNull();
  expect(f.audits(requestId)).toEqual([]);
});

it('refuses a moved schema head with its truthful delta when Notebook bytes did not change', async () => {
  const f = await nativeSchemaReviewFixture();
  const original = f.select().scopeSchemaText;
  const staleCandidate = `${original.trimEnd()}\n# Original review.\n`;
  const winner = `${original.trimEnd()}\n# Independent reviewed winner.\n`;
  const stale = await f.preview(staleCandidate);
  const winningReview = await f.preview(winner);
  const accepted = await f.call('knowledge.schema.apply', {
    requestId: randomUUID(),
    baseRevision: winningReview.notebookRevision,
    schemaText: winner,
    reviewedReport: winningReview,
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const before = f.select().head;
  expect(before.notebookCommit).toBe(stale.notebookRevision);
  const requestId = randomUUID();
  const refused = await f.call('knowledge.schema.apply', {
    requestId,
    baseRevision: stale.notebookRevision,
    schemaText: staleCandidate,
    reviewedReport: stale,
  });
  expect(refused.status, JSON.stringify(refused.body)).toBe(409);
  // A moved-base delta identifies the reviewed and current schema identities for re-review.
  // No unowned error field name is prescribed; exact identity leaves must be present in details.
  expect(schemaDeltaScalars(refused.body.details)).toEqual(
    expect.arrayContaining([stale.baseSchemaDigest, winningReview.candidateSchemaDigest])
  );
  expect(f.select().head).toEqual(before);
  expect(f.select().scopeSchemaText).toBe(winner);
  expect(f.receipt(requestId)).toBeNull();
  expect(f.audits(requestId)).toEqual([]);
});

it.each([
  false,
  true,
])('rechecks a different active Policy author after Main admission (author leaves: %s)', async (authorLeaves) => {
  const f = await nativeSchemaReviewFixture();
  const originalMainSqlite = f.workspaceDb.sqlite;
  expect(originalMainSqlite.readonly).toBe(true);
  expect(originalMainSqlite.pragma('query_only', { simple: true })).toBe(1);

  // Enrollment uses this fixture's real authentication owner. Generated registration values
  // stay inside this test; no response body, session, cookie or credential is retained or logged.
  const auth = createBetterAuth(f.coreDb, { env: {} });
  const authContext = await auth.$context;
  vi.spyOn(authContext.logger, 'error').mockImplementation(() => {});
  vi.spyOn(authContext.logger, 'warn').mockImplementation(() => {});
  const authorAddress = `${randomBytes(12).toString('hex')}@example.test`;
  const policyAuthorUserId = await auth.api
    .signUpEmail({
      body: {
        name: 'Schema Policy author',
        email: authorAddress,
        ['password']: randomBytes(32).toString('base64url'),
      },
    })
    .then(
      (result) => result.user.id,
      () => {
        throw new Error('Synthetic Policy-author enrollment failed.');
      }
    );
  expect(policyAuthorUserId).not.toBe(f.userId);
  expect(isCanonicalUserActive(f.coreDb, policyAuthorUserId)).toBe(true);
  expect(isCurrentServerPolicyAuthor(f.coreDb, policyAuthorUserId)).toBe(false);
  const invitation = f.coreDb.sqlite
    .transaction(() =>
      createWorkspaceInvitation({
        coreDb: f.coreDb,
        workspaceId: f.workspace.id,
        inviterUserId: f.userId,
        inviteeEmail: authorAddress,
        authorization: workspaceMembershipDecisionFixture(f.coreDb, f.userId, f.workspace.id),
      })
    )
    .immediate();
  expect(invitation.kind).toBe('created');
  if (invitation.kind !== 'created') throw new Error('Expected the real author invitation.');
  const accepted = f.coreDb.sqlite
    .transaction(() =>
      acceptWorkspaceInvitation({
        coreDb: f.coreDb,
        workspaceId: f.workspace.id,
        inviteeUserId: policyAuthorUserId,
        invitationId: invitation.invitation.invitationId,
        expectedRevision: invitation.invitation.revision,
      })
    )
    .immediate();
  expect(accepted.kind).toBe('accepted');
  if (accepted.kind !== 'accepted') throw new Error('Expected the real author membership.');
  expect(accepted.member).toMatchObject({
    userId: policyAuthorUserId,
    status: 'active',
    isOwner: false,
  });
  const authorAuthority = () =>
    currentWorkspaceAuthority(
      f.coreDb,
      f.workspace.id,
      { kind: 'user', id: policyAuthorUserId },
      'workspace.configure',
      true,
      undefined,
      { retainedPolicyAuthor: true, dependencyFailure: 'throw' }
    );
  const requesterAuthority = (operation: 'knowledge.read' | 'knowledge.write') =>
    currentWorkspaceAuthority(
      f.coreDb,
      f.workspace.id,
      { kind: 'user', id: f.userId },
      operation,
      true,
      f.requestActor,
      { dependencyFailure: 'throw' }
    );
  expect(authorAuthority()).toBe('member');
  expect(requesterAuthority('knowledge.read')).toBe('member');
  expect(requesterAuthority('knowledge.write')).toBe('member');

  const thread = await f.store.createThread(f.workspace.id, 'Independent Policy author');
  const configPath = join(f.workspaceRoot, 'config', 'workspace.jsonc');
  writeManagedThreadPolicyFixture({
    dataRoot: f.dataRoot,
    workspaceId: f.workspace.id,
    threadId: thread.id,
    userId: policyAuthorUserId,
    operations: ['thread.read'],
  });
  const authored = readFileSync(configPath, 'utf8');
  const authoredPolicy = WorkspaceConfigSchema.parse(parseJsonc(authored)).workspace.policy!
    .mediation;
  const permissionIndex = authoredPolicy.statements.findIndex(
    (statement) => statement.kind === 'permission'
  );
  expect(permissionIndex).toBeGreaterThanOrEqual(0);
  // Keep the new Thread readable by the original requester. Only the authored permission's
  // recipient changes; the existing builder's real distinct author and authority remain intact.
  writeFileSync(
    configPath,
    applyEdits(
      authored,
      modify(
        authored,
        [
          'workspace',
          'policy',
          'mediation',
          'statements',
          permissionIndex,
          'scope',
          'subjects',
          0,
          'id',
        ],
        f.userId,
        {}
      )
    )
  );
  expect((await f.runtimeConfigManager.reload({ dryRun: false, mode: 'safe' })).status).toBe(
    'applied'
  );
  const runtimeSnapshot = f.runtimeConfigManager.current();
  const loadedPolicy = findWorkspaceConfig(runtimeSnapshot, f.workspace.id)!.config.workspace
    .policy!.mediation;
  expect(loadedPolicy.statements).toHaveLength(2);
  expect(
    loadedPolicy.statements.every(
      (statement) =>
        statement.state === 'active' &&
        statement.author.kind === 'human' &&
        statement.author.id === policyAuthorUserId
    )
  ).toBe(true);
  expect(loadedPolicy.statements).toContainEqual(
    expect.objectContaining({
      kind: 'permission',
      scope: expect.objectContaining({
        subjects: [{ kind: 'human', id: f.userId }],
        actions: ['thread.read'],
      }),
    })
  );
  expect(
    readCurrentWorkspacePolicy({
      coreDb: f.coreDb,
      workspaceId: f.workspace.id,
      policy: loadedPolicy,
    })
  ).toEqual(loadedPolicy);
  const policyBytes = canonicalJsonText(loadedPolicy);
  const configurationBytes = readFileSync(configPath);
  const selected = f.select();
  const originalSchema = selected.scopeSchemaText;
  const candidate = `${originalSchema.trimEnd()}\n# Final current Policy-author predicate.\n`;
  const reviewed = await f.preview(candidate);
  expect(reviewed.inventoryComplete).toBe(true);
  expect(reviewed.records.every((row) => row.status === 'valid')).toBe(true);
  const packet = canonicalJsonText(
    writeRetainedV1({ requiredFeatures: [], reviewedReport: reviewed, actualReport: reviewed })
  );
  const reportDigest = `sha256:${sha256Hex(packet)}`;
  const historyRoot = join(f.workspaceRoot, 'knowledge', 'schema', 'history');
  const expected = [
    { path: join(historyRoot, `${reviewed.baseSchemaDigest.slice(7)}.yaml`), text: originalSchema },
    { path: join(historyRoot, `${reviewed.candidateSchemaDigest.slice(7)}.yaml`), text: candidate },
    { path: join(historyRoot, `${reportDigest.slice(7)}.json`), text: packet },
  ];
  const initialHistory = schemaHistoryBytes(historyRoot);
  const initialAudits = listSqliteAuditEvents(originalMainSqlite, f.workspace.id);
  const initialPages = selected.notebook.readContent(selected.head.notebookCommit);
  const initialRequesterMember = getWorkspaceMember(f.coreDb, f.workspace.id, f.userId);
  const requestId = randomUUID();
  expect(f.receipt(requestId)).toBeNull();
  expect(f.audits(requestId)).toEqual([]);
  const forecastPaths: string[] = [];
  const reservations: Array<{ path: string; bytes: bigint; priority: string; releases: number }> =
    [];
  const selectedPaths = new WeakMap<FileStorageAdmission, string>();
  const forPath = FileStorageAdmission.prototype.forPath;
  const reserve = FileStorageAdmission.prototype.reserve;
  vi.spyOn(FileStorageAdmission.prototype, 'forPath').mockImplementation(function (
    this: FileStorageAdmission,
    path
  ) {
    const target = forPath.call(this, path);
    if (schemaFreshness.phase === 'receiving') {
      forecastPaths.push(path);
      selectedPaths.set(target, path);
    }
    return target;
  });
  vi.spyOn(FileStorageAdmission.prototype, 'reserve').mockImplementation(function (
    this: FileStorageAdmission,
    writes,
    priority
  ) {
    const reservation = reserve.call(this, writes, priority);
    const path = selectedPaths.get(this);
    if (schemaFreshness.phase === 'receiving' && path !== undefined) {
      expect(writes.stagingBytes).toBe(0n);
      expect(writes.extractionBytes).toBe(0n);
      expect(writes.derivativeBytes).toBe(0n);
      const observed = {
        path,
        bytes: writes.publicationBytes,
        priority: priority ?? 'ordinary',
        releases: 0,
      };
      reservations.push(observed);
      const release = reservation.release.bind(reservation);
      reservation.release = () => {
        observed.releases += 1;
        release();
      };
    }
    return reservation;
  });
  schemaFreshness.database = `workspace:${originalMainSqlite.name}`;
  schemaFreshness.historyRoot = historyRoot;
  schemaFreshness.injectionError = undefined;
  schemaFreshness.injections = 0;
  schemaFreshness.forecasts = [];
  schemaFreshness.posts = [];
  schemaFreshness.decisions = [];
  schemaFreshness.failures = [];
  schemaFreshness.commits = [];
  let decisionVisits = 0;
  let authorRemovals = 0;
  schemaFreshness.mutate = () => {
    expect(schemaFreshness.decisions).toEqual([]);
    expect(forecastPaths).toEqual([]);
    expect(reservations).toEqual([]);
    expect(authorAuthority()).toBe('member');
    expect(
      readCurrentWorkspacePolicy({
        coreDb: f.coreDb,
        workspaceId: f.workspace.id,
        policy: loadedPolicy,
      })
    ).toEqual(loadedPolicy);
  };
  schemaFreshness.beforeDecision = () => {
    // This callback runs after the genuine Main comparison and all its reservations, while
    // native still awaits the exact original admitted decision. It adds no wire message.
    decisionVisits += 1;
    expect(schemaFreshness.forecasts).toHaveLength(1);
    const forecast = schemaFreshness.forecasts[0]!;
    expect(schemaFreshness.decisions).toEqual([
      {
        id: forecast.id,
        database: forecast.database,
        decision: 'admitted',
        keys: ['database', 'decision', 'id', 'operation', 'version'],
      },
    ]);
    expect(reservations).toHaveLength(3);
    expect(reservations.every((row) => row.priority === 'ordinary' && row.releases === 0)).toBe(
      true
    );
    expect(schemaHistoryBytes(historyRoot)).toEqual(initialHistory);
    expect(f.select().head).toEqual(selected.head);
    expect(authorAuthority()).toBe('member');
    if (authorLeaves) {
      const removed = f.coreDb.sqlite
        .transaction(() =>
          leaveWorkspace({
            coreDb: f.coreDb,
            workspaceId: f.workspace.id,
            memberUserId: policyAuthorUserId,
            expectedRevision: accepted.member.revision,
          })
        )
        .immediate();
      expect(removed.kind).toBe('removed');
      if (removed.kind !== 'removed') throw new Error('The real author membership did not leave.');
      expect(removed.member).toMatchObject({ userId: policyAuthorUserId, status: 'removed' });
      authorRemovals += 1;
      expect(authorAuthority()).toBeNull();
      expect(() =>
        readCurrentWorkspacePolicy({
          coreDb: f.coreDb,
          workspaceId: f.workspace.id,
          policy: loadedPolicy,
        })
      ).toThrow();
    }
    expect(isCanonicalUserActive(f.coreDb, policyAuthorUserId)).toBe(true);
    expect(isCurrentServerPolicyAuthor(f.coreDb, policyAuthorUserId)).toBe(false);
    expect(getWorkspaceMember(f.coreDb, f.workspace.id, f.userId)).toEqual(initialRequesterMember);
    expect(requesterAuthority('knowledge.read')).toBe('member');
    expect(requesterAuthority('knowledge.write')).toBe('member');
    expect(f.runtimeConfigManager.current()).toBe(runtimeSnapshot);
    expect(
      findWorkspaceConfig(runtimeSnapshot, f.workspace.id)!.config.workspace.policy!.mediation
    ).toBe(loadedPolicy);
    expect(canonicalJsonText(loadedPolicy)).toBe(policyBytes);
    expect(readFileSync(configPath).equals(configurationBytes)).toBe(true);
  };
  Atomics.store(new Int32Array(schemaFreshness.commitGate), 0, authorLeaves ? 0 : 1);
  schemaFreshness.phase = 'armed';
  onTestFinished(() => {
    Atomics.store(new Int32Array(schemaFreshness.commitGate), 0, 0);
    schemaFreshness.phase = 'idle';
    schemaFreshness.mutate = undefined;
    schemaFreshness.beforeDecision = undefined;
    vi.restoreAllMocks();
  });
  try {
    const result = await f.call('knowledge.schema.apply', {
      requestId,
      baseRevision: reviewed.notebookRevision,
      schemaText: candidate,
      reviewedReport: reviewed,
    });
    expect(schemaFreshness.injectionError).toBeUndefined();
    expect(schemaFreshness.injections).toBe(1);
    expect(decisionVisits).toBe(1);
    expect(authorRemovals).toBe(authorLeaves ? 1 : 0);
    expect(schemaFreshness.forecasts).toHaveLength(1);
    const forecast = schemaFreshness.forecasts[0]!;
    const producer = schemaFreshness.posts.filter((row) => row.id === forecast.id);
    expect(producer).toHaveLength(1);
    expect(
      schemaFreshness.posts.filter(
        (row) => row.database === forecast.database && row.operation === producer[0]!.operation
      )
    ).toHaveLength(1);
    const byPath = (a: { path: string }, b: { path: string }) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    expect([...forecast.files].sort(byPath)).toEqual(
      expected
        .map(({ path, text }) => ({ path, publicationBytes: Buffer.byteLength(text) }))
        .sort(byPath)
    );
    expect(schemaFreshness.decisions).toEqual([
      {
        id: forecast.id,
        database: forecast.database,
        decision: 'admitted',
        keys: ['database', 'decision', 'id', 'operation', 'version'],
      },
    ]);
    expect(forecastPaths.sort()).toEqual(expected.map(({ path }) => path).sort());
    expect(reservations).toHaveLength(3);
    for (const file of forecast.files)
      expect(reservations).toContainEqual({
        path: file.path,
        bytes: BigInt(file.publicationBytes),
        priority: 'ordinary',
        releases: 1,
      });
    expect(f.workspaceDb.sqlite).toBe(originalMainSqlite);
    expect(originalMainSqlite.readonly).toBe(true);
    expect(originalMainSqlite.pragma('query_only', { simple: true })).toBe(1);
    expect(f.select().notebook.readContent(selected.head.notebookCommit)).toEqual(initialPages);
    expect(requesterAuthority('knowledge.read')).toBe('member');
    expect(requesterAuthority('knowledge.write')).toBe('member');
    expect(canonicalJsonText(loadedPolicy)).toBe(policyBytes);
    expect(readFileSync(configPath).equals(configurationBytes)).toBe(true);
    if (authorLeaves) {
      // Current Policy author lifetime is an independent final Core predicate. A successful
      // Main decision and an unchanged requester cannot authorize this original schema tuple.
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(schemaFreshness.failures).toEqual([
        { id: forecast.id, code: 'precondition', commit: 'not-committed' },
      ]);
      expect(schemaHistoryBytes(historyRoot)).toEqual(initialHistory);
      expect(f.select().head).toEqual(selected.head);
      expect(f.select().scopeSchemaText).toBe(originalSchema);
      expect(listSqliteAuditEvents(originalMainSqlite, f.workspace.id)).toEqual(initialAudits);
      expect(f.receipt(requestId)).toBeNull();
      expect(f.audits(requestId)).toEqual([]);
    } else {
      expect(authorAuthority()).toBe('member');
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(schemaFreshness.failures).toEqual([]);
      expect(schemaFreshness.commits).toEqual([
        {
          id: forecast.id,
          phase: 'before',
          synchronous: 2,
          files: expected.map(({ path, text }) => ({
            path,
            hex: Buffer.from(text).toString('hex'),
          })),
        },
        { id: forecast.id, phase: 'after' },
        { id: forecast.id, phase: 'ack' },
      ]);
      for (const file of expected) expect(readFileSync(file.path, 'utf8')).toBe(file.text);
      expect(result.body.reportDigest).toBe(reportDigest);
      expect(f.select().head.notebookCommit).toBe(selected.head.notebookCommit);
      expect(f.select().scopeSchemaText).toBe(candidate);
      expect(f.receipt(requestId)?.response).toEqual({
        kind: 'knowledge_schema_report',
        id: reportDigest,
      });
      expect(f.audits(requestId)).toHaveLength(1);
      expect(f.audits(requestId)[0]).toMatchObject({
        outcome: 'succeeded',
        resource: `knowledge-schema-report:${reportDigest}`,
      });
    }
  } finally {
    Atomics.store(new Int32Array(schemaFreshness.commitGate), 0, 0);
    schemaFreshness.phase = 'idle';
    schemaFreshness.mutate = undefined;
    schemaFreshness.beforeDecision = undefined;
  }
});

it.each([
  'receipt-sql-failure',
  'lost-full-ack',
] as const)('keeps the original schema tuple truthful across %s and explicit same-request replay', async (fault) => {
  const f = await nativeSchemaReviewFixture();
  const before = f.select();
  const originalSchema = before.scopeSchemaText;
  const candidate = `${originalSchema.trimEnd()}
# Native original-receipt boundary.
`;
  const reviewed = await f.preview(candidate);
  expect(reviewed.records.every((row) => row.status === 'valid')).toBe(true);
  const packet = canonicalJsonText(
    writeRetainedV1({ requiredFeatures: [], reviewedReport: reviewed, actualReport: reviewed })
  );
  const reportDigest = `sha256:${sha256Hex(packet)}`;
  const expectedResult = {
    workspaceId: f.workspace.id,
    notebookRevision: before.head.notebookCommit,
    baseSchemaDigest: reviewed.baseSchemaDigest,
    candidateSchemaDigest: reviewed.candidateSchemaDigest,
    reportDigest,
  };
  const requestId = randomUUID();
  const input = {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  };
  const historyRoot = join(f.workspaceRoot, 'knowledge', 'schema', 'history');
  const originalPages = before.notebook.readContent(before.head.notebookCommit);
  const originalAudits = listSqliteAuditEvents(f.workspaceDb.sqlite, f.workspace.id);
  expect(f.receipt(requestId)).toBeNull();
  expect(f.audits(requestId)).toEqual([]);
  const client = getControlStoreWorkerClient();
  const apply = client.applyWorkspaceSchema.bind(client);
  let actualFailure: unknown;
  // Observe the real native error while preserving the public producer and original method.
  const observeFailure = vi
    .spyOn(client, 'applyWorkspaceSchema')
    .mockImplementation(async (owned) => {
      try {
        return await apply(owned);
      } catch (error: unknown) {
        actualFailure = error;
        throw error;
      }
    });
  let triggerCreated = false;
  schemaFreshness.database = `workspace:${f.workspaceDb.sqlite.name}`;
  schemaFreshness.historyRoot = historyRoot;
  schemaFreshness.phase = 'armed';
  schemaFreshness.injections = 0;
  schemaFreshness.injectionError = undefined;
  schemaFreshness.forecasts = [];
  schemaFreshness.posts = [];
  schemaFreshness.decisions = [];
  schemaFreshness.failures = [];
  schemaFreshness.commits = [];
  schemaFreshness.sqlFaults = [];
  schemaFreshness.droppedAcks = [];
  schemaFreshness.dropAck = fault === 'lost-full-ack';
  schemaFreshness.mutate = undefined;
  schemaFreshness.holdPost = undefined;
  schemaFreshness.beforeDecision =
    fault === 'receipt-sql-failure'
      ? () => {
          const writer = new Database(f.workspaceDb.sqlite.name, { fileMustExist: true });
          try {
            // Deliberate failure after valid setup, guarded to only this original receipt.
            // Head and Audit SQL precede receipt insertion in the real native transaction.
            writer.exec(`CREATE TRIGGER schema_original_receipt_fault
          BEFORE INSERT ON idempotency_requests
          WHEN NEW.command_name = 'knowledge.schema.apply' AND NEW.request_id = '${requestId}'
          BEGIN SELECT RAISE(ABORT, 'schema-boundary-original-receipt'); END`);
            triggerCreated = true;
          } finally {
            writer.close();
          }
        }
      : undefined;
  Atomics.store(new Int32Array(schemaFreshness.commitGate), 0, fault === 'lost-full-ack' ? 1 : 0);
  Atomics.store(
    new Int32Array(schemaFreshness.sqlFaultGate),
    0,
    fault === 'receipt-sql-failure' ? 1 : 0
  );
  const clear = () => {
    Atomics.store(new Int32Array(schemaFreshness.commitGate), 0, 0);
    Atomics.store(new Int32Array(schemaFreshness.sqlFaultGate), 0, 0);
    schemaFreshness.phase = 'idle';
    schemaFreshness.dropAck = false;
    schemaFreshness.beforeDecision = undefined;
    schemaFreshness.mutate = undefined;
    schemaFreshness.holdPost = undefined;
    observeFailure.mockRestore();
    if (triggerCreated) {
      const writer = new Database(f.workspaceDb.sqlite.name, { fileMustExist: true });
      try {
        writer.exec('DROP TRIGGER schema_original_receipt_fault');
        triggerCreated = false;
      } finally {
        writer.close();
      }
    }
  };
  onTestFinished(clear);
  try {
    const failed = await f.call('knowledge.schema.apply', input);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(schemaFreshness.injectionError).toBeUndefined();
    expect(schemaFreshness.injections).toBe(1);
    expect(schemaFreshness.forecasts).toHaveLength(1);
    const forecast = schemaFreshness.forecasts[0]!;
    const producer = schemaFreshness.posts.filter((row) => row.id === forecast.id);
    expect(producer).toHaveLength(1);
    expect(
      schemaFreshness.posts.filter(
        (row) => row.database === forecast.database && row.operation === producer[0]!.operation
      )
    ).toHaveLength(1);
    expect(schemaFreshness.decisions).toEqual([
      {
        id: forecast.id,
        database: forecast.database,
        decision: 'admitted',
        keys: ['database', 'decision', 'id', 'operation', 'version'],
      },
    ]);
    expect(f.select().notebook.readContent(before.head.notebookCommit)).toEqual(originalPages);
    if (fault === 'receipt-sql-failure') {
      expect(triggerCreated).toBe(true);
      expect(schemaFreshness.sqlFaults).toEqual([
        { id: forecast.id, code: 'SQLITE_CONSTRAINT_TRIGGER' },
      ]);
      expect(actualFailure).toMatchObject({ code: 'constraint', commit: 'not-committed' });
      expect(schemaFreshness.failures).toEqual([
        { id: forecast.id, code: 'constraint', commit: 'not-committed' },
      ]);
      expect(f.select().head).toEqual(before.head);
      expect(f.select().scopeSchemaText).toBe(originalSchema);
      expect(listSqliteAuditEvents(f.workspaceDb.sqlite, f.workspace.id)).toEqual(originalAudits);
      expect(f.receipt(requestId)).toBeNull();
      expect(f.audits(requestId)).toEqual([]);
      // Immutable orphan history is allowed after a definite SQL refusal. There is no
      // filesystem rollback oracle here; only the selected SQL tuple must roll back.
      clear();
      const replay = await f.call('knowledge.schema.apply', input);
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body).toEqual(expectedResult);
      expect(f.select().scopeSchemaText).toBe(candidate);
      expect(f.receipt(requestId)?.response).toEqual({
        kind: 'knowledge_schema_report',
        id: reportDigest,
      });
      expect(f.audits(requestId)).toHaveLength(1);
    } else {
      expect(actualFailure).toMatchObject({ code: 'unavailable', commit: 'unknown' });
      expect(JSON.stringify(failed.body)).not.toMatch(/"commit":"not-committed"/);
      expect(schemaFreshness.failures).toEqual([]);
      expect(schemaFreshness.sqlFaults).toEqual([]);
      expect(schemaFreshness.droppedAcks).toEqual([
        { id: forecast.id, operation: producer[0]!.operation },
      ]);
      expect(schemaFreshness.commits.map(({ id, phase }) => ({ id, phase }))).toEqual([
        { id: forecast.id, phase: 'before' },
        { id: forecast.id, phase: 'after' },
      ]);
      expect(schemaFreshness.commits[0]?.synchronous).toBe(2);
      const expectedFiles = [
        {
          path: join(historyRoot, `${reviewed.baseSchemaDigest.slice(7)}.yaml`),
          text: originalSchema,
        },
        {
          path: join(historyRoot, `${reviewed.candidateSchemaDigest.slice(7)}.yaml`),
          text: candidate,
        },
        { path: join(historyRoot, `${reportDigest.slice(7)}.json`), text: packet },
      ];
      expect(schemaFreshness.commits[0]?.files).toEqual(
        expectedFiles.map(({ path, text }) => ({ path, hex: Buffer.from(text).toString('hex') }))
      );
      const committedHead = f.select().head;
      const committedReceipt = f.receipt(requestId);
      const committedAudits = f.audits(requestId);
      const committedHistory = schemaHistoryBytes(historyRoot);
      expect(f.select().scopeSchemaText).toBe(candidate);
      expect(committedHead.notebookCommit).toBe(before.head.notebookCommit);
      expect(committedReceipt).not.toBeNull();
      expect(committedReceipt).toEqual({
        key: commandRequestKey('knowledge.schema.apply', requestId, {
          workspaceId: f.workspace.id,
          actorId: f.userId,
        }),
        command: 'knowledge.schema.apply',
        requestId,
        scope: { workspaceId: f.workspace.id, actorId: f.userId },
        inputHash: commandInputHash({ workspaceId: f.workspace.id, ...input }),
        response: { kind: 'knowledge_schema_report', id: reportDigest },
        createdAt: committedReceipt!.createdAt,
        expiresAt: commandRequestExpiresAt(committedReceipt!.createdAt),
      });
      expect(committedAudits).toHaveLength(1);
      expect(committedAudits[0]).toMatchObject({
        outcome: 'succeeded',
        resource: `knowledge-schema-report:${reportDigest}`,
      });
      clear();
      // This explicit new caller request inspects the original committed receipt while
      // the failed host stays failed. It does not retry the unknown native effect.
      const replay = await f.call('knowledge.schema.apply', input);
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body).toEqual(expectedResult);
      expect(f.select().head).toEqual(committedHead);
      expect(f.receipt(requestId)).toEqual(committedReceipt);
      expect(f.audits(requestId)).toEqual(committedAudits);
      expect(schemaHistoryBytes(historyRoot)).toEqual(committedHistory);
    }
  } finally {
    clear();
  }
});

it('refuses an actual pending Notebook publication validated under the prior Schema head', async () => {
  const f = await nativeSchemaReviewFixture();
  const before = f.select();
  const candidate = before.scopeSchemaText.replace(
    /^allowed_types:.*$/m,
    'allowed_types: [KnowledgePage, SourceSummary]'
  );
  const reviewed = await f.preview(candidate);
  expect(reviewed.records.every((row) => row.status === 'valid')).toBe(true);
  const pendingContent = before.notebook
    .readContent(before.head.notebookCommit)
    ['first.md']!.replace('type: "KnowledgePage"', 'type: "Observation"');
  expect(pendingContent).toContain('type: "Observation"');
  const pendingRequestId = randomUUID();
  const pendingInput = {
    requestId: pendingRequestId,
    baseRevision: before.head.notebookCommit,
    path: 'pending-observation.md',
    content: pendingContent,
    summary: 'A genuine producer validated before the Schema changes.',
  };
  let reached!: () => void;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let resumePending: (() => void) | undefined;
  let pendingPosts = 0;
  schemaFreshness.database = `workspace:${f.workspaceDb.sqlite.name}`;
  schemaFreshness.historyRoot = join(f.workspaceRoot, 'knowledge', 'schema', 'history');
  schemaFreshness.phase = 'armed';
  schemaFreshness.injectionError = undefined;
  schemaFreshness.injections = 0;
  schemaFreshness.forecasts = [];
  schemaFreshness.posts = [];
  schemaFreshness.decisions = [];
  schemaFreshness.failures = [];
  schemaFreshness.mutate = undefined;
  schemaFreshness.beforeDecision = undefined;
  schemaFreshness.dropAck = false;
  Atomics.store(new Int32Array(schemaFreshness.commitGate), 0, 0);
  Atomics.store(new Int32Array(schemaFreshness.sqlFaultGate), 0, 0);
  schemaFreshness.holdPost = (value, forward) => {
    if (
      !isControlWorkerRequest(value) ||
      value.operation !== 'write' ||
      value.database !== schemaFreshness.database ||
      !value.statements.some(
        (row) =>
          row.sql.includes('INSERT INTO idempotency_requests') &&
          row.parameters.includes(pendingRequestId)
      )
    )
      return false;
    pendingPosts += 1;
    if (resumePending) return false;
    const cas = value.statements.find((row) => row.sql.includes('UPDATE knowledge_notebook_heads'));
    expect(cas).toBeDefined();
    // Prove the actual original producer carried its validated Notebook and Schema head.
    expect(cas!.parameters).toContain(before.head.notebookCommit);
    expect(cas!.parameters).toContain(before.head.schemaContent.reference.contentDigest);
    let resumed = false;
    resumePending = () => {
      if (!resumed) {
        resumed = true;
        forward();
      }
    };
    reached();
    return true;
  };
  const pending = f.call('knowledge.notebook.create', pendingInput);
  const clear = () => {
    schemaFreshness.holdPost = undefined;
    schemaFreshness.phase = 'idle';
    schemaFreshness.mutate = undefined;
    schemaFreshness.beforeDecision = undefined;
  };
  onTestFinished(clear);
  try {
    await Promise.race([
      held,
      pending.then(() => {
        throw new Error('Notebook request settled before the real held POST.');
      }),
    ]);
    expect(pendingPosts).toBe(1);
    expect(f.select().head).toEqual(before.head);
    expect(
      f.store.getCommandRequest(
        'knowledge.notebook.create',
        pendingRequestId,
        { workspaceId: f.workspace.id, actorId: f.userId },
        f.workspaceDb
      )
    ).toBeNull();
    const schemaRequestId = randomUUID();
    const applied = await f.call('knowledge.schema.apply', {
      requestId: schemaRequestId,
      baseRevision: reviewed.notebookRevision,
      schemaText: candidate,
      reviewedReport: reviewed,
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const winningHead = f.select().head;
    const winningPages = f.select().notebook.readContent(winningHead.notebookCommit);
    const winningSchemaReceipt = f.receipt(schemaRequestId);
    const winningSchemaAudits = f.audits(schemaRequestId);
    expect(winningHead.notebookCommit).toBe(before.head.notebookCommit);
    expect(f.select().scopeSchemaText).toBe(candidate);
    expect(winningPages).not.toHaveProperty('pending-observation.md');
    expect(winningSchemaReceipt).not.toBeNull();
    expect(winningSchemaAudits).toHaveLength(1);
    resumePending!();
    const refused = await pending;
    // Either the retained Schema-head CAS refuses, or fresh validation rejects the
    // Observation under the new allowed types. Neither route may publish old validation.
    expect([
      { status: 409, code: 'conflict' },
      { status: 400, code: 'invalid_request' },
    ]).toContainEqual({ status: refused.status, code: refused.body.code });
    expect(pendingPosts).toBe(1);
    expect(f.select().head).toEqual(winningHead);
    expect(f.select().scopeSchemaText).toBe(candidate);
    expect(f.select().notebook.readContent(winningHead.notebookCommit)).toEqual(winningPages);
    expect(
      f.store.getCommandRequest(
        'knowledge.notebook.create',
        pendingRequestId,
        { workspaceId: f.workspace.id, actorId: f.userId },
        f.workspaceDb
      )
    ).toBeNull();
    expect(
      listSqliteAuditEvents(f.workspaceDb.sqlite, f.workspace.id).filter(
        (row) => row.requestId === pendingRequestId
      )
    ).toEqual([]);
    expect(f.receipt(schemaRequestId)).toEqual(winningSchemaReceipt);
    expect(f.audits(schemaRequestId)).toEqual(winningSchemaAudits);
  } finally {
    clear();
    // Forward the exact held request before fixture shutdown, including assertion failures.
    // Its original promise must settle before cleanup closes its Store or SQLite owners.
    if (resumePending) resumePending();
    await pending;
  }
});
