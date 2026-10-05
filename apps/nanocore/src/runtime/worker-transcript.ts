import { createHash } from 'node:crypto';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { ArtifactSchema, ItemSchema } from '@openkit/protocol';
import {
  type WorkerCanonicalEventRecord,
  type WorkerLineage,
  WorkerTranscriptEventRecordSchema,
  WorkerTranscriptItemRecordSchema,
} from '@openkit/worker-protocol';
import type { z } from 'zod';
import { createArtifactReview, getArtifactReview } from '../artifact-reviews.js';
import type { WorkerContextPackageTrace } from '../context/worker-context-package.js';
import {
  ALREADY_DECIDED_PUBLICATION_ADMISSION,
  ArtifactAuthorityError,
  type FsStore,
} from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import { artifactReferenceItemId } from '../storage/workspace-file-records.js';
import { getWorkspaceMaterial, getWorkspaceMaterialRevision } from '../workspace-materials.js';
import {
  type CredentialCheckValues,
  findWorkerCredentialMatches,
  type LocalSimulatorCredentialCheckValues,
  requireLocalSimulatorCredentialCheckValues,
  requireWorkerCredentialCheckValues,
  type WorkerCredentialCheckValues,
} from './worker-credential-guard.js';

/** Worker transcript import payload collected at turn end. */
export interface WorkerTranscriptPayload {
  /** Complete backend-private original-materialization evidence, outside worker JSONL. */
  credentialCheckValues?: WorkerCredentialCheckValues | null;
  /** Serialized `/openkit/session/events.jsonl` content. */
  eventsJsonl?: string;
  /** Serialized `/openkit/session/items.jsonl` content. */
  itemsJsonl?: string;
  /** Backend-local restricted runtime provenance files, when the AEP requested collection. */
  runtimeProvenance?: WorkerRuntimeProvenanceCollection;
}

/** Local simulator candidates with explicit private proof of its credential-free execution path. */
export type LocalSimulatorTranscriptPayload = Omit<
  WorkerTranscriptPayload,
  'credentialCheckValues'
> & {
  /** Evidence from the local simulator constructor, excluded from Worker collection's type. */
  credentialCheckValues: LocalSimulatorCredentialCheckValues;
};

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
  /** Stable server-written timestamp used by restart closeout exact replay. */
  recordedAt?: string;
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
  return importTranscript(store, environmentPackage, payload, options, () =>
    requireWorkerCredentialCheckValues(payload.credentialCheckValues)
  );
}

/** Imports local simulator candidates through the canonical admission path. @param store Canonical store. @param environmentPackage Accepted AEP. @param payload Local candidates and explicit no-injection proof. @param options Accepted proof. @returns IDs and diagnostics. */
export function importLocalSimulatorTranscript(
  store: FsStore,
  environmentPackage: AgentEnvironmentPackage,
  payload: LocalSimulatorTranscriptPayload,
  options: WorkerTranscriptImportOptions = {}
): WorkerTranscriptImportResult {
  return importTranscript(store, environmentPackage, payload, options, () =>
    requireLocalSimulatorCredentialCheckValues(payload.credentialCheckValues)
  );
}

