import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { type EvidenceBundleRecord, EvidenceBundleRecordSchema } from '@openkit/app-api-schemas';

import type { WorkspaceDb } from './storage/db.js';
import {
  assertCanonicalDirectory,
  assertSafeWorkspacePathSegment,
  ensureCanonicalDirectory,
  readCanonicalFile,
  readCanonicalTextFile,
  writeFileAtomic,
} from './storage/workspace-file-records.js';

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
  'agent-session',
  'goal',
  'item',
  'thread',
  'turn',
  'worker',
  'workspace',
  'workspace-apply-result',
  'workspace-change-set',
  'workspace-review',
  'workspace-sync-patch',
  'worker-runtime-provenance-index',
  'worker-runtime-provenance-manifest',
  'worker-runtime-provenance-native-index',
  'worker-runtime-provenance-stream',
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
 * @throws Error when the requested Workspace does not match the open database lineage.
 */
export function compactWorkspaceEvidenceBundles(
  input: CompactWorkspaceEvidenceBundlesInput
): CompactWorkspaceEvidenceBundlesResult {
  if (input.workspaceId !== input.workspaceDb.workspaceId) {
    throw new Error('Evidence bundle compaction has different Workspace lineage.');
  }
  const restrictedRows = input.workspaceDb.sqlite
    .prepare(
      `SELECT evidence_bundle_id
      FROM evidence_bundles
      WHERE workspace_id = ?
        AND retention_class = 'restricted-raw'
        AND source_kind IN ('worker-runtime-provenance-raw', 'work-observation-body')
        AND created_at < ?`
    )
    .all(input.workspaceId, input.olderThan) as Array<{ evidence_bundle_id: string }>;
  for (const row of restrictedRows) {
    assertSafeWorkspacePathSegment(row.evidence_bundle_id, 'Evidence bundle id');
    rmSync(
      join(
        input.workspaceDb.dataRoot,
        'workspaces',
        input.workspaceId,
        'evidence',
        'backend',
        row.evidence_bundle_id
      ),
      { force: true, recursive: true }
    );
  }
  const result = input.workspaceDb.sqlite
    .prepare(
      `UPDATE evidence_bundles
      SET
        raw_evidence_refs_json = ?,
        redacted_evidence_refs_json = ?,
        import_status = 'expired'
      WHERE workspace_id = ?
        AND (
          retention_class = 'ephemeral-diagnostic'
          OR (
            retention_class = 'restricted-raw'
            AND source_kind IN ('worker-runtime-provenance-raw', 'work-observation-body')
          )
        )
        AND import_status != 'expired'
        AND created_at < ?`
    )
    .run(JSON.stringify([]), JSON.stringify([]), input.workspaceId, input.olderThan);

  return { expiredCount: result.changes };
}

