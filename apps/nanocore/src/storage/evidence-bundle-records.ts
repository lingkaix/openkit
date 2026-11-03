import {
  type EvidenceBundleRecord,
  EvidenceBundleRecordSchema,
  type ServerEvidenceBundleRecord,
  ServerEvidenceBundleRecordSchema,
} from '@openkit/app-api-schemas';
import { readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import type { CoreDb, WorkspaceDb } from './db.js';
import { assertSafeWorkspacePathSegment } from './workspace-path-segment.js';

/** Exact existing SQL projection shared by retained EvidenceBundle readers. */
export interface EvidenceBundleRow {
  readonly schema_version: number;
  readonly evidence_bundle_id: string;
  readonly workspace_id: string | null;
  readonly thread_id: string | null;
  readonly goal_id: string | null;
  readonly turn_id: string | null;
  readonly agent_session_id: string | null;
  readonly backend_type: string | null;
  readonly source_kind: string;
  readonly summary: string;
  readonly raw_evidence_refs_json: string;
  readonly redacted_evidence_refs_json: string;
  readonly content_digests_json: string;
  readonly retention_class: EvidenceBundleRecord['retentionClass'];
  readonly sensitivity_class: EvidenceBundleRecord['sensitivityClass'];
  readonly import_status: EvidenceBundleRecord['importStatus'];
  readonly required_features_json: string;
  readonly created_at: string;
}

/**
 * Records one pre-normalized workspace evidence bundle.
 *
 * @param workspaceDb Workspace database that owns the bundle.
 * @param record Product-safe evidence bundle record.
 * @returns Stored evidence bundle read model.
 */
export function recordWorkspaceEvidenceBundle(
  workspaceDb: WorkspaceDb,
  record: EvidenceBundleRecord
): EvidenceBundleRecord {
  const parsed = EvidenceBundleRecordSchema.parse(record);
  return insertEvidenceBundle(workspaceDb, parsed);
}

/** Keeps bundle-owned directories separate from the shared immutable content namespace. */
export function assertEvidenceBundleDirectoryId(id: string): void {
  assertSafeWorkspacePathSegment(id, 'Evidence bundle id');
  if (id === 'sha256') {
    throw new Error('Reserved evidence bundle id: sha256.');
  }
}

/** Stores one exact known EvidenceBundle without changing original replay or scope semantics. */
export function insertEvidenceBundle<T extends EvidenceBundleRecord | ServerEvidenceBundleRecord>(
  workspaceDb: WorkspaceDb | CoreDb,
  record: T
): T {
  assertEvidenceBundleDirectoryId(record.id);
  const existingRow = workspaceDb.sqlite
    .prepare(
      `SELECT
        schema_version,
        evidence_bundle_id,
        workspace_id,
        thread_id,
        goal_id,
        turn_id,
        agent_session_id,
        backend_type,
        source_kind,
        summary,
        raw_evidence_refs_json,
        redacted_evidence_refs_json,
        content_digests_json,
        retention_class,
        sensitivity_class,
        import_status,
        required_features_json,
        created_at
      FROM evidence_bundles
      WHERE evidence_bundle_id = ?`
    )
    .get(record.id) as EvidenceBundleRow | undefined;
  if (existingRow) {
    const existing = evidenceBundleFromRow(existingRow, workspaceDb.scope === 'core') as T;
    if (JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error(`Evidence bundle replay conflict: ${record.id}`);
    }
    return existing;
  }
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO evidence_bundles (
        schema_version,
        evidence_bundle_id,
        workspace_id,
        thread_id,
        goal_id,
        turn_id,
        agent_session_id,
        backend_type,
        source_kind,
        summary,
        raw_evidence_refs_json,
        redacted_evidence_refs_json,
        content_digests_json,
        retention_class,
        sensitivity_class,
        import_status,
        required_features_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      writeRetainedV1(record).schemaVersion,
      record.id,
      record.workspaceId ?? null,
      record.threadId,
      record.goalId,
      record.turnId,
      record.agentSessionId,
      record.backendType,
      record.sourceKind,
      record.summary,
      JSON.stringify(record.rawEvidenceRefs),
      JSON.stringify(record.redactedEvidenceRefs),
      JSON.stringify(record.contentDigests),
      record.retentionClass,
      record.sensitivityClass,
      record.importStatus,
      JSON.stringify(record.requiredFeatures),
      record.createdAt
    );

  return record;
}

/** Decodes the original retained EvidenceBundle format for its existing scope. */
export function evidenceBundleFromRow(row: EvidenceBundleRow): EvidenceBundleRecord;
export function evidenceBundleFromRow(
  row: EvidenceBundleRow,
  server: boolean
): EvidenceBundleRecord | ServerEvidenceBundleRecord;
export function evidenceBundleFromRow(
  row: EvidenceBundleRow,
  server = false
): EvidenceBundleRecord | ServerEvidenceBundleRecord {
  readRetainedV1({ schemaVersion: row.schema_version }, () => undefined);
  return (server ? ServerEvidenceBundleRecordSchema : EvidenceBundleRecordSchema).parse({
    id: row.evidence_bundle_id,
    ...(server ? { owner: { kind: 'server' } } : { workspaceId: row.workspace_id }),
    threadId: row.thread_id,
    goalId: row.goal_id,
    turnId: row.turn_id,
    agentSessionId: row.agent_session_id,
    backendType: row.backend_type,
    sourceKind: row.source_kind,
    summary: row.summary,
    rawEvidenceRefs: JSON.parse(row.raw_evidence_refs_json) as unknown,
    redactedEvidenceRefs: JSON.parse(row.redacted_evidence_refs_json) as unknown,
    contentDigests: JSON.parse(row.content_digests_json) as unknown,
    retentionClass: row.retention_class,
    sensitivityClass: row.sensitivity_class,
    importStatus: row.import_status,
    requiredFeatures: JSON.parse(row.required_features_json) as unknown,
    createdAt: row.created_at,
  });
}
