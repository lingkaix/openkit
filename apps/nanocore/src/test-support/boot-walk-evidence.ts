import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import type { FsStore } from '../lib/store.js';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';

/** Retained evidence of one Workspace: file digests by path and committed row digests by table. */
export interface WorkspaceEvidence {
  readonly files: Record<string, string>;
  readonly content: Record<string, string>;
}

function workspaceDatabasePath(dataRoot: string, workspaceId: string): string {
  return join(dataRoot, 'workspaces', workspaceId, 'db', 'workspace.sqlite');
}

/** Opens one stopped root's Workspace database for production seed writers, then closes it. */
export async function withSeedWorkspaceDb<T>(
  dataRoot: string,
  workspaceId: string,
  use: (db: WorkspaceDb) => Promise<T>
): Promise<T> {
  const db = openWorkspaceDb(dataRoot, workspaceId);
  try {
    applyScopedMigrations(db);
    return await use(db);
  } finally {
    db.sqlite.close();
  }
}

/** Raises one Pending request through the production raiser on the seed handle. */
export function raiseSeedPendingRequest(
  store: FsStore,
  db: WorkspaceDb,
  input: Parameters<typeof raiseRecordedPendingRequest>[2]
) {
  return raiseRecordedPendingRequest(store, db.sqlite, input);
}

/** Reads one retained Pending row's claim, disposition, publication pointer and delivery. */
export function readPendingRow(
  dataRoot: string,
  workspaceId: string,
  requestId: string
): Record<string, unknown> {
  const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return sqlite
      .prepare(
        'SELECT claim, disposition, disposition_reason, publication_turn_id, delivery, delivery_turn_id, invalidation_turn_id FROM pending_requests WHERE request_id = ?'
      )
      .get(requestId) as Record<string, unknown>;
  } finally {
    sqlite.close();
  }
}

/**
 * Rewrites one retained Pending publication pointer while NanoCore is stopped.
 * It injects the stopped retained-record fault, or restores the original verified pointer.
 * @returns Number of changed rows.
 */
export function writePendingPublication(
  dataRoot: string,
  workspaceId: string,
  requestId: string,
  turnId: string
): number {
  const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    fileMustExist: true,
  });
  try {
    return sqlite
      .prepare('UPDATE pending_requests SET publication_turn_id = ? WHERE request_id = ?')
      .run(turnId, requestId).changes;
  } finally {
    sqlite.close();
  }
}

/**
 * Writes one stopped root's Pending disposition, as the closeout writer leaves a granted request
 * whose requester lost authority before its executor claimed it.
 */
export function writePendingDisposition(
  dataRoot: string,
  workspaceId: string,
  requestId: string,
  disposition: string,
  reason: string
): number {
  const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    fileMustExist: true,
  });
  try {
    return sqlite
      .prepare(
        'UPDATE pending_requests SET disposition = ?, disposition_reason = ? WHERE request_id = ?'
      )
      .run(disposition, reason, requestId).changes;
  } finally {
    sqlite.close();
  }
}

/**
 * Rewrites one retained MCP CapabilityCall column while NanoCore is stopped.
 * It injects the stopped ledger fault, or restores the original verified value.
 * @returns Number of changed rows.
 */
export function writeCapabilityCallColumn(
  dataRoot: string,
  workspaceId: string,
  callId: string,
  column: 'turn_id' | 'workspace_id',
  value: string
): number {
  const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    fileMustExist: true,
  });
  try {
    return sqlite
      .prepare(`UPDATE capability_calls SET ${column} = ? WHERE call_id = ?`)
      .run(value, callId).changes;
  } finally {
    sqlite.close();
  }
}

/** Counts retained capability calls, so a replay that calls upstream again is visible. */
export function capabilityCallCount(dataRoot: string, workspaceId: string): number {
  const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return (
      sqlite.prepare('SELECT count(*) AS count FROM capability_calls').get() as {
        count: number;
      }
    ).count;
  } finally {
    sqlite.close();
  }
}

/**
 * Inventories a Workspace's retained paths and hashes its committed SQLite content, including WAL frames.
 * Transient WAL and shared-memory file names are excluded; their committed rows are read through SQLite.
 */
export function workspaceEvidence(dataRoot: string, workspaceId: string): WorkspaceEvidence {
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!/\.sqlite(-wal|-shm|-journal)?$/.test(name))
        files[relative(workspaceRoot, path)] = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex');
      else files[relative(workspaceRoot, path).replace(/-(wal|shm|journal)$/, '')] = 'sqlite';
    }
  };
  walk(workspaceRoot);
  const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all() as string[];
    const content = Object.fromEntries(
      tables.map((table) => [
        table,
        createHash('sha256')
          .update(JSON.stringify(sqlite.prepare(`SELECT * FROM "${table}"`).raw().all()))
          .digest('hex'),
      ])
    );
    return { files, content };
  } finally {
    sqlite.close();
  }
}