/** Shares canonical admission while keeping each execution owner's evidence validation separate. @param store Canonical store. @param environmentPackage Accepted AEP. @param payload Candidates. @param options Accepted proof. @param requireEvidence Execution-specific validator. @returns IDs and diagnostics. */
function importTranscript(
  store: FsStore,
  environmentPackage: AgentEnvironmentPackage,
  payload: Omit<WorkerTranscriptPayload, 'credentialCheckValues'>,
  options: WorkerTranscriptImportOptions,
  requireEvidence: () => CredentialCheckValues
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
  const checkValues = payload.itemsJsonl?.trim() ? requireEvidence() : null;
  importItemRecords(
    store,
    environmentPackage,
    payload.itemsJsonl ?? '',
    options.recordedAt,
    result,
    checkValues
  );

  return result;
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
        message: 'Worker transcript event is invalid.',
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

/** Imports assistant Items. @param store Canonical store. @param environmentPackage Expected AEP. @param jsonl Item JSONL. @param recordedAt Stable time. @param result Mutable result. @param checkValues Original credential evidence. */
function importItemRecords(
  store: FsStore,
  environmentPackage: AgentEnvironmentPackage,
  jsonl: string,
  recordedAt: string | undefined,
  result: WorkerTranscriptImportResult,
  checkValues: CredentialCheckValues | null
): void {
  for (const record of parseJsonl(jsonl, '$.items', result.diagnostics)) {
    const parsed = WorkerTranscriptItemRecordSchema.safeParse(record.value);

    if (!parsed.success) {
      result.diagnostics.push({
        code: 'worker_transcript_invalid_item',
        path: record.path,
        message: 'Worker transcript item is invalid.',
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
      text: redactWorkerText(itemText(parsed.data.item), checkValues),
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
      store.createItem(item, ALREADY_DECIDED_PUBLICATION_ADMISSION);
    }

    result.itemIds.push(item.id);
  }
}

/** Prepares one verified synchronous file using the existing Artifact, Material and credential rules. @param input Trusted scope, accepted metadata and captured bytes. @returns Canonical Artifact and immutable Review input, without writes. */
export function prepareWorkerArtifact(input: {
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly environmentPackage: AgentEnvironmentPackage;
  readonly artifactId: string;
  readonly requestId: string;
  readonly recordedAt: string;
  readonly metadata: {
    kind: 'report' | 'diff' | 'file' | 'summary';
    title: string;
    mediaType: 'text/markdown' | 'text/plain' | 'application/json';
    materialProposal?:
      | { materialId: string; baseRevisionId: string; baseContentDigest: string }
      | undefined;
  };
  readonly bytes: Buffer;
  readonly checkValues: CredentialCheckValues;
  readonly contextPackageTrace?: WorkerContextPackageTrace;
}) {
  const {
    store,
    workspaceDb,
    environmentPackage,
    artifactId,
    requestId,
    recordedAt,
    metadata,
    bytes,
    checkValues,
    contextPackageTrace,
  } = input;
  if (workspaceDb.workspaceId !== environmentPackage.scope.workspaceId)
    throw transcriptError('recovery_required', 'Artifact Workspace authority is mismatched.');
  if (bytes.length === 0) throw transcriptError('invalid_request', 'Artifact bytes are empty.');
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
  // The model-selected key is persisted verbatim in origin and receipt; redaction would change replay identity.
  if (
    findWorkerCredentialMatches(bytes, checkValues).length > 0 ||
    findWorkerCredentialMatches(Buffer.from(requestId, 'utf8'), checkValues).length > 0
  ) {
    throw transcriptError(
      'invalid_request',
      'Worker Artifact content or request identity contains injected credential material.'
    );
  }
  let body: string;
  try {
    body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (metadata.mediaType === 'application/json') {
      JSON.parse(body);
    }
  } catch {
    throw transcriptError('invalid_request', 'Artifact bytes violate the declared format.');
  }
  const proposal = metadata.materialProposal ?? null;
  if (proposal) {
    const trace = contextPackageTrace;
    if (!trace || !matchesPackageLineage(trace, environmentPackage)) {
      throw transcriptError('recovery_required', 'Accepted Context Package trace is unavailable.');
    }
    const selections = trace.materialSelections.filter(
      (selection) =>
        selection.materialId === proposal.materialId &&
        selection.revisionId === proposal.baseRevisionId &&
        selection.contentDigest === proposal.baseContentDigest
    );
    if (
      selections.length !== 1 ||
      metadata.mediaType === 'application/json' ||
      selections[0]?.mediaType !== metadata.mediaType
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
        base.mediaType !== metadata.mediaType
      ) {
        throw new Error('contradictory proposal');
      }
    } catch {
      throw transcriptError('recovery_required', 'Material proposal authority is contradictory.');
    }
  }
  const artifact = ArtifactSchema.safeParse({
    id: artifactId,
    workspaceId: environmentPackage.scope.workspaceId,
    threadId: environmentPackage.scope.threadId,
    turnId: environmentPackage.scope.turnId,
    kind: metadata.kind,
    title: redactWorkerText(metadata.title, checkValues),
    status: 'ready',
    summary: null,
    version: 1,
    content: {
      format:
        metadata.mediaType === 'text/markdown'
          ? 'markdown'
          : metadata.mediaType === 'text/plain'
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
    createdAt: recordedAt,
    updatedAt: recordedAt,
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
  return { artifact: artifact.data, reviewInput };
}

/** Classifies owners. @param store Canonical store. @param workspaceDb Review owner. @param artifact Expected Artifact. @param reviewInput Expected immutable Review. @returns Whether this is replay. */
export function preflightArtifactTuple(
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
    } catch {
      // Native parser errors can quote secret-bearing candidate bytes.
      diagnostics.push({
        code: 'worker_transcript_invalid_json',
        path,
        message: 'Worker transcript line is invalid JSON.',
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

/** Replaces exact credential ranges before canonical creation or replay. @param text Candidate text. @param evidence Original private comparison evidence. @returns Guarded text. */
function redactWorkerText(text: string, evidence: CredentialCheckValues | null): string {
  const bytes = Buffer.from(text, 'utf8');
  const matches = findWorkerCredentialMatches(bytes, evidence!);
  if (matches.length === 0) return text;
  const parts: Buffer[] = [];
  let offset = 0;
  for (const match of matches) {
    parts.push(bytes.subarray(offset, match.start), Buffer.from('[redacted]'));
    offset = match.end;
  }
  parts.push(bytes.subarray(offset));
  return Buffer.concat(parts).toString('utf8');
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
