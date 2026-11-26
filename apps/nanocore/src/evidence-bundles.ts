import { writeFileAtomic } from './storage/canonical-write-capacity.js';
import {
  assertEvidenceBundleDirectoryId,
  type EvidenceBundleRow,
  evidenceBundleFromRow,
  insertEvidenceBundle,
} from './storage/evidence-bundle-records.js';
import { serverWorkUnavailable } from './storage/server-work-command.js';

export { recordWorkspaceEvidenceBundle } from './storage/evidence-bundle-records.js';

import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type EvidenceBundleRecord,
  EvidenceBundleRecordSchema,
  type ServerEvidenceBundleRecord,
  ServerEvidenceBundleRecordSchema,
} from '@openkit/app-api-schemas';
import { readRetainedV1 } from '@openkit/protocol';
import {
  assertCanonicalDirectory,
  ensureCanonicalDirectory,
  readCanonicalFile,
  readCanonicalTextFile,
} from '@openkit/storage';

import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { assertWorkObservationPosition } from './storage/work-observation-collection.js';
import type { ServerWorkObservationDb } from './storage/work-observations.js';
import { assertSafeWorkspacePathSegment } from './storage/workspace-file-records.js';

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
 * Expires old ephemeral diagnostic evidence refs without deleting governed rows.
 *
 * @param input Workspace database, owner workspace id, and exclusive cutoff timestamp.
 * @returns Number of compacted evidence bundle rows.
 * @throws Error when Workspace lineage, retained format, or a bundle directory id is unsafe.
 */
