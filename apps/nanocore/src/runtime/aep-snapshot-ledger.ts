import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AgentEnvironmentPackageSnapshotRecordSchema,
  type AgentEnvironmentPackageSnapshotRecord as AppApiAgentEnvironmentPackageSnapshotRecord,
} from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  redactAgentEnvironmentPackageSnapshot,
} from '@openkit/config-schema';
import type { WorkspaceDb } from '../storage/db.js';

/** Durable workspace-owned AEP snapshot record with its strictly parsed V2 snapshot. */
export type AgentEnvironmentPackageSnapshotRecord = Omit<
  AppApiAgentEnvironmentPackageSnapshotRecord,
  'snapshot'
> & { readonly snapshot: AgentEnvironmentPackage };

/** Input for recording an AEP snapshot. */
export interface RecordAgentEnvironmentPackageSnapshotInput {
  /** Full parsed V2 AEP snapshot. The helper stores only its redacted form. */
  readonly environmentPackage: AgentEnvironmentPackage;
  /** Record creation timestamp. */
  readonly createdAt: string;
}

/**
 * Persists one immutable, redacted AEP snapshot in the workspace ledger.
 *
 * @param workspaceDb Open workspace database.
 * @param input AEP snapshot input.
 * @returns Stored snapshot record.
 */
export function recordAgentEnvironmentPackageSnapshot(
  workspaceDb: WorkspaceDb,
  input: RecordAgentEnvironmentPackageSnapshotInput
): AgentEnvironmentPackageSnapshotRecord {
  const snapshot = AgentEnvironmentPackageSchema.parse(
    redactAgentEnvironmentPackageSnapshot(input.environmentPackage)
  );
  const record = validateSnapshotRecord(workspaceDb, {
    snapshotId: snapshot.snapshotId,
    workspaceId: snapshot.scope.workspaceId,
    turnId: snapshot.scope.turnId,
    threadId: snapshot.scope.threadId,
    agentSessionId: snapshot.scope.agentSessionId,
    agentId: snapshot.agent.agentId,
    packageId: snapshot.packageId,
    runtimeKind: snapshot.agent.runtimeKind,
    backendKind: snapshot.backend.preferred,
    contentDigest: snapshotDigest(snapshot),
    snapshot,
    createdAt: input.createdAt,
  });

  return writeSnapshotRecord(workspaceDb, record);
}

/**
 * Reads one durable AEP snapshot record or throws when missing.
 *
 * @param workspaceDb Open workspace database.
 * @param workspaceId Workspace id.
 * @param snapshotId AEP snapshot id.
 * @returns Stored AEP snapshot record.
 */
export function requireAgentEnvironmentPackageSnapshot(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  snapshotId: string
): AgentEnvironmentPackageSnapshotRecord {
  const record = listExportableAgentEnvironmentPackageSnapshots(workspaceDb, workspaceId).find(
    (candidate) => candidate.snapshotId === snapshotId
  );

  if (!record) {
    throw new Error(`Agent environment package snapshot not found: ${snapshotId}`);
  }

  return record;
}

/**
 * Lists redacted AEP snapshots for workspace export.
 *
 * @param workspaceDb Open workspace database.
 * @param workspaceId Workspace id.
 * @returns Exportable snapshot records in stable storage order.
 */
