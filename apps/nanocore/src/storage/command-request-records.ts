import { existsSync, readdirSync } from 'node:fs';
import { z } from 'zod';

import type {
  ChatCommandReceiptMetadata,
  CommandRequestName,
  CommandRequestRecord,
  CommandRequestResponse,
  CommandRequestResponseKind,
  CommandRequestScope,
} from '../lib/store.js';
import { openUserDb, openWorkspaceDb, type UserDb, type WorkspaceDb } from './db.js';
import { resolveDataRootPath, userDbPath, workspaceDbPath } from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';

/** Raw SQLite row for one command idempotency request. */
type CommandRequestRow = {
  readonly key: string;
  readonly command: CommandRequestName;
  readonly requestId: string;
  readonly scopeJson: string;
  readonly inputHash: string;
  readonly responseKind: CommandRequestResponseKind;
  readonly responseId: string;
  readonly responseJson: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
};

/** Scoped database that can own command idempotency requests. */
type CommandRequestDb = UserDb | WorkspaceDb;

/** Closed schema for the sole extra metadata allowed on a command receipt. */
const ChatCommandReceiptMetadataSchema: z.ZodType<ChatCommandReceiptMetadata> = z
  .object({
    downstream: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('task'), turnId: z.string().min(1) }).strict(),
        z
          .object({
            kind: z.literal('goal'),
            goalId: z.string().min(1),
            turnId: z.string().min(1),
          })
          .strict(),
      ])
      .nullable(),
    resultKind: z.enum([
      'knowledge-answer',
      'repository-answer',
      'provider-answer',
      'clarification',
      'task-handoff',
      'goal-handoff',
      'refused',
    ]),
    status: z.union([z.literal(200), z.literal(202)]),
  })
  .strict();

const COMMAND_REQUEST_SELECT = `SELECT
  request_key AS key,
  command_name AS command,
  request_id AS requestId,
  scope_json AS scopeJson,
  input_hash AS inputHash,
  response_kind AS responseKind,
  response_id AS responseId,
  response_json AS responseJson,
  created_at AS createdAt,
  expires_at AS expiresAt
FROM idempotency_requests`;

/**
 * Rejects unsupported receipt fields and validates the sole bounded Chat metadata exception.
 *
 * @param command Command that owns the receipt.
 * @param response Candidate response pointer.
 * @returns Exact normalized response pointer safe for memory and SQLite persistence.
 * @throws Error when fields or Chat metadata exceed the accepted receipt contract.
 */
export function normalizeCommandRequestResponse(
  command: CommandRequestName,
  response: CommandRequestResponse
): CommandRequestResponse {
  if (Object.keys(response).some((key) => !['kind', 'id', 'chatMetadata'].includes(key))) {
    throw new Error('Command receipt response contains unsupported fields.');
  }
  if (response.chatMetadata === undefined) {
    return { kind: response.kind, id: response.id };
  }
  if (command !== 'chat.start') {
    throw new Error('Only chat.start may store extra command receipt metadata.');
  }
  const parsed = ChatCommandReceiptMetadataSchema.safeParse(response.chatMetadata);
  if (!parsed.success) {
    throw new Error('chat.start command receipt metadata is invalid.');
  }
  return { kind: response.kind, id: response.id, chatMetadata: parsed.data };
}

/**
 * Stores one command idempotency request in its owning scoped database.
 *
 * @param dataRoot Data root that owns the databases.
 * @param userId User that owns the request.
 * @param record Command request record to store.
 */
export function recordCommandRequestRecord(
  dataRoot: string,
  userId: string,
  record: CommandRequestRecord
): void {
  if (
    record.scope.workspaceId !== undefined &&
    !existsSync(
      resolveDataRootPath(
        dataRoot,
        'users',
        userId,
        'workspaces',
        record.scope.workspaceId,
        'workspace.json'
      )
    )
  ) {
    throw new Error(`Workspace not found: ${record.scope.workspaceId}`);
  }

  const db = openCommandRequestDb(dataRoot, userId, record.scope.workspaceId);

  try {
    recordCommandRequestRecordInDb(db, record);
  } finally {
    db.sqlite.close();
  }
}

/**
 * Stores one command request through an already open scoped database.
 *
 * @param db Open database that owns the request scope.
 * @param record Complete command request record.
 */
