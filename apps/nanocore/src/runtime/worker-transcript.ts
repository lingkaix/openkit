import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import {
  type WorkerCanonicalEventRecord,
  type WorkerLineage,
  WorkerTranscriptArtifactRecordSchema,
  WorkerTranscriptEventRecordSchema,
  WorkerTranscriptItemRecordSchema,
} from '@openkit/worker-protocol';
import type { z } from 'zod';
import type { FsStore } from '../lib/store.js';

/**
 * Worker transcript import payload collected at turn end.
 */
export interface WorkerTranscriptPayload {
  /** Serialized `/openkit/session/events.jsonl` content. */
  eventsJsonl?: string;
  /** Serialized `/openkit/session/items.jsonl` content. */
  itemsJsonl?: string;
  /** Serialized `/openkit/session/artifacts.jsonl` content. */
  artifactsJsonl?: string;
  /** Backend-local restricted runtime provenance files, when the AEP requested collection. */
  runtimeProvenance?: WorkerRuntimeProvenanceCollection;
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

/**
 * Options that influence transcript import behavior.
 */
export interface WorkerTranscriptImportOptions {
  /** Live canonical event records already accepted through worker-control append. */
  acceptedLiveEvents?: WorkerCanonicalEventRecord[];
}

/**
 * Diagnostic produced while parsing or importing worker transcript files.
 */
export interface WorkerTranscriptDiagnostic {
  /** Stable diagnostic code. */
  code: string;
  /** JSON path or JSONL location. */
  path: string;
  /** Human-readable diagnostic message. */
  message: string;
}

/**
 * Result of importing one worker transcript payload.
 */
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

/**
 * Imports validated worker transcript candidates into canonical NanoCore records.
 *
 * @param store Store that owns the target workspace and thread.
 * @param environmentPackage Package that defines the expected transcript lineage.
 * @param payload Transcript file contents collected at turn end.
 * @returns Import result with canonical IDs and diagnostics.
 */
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
  importItemRecords(store, environmentPackage, payload.itemsJsonl ?? '', result);
  importArtifactRecords(store, environmentPackage, payload.artifactsJsonl ?? '', result);

  return result;
}

/**
 * Reconciles canonical transcript events against durable live acceptance.
 *
 * @param environmentPackage Expected package lineage.
 * @param jsonl Serialized event JSONL.
 * @param acceptedLiveEvents Stable fingerprints of live-accepted events keyed by sequence.
 * @param result Mutable import result.
 */
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

/**
 * Imports assistant-message item candidates from JSONL.
 *
 * @param store Store that owns canonical records.
 * @param environmentPackage Expected package lineage.
 * @param jsonl Serialized item JSONL.
 * @param result Mutable import result.
 */
function importItemRecords(
  store: FsStore,
  environmentPackage: AgentEnvironmentPackage,
  jsonl: string,
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

    const timestamp = new Date().toISOString();
    const item = store.createItem({
      id: `it_worker_${environmentPackage.scope.turnId}_${parsed.data.sequence}`,
      workspaceId: environmentPackage.scope.workspaceId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      type: 'assistant-message',
      status: parsed.data.item.status === 'failed' ? 'failed' : parsed.data.item.status,
      text: itemText(parsed.data.item),
      createdAt: timestamp,
      completedAt: parsed.data.item.status === 'completed' ? timestamp : null,
    });

    result.itemIds.push(item.id);
  }
}

/**
 * Imports artifact candidates from JSONL.
 *
 * @param store Store that owns canonical records.
 * @param environmentPackage Expected package lineage.
 * @param jsonl Serialized artifact JSONL.
 * @param result Mutable import result.
 */
function importArtifactRecords(
  store: FsStore,
  environmentPackage: AgentEnvironmentPackage,
  jsonl: string,
  result: WorkerTranscriptImportResult
): void {
  for (const record of parseJsonl(jsonl, '$.artifacts', result.diagnostics)) {
    const parsed = WorkerTranscriptArtifactRecordSchema.safeParse(record.value);

    if (!parsed.success) {
      result.diagnostics.push({
        code: 'worker_transcript_invalid_artifact',
        path: record.path,
        message: parsed.error.issues[0]?.message ?? 'Worker transcript artifact is invalid.',
      });
      continue;
    }

    if (!matchesPackageLineage(parsed.data.lineage, environmentPackage)) {
      result.diagnostics.push({
        code: 'worker_transcript_lineage_mismatch',
        path: record.path,
        message: 'Worker transcript artifact lineage does not match the package scope.',
      });
      continue;
    }

    const timestamp = new Date().toISOString();
    const artifact = store.createArtifact({
      id: `ar_worker_${environmentPackage.scope.turnId}_${parsed.data.sequence}`,
      workspaceId: environmentPackage.scope.workspaceId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      kind: parsed.data.artifact.kind,
      title: parsed.data.artifact.title,
      status: 'ready',
      summary: `Worker artifact candidate at ${parsed.data.artifact.path}.`,
      version: 1,
      content: {
        format: artifactContentFormat(parsed.data.artifact.mediaType ?? null),
        body: `Worker artifact candidate path: ${parsed.data.artifact.path}`,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    result.artifactIds.push(artifact.id);
  }
}

/**
 * Parses JSONL records and reports malformed lines as diagnostics.
 *
 * @param jsonl Serialized JSONL.
 * @param pathPrefix Diagnostic path prefix.
 * @param diagnostics Mutable diagnostic collection.
 * @returns Parsed line records.
 */
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

/**
 * Verifies worker transcript lineage against the expected package scope.
 *
 * @param record Parsed worker transcript record.
 * @param environmentPackage Expected package.
 * @returns True when the record belongs to the package and turn.
 */
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

/**
 * Extracts assistant text from a worker transcript item candidate.
 *
 * @param item Worker item candidate payload.
 * @returns Assistant message text.
 */
function itemText(item: z.infer<typeof WorkerTranscriptItemRecordSchema>['item']): string {
  if (typeof item.text === 'string') {
    return item.text;
  }

  return item.parts?.map((part) => part.text).join('') ?? '';
}

/**
 * Maps artifact media types to OpenKit inline content formats.
 *
 * @param mediaType Worker-provided media type.
 * @returns Artifact content format.
 */
function artifactContentFormat(mediaType: string | null): 'markdown' | 'text' | 'json' {
  if (mediaType === 'text/markdown') {
    return 'markdown';
  }

  if (mediaType === 'application/json') {
    return 'json';
  }

  return 'text';
}

/**
 * Builds a sequence index for live-accepted canonical events.
 *
 * @param records Live-accepted event records.
 * @returns Stable event fingerprints keyed by sequence.
 */
function indexAcceptedLiveEvents(records: WorkerCanonicalEventRecord[]): Map<number, string> {
  return new Map(records.map((record) => [record.sequence, stableJson(record)]));
}

/**
 * Serializes JSON-compatible data with stable object key ordering.
 *
 * @param value JSON-compatible value.
 * @returns Stable JSON string.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

/**
 * Sorts object keys recursively for semantic retry comparison.
 *
 * @param value JSON-compatible value.
 * @returns Value with object keys sorted recursively.
 */
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
