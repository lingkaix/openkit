import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  type ApplyKnowledgeSchemaResponse,
  type PreviewKnowledgeSchemaResponse,
  PreviewKnowledgeSchemaResponseSchema,
} from '@openkit/app-api-schemas';
import { canonicalJsonText, readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import {
  ensureCanonicalDirectory,
  listCanonicalDirectoryNames,
  measureCanonicalFile,
  syncCanonicalDirectory,
  syncCanonicalTree,
} from '@openkit/storage';
import { prepareAuditEvent, prepareAuditEventStatement } from '../audit-events.js';
import { readCurrentWorkspacePolicy } from '../auth/operation-authorizer.js';
import { isScopeAdmitted } from '../bootstrap/readiness.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { workerContextPackageTraceIdentity } from '../context/worker-context-package.js';
import { FsStore } from '../lib/store.js';
import { OperationError, WORKSPACE_ACCESS_DENIED } from '../operation-error.js';
import {
  admitKnowledgeRetrieval,
  knowledgeSourceAudienceReadableSteps,
  readAuthorizedWorkspaceNotebookPagesSteps,
} from '../retrieval-knowledge-adapter.js';
import { readAgentEnvironmentPackageSnapshotInventory } from '../runtime/aep-snapshot-ledger.js';
import { writeFileAtomic } from '../storage/canonical-write-capacity.js';
import {
  getCommandRequestRecordFromDb,
  prepareControlCommandRequestStatement,
} from '../storage/command-request-records.js';
import { CONTROL_STORE_BUDGET } from '../storage/control-store.js';
import {
  controlKnowledgeHeadStatements,
  readControlKnowledgeHead,
} from '../storage/control-store-knowledge-heads.js';
import { openControlStoreProductReadHandle } from '../storage/control-store-product-records.js';
import type {
  ControlPhysicalForecastFiles,
  ControlSchemaApplicationInput,
  ControlSqlStatement,
} from '../storage/control-store-worker-protocol.js';
import { bindCoreSqlite, type WorkspaceDb } from '../storage/db.js';
import { coreDbPath, workspaceDbPath } from '../storage/fs-layout.js';
import { readImmutableContentBytes } from '../storage/immutable-content-read.js';
import { readRetrievalTraceInventory } from '../storage/retrieval-traces.js';
import { nativeProductScope, readNativeProductPages } from '../storage/workspace-file-records.js';
import { NotebookError } from './notebook-error.js';
import {
  assertWorkspaceNotebookWrite,
  readWorkspaceNotebookAdmissionSteps,
} from './notebook-workspace-admission.js';
import { readWorkspaceNotebookSelection } from './notebook-workspace-selection.js';
import { previewWorkspaceSchemaSteps } from './schema-dependency-preview.js';

/** Retains exact reviewed and applied snapshots independently of the original receipt's expiry. */
export function schemaReportBytes(
  reviewedReport: PreviewKnowledgeSchemaResponse,
  actualReport: PreviewKnowledgeSchemaResponse
): string {
  if (
    reviewedReport.workspaceId !== actualReport.workspaceId ||
    reviewedReport.baseSchemaDigest !== actualReport.baseSchemaDigest ||
    reviewedReport.candidateSchemaDigest !== actualReport.candidateSchemaDigest
  )
    throw new NotebookError('conflict');
  return canonicalJsonText(writeRetainedV1({ requiredFeatures: [], reviewedReport, actualReport }));
}

/** Reconstructs the original applied result from its exact report pair, never current projections. */
export function schemaApplicationResult(
  reviewedReport: PreviewKnowledgeSchemaResponse,
  actualReport: PreviewKnowledgeSchemaResponse
): ApplyKnowledgeSchemaResponse {
  const reportDigest = `sha256:${sha256Hex(schemaReportBytes(reviewedReport, actualReport))}`;
  return {
    workspaceId: actualReport.workspaceId,
    notebookRevision: actualReport.notebookRevision,
    baseSchemaDigest: actualReport.baseSchemaDigest,
    candidateSchemaDigest: actualReport.candidateSchemaDigest,
    reportDigest,
  };
}

/** Publishes both schema versions and exact report snapshots synchronously before their native SQL reference. */
export function prepareSchemaApplicationHistory(input: {
  readonly workspaceRoot: string;
  readonly previousSchemaText: string;
  readonly candidateSchemaText: string;
  readonly report: PreviewKnowledgeSchemaResponse;
  readonly actualReport: PreviewKnowledgeSchemaResponse;
}): ApplyKnowledgeSchemaResponse {
  const result = schemaApplicationResult(input.report, input.actualReport);
  if (
    `sha256:${sha256Hex(input.previousSchemaText)}` !== result.baseSchemaDigest ||
    `sha256:${sha256Hex(input.candidateSchemaText)}` !== result.candidateSchemaDigest
  )
    throw new NotebookError('conflict');
  const directory = join(input.workspaceRoot, 'knowledge', 'schema', 'history');
  ensureCanonicalDirectory(directory);
  for (const [digest, extension, text] of [
    [result.baseSchemaDigest, 'yaml', input.previousSchemaText],
    [result.candidateSchemaDigest, 'yaml', input.candidateSchemaText],
    [result.reportDigest, 'json', schemaReportBytes(input.report, input.actualReport)],
  ]) {
    const bytes = Buffer.from(text!, 'utf8');
    if (bytes.toString('utf8') !== text) throw new NotebookError('invalid_request');
    const destinationPath = join(directory, `${digest!.slice(7)}.${extension}`);
    try {
      writeFileAtomic(destinationPath, bytes, 0o444, 'create');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      const winner = measureCanonicalFile(destinationPath);
      if (winner.byteLength !== bytes.length || winner.contentDigest !== digest)
        throw new Error('Immutable content winner does not match its exact bytes.');
      syncCanonicalTree(destinationPath);
      syncCanonicalDirectory(directory);
    }
  }
  return result;
}

/** Replays only the receipt's exact retained report; missing or unsupported required evidence fails closed. */
export function readSchemaApplicationHistory(
  workspaceRoot: string,
  reportDigest: string
): ApplyKnowledgeSchemaResponse {
  try {
    if (!/^sha256:[a-f0-9]{64}$/.test(reportDigest)) throw new Error('Invalid report identity.');
    const bytes = readFileSync(
      join(workspaceRoot, 'knowledge', 'schema', 'history', `${reportDigest.slice(7)}.json`)
    );
    if (`sha256:${sha256Hex(bytes)}` !== reportDigest)
      throw new Error('Report bytes do not match.');
    const report = readRetainedV1(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      (record) => {
        if (
          !record ||
          typeof record !== 'object' ||
          !('requiredFeatures' in record) ||
          !Array.isArray(record.requiredFeatures) ||
          record.requiredFeatures.length ||
          !('reviewedReport' in record) ||
          !('actualReport' in record)
        )
          throw new Error('Unsupported required schema report semantics.');
        return {
          reviewedReport: PreviewKnowledgeSchemaResponseSchema.parse(record.reviewedReport),
          actualReport: PreviewKnowledgeSchemaResponseSchema.parse(record.actualReport),
        };
      }
    );
    return {
      ...schemaApplicationResult(report.reviewedReport, report.actualReport),
      reportDigest,
    };
  } catch {
    throw new NotebookError('recovery_required');
  }
}

/** One admitted native request's disposable current computation; it owns no retained state or connection. */
export interface PreparedNativeSchemaApplication {
  readonly result: ApplyKnowledgeSchemaResponse;
  readonly files: ControlPhysicalForecastFiles;
  readonly statements: readonly ControlSqlStatement[];
  /** Runs only at the leading FIFO barrier, synchronously before the SQL tuple. */
  readonly publishHistory: () => void;
  readonly revalidate: () => void;
  /** Compares current SQL and physical selections outside the final write transaction. */
  readonly validateInputs: () => void;
  /** Closes only this request's owned Core reader, never the borrowed Workspace writer. */
  readonly close: () => void;
}

/** A proved stale administrative attempt, never a semantic refusal or an uncertain commit. */
export class NativeSchemaReadsetConflict extends Error {
  readonly code = 'schema_readset_changed';

  constructor() {
    super('Schema application input revisions changed.');
  }
}

/** Current attempt observations own only their opened query-only connections. */
interface SchemaApplicationObservations {
  readonly revalidateSql: () => void;
  readonly revalidate: () => void;
  readonly close: () => void;
}

/**
 * Observes the original opaque-search domain without keeping a read transaction or copying rows.
 *
 * A data_version value is meaningful only on its original still-open connection. Separate
 * query-only observers cover other scopes. The admitted target writer also observes its own
 * total changes and schema version, so its maintenance checkpoint does not look like a commit.
 * Unchanged revisions cover inserted/deleted and negative selections too. Physical membership
 * remains with the original trace and snapshot owners and is compared separately.
 */
function* observeSchemaApplicationInputs(
  workspaceDb: WorkspaceDb,
  coreReader: ReturnType<typeof openControlStoreProductReadHandle>,
  scopeRefusals: ControlSchemaApplicationInput['facts']['scopeRefusals']
): Generator<void, SchemaApplicationObservations, void> {
  const { dataRoot, workspaceId } = workspaceDb;
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  const workspaceNames = () =>
    listCanonicalDirectoryNames(join(dataRoot, 'workspaces')).filter(
      (id) => id !== '.staging' && isScopeAdmitted(dataRoot, 'workspace', id, scopeRefusals)
    );
  const names = workspaceNames();
  const observers: Array<{
    readonly path: string;
    readonly identity: string;
    readonly version: readonly number[];
    readonly sqlite: WorkspaceDb['sqlite'];
  }> = [];
  const owned: Array<ReturnType<typeof openControlStoreProductReadHandle>> = [];
  let transferred = false;
  const identity = (path: string): string => {
    const entry = lstatSync(path, { bigint: true });
    if (!entry.isFile() || realpathSync(path) !== path) throw new NativeSchemaReadsetConflict();
    return `${entry.dev}:${entry.ino}`;
  };
  const version = (sqlite: WorkspaceDb['sqlite']): readonly number[] => {
    const target = sqlite === workspaceDb.sqlite;
    if (!sqlite.open || (!target && sqlite.inTransaction)) throw new NativeSchemaReadsetConflict();
    const values = [sqlite.pragma('main.data_version', { simple: true })];
    if (target) {
      values.push(sqlite.prepare('SELECT total_changes()').pluck().get());
      values.push(sqlite.pragma('main.schema_version', { simple: true }));
    }
    if (!values.every(Number.isSafeInteger)) throw new NativeSchemaReadsetConflict();
    return values as number[];
  };
  const assertBudget = (started: number) => {
    if (performance.now() - started > CONTROL_STORE_BUDGET.maxReadMs)
      throw new OperationError(
        'operation_storage_unavailable',
        'Schema application input validation exceeded its read budget.',
        503
      );
  };
  const close = () => {
    for (const reader of owned) if (reader.sqlite.open) reader.close();
  };
  try {
    const corePath = coreDbPath(dataRoot);
    observers.push({
      path: corePath,
      identity: identity(corePath),
      version: version(coreReader.sqlite),
      sqlite: coreReader.sqlite,
    });
    for (const id of names) {
      const path = workspaceDbPath(dataRoot, id);
      const before = identity(path);
      let sqlite = workspaceDb.sqlite;
      if (id !== workspaceId) {
        const reader = openControlStoreProductReadHandle(path, {
          kind: 'workspace',
          workspaceId: id,
        });
        owned.push(reader);
        sqlite = reader.sqlite;
      }
      if (identity(path) !== before) throw new NativeSchemaReadsetConflict();
      observers.push({ path, identity: before, version: version(sqlite), sqlite });
      yield;
    }
    if (!names.includes(workspaceId)) throw new NativeSchemaReadsetConflict();
    const scope = {
      ...nativeProductScope(dataRoot, { kind: 'workspace', workspaceId }),
      sqlite: workspaceDb.sqlite,
    };
    // Select only validated metadata pages. No history is hydrated to discover a named path.
    const threads: string[] = [];
    for (const page of readNativeProductPages(scope, 'thread')) {
      threads.push(...page.map((row) => row.record.id as string));
      yield;
    }
    const turns: Array<{ id: string; threadId: string }> = [];
    for (const page of readNativeProductPages(scope, 'turn')) {
      turns.push(
        ...page.map((row) => ({
          id: row.record.id as string,
          threadId: row.record.threadId as string,
        }))
      );
      yield;
    }
    const sessions: string[] = [];
    for (const page of readNativeProductPages(scope, 'agent-session')) {
      sessions.push(...page.map((row) => row.record.id as string));
      yield;
    }
    function* physicalSteps() {
      const workspaces = workspaceNames();
      yield;
      const knowledgeBaseId = readDefaultKnowledgeBaseId({
        dataRoot,
        scope: { kind: 'workspace', workspaceId },
      });
      yield;
      const retrieval: Array<ReturnType<typeof readRetrievalTraceInventory>> = [];
      for (const threadId of threads) {
        retrieval.push(
          readRetrievalTraceInventory(
            workspaceRoot,
            `retrieval-trace/thread/${workspaceId}/${threadId}`
          )
        );
        yield;
      }
      for (const turn of turns) {
        retrieval.push(
          readRetrievalTraceInventory(
            workspaceRoot,
            `retrieval-trace/turn/${workspaceId}/${turn.threadId}/${turn.id}`
          )
        );
        yield;
      }
      const context: Array<ReturnType<typeof workerContextPackageTraceIdentity>> = [];
      for (const turn of turns) {
        context.push(workerContextPackageTraceIdentity(workspaceRoot, turn.threadId, turn.id));
        yield;
      }
      const environments: Array<ReturnType<typeof readAgentEnvironmentPackageSnapshotInventory>> =
        [];
      for (const id of sessions) {
        environments.push(readAgentEnvironmentPackageSnapshotInventory(workspaceDb, id));
        yield;
      }
      return { workspaces, knowledgeBaseId, retrieval, context, environments };
    }
    const selectedPhysical = yield* physicalSteps();
    const physical = (started: number) => {
      for (const steps = physicalSteps(); ; ) {
        const step = steps.next();
        assertBudget(started);
        if (step.done) return step.value;
      }
    };
    const revalidateSql = () => {
      const started = performance.now();
      for (const observation of observers) {
        if (!isDeepStrictEqual(version(observation.sqlite), observation.version))
          throw new NativeSchemaReadsetConflict();
        assertBudget(started);
      }
    };
    const revalidate = () => {
      const started = performance.now();
      for (const observation of observers) {
        if (
          identity(observation.path) !== observation.identity ||
          !isDeepStrictEqual(version(observation.sqlite), observation.version)
        )
          throw new NativeSchemaReadsetConflict();
        assertBudget(started);
      }
      if (!isDeepStrictEqual(physical(started), selectedPhysical))
        throw new NativeSchemaReadsetConflict();
      assertBudget(started);
    };
    transferred = true;
    return { revalidateSql, revalidate, close };
  } finally {
    if (!transferred) close();
  }
}

/** Decides the complete current Schema impact on the admitted Workspace connection, before the one capacity exchange. */
export async function prepareNativeSchemaApplication(
  workspaceDb: WorkspaceDb,
  input: ControlSchemaApplicationInput
): Promise<PreparedNativeSchemaApplication> {
  const steps = nativeSchemaApplicationSteps(workspaceDb, input);
  try {
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
      if (workspaceDb.sqlite.inTransaction) throw new NotebookError('recovery_required');
      await nextEventLoopTurn();
    }
  } finally {
    steps.return(undefined as never);
  }
}