function insertEvidenceBundle(
  workspaceDb: WorkspaceDb,
  record: EvidenceBundleRecord
): EvidenceBundleRecord {
  const existingRow = workspaceDb.sqlite
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
      WHERE evidence_bundle_id = ?`
    )
    .get(record.id) as EvidenceBundleRow | undefined;
  if (existingRow) {
    const existing = evidenceBundleFromRow(existingRow);
    if (JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error(`Evidence bundle replay conflict: ${record.id}`);
    }
    return existing;
  }
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

  return record;
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
  // Observation bodies are accessed only through the owning Thread projection, never this Workspace-wide listing.
  return listStoredWorkspaceEvidenceBundles(workspaceDb, workspaceId)
    .filter((record) => record.sourceKind !== 'work-observation-body')
    .map(projectEvidenceBundleForProduct);
}

/** Lists complete stored Workspace evidence manifests without product redaction. */
export function listStoredWorkspaceEvidenceBundles(
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

function projectEvidenceBundleForProduct(record: EvidenceBundleRecord): EvidenceBundleRecord {
  return record.sourceKind === 'worker-runtime-provenance-raw'
    ? EvidenceBundleRecordSchema.parse({ ...record, rawEvidenceRefs: [] })
    : record;
}

/** Deterministic evidence identity scoped to one observation body, never a native identifier. */
export function workObservationBodyBundleId(
  workspaceId: string,
  threadId: string,
  turnId: string,
  observationId: string,
  bodyId: string
): string {
  return `evb_work_${createHash('sha256')
    .update(JSON.stringify([workspaceId, threadId, turnId, observationId, bodyId]))
    .digest('hex')}`;
}

/** Exact immutable identity shared by restricted staging and final body adoption. */
export interface WorkObservationEvidenceInput {
  readonly bundleId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly createdAt: string;
  readonly sha256: string;
}

/** Checks existing evidence identity and prevents source expiry from being undone by replay. */
function workBodyRecord(
  workspaceDb: WorkspaceDb,
  input: WorkObservationEvidenceInput
): EvidenceBundleRecord | undefined {
  const row = workspaceDb.sqlite
    .prepare('SELECT * FROM evidence_bundles WHERE evidence_bundle_id = ?')
    .get(input.bundleId) as EvidenceBundleRow | undefined;
  if (!row) return undefined;
  const record = evidenceBundleFromRow(row);
  if (
    record.workspaceId !== workspaceDb.workspaceId ||
    record.threadId !== input.threadId ||
    record.turnId !== input.turnId ||
    record.sourceKind !== 'work-observation-body' ||
    record.createdAt !== input.createdAt ||
    record.contentDigests.length !== 1 ||
    record.contentDigests[0] !== input.sha256
  )
    throw new Error('recovery_required: observation evidence identity conflict');
  return record;
}

/** Resolves the restricted owner path without following directory links. */
function workBodyRoot(workspaceDb: WorkspaceDb, bundleId: string, create: boolean): string {
  assertSafeWorkspacePathSegment(bundleId, 'Observation evidence bundle');
  assertSafeWorkspacePathSegment(workspaceDb.workspaceId, 'Observation Workspace');
  let path = workspaceDb.dataRoot;
  for (const part of [
    'workspaces',
    workspaceDb.workspaceId,
    'evidence',
    'backend',
    bundleId,
    'raw',
  ]) {
    path = join(path, part);
    if (create) ensureCanonicalDirectory(path);
    else assertCanonicalDirectory(path);
  }
  return path;
}

/** Publishes only evidence metadata after its file bytes have reached their durability boundary. */
function recordWorkBody(
  workspaceDb: WorkspaceDb,
  input: WorkObservationEvidenceInput,
  promoted: boolean
): void {
  if (
    workspaceDb.sqlite.inTransaction ||
    Number(workspaceDb.sqlite.pragma('synchronous', { simple: true })) < 2
  )
    throw new Error('Observation evidence requires a durable independent Workspace commit');
  const existing = workBodyRecord(workspaceDb, input);
  if (existing) {
    if (existing.importStatus === 'expired') throw new Error('Observation evidence is expired');
    if (promoted && existing.importStatus !== 'promoted')
      workspaceDb.sqlite
        .prepare(
          "UPDATE evidence_bundles SET import_status = 'promoted' WHERE evidence_bundle_id = ?"
        )
        .run(input.bundleId);
    return;
  }
  recordWorkspaceEvidenceBundle(workspaceDb, {
    id: input.bundleId,
    workspaceId: workspaceDb.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    goalId: null,
    agentSessionId: null,
    backendType: null,
    sourceKind: 'work-observation-body',
    summary: 'Restricted admitted work content.',
    rawEvidenceRefs: [{ kind: 'work-observation-body', ref: 'raw/content' }],
    redactedEvidenceRefs: [],
    contentDigests: [input.sha256],
    retentionClass: 'restricted-raw',
    sensitivityClass: 'restricted',
    importStatus: promoted ? 'promoted' : 'collected',
    requiredFeatures: ['openkit.work-observations.v1'],
    createdAt: input.createdAt,
  });
}

/** Adopts exact complete bytes under existing evidence retention; never restores expired content. */
export function retainWorkObservationBody(
  workspaceDb: WorkspaceDb,
  input: WorkObservationEvidenceInput & { readonly bytes: Uint8Array }
): 'retained' | 'expired' {
  if (createHash('sha256').update(input.bytes).digest('hex') !== input.sha256)
    throw new Error('Observation body digest mismatch');
  const existing = workBodyRecord(workspaceDb, input);
  if (existing?.importStatus === 'expired') return 'expired';
  const root = workBodyRoot(workspaceDb, input.bundleId, true);
  const path = join(root, 'content');
  if (existsSync(path)) {
    if (!readCanonicalFile(path).equals(Buffer.from(input.bytes)))
      throw new Error('recovery_required: observation body conflict');
  }
  writeFileAtomic(path, input.bytes);
  recordWorkBody(workspaceDb, input, true);
  return 'retained';
}

/** Reads exact currently available evidence after the caller's owning Thread audience check; expiry is not corruption. */
export function readWorkObservationBody(
  workspaceDb: WorkspaceDb,
  input: WorkObservationEvidenceInput
): Uint8Array | null {
  const record = workBodyRecord(workspaceDb, input);
  if (!record || record.importStatus !== 'promoted') return null;
  const path = join(workBodyRoot(workspaceDb, input.bundleId, false), 'content');
  if (!existsSync(path)) return null;
  const bytes = readCanonicalFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== input.sha256)
    throw new Error('recovery_required: retained observation body mismatch');
  return bytes;
}

/** Stages a bounded chunk durably and returns complete bytes only after full digest/length verification. */
export function stageWorkObservationChunk(
  workspaceDb: WorkspaceDb,
  input: WorkObservationEvidenceInput & {
    readonly totalBytes: number;
    readonly chunkCount: number;
    readonly chunkIndex: number;
    readonly byteOffset: number;
    readonly bytes: Uint8Array;
  }
):
  | { readonly state: 'staged' }
  | { readonly state: 'complete'; readonly bytes: Uint8Array }
  | { readonly state: 'expired' } {
  if (
    !Number.isSafeInteger(input.totalBytes) ||
    input.totalBytes < 0 ||
    input.totalBytes > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(input.chunkCount) ||
    input.chunkCount < 1 ||
    input.chunkCount > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(input.chunkIndex) ||
    input.chunkIndex < 0 ||
    input.chunkIndex >= input.chunkCount ||
    !Number.isSafeInteger(input.byteOffset) ||
    input.byteOffset < 0 ||
    input.bytes.byteLength > 48 * 1024 ||
    input.byteOffset + input.bytes.byteLength > input.totalBytes
  )
    throw new Error('Invalid observation content chunk coordinates');
  const prior = workBodyRecord(workspaceDb, input);
  if (prior?.importStatus === 'expired') return { state: 'expired' };
  if (prior?.importStatus === 'promoted') {
    const descriptor = JSON.parse(
      readCanonicalTextFile(
        join(workBodyRoot(workspaceDb, input.bundleId, false), `chunk-${input.chunkIndex}.json`)
      )
    ) as { byteOffset: number; bytes: number; sha256: string };
    if (
      descriptor.byteOffset !== input.byteOffset ||
      descriptor.bytes !== input.bytes.byteLength ||
      descriptor.sha256 !== createHash('sha256').update(input.bytes).digest('hex')
    )
      throw new Error('recovery_required: published chunk coordinates conflict');
    const complete = readWorkObservationBody(workspaceDb, input);
    if (
      !complete ||
      complete.byteLength !== input.totalBytes ||
      !Buffer.from(complete)
        .subarray(input.byteOffset, input.byteOffset + input.bytes.byteLength)
        .equals(Buffer.from(input.bytes))
    )
      throw new Error('recovery_required: published content chunk replay mismatch');
    return { state: 'complete', bytes: complete };
  }
  const root = workBodyRoot(workspaceDb, input.bundleId, true);
  const path = join(root, `chunk-${input.chunkIndex}`);
  const descriptor = JSON.stringify({
    byteOffset: input.byteOffset,
    bytes: input.bytes.byteLength,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
  });
  if (existsSync(`${path}.json`) && readCanonicalTextFile(`${path}.json`) !== descriptor)
    throw new Error('recovery_required: observation chunk conflict');
  if (existsSync(path)) {
    if (!readCanonicalFile(path).equals(Buffer.from(input.bytes)))
      throw new Error('recovery_required: observation chunk bytes conflict');
  }
  writeFileAtomic(path, input.bytes);
  writeFileAtomic(`${path}.json`, descriptor);
  recordWorkBody(workspaceDb, input, false);
  const chunks: Buffer[] = [];
  let offset = 0;
  for (let index = 0; index < input.chunkCount; index += 1) {
    const chunkPath = join(root, `chunk-${index}`);
    if (!existsSync(`${chunkPath}.json`)) return { state: 'staged' };
    const saved = JSON.parse(readCanonicalTextFile(`${chunkPath}.json`)) as {
      byteOffset: number;
      bytes: number;
      sha256: string;
    };
    const bytes = readCanonicalFile(chunkPath);
    if (
      saved.byteOffset !== offset ||
      saved.bytes !== bytes.length ||
      saved.sha256 !== createHash('sha256').update(bytes).digest('hex')
    )
      throw new Error('recovery_required: corrupt staged observation chunk');
    offset += bytes.length;
    if (offset > input.totalBytes) throw new Error('Observation content length mismatch');
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (
    bytes.length !== input.totalBytes ||
    createHash('sha256').update(bytes).digest('hex') !== input.sha256
  )
    throw new Error('Observation content digest or length mismatch');
  return { state: 'complete', bytes };
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
