import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerOptions } from 'node:worker_threads';
import {
  canonicalJsonText,
  compareCodeUnits,
  formatReferenceUri,
  writeRetainedV1,
} from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listWorkspaceAuditEvents } from './audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import * as notebookAdmission from './knowledge/notebook-workspace-admission.js';
import * as retrieval from './retrieval-knowledge-adapter.js';
import * as knowledgePreparation from './storage/control-store-knowledge.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './storage/control-store-worker-client.js';
import { createAppWithWorkspaceAuthority } from './test-support/app.js';
import { serializeKnowledgePageFixture } from './test-support/knowledge-page.js';
import { ensureLocalUser } from './test-support/local-user.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
} from './test-support/store.js';
import { readTestWorkspaceNotebookSelection } from './test-support/workspace-notebook.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Observes only genuine native frames and the actual SQLite commit; it holds no credential payload. */
const schemaBoundary = vi.hoisted(() => ({
  database: undefined as string | undefined,
  events: [] as string[],
  requests: [] as number[],
  forecasts: [] as number[],
  decisions: [] as Array<{ id: number; decision: string }>,
  bundle: undefined as
    | {
        url: string;
        sourceSha256: string;
        entryOffset: number;
        markerOffset: number;
        instrumentedSourceSha256: string;
      }
    | undefined,
  proofs: [] as Array<{ id: number; database: string; [key: string]: unknown }>,
  histories: [] as Array<{ synchronous: number; files: Array<{ path: string; hex: string }> }>,
  beforeForecast: undefined as (() => void) | undefined,
  injections: 0,
  injectionError: undefined as unknown,
}));

