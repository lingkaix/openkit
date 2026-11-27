import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import type { FsStore } from '../lib/store.js';
import { StoredGoalCardTaskV1Schema, StoredGoalV1Schema } from '../runtime/goal-retained-v1.js';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import {
  PENDING_PROJECTION_ROLES,
  type PendingRequestRecord,
  pendingRequestItemId,
  readPendingRequest,
} from '../runtime/pending-requests.js';
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
  input: Parameters<typeof raiseRecordedPendingRequest>[2],
  requestItem?: Parameters<typeof raiseRecordedPendingRequest>[3]
) {
  return raiseRecordedPendingRequest(store, db.sqlite, input, requestItem);
}

/**
 * Seeds a long valid Pending history while NanoCore is stopped: `count` copies of one retained
 * request that names no Turn but its completed raising Turn, each with its own request identity
 * and its own request Item appended to that Turn in sequence order. Each inline Item body keeps
 * its descriptor exact (digest and length over the copied body). Seed state only, so a Boot walk
 * meets a history too long for one writer frame.
 * @returns The copies' request ids.
 */
export function copyRetainedPendingHistory(
  dataRoot: string,
  workspaceId: string,
  requestId: string,
  count: number
): string[] {
  const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    fileMustExist: true,
  });
  try {
    const row = sqlite
      .prepare('SELECT * FROM pending_requests WHERE request_id = ?')
      .get(requestId) as Record<string, unknown> | undefined;
    if (
      !row ||
      row.execution_call_id !== null ||
      row.publication_turn_id !== null ||
      row.invalidation_turn_id !== null ||
      row.delivery_turn_id !== null
    )
      throw new Error('The history template must name no Turn but its raising Turn.');
    const roles = ['request', ...PENDING_PROJECTION_ROLES] as const;
    const itemIds = roles.map((role) => pendingRequestItemId(requestId, role));
    const entries = sqlite
      .prepare(
        `SELECT turn_id,sequence,id,revision,schema_version,content_json,identity_json,read_metadata_json
         FROM control_product_entries WHERE kind='item' AND id IN (${itemIds.map(() => '?').join(',')})
         ORDER BY turn_id,sequence`
      )
      .all(...itemIds) as Record<string, string | number | null>[];
    if (!entries.some((entry) => entry.id === row.request_item_id))
      throw new Error('The history template has no retained request Item.');
    const last = sqlite.prepare(
      "SELECT MAX(sequence) FROM control_product_entries WHERE kind='item' AND turn_id = ?"
    );
    const sequences = new Map<string, number>();
    for (const entry of entries) {
      const turnId = String(entry.turn_id);
      if (!sequences.has(turnId)) sequences.set(turnId, Number(last.pluck().get(turnId)));
    }
    const columns = Object.keys(row);
    const insertRow = sqlite.prepare(
      `INSERT INTO pending_requests (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    );
    const insertEntry = sqlite.prepare(
      `INSERT INTO control_product_entries
       (kind,turn_id,sequence,id,revision,schema_version,content_json,identity_json,read_metadata_json)
       VALUES ('item',?,?,?,?,?,?,?,?)`
    );
    const copies: string[] = [];
    sqlite.transaction(() => {
      for (let index = 0; index < count; index++) {
        const copy = `${requestId}h${index.toString(36).padStart(4, '0')}`;
        const swaps = [
          ...roles.map((role) => [
            pendingRequestItemId(requestId, role),
            pendingRequestItemId(copy, role),
          ]),
          [requestId, copy],
        ] as const;
        const swap = (value: unknown) =>
          typeof value === 'string'
            ? swaps.reduce((text, [from, to]) => text.split(from).join(to), value)
            : value;
        insertRow.run(...columns.map((column) => swap(row[column])));
        for (const entry of entries) {
          const content = JSON.parse(swap(entry.content_json) as string) as {
            reference: { representation: string; body?: string; contentDigest: string };
            byteLength: number;
          };
          if (content.reference.representation !== 'inline' || !content.reference.body)
            throw new Error('The history template Item must be inline.');
          const bytes = Buffer.from(content.reference.body, 'utf8');
          const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
          const original = content.reference.contentDigest;
          const descriptor = (value: unknown) =>
            typeof value === 'string' ? value.split(original).join(digest) : value;
          content.reference.contentDigest = digest;
          content.byteLength = bytes.length;
          const turnId = String(entry.turn_id);
          const sequence = sequences.get(turnId)! + 1;
          sequences.set(turnId, sequence);
          insertEntry.run(
            turnId,
            sequence,
            swap(entry.id),
            entry.revision,
            entry.schema_version,
            JSON.stringify(content),
            descriptor(swap(entry.identity_json)),
            descriptor(swap(entry.read_metadata_json))
          );
        }
        copies.push(copy);
      }
    })();
    return copies;
  } finally {
    sqlite.close();
  }
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

/** Leaves a stopped publication missing its trailing Item, with no retained sequence gap. */
export function removeTrailingPublicationItem(
  dataRoot: string,
  workspaceId: string,
  turnId: string,
  itemId: string
): number {
  const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    fileMustExist: true,
  });
  try {
    return sqlite
      .prepare(
        `DELETE FROM control_product_entries WHERE kind='item' AND turn_id=? AND id=?
         AND sequence=(SELECT max(sequence) FROM control_product_entries WHERE kind='item' AND turn_id=?)`
      )
      .run(turnId, itemId, turnId).changes;
  } finally {
    sqlite.close();
  }
}

/** Reads every retained Pending record of one Workspace through the production record reader. */
export function readPendingRecords(dataRoot: string, workspaceId: string): PendingRequestRecord[] {
  const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return (
      sqlite
        .prepare('SELECT request_id FROM pending_requests ORDER BY request_id')
        .pluck()
        .all() as string[]
    ).map((requestId) => readPendingRequest(sqlite, requestId)!);
  } finally {
    sqlite.close();
  }
}

/** Reads one retained Pending record through the production record reader. */
export function readPendingRecord(
  dataRoot: string,
  workspaceId: string,
  requestId: string
): PendingRequestRecord | null {
  const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return readPendingRequest(sqlite, requestId);
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
  turnId: string | null
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
 * Rewrites one stopped root's held Pending result bytes, so that row no longer decodes while its
 * delivery columns still name its frozen batch.
 * @returns Writes the original bytes back.
 */
export function writePendingHeldResult(
  dataRoot: string,
  workspaceId: string,
  requestId: string,
  bytes: string
): () => void {
  const write = (value: string | null) => {
    const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
      fileMustExist: true,
    });
    try {
      return sqlite
        .prepare('UPDATE pending_requests SET held_result_json = ? WHERE request_id = ?')
        .run(value, requestId).changes;
    } finally {
      sqlite.close();
    }
  };
  const reader = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    readonly: true,
    fileMustExist: true,
  });
  let original: { held_result_json: string | null } | undefined;
  try {
    original = reader
      .prepare('SELECT held_result_json FROM pending_requests WHERE request_id = ?')
      .get(requestId) as { held_result_json: string | null } | undefined;
  } finally {
    reader.close();
  }
  if (!original || write(bytes) !== 1) throw new Error(`Pending row not rewritten: ${requestId}`);
  const retained = original.held_result_json;
  return () => {
    if (write(retained) !== 1) throw new Error(`Pending row not restored: ${requestId}`);
  };
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
 * Changes only one Goal's intent, as a concurrent Goal owner may between a planned Pending decision
 * and its writer. The Task terminal owner accepts the changed Goal.
 * @returns Number of changed rows.
 */
export function reviseGoalIntent(dataRoot: string, workspaceId: string, goalId: string): number {
  const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    fileMustExist: true,
  });
  try {
    return sqlite
      .prepare(
        "UPDATE goals SET payload_json = json_set(payload_json, '$.intent', 'Changed after planning') WHERE goal_id = ?"
      )
      .run(goalId).changes;
  } finally {
    sqlite.close();
  }
}

/**
 * Rewrites one Pending row's update time, as a concurrent writer leaves an otherwise unchanged
 * row: a dependency a Boot walk proved changes after its proof.
 * @returns Number of changed rows.
 */
export function touchPendingRow(
  dataRoot: string,
  workspaceId: string,
  requestId: string,
  updatedAt: string
): number {
  const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    fileMustExist: true,
  });
  try {
    return sqlite
      .prepare('UPDATE pending_requests SET updated_at = ? WHERE request_id = ?')
      .run(updatedAt, requestId).changes;
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
 * Links one Thread as a Goal card Task of an ended Goal while NanoCore is stopped, as Task
 * admission records the link and its Goal (`control-store-admission.ts`), so a terminal Turn on
 * that Thread records a Task fact. An ended Goal starts no coordinator Turn.
 * @returns The Goal ID.
 */
export function seedEndedGoalTask(
  dataRoot: string,
  workspaceId: string,
  input: { readonly taskThreadId: string; readonly goalThreadId: string; readonly userId: string }
): string {
  const goalId = 'goal_b5_task';
  const at = '2026-01-01T00:00:00.000Z';
  const goal = StoredGoalV1Schema.parse({
    goalId,
    workspaceId,
    threadId: input.goalThreadId,
    responsibleUserId: input.userId,
    intent: 'Finish the linked Task',
    intentRevision: 0,
    responsibleActorContext: { userId: input.userId, kind: 'local' },
    intentHistory: [],
    proposedPlanVersionId: null,
    activePlanVersionId: null,
    disposition: { kind: 'cancelled', reason: 'Ended', actorId: input.userId, at },
    changeRevision: 0,
    consideredRevision: 0,
    createdAt: at,
    updatedAt: at,
  });
  const link = StoredGoalCardTaskV1Schema.parse({
    goalId,
    cardId: 'card_b5_task',
    threadId: input.taskThreadId,
    planVersionId: 'plan_b5_task',
    cardRevision: 0,
  });
  const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    fileMustExist: true,
  });
  try {
    sqlite.transaction(() => {
      sqlite
        .prepare(
          'INSERT INTO goals (goal_id,thread_id,payload_json,schema_version) VALUES (?,?,?,1)'
        )
        .run(goalId, input.goalThreadId, JSON.stringify(goal));
      sqlite
        .prepare(
          'INSERT INTO goal_card_tasks (thread_id,goal_id,card_id,payload_json,schema_version) VALUES (?,?,?,?,1)'
        )
        .run(input.taskThreadId, goalId, link.cardId, JSON.stringify(link));
    })();
  } finally {
    sqlite.close();
  }
  return goalId;
}

/**
 * Removes one retained Goal row while NanoCore is stopped; its Task links stay in place.
 * @returns Writes the original row back.
 */
export function removeGoal(dataRoot: string, workspaceId: string, goalId: string): () => void {
  const open = () =>
    new Database(workspaceDatabasePath(dataRoot, workspaceId), { fileMustExist: true });
  const sqlite = open();
  let row: Record<string, unknown> | undefined;
  try {
    row = sqlite
      .prepare(
        'SELECT goal_id, thread_id, payload_json, schema_version FROM goals WHERE goal_id = ?'
      )
      .get(goalId) as Record<string, unknown> | undefined;
    if (!row || sqlite.prepare('DELETE FROM goals WHERE goal_id = ?').run(goalId).changes !== 1)
      throw new Error(`Goal not removed: ${goalId}`);
  } finally {
    sqlite.close();
  }
  const retained = row;
  return () => {
    const writer = open();
    try {
      writer
        .prepare(
          'INSERT INTO goals (goal_id, thread_id, payload_json, schema_version) VALUES (@goal_id, @thread_id, @payload_json, @schema_version)'
        )
        .run(retained);
    } finally {
      writer.close();
    }
  };
}

/**
 * Removes one retained native observation while NanoCore is stopped, leaving a sequence gap in an
 * otherwise valid observation history.
 * @returns Writes the original row back.
 */
export function removeWorkObservation(
  dataRoot: string,
  workspaceId: string,
  turnId: string,
  sequence: number
): () => void {
  const open = () =>
    new Database(workspaceDatabasePath(dataRoot, workspaceId), { fileMustExist: true });
  const sqlite = open();
  let row: Record<string, unknown> | undefined;
  try {
    row = sqlite
      .prepare(
        'SELECT turn_id, sequence, id, schema_version, record_json FROM control_work_observations WHERE turn_id = ? AND sequence = ?'
      )
      .get(turnId, sequence) as Record<string, unknown> | undefined;
    if (
      !row ||
      sqlite
        .prepare('DELETE FROM control_work_observations WHERE turn_id = ? AND sequence = ?')
        .run(turnId, sequence).changes !== 1
    )
      throw new Error(`Observation not removed: ${turnId}#${sequence}`);
  } finally {
    sqlite.close();
  }
  const retained = row;
  return () => {
    const writer = open();
    try {
      writer
        .prepare(
          'INSERT INTO control_work_observations (turn_id, sequence, id, schema_version, record_json) VALUES (@turn_id, @sequence, @id, @schema_version, @record_json)'
        )
        .run(retained);
    } finally {
      writer.close();
    }
  };
}

