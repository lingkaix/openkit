export type {
  AgentEnvironmentPackageSnapshotReadRecord,
  AgentEnvironmentPackageSnapshotRecord,
} from '../storage/workspace-file-records.js';
export {
  AgentEnvironmentSnapshotReadError,
  listExportableAgentEnvironmentPackageSnapshots,
  snapshotDigest,
} from '../storage/workspace-file-records.js';

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  redactAgentEnvironmentPackageSnapshot,
} from '@openkit/config-schema';
import { writeRetainedV1 } from '@openkit/protocol';
import type { WorkspaceDb } from '../storage/db.js';
import {
  type AgentEnvironmentPackageSnapshotReadRecord,
  type AgentEnvironmentPackageSnapshotRecord,
  agentSessionsRoot,
  assertPathSegment,
  assertWorkspaceOwner,
  readSnapshotRecord,
  snapshotDigest,
  syncCanonicalDirectory,
  syncCanonicalTree,
  validateSnapshotRecord,
  writeFileAtomic,
} from '../storage/workspace-file-records.js';

/** Local write-intent failure whose decoder cause stays private at publication. */
export class AgentEnvironmentSnapshotPreparationError extends Error {
  /** @param cause Private construction or validation failure. */
  constructor(cause: unknown) {
    super('The agent environment snapshot could not be prepared.', { cause });
  }
}