export function listExportableAgentEnvironmentPackageSnapshots(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): AgentEnvironmentPackageSnapshotRecord[] {
  assertWorkspaceOwner(workspaceDb, workspaceId);
  const root = agentSessionsRoot(workspaceDb);

  if (!existsSync(root)) {
    return [];
  }
  if (!lstatSync(root).isDirectory()) {
    throw new Error('Agent environment package session root must be a directory.');
  }

  const records: AgentEnvironmentPackageSnapshotRecord[] = [];
  for (const sessionEntry of readdirSync(root, { withFileTypes: true })) {
    if (sessionEntry.isSymbolicLink()) {
      throw new Error(`Agent environment package session path is symbolic: ${sessionEntry.name}`);
    }
    if (!sessionEntry.isDirectory()) {
      continue;
    }

    const snapshotsRoot = join(root, sessionEntry.name, 'aep-snapshots');
    if (!existsSync(snapshotsRoot)) {
      continue;
    }
    if (!lstatSync(snapshotsRoot).isDirectory()) {
      throw new Error(
        `Agent environment package snapshot root must be a directory: ${sessionEntry.name}`
      );
    }

    for (const snapshotEntry of readdirSync(snapshotsRoot, { withFileTypes: true })) {
      if (snapshotEntry.isSymbolicLink()) {
        throw new Error(
          `Agent environment package snapshot path is symbolic: ${snapshotEntry.name}`
        );
      }
      if (!snapshotEntry.isFile() || !snapshotEntry.name.endsWith('.json')) {
        continue;
      }

      const snapshotId = snapshotEntry.name.slice(0, -'.json'.length);
      records.push(
        readSnapshotRecord(
          workspaceDb,
          join(snapshotsRoot, snapshotEntry.name),
          sessionEntry.name,
          snapshotId
        )
      );
    }
  }

  records.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.snapshotId.localeCompare(right.snapshotId)
  );

  const snapshotIds = new Set<string>();
  for (const record of records) {
    if (snapshotIds.has(record.snapshotId)) {
      throw new Error(`Duplicate agent environment package snapshot: ${record.snapshotId}`);
    }
    snapshotIds.add(record.snapshotId);
  }

  return records;
}

/**
 * Replays exported redacted AEP snapshots into an imported workspace.
 *
 * @param workspaceDb Open target workspace database.
 * @param records Exported records already rewritten to the target workspace id.
 */
export function importAgentEnvironmentPackageSnapshots(
  workspaceDb: WorkspaceDb,
  records: readonly AgentEnvironmentPackageSnapshotRecord[]
): void {
  for (const record of records) {
    writeSnapshotRecord(workspaceDb, validateSnapshotRecord(workspaceDb, record));
  }
}

/**
 * Writes one validated immutable snapshot using atomic no-clobber publication.
 *
 * @param workspaceDb Workspace that owns the snapshot.
 * @param record Validated snapshot record.
 * @returns Newly written or existing identical record.
 * @throws Error when the same snapshot id already names different content.
 */
