import { type BigIntStats, constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import {
  MAX_ARTIFACT_FILE_BYTES,
  parseReferenceScope,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import { currentSchedulerAdmissionWorkspaceAuthority } from '../auth/operation-authorizer.js';
import {
  isArtifactVisible,
  isThreadIdVisible,
  isThreadVisible,
} from '../auth/thread-visibility.js';
import type { FsStore } from '../lib/store.js';
import { getWorkerControlAcceptedFinalStatus } from '../runtime/worker-control-records.js';
import { findSchedulerAdmissionForWorkerLineage } from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { resolveDataRootPath } from '../storage/fs-layout.js';
import {
  assertCanonicalDirectory,
  assertSafeWorkspacePathSegment,
} from '../storage/workspace-file-records.js';
import { readWorkspaceMaterialSensitivity } from '../workspace-materials.js';
import {
  BoundedSourceError,
  openBoundedSourceView,
  type SourceViewCursor,
  type SourceViewPage,
  type SourceViewUnavailable,
  type SourceViewUnavailableReason,
} from './bounded-source-view.js';
import type { MediaByteSource } from './media-process.js';
import { createWorkerContextPackageAuthorityReader } from './worker-context-authorities.js';
import {
  readWorkerContextPackageTrace,
  type WorkerContextPackageSourceFile,
} from './worker-context-package.js';

type Coverage =
  | NonNullable<WorkerContextPackageSourceFile['projection']['pdfTextLayer']>['coverage']
  | { readonly kind: 'original-utf8'; readonly complete: true };

/** A bounded text page reports original size separately from representation size and coverage. */
export type WorkerSourceReadResult =
  | SourceViewUnavailable
  | (SourceViewPage & { readonly sourceByteLength: number; readonly coverage: Coverage });

/**
 * Resolves one exact inventory path under current Worker, source and receiving-audience authority. The returned paths and callback are private per-operation inputs, never a retained grant or model projection.
 * @param input Current authenticated Worker package and existing authority owners.
 * @param inventoryPath Exact sourceFiles packagePath from the accepted Turn snapshot.
 * @returns Verified source, canonical package root and a current-authority check for the caller's bounded operation.
 * @throws Error when authority or inventory is unavailable; callers must return a value-free refusal.
 */
export function resolveCurrentWorkerSource(
  input: {
    readonly environmentPackage: AgentEnvironmentPackage;
    readonly coreDb: CoreDb;
    readonly store: FsStore;
    readonly workspaceDb: WorkspaceDb;
    readonly signal?: AbortSignal | undefined;
    readonly requireAdmission?: (() => void) | undefined;
  },
  inventoryPath: string
) {
  const { scope } = input.environmentPackage;
  const admit = (source?: WorkerContextPackageSourceFile) => {
    input.signal?.throwIfAborted();
    input.requireAdmission?.();
    const turn = input.store.getTurnById(scope.turnId);
    const admission = findSchedulerAdmissionForWorkerLineage(input.coreDb, {
      ...scope,
      packageSnapshotId: input.environmentPackage.snapshotId,
    });
    if (
      !admission ||
      turn.status !== 'running' ||
      turn.workspaceId !== scope.workspaceId ||
      turn.threadId !== scope.threadId ||
      turn.agentSessionId !== scope.agentSessionId ||
      turn.agentId !== input.environmentPackage.agent.agentId ||
      !currentSchedulerAdmissionWorkspaceAuthority(input.coreDb, admission, 'thread.read', true) ||
      getWorkerControlAcceptedFinalStatus(input.coreDb, {
        ...scope,
        packageSnapshotId: input.environmentPackage.snapshotId,
        requestId: scope.requestId ?? null,
      })
    )
      throw new Error('Current source read admission is unavailable.');
    const userId = responsibleUserIdForActor(admission.triggerActor) ?? undefined;
    const administrator = admission.serverAdminTokenId !== null;
    const destination = input.store.getThread(scope.workspaceId, scope.threadId);
    if (!isThreadVisible(input.store, destination, userId, administrator))
      throw new Error('Current source read audience is unavailable.');
    if (!source) return;
    const referenceScope = parseReferenceScope(source.source.reference.scopeId);
    if (
      !referenceScope ||
      !('workspaceId' in referenceScope) ||
      referenceScope.workspaceId !== scope.workspaceId
    )
      throw new Error('Current source scope is unavailable.');
    let sourceThreadId: string | null = null;
    if (source.source.kind === 'artifact') {
      const artifact = input.store.getArtifact(scope.workspaceId, source.source.reference.objectId);
      if (!isArtifactVisible(input.store, artifact, userId, administrator))
        throw new Error('Current source is unavailable.');
      sourceThreadId = artifact.origin.kind === 'turn-output' ? artifact.origin.threadId : null;
    } else if (source.source.kind === 'material') {
      if (
        readWorkspaceMaterialSensitivity(input.workspaceDb, source.source.reference.objectId) ===
        'restricted'
      )
        throw new Error('Current source is unavailable.');
    } else {
      if (
        referenceScope.family !== 'input' ||
        !isThreadIdVisible(
          input.store,
          scope.workspaceId,
          referenceScope.threadId,
          userId,
          administrator
        )
      )
        throw new Error('Current source is unavailable.');
      const owner = input.store.getTurn(
        scope.workspaceId,
        referenceScope.threadId,
        referenceScope.turnId
      );
      if (!owner.fileInputs?.[Number(source.source.reference.objectId)])
        throw new Error('Current source is unavailable.');
      sourceThreadId = referenceScope.threadId;
    }
    if (sourceThreadId) {
      const sourceThread = input.store.getThread(scope.workspaceId, sourceThreadId);
      if (
        sourceThread.visibility === 'private' &&
        (destination.visibility !== 'private' ||
          destination.privateOwnerUserId !== sourceThread.privateOwnerUserId)
      )
        throw new Error('Current source destination is unavailable.');
    }
  };
  admit();
  const workspaceRoot = resolveDataRootPath(
    input.workspaceDb.dataRoot,
    'workspaces',
    scope.workspaceId
  );
  const trace = readWorkerContextPackageTrace({
    authorities: createWorkerContextPackageAuthorityReader(input),
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    turnId: scope.turnId,
    workspaceRoot,
  });
  if (
    trace.packageSnapshotId !== input.environmentPackage.snapshotId ||
    trace.agentSessionId !== scope.agentSessionId
  )
    throw new Error('Current source package is unavailable.');
  const source = trace.sourceFiles?.find((entry) => entry.packagePath === inventoryPath);
  if (!source) throw new Error('Selected source is unavailable.');
  admit(source);
  return {
    source,
    workspaceRoot,
    packageRoot: join(
      workspaceRoot,
      'threads',
      scope.threadId,
      'turns',
      scope.turnId,
      'context-package'
    ),
    threadId: scope.threadId,
    turnId: scope.turnId,
    assertCurrent: () => admit(source),
  };
}

/**
 * Reads only a source entry already admitted by the strict S39 verifier. The caller owns current source and receiving-audience authorization; no file path or callback becomes a retained grant.
 * @param input Exact accepted inventory entry, current Turn root and per-operation authority.
 * @returns A bounded UTF-8 page and pinned continuation, or a content-free unavailable result.
 */
export async function readWorkerSourceSnapshot(input: {
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly source: WorkerContextPackageSourceFile;
  readonly assertCurrent: () => void;
  readonly mode?: 'preview' | 'read' | undefined;
  readonly cursor?: SourceViewCursor | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<WorkerSourceReadResult> {
  try {
    input.signal?.throwIfAborted();
    input.assertCurrent();
    const source = structuredClone(input.source);
    const projection = source.projection;
    if (projection.kind === 'descriptor' || projection.availability === 'unavailable')
      return unavailable('unsupported');
    if (input.cursor && input.mode !== 'read') return unavailable('invalid_request');
    const relative = projection.representationSnapshotPath ?? source.originalSnapshotPath;
    if (
      (!projection.representationSnapshotPath && projection.representationId !== 'original-utf8') ||
      (projection.representationSnapshotPath && !projection.pdfTextLayer)
    )
      return unavailable('unsupported');
    // Select known coverage only: retained descriptive additions are not Tool output.
    const pdf = projection.pdfTextLayer?.coverage;
    const coverage: Coverage = pdf
      ? {
          kind: pdf.kind,
          complete: pdf.complete,
          provesCompleteBodyAbsence: pdf.provesCompleteBodyAbsence,
          totalPages: pdf.totalPages,
          processedPages: pdf.processedPages,
          pagesWithoutText: [...pdf.pagesWithoutText],
          reason: pdf.reason,
        }
      : { kind: 'original-utf8', complete: true };
    const extra = { sourceByteLength: source.byteLength, coverage };
    const envelopeBytes = 65_536 - Buffer.byteLength(JSON.stringify(extra), 'utf8');
    if (envelopeBytes < 128) return unavailable('resource_limited');
    if (Buffer.byteLength(relative, 'utf8') > 4096) return unavailable('resource_limited');
    const path = sourceSnapshotPath(input, relative);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      input.signal?.throwIfAborted();
      input.assertCurrent();
      const pinned = await file.stat({ bigint: true });
      if (
        !pinned.isFile() ||
        pinned.nlink !== 1n ||
        pinned.size !== BigInt(projection.representationByteLength)
      )
        throw new BoundedSourceError('corrupt');
      const view = await openBoundedSourceView(
        {
          identity: {
            sourceKey: `${source.source.reference.scopeId}/${source.source.reference.objectId}`,
            revision: projection.sourceRevision,
            originalDigest: source.originalDigest,
            representationId: projection.representationId,
            representationDigest: projection.representationDigest,
          },
          byteLength: projection.representationByteLength,
          read: async (offset, maximum, signal) => {
            signal.throwIfAborted();
            const bytes = Buffer.alloc(Math.min(maximum, 65_536));
            const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
            signal.throwIfAborted();
            return bytes.subarray(0, bytesRead);
          },
          assertUnchanged: async (signal) => {
            signal.throwIfAborted();
            input.assertCurrent();
            const held = await file.stat({ bigint: true });
            const named = await lstat(path, { bigint: true });
            signal.throwIfAborted();
            if (!sameFile(pinned, held) || !sameFile(pinned, named))
              throw new BoundedSourceError('stale');
            input.assertCurrent();
          },
        },
        {
          maxRepresentationBytes: MAX_ARTIFACT_FILE_BYTES,
          timeoutMs: 30_000,
          maxEnvelopeBytes: envelopeBytes,
        },
        input.signal
      );
      if (view.status !== 'ready') return view;
      const page =
        input.mode === 'read'
          ? await view.read(input.cursor, input.signal)
          : await view.preview(input.signal);
      input.signal?.throwIfAborted();
      input.assertCurrent();
      return page.status === 'ready' ? { ...page, ...extra } : page;
    } finally {
      await file.close();
    }
  } catch (error) {
    return unavailable(
      input.signal?.aborted
        ? 'cancelled'
        : error instanceof BoundedSourceError
          ? error.reason
          : 'unavailable'
    );
  }
}

/** Streams the exact retained original to an explicitly requested source-owned processor. This factory opens no current source or arbitrary host path and creates no access grant. */
export function workerSourceOriginal(input: {
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly source: WorkerContextPackageSourceFile;
  readonly assertCurrent: () => void;
}): MediaByteSource {
  const source = structuredClone(input.source);
  return {
    sourceKey: `${source.source.reference.scopeId}/${source.source.reference.objectId}`,
    revision: source.projection.sourceRevision,
    originalDigest: source.originalDigest,
    byteLength: source.byteLength,
    async *open(signal) {
      signal.throwIfAborted();
      input.assertCurrent();
      const path = sourceSnapshotPath(input, source.originalSnapshotPath);
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const pinned = await file.stat({ bigint: true });
        if (!pinned.isFile() || pinned.nlink !== 1n || pinned.size !== BigInt(source.byteLength))
          throw new BoundedSourceError('corrupt');
        let position = 0;
        while (position < source.byteLength) {
          signal.throwIfAborted();
          input.assertCurrent();
          const bytes = Buffer.alloc(Math.min(65_536, source.byteLength - position));
          const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
          signal.throwIfAborted();
          input.assertCurrent();
          if (!bytesRead) throw new BoundedSourceError('corrupt');
          position += bytesRead;
          yield bytes.subarray(0, bytesRead);
        }
        signal.throwIfAborted();
        input.assertCurrent();
        if (
          !sameFile(pinned, await file.stat({ bigint: true })) ||
          !sameFile(pinned, await lstat(path, { bigint: true }))
        )
          throw new BoundedSourceError('stale');
        input.assertCurrent();
      } finally {
        await file.close();
      }
    },
  };
}

/** Resolves only one inventory-owned snapshot path through canonical no-link directories. */
function sourceSnapshotPath(
  input: { workspaceRoot: string; threadId: string; turnId: string },
  relative: string
): string {
  if (Buffer.byteLength(relative, 'utf8') > 4096) throw new BoundedSourceError('resource_limited');
  const parts = [
    'threads',
    input.threadId,
    'turns',
    input.turnId,
    'context-package',
    ...relative.split('/'),
  ];
  for (const part of parts) assertSafeWorkspacePathSegment(part, 'Context Package path');
  let path = input.workspaceRoot;
  assertCanonicalDirectory(path);
  for (const part of parts.slice(0, -1)) {
    path = join(path, part);
    assertCanonicalDirectory(path);
  }
  return join(path, parts.at(-1)!);
}

/** Detects mutation or replacement of the held immutable snapshot, without reopening current sources. */
function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    after.isFile() &&
    after.nlink === 1n &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

/** No source name, digest, body or cursor is published on refusal. */
function unavailable(reason: SourceViewUnavailableReason): SourceViewUnavailable {
  return { status: 'unavailable', reason };
}
