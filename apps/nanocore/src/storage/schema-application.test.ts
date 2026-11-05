import { randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
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
import { verifyOpenKitAccessTokenRecord } from '../auth/access-token-verification.js';
import { createBetterAuth } from '../auth/better-auth.js';
import type { Actor } from '../auth/identity.js';
import {
  currentWorkspaceAuthority,
  isCurrentServerPolicyAuthor,
  isWorkspaceOperationAuthorized,
  readCurrentWorkspacePolicy,
} from '../auth/operation-authorizer.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { isScopeAdmitted, refuseScope, scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createRuntimeConfigManager, findWorkspaceConfig } from '../config/runtime-config.js';
import { readWorkspaceNotebookSelection } from '../knowledge/notebook-workspace-selection.js';
import { commandRequestExpiresAt, commandRequestKey } from '../lib/store.js';
import { OperationError } from '../operation-error.js';
import {
  knowledgePageReadable,
  knowledgeSourceAudienceReadable,
  threadReadable,
} from '../retrieval-knowledge-adapter.js';
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
  controlKnowledgeReviewStatement,
  prepareWorkspaceKnowledgeSelection,
  readControlKnowledgeHead,
} from './control-store-knowledge.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import {
  ControlPhysicalForecastDecisionSchema,
  ControlSchemaApplicationRefusalSchema,
  isControlWorkerRequest,
} from './control-store-worker-protocol.js';
import { openWorkspaceDb, openWorkspaceReadDb } from './db.js';
import { retrieveWorkspaceKnowledge } from './index-rebuild.js';
import { retrievalTraceRelativePath } from './retrieval-traces.js';
import { appendWorkObservation, readWorkObservations } from './work-observations.js';

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
  // Mode 1 keeps the queued-frame handshake. Mode 2 delays only already released
  // native continuations for this test; neither mode retains a SQL cut.
  preparationGate: new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT),
  preparationReceived: undefined as (() => void) | undefined,
  preparationSignals: [] as Array<{
    id: number;
    event:
      | 'selected-head'
      | 'immutable'
      | 'yield'
      | 'revision-captured'
      | 'yield-paused'
      | 'yield-released'
      | 'winner-committed';
    sqlCut: boolean;
    headIsWinner?: boolean;
  }>,
  preparationAcks: [] as number[],
  // Only finite facts about the genuine refusal are retained; no report or Actor payload.
  disclosurePath: undefined as string | undefined,
  disclosureRefusals: [] as Array<{
    id: number;
    notCommitted: boolean;
    fullReportConflict: boolean;
    protectedImpact: boolean;
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
          const fs=require('node:fs');
          const readFileSync=fs.readFileSync;
          const preparationGate=new Int32Array(workerData.schemaPreparationGate);
          const selectedDatabases=new Set();
          let preparationId;
          let preparationDatabase;
          let targetHeadSelected=false;
          // Mode 2 tags only this test's two real requests. Async context prevents a later
          // winner revalidation from being mistaken for the losing request's C1 capture.
          const preparationContext=new (require('node:async_hooks').AsyncLocalStorage)();
          const on=parentPort.on;
          parentPort.on=function(event,listener) {
            if(event!=='message') return on.call(this,event,listener);
            return on.call(this,event,function(value,...args) {
              if(Atomics.load(preparationGate,0)!==2)
                return Reflect.apply(listener,this,[value,...args]);
              return preparationContext.run(value && value.id,()=>Reflect.apply(listener,this,[value,...args]));
            });
          };
          let earlyWinnerId;
          let earlyLoserId;
          let earlyPauseId;
          let earlyCaptured=false;
          let earlyWinnerHeadSelected=false;
          let earlyWinnerPaused=false;
          let earlyWinnerDigest;
          let earlyWinnerNotebookCommit;
          let earlyWinnerCommitted=false;
          let earlyHeadObserved=false;
          const observeEarly=(id,event,extra={})=> {
            if(Atomics.load(preparationGate,0)!==2) return;
            post({schemaPreparation:true,id,event,...extra,
              sqlCut:[...selectedDatabases].some(db=>db.open && db.inTransaction)});
          };
          const timers=require('node:timers/promises');
          const nextEventLoopTurn=timers.setImmediate;
          timers.setImmediate=function(...args) {
            const id=preparationContext.getStore();
            let cell;
            if(Atomics.load(preparationGate,0)===2 && id!==undefined) {
              if(id===earlyWinnerId && earlyWinnerHeadSelected && !earlyWinnerPaused) {
                earlyWinnerPaused=true;
                cell=1;
              } else if(id===earlyPauseId) {
                earlyPauseId=undefined;
                cell=2;
              }
            }
            const original=nextEventLoopTurn.apply(this,args);
            if(cell===undefined) return original;
            // Only existing production await sites are held. First admit/capture the loser
            // before winner promotion; then keep only the losing continuation suspended.
            const released=Atomics.waitAsync(preparationGate,cell,0);
            observeEarly(id,cell===1 ? 'selected-head' : 'yield-paused');
            return original.then(value=>Promise.resolve(released.value).then(()=> {
              if(cell===2) observeEarly(id,'yield-released');
              return value;
            }));
          };
          const pragma=Database.prototype.pragma;
          Database.prototype.pragma=function(...args) {
            const result=pragma.apply(this,args);
            const [sql,options]=args;
            const id=preparationContext.getStore();
            if(Atomics.load(preparationGate,0)===2 && id===earlyLoserId && id!==undefined && !earlyCaptured &&
                this.name===preparationDatabase && sql==='main.schema_version' && options?.simple===true) {
              // This exact pragma is the final original read of the target's C1 tuple.
              earlyCaptured=true;
              earlyPauseId=id;
              observeEarly(id,'revision-captured');
            }
            return result;
          };
          const observePreparation=event=> {
            if(preparationId===undefined || Atomics.load(preparationGate,0)!==1) return;
            post({schemaPreparation:true,id:preparationId,event,
              sqlCut:[...selectedDatabases].some(db=>db.open && db.inTransaction)});
          };
          const queuePreparedReview=()=> {
            if(preparationId===undefined || Atomics.load(preparationGate,0)!==1 ||
              !targetHeadSelected || [...selectedDatabases].some(db=>db.open && db.inTransaction) ||
              Atomics.compareExchange(preparationGate,2,0,1)!==0) return;
            // The real target head has been selected under its required revision observation.
            // Queue the prepared Review only after every observed SQL transaction has ended.
            observePreparation('selected-head');
            Atomics.wait(preparationGate,1,0,5000);
            if(Atomics.load(preparationGate,1)!==1)
              throw new Error('Test Review frame was not queued after target head selection.');
          };
          // Only observe the real immutable-read boundary; original bytes and exceptions pass through.
          fs.readFileSync=function(...args) {
            queuePreparedReview();
            observePreparation('immutable');
            return readFileSync.apply(this,args);
          };
          require('node:module').syncBuiltinESMExports();
          const gate=new Int32Array(workerData.schemaCapacityCommitGate);
          const sqlFaultGate=new Int32Array(workerData.schemaSqlFaultGate);
          const post=parentPort.postMessage.bind(parentPort);
          let forecast;
          parentPort.on('message',value=> {
            const mode=Atomics.load(preparationGate,0);
            if((mode===1 || mode===2) && value && value.operation==='schema-application') {
              if(mode===2) {
                if(earlyWinnerId===undefined) earlyWinnerId=value.id;
                else if(earlyLoserId===undefined && value.id!==earlyWinnerId) {
                  earlyLoserId=value.id;
                }
              }
              preparationId=value.id;
              preparationDatabase=value.database.startsWith('workspace:')
                ? value.database.slice('workspace:'.length) : undefined;
              targetHeadSelected=false;
            }
          });
          parentPort.postMessage=function(value,...args) {
            if(value && value.id===preparationId &&
              (value.status==='physical-forecast' || value.status==='error' || value.status==='ok'))
              preparationId=undefined;
            if((Atomics.load(gate,0)===1 || Atomics.load(sqlFaultGate,0)===1) &&
              value && value.status==='physical-forecast') forecast=value;
            return post(value,...args);
          };
          // Observe only a genuine targeted SQLite trigger failure; execute the original
          // statement and rethrow its actual error. No synthetic SQL failure is returned.
          const prepare=Database.prototype.prepare;
          Database.prototype.prepare=function(sql) {
            const statement=prepare.call(this,sql);
            const db=this;
            selectedDatabases.add(db);
            for(const method of ['get','all']) {
              const select=statement[method];
              statement[method]=function(...parameters) {
                const result=select.apply(this,parameters);
                if(Atomics.load(preparationGate,0)===2 && db.name===preparationDatabase &&
                    /FROM\\s+knowledge_notebook_heads\\b/i.test(sql)) {
                  const rows=Array.isArray(result) ? result : [result];
                  const head=rows.find(row=>row && typeof row.record_json==='string');
                  const id=preparationContext.getStore();
                  if(head && id!==undefined && id===earlyWinnerId) earlyWinnerHeadSelected=true;
                  if(head && id!==undefined && id===earlyLoserId && !earlyHeadObserved) {
                    earlyHeadObserved=true;
                    let headIsWinner=false;
                    try {
                      const selectedHead=JSON.parse(head.record_json);
                      headIsWinner=earlyWinnerCommitted && typeof earlyWinnerDigest==='string' &&
                        selectedHead.schemaContent.reference.contentDigest===earlyWinnerDigest &&
                        selectedHead.notebookCommit===earlyWinnerNotebookCommit;
                    } catch {}
                    observeEarly(id,'selected-head',{headIsWinner});
                  }
                }
                if(preparationId!==undefined && Atomics.load(preparationGate,0)===1) {
                  const rows=Array.isArray(result) ? result : [result];
                  if(db.name===preparationDatabase &&
                    /FROM\\s+knowledge_notebook_heads\\b/i.test(sql) &&
                    rows.some(row=>row && typeof row.record_json==='string'))
                    targetHeadSelected=true;
                  queuePreparedReview();
                  setImmediate(()=> {
                    queuePreparedReview();
                    observePreparation('yield');
                  });
                }
                return result;
              };
            }
            if(/UPDATE\\s+knowledge_notebook_heads\\s+SET\\s+record_json/i.test(sql)) {
              const run=statement.run;
              statement.run=function(...parameters) {
                const result=run.apply(this,parameters);
                if(Atomics.load(preparationGate,0)===2 && db.name===preparationDatabase &&
                    preparationContext.getStore()===earlyWinnerId && result.changes===1) {
                  try {
                    earlyWinnerDigest=JSON.parse(parameters[1]).reference.contentDigest;
                    earlyWinnerNotebookCommit=parameters[0];
                  } catch {}
                }
                return result;
              };
            }
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
            if(Atomics.load(preparationGate,0)===2 && selected.id===earlyWinnerId) {
              earlyWinnerCommitted=true;
              observeEarly(selected.id,'winner-committed');
            }
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
            schemaPreparationGate: schemaFreshness.preparationGate,
          },
        });
        const emit = this.emit.bind(this);
        this.emit = ((event: string | symbol, ...args: unknown[]) => {
          const value = args[0];
          if (event === 'message' && value !== null && typeof value === 'object') {
            const row = value as Record<string, unknown>;
            if (
              schemaFreshness.disclosurePath !== undefined &&
              row.status === 'error' &&
              typeof row.id === 'number' &&
              schemaFreshness.posts.some(
                (posted) => posted.id === row.id && posted.operation === 'schema-application'
              )
            ) {
              const refusal = ControlSchemaApplicationRefusalSchema.safeParse(row.domain);
              const details = refusal.success ? refusal.data.details : undefined;
              const report =
                details && 'actualReport' in details ? details.actualReport : undefined;
              schemaFreshness.disclosureRefusals.push({
                id: row.id,
                notCommitted: row.commit === 'not-committed',
                fullReportConflict: Boolean(
                  refusal.success &&
                    refusal.data.code === 'conflict' &&
                    refusal.data.status === 409 &&
                    report
                ),
                protectedImpact: Boolean(
                  report?.records.some(
                    (record) =>
                      record.path === schemaFreshness.disclosurePath &&
                      record.status === 'needs-review' &&
                      canonicalJsonText(record.diagnostics) ===
                        canonicalJsonText([
                          { code: 'scope_schema.type_not_allowed', field: 'type' },
                        ])
                  )
                ),
              });
            }
            if (row.schemaPreparation === true) {
              schemaFreshness.preparationSignals.push({
                id: row.id as number,
                event: row.event as (typeof schemaFreshness.preparationSignals)[number]['event'],
                sqlCut: row.sqlCut as boolean,
                ...(typeof row.headIsWinner === 'boolean'
                  ? { headIsWinner: row.headIsWinner }
                  : {}),
              });
              if (
                row.event === 'selected-head' ||
                (row.event === 'yield-paused' &&
                  Atomics.load(new Int32Array(schemaFreshness.preparationGate), 0) === 2)
              )
                schemaFreshness.preparationReceived?.();
              return true;
            }
            if (
              row.status === 'ok' &&
              typeof row.id === 'number' &&
              Atomics.load(new Int32Array(schemaFreshness.preparationGate), 0) === 1
            )
              schemaFreshness.preparationAcks.push(row.id);
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
    sourcePin,
    dataRoot,
    coreDb,
    workspaceDb,
    runtimeConfigManager,
    fileAdmission,
    // This operation's strict input has no requestId. Keep the original call helper
    // unchanged and use the same App, manager and genuine credential for publication.
    applyApprovedResourcePolicy: async (input: { threadId: string; approvalRequestId: string }) => {
      const response = await app.request('/api/app/operations/workspace.resource-access-apply', {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: workspace.id,
          ...input,
          confirmation: 'APPLY WORKSPACE RESOURCE POLICY',
        }),
      });
      return { status: response.status, body: await response.json() };
    },
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

/** Arms the existing genuine forecast boundary for each submitted administrative attempt. */
function armOptionCForecasts(
  f: Awaited<ReturnType<typeof nativeSchemaReviewFixture>>,
  mutate: () => void | Promise<void>
) {
  const historyRoot = join(f.workspaceRoot, 'knowledge', 'schema', 'history');
  schemaFreshness.database = `workspace:${f.workspaceDb.sqlite.name}`;
  schemaFreshness.historyRoot = historyRoot;
  schemaFreshness.injectionError = undefined;
  schemaFreshness.injections = 0;
  schemaFreshness.forecasts = [];
  schemaFreshness.posts = [];
  schemaFreshness.decisions = [];
  schemaFreshness.failures = [];
  schemaFreshness.commits = [];
  schemaFreshness.mutate = mutate;
  schemaFreshness.beforeDecision = undefined;
  schemaFreshness.dropAck = false;
  // Forward every actual decision. Re-arm observation only; this neither submits nor retries work.
  schemaFreshness.holdPost = (value) => {
    const decision = ControlPhysicalForecastDecisionSchema.safeParse(value);
    if (decision.success && decision.data.database === schemaFreshness.database)
      schemaFreshness.phase = 'armed';
    return false;
  };
  schemaFreshness.phase = 'armed';
  onTestFinished(() => {
    schemaFreshness.phase = 'idle';
    schemaFreshness.mutate = undefined;
    schemaFreshness.beforeDecision = undefined;
    schemaFreshness.holdPost = undefined;
    Atomics.store(new Int32Array(schemaFreshness.commitGate), 0, 0);
  });
  return historyRoot;
}

it('requires current native schema-write admission when replaying the same User receipt through a readonly credential', async () => {
  const f = await nativeSchemaReviewFixture();
  const candidate = `${f.select().scopeSchemaText.trimEnd()}\n# Native retained-receipt write admission.\n`;
  const reviewed = await f.preview(candidate);
  const requestId = randomUUID();
  const input = {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  };
  const client = getControlStoreWorkerClient();
  const apply = client.applyWorkspaceSchema.bind(client);
  const captured: Array<Parameters<typeof client.applyWorkspaceSchema>[0]> = [];
  // Keep the genuine native producer call and capture only its non-secret domain inputs.
  const capture = vi.spyOn(client, 'applyWorkspaceSchema').mockImplementation((owned) => {
    if (owned.request.requestId === requestId) captured.push(owned);
    return apply(owned);
  });
  onTestFinished(() => capture.mockRestore());
  const historyRoot = armOptionCForecasts(f, () => {});
  Atomics.store(new Int32Array(schemaFreshness.commitGate), 0, 1);
  const applied = await f.call('knowledge.schema.apply', input);
  capture.mockRestore();
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  expect(captured.length).toBe(1);
  const original = captured[0]!;
  expect(original.request).toEqual({ workspaceId: f.workspace.id, ...input });
  expect(original.producer).toEqual({ kind: 'user', id: f.userId });
  expect(original.requestActor.userId).toBe(f.userId);
  expect(original.requestActor.tokenScope).toBe('workspace');
  expect(original.candidateHead.schemaContent.reference.contentDigest).toBe(
    reviewed.candidateSchemaDigest
  );
  const receipt = f.receipt(requestId);
  expect(receipt !== null).toBe(true);
  if (!receipt) throw new Error('The original schema receipt was not retained.');
  expect(receipt).toEqual({
    key: commandRequestKey('knowledge.schema.apply', requestId, {
      workspaceId: f.workspace.id,
      actorId: f.userId,
    }),
    command: 'knowledge.schema.apply',
    requestId,
    scope: { workspaceId: f.workspace.id, actorId: f.userId },
    inputHash: commandInputHash({ workspaceId: f.workspace.id, ...input }),
    response: { kind: 'knowledge_schema_report', id: applied.body.reportDigest },
    createdAt: receipt.createdAt,
    expiresAt: commandRequestExpiresAt(receipt.createdAt),
  });
  const { response: _response, ...retainedInput } = receipt;
  expect(original.receipt).toEqual({
    ...retainedInput,
    responseKind: 'knowledge_schema_report',
  });
  expect(schemaFreshness.injectionError).toBeUndefined();
  expect(schemaFreshness.forecasts).toHaveLength(1);
  const firstId = schemaFreshness.forecasts[0]!.id;
  expect(schemaFreshness.commits.map(({ id, phase }) => ({ id, phase }))).toEqual([
    { id: firstId, phase: 'before' },
    { id: firstId, phase: 'after' },
    { id: firstId, phase: 'ack' },
  ]);
  expect(schemaFreshness.commits[0]?.synchronous).toBe(2);
  const packet = JSON.parse(
    readFileSync(join(historyRoot, `${applied.body.reportDigest.slice(7)}.json`), 'utf8')
  );
  expect(packet.reviewedReport).toEqual(reviewed);
  expect(packet.actualReport).toEqual(reviewed);
  const audits = f.audits(requestId);
  expect(audits).toHaveLength(1);

  // A real later Notebook member makes current inventory different from the original report.
  // Native receipt replay must inspect the retained result without recomputing its impact.
  await f.publish('after-native-receipt.md');
  const current = await f.preview(candidate);
  expect(current.records).toContainEqual(
    expect.objectContaining({ path: 'after-native-receipt.md', status: 'valid' })
  );
  expect(current.records).not.toEqual(reviewed.records);
  const selected = f.select();
  const pages = selected.notebook.readContent(selected.head.notebookCommit);
  const history = schemaHistoryBytes(historyRoot);
  const commits = structuredClone(schemaFreshness.commits);
  schemaFreshness.mutate = () => {
    throw new Error('Retained schema receipt replay requested another physical forecast.');
  };

  // Issue and authenticate through the actual Token/native verification owners. The bearer
  // stays in memory and is never part of an assertion, native schema input or observation.
  const issued = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: f.userId,
    scope: 'workspace-readonly',
    workspaceIds: [f.workspace.id],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const verified = await verifyOpenKitAccessTokenRecord(f.coreDb, issued.secret);
  if (!verified) throw new Error('The owner-issued readonly credential did not authenticate.');
  // This is the production auth facade projection of its verified non-secret Token record.
  const readOnlyActor: Actor = {
    kind: 'token',
    userId: verified.ownerUserId,
    tokenId: verified.tokenId,
    tokenScope: verified.scope,
    tokenWorkspaceIds: [...verified.workspaceIds],
  };
  expect(readOnlyActor.userId).toBe(original.producer.id);
  expect(readOnlyActor.tokenScope).toBe('workspace-readonly');
  expect(readOnlyActor.tokenId === original.requestActor.tokenId).toBe(false);
  expect(
    isWorkspaceOperationAuthorized(f.coreDb, readOnlyActor, f.workspace.id, {
      mutating: false,
      policyOperation: 'knowledge.read',
    })
  ).toBe(true);
  expect(
    isWorkspaceOperationAuthorized(f.coreDb, readOnlyActor, f.workspace.id, {
      mutating: true,
      policyOperation: 'knowledge.write',
    })
  ).toBe(false);

  // Main's original invocation handle is closed after public return. Use the fixture's real
  // inspection connection to address the same native owner. Preserve its exact original
  // command, candidate, producer, receipt and live non-retained Main fact supplier.
  const nativeReplay = (requestActor: Actor) =>
    apply({
      ...original,
      workspaceDb: f.workspaceDb,
      requestActor,
      captureFacts: () => ({ ...original.captureFacts(), presentedActor: requestActor }),
    });
  expect(await nativeReplay(original.requestActor)).toEqual(applied.body);
  expect(schemaFreshness.injectionError).toBeUndefined();
  expect(schemaFreshness.forecasts).toHaveLength(1);
  expect(
    schemaFreshness.posts.filter((row) => row.operation === 'schema-application')
  ).toHaveLength(2);
  expect(f.receipt(requestId)).toEqual(receipt);
  expect(f.audits(requestId)).toEqual(audits);
  expect(schemaHistoryBytes(historyRoot)).toEqual(history);
  expect(f.select().head).toEqual(selected.head);
  expect(f.select().notebook.readContent(selected.head.notebookCommit)).toEqual(pages);

  const [denied] = await Promise.allSettled([nativeReplay(readOnlyActor)]);
  // Intended current-C2 RED: the real native retained-receipt path returns the original
  // report to this read-eligible credential instead of applying its original write predicate.
  expect(denied.status).toBe('rejected');
  if (denied.status !== 'rejected')
    throw new Error('Native schema receipt replay accepted a readonly credential.');
  expect(denied.reason instanceof OperationError).toBe(true);
  const failure = denied.reason as OperationError;
  expect({ code: failure.code, status: failure.status }).toEqual({
    code: 'workspace_access_denied',
    status: 403,
  });
  const posts = schemaFreshness.posts.filter((row) => row.operation === 'schema-application');
  expect(posts).toHaveLength(3);
  expect(new Set(posts.map((row) => row.id)).size).toBe(3);
  expect(schemaFreshness.injectionError).toBeUndefined();
  expect(schemaFreshness.forecasts).toHaveLength(1);
  expect(schemaFreshness.commits).toEqual(commits);
  expect(f.receipt(requestId)).toEqual(receipt);
  expect(f.audits(requestId)).toEqual(audits);
  expect(schemaHistoryBytes(historyRoot)).toEqual(history);
  expect(f.select().head).toEqual(selected.head);
  expect(f.select().scopeSchemaText).toBe(candidate);
  expect(f.select().notebook.readContent(selected.head.notebookCommit)).toEqual(pages);
});

/** Drafts a fixed candidate through the public Proposal owner, without publishing it. */
async function optionCProposal(f: Awaited<ReturnType<typeof nativeSchemaReviewFixture>>) {
  const selection = f.select();
  // The single-Page Proposal input carries its future accepted content. The real Proposal
  // and human Review owners still decide whether these candidate bytes become published.
  const content = selection.notebook
    .readContent(selection.head.notebookCommit)
    ['first.md']!.replace('review_state: "user-authored"', 'review_state: "accepted"')
    .replace(
      'An explicit human-authored Page with admitted Source evidence.',
      'An explicit human-authored Page with admitted Source evidence. Reviewed current bytes.'
    );
  const drafted = await f.call('knowledge.proposal.draft', {
    requestId: randomUUID(),
    baseRevision: selection.head.notebookCommit,
    knowledgePageId: 'first',
    canonicalPageBytes: content,
    contentDigest: `sha256:${sha256Hex(content)}`,
    sourceReferences: [f.sourcePin],
    rationale: 'Retain an actual current candidate for concurrent human review.',
    confidence: 0.9,
  });
  expect(drafted.status, JSON.stringify(drafted.body)).toBe(200);
  const proposal = f.store.getKnowledgeProposal(drafted.body.proposal.id)!;
  expect(proposal).not.toBeNull();
  return {
    proposal,
    decision: {
      requestId: randomUUID(),
      proposalId: proposal.id,
      decision: 'deferred' as const,
      proposalDigest: f.store.knowledgeProposalDigest(f.workspace.id, proposal.id),
      baseRevision: proposal.baseRevision,
      candidateRevision: proposal.candidateRevision,
    },
  };
}

it('recomputes once after a real external Review append and replays its exact original receipt', async () => {
  const f = await nativeSchemaReviewFixture();
  const { proposal, decision } = await optionCProposal(f);
  const candidate = `${f.select().scopeSchemaText.trimEnd()}\n# Readset conflict, fixed reviewed command.\n`;
  const reviewed = await f.preview(candidate);
  const before = f.select().head;
  const requestId = randomUUID();
  const input = {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  };
  // The public Store's actual decision producer validates the original candidate and ordered Reviews.
  const prepared = f.store.prepareKnowledgeProposalReviewDecision({
    ...decision,
    workspaceId: f.workspace.id,
    actor: { kind: 'user', id: f.userId },
    decidedAt: new Date().toISOString(),
    verifiedExternalReferences: [],
  });
  const append = controlKnowledgeReviewStatement(f.workspaceDb, proposal.id, prepared.review);
  let externalCommits = 0;
  const reservations: Array<{ releases: number }> = [];
  const reserve = FileStorageAdmission.prototype.reserve;
  const observeReservations = vi
    .spyOn(FileStorageAdmission.prototype, 'reserve')
    .mockImplementation(function (this: FileStorageAdmission, writes, priority) {
      const reservation = reserve.call(this, writes, priority);
      if (schemaFreshness.phase === 'receiving') {
        const row = { releases: 0 };
        reservations.push(row);
        const release = reservation.release.bind(reservation);
        reservation.release = () => {
          row.releases += 1;
          release();
        };
      }
      return reservation;
    });
  onTestFinished(() => observeReservations.mockRestore());
  const historyRoot = armOptionCForecasts(f, () => {
    // The next attempt cannot borrow capacity held by the rejected original attempt.
    if (schemaFreshness.injections === 2) {
      expect(reservations.length).toBeGreaterThanOrEqual(3);
      expect(reservations.every((row) => row.releases === 1)).toBe(true);
    }
    expect(schemaHistoryBytes(historyRoot)).toEqual(initialHistory);
    expect(f.receipt(requestId)).toBeNull();
    expect(f.audits(requestId)).toEqual([]);
    if (schemaFreshness.injections !== 1) return;
    // Storage-owner fault injection, matching the existing competing-head test: use the
    // real owner's conditional statement on an actual second connection after valid setup.
    const writer = new Database(f.workspaceDb.sqlite.name, { fileMustExist: true });
    try {
      writer.transaction(() => {
        expect(writer.prepare(append.sql).run(...append.parameters).changes).toBe(1);
      })();
      externalCommits += 1;
    } finally {
      writer.close();
    }
    expect(f.store.listKnowledgeProposalReviewDecisions(f.workspace.id)).toEqual([prepared.review]);
    expect(f.select().head).toEqual(before);
  });
  const initialHistory = schemaHistoryBytes(historyRoot);
  Atomics.store(new Int32Array(schemaFreshness.commitGate), 0, 1);
  const result = await f.call('knowledge.schema.apply', input);
  expect(schemaFreshness.injectionError).toBeUndefined();
  expect(externalCommits).toBe(1);
  // Option C permits exactly one recomputation of a proved administrative conflict.
  // Baseline RED: it publishes the first stale inventory with just one genuine forecast.
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(schemaFreshness.forecasts).toHaveLength(2);
  expect(new Set(schemaFreshness.forecasts.map((row) => row.id)).size).toBe(2);
  expect(schemaFreshness.decisions.map((row) => row.decision)).toEqual(['admitted', 'admitted']);
  const successfulId = schemaFreshness.forecasts[1]!.id;
  expect(schemaFreshness.commits.map(({ id, phase }) => ({ id, phase }))).toEqual([
    { id: successfulId, phase: 'before' },
    { id: successfulId, phase: 'after' },
    { id: successfulId, phase: 'ack' },
  ]);
  expect(schemaFreshness.commits[0]?.synchronous).toBe(2);
  expect(reservations.length).toBeGreaterThanOrEqual(6);
  expect(reservations.every((row) => row.releases === 1)).toBe(true);
  const actual = await f.preview(candidate);
  expect(
    actual.dependencyInventory.find((row) => row.family === 'proposals')?.records
  ).toContainEqual(expect.objectContaining({ id: prepared.review.reviewId, status: 'valid' }));
  const reportPath = join(historyRoot, `${result.body.reportDigest.slice(7)}.json`);
  const packet = JSON.parse(readFileSync(reportPath, 'utf8'));
  expect(packet.reviewedReport).toEqual(reviewed);
  expect(packet.actualReport.dependencyInventory).toEqual(actual.dependencyInventory);
  const receipt = f.receipt(requestId);
  expect(receipt).toMatchObject({
    requestId,
    inputHash: commandInputHash({ workspaceId: f.workspace.id, ...input }),
    response: { kind: 'knowledge_schema_report', id: result.body.reportDigest },
  });
  expect(f.audits(requestId)).toHaveLength(1);
  expect(f.select().head.notebookCommit).toBe(before.notebookCommit);
  expect(f.select().scopeSchemaText).toBe(candidate);
  const head = f.select().head;
  const audits = f.audits(requestId);
  const history = schemaHistoryBytes(historyRoot);
  // A later inventory member cannot turn an explicit original-request replay into recomputation.
  await f.publish('after-original-receipt.md');
  const replayHead = f.select().head;
  schemaFreshness.mutate = () => {
    throw new Error('Original receipt replay requested a forecast.');
  };
  const replay = await f.call('knowledge.schema.apply', input);
  expect(replay).toEqual(result);
  expect(schemaFreshness.forecasts).toHaveLength(2);
  expect(f.receipt(requestId)).toEqual(receipt);
  expect(f.audits(requestId)).toEqual(audits);
  expect(schemaHistoryBytes(historyRoot)).toEqual(history);
  expect(f.select().head).toEqual(replayHead);
  expect(replayHead.schemaContent).toEqual(head.schemaContent);
});

it('exhausts two Core readset conflicts without schema publication or successor poisoning', async () => {
  const f = await nativeSchemaReviewFixture();
  const peers = [
    await f.store.createWorkspace('First independent Core owner'),
    await f.store.createWorkspace('Second independent Core owner'),
  ];
  const candidate = `${f.select().scopeSchemaText.trimEnd()}\n# Core revision exhaustion.\n`;
  const reviewed = await f.preview(candidate);
  const before = f.select().head;
  const requestId = randomUUID();
  let successor: ReturnType<typeof f.store.createThread> | undefined;
  let successorSettled:
    | Promise<{ kind: 'settled' } | { kind: 'rejected'; error: unknown }>
    | undefined;
  let successorPosted!: () => void;
  const posted = new Promise<{ kind: 'posted' }>((resolve) => {
    successorPosted = () => resolve({ kind: 'posted' });
  });
  let cancelPostWait!: () => void;
  let cancelled = false;
  const cancellation = new Promise<{ kind: 'cancelled' }>((resolve) => {
    cancelPostWait = () => {
      cancelled = true;
      resolve({ kind: 'cancelled' });
    };
  });
  const historyRoot = armOptionCForecasts(f, async () => {
    if (cancelled) return;
    expect(schemaHistoryBytes(historyRoot)).toEqual(initialHistory);
    expect(f.receipt(requestId)).toBeNull();
    expect(f.audits(requestId)).toEqual([]);
    const peer = peers[schemaFreshness.injections - 1];
    expect(peer).toBeDefined();
    // A real unrelated membership commit changes the actual Core database, with no target
    // Policy, current human, reviewed base, command identity or schema-content change.
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: peer!.id,
      ownerUserId: f.userId,
    });
    if (!successor) {
      successor = f.store.createThread(
        f.workspace.id,
        'Foreground successor of a proved admin conflict'
      );
      // Observe rejection immediately. An early settlement or teardown must also release
      // the genuine forecast; none can leave this callback waiting for an absent frame.
      successorSettled = successor.then(
        () => ({ kind: 'settled' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error })
      );
      const ready = await Promise.race([posted, successorSettled, cancellation]);
      if (ready.kind === 'rejected') throw ready.error;
      if (ready.kind === 'settled')
        throw new Error('The real successor settled without its original products frame.');
      if (ready.kind === 'cancelled') return;
    }
  });
  const initialHistory = schemaHistoryBytes(historyRoot);
  const rearm = schemaFreshness.holdPost!;
  schemaFreshness.holdPost = (value, forward) => {
    const held = rearm(value, forward);
    if (
      isControlWorkerRequest(value) &&
      value.database === schemaFreshness.database &&
      value.operation === 'products'
    )
      successorPosted();
    return held;
  };
  // onTestFinished runs in reverse registration order. This releases the held forecast
  // and joins its actual successor before the fixture starts native shutdown/drain.
  onTestFinished(async () => {
    cancelPostWait();
    await successorSettled;
  });
  const result = await f.call('knowledge.schema.apply', {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  });
  expect(schemaFreshness.injectionError).toBeUndefined();
  // Baseline RED: the first stale Core observation succeeds; broad retry implementations
  // also fail the exact two-attempt and original typed unavailability assertions.
  expect(result.status, JSON.stringify(result.body)).toBe(503);
  expect(result.body).toMatchObject({ code: 'operation_storage_unavailable' });
  expect(schemaFreshness.forecasts).toHaveLength(2);
  expect(new Set(schemaFreshness.forecasts.map((row) => row.id)).size).toBe(2);
  expect(schemaFreshness.injections).toBe(2);
  expect(schemaFreshness.decisions.map((row) => row.decision)).toEqual(['admitted', 'admitted']);
  expect(f.select().head).toEqual(before);
  expect(schemaHistoryBytes(historyRoot)).toEqual(initialHistory);
  expect(f.receipt(requestId)).toBeNull();
  expect(f.audits(requestId)).toEqual([]);
  expect(successor).toBeDefined();
  const thread = await successor!;
  expect(f.store.getThread(f.workspace.id, thread.id)).toEqual(thread);
});

