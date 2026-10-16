import { createHash } from 'node:crypto';
import type { RetrievalDocument } from '../retrieval-service.js';
import type { WorkerContextPackageSourceFile } from './worker-context-package.js';

/** Projects one already verified, currently authorized S39 PDF source into the generic kernel. The caller owns its accepted package root and repeats authorization before disclosure. */
export function pdfSourceRetrievalDocument(
  source: WorkerContextPackageSourceFile
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
      path: projection.representationSnapshotPath,
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
