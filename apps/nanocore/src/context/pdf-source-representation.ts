import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  getRetrievalService,
  type RetrievalDocument,
  type RetrievalQuery,
  type RetrievalResult,
} from '../retrieval-service.js';
import type { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { ensureCanonicalDirectoryAsync } from '../storage/workspace-file-records.js';
import { SOURCE_PREVIEW_LIMITS, type SourceViewUnavailable } from './bounded-source-view.js';
import type {
  WorkerContextPackageSourceFile,
  WorkerContextPackageSourceFileInput,
} from './worker-context-package.js';
import { sameCurrentRepresentation } from './worker-source-read.js';

/** Projects one already verified, currently authorized exact PDF source into the generic kernel. The caller supplies its trusted data-root-relative temporary representation path and repeats authorization before disclosure. */
export function pdfSourceRetrievalDocument(
  source: WorkerContextPackageSourceFile,
  representationPath: string
): RetrievalDocument | null {
  const { projection } = source;
  if (projection.kind === 'descriptor' || !projection.pdfTextLayer) return null;
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
      path: representationPath,
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

/** Searches only a verified current exact representation staged outside immutable package bytes; cleanup releases the shared capacity reservation. */
export async function searchPdfSourceSnapshot(input: {
  readonly dataRoot: string;
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly source: WorkerContextPackageSourceFile;
  readonly currentSource?: WorkerContextPackageSourceFileInput | undefined;
  readonly admission?: FileStorageAdmission | undefined;
  readonly assertCurrent: () => void;
  readonly query: Pick<RetrievalQuery, 'mode' | 'query' | 'limit'>;
  readonly signal?: AbortSignal;
}): Promise<{ status: 'ready'; result: RetrievalResult } | SourceViewUnavailable> {
  let temporary: string | undefined;
  let reservation: ReturnType<FileStorageAdmission['reserve']> | undefined;
  try {
    input.signal?.throwIfAborted();
    input.assertCurrent();
    const current = input.currentSource;
    if (!input.source.projection.pdfTextLayer)
      return { status: 'unavailable', reason: 'unsupported' };
    if (
      !current?.openRepresentation ||
      !input.admission ||
      !sameCurrentRepresentation(input.source, current)
    )
      return { status: 'unavailable', reason: 'unavailable' };
    if (!Number.isSafeInteger(input.query.limit) || input.query.limit < 1 || input.query.limit > 20)
      return { status: 'unavailable', reason: 'invalid_request' };
    const size = input.source.projection.representationByteLength;
    reservation = input.admission.reserve({
      stagingBytes: BigInt(size) + 131_072n,
      publicationBytes: 0n,
      extractionBytes: 0n,
      derivativeBytes: 0n,
    });
    const parent = join(dirname(input.workspaceRoot), '.staging');
    await ensureCanonicalDirectoryAsync(parent);
    temporary = await mkdtemp(join(parent, 'source-search-'));
    const path = join(temporary, 'representation.txt');
    const file = await open(path, 'wx', 0o600);
    let length = 0;
    const hash = createHash('sha256');
    const signal = input.signal ?? new AbortController().signal;
    try {
      for await (const chunk of current.openRepresentation(signal)) {
        signal.throwIfAborted();
        input.assertCurrent();
        length += chunk.byteLength;
        if (chunk.byteLength > 65_536 || length > size)
          throw new Error('Current representation exceeded its captured size.');
        hash.update(chunk);
        await file.writeFile(chunk);
        reservation.recordWritten(chunk.byteLength);
      }
    } finally {
      await file.close();
    }
    await current.assertUnchanged(signal);
    input.assertCurrent();
    if (
      length !== size ||
      `sha256:${hash.digest('hex')}` !== input.source.projection.representationDigest
    )
      throw new Error('Current representation does not match captured bytes.');
    const document = pdfSourceRetrievalDocument(input.source, relative(input.dataRoot, path));
    if (!document) return { status: 'unavailable', reason: 'unsupported' };
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
  } finally {
    if (temporary) await rm(temporary, { recursive: true });
    reservation?.release();
  }
}