it.each([
  'insert',
  'delete',
] as const)('recaptures exact physical retrieval filename membership after %s at the final forecast', async (change) => {
  const f = await nativeSchemaReviewFixture();
  const thread = await f.store.createThread(f.workspace.id, 'Physical trace inventory');
  const retrieve = () =>
    retrieveWorkspaceKnowledge({
      dataRoot: f.dataRoot,
      workspaceId: f.workspace.id,
      caller: 'app-api' as const,
      query: 'explicit human-authored Page',
      access: {
        store: f.store,
        coreDb: f.coreDb,
        workspaceDb: f.workspaceDb,
        actor: { kind: 'user' as const, id: f.userId },
        requestActor: f.requestActor,
        outputThreadId: thread.id,
      },
    });
  const originalTrace = change === 'delete' ? await retrieve() : undefined;
  if (originalTrace) expect(originalTrace.retrievalTraceRef).toBeDefined();
  const candidate = `${f.select().scopeSchemaText.trimEnd()}\n# Physical trace membership.\n`;
  const reviewed = await f.preview(candidate);
  const requestId = randomUUID();
  let inserted: Awaited<ReturnType<typeof retrieve>> | undefined;
  const historyRoot = armOptionCForecasts(f, async () => {
    expect(schemaHistoryBytes(historyRoot)).toEqual(initialHistory);
    if (schemaFreshness.injections !== 1) return;
    if (change === 'insert') {
      inserted = await retrieve();
      expect(inserted.retrievalTraceRef).toBeDefined();
    } else {
      // Deliberate physical deletion after the real retrieval publisher created valid evidence.
      const path = join(
        f.workspaceRoot,
        retrievalTraceRelativePath(originalTrace!.retrievalTraceRef!)
      );
      expect(existsSync(path)).toBe(true);
      rmSync(path);
      expect(existsSync(path)).toBe(false);
    }
  });
  const initialHistory = schemaHistoryBytes(historyRoot);
  const result = await f.call('knowledge.schema.apply', {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  });
  expect(schemaFreshness.injectionError).toBeUndefined();
  // SQL revisions cannot stand in for filename presence or absence. Baseline RED: one
  // forecast publishes the report from before the actual physical membership change.
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(schemaFreshness.forecasts).toHaveLength(2);
  const packet = JSON.parse(
    readFileSync(join(historyRoot, `${result.body.reportDigest.slice(7)}.json`), 'utf8')
  );
  const current = await f.preview(candidate);
  expect(packet.reviewedReport).toEqual(reviewed);
  expect(packet.actualReport.dependencyInventory).toEqual(current.dependencyInventory);
  const reference = (inserted ?? originalTrace)!.retrievalTraceRef!;
  const actualIds = current.dependencyInventory
    .find((row) => row.family === 'trace-references')!
    .records.map((row) => row.id);
  const originalIds = reviewed.dependencyInventory
    .find((row) => row.family === 'trace-references')!
    .records.map((row) => row.id);
  expect(actualIds.length - originalIds.length).toBe(change === 'insert' ? 1 : -1);
  expect(actualIds.some((id) => id.includes(reference.objectId))).toBe(change === 'insert');
  expect(f.audits(requestId)).toHaveLength(1);
  expect(f.receipt(requestId)?.response).toEqual({
    kind: 'knowledge_schema_report',
    id: result.body.reportDigest,
  });
});

