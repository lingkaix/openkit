import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ApplyKnowledgeSchemaResponse,
  type PreviewKnowledgeSchemaResponse,
  PreviewKnowledgeSchemaResponseSchema,
} from '@openkit/app-api-schemas';
import { canonicalJsonText, readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import {
  ensureCanonicalDirectoryAsync,
  publishDurableFile,
  syncCanonicalDirectoryAsync,
} from '@openkit/storage';

import { verifyImmutableWinner } from '../storage/immutable-content-publish.js';
import { NotebookError } from './notebook-error.js';

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

/** Preserves both schema versions and both exact report snapshots before the native SQL reference. */
export async function prepareSchemaApplicationHistory(input: {
  readonly workspaceRoot: string;
  readonly previousSchemaText: string;
  readonly candidateSchemaText: string;
  readonly report: PreviewKnowledgeSchemaResponse;
  readonly actualReport: PreviewKnowledgeSchemaResponse;
}): Promise<ApplyKnowledgeSchemaResponse> {
  const result = schemaApplicationResult(input.report, input.actualReport);
  if (
    `sha256:${sha256Hex(input.previousSchemaText)}` !== result.baseSchemaDigest ||
    `sha256:${sha256Hex(input.candidateSchemaText)}` !== result.candidateSchemaDigest
  )
    throw new NotebookError('conflict');
  const directory = join(input.workspaceRoot, 'knowledge', 'schema', 'history');
  await ensureCanonicalDirectoryAsync(directory);
  for (const [digest, extension, text] of [
    [result.baseSchemaDigest, 'yaml', input.previousSchemaText],
    [result.candidateSchemaDigest, 'yaml', input.candidateSchemaText],
    [result.reportDigest, 'json', schemaReportBytes(input.report, input.actualReport)],
  ]) {
    const bytes = Buffer.from(text!, 'utf8');
    if (bytes.toString('utf8') !== text) throw new NotebookError('invalid_request');
    const destinationPath = join(directory, `${digest!.slice(7)}.${extension}`);
    try {
      await publishDurableFile({ destinationPath, bytes, mode: 0o444 });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      await verifyImmutableWinner(destinationPath, digest!, bytes.length);
      await syncCanonicalDirectoryAsync(directory);
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