export function compactWorkspaceEvidenceBundles(
  input: CompactWorkspaceEvidenceBundlesInput
): CompactWorkspaceEvidenceBundlesResult {
  if (input.workspaceId !== input.workspaceDb.workspaceId) {
    throw new Error('Evidence bundle compaction has different Workspace lineage.');
  }
  const compactedRows = input.workspaceDb.sqlite
    .prepare(
      `SELECT evidence_bundle_id, schema_version, retention_class, import_status
      FROM evidence_bundles
      WHERE workspace_id = ?
        AND (retention_class = 'ephemeral-diagnostic' OR (
          retention_class = 'restricted-raw'
          AND source_kind IN ('worker-runtime-provenance-raw', 'work-observation-body')
        ))
        AND created_at < ?`
    )
    .all(input.workspaceId, input.olderThan) as Array<{
    evidence_bundle_id: string;
    schema_version: number;
    retention_class: string;
    import_status: string;
  }>;
  for (const row of compactedRows) {
    readRetainedV1({ schemaVersion: row.schema_version }, () => undefined);
    assertEvidenceBundleDirectoryId(row.evidence_bundle_id);
  }
  for (const row of compactedRows) {
    if (row.retention_class !== 'restricted-raw' || row.import_status === 'expired') continue;
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
        WHERE workspace_id = ?
        ORDER BY created_at, evidence_bundle_id`
      )
      .all(workspaceId) as EvidenceBundleRow[]
  ).map((row) => evidenceBundleFromRow(row));
}

function projectEvidenceBundleForProduct(record: EvidenceBundleRecord): EvidenceBundleRecord {
  return record.sourceKind === 'worker-runtime-provenance-raw'
    ? EvidenceBundleRecordSchema.parse({ ...record, rawEvidenceRefs: [] })
    : record;
}

/** Deterministic evidence identity scoped to one observation body, never a native identifier. */
export function workObservationBodyBundleId(
  workspaceId: string | { readonly kind: 'server' },
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
  workspaceDb: WorkspaceDb | CoreDb | ServerWorkObservationDb,
  input: WorkObservationEvidenceInput
): EvidenceBundleRecord | ServerEvidenceBundleRecord | undefined {
  if (workspaceDb.scope === 'core') throw serverWorkUnavailable();
  const row = workspaceDb.sqlite
    .prepare('SELECT * FROM evidence_bundles WHERE evidence_bundle_id = ?')
    .get(input.bundleId) as EvidenceBundleRow | undefined;
  if (!row) return undefined;
  const record = evidenceBundleFromRow(row, workspaceDb.scope === 'server-work');
  if (
    record.workspaceId !==
      (workspaceDb.scope === 'workspace' ? workspaceDb.workspaceId : undefined) ||
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
function workBodyRoot(
  workspaceDb: WorkspaceDb | CoreDb | ServerWorkObservationDb,
  bundleId: string,
  create: boolean
): string {
  if (workspaceDb.scope === 'core') throw serverWorkUnavailable();
  assertSafeWorkspacePathSegment(bundleId, 'Observation evidence bundle');
  if (workspaceDb.scope === 'workspace')
    assertSafeWorkspacePathSegment(workspaceDb.workspaceId, 'Observation Workspace');
  let path = workspaceDb.dataRoot;
  for (const part of [
    ...(workspaceDb.scope === 'server-work' ? ['server'] : ['workspaces', workspaceDb.workspaceId]),
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
  workspaceDb: WorkspaceDb | CoreDb | ServerWorkObservationDb,
  input: WorkObservationEvidenceInput,
  promoted: boolean
): void {
  if (
    workspaceDb.sqlite.inTransaction ||
    Number(workspaceDb.sqlite.pragma('synchronous', { simple: true })) < 2
  )
    throw new Error('Observation evidence requires a durable independent owner commit');
  if (workspaceDb.scope === 'core') throw serverWorkUnavailable();
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
  insertEvidenceBundle(
    workspaceDb,
    (workspaceDb.scope === 'server-work'
      ? ServerEvidenceBundleRecordSchema
      : EvidenceBundleRecordSchema
    ).parse({
      id: input.bundleId,
      ...(workspaceDb.scope === 'server-work'
        ? { owner: { kind: 'server' } }
        : { workspaceId: workspaceDb.workspaceId }),
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
    })
  );
}

/** Adopts exact complete bytes under existing evidence retention; never restores expired content. */
export function retainWorkObservationBody(
  workspaceDb: WorkspaceDb | CoreDb | ServerWorkObservationDb,
  input: WorkObservationEvidenceInput & { readonly bytes: Uint8Array }
): 'retained' | 'expired' {
  if (createHash('sha256').update(input.bytes).digest('hex') !== input.sha256)
    throw new Error('Observation body digest mismatch');
  if (workspaceDb.scope === 'core') throw serverWorkUnavailable();
  const existing = workBodyRecord(workspaceDb, input);
  if (existing?.importStatus === 'expired') return 'expired';
  const root = workBodyRoot(workspaceDb, input.bundleId, true);
  const path = join(root, 'content');
  if (existsSync(path)) {
    if (!readCanonicalFile(path).equals(Buffer.from(input.bytes)))
      throw new Error('recovery_required: observation body conflict');
  } else writeFileAtomic(path, input.bytes);
  recordWorkBody(workspaceDb, input, true);
  return 'retained';
}

/** Reads exact currently available evidence after the caller's owning Thread audience check; expiry is not corruption. */
export function readWorkObservationBody(
  workspaceDb: WorkspaceDb | CoreDb | ServerWorkObservationDb,
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
export async function stageWorkObservationChunk(
  workspaceDb: WorkspaceDb,
  input: WorkObservationEvidenceInput & {
    readonly totalBytes: number;
    readonly chunkCount: number;
    readonly chunkIndex: number;
    readonly byteOffset: number;
    readonly workerSequence?: number | undefined;
    readonly originalWorkerReplay?: boolean | undefined;
    readonly bytes: Uint8Array;
  }
): Promise<
  | { readonly state: 'staged' }
  | { readonly state: 'complete'; readonly bytes: Uint8Array }
  | { readonly state: 'expired' }
> {
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
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > 48 * 1024 ||
    input.byteOffset + input.bytes.byteLength > input.totalBytes
  )
    throw new Error('Invalid observation content chunk coordinates');
  const prior = workBodyRecord(workspaceDb, input);
  if (prior?.importStatus === 'expired') {
    if (input.workerSequence !== undefined)
      assertWorkObservationPosition(undefined, input.workerSequence, input.originalWorkerReplay);
    return { state: 'expired' };
  }
  const assertPosition = (saved: { workerSequence?: number | undefined }) => {
    if (input.workerSequence !== undefined)
      assertWorkObservationPosition(
        saved.workerSequence,
        input.workerSequence,
        input.originalWorkerReplay
      );
  };
  if (prior?.importStatus === 'promoted') {
    const descriptor = JSON.parse(
      readCanonicalTextFile(
        join(workBodyRoot(workspaceDb, input.bundleId, false), `chunk-${input.chunkIndex}.json`)
      )
    ) as { byteOffset: number; bytes: number; sha256: string; workerSequence?: number };
    assertPosition(descriptor);
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
  const descriptor = {
    byteOffset: input.byteOffset,
    bytes: input.bytes.byteLength,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    workerSequence: input.workerSequence,
  };
  const descriptorPath = `${path}.json`;
  const hasDescriptor = existsSync(`${path}.json`);
  const hasBytes = existsSync(path);
  if (hasDescriptor) {
    const saved = JSON.parse(readCanonicalTextFile(descriptorPath)) as typeof descriptor;
    assertPosition(saved);
    if (
      saved.byteOffset !== descriptor.byteOffset ||
      saved.bytes !== descriptor.bytes ||
      saved.sha256 !== descriptor.sha256
    )
      throw new Error('recovery_required: observation chunk conflict');
  } else if (hasBytes) {
    assertPosition({});
  }
  if (hasBytes && !readCanonicalFile(path).equals(Buffer.from(input.bytes)))
    throw new Error('recovery_required: observation chunk bytes conflict');

  // A distinct chunk spends its reserved bytes before any file grows. The descriptor goes
  // first so a crash cannot leave an uncharged file. Legacy file-only staging still counts.
  const names = new Set(await readdir(root));
  if (!hasDescriptor) {
    let total = input.bytes.byteLength;
    for (const name of names) {
      if (/^chunk-\d+\.json$/.test(name) && name !== `chunk-${input.chunkIndex}.json`) {
        const saved = JSON.parse(readCanonicalTextFile(join(root, name))) as { bytes: number };
        if (!Number.isSafeInteger(saved.bytes) || saved.bytes <= 0 || saved.bytes > 48 * 1024)
          throw new Error('recovery_required: corrupt staged observation chunk');
        total += saved.bytes;
      } else if (
        /^chunk-\d+$/.test(name) &&
        name !== `chunk-${input.chunkIndex}` &&
        !names.has(`${name}.json`)
      ) {
        // Only the previous file-first implementation could have left this half completed.
        const stat = await lstat(join(root, name));
        if (!stat.isFile()) throw new Error('recovery_required: corrupt staged observation chunk');
        total += stat.size;
      }
    }
    if (total > input.totalBytes)
      throw new Error('Observation content length exceeds its declaration');
    writeFileAtomic(descriptorPath, JSON.stringify(descriptor));
    names.add(`chunk-${input.chunkIndex}.json`);
  }
  if (!hasBytes) writeFileAtomic(path, input.bytes);
  names.add(`chunk-${input.chunkIndex}`);
  recordWorkBody(workspaceDb, input, false);

  // Check completion before reading any of the preceding bodies again.
  for (let index = 0; index < input.chunkCount; index += 1)
    if (!names.has(`chunk-${index}`) || !names.has(`chunk-${index}.json`))
      return { state: 'staged' };
  const chunks: Buffer[] = [];
  let offset = 0;
  for (let index = 0; index < input.chunkCount; index += 1) {
    const chunkPath = join(root, `chunk-${index}`);
    const saved = JSON.parse(readCanonicalTextFile(`${chunkPath}.json`)) as {
      byteOffset: number;
      bytes: number;
      sha256: string;
    };
    let bytes: Buffer;
    try {
      bytes = readCanonicalFile(chunkPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'staged' };
      throw error;
    }
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