it('commits a real foreground accepted Review during schema preparation with no retained SQL cut', async () => {
  const f = await nativeSchemaReviewFixture();
  const { proposal, decision } = await optionCProposal(f);
  // Existing owners produce several independent containers. This is a finite deciding fixture,
  // not a timing dose, test cap, old reader, synthetic Session or fabricated S39 trace.
  for (let index = 0; index < 4; index += 1)
    await f.store.createThread(f.workspace.id, `Preparation census container ${index}`);
  const candidate = `${f.select().scopeSchemaText.trimEnd()}\n# Foreground during preparation.\n`;
  const reviewed = await f.preview(candidate);
  const originalHead = f.select().head;
  const requestId = randomUUID();
  let reviewNativeId: number | undefined;
  let ordinaryNativeId: number | undefined;
  let ordinary: ReturnType<typeof f.store.createThread> | undefined;
  let ordinarySettled: Promise<unknown> | undefined;
  let forwardReview: (() => void) | undefined;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let review: ReturnType<typeof f.call>;
  const historyRoot = armOptionCForecasts(f, async () => {
    // An original FULL ACK before the first schema forecast proves the mutation passed the
    // outstanding preparer. Await public 200 only after this assertion, so baseline failure
    // releases the genuine forecast rather than deadlocking behind the old schema barrier.
    expect(reviewNativeId).toBeDefined();
    expect(schemaFreshness.preparationAcks).toContain(reviewNativeId);
    expect(ordinaryNativeId).toBeDefined();
    expect(schemaFreshness.preparationAcks).toContain(ordinaryNativeId);
    expect(schemaFreshness.preparationAcks.indexOf(ordinaryNativeId!)).toBeLessThan(
      schemaFreshness.preparationAcks.indexOf(reviewNativeId!)
    );
    expect((await review).status).toBe(200);
    expect(f.receipt(requestId)).toBeNull();
    expect(schemaHistoryBytes(historyRoot)).toEqual(initialHistory);
  });
  const initialHistory = schemaHistoryBytes(historyRoot);
  const rearm = schemaFreshness.holdPost!;
  schemaFreshness.holdPost = (value, forward) => {
    if (
      ordinary &&
      isControlWorkerRequest(value) &&
      value.operation === 'products' &&
      value.database === schemaFreshness.database &&
      ordinaryNativeId === undefined
    ) {
      ordinaryNativeId = value.id;
      // Native arrival is S, ordinary P, barrier W. Forward both genuine frames in that order.
      forward();
      forwardReview!();
      forwardReview = undefined;
      Atomics.store(new Int32Array(schemaFreshness.preparationGate), 1, 1);
      Atomics.notify(new Int32Array(schemaFreshness.preparationGate), 1);
      return true;
    }
    if (
      isControlWorkerRequest(value) &&
      value.operation === 'write' &&
      value.database === schemaFreshness.database &&
      value.statements.some(
        (row) =>
          row.sql.includes('INSERT INTO idempotency_requests') &&
          row.parameters.includes(decision.requestId)
      )
    ) {
      reviewNativeId = value.id;
      forwardReview = forward;
      reached();
      return true;
    }
    return rearm(value, forward);
  };
  review = f.call('knowledge.proposal.decide', { ...decision, decision: 'accepted' });
  await held;
  expect(forwardReview).toBeDefined();
  const gate = new Int32Array(schemaFreshness.preparationGate);
  schemaFreshness.preparationSignals = [];
  schemaFreshness.preparationAcks = [];
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 2, 0);
  schemaFreshness.preparationReceived = () => {
    ordinary = f.store.createThread(f.workspace.id, 'Ordinary predecessor of the Review barrier');
    ordinarySettled = ordinary.catch((error: unknown) => {
      schemaFreshness.injectionError = error;
      forwardReview?.();
      forwardReview = undefined;
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
    });
  };
  Atomics.store(gate, 0, 1);
  const clear = () => {
    Atomics.store(gate, 0, 0);
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
    schemaFreshness.preparationReceived = undefined;
    forwardReview?.();
    forwardReview = undefined;
  };
  onTestFinished(async () => {
    schemaFreshness.holdPost = undefined;
    clear();
    await ordinarySettled;
  });
  const applied = await f.call('knowledge.schema.apply', {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  });
  clear();
  // Baseline RED: synchronous preparation retains the unconditional barrier, so its first
  // forecast arrives without the accepted Review's original FULL ACK.
  expect(schemaFreshness.injectionError).toBeUndefined();
  const accepted = await review;
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  expect(
    schemaFreshness.preparationSignals.filter((row) => row.event === 'selected-head')
  ).toHaveLength(1);
  expect(schemaFreshness.preparationSignals.some((row) => row.event === 'immutable')).toBe(true);
  expect(schemaFreshness.preparationSignals.some((row) => row.event === 'yield')).toBe(true);
  expect(schemaFreshness.preparationSignals.every((row) => row.sqlCut === false)).toBe(true);
  // The native writer changed after the real target head selection and its required
  // revision observation. Its own data_version alone cannot detect that commit.
  expect(
    schemaFreshness.posts.filter((row) => row.operation === 'schema-application')
  ).toHaveLength(2);
  expect(schemaFreshness.posts.filter((row) => row.id === reviewNativeId)).toHaveLength(1);
  expect(schemaFreshness.posts.filter((row) => row.id === ordinaryNativeId)).toHaveLength(1);
  const ordinaryThread = await ordinary!;
  expect(f.store.getThread(f.workspace.id, ordinaryThread.id)).toEqual(ordinaryThread);
  expect(f.store.listKnowledgeProposalReviewDecisions(f.workspace.id)).toEqual([
    accepted.body.review,
  ]);
  expect(f.select().head.notebookCommit).toBe(proposal.candidateRevision);
  expect(f.select().head.notebookCommit).not.toBe(originalHead.notebookCommit);
  expect(f.select().scopeSchemaText).toBe(candidate);
  expect(f.receipt(requestId)?.response).toEqual({
    kind: 'knowledge_schema_report',
    id: applied.body.reportDigest,
  });
  expect(f.audits(requestId)).toHaveLength(1);
  const packet = JSON.parse(
    readFileSync(join(historyRoot, `${applied.body.reportDigest.slice(7)}.json`), 'utf8')
  );
  expect(packet.reviewedReport).toEqual(reviewed);
  expect(packet.actualReport.notebookRevision).toBe(proposal.candidateRevision);
  expect(
    packet.actualReport.dependencyInventory.find(
      (row: { family: string }) => row.family === 'proposals'
    ).records
  ).toContainEqual(expect.objectContaining({ id: accepted.body.review.reviewId, status: 'valid' }));
});

