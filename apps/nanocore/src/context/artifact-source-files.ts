import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { type FileHandle, lstat, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ArtifactReferenceSchema,
  ArtifactSchema,
  MAX_ARTIFACT_FILE_BYTES,
} from '@openkit/protocol';
import type { z } from 'zod';
import type { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import {
  artifactFilePayloadPath,
  MAX_ARTIFACT_MATERIAL_TEXT_BYTES,
} from '../storage/artifacts/file-records.js';
import {
  assertCanonicalDirectory,
  ensureCanonicalDirectoryAsync,
} from '../storage/workspace-file-records.js';
import { type BoundedByteSource, openBoundedSourceView } from './bounded-source-view.js';
import { type PdfTextLayerDerivative, processPdfTextLayer } from './pdf-text-layer.js';
import type {
  WorkerContextPackageProjection,
  WorkerContextPackageSourceFileInput,
} from './worker-context-package.js';

type Artifact = z.infer<typeof ArtifactSchema>;

const CHUNK_BYTES = 65_536;
const TEXT_MEDIA = new Set(['text/plain', 'text/markdown', 'application/json']);

/** Prepares explicitly selected exact Artifact versions under current source and destination authority. This adapter retains no access grant or open descriptor. The existing S39 writer verifies every complete original before first acceptance without retaining an extra copy; a bounded text descriptor does not prove body absence. */
export async function prepareArtifactSourceInputs(input: {
  readonly workspaceRoot: string;
  readonly artifacts: readonly Artifact[];
  /** Must compare the captured version and metadata with the current owner and recheck source visibility and receiving audience. */
  readonly assertCurrent: (artifact: Readonly<Artifact>) => void;
  readonly signal?: AbortSignal;
  /** Existing App-owned reserve used by isolated PDF staging as well as snapshot publication. */
  readonly admission?: FileStorageAdmission;
}): Promise<WorkerContextPackageSourceFileInput[]> {
  const workspaceRoot = input.workspaceRoot;
  const signal = input.signal ?? new AbortController().signal;
  const assertCurrent = input.assertCurrent;
  signal.throwIfAborted();
  if (input.artifacts.length > 100_000)
    throw new Error('Artifact source inventory exceeds the package bound.');
  // Capture all selections before the first callback or await can mutate caller-owned metadata.
  const artifacts = input.artifacts.map((artifact) => freeze(ArtifactSchema.parse(artifact)));
  const identities = new Set<string>();
  for (const artifact of artifacts) {
    const identity = `${artifact.workspaceId}/${artifact.id}/${artifact.version}`;
    if (identities.has(identity)) throw new Error('Artifact source selection is duplicated.');
    identities.add(identity);
  }
  const result: WorkerContextPackageSourceFileInput[] = [];
  for (const artifact of artifacts) {
    const check = (currentSignal = signal) => {
      signal.throwIfAborted();
      currentSignal.throwIfAborted();
      assertCurrent(artifact);
      signal.throwIfAborted();
      currentSignal.throwIfAborted();
    };
    check();
    assertCanonicalDirectory(workspaceRoot);
    const reference = ArtifactReferenceSchema.parse({
      scopeId: `artifact/workspace/${artifact.workspaceId}`,
      objectId: artifact.id,
    });
    // The existing path owner validates components, including inline identities used only in a snapshot.
    const path = artifactFilePayloadPath(workspaceRoot, artifact.id, artifact.version);
    const byteLength =
      artifact.content.format === 'file'
        ? artifact.content.byteLength
        : Buffer.byteLength(artifact.content.body, 'utf8');
    const mediaType =
      artifact.content.format === 'file'
        ? artifact.content.mediaType
        : artifact.content.format === 'markdown'
          ? 'text/markdown'
          : artifact.content.format === 'json'
            ? 'application/json'
            : 'text/plain';
    const packagePath = `sources/artifacts/${artifact.id}/${artifact.version}.txt`;
    let pinned: BigIntStats | undefined;
    /** Acquires one no-follow original and closes it if any post-await admission check fails. */
    const acquire = async (currentSignal: AbortSignal): Promise<FileHandle> => {
      check(currentSignal);
      assertParents(path);
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        check(currentSignal);
        const actual = await handle.stat({ bigint: true });
        check(currentSignal);
        if (
          !actual.isFile() ||
          actual.nlink !== 1n ||
          actual.size !== BigInt(byteLength) ||
          (pinned && !unchanged(pinned, actual))
        )
          throw new Error('Artifact original identity is unavailable.');
        pinned ??= actual;
        await assertPinned(handle, currentSignal);
        return handle;
      } catch (error) {
        await handle.close();
        throw error;
      }
    };
    /** Checks both the held original and its still-canonical owner path around every awaited probe. */
    const assertPinned = async (handle: FileHandle, currentSignal: AbortSignal): Promise<void> => {
      check(currentSignal);
      assertParents(path);
      const held = await handle.stat({ bigint: true });
      check(currentSignal);
      const named = await lstat(path, { bigint: true });
      check(currentSignal);
      assertParents(path);
      if (!pinned || !unchanged(pinned, held) || !unchanged(pinned, named))
        throw new Error('Artifact original changed after selection.');
    };
    /** Reads only a pinned range and never exposes bytes after authority or identity changes. */
    const read = async (
      handle: FileHandle,
      offset: number,
      maximum: number,
      currentSignal: AbortSignal
    ): Promise<Uint8Array> => {
      await assertPinned(handle, currentSignal);
      check(currentSignal);
      const bytes = Buffer.alloc(Math.min(maximum, CHUNK_BYTES));
      const count = await handle.read(bytes, 0, bytes.length, offset);
      check(currentSignal);
      await assertPinned(handle, currentSignal);
      return bytes.subarray(0, count.bytesRead);
    };
    const inline = artifact.content.format === 'file' ? undefined : artifact.content.body;
    const openOriginal = async function* (currentSignal: AbortSignal) {
      check(currentSignal);
      if (inline !== undefined) {
        let offset = 0;
        while (offset < inline.length) {
          check(currentSignal);
          let end = Math.min(offset + 16_384, inline.length);
          if (
            end < inline.length &&
            inline.charCodeAt(end - 1) >= 0xd800 &&
            inline.charCodeAt(end - 1) <= 0xdbff &&
            inline.charCodeAt(end) >= 0xdc00 &&
            inline.charCodeAt(end) <= 0xdfff
          )
            end -= 1;
          const bytes = Buffer.from(inline.slice(offset, end), 'utf8');
          offset = end;
          yield bytes;
        }
        check(currentSignal);
        return;
      }
      const current = await acquire(currentSignal);
      try {
        let offset = 0;
        while (offset < byteLength) {
          const bytes = await read(
            current,
            offset,
            Math.min(CHUNK_BYTES, byteLength - offset),
            currentSignal
          );
          if (!bytes.byteLength)
            throw new Error('Artifact original ended before its admitted size.');
          offset += bytes.byteLength;
          check(currentSignal);
          yield bytes;
        }
        await assertPinned(current, currentSignal);
        check(currentSignal);
      } finally {
        await current.close();
      }
    };
    // Inline processing is already bounded by its existing text owner. Larger retained strings still stream exactly as originals.
    let inlineBytes =
      inline !== undefined && byteLength <= MAX_ARTIFACT_MATERIAL_TEXT_BYTES
        ? Buffer.from(inline, 'utf8')
        : undefined;
    if (inlineBytes && sha256(inlineBytes) !== artifact.contentDigest)
      throw new Error('Artifact inline original digest mismatch.');
    const handle = artifact.content.format === 'file' ? await acquire(signal) : undefined;
    let deliveredBytes: Uint8Array;
    let projection: WorkerContextPackageProjection;
    let representationBytes: Buffer | undefined;
    let pdfEvidence: Pick<PdfTextLayerDerivative, 'processor' | 'pages' | 'coverage'> | undefined;
    try {
      check();
      const identity = {
        sourceKey: `${reference.scopeId}/${reference.objectId}`,
        revision: String(artifact.version),
        originalDigest: artifact.contentDigest,
        representationId: 'original-utf8',
        representationDigest: artifact.contentDigest,
      };
      const pdf =
        mediaType === 'application/pdf'
          ? await preparePdfView({
              workspaceRoot,
              admission: input.admission,
              source: { ...identity, byteLength, open: openOriginal },
              signal,
              assertCurrent: check,
            })
          : undefined;
      if (pdf && pdf.status !== 'unavailable') {
        representationBytes = Buffer.from(pdf.derivative.text, 'utf8');
        pdfEvidence = {
          processor: pdf.derivative.processor,
          pages: pdf.derivative.pages,
          coverage: pdf.derivative.coverage,
        };
      }
      check();
      const representationDigest =
        pdf && pdf.status !== 'unavailable'
          ? pdf.derivative.representationDigest
          : artifact.contentDigest;
      const representationId =
        pdf && pdf.status !== 'unavailable' ? pdf.derivative.representationId : 'original-utf8';
      const representationByteLength = representationBytes?.byteLength ?? byteLength;
      const source: BoundedByteSource = {
        identity: { ...identity, representationDigest, representationId },
        byteLength: representationByteLength,
        read: async (offset, maximum, currentSignal) => {
          check(currentSignal);
          const bytes = representationBytes
            ? representationBytes.subarray(offset, offset + Math.min(maximum, CHUNK_BYTES))
            : handle
              ? await read(handle, offset, maximum, currentSignal)
              : inlineBytes!.subarray(offset, offset + Math.min(maximum, CHUNK_BYTES));
          check(currentSignal);
          return bytes;
        },
        assertUnchanged: async (currentSignal) => {
          check(currentSignal);
          if (handle) await assertPinned(handle, currentSignal);
          check(currentSignal);
        },
      };
      const view =
        pdf?.status === 'unavailable'
          ? pdf
          : !TEXT_MEDIA.has(mediaType) && !representationBytes
            ? { status: 'unavailable' as const, reason: 'unsupported' as const }
            : inline !== undefined && !inlineBytes
              ? { status: 'unavailable' as const, reason: 'resource_limited' as const }
              : await openBoundedSourceView(
                  source,
                  {
                    maxRepresentationBytes: MAX_ARTIFACT_FILE_BYTES,
                    timeoutMs: 30_000,
                    maxEnvelopeBytes: 65_536,
                  },
                  signal
                );
      check();
      const page = view.status === 'ready' ? await view.preview(signal) : view;
      check();
      if (page.status === 'ready') {
        deliveredBytes = Buffer.from(page.text, 'utf8');
        projection = {
          kind: page.truncated ? 'excerpt' : 'body',
          sourceRevision: String(artifact.version),
          representationId,
          representationDigest,
          representationByteLength,
          deliveredDigest: sha256(deliveredBytes),
          ranges: [{ start: page.range.start, end: page.range.end }],
          byteLength: deliveredBytes.byteLength,
          truncated: page.truncated,
          availability:
            page.truncated || pdfEvidence?.coverage.complete === false ? 'incomplete' : 'available',

          ...(pdfEvidence
            ? {
                pdfTextLayer: pdfEvidence,
              }
            : {}),
        };
      } else {
        representationBytes = undefined;
        pdfEvidence = undefined;
        if (!pdf && !['unsupported', 'invalid_utf8', 'resource_limited'].includes(page.reason))
          throw new Error('Artifact text representation is unavailable.');
        deliveredBytes = Buffer.from(
          JSON.stringify({ status: 'unavailable', reason: page.reason }),
          'utf8'
        );
        projection = {
          kind: 'descriptor',
          sourceRevision: String(artifact.version),
          representationId: pdf ? 'unavailable-pdf-text-layer-v1' : 'unavailable-original-view-v1',
          representationDigest: artifact.contentDigest,
          representationByteLength: byteLength,
          deliveredDigest: sha256(deliveredBytes),
          ranges: [],
          byteLength: deliveredBytes.byteLength,
          truncated: true,
          availability: 'unavailable',
        };
      }
      if (handle) await assertPinned(handle, signal);
      check();
    } finally {
      // Suppliers retain the immutable string, not one processor Buffer per selected inline source.
      inlineBytes = undefined;
      await handle?.close();
    }
    check();
    result.push({
      source: { kind: 'artifact', reference, artifactVersion: artifact.version },
      originalDigest: artifact.contentDigest,
      byteLength,
      mediaType,

      packagePath,
      projection,
      deliveredBytes,
      ...(representationBytes
        ? {
            openRepresentation: async function* (currentSignal: AbortSignal) {
              for (
                let offset = 0;
                offset < representationBytes!.byteLength;
                offset += CHUNK_BYTES
              ) {
                check(currentSignal);
                yield Buffer.from(representationBytes!.subarray(offset, offset + CHUNK_BYTES));
              }
              check(currentSignal);
            },
          }
        : {}),
      assertUnchanged: async (currentSignal = signal) => {
        check(currentSignal);
        if (artifact.content.format === 'file') {
          const current = await acquire(currentSignal);
          try {
            await assertPinned(current, currentSignal);
          } finally {
            await current.close();
          }
        }
        check(currentSignal);
      },
      open: openOriginal,
    });
  }
  return result;
}