/** Captures and computes through the existing owners, retaining values rather than a SQL cut. */
function* nativeSchemaApplicationSteps(
  workspaceDb: WorkspaceDb,
  input: ControlSchemaApplicationInput
): Generator<void, PreparedNativeSchemaApplication, void> {
  const { request, requestActor, producer, receipt, candidateHead, facts } = input;
  const workspaceId = workspaceDb.workspaceId;
  const dataRoot = workspaceDb.dataRoot;
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  if (
    workspaceId !== request.workspaceId ||
    candidateHead.workspaceId !== workspaceId ||
    !isDeepStrictEqual(requestActor, facts.presentedActor) ||
    producer.id !== requestActor.userId ||
    receipt.command !== 'knowledge.schema.apply' ||
    receipt.requestId !== request.requestId ||
    receipt.scope.workspaceId !== workspaceId ||
    receipt.scope.actorId !== producer.id ||
    receipt.responseKind !== 'knowledge_schema_report'
  )
    throw new NotebookError('recovery_required');
  const coreReader = openControlStoreProductReadHandle(coreDbPath(dataRoot), { kind: 'server' });
  let observations: SchemaApplicationObservations | undefined;
  let transferred = false;
  const close = () => {
    observations?.close();
    coreReader.close();
  };
  try {
    const coreDb = bindCoreSqlite(coreReader.sqlite, dataRoot);
    // Replay inspects the original receipt before any impact or opaque peer census.
    const retainedReceipt = getCommandRequestRecordFromDb(
      workspaceDb,
      receipt.key,
      receipt.createdAt
    );
    if (!retainedReceipt)
      observations = yield* observeSchemaApplicationInputs(
        workspaceDb,
        coreReader,
        facts.scopeRefusals
      );
    yield;
    const store = new FsStore({
      dataRoot,
      nativeProductScope: {
        ...nativeProductScope(dataRoot, { kind: 'workspace', workspaceId }),
        sqlite: workspaceDb.sqlite,
      },
      scopeRefusals: facts.scopeRefusals,
    });
    store.setWorkspaceResourcePolicyProjection((id) => {
      if (id !== workspaceId) throw new NotebookError('recovery_required');
      return readCurrentWorkspacePolicy({ coreDb, workspaceId, policy: facts.effectivePolicy });
    });
    const knowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot,
      scope: { kind: 'workspace', workspaceId },
    });
    const selected = readWorkspaceNotebookSelection({
      workspaceDb,
      workspaceRoot,
      knowledgeBaseId,
    });
    const access = { store, coreDb, workspaceDb, actor: producer, requestActor };
    yield;
    const ownerAdmission = (
      baseRevision: string,
      changes: readonly { path: string; content: string | null }[] = [],
      sourceRequestId = request.requestId
    ) =>
      readWorkspaceNotebookAdmissionSteps({
        store,
        coreDb,
        workspaceDb,
        notebook: selected.notebook,
        scopeSchemaText: selected.scopeSchemaText,
        requestActor,
        actor: producer,
        reviewRequiredPageIds: facts.reviewRequiredPageIds,
        request: {
          workspaceId,
          requestId: sourceRequestId,
          baseRevision,
          summary: 'Inspect the current reviewed Scope Schema',
          changes: [...changes],
        },
      });
    const reviewed = request.reviewedReport;
    const assertCurrentAuthority = () => {
      assertWorkspaceNotebookWrite({ coreDb, requestActor, actor: producer, request });
      // Empty-change admission need not dereference a Thread's lazy Policy projection.
      // The active human author remains a fresh Core predicate after physical admission.
      try {
        readCurrentWorkspacePolicy({ coreDb, workspaceId, policy: facts.effectivePolicy });
      } catch {
        throw new NotebookError('recovery_required');
      }
      admitKnowledgeRetrieval({ workspaceId, access });
    };
    const assertReviewedSchemaDigest = (currentDigest: string) => {
      if (currentDigest !== reviewed.baseSchemaDigest)
        throw new OperationError('conflict', 'The reviewed Schema head changed.', 409, {
          details: {
            baseSchemaDigest: reviewed.baseSchemaDigest,
            currentSchemaDigest: currentDigest,
          },
        });
    };
    const validateObservedInputs = () => {
      const current = readControlKnowledgeHead(workspaceDb, knowledgeBaseId);
      if (!current) throw new NotebookError('conflict');
      assertReviewedSchemaDigest(current.schemaContent.reference.contentDigest);
      if (!isDeepStrictEqual(current, selected.head)) throw new NativeSchemaReadsetConflict();
      observations!.revalidateSql();
    };
    const revalidate = () => {
      assertCurrentAuthority();
      if (!retainedReceipt) validateObservedInputs();
    };
    assertCurrentAuthority();
    if (retainedReceipt) {
      if (
        retainedReceipt.inputHash !== receipt.inputHash ||
        retainedReceipt.command !== receipt.command ||
        !isDeepStrictEqual(retainedReceipt.scope, receipt.scope)
      )
        throw new OperationError(
          'idempotency_key_conflict',
          'The request identity is already used.',
          409
        );
      if (retainedReceipt.response.kind !== 'knowledge_schema_report')
        throw new NotebookError('recovery_required');
      const result = readSchemaApplicationHistory(workspaceRoot, retainedReceipt.response.id);
      transferred = true;
      return {
        result,
        files: [],
        statements: [],
        publishHistory() {},
        revalidate,
        validateInputs: revalidate,
        close,
      };
    }
    const fullyValid = (report: PreviewKnowledgeSchemaResponse) =>
      report.inventoryComplete &&
      !report.schemaDiagnostics.length &&
      report.records.every((row) => row.status === 'valid' && !row.diagnostics.length) &&
      report.dependencyInventory.every(
        (row) =>
          row.complete &&
          !!row.inventoryDigest &&
          !row.diagnostics.length &&
          row.records.every((record) => record.status === 'valid' && !record.diagnostics.length)
      );
    if (!fullyValid(reviewed)) throw new NotebookError('invalid_request');
    if (
      reviewed.workspaceId !== workspaceId ||
      reviewed.notebookRevision !== request.baseRevision ||
      reviewed.candidateSchemaDigest !== `sha256:${sha256Hex(request.schemaText)}`
    )
      throw new NotebookError('conflict');
    assertReviewedSchemaDigest(`sha256:${sha256Hex(selected.scopeSchemaText)}`);
    validateObservedInputs();
    if (candidateHead.knowledgeBaseId !== knowledgeBaseId)
      throw new NotebookError('recovery_required');
    const candidateBytes = readImmutableContentBytes(
      {
        root: join(workspaceRoot, 'knowledge', 'content'),
        knowledgeBaseId,
        mount: candidateHead.schemaContent.reference.locator.mount,
      },
      { kind: 'workspace', workspaceId },
      candidateHead.schemaContent,
      candidateHead.schemaContent.byteLength
    );
    if (!Buffer.from(candidateBytes).equals(Buffer.from(request.schemaText, 'utf8')))
      throw new NotebookError('recovery_required');
    yield;
    const admission = yield* ownerAdmission(selected.head.notebookCommit);
    yield;
    const entries = Object.keys(
      selected.notebook.inspectRevision(selected.head.notebookCommit).entries
    );
    const pageIds = entries
      .filter((path) => !['index.md', 'log.md'].includes(path.split('/').at(-1)!))
      .map((path) => path.slice(0, -3));
    const sources = Object.keys(selected.notebook.readSourcePointers(selected.head.notebookCommit));
    const report = yield* previewWorkspaceSchemaSteps({
      dataRoot,
      coreDb,
      store,
      workspaceDb,
      access,
      workspaceId,
      notebook: selected.notebook,
      scopeSchemaText: selected.scopeSchemaText,
      candidateSchemaText: request.schemaText,
      pageScopeId: admission.pageScopeId!,
      registeredSources: admission.registeredSources,
      revalidate: function* () {
        revalidate();
        yield* readAuthorizedWorkspaceNotebookPagesSteps({
          workspaceId,
          access,
          dataRoot,
          notebookRevision: selected.head.notebookCommit,
          pageIds,
        });
        for (const sourceId of sources)
          if (!(yield* knowledgeSourceAudienceReadableSteps({ workspaceId, access }, sourceId)))
            throw new OperationError(
              WORKSPACE_ACCESS_DENIED.code,
              'Knowledge source is unavailable.',
              403
            );
      },
      admitProposal: function* (proposal) {
        const candidate = selected.notebook.readRevision(proposal.candidateRevision);
        const trees = [proposal.baseRevision, proposal.candidateRevision].map((revision) =>
          selected.notebook.readContent(revision)
        );
        const paths = [...new Set(trees.flatMap((files) => Object.keys(files)))];
        for (const files of trees)
          yield* ownerAdmission(
            proposal.baseRevision,
            paths.map((path) => ({ path, content: files[path] ?? null })),
            candidate.metadata.changeRequest.requestId
          );
      },
    });
    // Classify semantic head changes after released disclosure work, before general readset conflicts.
    revalidate();
    observations!.revalidate();
    if (!fullyValid(report))
      throw new OperationError('conflict', 'The current Schema impact requires review.', 409, {
        details: { reviewedReport: reviewed, actualReport: report },
      });
    yield;
    const result = schemaApplicationResult(reviewed, report);
    const nextHead = { ...candidateHead, notebookCommit: selected.head.notebookCommit };
    const { responseKind, ...original } = receipt;
    const statements = [
      ...controlKnowledgeHeadStatements(nextHead, selected.head),
      prepareAuditEventStatement(
        prepareAuditEvent({
          workspaceId,
          requestId: request.requestId,
          actor: producer,
          category: 'knowledge',
          action: 'knowledge.schema.apply',
          outcome: 'succeeded',
          resource: `knowledge-schema-report:${result.reportDigest}`,
          summary: 'Reviewed Workspace schema applied.',
          now: new Date(receipt.createdAt),
        })
      ),
      prepareControlCommandRequestStatement(workspaceId, {
        ...original,
        response: { kind: responseKind, id: result.reportDigest },
      }),
    ];
    const directory = join(workspaceRoot, 'knowledge', 'schema', 'history');
    const files = [
      {
        path: join(directory, `${result.baseSchemaDigest.slice(7)}.yaml`),
        publicationBytes: Buffer.byteLength(selected.scopeSchemaText),
      },
      {
        path: join(directory, `${result.candidateSchemaDigest.slice(7)}.yaml`),
        publicationBytes: Buffer.byteLength(request.schemaText),
      },
      {
        path: join(directory, `${result.reportDigest.slice(7)}.json`),
        publicationBytes: Buffer.byteLength(schemaReportBytes(reviewed, report)),
      },
    ];
    const validateInputs = () => {
      revalidate();
      observations!.revalidate();
    };
    transferred = true;
    return {
      result,
      files,
      statements,
      revalidate,
      validateInputs,
      publishHistory: () => {
        validateInputs();
        if (getCommandRequestRecordFromDb(workspaceDb, receipt.key, receipt.createdAt))
          throw new NotebookError('conflict');
        prepareSchemaApplicationHistory({
          workspaceRoot,
          previousSchemaText: selected.scopeSchemaText,
          candidateSchemaText: request.schemaText,
          report: reviewed,
          actualReport: report,
        });
      },
      close,
    };
  } finally {
    if (!transferred) close();
  }
}