export function recordCommandRequestRecordInDb(
  db: CommandRequestDb,
  record: CommandRequestRecord
): void {
  const response = normalizeCommandRequestResponse(record.command, record.response);
  db.sqlite
    .prepare(
      `INSERT OR REPLACE INTO idempotency_requests (
        request_key,
        command_name,
        request_id,
        scope_json,
        input_hash,
        response_kind,
        response_id,
        response_json,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.key,
      record.command,
      record.requestId,
      JSON.stringify(record.scope),
      record.inputHash,
      response.kind,
      response.id,
      response.chatMetadata === undefined ? null : JSON.stringify(response.chatMetadata),
      record.createdAt,
      record.expiresAt
    );
  pruneCommandRequestRecords(db, new Date().toISOString());
}

/**
 * Gets one active command idempotency request from its owning scoped database.
 *
 * @param dataRoot Data root that owns the databases.
 * @param userId User that owns the request.
 * @param workspaceId Workspace owner, or undefined for user scope.
 * @param key Stable command request key.
 * @param referenceTime Current ISO timestamp used for expiry.
 * @returns Stored active request, or null.
 */
export function getCommandRequestRecord(
  dataRoot: string,
  userId: string,
  workspaceId: string | undefined,
  key: string,
  referenceTime: string
): CommandRequestRecord | null {
  if (
    workspaceId !== undefined &&
    !existsSync(
      resolveDataRootPath(dataRoot, 'users', userId, 'workspaces', workspaceId, 'workspace.json')
    )
  ) {
    return null;
  }

  const path =
    workspaceId === undefined
      ? userDbPath(dataRoot, userId)
      : workspaceDbPath(dataRoot, userId, workspaceId);

  if (!existsSync(path)) {
    return null;
  }

  const db = openCommandRequestDb(dataRoot, userId, workspaceId);

  try {
    return getCommandRequestRecordFromDb(db, key, referenceTime);
  } finally {
    db.sqlite.close();
  }
}

/**
 * Reads one active command request through an already open scoped database.
 *
 * @param db Open database that owns the request scope.
 * @param key Stable command request key.
 * @param referenceTime Current ISO timestamp used for expiry.
 * @returns Stored active request, or null.
 */
export function getCommandRequestRecordFromDb(
  db: CommandRequestDb,
  key: string,
  referenceTime: string
): CommandRequestRecord | null {
  pruneCommandRequestRecords(db, referenceTime);
  const row = db.sqlite.prepare(`${COMMAND_REQUEST_SELECT} WHERE request_key = ?`).get(key) as
    | CommandRequestRow
    | undefined;

  return row ? mapCommandRequestRow(row) : null;
}

/**
 * Lists active user- and workspace-owned command requests in deterministic order.
 *
 * @param dataRoot Data root that owns the databases.
 * @param userId User that owns the requests.
 * @param referenceTime Current ISO timestamp used for expiry.
 * @returns Active command request records.
 */
export function listCommandRequestRecords(
  dataRoot: string,
  userId: string,
  referenceTime: string
): CommandRequestRecord[] {
  const scopes: Array<string | undefined> = existsSync(userDbPath(dataRoot, userId))
    ? [undefined]
    : [];
  const workspacesRoot = resolveDataRootPath(dataRoot, 'users', userId, 'workspaces');

  if (existsSync(workspacesRoot)) {
    for (const entry of readdirSync(workspacesRoot, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (
        entry.isDirectory() &&
        entry.name !== '.staging' &&
        existsSync(workspaceDbPath(dataRoot, userId, entry.name))
      ) {
        scopes.push(entry.name);
      }
    }
  }

  const records = scopes.flatMap((workspaceId) => {
    const db = openCommandRequestDb(dataRoot, userId, workspaceId);

    try {
      pruneCommandRequestRecords(db, referenceTime);
      return (
        db.sqlite
          .prepare(`${COMMAND_REQUEST_SELECT} ORDER BY created_at ASC, request_key ASC`)
          .all() as CommandRequestRow[]
      ).map(mapCommandRequestRow);
    } finally {
      db.sqlite.close();
    }
  });

  return records.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.key.localeCompare(right.key)
  );
}

/**
 * Opens and migrates the database that owns one command request scope.
 *
 * @param dataRoot Data root that owns the database.
 * @param userId User that owns the database.
 * @param workspaceId Workspace owner, or undefined for user scope.
 * @returns Open migrated scoped database.
 */
function openCommandRequestDb(
  dataRoot: string,
  userId: string,
  workspaceId: string | undefined
): CommandRequestDb {
  const db =
    workspaceId === undefined
      ? openUserDb(dataRoot, userId)
      : openWorkspaceDb(dataRoot, userId, workspaceId);

  applyScopedMigrations(db);
  return db;
}

/**
 * Removes expired command requests from one open database.
 *
 * @param db Scoped database to prune.
 * @param referenceTime Current ISO timestamp used for expiry.
 */
function pruneCommandRequestRecords(db: CommandRequestDb, referenceTime: string): void {
  db.sqlite.prepare('DELETE FROM idempotency_requests WHERE expires_at <= ?').run(referenceTime);
}

/**
 * Maps one raw SQLite row to the public command request record.
 *
 * @param row Raw SQLite row.
 * @returns Command request record.
 */
function mapCommandRequestRow(row: CommandRequestRow): CommandRequestRecord {
  return {
    key: row.key,
    command: row.command,
    requestId: row.requestId,
    scope: JSON.parse(row.scopeJson) as CommandRequestScope,
    inputHash: row.inputHash,
    response: normalizeCommandRequestResponse(row.command, {
      kind: row.responseKind,
      id: row.responseId,
      ...(row.responseJson === null ? {} : { chatMetadata: JSON.parse(row.responseJson) }),
    }),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
