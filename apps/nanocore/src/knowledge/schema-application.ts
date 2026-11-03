import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  measureCanonicalFile,
  syncCanonicalDirectory,
  syncCanonicalTree,
} from '@openkit/storage';

import { prepareAuditEvent, prepareAuditEventStatement } from '../audit-events.js';
import { readCurrentWorkspacePolicy } from '../auth/operation-authorizer.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { FsStore } from '../lib/store.js';
import { OperationError, WORKSPACE_ACCESS_DENIED } from '../operation-error.js';
import {
  admitKnowledgeRetrieval,
  knowledgeSourceAudienceReadable,
  readAuthorizedWorkspaceNotebookPages,
} from '../retrieval-knowledge-adapter.js';
import {
  getCommandRequestRecordFromDb,
  prepareControlCommandRequestStatement,
} from '../storage/command-request-records.js';
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
import { coreDbPath } from '../storage/fs-layout.js';
import { readImmutableContentBytes } from '../storage/immutable-content-read.js';
import { nativeProductScope, writeFileAtomic } from '../storage/workspace-file-records.js';
import { NotebookError } from './notebook-error.js';
import { readWorkspaceNotebookAdmission } from './notebook-workspace-admission.js';
import { readWorkspaceNotebookSelection } from './notebook-workspace-selection.js';
import { previewWorkspaceSchema } from './schema-dependency-preview.js';

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
  /** Closes only this request's owned Core reader, never the borrowed Workspace writer. */
  readonly close: () => void;
}

/** Decides the complete current Schema impact on the admitted Workspace connection, before the one capacity exchange. */
export function prepareNativeSchemaApplication(
  workspaceDb: WorkspaceDb,
  input: ControlSchemaApplicationInput
): PreparedNativeSchemaApplication {
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
  try {
    const coreDb = bindCoreSqlite(coreReader.sqlite, dataRoot);
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
    const ownerAdmission = (
      baseRevision: string,
      changes: readonly { path: string; content: string | null }[] = [],
      sourceRequestId = request.requestId
    ) =>
      readWorkspaceNotebookAdmission({
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
    const revalidate = () => {
      // Empty-change admission need not dereference a Thread's lazy Policy projection.
      // The active human author remains a fresh Core predicate after physical admission.
      try {
        readCurrentWorkspacePolicy({ coreDb, workspaceId, policy: facts.effectivePolicy });
      } catch {
        throw new NotebookError('recovery_required');
      }
      if (!isDeepStrictEqual(readControlKnowledgeHead(workspaceDb, knowledgeBaseId), selected.head))
        throw new NotebookError('conflict');
      admitKnowledgeRetrieval({ workspaceId, access });
      ownerAdmission(selected.head.notebookCommit);
    };
    revalidate();
    const retainedReceipt = getCommandRequestRecordFromDb(
      workspaceDb,
      receipt.key,
      receipt.createdAt
    );
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
      return {
        result,
        files: [],
        statements: [],
        publishHistory() {},
        revalidate,
        close: () => coreReader.close(),
      };
    }
    const reviewed = request.reviewedReport;
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
    const currentDigest = `sha256:${sha256Hex(selected.scopeSchemaText)}`;
    if (currentDigest !== reviewed.baseSchemaDigest)
      throw new OperationError('conflict', 'The reviewed Schema head changed.', 409, {
        details: {
          baseSchemaDigest: reviewed.baseSchemaDigest,
          currentSchemaDigest: currentDigest,
        },
      });
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
    const admission = ownerAdmission(selected.head.notebookCommit);
    const entries = Object.keys(
      selected.notebook.inspectRevision(selected.head.notebookCommit).entries
    );
    const pageIds = entries
      .filter((path) => !['index.md', 'log.md'].includes(path.split('/').at(-1)!))
      .map((path) => path.slice(0, -3));
    const sources = Object.keys(selected.notebook.readSourcePointers(selected.head.notebookCommit));
    const report = previewWorkspaceSchema({
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
      revalidate: () => {
        revalidate();
        readAuthorizedWorkspaceNotebookPages({
          workspaceId,
          access,
          dataRoot,
          notebookRevision: selected.head.notebookCommit,
          pageIds,
        });
        for (const sourceId of sources)
          if (!knowledgeSourceAudienceReadable({ workspaceId, access }, sourceId))
            throw new OperationError(
              WORKSPACE_ACCESS_DENIED.code,
              'Knowledge source is unavailable.',
              403
            );
      },
      admitProposal: (proposal) => {
        const candidate = selected.notebook.readRevision(proposal.candidateRevision);
        const trees = [proposal.baseRevision, proposal.candidateRevision].map((revision) =>
          selected.notebook.readContent(revision)
        );
        const paths = [...new Set(trees.flatMap((files) => Object.keys(files)))];
        for (const files of trees)
          ownerAdmission(
            proposal.baseRevision,
            paths.map((path) => ({ path, content: files[path] ?? null })),
            candidate.metadata.changeRequest.requestId
          );
      },
    });
    if (!fullyValid(report))
      throw new OperationError('conflict', 'The current Schema impact requires review.', 409, {
        details: { reviewedReport: reviewed, actualReport: report },
      });
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
    return {
      result,
      files,
      statements,
      revalidate,
      publishHistory: () => {
        revalidate();
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
      close: () => coreReader.close(),
    };
  } catch (error) {
    coreReader.close();
    throw error;
  }
}
