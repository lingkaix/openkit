import { createHash, randomUUID } from 'node:crypto';
import {
  type CreateEvidenceBundleRequest,
  type EvidenceBundleRecord,
  EvidenceBundleRecordSchema,
  type EvidenceBundleRef,
} from '@openkit/app-api-schemas';

import type { WorkspaceDb } from './storage/db.js';

/** Input for creating one workspace-owned evidence bundle. */
export interface CreateWorkspaceEvidenceBundleInput {
  /** Workspace-scoped database handle. */
  workspaceDb: WorkspaceDb;
  /** Workspace that owns the bundle. */
  workspaceId: string;
  /** Product-level request fields. */
  request: CreateEvidenceBundleRequest;
  /** Product-safe references to include. */
  redactedEvidenceRefs: readonly EvidenceBundleRef[];
  /** Stable evidence bundle id for deterministic tests. */
  evidenceBundleId?: string;
  /** Storage creation time. */
  now?: Date;
}

interface EvidenceBundleRow {
  readonly evidence_bundle_id: string;
  readonly workspace_id: string;
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

const knownImportedEvidenceRefKinds = new Set([
  'artifact',
  'goal',
  'thread',
  'turn',
  'worker',
  'workspace',
  'workspace-apply-result',
  'workspace-change-set',
  'workspace-review',
  'workspace-sync-patch',
]);

const ImportedEvidenceBundleRecordSchema = EvidenceBundleRecordSchema.strip();

/** Input for compacting expired workspace evidence bundle refs. */
export interface CompactWorkspaceEvidenceBundlesInput {
  /** Workspace database that owns the evidence bundle rows. */
  workspaceDb: WorkspaceDb;
  /** Workspace id whose evidence bundles should be compacted. */
  workspaceId: string;
  /** Exclusive creation timestamp cutoff for expiring ephemeral diagnostics. */
  olderThan: string;
}

/** Result of one evidence bundle compaction pass. */
export interface CompactWorkspaceEvidenceBundlesResult {
  /** Number of evidence bundle rows moved to the expired state. */
  expiredCount: number;
}

/**
 * Creates one compact workspace-owned evidence bundle index.
 *
 * @param input Workspace database, request lineage, and product-safe refs.
 * @returns Stored evidence bundle read model.
 */
export function createWorkspaceEvidenceBundle(
  input: CreateWorkspaceEvidenceBundleInput
): EvidenceBundleRecord {
  const createdAt = (input.now ?? new Date()).toISOString();
  const redactedEvidenceRefs = [...input.redactedEvidenceRefs];
  const record = EvidenceBundleRecordSchema.parse({
    id: input.evidenceBundleId ?? `evb_${randomUUID()}`,
    workspaceId: input.workspaceId,
    threadId: input.request.threadId ?? null,
    goalId: input.request.goalId ?? null,
    turnId: input.request.turnId ?? null,
    agentSessionId: null,
    backendType: null,
    sourceKind: 'manual',
    summary: summarizeEvidenceBundle(input.workspaceId, input.request),
    rawEvidenceRefs: [],
    redactedEvidenceRefs,
    contentDigests: [digestEvidenceRefs(input.workspaceId, input.request, redactedEvidenceRefs)],
    retentionClass: input.request.turnId ? 'turn-evidence' : 'workspace-audit',
    sensitivityClass: 'product-safe',
    importStatus: 'collected',
    requiredFeatures: ['evidence.bundle.v1'],
    createdAt,
  });

  insertEvidenceBundle(input.workspaceDb, record);

  return record;
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
  insertEvidenceBundle(workspaceDb, parsed);

  return parsed;
}

/**
 * Imports workspace-owned evidence bundles into a workspace database.
 *
 * @param workspaceDb Workspace database that owns the imported records.
 * @param records Evidence bundle records with the target workspace id.
 */
export function importWorkspaceEvidenceBundles(
  workspaceDb: WorkspaceDb,
  records: readonly EvidenceBundleRecord[]
): void {
  for (const record of records) {
    insertEvidenceBundle(workspaceDb, quarantineUnknownEvidenceKinds(record));
  }
}

/**
 * Expires old ephemeral diagnostic evidence refs without deleting governed rows.
 *
 * @param input Workspace database, owner workspace id, and exclusive cutoff timestamp.
 * @returns Number of compacted evidence bundle rows.
 */
export function compactWorkspaceEvidenceBundles(
  input: CompactWorkspaceEvidenceBundlesInput
): CompactWorkspaceEvidenceBundlesResult {
  const result = input.workspaceDb.sqlite
    .prepare(
      `UPDATE evidence_bundles
      SET
        raw_evidence_refs_json = ?,
        redacted_evidence_refs_json = ?,
        import_status = 'expired'
      WHERE workspace_id = ?
        AND retention_class = 'ephemeral-diagnostic'
        AND import_status != 'expired'
        AND created_at < ?`
    )
    .run(JSON.stringify([]), JSON.stringify([]), input.workspaceId, input.olderThan);

  return { expiredCount: result.changes };
}

function insertEvidenceBundle(workspaceDb: WorkspaceDb, record: EvidenceBundleRecord): void {
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO evidence_bundles (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.workspaceId,
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
}

function quarantineUnknownEvidenceKinds(record: unknown): EvidenceBundleRecord {
  const parsed = ImportedEvidenceBundleRecordSchema.parse(record);
  const refs = [...parsed.rawEvidenceRefs, ...parsed.redactedEvidenceRefs];

  if (refs.every((ref) => isKnownImportedEvidenceRefKind(ref.kind))) {
    return parsed;
  }

  return EvidenceBundleRecordSchema.parse({ ...parsed, importStatus: 'quarantined' });
}

function isKnownImportedEvidenceRefKind(kind: string): boolean {
  return (
    knownImportedEvidenceRefKinds.has(kind) ||
    kind.startsWith('backend.') ||
    kind.startsWith('sandbox.')
  );
}

/**
 * Lists workspace-owned evidence bundle indexes in durable order.
 *
 * @param workspaceDb Workspace database that owns the bundles.
 * @param workspaceId Workspace id to list.
 * @returns Evidence bundle read models.
 */
export function listWorkspaceEvidenceBundles(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): EvidenceBundleRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT
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
        WHERE workspace_id = ?
        ORDER BY created_at, evidence_bundle_id`
      )
      .all(workspaceId) as EvidenceBundleRow[]
  ).map(evidenceBundleFromRow);
}

function digestEvidenceRefs(
  workspaceId: string,
  request: CreateEvidenceBundleRequest,
  refs: readonly EvidenceBundleRef[]
): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ refs, request, workspaceId }))
    .digest('hex')}`;
}

function evidenceBundleFromRow(row: EvidenceBundleRow): EvidenceBundleRecord {
  return EvidenceBundleRecordSchema.parse({
    id: row.evidence_bundle_id,
    workspaceId: row.workspace_id,
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

function summarizeEvidenceBundle(
  workspaceId: string,
  request: CreateEvidenceBundleRequest
): string {
  if (request.turnId) {
    return `Evidence bundle for turn ${request.turnId} in workspace ${workspaceId}.`;
  }

  if (request.threadId) {
    return `Evidence bundle for thread ${request.threadId} in workspace ${workspaceId}.`;
  }

  return `Evidence bundle for workspace ${workspaceId}.`;
}
