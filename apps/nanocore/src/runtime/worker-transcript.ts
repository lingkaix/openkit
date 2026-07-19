import { createHash } from 'node:crypto';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { ArtifactSchema, ItemSchema } from '@openkit/protocol';
import {
  type WorkerCanonicalEventRecord,
  type WorkerLineage,
  WorkerTranscriptArtifactRecordSchema,
  WorkerTranscriptEventRecordSchema,
  WorkerTranscriptItemRecordSchema,
} from '@openkit/worker-protocol';
import { z } from 'zod';
import { createArtifactReview, getArtifactReview } from '../artifact-reviews.js';
import type { WorkerContextPackageTrace } from '../context/worker-context-package.js';
import { ArtifactAuthorityError, type FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import { artifactReferenceItemId } from '../storage/workspace-file-records.js';
import { getWorkspaceMaterial, getWorkspaceMaterialRevision } from '../workspace-materials.js';

/** Worker transcript import payload collected at turn end. */
export interface WorkerTranscriptPayload {
  /** Serialized `/openkit/session/events.jsonl` content. */
  eventsJsonl?: string;
  /** Serialized `/openkit/session/items.jsonl` content. */
  itemsJsonl?: string;
  /** Serialized `/openkit/session/artifacts.jsonl` content. */
  artifactsJsonl?: string;
  /** Backend-validated exact bytes keyed by their Artifact declaration sequence. */
  artifactFiles?: WorkerTranscriptArtifactFile[];
  /** Backend-local restricted runtime provenance files, when the AEP requested collection. */
  runtimeProvenance?: WorkerRuntimeProvenanceCollection;
}

/** One backend-validated Artifact payload retained only through canonical import. */
export interface WorkerTranscriptArtifactFile {
  /** Exact source bytes with no text or newline normalization. */
  bytes: Buffer;
  /** Unique sequence of the matching transcript declaration. */
  sequence: number;
}

/** Backend-local runtime provenance collection passed only to NanoCore's restricted importer. */
export interface WorkerRuntimeProvenanceCollection {
  /** Product-safe collection diagnostics. */
  diagnostics: WorkerTranscriptDiagnostic[];
  /** Downloaded restricted raw-stream manifest path, or null when unavailable. */
  manifestPath: string | null;
  /** Required worker-visible paths that could not be collected. */
  missingPaths: string[];
  /** Downloaded restricted native-origin index path, or null when unavailable. */
  nativeOriginIndexPath: string | null;
  /** Synthetic stream refs mapped to backend-local restricted files. */
  rawStreamPaths: Record<string, string>;
}

/** Options that influence transcript import behavior. */
export interface WorkerTranscriptImportOptions {
  /** Live canonical event records already accepted through worker-control append. */
  acceptedLiveEvents?: WorkerCanonicalEventRecord[];
  /** Already strictly verified same-Turn S39 delivery trace. */
  contextPackageTrace?: WorkerContextPackageTrace;
  /** Stable server-written timestamp used by restart closeout exact replay. */
  recordedAt?: string;
  /** Workspace Review and Material authority for canonical Artifact import. */
  workspaceDb?: WorkspaceDb;
}

/** Diagnostic produced while parsing or importing worker transcript files. */
export interface WorkerTranscriptDiagnostic {
  /** Stable diagnostic code. */
  code: string;
  /** JSON path or JSONL location. */
  path: string;
  /** Human-readable diagnostic message. */
  message: string;
}

/** Result of importing one worker transcript payload. */
export interface WorkerTranscriptImportResult {
  /** Event sequences rejected because durable live acceptance was missing or conflicting. */
  rejectedEventSequences: number[];
  /** Event sequences skipped because identical live records were already accepted. */
  dedupedEventSequences: number[];
  /** Canonical item IDs created by NanoCore. */
  itemIds: string[];
  /** Canonical artifact IDs created by NanoCore. */
  artifactIds: string[];
  /** Diagnostics for rejected records. */
  diagnostics: WorkerTranscriptDiagnostic[];
}

/** Imports transcript candidates. @param store Canonical store. @param environmentPackage Accepted AEP. @param payload Collected files. @param options Accepted proof. @returns IDs and diagnostics. */
export function importWorkerTranscript(
  store: FsStore,
  environmentPackage: AgentEnvironmentPackage,
  payload: WorkerTranscriptPayload,
  options: WorkerTranscriptImportOptions = {}
): WorkerTranscriptImportResult {
  const result: WorkerTranscriptImportResult = {
    artifactIds: [],
    dedupedEventSequences: [],
    diagnostics: [],
    itemIds: [],
    rejectedEventSequences: [],
  };
  const acceptedLiveEvents = indexAcceptedLiveEvents(options.acceptedLiveEvents ?? []);

  importEventRecords(environmentPackage, payload.eventsJsonl ?? '', acceptedLiveEvents, result);
  if (result.diagnostics.some((diagnostic) => diagnostic.path.startsWith('$.events'))) {
    return result;
  }
  const artifacts = prepareArtifactRecords(store, environmentPackage, payload, options);
  importItemRecords(
    store,
    environmentPackage,
    payload.itemsJsonl ?? '',
    options.recordedAt,
    result
  );
  for (const prepared of artifacts) {
    if (!prepared.replay) {
      store.createArtifact(prepared.artifact);
      createArtifactReview(options.workspaceDb as WorkspaceDb, prepared.reviewInput);
      result.artifactIds.push(prepared.artifact.id);
    }
  }

  return result;
}

/** Reports whether one transcript proposes changing a Material. @param payload Collected transcript files. @returns Whether any valid Artifact declaration includes a Material proposal. */
export function workerTranscriptHasMaterialProposal(payload: WorkerTranscriptPayload): boolean {
  return parseTranscriptDeclarations(payload).some(
    (record) => record.artifact.materialProposal !== undefined
  );
}

/** Reconciles events. @param environmentPackage Expected AEP. @param jsonl Event JSONL. @param acceptedLiveEvents Durable fingerprints. @param result Mutable result. */
function importEventRecords(
  environmentPackage: AgentEnvironmentPackage,
  jsonl: string,
  acceptedLiveEvents: Map<number, string>,
  result: WorkerTranscriptImportResult
): void {
  for (const record of parseJsonl(jsonl, '$.events', result.diagnostics)) {
    const parsed = WorkerTranscriptEventRecordSchema.safeParse(record.value);

    if (!parsed.success) {
      result.diagnostics.push({
        code: 'worker_transcript_invalid_event',
        path: record.path,
        message: parsed.error.issues[0]?.message ?? 'Worker transcript event is invalid.',
      });
      continue;
    }

    const acceptedFingerprint = acceptedLiveEvents.get(parsed.data.sequence);

    if (!matchesPackageLineage(parsed.data.lineage, environmentPackage)) {
      acceptedLiveEvents.delete(parsed.data.sequence);
      result.rejectedEventSequences.push(parsed.data.sequence);
      result.diagnostics.push({
        code: 'worker_transcript_lineage_mismatch',
        path: record.path,
        message: 'Worker transcript event lineage does not match the package scope.',
      });
      continue;
    }

    const transcriptFingerprint = stableJson(parsed.data);

    if (acceptedFingerprint === undefined) {
      result.rejectedEventSequences.push(parsed.data.sequence);
      result.diagnostics.push({
        code: 'worker_transcript_live_event_missing',
        path: record.path,
        message: 'Worker transcript event was not accepted through live worker control.',
      });
      continue;
    }
    acceptedLiveEvents.delete(parsed.data.sequence);

    if (acceptedFingerprint === transcriptFingerprint) {
      result.dedupedEventSequences.push(parsed.data.sequence);
      continue;
    }

    result.rejectedEventSequences.push(parsed.data.sequence);
    result.diagnostics.push({
      code: 'worker_transcript_live_event_conflict',
      path: record.path,
      message: 'Worker transcript event conflicts with an already accepted live event.',
    });
  }

  for (const sequence of [...acceptedLiveEvents.keys()].sort((left, right) => left - right)) {
    result.rejectedEventSequences.push(sequence);
    result.diagnostics.push({
      code: 'worker_transcript_live_event_missing_from_transcript',
      path: '$.events',
      message: 'A live-accepted worker event is absent from the collected transcript.',
    });
  }
}

/** Imports assistant Items. @param store Canonical store. @param environmentPackage Expected AEP. @param jsonl Item JSONL. @param recordedAt Stable time. @param result Mutable result. */
function importItemRecords(
  store: FsStore,
  environmentPackage: AgentEnvironmentPackage,
  jsonl: string,
  recordedAt: string | undefined,
  result: WorkerTranscriptImportResult
): void {
  for (const record of parseJsonl(jsonl, '$.items', result.diagnostics)) {
    const parsed = WorkerTranscriptItemRecordSchema.safeParse(record.value);

    if (!parsed.success) {
      result.diagnostics.push({
        code: 'worker_transcript_invalid_item',
        path: record.path,
        message: parsed.error.issues[0]?.message ?? 'Worker transcript item is invalid.',
      });
      continue;
    }

    if (!matchesPackageLineage(parsed.data.lineage, environmentPackage)) {
      result.diagnostics.push({
        code: 'worker_transcript_lineage_mismatch',
        path: record.path,
        message: 'Worker transcript item lineage does not match the package scope.',
      });
      continue;
    }

    const timestamp = recordedAt ?? new Date().toISOString();
    const item = {
      id: `it_worker_${environmentPackage.scope.turnId}_${parsed.data.sequence}`,
      workspaceId: environmentPackage.scope.workspaceId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      type: 'assistant-message',
      status: parsed.data.item.status,
      text: itemText(parsed.data.item),
      createdAt: timestamp,
      completedAt: parsed.data.item.status === 'completed' ? timestamp : null,
    } as const;
    const existing = store
      .listThreadItems(environmentPackage.scope.workspaceId, environmentPackage.scope.threadId)
      .find((candidate) => candidate.id === item.id);
    if (existing && !isDeepStrictEqual(existing, item)) {
      throw new Error(`Worker transcript item replay conflict: ${item.id}`);
    }
    if (!existing) {
      store.createItem(item);
    }

    result.itemIds.push(item.id);
  }
}

/** Prepares Artifacts. @param store Canonical store. @param environmentPackage Accepted AEP. @param payload Collected files. @param options Accepted proof. @returns Classified candidates. */
function prepareArtifactRecords(
  store: FsStore,
  environmentPackage: AgentEnvironmentPackage,
  payload: WorkerTranscriptPayload,
  options: WorkerTranscriptImportOptions
) {
  if (!(payload.artifactsJsonl?.trim() || payload.artifactFiles?.length)) {
    return [];
  }
  const workspaceDb = options.workspaceDb;
  if (!workspaceDb || workspaceDb.workspaceId !== environmentPackage.scope.workspaceId) {
    throw transcriptError('recovery_required', 'Artifact Workspace authority is mismatched.');
  }
  const requestId = environmentPackage.scope.requestId;
  if (!requestId) {
    throw transcriptError('recovery_required', 'Artifact import has no accepted request identity.');
  }
  if (!options.recordedAt) {
    throw transcriptError('recovery_required', 'Artifact import has no recorded timestamp.');
  }
  if (!z.iso.datetime().safeParse(options.recordedAt).success) {
    throw transcriptError('invalid_request', 'Artifact import timestamp is invalid.');
  }
  const sourceTurn = store
    .listThreadTurns(environmentPackage.scope.workspaceId, environmentPackage.scope.threadId)
    .find((turn) => turn.id === environmentPackage.scope.turnId);
  const sourceAgentId = sourceTurn?.agentId ?? null;
  if (
    !sourceTurn ||
    sourceAgentId !== environmentPackage.agent.agentId ||
    sourceTurn.agentSessionId !== environmentPackage.scope.agentSessionId
  ) {
    throw transcriptError('recovery_required', 'The canonical source Turn assignment is invalid.');
  }
  const records = parseTranscriptDeclarations(payload);
  const files = new Map<number, Buffer>();
  for (const file of payload.artifactFiles ?? []) {
    if (!Buffer.isBuffer(file.bytes) || file.bytes.length === 0 || files.has(file.sequence)) {
      throw transcriptError('invalid_request', 'Artifact payload bytes are invalid or duplicated.');
    }
    files.set(file.sequence, file.bytes);
  }
  if (files.size !== records.length || records.some((record) => !files.has(record.sequence))) {
    throw transcriptError('invalid_request', 'Artifact declarations and payload bytes disagree.');
  }

  const prepared = records.map((record) => {
    if (!matchesPackageLineage(record.lineage, environmentPackage)) {
      throw transcriptError('invalid_request', 'Artifact lineage does not match the accepted AEP.');
    }
    const bytes = files.get(record.sequence) as Buffer;
    let body: string;
    try {
      body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (record.artifact.mediaType === 'application/json') {
        JSON.parse(body);
      }
    } catch {
      throw transcriptError('invalid_request', 'Artifact bytes violate the declared format.');
    }
    const proposal = record.artifact.materialProposal ?? null;
    if (proposal) {
      const trace = options.contextPackageTrace;
      if (!trace || !matchesPackageLineage(trace, environmentPackage)) {
        throw transcriptError(
          'recovery_required',
          'Accepted Context Package trace is unavailable.'
        );
      }
      const selections = trace.materialSelections.filter(
        (selection) =>
          selection.materialId === proposal.materialId &&
          selection.revisionId === proposal.baseRevisionId &&
          selection.contentDigest === proposal.baseContentDigest
      );
      if (
        selections.length !== 1 ||
        record.artifact.mediaType === 'application/json' ||
        selections[0]?.mediaType !== record.artifact.mediaType
      ) {
        throw transcriptError('invalid_request', 'Material proposal is not one trace selection.');
      }
      try {
        const material = getWorkspaceMaterial(workspaceDb, proposal.materialId);
        const base = getWorkspaceMaterialRevision(
          workspaceDb,
          proposal.materialId,
          proposal.baseRevisionId
        );
        if (
          !material.currentRevisionId ||
          base.mediaType !== (material.kind === 'markdown' ? 'text/markdown' : 'text/plain') ||
          base.contentDigest !== proposal.baseContentDigest ||
          base.mediaType !== record.artifact.mediaType
        ) {
          throw new Error('contradictory proposal');
        }
      } catch {
        throw transcriptError('recovery_required', 'Material proposal authority is contradictory.');
      }
    }
    const artifact = ArtifactSchema.safeParse({
      id: `worker-artifact-${environmentPackage.snapshotId}-${record.sequence}`,
      workspaceId: environmentPackage.scope.workspaceId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      kind: record.artifact.kind,
      title: record.artifact.title,
      status: 'ready',
      summary: null,
      version: 1,
      content: {
        format:
          record.artifact.mediaType === 'text/markdown'
            ? 'markdown'
            : record.artifact.mediaType === 'text/plain'
              ? 'text'
              : 'json',
        body,
      },
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      lastMutationRequestId: requestId,
      origin: {
        kind: 'turn-output',
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        requestId,
      },
      createdAt: options.recordedAt,
      updatedAt: options.recordedAt,
    });
    if (!artifact.success) {
      throw transcriptError('invalid_request', 'Canonical Artifact fields are invalid.');
    }
    const reviewInput = {
      artifactId: artifact.data.id,
      artifactVersion: 1,
      contentDigest: artifact.data.contentDigest,
      sourceThreadId: artifact.data.threadId,
      sourceTurnId: artifact.data.turnId,
      sourceAgentId,
      materialProposal: proposal,
      createdAt: artifact.data.createdAt,
    };
    return {
      artifact: artifact.data,
      replay: preflightArtifactTuple(store, workspaceDb, artifact.data, reviewInput),
      reviewInput,
    };
  });
  const replayCount = prepared.filter((candidate) => candidate.replay).length;
  if (replayCount > 0 && replayCount !== prepared.length) {
    throw transcriptError('recovery_required', 'The Artifact declaration set is only partial.');
  }
  return prepared;
}

/** Parses Artifact declarations. @param payload Collected files. @returns Artifacts after channel-local sequence validation. */
function parseTranscriptDeclarations(
  payload: WorkerTranscriptPayload
): Array<z.infer<typeof WorkerTranscriptArtifactRecordSchema>> {
  const diagnostics: WorkerTranscriptDiagnostic[] = [];
  const seen = new Set<number>();
  const artifacts: Array<z.infer<typeof WorkerTranscriptArtifactRecordSchema>> = [];
  for (const record of parseJsonl(payload.artifactsJsonl ?? '', '$.artifacts', diagnostics)) {
    const parsed = WorkerTranscriptArtifactRecordSchema.safeParse(record.value);
    if (!parsed.success || seen.has(parsed.data.sequence)) {
      throw transcriptError('invalid_request', 'Artifact declaration or sequence is invalid.');
    }
    seen.add(parsed.data.sequence);
    artifacts.push(parsed.data);
  }
  if (diagnostics.length > 0) {
    throw transcriptError('invalid_request', 'Transcript declarations contain invalid JSON.');
  }
  return artifacts;
}

/** Classifies owners. @param store Canonical store. @param workspaceDb Review owner. @param artifact Expected Artifact. @param reviewInput Expected immutable Review. @returns Whether this is replay. */
function preflightArtifactTuple(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  artifact: z.infer<typeof ArtifactSchema>,
  reviewInput: Parameters<typeof createArtifactReview>[1]
): boolean {
  const expectedReference = ItemSchema.parse({
    id: artifactReferenceItemId(artifact.id, artifact.turnId as string),
    workspaceId: artifact.workspaceId,
    threadId: artifact.threadId,
    turnId: artifact.turnId,
    type: 'artifact-reference',
    status: 'completed',
    artifactId: artifact.id,
    artifactVersion: 1,
    title: artifact.title,
    summary: null,
    lastMutationRequestId: artifact.lastMutationRequestId,
    createdAt: artifact.createdAt,
    completedAt: artifact.updatedAt,
  });
  const existingArtifact = store
    .listArtifacts(artifact.workspaceId)
    .find((candidate) => candidate.id === artifact.id);
  const references = store
    .listThreadItems(artifact.workspaceId, artifact.threadId as string)
    .filter(
      (candidate) =>
        candidate.type === 'artifact-reference' &&
        (candidate.id === expectedReference.id || candidate.artifactId === artifact.id)
    );
  let existingReview = null;
  try {
    existingReview = getArtifactReview(workspaceDb, artifact.id, 1);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'stale')) {
      throw error;
    }
  }
  if (!existingArtifact && references.length === 0 && !existingReview) {
    return false;
  }
  if (
    !existingArtifact ||
    references.length !== 1 ||
    !existingReview ||
    !isDeepStrictEqual(existingArtifact, artifact) ||
    !isDeepStrictEqual(references[0], expectedReference)
  ) {
    throw transcriptError('recovery_required', 'The deterministic Artifact tuple is incomplete.');
  }
  createArtifactReview(workspaceDb, reviewInput);
  return true;
}