/** Uses the existing private staging parent and shared App reserve; failures leave the original selected with a bounded unavailable view. */
async function preparePdfView(input: {
  workspaceRoot: string;
  admission: FileStorageAdmission | undefined;
  source: {
    sourceKey: string;
    revision: string;
    originalDigest: string;
    byteLength: number;
    open(signal: AbortSignal): AsyncIterable<Uint8Array>;
  };
  signal: AbortSignal;
  assertCurrent: () => void;
}) {
  if (!input.admission)
    return { status: 'unavailable' as const, reason: 'dependency-unavailable' as const };
  const admission = input.admission;
  input.assertCurrent();
  const temporaryRoot = join(dirname(input.workspaceRoot), '.staging');
  try {
    const directoryReservation = admission.reserve({
      stagingBytes: 65_536n,
      publicationBytes: 0n,
      extractionBytes: 0n,
      derivativeBytes: 0n,
    });
    try {
      await ensureCanonicalDirectoryAsync(temporaryRoot);
    } finally {
      directoryReservation.release();
    }
  } catch {
    input.assertCurrent();
    return { status: 'unavailable' as const, reason: 'resource-limited' as const };
  }
  input.assertCurrent();
  return processPdfTextLayer({
    source: input.source,
    temporaryRoot,
    signal: input.signal,
    reserveTemporaryBytes(bytes) {
      const reservation = admission.reserve({
        stagingBytes: BigInt(bytes) + 131_072n,
        publicationBytes: 0n,
        extractionBytes: 0n,
        derivativeBytes: 0n,
      });
      return {
        recordWritten(count) {
          reservation.recordWritten(Number(count));
        },
        release() {
          reservation.release();
        },
      };
    },
  });
}

/** Uses the same five canonical parent levels as the existing Artifact payload owner. */
function assertParents(path: string): void {
  let parent = dirname(path);
  for (let level = 0; level < 5; level += 1) {
    assertCanonicalDirectory(parent);
    parent = dirname(parent);
  }
}

/** Pins exact inode, ownership multiplicity, size and modification metadata. */
function unchanged(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    right.nlink === 1n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Hashes bounded delivered bytes or the existing bounded inline processor input. */
function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Removes caller mutation from all nested metadata before authority callbacks can inspect it. */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
