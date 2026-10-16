import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import {
  getRetrievalService,
  type RetrievalDocument,
  type RetrievalQuery,
  type RetrievalResult,
} from '../retrieval-service.js';
import { SOURCE_PREVIEW_LIMITS, type SourceViewUnavailable } from './bounded-source-view.js';
import type { WorkerContextPackageSourceFile } from './worker-context-package.js';

/** Projects one already verified, currently authorized S39 PDF source into the generic kernel. The caller supplies its trusted data-root-relative package path and repeats authorization before disclosure. */
export function pdfSourceRetrievalDocument(
  source: WorkerContextPackageSourceFile,
  packagePath: string
): RetrievalDocument | null {
  const { projection } = source;
  if (
    projection.kind === 'descriptor' ||
    !projection.representationSnapshotPath ||
    !projection.pdfTextLayer
  )
    return null;
  const original = JSON.stringify(source.source.reference);
  return {
    key: { namespace: 'turn-source', id: source.packagePath },
    revision: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
    digest: source.originalDigest.slice('sha256:'.length),
    size: source.byteLength,
    name: source.packagePath,
    media_type: source.mediaType,
    locator: original,
    content: {
      kind: 'representation',
      path: `${packagePath}/${projection.representationSnapshotPath}`,
      digest: projection.representationDigest.slice('sha256:'.length),
      size: projection.representationByteLength,
      processor: projection.representationId,
      fragments: projection.pdfTextLayer.pages.map((page) => ({
        start: page.startByte,
        end: page.endByte,
        locator: `${original}#page=${page.page}`,
      })),
      complete: projection.pdfTextLayer.coverage.complete,
    },
  };
}

/** Searches one admitted retained PDF representation. No current source is reparsed or used to repair missing snapshot bytes. */
export async function searchPdfSourceSnapshot(input: {
  readonly dataRoot: string;
  readonly workspaceRoot: string;
  readonly packageRoot: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly source: WorkerContextPackageSourceFile;
  readonly assertCurrent: () => void;
  readonly query: Pick<RetrievalQuery, 'mode' | 'query' | 'limit'>;
  readonly signal?: AbortSignal;
}): Promise<{ status: 'ready'; result: RetrievalResult } | SourceViewUnavailable> {
  try {
    input.signal?.throwIfAborted();
    input.assertCurrent();
    const document = pdfSourceRetrievalDocument(
      input.source,
      relative(input.dataRoot, input.packageRoot)
    );
    if (!document) return { status: 'unavailable', reason: 'unsupported' };
    if (!Number.isSafeInteger(input.query.limit) || input.query.limit < 1 || input.query.limit > 20)
      return { status: 'unavailable', reason: 'invalid_request' };
    // Derived indexes stay in the existing receiving Thread home, outside immutable package bytes.
    const service = getRetrievalService(
      input.dataRoot,
      join(input.workspaceRoot, 'threads', input.threadId)
    );
    await service.search({ ...input.query, scopes: [] }, input.signal);
    input.assertCurrent();
    const view = {
      scope: createHash('sha256')
        .update(JSON.stringify([input.threadId, input.turnId, input.source.packagePath]))
        .digest('hex'),
      documents: [document],
    };
    const generation = await service.inspect(view.scope, input.signal);
    input.assertCurrent();
    await service.publish(view, generation, input.signal);
    input.assertCurrent();
    const result = await service.search({ ...input.query, scopes: [view] }, input.signal);
    input.assertCurrent();
    input.signal?.throwIfAborted();
    // Each query returns at most twenty previews, each at most fifty lines and the kernel byte cap.
    for (const hit of result.hits) {
      const lines = hit.snippet.split('\n');
      if (lines.length > SOURCE_PREVIEW_LIMITS.lines)
        hit.snippet = lines.slice(0, SOURCE_PREVIEW_LIMITS.lines).join('\n');
    }
    const response = { status: 'ready' as const, result };
    // Leave room for the MCP wrapper; omitted hits never claim complete enumeration.
    while (Buffer.byteLength(JSON.stringify(response)) > 48 * 1024 && result.hits.length) {
      result.hits.pop();
      result.coverage.omitted_matches += 1;
      result.coverage.matches_complete = false;
      result.complete = false;
    }
    if (Buffer.byteLength(JSON.stringify(response)) > 48 * 1024)
      return { status: 'unavailable', reason: 'resource_limited' };
    return response;
  } catch {
    return { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'unavailable' };
  }
}