it.each([
  'negative-peer-write',
  'new-peer-domain',
] as const)('invalidates the actual opaque Turn search footprint after %s', async (change) => {
  const f = await nativeSchemaReviewFixture();
  const peer = await f.store.createWorkspace('Initially negative opaque lookup peer');
  recordWorkspaceOwnerMembership({ coreDb: f.coreDb, workspaceId: peer.id, ownerUserId: f.userId });
  const thread = await f.store.createThread(f.workspace.id, 'Turn-qualified retrieval evidence');
  const turn = await f.store.createTurn(
    f.workspace.id,
    thread.id,
    'Actual retained query owner.',
    { kind: 'user', id: f.userId },
    null,
    { status: 'pending' }
  );
  const trace = await retrieveWorkspaceKnowledge({
    dataRoot: f.dataRoot,
    workspaceId: f.workspace.id,
    caller: 'app-api',
    query: 'explicit human-authored Page',
    access: {
      store: f.store,
      coreDb: f.coreDb,
      workspaceDb: f.workspaceDb,
      actor: { kind: 'user', id: f.userId },
      requestActor: f.requestActor,
      outputThreadId: thread.id,
      outputTurnId: turn.id,
    },
  });
  expect(trace.retrievalTraceRef).toBeDefined();
  // The real trace reader resolves its containing Turn through getTurnById. The search
  // includes this actual admitted peer, where the requested Turn is absent, not selected.
  expect(f.store.listThreads(peer.id)).toEqual([]);
  const candidate = `${f.select().scopeSchemaText.trimEnd()}\n# Opaque search footprint.\n`;
  const reviewed = await f.preview(candidate);
  expect(
    reviewed.dependencyInventory.find((row) => row.family === 'trace-references')!.records
  ).toContainEqual(
    expect.objectContaining({
      id: expect.stringContaining(trace.retrievalTraceRef!.objectId),
      status: 'valid',
    })
  );
  const requestId = randomUUID();
  let changedPeer: string | undefined;
  const historyRoot = armOptionCForecasts(f, async () => {
    expect(schemaHistoryBytes(historyRoot)).toEqual(initialHistory);
    if (schemaFreshness.injections !== 1) return;
    if (change === 'negative-peer-write') {
      const added = await f.store.createThread(
        peer.id,
        'Native commit in a negative search result'
      );
      expect(f.store.getThread(peer.id, added.id)).toEqual(added);
      changedPeer = peer.id;
    } else {
      // The real Workspace owner creates the new physical search-domain member. Its
      // absence was part of the first attempt, independent of every existing SQL token.
      const added = await f.store.createWorkspace('New physical opaque lookup domain');
      changedPeer = added.id;
      expect(f.store.getWorkspace(added.id).id).toBe(added.id);
    }
  });
  const initialHistory = schemaHistoryBytes(historyRoot);
  const result = await f.call('knowledge.schema.apply', {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  });
  expect(schemaFreshness.injectionError).toBeUndefined();
  expect(changedPeer).toBeDefined();
  // Baseline RED: one forecast succeeds with no invalidation of either negative-peer SQL
  // observations or the complete admitted physical Workspace search-domain selection.
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(schemaFreshness.forecasts).toHaveLength(2);
  expect(f.audits(requestId)).toHaveLength(1);
  expect(f.receipt(requestId)?.response).toEqual({
    kind: 'knowledge_schema_report',
    id: result.body.reportDigest,
  });
  const packet = JSON.parse(
    readFileSync(join(historyRoot, `${result.body.reportDigest.slice(7)}.json`), 'utf8')
  );
  expect(packet.reviewedReport).toEqual(reviewed);
  expect(packet.actualReport.dependencyInventory).toEqual(reviewed.dependencyInventory);
});