/**
 * Rewrites the stop reason of one Turn's retained inline completion while NanoCore is stopped.
 * The completion stays a readable, digest-consistent retained event; only that field changes.
 * @returns Writes the original entry descriptor back.
 */
export function contradictTurnCompletionStopReason(
  dataRoot: string,
  workspaceId: string,
  turnId: string,
  stopReason: string
): () => void {
  const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    fileMustExist: true,
  });
  const write = (rowid: number, content: string) => {
    const writer = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
      fileMustExist: true,
    });
    try {
      return writer
        .prepare('UPDATE control_product_entries SET content_json = ? WHERE rowid = ?')
        .run(content, rowid).changes;
    } finally {
      writer.close();
    }
  };
  let rowid: number | undefined;
  let original: string | undefined;
  let changed: string | undefined;
  try {
    const rows = sqlite
      .prepare(
        "SELECT rowid, content_json FROM control_product_entries WHERE kind = 'event' AND turn_id = ?"
      )
      .all(turnId) as { rowid: number; content_json: string }[];
    for (const row of rows) {
      const content = JSON.parse(row.content_json) as {
        reference: { representation?: string; body?: string; contentDigest?: string };
        byteLength: number;
      };
      if (content.reference.representation !== 'inline' || !content.reference.body) continue;
      const event = JSON.parse(content.reference.body) as {
        data?: { type?: string; stopReason?: string };
      };
      if (event.data?.type !== 'turn-completed') continue;
      if (rowid !== undefined) throw new Error(`Turn has two completions: ${turnId}`);
      event.data.stopReason = stopReason;
      const body = JSON.stringify(event);
      const bytes = Buffer.from(body, 'utf8');
      rowid = row.rowid;
      original = row.content_json;
      changed = JSON.stringify({
        ...content,
        reference: {
          ...content.reference,
          body,
          contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        },
        byteLength: bytes.length,
      });
    }
  } finally {
    sqlite.close();
  }
  if (rowid === undefined || !original || !changed)
    throw new Error(`Turn has no inline completion: ${turnId}`);
  const entry = rowid;
  const retained = original;
  if (write(entry, changed) !== 1) throw new Error(`Completion not rewritten: ${turnId}`);
  return () => {
    if (write(entry, retained) !== 1) throw new Error(`Completion not restored: ${turnId}`);
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

/**
 * Rewrites one retained AgentSession's status while NanoCore is stopped, so an open Turn names a
 * Session that its own writer refuses.
 * @returns Writes the original status and record bytes back.
 */
export function writeAgentSessionStatus(
  dataRoot: string,
  workspaceId: string,
  agentSessionId: string,
  status: string
): () => void {
  const write = (value: { status: string; record_json: string }) => {
    const sqlite = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
      fileMustExist: true,
    });
    try {
      if (
        sqlite
          .prepare('UPDATE control_agent_sessions SET status = ?, record_json = ? WHERE id = ?')
          .run(value.status, value.record_json, agentSessionId).changes !== 1
      )
        throw new Error(`AgentSession not rewritten: ${agentSessionId}`);
    } finally {
      sqlite.close();
    }
  };
  const reader = new Database(workspaceDatabasePath(dataRoot, workspaceId), {
    readonly: true,
    fileMustExist: true,
  });
  let original: { status: string; record_json: string } | undefined;
  try {
    original = reader
      .prepare('SELECT status, record_json FROM control_agent_sessions WHERE id = ?')
      .get(agentSessionId) as typeof original;
  } finally {
    reader.close();
  }
  if (!original) throw new Error(`AgentSession not found: ${agentSessionId}`);
  const retained = original;
  write({ status, record_json: JSON.stringify({ ...JSON.parse(retained.record_json), status }) });
  return () => write(retained);
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