// Preserve the real producer, Worker, forecast/decision objects, SQL and acknowledgements.
vi.mock('node:worker_threads', async (load) => {
  const native = await load<typeof import('node:worker_threads')>();
  return {
    ...native,
    Worker: class extends native.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        const bundleUrl = options?.eval ? undefined : String(filename);
        let bundle: typeof schemaBoundary.bundle;
        // V8's generator root count includes creation and resumptions. Count the original
        // owner body once on first advancement; retain V8 coverage for exact script identity.
        const proofMarker =
          '\n  globalThis[Symbol.for("openkit.test.schema-complete-proof-entry")]();';
        if (bundleUrl) {
          const source = readFileSync(new URL(bundleUrl), 'utf8');
          const entry = 'function* readAuthorizedWorkspaceNotebookPagesSteps(';
          const entryOffset = source.indexOf(entry);
          const header =
            /^function\* readAuthorizedWorkspaceNotebookPagesSteps\([^{}\n]*\) \{/.exec(
              source.slice(entryOffset)
            );
          if (entryOffset < 0 || source.indexOf(entry, entryOffset + 1) !== -1 || !header)
            throw new Error('Ambiguous canonical native proof owner.');
          const markerOffset = entryOffset + header[0].length;
          const instrumented =
            source.slice(0, markerOffset) + proofMarker + source.slice(markerOffset);
          bundle = {
            url: bundleUrl,
            sourceSha256: createHash('sha256').update(source).digest('hex'),
            entryOffset,
            markerOffset,
            instrumentedSourceSha256: createHash('sha256').update(instrumented).digest('hex'),
          };
        }
        const prelude = `
          const {parentPort,workerData}=require('node:worker_threads');
          const Database=require(workerData.schemaRevalidationDatabaseModule);
          const readFileSync=require('node:fs').readFileSync;
          const post=parentPort.postMessage.bind(parentPort);
          const inspector=new (require('node:inspector').Session)();
          inspector.connect();
          let enabled=false;
          inspector.post('Profiler.enable',error=>{ if(error) throw error; enabled=true; });
          if(!enabled) throw new Error('Native coverage setup did not complete synchronously.');
          let activeProof;
          let loadedProof;
          Object.defineProperty(globalThis,Symbol.for('openkit.test.schema-complete-proof-entry'),{
            value() { if(activeProof) activeProof.entries+=1; },
          });
          const canonicalUrl=workerData.schemaRevalidationBundleUrl;
          const proofIdentity=workerData.schemaRevalidationProofIdentity;
          if(typeof canonicalUrl==='string' && proofIdentity) {
            const createHash=require('node:crypto').createHash;
            const hash=value=>createHash('sha256').update(value).digest('hex');
            require('node:module').registerHooks({
              load(url,context,nextLoad) {
                const loaded=nextLoad(url,context);
                if(url!==canonicalUrl) return loaded;
                const source=typeof loaded.source==='string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
                if(hash(source)!==proofIdentity.sourceSha256)
                  throw new Error('Canonical native proof source changed before load.');
                const instrumented=source.slice(0,proofIdentity.markerOffset)+
                  proofIdentity.marker+source.slice(proofIdentity.markerOffset);
                if(hash(instrumented)!==proofIdentity.instrumentedSourceSha256)
                  throw new Error('Native proof marker identity mismatch.');
                loadedProof={markerOffset:proofIdentity.markerOffset,instrumentedSourceSha256:hash(instrumented)};
                return {...loaded,source:instrumented};
              },
            });
          }
          const on=parentPort.on;
          parentPort.on=function(event,listener) {
            if(event!=='message') return on.call(this,event,listener);
            return on.call(this,event,function(value,...args) {
              if(value && value.operation==='schema-application') {
                if(activeProof) throw new Error('Overlapping native coverage requests.');
                activeProof={id:value.id,database:value.database,entries:0};
                let started=false;
                inspector.post('Profiler.startPreciseCoverage',{callCount:true,detailed:false},error=>{
                  if(error) throw error;
                  started=true;
                });
                if(!started) throw new Error('Native coverage start did not complete synchronously.');
              }
              return Reflect.apply(listener,this,[value,...args]);
            });
          };
          let forecast;
          parentPort.postMessage=function(value,...args) {
            if(activeProof && value && value.id===activeProof.id &&
                (value.status==='ok' || value.status==='error')) {
              const owned=activeProof;
              activeProof=undefined;
              let measured=false;
              inspector.post('Profiler.takePreciseCoverage',(error,result)=>{
                measured=true;
                const observation={schemaRevalidation:true,...owned,phase:'proof-count'};
                try {
                  if(error) throw error;
                  const url=workerData.schemaRevalidationBundleUrl;
                  if(typeof url!=='string') throw new Error('Missing canonical bundle.');
                  const source=readFileSync(require('node:url').fileURLToPath(url),'utf8');
                  const entry='function* readAuthorizedWorkspaceNotebookPagesSteps(';
                  const offset=source.indexOf(entry);
                  if(offset<0 || source.indexOf(entry,offset+1)!==-1)
                    throw new Error('Ambiguous native proof owner.');
                  const scripts=result.result.filter(script=>script.url===url);
                  if(scripts.length!==1) throw new Error('Canonical native script not observed.');
                  const functions=scripts[0].functions.filter(fn=>
                    fn.functionName==='readAuthorizedWorkspaceNotebookPagesSteps' &&
                    fn.ranges[0].startOffset===offset);
                  if(functions.length!==1 || functions[0].isBlockCoverage ||
                      functions[0].ranges.length!==1 || !Number.isSafeInteger(functions[0].ranges[0].count))
                    throw new Error('Native function entry not observed.');
                  if(!loadedProof || !Number.isSafeInteger(owned.entries) || owned.entries<0 ||
                      functions[0].ranges[0].count<owned.entries)
                    throw new Error('Native complete-proof body entries were not observed.');
                  Object.assign(observation,{
                    bundleUrl:url,sourceSha256:require('node:crypto').createHash('sha256').update(source).digest('hex'),
                    functionName:functions[0].functionName,isBlockCoverage:functions[0].isBlockCoverage,entryOffset:offset,
                    endOffset:functions[0].ranges[0].endOffset,count:owned.entries,
                    coverageCount:functions[0].ranges[0].count,countMode:'owner-body-entry',...loadedProof,
                  });
                } catch {
                  observation.error='Native complete-proof function entry was not measured.';
                }
                post(observation);
              });
              if(!measured) throw new Error('Native coverage read did not complete synchronously.');
              let stopped=false;
              inspector.post('Profiler.stopPreciseCoverage',error=>{
                if(error) throw error;
                stopped=true;
              });
              if(!stopped) throw new Error('Native coverage stop did not complete synchronously.');
            }
            if(value && value.status==='physical-forecast' && value.files.some(
              file=>file.path.includes('/knowledge/schema/history/'))) forecast=value;
            return post(value,...args);
          };
          const exec=Database.prototype.exec;
          Database.prototype.exec=function(sql) {
            const observed=forecast && forecast.database==='workspace:'+this.name && /^COMMIT$/i.test(sql);
            if(!observed) return exec.call(this,sql);
            const selected=forecast; forecast=undefined;
            const files=selected.files.filter(file=>file.path.includes('/knowledge/schema/history/'))
              .map(file=>({path:file.path,hex:readFileSync(file.path).toString('hex')}));
            post({schemaRevalidation:true,database:selected.database,id:selected.id,phase:'history-ready',
              synchronous:Number(this.pragma('synchronous',{simple:true})),files});
            const result=exec.call(this,sql);
            post({schemaRevalidation:true,database:selected.database,id:selected.id,phase:'committed'});
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
            schemaRevalidationDatabaseModule: createRequire(import.meta.url).resolve(
              'better-sqlite3'
            ),
            schemaRevalidationBundleUrl: bundleUrl,
            schemaRevalidationProofIdentity: bundle && { ...bundle, marker: proofMarker },
          },
        });
        const emit = this.emit.bind(this);
        this.emit = ((event: string | symbol, ...args: unknown[]) => {
          const row = args[0] as Record<string, unknown> | null;
          if (event === 'message' && row !== null && typeof row === 'object') {
            if (row.schemaRevalidation === true) {
              if (
                row.database === schemaBoundary.database &&
                schemaBoundary.requests.includes(row.id as number)
              ) {
                if (row.phase === 'proof-count') {
                  schemaBoundary.proofs.push(
                    row as { id: number; database: string; [key: string]: unknown }
                  );
                  return true;
                }
                schemaBoundary.events.push(row.phase as string);
                if (row.phase === 'history-ready')
                  schemaBoundary.histories.push({
                    synchronous: row.synchronous as number,
                    files: row.files as Array<{ path: string; hex: string }>,
                  });
              }
              // This observation is not a protocol reply and must not reach the production client.
              return true;
            }
            if (
              row.database === schemaBoundary.database &&
              schemaBoundary.requests.includes(row.id as number) &&
              row.status === 'physical-forecast'
            ) {
              schemaBoundary.forecasts.push(row.id as number);
              schemaBoundary.events.push('forecast');
              if (schemaBoundary.beforeForecast) {
                try {
                  schemaBoundary.injections += 1;
                  schemaBoundary.beforeForecast();
                } catch (error: unknown) {
                  schemaBoundary.injectionError = error;
                }
              }
            }
            if (row.status === 'ok' && schemaBoundary.requests.includes(row.id as number))
              schemaBoundary.events.push('ack');
          }
          return emit(event, ...args);
        }) as native.Worker['emit'];
        const postMessage = this.postMessage.bind(this);
        this.postMessage = ((...args: Parameters<native.Worker['postMessage']>) => {
          const row = args[0] as Record<string, unknown> | null;
          if (row !== null && typeof row === 'object' && row.database === schemaBoundary.database) {
            if (row.operation === 'schema-application') {
              schemaBoundary.bundle = bundle;
              schemaBoundary.requests.push(row.id as number);
              schemaBoundary.events.push('request');
            }
            if (
              row.operation === 'physical-forecast' &&
              schemaBoundary.requests.includes(row.id as number)
            ) {
              schemaBoundary.decisions.push({
                id: row.id as number,
                decision: row.decision as string,
              });
              schemaBoundary.events.push('decision');
            }
          }
          return postMessage(...args);
        }) as native.Worker['postMessage'];
      }
    },
  };
});

/** Builds a real Source and recursive Page closure through their public publication owners. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'schema-current-proof-'));
  const coreDb = createTestCoreDb(dataRoot);
  const userId = ensureLocalUser(coreDb);
  const store = createTestStore({ dataRoot });
  onTestFinished(async () => {
    vi.restoreAllMocks();
    schemaBoundary.database = undefined;
    schemaBoundary.beforeForecast = undefined;
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const workspace = await store.createWorkspace('Current schema proof');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const writer = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'workspace',
    workspaceIds: [workspace.id],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const app = createAppWithWorkspaceAuthority({ mode: 'server', coreDb, dataRoot, store });
  const call = async (operation: string, input: Record<string, unknown>) => {
    const requestId = typeof input.requestId === 'string' ? input.requestId : randomUUID();
    const response = await app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${writer.secret}`,
        'x-openkit-request-id': requestId,
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        ...input,
        ...(operation === 'knowledge.schema.preview' ? { requestId } : {}),
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  const source = await call('knowledge.source.register', {
    kind: 'document',
    title: 'Schema proof evidence',
    content: 'Actual immutable evidence for the recursive Page closure.',
  });
  expect(source.status, JSON.stringify(source.body)).toBe(200);
  const sourcePin = `source:${source.body.source.id}@${source.body.source.contentDigest}`;
  const selection = () => readTestWorkspaceNotebookSelection(dataRoot, workspace.id);
  const publish = async (path: string, sourceReferences: string[]) => {
    const result = await call('knowledge.notebook.create', {
      baseRevision: selection().head.notebookCommit,
      path,
      content: serializeKnowledgePageFixture(
        {
          title: path,
          content: `Exact authored content for ${path}.`,
          sourceReferences,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
        { kind: 'workspace', workspaceId: workspace.id }
      ),
      summary: 'Publish schema proof fixture.',
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
  };
  await publish('companion.md', [sourcePin]);
  const companion = selection();
  const companionBytes = companion.notebook.readRevision(companion.head.notebookCommit).files[
    'companion.md'
  ]!;
  const pagePin = formatReferenceUri(
    {
      scopeId: `page/workspace/${workspace.id}/${companion.head.knowledgeBaseId}`,
      objectId: 'companion',
    },
    `sha256:${createHash('sha256').update(companionBytes).digest('hex')}`
  );
  await publish('guide.md', [sourcePin, pagePin]);
  const initial = selection();
  const input = {
    baseRevision: initial.head.notebookCommit,
    schemaText: `${initial.scopeSchemaText}\n# Explicit reviewed schema change for QA039.\n`,
  };
  return { coreDb, userId, store, workspace, writer, call, selection, initial, input };
}

it('checks the complete schema closure once per synchronous preview and apply inspection', async () => {
  const f = await fixture();
  // QA039 explicitly requires removal of repeated complete proofs within one synchronous stretch.
  // Observe the actual Page/reference owner; its real authority and Git work still run.
  const completeProof = vi.spyOn(retrieval, 'readAuthorizedWorkspaceNotebookPages');
  const preview = await f.call('knowledge.schema.preview', f.input);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body).toMatchObject({
    workspaceId: f.workspace.id,
    notebookRevision: f.input.baseRevision,
    inventoryComplete: true,
    coverage: 'workspace',
  });
  expect(preview.body.records.map((row: { path: string }) => row.path)).toEqual(
    expect.arrayContaining(['companion.md', 'guide.md'])
  );
  expect(completeProof.mock.calls.length).toBeGreaterThan(0);
  expect
    .soft(completeProof.mock.calls.length, 'public preview complete proofs')
    .toBeLessThanOrEqual(1);
  completeProof.mockClear();

  const events: string[] = [];
  const originalAdmission = notebookAdmission.readWorkspaceNotebookAdmission;
  vi.spyOn(notebookAdmission, 'readWorkspaceNotebookAdmission').mockImplementation((...args) => {
    const result = originalAdmission(...args);
    events.push('admission');
    return result;
  });
  const originalSelection = knowledgePreparation.prepareWorkspaceKnowledgeSelection;
  vi.spyOn(knowledgePreparation, 'prepareWorkspaceKnowledgeSelection').mockImplementation(
    async (...args) => {
      const result = await originalSelection(...args);
      events.push('selection');
      return result;
    }
  );
  const client = getControlStoreWorkerClient();
  const pause = vi.spyOn(client, 'tryPauseForWorkspaceCapture');
  Object.assign(schemaBoundary, {
    database: `workspace:${join(f.coreDb.dataRoot, 'workspaces', f.workspace.id, 'db', 'workspace.sqlite')}`,
    events,
    requests: [],
    forecasts: [],
    decisions: [],
    histories: [],
    proofs: [],
    beforeForecast: undefined,
    injections: 0,
    injectionError: undefined,
  });
  const requestId = randomUUID();
  const applied = await f.call('knowledge.schema.apply', {
    ...f.input,
    requestId,
    reviewedReport: preview.body,
  });
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  expect(schemaBoundary.proofs).toHaveLength(1);
  const nativeProof = schemaBoundary.proofs[0]!;
  expect(schemaBoundary.bundle).toBeDefined();
  expect(schemaBoundary.bundle!.entryOffset).toBeGreaterThanOrEqual(0);
  expect(nativeProof.error).toBeUndefined();
  expect(nativeProof).toMatchObject({
    id: schemaBoundary.requests[0],
    database: schemaBoundary.database,
    bundleUrl: schemaBoundary.bundle!.url,
    sourceSha256: schemaBoundary.bundle!.sourceSha256,
    functionName: 'readAuthorizedWorkspaceNotebookPagesSteps',
    countMode: 'owner-body-entry',
    markerOffset: schemaBoundary.bundle!.markerOffset,
    instrumentedSourceSha256: schemaBoundary.bundle!.instrumentedSourceSha256,
    isBlockCoverage: false,
    entryOffset: schemaBoundary.bundle!.entryOffset,
  });
  expect(nativeProof.endOffset).toBeGreaterThan(nativeProof.entryOffset as number);
  // Count original owner-body invocations, not generator creation or resumptions, plus
  // any remaining Main proof for this original request. V8 still identifies the real owner.
  expect(nativeProof.count).toBeGreaterThan(0);
  const applyCompleteProofs = completeProof.mock.calls.length + (nativeProof.count as number);
  expect(applyCompleteProofs).toBeGreaterThan(0);
  expect.soft(applyCompleteProofs, 'public apply complete proofs').toBeLessThanOrEqual(2);
  expect(pause).not.toHaveBeenCalled();
  expect(schemaBoundary.requests).toHaveLength(1);
  expect(schemaBoundary.forecasts).toEqual(schemaBoundary.requests);
  expect(schemaBoundary.decisions).toEqual([
    { id: schemaBoundary.requests[0], decision: 'admitted' },
  ]);
  expect(events.filter((event) => event !== 'admission')).toEqual([
    'selection',
    'request',
    'forecast',
    'decision',
    'history-ready',
    'committed',
    'ack',
  ]);
  // Main rechecks its current owner after candidate-byte preparation; native rechecks after
  // the forecast exchange are decided by the real late-credential refusal below.
  expect(events.slice(events.indexOf('selection') + 1, events.indexOf('request'))).toContain(
    'admission'
  );
  const historyRoot = join(
    f.coreDb.dataRoot,
    'workspaces',
    f.workspace.id,
    'knowledge',
    'schema',
    'history'
  );
  expect(schemaBoundary.histories).toHaveLength(1);
  expect(schemaBoundary.histories[0]!.synchronous).toBe(2);
  expect(
    schemaBoundary.histories[0]!.files.sort((left, right) =>
      compareCodeUnits(left.path, right.path)
    )
  ).toEqual(
    [
      {
        path: join(historyRoot, `${applied.body.baseSchemaDigest.slice(7)}.yaml`),
        hex: Buffer.from(f.initial.scopeSchemaText).toString('hex'),
      },
      {
        path: join(historyRoot, `${applied.body.candidateSchemaDigest.slice(7)}.yaml`),
        hex: Buffer.from(f.input.schemaText).toString('hex'),
      },
      {
        path: join(historyRoot, `${applied.body.reportDigest.slice(7)}.json`),
        hex: Buffer.from(
          canonicalJsonText(
            writeRetainedV1({
              requiredFeatures: [],
              reviewedReport: preview.body,
              actualReport: preview.body,
            })
          )
        ).toString('hex'),
      },
    ].sort((left, right) => compareCodeUnits(left.path, right.path))
  );
  expect(f.selection().scopeSchemaText).toBe(f.input.schemaText);
  expect(f.selection().head.notebookCommit).toBe(f.input.baseRevision);
  const db = createTestWorkspaceDb(f.coreDb.dataRoot, f.workspace.id);
  try {
    expect(
      f.store.getCommandRequest(
        'knowledge.schema.apply',
        requestId,
        {
          workspaceId: f.workspace.id,
          actorId: f.userId,
        },
        db
      )?.response
    ).toEqual({ kind: 'knowledge_schema_report', id: applied.body.reportDigest });
    expect(
      listWorkspaceAuditEvents(db, f.workspace.id).filter(
        (event) => event.action === 'knowledge.schema.apply' && event.requestId === requestId
      )
    ).toHaveLength(1);
  } finally {
    closeTestCoreDb(db);
  }
});

it('refuses schema publication when the actual writer token is revoked before the native forecast decision', async () => {
  const f = await fixture();
  const preview = await f.call('knowledge.schema.preview', f.input);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const historyRoot = join(
    f.coreDb.dataRoot,
    'workspaces',
    f.workspace.id,
    'knowledge',
    'schema',
    'history'
  );
  const historyBefore = existsSync(historyRoot)
    ? readdirSync(historyRoot)
        .sort()
        .map((path) => ({
          path,
          hex: readFileSync(join(historyRoot, path)).toString('hex'),
        }))
    : [];
  Object.assign(schemaBoundary, {
    database: `workspace:${join(f.coreDb.dataRoot, 'workspaces', f.workspace.id, 'db', 'workspace.sqlite')}`,
    events: [],
    requests: [],
    forecasts: [],
    decisions: [],
    histories: [],
    proofs: [],
    beforeForecast: () => revokeOpenKitAccessTokenRecord(f.coreDb, f.writer.tokenId),
    injections: 0,
    injectionError: undefined,
  });
  const requestId = randomUUID();
  const applied = await f.call('knowledge.schema.apply', {
    ...f.input,
    requestId,
    reviewedReport: preview.body,
  });
  expect(schemaBoundary.injectionError).toBeUndefined();
  expect(schemaBoundary.requests).toHaveLength(1);
  expect(schemaBoundary.forecasts).toEqual(schemaBoundary.requests);
  expect(schemaBoundary.injections).toBe(1);
  expect(schemaBoundary.decisions).toHaveLength(1);
  expect(schemaBoundary.histories).toEqual([]);
  expect(
    existsSync(historyRoot)
      ? readdirSync(historyRoot)
          .sort()
          .map((path) => ({
            path,
            hex: readFileSync(join(historyRoot, path)).toString('hex'),
          }))
      : []
  ).toEqual(historyBefore);
  expect(applied.status, JSON.stringify(applied.body)).toBe(403);
  expect(f.selection().head).toEqual(f.initial.head);
  expect(f.selection().scopeSchemaText).toBe(f.initial.scopeSchemaText);
  const db = createTestWorkspaceDb(f.coreDb.dataRoot, f.workspace.id);
  try {
    expect(
      f.store.getCommandRequest(
        'knowledge.schema.apply',
        requestId,
        {
          workspaceId: f.workspace.id,
          actorId: f.userId,
        },
        db
      )
    ).toBeNull();
    expect(
      listWorkspaceAuditEvents(db, f.workspace.id).filter(
        (event) => event.action === 'knowledge.schema.apply' && event.requestId === requestId
      )
    ).toHaveLength(0);
  } finally {
    closeTestCoreDb(db);
  }
});