it('refuses newly present corrupt Context evidence before history rather than publishing its prior absence', async () => {
  const f = await nativeSchemaReviewFixture();
  const thread = await f.store.createThread(f.workspace.id, 'Context absence owner');
  const turn = await f.store.createTurn(
    f.workspace.id,
    thread.id,
    'Actual Context candidate.',
    { kind: 'user', id: f.userId },
    null,
    { status: 'pending' }
  );
  const directory = join(f.workspaceRoot, 'threads', thread.id, 'turns', turn.id);
  const contextPath = join(directory, 'context-package.json');
  expect(existsSync(contextPath)).toBe(false);
  const candidate = `${f.select().scopeSchemaText.trimEnd()}\n# Named Context absence.\n`;
  const reviewed = await f.preview(candidate);
  const before = f.select().head;
  const requestId = randomUUID();
  const historyRoot = armOptionCForecasts(f, () => {});
  const initialHistory = schemaHistoryBytes(historyRoot);
  let physicalFaults = 0;
  schemaFreshness.beforeDecision = () => {
    if (physicalFaults) return;
    // Deliberate corrupt-file injection after valid native Turn setup. This is required
    // evidence refusal, never a hand-built valid Context record or cached allow claim.
    mkdirSync(directory, { recursive: true });
    writeFileSync(contextPath, '{}');
    physicalFaults += 1;
  };
  const refused = await f.call('knowledge.schema.apply', {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  });
  expect(schemaFreshness.injectionError).toBeUndefined();
  expect(physicalFaults).toBe(1);
  // Baseline RED: final revalidation does not revisit named Context presence and returns 200.
  expect(refused.status, JSON.stringify(refused.body)).toBe(409);
  expect(
    schemaFreshness.posts.filter((row) => row.operation === 'schema-application')
  ).toHaveLength(2);
  expect(schemaFreshness.forecasts).toHaveLength(1);
  expect(schemaHistoryBytes(historyRoot)).toEqual(initialHistory);
  expect(f.select().head).toEqual(before);
  expect(f.receipt(requestId)).toBeNull();
  expect(f.audits(requestId)).toEqual([]);
});

