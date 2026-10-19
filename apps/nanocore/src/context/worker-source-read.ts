import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import {
  MAX_ARTIFACT_FILE_BYTES,
  parseReferenceScope,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import { currentSchedulerAdmissionWorkspaceAuthority } from '../auth/operation-authorizer.js';
import {
  canDiscloseThreadToAudience,
  isArtifactVisible,
  isThreadIdVisible,
  isThreadVisible,
} from '../auth/thread-visibility.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import type { FsStore } from '../lib/store.js';
import { readAuthorizedWorkspaceNotebookPages } from '../retrieval-knowledge-adapter.js';
import { getWorkerControlAcceptedFinalStatus } from '../runtime/worker-control-records.js';
import { findSchedulerAdmissionForWorkerLineage } from '../scheduler-records.js';
import type { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { resolveDataRootPath } from '../storage/fs-layout.js';
import {
  getWorkspaceMaterial,
  getWorkspaceMaterialRevision,
  readWorkspaceMaterialSensitivity,
} from '../workspace-materials.js';
import { prepareArtifactSourceInputs } from './artifact-source-files.js';
import {
  BoundedSourceError,
  openBoundedSourceView,
  type SourceViewCursor,
  type SourceViewPage,
  type SourceViewUnavailable,
  type SourceViewUnavailableReason,
} from './bounded-source-view.js';
import { prepareMaterialSourceInput } from './material-source-files.js';
import type { MediaByteSource } from './media-process.js';
import { PdfTextLayerEvidenceSchema } from './pdf-text-layer.js';
import { prepareTurnFileSourceInputs } from './turn-source-files.js';
import { createWorkerContextPackageAuthorityReader } from './worker-context-authorities.js';
import {
  readWorkerContextPackageTrace,
  type WorkerContextPackageKnowledgeSelection,
  type WorkerContextPackageSourceFile,
  type WorkerContextPackageSourceFileInput,
} from './worker-context-package.js';

type Coverage =
  | NonNullable<WorkerContextPackageSourceFile['projection']['pdfTextLayer']>['coverage']
  | { readonly kind: 'original-utf8'; readonly complete: true };

/** A bounded text page reports original size separately from representation size and coverage. */
export type WorkerSourceReadResult =
  | SourceViewUnavailable
  | (SourceViewPage & { readonly sourceByteLength: number; readonly coverage: Coverage });

/**
 * Resolves one exact inventory path under current Worker, source and receiving-audience authority. The returned suppliers and callback are private per-operation inputs, never a retained grant or model projection.
 * @param input Current authenticated Worker package and existing authority owners.
 * @param inventoryPath Exact sourceFiles or knowledgeSelections packagePath from the accepted Turn snapshot.
 * @returns Exact current source suppliers or a pinned Knowledge selection, with a current-authority check for bounded consumption.
 * @throws Error when authority or inventory is unavailable; callers must return a value-free refusal.
 */
export async function resolveCurrentWorkerSource(
  input: {
    readonly environmentPackage: AgentEnvironmentPackage;
    readonly coreDb: CoreDb;
    readonly store: FsStore;
    readonly workspaceDb: WorkspaceDb;
    readonly signal?: AbortSignal | undefined;
    readonly requireAdmission?: (() => void) | undefined;
    readonly fileAdmission?: FileStorageAdmission | undefined;
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
    if (!userId) throw new Error('Current Worker responsibility is unavailable.');
    const resourcePolicyActor = {
      kind: 'agent' as const,
      userId,
      agentId: input.environmentPackage.agent.agentId,
      processId: scope.agentSessionId,
    };

    const destination = input.store.getThread(scope.workspaceId, scope.threadId);
    if (
      !isThreadVisible(
        input.store,
        destination,
        userId,
        administrator,
        'thread.read',
        resourcePolicyActor
      )
    )
      throw new Error('Current source read audience is unavailable.');
    if (!source) return admission;
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
      if (
        artifact.version < source.source.artifactVersion ||
        !isArtifactVisible(input.store, artifact, userId, administrator, resourcePolicyActor)
      )
        throw new Error('Current source is unavailable.');
      sourceThreadId = artifact.origin.kind === 'turn-output' ? artifact.origin.threadId : null;
    } else if (source.source.kind === 'material') {
      const revision = getWorkspaceMaterialRevision(
        input.workspaceDb,
        source.source.reference.objectId,
        source.source.revisionId
      );
      if (
        revision.contentDigest !== source.originalDigest ||
        Buffer.byteLength(revision.content) !== source.byteLength ||
        revision.mediaType !== source.mediaType
      )
        throw new Error('Current Material revision is unavailable.');
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
          administrator,
          'thread.read',
          resourcePolicyActor
        )
      )
        throw new Error('Current source is unavailable.');
      const owner = input.store.getTurn(
        scope.workspaceId,
        referenceScope.threadId,
        referenceScope.turnId
      );
      const original = owner.fileInputs?.[Number(source.source.reference.objectId)];
      if (
        !original ||
        original.contentDigest !== source.originalDigest ||
        original.sizeBytes !== source.byteLength ||
        original.mediaType !== source.mediaType
      )
        throw new Error('Current source is unavailable.');
      sourceThreadId = referenceScope.threadId;
    }
    if (sourceThreadId) {
      const sourceThread = input.store.getThread(scope.workspaceId, sourceThreadId);
      if (!canDiscloseThreadToAudience(input.store, sourceThread, destination))
        throw new Error('Current source destination is unavailable.');
    }
    return admission;
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
  const knowledge = trace.knowledgeSelections.find((entry) => entry.packagePath === inventoryPath);
  if ((!source && !knowledge) || (source && knowledge))
    throw new Error('Selected source is unavailable.');
  const readKnowledge = () => {
    const admission = admit();
    if (
      !knowledge?.notebookRevision ||
      knowledge.knowledgeBaseId !==
        readDefaultKnowledgeBaseId({
          dataRoot: input.workspaceDb.dataRoot,
          scope: { kind: 'workspace', workspaceId: scope.workspaceId },
        }) ||
      !knowledge.projection ||
      knowledge.projection.sourceRevision !== knowledge.notebookRevision ||
      knowledge.projection.representationId !== 'original-utf8'
    )
      throw new Error('Selected Knowledge is unavailable.');
    const selected = readAuthorizedWorkspaceNotebookPages({
      dataRoot: input.workspaceDb.dataRoot,
      workspaceId: scope.workspaceId,
      notebookRevision: knowledge.notebookRevision,
      pageIds: [knowledge.knowledgePageId],
      access: {
        store: input.store,
        coreDb: input.coreDb,
        actor: admission.triggerActor,
        outputThreadId: scope.threadId,
        outputTurnId: scope.turnId,
      },
    });
    const page = selected.pages[0];
    if (
      selected.notebookRevision !== knowledge.notebookRevision ||
      !page ||
      page.contentDigest !== knowledge.contentDigest
    )
      throw new Error('Selected Knowledge is unavailable.');
    return page.content;
  };
  admit(source);
  if (knowledge) readKnowledge();
  const assertCurrent = () => {
    admit(source);
  };
  let currentSource: WorkerContextPackageSourceFileInput | undefined;
  if (source?.source.kind === 'artifact') {
    // Current source and receiving-audience admission precede any retained original read.
    const artifact = input.store.getArtifactVersion(
      scope.workspaceId,
      source.source.reference.objectId,
      source.source.artifactVersion
    ).artifact;
    if (artifact.contentDigest !== source.originalDigest)
      throw new Error('Current source is unavailable.');
    [currentSource] = await prepareArtifactSourceInputs({
      workspaceRoot,
      artifacts: [artifact],
      assertCurrent,
      ...(input.fileAdmission ? { admission: input.fileAdmission } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } else if (source?.source.kind === 'material') {
    const { reference, revisionId } = source.source;
    const selected = trace.materialSelections.find(
      (entry) => entry.materialId === reference.objectId && entry.revisionId === revisionId
    );
    if (!selected) throw new Error('Selected Material is unavailable.');
    const revision = getWorkspaceMaterialRevision(
      input.workspaceDb,
      selected.materialId,
      selected.revisionId
    );
    const material = getWorkspaceMaterial(input.workspaceDb, selected.materialId);
    currentSource = (
      await prepareMaterialSourceInput({
        workspaceId: scope.workspaceId,
        selection: { ...selected, ...revision, sensitivity: material.sensitivity },
        assertCurrent,
        ...(input.signal ? { signal: input.signal } : {}),
      })
    ).source;
  } else if (source) {
    const owner = parseReferenceScope(source.source.reference.scopeId);
    if (owner?.family !== 'input') throw new Error('Selected Turn input is unavailable.');
    [currentSource] = await prepareTurnFileSourceInputs({
      workspaceRoot,
      turn: input.store.getTurn(scope.workspaceId, owner.threadId, owner.turnId),
      onlyOrdinal: Number(source.source.reference.objectId),
      assertCurrent,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
  if (
    source &&
    (!currentSource ||
      !isDeepStrictEqual(currentSource.source, source.source) ||
      currentSource.originalDigest !== source.originalDigest ||
      currentSource.byteLength !== source.byteLength ||
      currentSource.mediaType !== source.mediaType)
  )
    throw new Error('Selected exact original is unavailable.');
  assertCurrent();
  return {
    source,
    currentSource,
    knowledge,
    workspaceId: scope.workspaceId,
    readKnowledge: knowledge ? readKnowledge : undefined,
    workspaceRoot,
    threadId: scope.threadId,
    turnId: scope.turnId,
    assertCurrent,
  };
}

/**
 * Reads only a source entry already admitted by the strict S39 verifier. The caller owns current source and receiving-audience authorization; no file path or callback becomes a retained grant.
 * @param input Exact accepted inventory entry, current Turn root and per-operation authority.
 * @returns A bounded UTF-8 page and pinned continuation, or a content-free unavailable result.
 */
export async function readWorkerSourceSnapshot(input: {
  readonly workspaceId?: string | undefined;
  readonly source?: WorkerContextPackageSourceFile | undefined;
  /** Transient exact-owner supplier; never serialized in the Context Package. */
  readonly currentSource?: WorkerContextPackageSourceFileInput | undefined;
  readonly knowledge?: WorkerContextPackageKnowledgeSelection | undefined;
  /** Private canonical pinned reader supplied only after current Worker and selection admission. */
  readonly readKnowledge?: (() => string) | undefined;
  readonly assertCurrent: () => void;
  readonly mode?: 'preview' | 'read' | undefined;
  readonly cursor?: SourceViewCursor | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<WorkerSourceReadResult> {
  try {
    input.signal?.throwIfAborted();
    input.assertCurrent();
    if (input.knowledge) return await readKnowledgeSelection(input);
    if (!input.source) return unavailable('unavailable');
    const source = structuredClone(input.source);
    const projection = source.projection;
    if (projection.kind === 'descriptor' || projection.availability === 'unavailable')
      return unavailable('unsupported');
    if (input.cursor && input.mode !== 'read') return unavailable('invalid_request');
    const current = input.currentSource;
    if (!current || !sameCurrentRepresentation(source, current)) return unavailable('unavailable');
    if (projection.representationId !== 'original-utf8' && !projection.pdfTextLayer)
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
    const reader = streamRangeReader(
      projection.pdfTextLayer ? current.openRepresentation! : current.open,
      input.assertCurrent
    );
    try {
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
          read: reader.read,
          assertUnchanged: async (signal) => {
            signal.throwIfAborted();
            input.assertCurrent();
            await current.assertUnchanged(signal);
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
      await reader.close();
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

/**
 * Supplies the current exact canonical original only to the bounded vision consumer. Each open and chunk rechecks current authority; the staging owner verifies the complete original digest before processing.
 * @param input Accepted selected source, exact canonical supplier and fresh authority callback.
 * @returns A private bounded byte supplier, never a model-visible path or retained grant.
 */
export function workerSourceOriginal(input: {
  readonly source: WorkerContextPackageSourceFile;
  readonly currentSource?: WorkerContextPackageSourceFileInput | undefined;
  readonly assertCurrent: () => void;
}): MediaByteSource {
  const { source, currentSource } = input;
  if (
    !currentSource ||
    !isDeepStrictEqual(currentSource.source, source.source) ||
    currentSource.originalDigest !== source.originalDigest ||
    currentSource.byteLength !== source.byteLength ||
    currentSource.mediaType !== source.mediaType
  )
    throw new Error('Selected original is unavailable.');
  return {
    sourceKey: `${source.source.reference.scopeId}/${source.source.reference.objectId}`,
    revision: source.projection.sourceRevision,
    originalDigest: source.originalDigest,
    byteLength: source.byteLength,
    async *open(signal) {
      input.assertCurrent();
      for await (const chunk of currentSource.open(signal)) {
        signal.throwIfAborted();
        input.assertCurrent();
        yield chunk;
      }
      await currentSource.assertUnchanged(signal);
      input.assertCurrent();
    },
  };
}

/**
 * Compares known representation and recipe facts; descriptive additions carry no authority.
 * @param source Captured digest reference and representation proof.
 * @param current Transient source supplied by its exact canonical owner.
 * @returns Whether the current representation has all captured identity and lineage facts.
 */
export function sameCurrentRepresentation(
  source: WorkerContextPackageSourceFile,
  current: WorkerContextPackageSourceFileInput
): boolean {
  const a = source.projection;
  const b = current.projection;
  return (
    isDeepStrictEqual(source.source, current.source) &&
    source.originalDigest === current.originalDigest &&
    source.byteLength === current.byteLength &&
    source.mediaType === current.mediaType &&
    a.sourceRevision === b.sourceRevision &&
    a.representationId === b.representationId &&
    a.representationDigest === b.representationDigest &&
    a.representationByteLength === b.representationByteLength &&
    (a.pdfTextLayer
      ? !!current.openRepresentation &&
        isDeepStrictEqual(
          PdfTextLayerEvidenceSchema.parse(a.pdfTextLayer),
          PdfTextLayerEvidenceSchema.parse(b.pdfTextLayer)
        )
      : !b.pdfTextLayer)
  );
}

/** Adapts the existing bounded stream supplier to the view's sequential verification and range reads without retaining a complete original. */
function streamRangeReader(
  open: WorkerContextPackageSourceFileInput['open'],
  assertCurrent: () => void
) {
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let position = 0;
  let pending: Uint8Array = new Uint8Array();
  const close = async () => {
    await iterator?.return?.();
    iterator = undefined;
    pending = new Uint8Array();
  };
  return {
    close,
    async read(offset: number, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
      signal.throwIfAborted();
      assertCurrent();
      if (!iterator || offset < position) {
        await close();
        iterator = open(signal)[Symbol.asyncIterator]();
        position = 0;
      }
      while (position < offset || pending.byteLength === 0) {
        if (!pending.byteLength) {
          const next = await iterator.next();
          if (next.done) return new Uint8Array();
          if (next.value.byteLength > 65_536) throw new BoundedSourceError('resource_limited');
          pending = next.value;
        }
        const skip = Math.min(offset - position, pending.byteLength);
        pending = pending.subarray(skip);
        position += skip;
        if (position === offset && pending.byteLength) break;
      }
      const result = Buffer.from(pending.subarray(0, Math.min(maximum, 65_536)));
      pending = pending.subarray(result.length);
      position += result.length;
      signal.throwIfAborted();
      assertCurrent();
      return result;
    },
  };
}

/** No source name, digest, body or cursor is published on refusal. */
function unavailable(reason: SourceViewUnavailableReason): SourceViewUnavailable {
  return { status: 'unavailable', reason };
}

/**
 * Reads an already selected Notebook representation through the existing canonical authorization callback.
 * @param input Exact accepted selection, pinned reader and current Worker admission.
 * @returns A bounded selected page or a content-free refusal.
 */
async function readKnowledgeSelection(
  input: Parameters<typeof readWorkerSourceSnapshot>[0]
): Promise<WorkerSourceReadResult> {
  const selected = input.knowledge!;
  const projection = selected.projection;
  if (
    !projection ||
    !selected.notebookRevision ||
    !input.workspaceId ||
    !input.readKnowledge ||
    projection.kind === 'descriptor' ||
    projection.availability === 'unavailable'
  )
    return unavailable('unavailable');
  if (input.cursor && input.mode !== 'read') return unavailable('invalid_request');
  const bytes = Buffer.from(input.readKnowledge());
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (
    digest !== selected.contentDigest ||
    projection.representationDigest !== digest ||
    projection.representationByteLength !== bytes.length ||
    projection.sourceRevision !== selected.notebookRevision
  )
    return unavailable('corrupt');
  const extra = {
    sourceByteLength: bytes.length,
    coverage: { kind: 'original-utf8' as const, complete: true as const },
  };
  const view = await openBoundedSourceView(
    {
      identity: {
        sourceKey: `page/workspace/${input.workspaceId}/${selected.knowledgeBaseId}/${selected.knowledgePageId}`,
        revision: selected.notebookRevision,
        originalDigest: digest,
        representationId: 'original-utf8',
        representationDigest: digest,
      },
      byteLength: bytes.length,
      read: async (offset, maximum, signal) => {
        signal.throwIfAborted();
        return bytes.subarray(offset, offset + maximum);
      },
      assertUnchanged: (signal) => {
        signal.throwIfAborted();
        input.assertCurrent();
      },
    },
    {
      maxRepresentationBytes: 32 * 1024 * 1024,
      timeoutMs: 30_000,
      maxEnvelopeBytes: 65_536 - Buffer.byteLength(JSON.stringify(extra)),
    },
    input.signal
  );
  if (view.status !== 'ready') return view;
  const page =
    input.mode === 'read'
      ? await view.read(input.cursor, input.signal)
      : await view.preview(input.signal);
  // Re-open only the exact selected commit under fresh source and destination admission before disclosure.
  if (input.readKnowledge() !== bytes.toString('utf8')) return unavailable('stale');
  input.assertCurrent();
  return page.status === 'ready' ? { ...page, ...extra } : page;
}