/** Input for recording an AEP snapshot. */
export interface RecordAgentEnvironmentPackageSnapshotInput {
  /** Full parsed V4 AEP snapshot. The helper stores only its redacted form. */
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
  let record: AgentEnvironmentPackageSnapshotRecord;
  try {
    const snapshot = AgentEnvironmentPackageSchema.parse(
      redactAgentEnvironmentPackageSnapshot(input.environmentPackage)
    );
    record = validateSnapshotRecord(workspaceDb, {
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
  } catch (cause) {
    throw new AgentEnvironmentSnapshotPreparationError(cause);
  }

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
): AgentEnvironmentPackageSnapshotReadRecord {
  assertWorkspaceOwner(workspaceDb, workspaceId);
  assertPathSegment(snapshotId, 'snapshot id');
  const startedAt = performance.now();
  try {
    const root = agentSessionsRoot(workspaceDb);
    let owner: { path: string; agentSessionId: string } | undefined;
    if (existsSync(root)) {
      if (!lstatSync(root).isDirectory()) {
        throw new Error('Agent environment package session root must be a directory.');
      }
      // Snapshot ids are opaque retained data: locate the filename without decoding history.
      for (const sessionEntry of readdirSync(root, { withFileTypes: true })) {
        if (sessionEntry.isSymbolicLink()) {
          throw new Error(
            `Agent environment package session path is symbolic: ${sessionEntry.name}`
          );
        }
        if (!sessionEntry.isDirectory()) continue;
        const snapshotsRoot = join(root, sessionEntry.name, 'aep-snapshots');
        if (!existsSync(snapshotsRoot)) continue;
        if (!lstatSync(snapshotsRoot).isDirectory()) {
          throw new Error(
            `Agent environment package snapshot root must be a directory: ${sessionEntry.name}`
          );
        }
        const filename = `${snapshotId}.json`;
        // Filesystem case folding must not turn a different retained id into this record's owner.
        if (!readdirSync(snapshotsRoot).includes(filename)) continue;
        const path = join(snapshotsRoot, filename);
        const entry = lstatSync(path, { throwIfNoEntry: false });
        if (!entry) continue;
        if (entry.isSymbolicLink()) {
          throw new Error(
            `Agent environment package snapshot path is symbolic: ${snapshotId}.json`
          );
        }
        if (!entry.isFile()) continue;
        // Only an actual named record owns a session id; unrelated directory names are ignored.
        assertPathSegment(sessionEntry.name, 'AgentSession id');
        // Export refuses duplicate ids rather than choosing by createdAt; lookup stays fail-closed.
        if (owner) throw new Error(`Duplicate agent environment package snapshot: ${snapshotId}`);
        owner = { path, agentSessionId: sessionEntry.name };
      }
    }
    if (!owner) {
      throw new Error(`Agent environment package snapshot not found: ${snapshotId}`);
    }
    return readSnapshotRecord(workspaceDb, owner.path, owner.agentSessionId, snapshotId);
  } finally {
    try {
      const durationMs = performance.now() - startedAt;
      if (durationMs >= 100) {
        console.error(
          JSON.stringify({
            stage: 'aep-lookup',
            durationMs: Math.round(durationMs),
            timestamp: new Date().toISOString(),
            workspaceId: workspaceDb.workspaceId,
            packageSnapshotId: snapshotId,
          })
        );
      }
    } catch {
      // Diagnostics must not change the owning operation.
    }
  }
}

/**
 * Reads the one snapshot a durable record names, or null only for definite absence.
 *
 * Callers that already hold an AgentSession and snapshot id use this instead of the export listing,
 * so an unrelated malformed snapshot cannot fail their read. A snapshot that exists but does not
 * validate still throws. Permission and I/O failures propagate; noncanonical entries refuse.
 *
 * @param workspaceDb Open workspace database.
 * @param workspaceId Workspace id.
 * @param agentSessionId AgentSession that owns the snapshot.
 * @param snapshotId AEP snapshot id.
 * @returns Stored AEP snapshot record, or null when its canonical location is definitely absent.
 * @throws Error for inaccessible storage, noncanonical entries or invalid retained bytes.
 */
export function findNamedAgentEnvironmentPackageSnapshot(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  agentSessionId: string,
  snapshotId: string
): AgentEnvironmentPackageSnapshotReadRecord | null {
  assertWorkspaceOwner(workspaceDb, workspaceId);
  const path = snapshotPath(workspaceDb, agentSessionId, snapshotId);

  const root = agentSessionsRoot(workspaceDb);
  // Inspect only the named path. Missing entries prove absence; unreadable storage does not.
  // Parent checks also refuse links and non-directories before a child can appear missing.
  for (const directory of [dirname(root), root, join(root, agentSessionId), dirname(path)]) {
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (!entry) return null;
    if (!entry.isDirectory()) {
      throw new Error(
        `Agent environment package snapshot parent is not a canonical directory: ${snapshotId}`
      );
    }
  }
  if (!lstatSync(path, { throwIfNoEntry: false })) return null;

  return readSnapshotRecord(workspaceDb, path, agentSessionId, snapshotId);
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

  try {
    writeFileAtomic(
      path,
      `${JSON.stringify(writeRetainedV1({ ...record, snapshot: 'retainedSnapshot' in record ? record.retainedSnapshot : record.snapshot }), null, 2)}\n`,
      undefined,
      'create'
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return requireMatchingSnapshotRecord(workspaceDb, path, record);
  }

  return readSnapshotRecord(workspaceDb, path, record.agentSessionId, record.snapshotId);
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
    JSON.stringify(existing.retainedSnapshot) ===
      JSON.stringify('retainedSnapshot' in expected ? expected.retainedSnapshot : expected.snapshot)
  ) {
    // Identical replay must finish an interrupted publication acknowledgement.
    syncCanonicalTree(path);
    syncCanonicalDirectory(dirname(path));
    return existing;
  }

  throw new Error(`Agent environment package snapshot conflict: ${expected.snapshotId}`);
}

/**
 * Resolves the canonical snapshot file path.
 *
 * @param workspaceDb Workspace that owns the snapshot.
 * @param agentSessionId AgentSession directory id.
 * @param snapshotId Snapshot file id.
 * @returns Absolute canonical snapshot path.
 */
function snapshotPath(
  workspaceDb: WorkspaceDb,
  agentSessionId: string,
  snapshotId: string
): string {
  assertPathSegment(agentSessionId, 'AgentSession id');
  assertPathSegment(snapshotId, 'snapshot id');
  return join(
    agentSessionsRoot(workspaceDb),
    agentSessionId,
    'aep-snapshots',
    `${snapshotId}.json`
  );
}
