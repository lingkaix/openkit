import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ApplyKnowledgeSchemaResponse,
  type PreviewKnowledgeSchemaResponse,
  PreviewKnowledgeSchemaResponseSchema,
} from '@openkit/app-api-schemas';
import { canonicalJsonText, readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { publishDurableFile } from '@openkit/storage';
import {
  ensureCanonicalDirectoryAsync,
  syncCanonicalDirectoryAsync,
} from '../storage/canonical-filesystem.js';
import { verifyImmutableWinner } from '../storage/immutable-content-publish.js';
import { NotebookError } from './notebook-error.js';

/** Canonical dry-run evidence is retained independently of the original command receipt's expiry. */
export function schemaReportBytes(report: PreviewKnowledgeSchemaResponse): string {
  return canonicalJsonText(writeRetainedV1({ requiredFeatures: [], reviewedReport: report }));
}

/** Public result facts are reconstructed from the exact reviewed report, never current schema projections. */
export function schemaApplicationResult(
  report: PreviewKnowledgeSchemaResponse
): ApplyKnowledgeSchemaResponse {
  return {
    workspaceId: report.workspaceId,
    notebookRevision: report.notebookRevision,
    baseSchemaDigest: report.baseSchemaDigest,
    candidateSchemaDigest: report.candidateSchemaDigest,
    reportDigest: `sha256:${sha256Hex(schemaReportBytes(report))}`,
  };
}

/** Preserves both schema versions and the reviewed canonical report before the native SQL reference. */
export async function prepareSchemaApplicationHistory(input: {
  readonly workspaceRoot: string;
  readonly previousSchemaText: string;
  readonly candidateSchemaText: string;
  readonly report: PreviewKnowledgeSchemaResponse;
}): Promise<ApplyKnowledgeSchemaResponse> {
  const result = schemaApplicationResult(input.report);
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
    [result.reportDigest, 'json', schemaReportBytes(input.report)],
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
          !('reviewedReport' in record)
        )
          throw new Error('Unsupported required schema report semantics.');
        return PreviewKnowledgeSchemaResponseSchema.parse(record.reviewedReport);
      }
    );
    return { ...schemaApplicationResult(report), reportDigest };
  } catch (error) {
    if (error instanceof NotebookError) throw error;
    throw new NotebookError('recovery_required');
  }
}