function writeSnapshotRecord(
  workspaceDb: WorkspaceDb,
  record: AgentEnvironmentPackageSnapshotRecord
): AgentEnvironmentPackageSnapshotRecord {
  const path = snapshotPath(workspaceDb, record.agentSessionId, record.snapshotId);

  if (existsSync(path)) {
    return requireMatchingSnapshotRecord(workspaceDb, path, record);
  }

  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${record.snapshotId}.${process.pid}.${randomUUID()}.tmp`
  );

  try {
    writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    try {
      linkSync(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      return requireMatchingSnapshotRecord(workspaceDb, path, record);
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }

  return readSnapshotRecord(workspaceDb, path, record.agentSessionId, record.snapshotId);
}

/**
 * Reads and validates one canonical snapshot file.
 *
 * @param workspaceDb Workspace that owns the snapshot.
 * @param path Canonical snapshot file path.
 * @param agentSessionId Parent session directory name.
 * @param snapshotId Snapshot file name without extension.
 * @returns Validated snapshot record.
 */
function readSnapshotRecord(
  workspaceDb: WorkspaceDb,
  path: string,
  agentSessionId: string,
  snapshotId: string
): AgentEnvironmentPackageSnapshotRecord {
  if (!lstatSync(path).isFile()) {
    throw new Error(`Agent environment package snapshot is not a regular file: ${snapshotId}`);
  }
  const record = validateSnapshotRecord(workspaceDb, JSON.parse(readFileSync(path, 'utf8')));

  if (record.agentSessionId !== agentSessionId || record.snapshotId !== snapshotId) {
    throw new Error(`Agent environment package snapshot path mismatch: ${snapshotId}`);
  }

  return record;
}

/**
 * Returns an existing identical snapshot or rejects an immutable-id conflict.
 *
 * @param workspaceDb Workspace that owns the snapshot.
 * @param path Existing canonical file path.
 * @param expected Candidate record for the same id.
 * @returns Existing identical snapshot record.
 */
function requireMatchingSnapshotRecord(
  workspaceDb: WorkspaceDb,
  path: string,
  expected: AgentEnvironmentPackageSnapshotRecord
): AgentEnvironmentPackageSnapshotRecord {
  const existing = readSnapshotRecord(
    workspaceDb,
    path,
    expected.agentSessionId,
    expected.snapshotId
  );

  if (
    existing.contentDigest === expected.contentDigest &&
    JSON.stringify(existing.snapshot) === JSON.stringify(expected.snapshot)
  ) {
    return existing;
  }

  throw new Error(`Agent environment package snapshot conflict: ${expected.snapshotId}`);
}

/**
 * Parses one public snapshot record as V2 and verifies its digest and complete AEP lineage.
 *
 * @param workspaceDb Workspace that owns the snapshot.
 * @param value Candidate snapshot record.
 * @returns Validated record with a parsed Agent Environment Package.
 */
function validateSnapshotRecord(
  workspaceDb: WorkspaceDb,
  value: unknown
): AgentEnvironmentPackageSnapshotRecord {
  const parsed = AgentEnvironmentPackageSnapshotRecordSchema.parse(value);
  const snapshot = AgentEnvironmentPackageSchema.parse(parsed.snapshot);
  const redactedSnapshot = AgentEnvironmentPackageSchema.parse(
    redactAgentEnvironmentPackageSnapshot(snapshot)
  );
  const record: AgentEnvironmentPackageSnapshotRecord = { ...parsed, snapshot };

  if (JSON.stringify(snapshot) !== JSON.stringify(redactedSnapshot)) {
    throw new Error(`Agent environment package snapshot is not redacted: ${record.snapshotId}`);
  }

  assertWorkspaceOwner(workspaceDb, record.workspaceId);
  assertPathSegment(record.agentSessionId, 'agent session id');
  assertPathSegment(record.snapshotId, 'snapshot id');

  if (
    record.snapshotId !== snapshot.snapshotId ||
    record.workspaceId !== snapshot.scope.workspaceId ||
    record.turnId !== snapshot.scope.turnId ||
    record.threadId !== snapshot.scope.threadId ||
    record.agentSessionId !== snapshot.scope.agentSessionId ||
    record.agentId !== snapshot.agent.agentId ||
    record.packageId !== snapshot.packageId ||
    record.runtimeKind !== snapshot.agent.runtimeKind ||
    record.backendKind !== snapshot.backend.preferred
  ) {
    throw new Error(`Agent environment package snapshot lineage mismatch: ${record.snapshotId}`);
  }

  if (record.contentDigest !== snapshotDigest(snapshot)) {
    throw new Error(`Agent environment package snapshot digest mismatch: ${record.snapshotId}`);
  }

  return record;
}

/**
 * Resolves the canonical snapshot file path.
 *
 * @param workspaceDb Workspace that owns the snapshot.
 * @param agentSessionId Agent session directory id.
 * @param snapshotId Snapshot file id.
 * @returns Absolute canonical snapshot path.
 */
function snapshotPath(
  workspaceDb: WorkspaceDb,
  agentSessionId: string,
  snapshotId: string
): string {
  assertPathSegment(agentSessionId, 'agent session id');
  assertPathSegment(snapshotId, 'snapshot id');
  return join(
    agentSessionsRoot(workspaceDb),
    agentSessionId,
    'aep-snapshots',
    `${snapshotId}.json`
  );
}

/**
 * Resolves the workspace-owned agent session directory.
 *
 * @param workspaceDb Workspace ownership metadata.
 * @returns Absolute agent session root.
 */
function agentSessionsRoot(workspaceDb: WorkspaceDb): string {
  return join(dirname(dirname(workspaceDb.sqlite.name)), 'runtime', 'agent-sessions');
}

/**
 * Hashes one parsed redacted snapshot using the existing public digest format.
 *
 * @param snapshot Parsed redacted Agent Environment Package.
 * @returns Lowercase SHA-256 digest.
 */
function snapshotDigest(snapshot: AgentEnvironmentPackage): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

/**
 * Verifies that one API workspace scope matches the open workspace owner.
 *
 * @param workspaceDb Open workspace database metadata.
 * @param workspaceId Workspace id supplied by the record or caller.
 */
function assertWorkspaceOwner(workspaceDb: WorkspaceDb, workspaceId: string): void {
  if (workspaceId !== workspaceDb.workspaceId) {
    throw new Error(`Agent environment package snapshot workspace mismatch: ${workspaceId}`);
  }
}

/**
 * Rejects ids that would create nested or escaped canonical paths.
 *
 * @param value Candidate file or directory id.
 * @param label Human-readable id label.
 */
function assertPathSegment(value: string, label: string): void {
  if (value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new Error(`Agent environment package ${label} is not a safe path segment.`);
  }
}
