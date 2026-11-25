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

/**
 * Makes one Workspace unable to answer any Turn selector read until the returned restore runs:
 * its Turn table is renamed, so every read of it fails rather than observing a miss.
 * @returns Restores the original table name.
 */
export function hideWorkspaceTurnSelector(dataRoot: string, workspaceId: string): () => void {
  const rename = (from: string, to: string) => {
    const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
      fileMustExist: true,
    });
    try {
      sqlite.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
    } finally {
      sqlite.close();
    }
  };
  rename('control_turns', 'b5_unreadable_control_turns');
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    rename('b5_unreadable_control_turns', 'control_turns');
  };
}

/**
 * Rewrites one field of one retained Turn record while NanoCore is stopped, so a readable record
 * contradicts its own sealed completion snapshot.
 * @returns Writes the original record bytes back.
 */
export function contradictTurnRecord(
  dataRoot: string,
  workspaceId: string,
  turnId: string,
  field: string,
  value: unknown
): () => void {
  const write = (record: string) => {
    const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
      fileMustExist: true,
    });
    try {
      return sqlite
        .prepare('UPDATE control_turns SET record_json = ? WHERE id = ?')
        .run(record, turnId).changes;
    } finally {
      sqlite.close();
    }
  };
  const reader = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    readonly: true,
    fileMustExist: true,
  });
  let original: string;
  try {
    original = reader
      .prepare('SELECT record_json FROM control_turns WHERE id = ?')
      .pluck()
      .get(turnId) as string;
  } finally {
    reader.close();
  }
  if (typeof original !== 'string') throw new Error(`Turn not found: ${turnId}`);
  if (write(JSON.stringify({ ...JSON.parse(original), [field]: value })) !== 1)
    throw new Error(`Turn not rewritten: ${turnId}`);
  return () => {
    if (write(original) !== 1) throw new Error(`Turn not restored: ${turnId}`);
  };
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