it.each([
  'moved-base',
  'new-impact',
] as const)('does not turn the semantic %s refusal into an administrative retry', async (change) => {
  const f = await nativeSchemaReviewFixture();
  const original = f.select().scopeSchemaText;
  const candidate =
    change === 'new-impact'
      ? original.replace(/^allowed_types:.*$/m, 'allowed_types: [KnowledgePage, SourceSummary]')
      : `${original.trimEnd()}\n# Stale reviewed semantic base.\n`;
  const reviewed = await f.preview(candidate);
  if (change === 'moved-base') {
    const winningSchema = `${original.trimEnd()}\n# Independent human reviewed winner.\n`;
    const winner = await f.preview(winningSchema);
    const result = await f.call('knowledge.schema.apply', {
      requestId: randomUUID(),
      baseRevision: winner.notebookRevision,
      schemaText: winningSchema,
      reviewedReport: winner,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
  } else {
    await f.publish('new-unsafe-impact.md', 'Observation');
  }
  const before = f.select().head;
  const requestId = randomUUID();
  const historyRoot = armOptionCForecasts(f, () => {
    throw new Error('A semantic re-review refusal reached physical capacity.');
  });
  const history = schemaHistoryBytes(historyRoot);
  const refused = await f.call('knowledge.schema.apply', {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  });
  expect(refused.status, JSON.stringify(refused.body)).toBe(409);
  expect(schemaFreshness.forecasts).toEqual([]);
  // There can be an earlier Main refusal, or one original native semantic refusal.
  expect(
    schemaFreshness.posts.filter((row) => row.operation === 'schema-application').length
  ).toBeLessThanOrEqual(1);
  expect(f.select().head).toEqual(before);
  expect(schemaHistoryBytes(historyRoot)).toEqual(history);
  expect(f.receipt(requestId)).toBeNull();
  expect(f.audits(requestId)).toEqual([]);
});

/** Reuses the original target-head/closed-SQL handshake; it creates no production yield. */
function armOptionCHeadBoundary(selected: () => void) {
  const gate = new Int32Array(schemaFreshness.preparationGate);
  schemaFreshness.preparationSignals = [];
  schemaFreshness.preparationAcks = [];
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 2, 0);
  schemaFreshness.preparationReceived = selected;
  Atomics.store(gate, 0, 1);
  const release = () => {
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
  };
  const clear = () => {
    Atomics.store(gate, 0, 0);
    schemaFreshness.preparationReceived = undefined;
    release();
  };
  onTestFinished(clear);
  return { release, clear };
}

it('keeps a typed pre-promotion schema refusal local to its original request', async () => {
  const f = await nativeSchemaReviewFixture();
  const { proposal, decision } = await optionCProposal(f);
  const original = f.select().scopeSchemaText;
  const candidate = `${original.trimEnd()}\n# Reviewed before an independent schema winner.\n`;
  const reviewed = await f.preview(candidate);
  const winnerText = `${original.trimEnd()}\n# Independent current schema winner.\n`;
  const winner = await f.preview(winnerText);
  const winning = await f.call('knowledge.schema.apply', {
    requestId: randomUUID(),
    baseRevision: winner.notebookRevision,
    schemaText: winnerText,
    reviewedReport: winner,
  });
  expect(winning.status, JSON.stringify(winning.body)).toBe(200);
  const head = f.select().head;
  const requestId = randomUUID();
  let forwardReview: (() => void) | undefined;
  let reviewId: number | undefined;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let reviewSettled: Promise<unknown> | undefined;
  let boundary: ReturnType<typeof armOptionCHeadBoundary> | undefined;
  const historyRoot = armOptionCForecasts(f, () => {
    throw new Error('A known moved-base refusal requested physical schema capacity.');
  });
  const history = schemaHistoryBytes(historyRoot);
  const rearm = schemaFreshness.holdPost!;
  schemaFreshness.holdPost = (value, forward) => {
    if (
      isControlWorkerRequest(value) &&
      value.operation === 'write' &&
      value.database === schemaFreshness.database &&
      value.statements.some(
        (row) =>
          row.sql.includes('INSERT INTO idempotency_requests') &&
          row.parameters.includes(decision.requestId)
      )
    ) {
      reviewId = value.id;
      forwardReview = forward;
      reached();
      return true;
    }
    return rearm(value, forward);
  };
  // Register release/join before starting the public Review, including early setup refusal.
  onTestFinished(async () => {
    schemaFreshness.holdPost = undefined;
    boundary?.clear();
    forwardReview?.();
    forwardReview = undefined;
    await reviewSettled;
  });
  const review = f.call('knowledge.proposal.decide', decision);
  reviewSettled = review.then(
    (result) => result,
    (error: unknown) => error
  );
  const didHold = await Promise.race([held.then(() => true), reviewSettled.then(() => false)]);
  expect(didHold).toBe(true);
  boundary = armOptionCHeadBoundary(() => {
    forwardReview!();
    forwardReview = undefined;
    boundary!.release();
  });
  const refused = await f.call('knowledge.schema.apply', {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  });
  boundary.clear();
  expect(schemaFreshness.injectionError).toBeUndefined();
  expect(refused.status, JSON.stringify(refused.body)).toBe(409);
  expect(
    schemaFreshness.preparationSignals.filter((row) => row.event === 'selected-head')
  ).toHaveLength(1);
  expect(
    schemaFreshness.posts.filter((row) => row.operation === 'schema-application')
  ).toHaveLength(1);
  expect(schemaFreshness.forecasts).toEqual([]);
  const accepted = await review;
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(schemaFreshness.posts.filter((row) => row.id === reviewId)).toHaveLength(1);
  expect(f.store.listKnowledgeProposalReviewDecisions(f.workspace.id)).toEqual([
    accepted.body.review,
  ]);
  expect(accepted.body.review).toMatchObject({ proposalId: proposal.id, decision: 'deferred' });
  expect(f.select().head).toEqual(head);
  expect(schemaHistoryBytes(historyRoot)).toEqual(history);
  expect(f.receipt(requestId)).toBeNull();
  expect(f.audits(requestId)).toEqual([]);
});

it('settles two schema slots from their originally earlier prefix without a wait cycle', async () => {
  const f = await nativeSchemaReviewFixture();
  const original = f.select().scopeSchemaText;
  const firstText = `${original.trimEnd()}\n# First native schema slot.\n`;
  const secondText = `${original.trimEnd()}\n# Second native schema slot.\n`;
  const firstReport = await f.preview(firstText);
  const secondReport = await f.preview(secondText);
  const firstRequest = randomUUID();
  const secondRequest = randomUUID();
  let heldSecond: (() => void) | undefined;
  let secondId: number | undefined;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let secondSettled: Promise<unknown> | undefined;
  let boundary: ReturnType<typeof armOptionCHeadBoundary> | undefined;
  const historyRoot = armOptionCForecasts(f, () => {});
  const rearm = schemaFreshness.holdPost!;
  let captureSecond = true;
  schemaFreshness.holdPost = (value, forward) => {
    if (
      captureSecond &&
      isControlWorkerRequest(value) &&
      value.operation === 'schema-application' &&
      value.database === schemaFreshness.database
    ) {
      secondId = value.id;
      heldSecond = forward;
      reached();
      return true;
    }
    return rearm(value, forward);
  };
  onTestFinished(async () => {
    captureSecond = false;
    schemaFreshness.holdPost = undefined;
    boundary?.clear();
    heldSecond?.();
    heldSecond = undefined;
    await secondSettled;
  });
  const second = f.call('knowledge.schema.apply', {
    requestId: secondRequest,
    baseRevision: secondReport.notebookRevision,
    schemaText: secondText,
    reviewedReport: secondReport,
  });
  secondSettled = second.then(
    (result) => result,
    (error: unknown) => error
  );
  expect(await Promise.race([held.then(() => true), secondSettled.then(() => false)])).toBe(true);
  captureSecond = false;
  boundary = armOptionCHeadBoundary(() => {
    // S1 is already executing its actual target selection. S2 enters the original native
    // queue before S1 can take its next production step; neither frame is synthesized.
    heldSecond!();
    heldSecond = undefined;
    boundary!.release();
  });
  const first = await f.call('knowledge.schema.apply', {
    requestId: firstRequest,
    baseRevision: firstReport.notebookRevision,
    schemaText: firstText,
    reviewedReport: firstReport,
  });
  boundary.clear();
  const later = await second;
  expect(schemaFreshness.injectionError).toBeUndefined();
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(later.status, JSON.stringify(later.body)).toBe(409);
  expect(
    schemaFreshness.posts.filter((row) => row.operation === 'schema-application')
  ).toHaveLength(2);
  expect(schemaFreshness.posts.filter((row) => row.id === secondId)).toHaveLength(1);
  expect(schemaFreshness.forecasts).toHaveLength(1);
  expect(f.select().scopeSchemaText).toBe(firstText);
  expect(f.receipt(firstRequest)?.response).toEqual({
    kind: 'knowledge_schema_report',
    id: first.body.reportDigest,
  });
  expect(f.audits(firstRequest)).toHaveLength(1);
  expect(f.receipt(secondRequest)).toBeNull();
  expect(f.audits(secondRequest)).toEqual([]);
  const history = schemaHistoryBytes(historyRoot);
  expect(Object.keys(history)).toContain(`${firstReport.candidateSchemaDigest.slice(7)}.yaml`);
  expect(Object.keys(history)).not.toContain(`${secondReport.candidateSchemaDigest.slice(7)}.yaml`);
});

it('drains a schema accepted before close while its yielding preparation is outstanding', async () => {
  const f = await nativeSchemaReviewFixture();
  const candidate = `${f.select().scopeSchemaText.trimEnd()}\n# Close during accepted schema preparation.\n`;
  const reviewed = await f.preview(candidate);
  const requestId = randomUUID();
  const originalHead = f.select().head;
  const database = `workspace:${f.workspaceDb.sqlite.name}`;
  const databasePath = f.workspaceDb.sqlite.name;
  let closeId: number | undefined;
  let closed: Promise<void> | undefined;
  let closeSettled: Promise<unknown> | undefined;
  let boundary: ReturnType<typeof armOptionCHeadBoundary> | undefined;
  const historyRoot = armOptionCForecasts(f, () => {});
  const rearm = schemaFreshness.holdPost!;
  schemaFreshness.holdPost = (value, forward) => {
    if (
      isControlWorkerRequest(value) &&
      value.operation === 'close' &&
      value.database === database
    ) {
      closeId = value.id;
      forward();
      boundary!.release();
      return true;
    }
    return rearm(value, forward);
  };
  onTestFinished(async () => {
    schemaFreshness.holdPost = undefined;
    boundary?.clear();
    await closeSettled;
  });
  boundary = armOptionCHeadBoundary(() => {
    // This independent test reader has no further role in the accepted operation. Release
    // it before native close so it cannot itself keep SQLite sidecars alive at rest.
    f.workspaceDb.sqlite.close();
    closed = getControlStoreWorkerClient().close(database);
    closeSettled = closed.then(
      () => {
        boundary!.release();
      },
      (error: unknown) => {
        boundary!.release();
        return error;
      }
    );
  });
  const applied = await f.call('knowledge.schema.apply', {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  });
  expect(closed).toBeDefined();
  await closed!;
  boundary.clear();
  expect(schemaFreshness.injectionError).toBeUndefined();
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  expect(schemaFreshness.preparationSignals.some((row) => row.event === 'yield')).toBe(true);
  expect(schemaFreshness.preparationSignals.every((row) => !row.sqlCut)).toBe(true);
  expect(
    schemaFreshness.posts.filter((row) => row.operation === 'schema-application')
  ).toHaveLength(1);
  expect(schemaFreshness.posts.filter((row) => row.id === closeId)).toHaveLength(1);
  expect(schemaFreshness.forecasts).toHaveLength(1);
  const schemaId = schemaFreshness.forecasts[0]!.id;
  expect(schemaFreshness.preparationAcks.indexOf(schemaId)).toBeGreaterThanOrEqual(0);
  expect(schemaFreshness.preparationAcks.indexOf(closeId!)).toBeGreaterThan(
    schemaFreshness.preparationAcks.indexOf(schemaId)
  );
  // Observe at-rest cleanup before opening a new independent inspection reader.
  expect(existsSync(`${databasePath}-wal`)).toBe(false);
  expect(existsSync(`${databasePath}-shm`)).toBe(false);
  const inspection = openWorkspaceReadDb(f.dataRoot, f.workspace.id);
  try {
    const head = readControlKnowledgeHead(inspection, originalHead.knowledgeBaseId);
    expect(head?.notebookCommit).toBe(originalHead.notebookCommit);
    expect(head?.schemaContent.reference.contentDigest).toBe(reviewed.candidateSchemaDigest);
    expect(
      f.store.getCommandRequest(
        'knowledge.schema.apply',
        requestId,
        { workspaceId: f.workspace.id, actorId: f.userId },
        inspection
      )?.response
    ).toEqual({
      kind: 'knowledge_schema_report',
      id: applied.body.reportDigest,
    });
    expect(
      listSqliteAuditEvents(inspection.sqlite, f.workspace.id).filter(
        (row) => row.requestId === requestId
      )
    ).toHaveLength(1);
  } finally {
    inspection.sqlite.close();
  }
  expect(Object.keys(schemaHistoryBytes(historyRoot))).toContain(
    `${reviewed.candidateSchemaDigest.slice(7)}.yaml`
  );
});

it('includes the observation after the first full native page in schema impact', async () => {
  const f = await nativeSchemaReviewFixture();
  const thread = await f.store.createThread(f.workspace.id, 'Paged maintenance observation owner');
  const turn = await f.store.createTurn(
    f.workspace.id,
    thread.id,
    'Native maintenance metadata.',
    { kind: 'user', id: f.userId },
    null,
    {
      status: 'completed',
      agentId: 'knowledge-manager',
      triggerSource: { kind: 'system-input', summary: 'Knowledge maintenance.' },
    }
  );
  const append = (index: number) =>
    appendWorkObservation(f.workspaceDb, {
      threadId: thread.id,
      turnId: turn.id,
      bodies: [],
      observation: {
        id: `schema-maintenance-gap-${index}`,
        type: 'capture.unavailable',
        ts: turn.startedAt!,
        obs: 'nanocore',
        ret: 'turn-evidence',
        payload: { family: 'runtime-content', reason: 'unsupported' },
      },
    });
  // Native terminal creation already committed the original turn.reap observation.
  // Consume that real owner fact when filling exactly the first 128-row native page.
  const initialObservations = readWorkObservations(f.workspaceDb, {
    threadId: thread.id,
    turnId: turn.id,
  });
  expect(initialObservations).toHaveLength(1);
  expect(initialObservations[0]).toMatchObject({
    id: `turn.reap:${turn.id}`,
    type: 'turn.reap',
    turnId: turn.id,
    seq: 1,
  });
  // The existing observation owner selects 128 rows per page. This is a finite boundary
  // fixture, not a new inventory cap, retained-row builder or larger read/time allowance.
  for (let index = initialObservations.length; index < 128; index += 1)
    expect((await append(index)).disposition).toBe('committed');
  expect(
    readWorkObservations(f.workspaceDb, { threadId: thread.id, turnId: turn.id })
  ).toHaveLength(128);
  const candidate = `${f.select().scopeSchemaText.trimEnd()}\n# Complete paged maintenance contribution.\n`;
  const reviewed = await f.preview(candidate);
  const reviewedMaintenance = reviewed.dependencyInventory.find(
    (row) => row.family === 'maintenance'
  )!;
  expect(reviewedMaintenance.records).toEqual([
    expect.objectContaining({ id: turn.id, status: 'valid' }),
  ]);
  const originalTurn = f.store.getTurn(f.workspace.id, thread.id, turn.id);
  expect((await append(128)).disposition).toBe('committed');
  expect(f.store.getTurn(f.workspace.id, thread.id, turn.id)).toEqual(originalTurn);
  const observations = readWorkObservations(f.workspaceDb, {
    threadId: thread.id,
    turnId: turn.id,
  });
  expect(observations).toHaveLength(129);
  expect(observations.at(-1)).toMatchObject({ id: 'schema-maintenance-gap-128', seq: 129 });
  const current = await f.preview(candidate);
  const actualMaintenance = current.dependencyInventory.find(
    (row) => row.family === 'maintenance'
  )!;
  expect(actualMaintenance.records).toEqual(reviewedMaintenance.records);
  expect(actualMaintenance.inventoryDigest).not.toBe(reviewedMaintenance.inventoryDigest);
  const requestId = randomUUID();
  const historyRoot = armOptionCForecasts(f, () => {});
  const result = await f.call('knowledge.schema.apply', {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(schemaFreshness.injectionError).toBeUndefined();
  expect(schemaFreshness.forecasts).toHaveLength(1);
  const packet = JSON.parse(
    readFileSync(join(historyRoot, `${result.body.reportDigest.slice(7)}.json`), 'utf8')
  );
  expect(packet.reviewedReport).toEqual(reviewed);
  expect(
    packet.actualReport.dependencyInventory.find(
      (row: { family: string }) => row.family === 'maintenance'
    )
  ).toEqual(actualMaintenance);
  expect(f.receipt(requestId)?.response).toEqual({
    kind: 'knowledge_schema_report',
    id: result.body.reportDigest,
  });
  expect(f.audits(requestId)).toHaveLength(1);
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
  schemaFreshness.beforeDecision = undefined;
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
    if (fault === 'receipt-sql-failure') {
      // Install DDL before native schema input observations begin. The fault still occurs
      // only at the original receipt INSERT inside its actual native savepoint.
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

it('refuses a moved reviewed schema without retry when the winner commits after capture but before head selection', async () => {
  const f = await nativeSchemaReviewFixture();
  const initialHead = f.select().head;
  const original = f.select().scopeSchemaText;
  const winnerText = `${original.trimEnd()}\n# Winner before losing head selection.\n`;
  const loserText = `${original.trimEnd()}\n# Loser captured the earlier target tuple.\n`;
  const winnerReport = await f.preview(winnerText);
  const loserReport = await f.preview(loserText);
  const winnerRequest = randomUUID();
  const loserRequest = randomUUID();
  const winnerInput = {
    requestId: winnerRequest,
    baseRevision: winnerReport.notebookRevision,
    schemaText: winnerText,
    reviewedReport: winnerReport,
  };
  let heldLoser: (() => void) | undefined;
  let loserId: number | undefined;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let loserSettled: Promise<unknown> | undefined;
  let winnerSettled: Promise<unknown> | undefined;
  let boundary: ReturnType<typeof armOptionCHeadBoundary> | undefined;
  let captureLoser = true;
  const gate = new Int32Array(schemaFreshness.preparationGate);
  const releaseLoser = () => {
    Atomics.store(gate, 2, 1);
    Atomics.notify(gate, 2);
  };
  const historyRoot = armOptionCForecasts(f, () => {});
  const initialHistory = schemaHistoryBytes(historyRoot);
  const rearm = schemaFreshness.holdPost!;
  schemaFreshness.holdPost = (value, forward) => {
    if (
      captureLoser &&
      isControlWorkerRequest(value) &&
      value.operation === 'schema-application' &&
      value.database === schemaFreshness.database
    ) {
      loserId = value.id;
      heldLoser = forward;
      reached();
      return true;
    }
    return rearm(value, forward);
  };
  // Register release/join before either public operation. Failure cannot leave a held
  // frame, a waitAsync continuation or an accepted native request behind fixture shutdown.
  onTestFinished(async () => {
    captureLoser = false;
    schemaFreshness.holdPost = undefined;
    releaseLoser();
    boundary?.clear();
    heldLoser?.();
    heldLoser = undefined;
    await Promise.all([loserSettled, winnerSettled]);
  });
  const loser = f.call('knowledge.schema.apply', {
    requestId: loserRequest,
    baseRevision: loserReport.notebookRevision,
    schemaText: loserText,
    reviewedReport: loserReport,
  });
  loserSettled = loser.then(
    (result) => result,
    (error: unknown) => error
  );
  expect(await Promise.race([held.then(() => true), loserSettled.then(() => false)])).toBe(true);
  captureLoser = false;
  boundary = armOptionCHeadBoundary(() => {
    const observed = schemaFreshness.preparationSignals.at(-1)!;
    if (observed.event === 'selected-head') {
      heldLoser!();
      heldLoser = undefined;
    } else if (observed.event === 'yield-paused') {
      schemaFreshness.preparationReceived = undefined;
      // Actual losing capture and its held existing await precede winner promotion.
      boundary!.release();
    }
  });
  // Mode 1 retains its original behavior. Mode 2 selects two causal joins on the
  // real nextEventLoopTurn already awaited by native Schema preparation.
  Atomics.store(new Int32Array(schemaFreshness.preparationGate), 0, 2);
  Atomics.store(new Int32Array(schemaFreshness.commitGate), 0, 1);
  const winning = f.call('knowledge.schema.apply', winnerInput);
  winnerSettled = winning.then(
    (result) => result,
    (error: unknown) => error
  );
  const next = await Promise.race([
    winning.then((result) => ({ kind: 'winner' as const, result })),
    loserSettled.then(() => ({ kind: 'loser' as const })),
  ]);
  expect(next.kind).toBe('winner');
  if (next.kind !== 'winner')
    throw new Error('The losing request settled before its captured continuation was held.');
  const winner = next.result;
  expect(winner.status, JSON.stringify(winner.body)).toBe(200);
  const winnerId = schemaFreshness.forecasts[0]!.id;
  expect(schemaFreshness.preparationSignals).toEqual([
    { id: winnerId, event: 'selected-head', sqlCut: false },
    { id: loserId, event: 'revision-captured', sqlCut: false },
    { id: loserId, event: 'yield-paused', sqlCut: false },
    { id: winnerId, event: 'winner-committed', sqlCut: false },
  ]);
  expect(schemaFreshness.commits.map(({ id, phase }) => ({ id, phase }))).toEqual([
    { id: winnerId, phase: 'before' },
    { id: winnerId, phase: 'after' },
    { id: winnerId, phase: 'ack' },
  ]);
  expect(schemaFreshness.commits[0]!.synchronous).toBe(2);
  const packet = canonicalJsonText(
    writeRetainedV1({
      requiredFeatures: [],
      reviewedReport: winnerReport,
      actualReport: winnerReport,
    })
  );
  const reportDigest = `sha256:${sha256Hex(packet)}`;
  const expectedHistory = {
    ...initialHistory,
    [`${winnerReport.baseSchemaDigest.slice(7)}.yaml`]: Buffer.from(original).toString('hex'),
    [`${winnerReport.candidateSchemaDigest.slice(7)}.yaml`]:
      Buffer.from(winnerText).toString('hex'),
    [`${reportDigest.slice(7)}.json`]: Buffer.from(packet).toString('hex'),
  };
  expect(winner.body).toEqual({
    workspaceId: f.workspace.id,
    notebookRevision: initialHead.notebookCommit,
    baseSchemaDigest: winnerReport.baseSchemaDigest,
    candidateSchemaDigest: winnerReport.candidateSchemaDigest,
    reportDigest,
  });
  expect(schemaHistoryBytes(historyRoot)).toEqual(expectedHistory);
  expect(
    schemaFreshness.commits[0]!.files?.sort((left, right) => left.path.localeCompare(right.path))
  ).toEqual(
    [
      {
        path: join(historyRoot, `${winnerReport.baseSchemaDigest.slice(7)}.yaml`),
        hex: Buffer.from(original).toString('hex'),
      },
      {
        path: join(historyRoot, `${winnerReport.candidateSchemaDigest.slice(7)}.yaml`),
        hex: Buffer.from(winnerText).toString('hex'),
      },
      {
        path: join(historyRoot, `${reportDigest.slice(7)}.json`),
        hex: Buffer.from(packet).toString('hex'),
      },
    ].sort((left, right) => left.path.localeCompare(right.path))
  );
  const winnerReceipt = f.receipt(winnerRequest);
  expect(winnerReceipt !== null).toBe(true);
  if (!winnerReceipt) throw new Error('The actual winning receipt is missing.');
  expect(winnerReceipt).toEqual({
    key: commandRequestKey('knowledge.schema.apply', winnerRequest, {
      workspaceId: f.workspace.id,
      actorId: f.userId,
    }),
    command: 'knowledge.schema.apply',
    requestId: winnerRequest,
    scope: { workspaceId: f.workspace.id, actorId: f.userId },
    inputHash: commandInputHash({ workspaceId: f.workspace.id, ...winnerInput }),
    response: { kind: 'knowledge_schema_report', id: reportDigest },
    createdAt: winnerReceipt.createdAt,
    expiresAt: commandRequestExpiresAt(winnerReceipt.createdAt),
  });
  const winnerAudits = f.audits(winnerRequest);
  expect(winnerAudits).toHaveLength(1);
  expect(winnerAudits[0]).toMatchObject({
    workspaceId: f.workspace.id,
    requestId: winnerRequest,
    actor: { kind: 'user', id: f.userId },
    category: 'knowledge',
    action: 'knowledge.schema.apply',
    outcome: 'succeeded',
    resource: `knowledge-schema-report:${reportDigest}`,
  });
  const winningHead = f.select().head;
  expect(winningHead.schemaContent.reference.contentDigest).toBe(
    winnerReport.candidateSchemaDigest
  );
  expect(winningHead.notebookCommit).toBe(initialHead.notebookCommit);
  expect(f.select().scopeSchemaText).toBe(winnerText);

  // Release only after the real winner's FULL COMMIT and original ACK. This controls the
  // released await continuation; original timers, clocks, queue positions and SQL stay intact.
  releaseLoser();
  const refused = await loser;
  boundary.clear();
  expect(schemaFreshness.injectionError).toBeUndefined();
  expect(refused.status, JSON.stringify(refused.body)).toBe(409);
  expect(refused.body).toMatchObject({
    code: 'conflict',
    message: 'Schema application conflict.',
  });
  expect(refused.body.details).toEqual({
    baseSchemaDigest: loserReport.baseSchemaDigest,
    currentSchemaDigest: winnerReport.candidateSchemaDigest,
  });
  expect(schemaFreshness.preparationSignals).toEqual([
    { id: winnerId, event: 'selected-head', sqlCut: false },
    { id: loserId, event: 'revision-captured', sqlCut: false },
    { id: loserId, event: 'yield-paused', sqlCut: false },
    { id: winnerId, event: 'winner-committed', sqlCut: false },
    { id: loserId, event: 'yield-released', sqlCut: false },
    { id: loserId, event: 'selected-head', sqlCut: false, headIsWinner: true },
  ]);
  expect(f.select().head).toEqual(winningHead);
  expect(schemaHistoryBytes(historyRoot)).toEqual(expectedHistory);
  expect(f.receipt(winnerRequest)).toEqual(winnerReceipt);
  expect(f.audits(winnerRequest)).toEqual(winnerAudits);
  expect(f.receipt(loserRequest)).toBeNull();
  expect(f.audits(loserRequest)).toEqual([]);
  expect(schemaFreshness.forecasts.map(({ id }) => id)).toEqual([winnerId]);
  expect(schemaFreshness.decisions.map(({ id, decision }) => ({ id, decision }))).toEqual([
    { id: winnerId, decision: 'admitted' },
  ]);
  // Keep this deciding assertion last: the late-only correction can return the right 409
  // only after an illicit third frame, while all preceding publication oracles still run.
  expect(
    schemaFreshness.posts.filter((row) => row.operation === 'schema-application')
  ).toHaveLength(2);
  expect(schemaFreshness.posts.filter((row) => row.id === loserId)).toHaveLength(1);
});

// Current Source disclosure is Main-owned even when native preparation ends in a report refusal.
// One regression and its unchanged-effective-facts control use the same real Policy publication.
it.each([
  { name: 'suppresses new-impact metadata after effective Policy activation', activate: true },
  {
    name: 'preserves the exact new-impact delta when effective Policy stays unchanged',
    activate: false,
  },
])('$name during released native schema preparation', async ({ activate }) => {
  const f = await nativeSchemaReviewFixture();
  const candidate = f
    .select()
    .scopeSchemaText.replace(
      /^allowed_types:.*$/m,
      'allowed_types: [KnowledgePage, SourceSummary]'
    );
  const reviewed = await f.preview(candidate);
  expect(reviewed.records.every((record) => record.status === 'valid')).toBe(true);
  const path = 'late-observation.md';
  expect(reviewed.records.some((record) => record.path === path)).toBe(false);

  const sourceThread = await f.store.createThread(f.workspace.id, 'Report Source audience');
  const source = await f.call('knowledge.source.register', {
    kind: 'document',
    title: 'Report Source with real Thread lineage',
    content: 'A captured original admitted before its approved audience restriction activates.',
    originatingThreadId: sourceThread.id,
  });
  expect(source.status).toBe(200);
  const sourceId = source.body.source.id as string;
  expect(f.store.getKnowledgeSource(f.workspace.id, sourceId).originatingThreadId).toBe(
    sourceThread.id
  );
  const content = serializeKnowledgePageFixture(
    {
      title: 'Later Observation',
      content: 'An explicit human-authored Observation with current captured Source evidence.',
      sourceReferences: [`source:${sourceId}@${source.body.source.contentDigest}`],
      createdAt: '2026-11-03T00:00:00.000Z',
      updatedAt: '2026-11-03T00:00:00.000Z',
    },
    { kind: 'workspace', workspaceId: f.workspace.id }
  ).replace('type: "KnowledgePage"', 'type: "Observation"');
  const published = await f.call('knowledge.notebook.create', {
    baseRevision: f.select().head.notebookCommit,
    path,
    content,
    summary: 'Publish the later Observation through its original Notebook owner.',
  });
  expect(published.status).toBe(200);
  expect(f.select().notebook.readContent(f.select().head.notebookCommit)[path] === content).toBe(
    true
  );

  // Real human request -> actual Pending grant -> configuration publication. The one
  // owner reload is a genuine dry run, so approval SQL finishes before native capture.
  const decisionThread = await f.store.createThread(f.workspace.id, 'Report Policy decision');
  const owner = { kind: 'workspace' as const, workspaceId: f.workspace.id };
  const requested = await f.call('workspace.resource-access-request', {
    threadId: decisionThread.id,
    change: {
      resource: { family: 'thread', id: sourceThread.id },
      replacement: {
        schemaVersion: 1,
        statements: [
          {
            id: 'report-source-current-audience',
            kind: 'managed-boundary',
            author: { kind: 'human', id: f.userId },
            authority: { kind: 'human', userId: f.userId },
            authoredAt: new Date().toISOString(),
            state: 'active',
            lifetime: { anchor: { owner, kind: 'workspace', id: f.workspace.id } },
            scope: {
              subjects: [],
              actions: [],
              resources: [
                { kind: 'container', container: { owner, kind: 'thread', id: sourceThread.id } },
              ],
            },
          },
        ],
      },
    },
  });
  expect(requested.status).toBe(200);
  await f.store.applyPendingRequestCommand(f.workspace.id, {
    action: 'grant-command',
    workspaceId: f.workspace.id,
    threadId: decisionThread.id,
    requestId: requested.body.id,
    actor: { kind: 'user', id: f.userId },
    now: new Date().toISOString(),
    decisionContext: { kind: 'local', userId: f.userId },
  });
  const reload = f.runtimeConfigManager.reload.bind(f.runtimeConfigManager);
  const deferred = vi
    .spyOn(f.runtimeConfigManager, 'reload')
    .mockImplementationOnce(() => reload({ dryRun: true, mode: 'safe' }));
  try {
    const saved = await f.applyApprovedResourcePolicy({
      threadId: decisionThread.id,
      approvalRequestId: requested.body.id,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.reloadStatus).toBe('dry-run');
  } finally {
    deferred.mockRestore();
  }

  const actual = await f.preview(candidate);
  expect(actual.records.find((record) => record.path === path)).toEqual({
    path,
    status: 'needs-review',
    diagnostics: [{ code: 'scope_schema.type_not_allowed', field: 'type' }],
  });
  const selected = f.select();
  const beforeHead = selected.head;
  const beforeSchema = selected.scopeSchemaText;
  const beforePages = selected.notebook.readContent(beforeHead.notebookCommit);
  const beforeAudits = listSqliteAuditEvents(f.workspaceDb.sqlite, f.workspace.id);
  const access = {
    store: f.store,
    coreDb: f.coreDb,
    workspaceDb: f.workspaceDb,
    actor: { kind: 'user' as const, id: f.userId },
    requestActor: f.requestActor,
  };
  const target = {
    dataRoot: f.dataRoot,
    workspaceId: f.workspace.id,
    access,
    notebookRevision: beforeHead.notebookCommit,
  };
  const currentAudience = () => ({
    thread: threadReadable(target, sourceThread.id),
    source: knowledgeSourceAudienceReadable(target, sourceId),
    page: knowledgePageReadable(target, 'late-observation', content),
    write: isWorkspaceOperationAuthorized(f.coreDb, f.requestActor, f.workspace.id, {
      mutating: true,
      policyOperation: 'knowledge.write',
    }),
  });
  expect(currentAudience()).toEqual({ thread: true, source: true, page: true, write: true });
  // All values are observer results, not permission substitutes. Main's readers are
  // synchronous; the App's real reload wrapper returns a Promise while mode 1 is joined.
  const sqlRevision = () =>
    [f.coreDb.sqlite, f.workspaceDb.sqlite].map((db) => ({
      data: db.pragma('main.data_version', { simple: true }),
      schema: db.pragma('main.schema_version', { simple: true }),
      changes: db.prepare('SELECT total_changes() AS changes').get(),
    }));
  const requestId = randomUUID();
  expect(f.receipt(requestId)).toBeNull();
  const historyRoot = armOptionCForecasts(f, () => {});
  const beforeHistory = schemaHistoryBytes(historyRoot);
  schemaFreshness.disclosurePath = path;
  schemaFreshness.disclosureRefusals = [];
  const forecastPaths: string[] = [];
  const reservations: string[] = [];
  const selectedPaths = new WeakMap<FileStorageAdmission, string>();
  const forPath = FileStorageAdmission.prototype.forPath;
  const reserve = FileStorageAdmission.prototype.reserve;
  const pathObserver = vi
    .spyOn(FileStorageAdmission.prototype, 'forPath')
    .mockImplementation(function (this: FileStorageAdmission, selectedPath) {
      const actualOwner = forPath.call(this, selectedPath);
      if (selectedPath.startsWith(`${historyRoot}/`)) {
        forecastPaths.push(selectedPath);
        selectedPaths.set(actualOwner, selectedPath);
      }
      return actualOwner;
    });
  const reserveObserver = vi
    .spyOn(FileStorageAdmission.prototype, 'reserve')
    .mockImplementation(function (this: FileStorageAdmission, writes, priority) {
      const actualReservation = reserve.call(this, writes, priority);
      const selectedPath = selectedPaths.get(this);
      if (selectedPath !== undefined) reservations.push(selectedPath);
      return actualReservation;
    });
  let boundary: ReturnType<typeof armOptionCHeadBoundary> | undefined;
  let settled: Promise<unknown> | undefined;
  let crossingError: unknown;
  let crossing: Promise<void> | undefined;
  let crossed = false;
  let audienceAfter: ReturnType<typeof currentAudience> | undefined;
  let activationSqlUnchanged = false;
  let inCrossing = false;
  let workerRequestDuringCrossing = false;
  const rearm = schemaFreshness.holdPost!;
  schemaFreshness.holdPost = (value, forward) => {
    if (inCrossing && isControlWorkerRequest(value)) workerRequestDuringCrossing = true;
    return rearm(value, forward);
  };
  const version = f.runtimeConfigManager.current().version;
  // Release and join even if setup or a later assertion refuses the intended interleaving.
  onTestFinished(async () => {
    boundary?.clear();
    await crossing;
    await settled;
    schemaFreshness.disclosurePath = undefined;
    schemaFreshness.disclosureRefusals = [];
    pathObserver.mockRestore();
    reserveObserver.mockRestore();
  });
  const crossAtSelectedHead = async () => {
    inCrossing = true;
    try {
      const before = sqlRevision();
      // createApp wraps this same manager's reload in its real asynchronous owner.
      // Keep the existing join until that owner settles; no Worker request is permitted.
      const loaded = await f.runtimeConfigManager.reload({ dryRun: !activate, mode: 'safe' });
      if (loaded.status !== (activate ? 'applied' : 'dry-run'))
        throw new Error('Approved Policy reload did not reach its intended owner result.');
      if (f.runtimeConfigManager.current().version !== version + (activate ? 1 : 0))
        throw new Error('Effective Policy snapshot did not take the intended transition.');
      audienceAfter = currentAudience();
      activationSqlUnchanged = canonicalJsonText(sqlRevision()) === canonicalJsonText(before);
      crossed = true;
    } catch (error: unknown) {
      crossingError = error;
    } finally {
      inCrossing = false;
      boundary!.release();
    }
  };
  boundary = armOptionCHeadBoundary(() => {
    crossing = crossAtSelectedHead();
  });
  const applying = f.call('knowledge.schema.apply', {
    requestId,
    baseRevision: reviewed.notebookRevision,
    schemaText: candidate,
    reviewedReport: reviewed,
  });
  settled = applying.then(
    (result) => result,
    (error: unknown) => error
  );
  const result = await applying;
  boundary.clear();
  expect(crossingError === undefined, 'real Policy reload/read crossing completed').toBe(true);
  expect(crossed).toBe(true);
  expect(activationSqlUnchanged).toBe(true);
  expect(workerRequestDuringCrossing).toBe(false);
  expect(audienceAfter).toEqual({
    thread: !activate,
    source: !activate,
    page: !activate,
    write: true,
  });
  const headSignals = schemaFreshness.preparationSignals.filter(
    (signal) => signal.event === 'selected-head'
  );
  expect(headSignals).toHaveLength(1);
  expect(headSignals[0].sqlCut).toBe(false);
  const frames = schemaFreshness.posts.filter(
    (posted) => posted.operation === 'schema-application'
  );
  expect(frames).toHaveLength(1);
  expect(headSignals[0].id).toBe(frames[0].id);
  expect(schemaFreshness.disclosureRefusals).toEqual([
    {
      id: frames[0].id,
      notCommitted: true,
      fullReportConflict: true,
      protectedImpact: true,
    },
  ]);
  expect(schemaFreshness.forecasts).toEqual([]);
  expect(schemaFreshness.decisions).toEqual([]);
  expect(schemaFreshness.commits).toEqual([]);
  expect(forecastPaths).toEqual([]);
  expect(reservations).toEqual([]);
  expect(f.select().head).toEqual(beforeHead);
  expect(f.select().scopeSchemaText).toBe(beforeSchema);
  expect(f.select().notebook.readContent(beforeHead.notebookCommit)).toEqual(beforePages);
  expect(schemaHistoryBytes(historyRoot)).toEqual(beforeHistory);
  expect(f.receipt(requestId)).toBeNull();
  expect(f.audits(requestId)).toEqual([]);
  expect(listSqliteAuditEvents(f.workspaceDb.sqlite, f.workspace.id)).toEqual(beforeAudits);
  // The failure message reveals only finite observation facts. In the old client the
  // deciding RED must show 409 + protectedPath=true after the real Main denial above.
  const publicProtectedPath = Boolean(
    result.body.details?.actualReport?.records?.some(
      (record: { path?: unknown }) => record.path === path
    )
  );
  const profile = JSON.stringify({
    nativeFullReport: schemaFreshness.disclosureRefusals[0].fullReportConflict,
    currentReadDenied: audienceAfter?.page === false,
    public409: result.status === 409,
    public503: result.status === 503,
    protectedPath: publicProtectedPath,
  });
  expect(result.status, profile).toBe(activate ? 503 : 409);
  if (activate) {
    // Keep the existing known-noncommit precondition projector; no new error category.
    expect(result.body.code).toBe('recovery_required');
    expect(Object.hasOwn(result.body, 'details')).toBe(false);
    expect(publicProtectedPath).toBe(false);
    expect(JSON.stringify(result.body).includes(path)).toBe(false);
  } else {
    expect(result.body.code).toBe('conflict');
    expect(result.body.message).toBe('Schema application conflict.');
    expect(publicProtectedPath).toBe(true);
    expect(
      result.body.details !== undefined &&
        canonicalJsonText(result.body.details) ===
          canonicalJsonText({
            reviewedReport: reviewed,
            actualReport: actual,
          }),
      'unchanged effective facts retain the exact real reviewed/current delta'
    ).toBe(true);
  }
});
