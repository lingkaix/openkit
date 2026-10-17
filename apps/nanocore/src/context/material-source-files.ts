import { createHash } from 'node:crypto';
import { MaterialReferenceSchema } from '@openkit/protocol';
import { openBoundedSourceView } from './bounded-source-view.js';
import type {
  WorkerContextPackageMaterialSelectionInput,
  WorkerContextPackageProjection,
  WorkerContextPackageSourceFileInput,
} from './worker-context-package.js';

const MAX_MATERIAL_SOURCE_BYTES = 16_777_216;

/** Captures one already-authorized immutable Material revision and separates its complete original from its bounded delivered text. The caller rechecks current source and destination authority through assertCurrent; this private callback grants no retained access. */
export async function prepareMaterialSourceInput(input: {
  readonly workspaceId: string;
  readonly selection: WorkerContextPackageMaterialSelectionInput;
  readonly assertCurrent: () => void;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly selection: WorkerContextPackageMaterialSelectionInput;
  readonly source: WorkerContextPackageSourceFileInput;
}> {
  const signal = input.signal ?? new AbortController().signal;
  const assertCurrent = input.assertCurrent;
  signal.throwIfAborted();
  assertCurrent();
  const selection = { ...input.selection };
  if (selection.sensitivity === 'restricted') throw new Error('Material source is unavailable.');
  // Check the UTF-8 allocation bound before copying the canonical SQLite text.
  const byteLength = Buffer.byteLength(selection.content, 'utf8');
  if (byteLength > MAX_MATERIAL_SOURCE_BYTES)
    throw new Error('Material source exceeds its processor bound.');
  const original = Buffer.from(selection.content, 'utf8');
  if (
    original.toString('utf8') !== selection.content ||
    sha256(original) !== selection.contentDigest
  )
    throw new Error('Material source revision is inconsistent.');
  const reference = MaterialReferenceSchema.parse({
    scopeId: `material/workspace/${input.workspaceId}`,
    objectId: selection.materialId,
  });
  const originalSnapshotPath = `originals/materials/${selection.materialId}/${selection.revisionId}/payload`;
  const extension = selection.mediaType === 'text/markdown' ? 'md' : 'txt';
  const packagePath = `workspace/materials/${selection.materialId}/${selection.revisionId}.${extension}`;
  const view = await openBoundedSourceView(
    {
      identity: {
        sourceKey: `${reference.scopeId}/${reference.objectId}`,
        revision: selection.revisionId,
        originalDigest: selection.contentDigest,
        representationId: 'original-utf8',
        representationDigest: selection.contentDigest,
      },
      byteLength,
      read: async (offset, maximum, currentSignal) => {
        currentSignal.throwIfAborted();
        assertCurrent();
        return original.subarray(offset, offset + maximum);
      },
      assertUnchanged: (currentSignal) => {
        currentSignal.throwIfAborted();
        assertCurrent();
      },
    },
    {
      maxRepresentationBytes: MAX_MATERIAL_SOURCE_BYTES,
      maxEnvelopeBytes: 65_536,
      timeoutMs: 30_000,
    },
    signal
  );
  const page = view.status === 'ready' ? await view.preview(signal) : view;
  if (page.status !== 'ready') throw new Error('Material text representation is unavailable.');
  const deliveredBytes = Buffer.from(page.text, 'utf8');
  const projection: WorkerContextPackageProjection = {
    kind: page.truncated ? 'excerpt' : 'body',
    sourceRevision: selection.revisionId,
    representationId: 'original-utf8',
    representationDigest: selection.contentDigest,
    representationByteLength: byteLength,
    deliveredDigest: sha256(deliveredBytes),
    ranges: [{ start: page.range.start, end: page.range.end }],
    byteLength: deliveredBytes.byteLength,
    truncated: page.truncated,
    availability: page.truncated ? 'incomplete' : 'available',
    originalSnapshotPath,
  };
  assertCurrent();
  return {
    selection: { ...selection, deliveredContent: page.text, projection },
    source: {
      source: { kind: 'material', reference, revisionId: selection.revisionId },
      originalDigest: selection.contentDigest,
      byteLength,
      mediaType: selection.mediaType,
      originalSnapshotPath,
      packagePath,
      projection,
      deliveredBytes,
      assertUnchanged: (currentSignal = signal) => {
        currentSignal.throwIfAborted();
        assertCurrent();
      },
      open: async function* (currentSignal) {
        for (let offset = 0; offset < original.byteLength; offset += 65_536) {
          currentSignal.throwIfAborted();
          assertCurrent();
          // Yield a copy: a consumer cannot modify the captured immutable original.
          yield Buffer.from(original.subarray(offset, offset + 65_536));
        }
        currentSignal.throwIfAborted();
        assertCurrent();
      },
    },
  };
}

/** Computes exact byte identity for bounded processor input or delivered preview bytes. */
function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