/** Creates a failure. @param code Stable code. @param message Safe detail. @returns Typed failure. */
function transcriptError(
  code: 'invalid_request' | 'recovery_required',
  message: string
): ArtifactAuthorityError {
  return new ArtifactAuthorityError(code, message);
}

/** Parses JSONL. @param jsonl Serialized records. @param pathPrefix Diagnostic path. @param diagnostics Mutable errors. @returns Parsed lines. */
function parseJsonl(
  jsonl: string,
  pathPrefix: string,
  diagnostics: WorkerTranscriptDiagnostic[]
): Array<{ path: string; value: unknown }> {
  const records: Array<{ path: string; value: unknown }> = [];
  const lines = jsonl.split('\n');

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }

    const path = `${pathPrefix}[${index + 1}]`;

    try {
      records.push({ path, value: JSON.parse(line) });
    } catch (error) {
      diagnostics.push({
        code: 'worker_transcript_invalid_json',
        path,
        message: error instanceof Error ? error.message : 'Worker transcript line is invalid JSON.',
      });
    }
  }

  return records;
}

/** Matches lineage. @param record Candidate lineage. @param environmentPackage Expected AEP. @returns Whether every field matches. */
function matchesPackageLineage(
  record: WorkerLineage,
  environmentPackage: AgentEnvironmentPackage
): boolean {
  return (
    record.workspaceId === environmentPackage.scope.workspaceId &&
    record.threadId === environmentPackage.scope.threadId &&
    record.turnId === environmentPackage.scope.turnId &&
    record.agentSessionId === environmentPackage.scope.agentSessionId &&
    record.packageSnapshotId === environmentPackage.snapshotId &&
    (record.requestId ?? null) === (environmentPackage.scope.requestId ?? null)
  );
}

/** Extracts text. @param item Worker Item. @returns Assistant text. */
function itemText(item: z.infer<typeof WorkerTranscriptItemRecordSchema>['item']): string {
  if (typeof item.text === 'string') {
    return item.text;
  }

  return item.parts?.map((part) => part.text).join('') ?? '';
}

/** Indexes events. @param records Accepted events. @returns Fingerprints by sequence. */
function indexAcceptedLiveEvents(records: WorkerCanonicalEventRecord[]): Map<number, string> {
  return new Map(records.map((record) => [record.sequence, stableJson(record)]));
}

/** Serializes stable JSON. @param value JSON value. @returns Stable string. */
function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

/** Sorts keys. @param value JSON value. @returns Recursively sorted value. */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJsonValue(entryValue)])
    );
  }

  return value;
}
