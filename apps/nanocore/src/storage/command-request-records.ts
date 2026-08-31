import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type {
  CommandRequestName,
  CommandRequestRecord,
  CommandRequestResponse,
  CommandRequestResponseKind,
  CommandRequestScope,
  ConversationCommandReceiptMetadata,
} from '../lib/store.js';
import {
  type CoreDb,
  openCoreDb,
  openUserDb,
  openWorkspaceDb,
  type UserDb,
  type WorkspaceDb,
} from './db.js';
import { coreDbPath, resolveDataRootPath, userDbPath, workspaceDbPath } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

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
type CommandRequestDb = CoreDb | UserDb | WorkspaceDb;

/** Exact physical owner selected by one command request scope. */
type CommandRequestOwner =
  | { readonly scope: 'core' }
  | { readonly scope: 'user'; readonly userId: string }
  | { readonly scope: 'workspace'; readonly workspaceId: string };

/** Closed schema for the sole extra metadata allowed on a command receipt. */
const ConversationCommandReceiptMetadataSchema: z.ZodType<ConversationCommandReceiptMetadata> = z
  .object({
    targetRef: z.string().min(1),
    logicalModelId: z.string().min(1).nullable(),
    receivingWorkspaceId: z.string().min(1),
    receivingThreadId: z.string().min(1),
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
      'worker-turn',
      'goal-steering',
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
  if (Object.keys(response).some((key) => !['kind', 'id', 'conversationMetadata'].includes(key))) {
    throw new Error('Command receipt response contains unsupported fields.');
  }
  if (response.conversationMetadata === undefined) {
    return { kind: response.kind, id: response.id };
  }
  if (command !== 'conversation.submit') {
    throw new Error('Only conversation.submit may store extra command receipt metadata.');
  }
  const parsed = ConversationCommandReceiptMetadataSchema.safeParse(response.conversationMetadata);
  if (!parsed.success) {
    throw new Error('conversation.submit command receipt metadata is invalid.');
  }
  return { kind: response.kind, id: response.id, conversationMetadata: parsed.data };
}

/**
 * Stores one command idempotency request in its owning scoped database.
 *
 * @param dataRoot Data root that owns the databases.
 * @param record Command request record to store.
 * @throws Error when the scope has no exact Core, User, or Workspace owner.
 */
export function recordCommandRequestRecord(dataRoot: string, record: CommandRequestRecord): void {
  const owner = commandRequestOwner(record.scope);

  if (owner.scope === 'workspace' && !workspaceRecordExists(dataRoot, owner.workspaceId)) {
    throw new Error(`Workspace not found: ${owner.workspaceId}`);
  }

  const db = openCommandRequestDb(dataRoot, owner);

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
  assertCommandRequestDbOwner(db, record.scope);
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
      response.conversationMetadata === undefined
        ? null
        : JSON.stringify(response.conversationMetadata),
      record.createdAt,
      record.expiresAt
    );
  pruneCommandRequestRecords(db, new Date().toISOString());
}

/**
 * Gets one active command idempotency request from its owning scoped database.
 *
 * @param dataRoot Data root that owns the databases.
 * @param scope Exact Core, User, or Workspace request owner.
 * @param key Stable command request key.
 * @param referenceTime Current ISO timestamp used for expiry.
 * @returns Stored active request, or null.
 * @throws Error when the scope has no exact Core, User, or Workspace owner.
 */
export function getCommandRequestRecord(
  dataRoot: string,
  scope: CommandRequestScope,
  key: string,
  referenceTime: string
): CommandRequestRecord | null {
  const owner = commandRequestOwner(scope);

  if (owner.scope === 'workspace' && !workspaceRecordExists(dataRoot, owner.workspaceId)) {
    return null;
  }

  const path =
    owner.scope === 'core'
      ? coreDbPath(dataRoot)
      : owner.scope === 'user'
        ? userDbPath(dataRoot, owner.userId)
        : workspaceDbPath(dataRoot, owner.workspaceId);

  if (!existsSync(path)) {
    return null;
  }

  const db = openCommandRequestDb(dataRoot, owner);

  try {
    return getCommandRequestRecordFromDb(db, key, referenceTime);
  } finally {
    db.sqlite.close();
  }
}

/**
 * Returns whether one Workspace has the current canonical record and rejects the retired name.
 *
 * @param dataRoot Data root that owns the Workspace.
 * @param workspaceId Workspace identity to inspect.
 * @returns Whether the current canonical record exists.
 */
function workspaceRecordExists(dataRoot: string, workspaceId: string): boolean {
  const workspaceRoot = resolveDataRootPath(dataRoot, 'workspaces', workspaceId);
  const retiredPath = join(workspaceRoot, 'workspace.json');
  if (existsSync(retiredPath)) {
    throw new Error(`Unsupported canonical workspace file workspace.json: ${workspaceId}.`);
  }
  return existsSync(join(workspaceRoot, 'workspace-record.json'));
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

  if (!row) {
    return null;
  }

  const record = mapCommandRequestRow(row);
  assertCommandRequestDbOwner(db, record.scope);
  return record;
}

/**
 * Lists active User- and Workspace-owned command requests in deterministic order.
 *
 * @param dataRoot Data root that owns the databases.
 * @param referenceTime Current ISO timestamp used for expiry.
 * @returns Active command request records.
 */
export function listCommandRequestRecords(
  dataRoot: string,
  referenceTime: string
): CommandRequestRecord[] {
  const owners: CommandRequestOwner[] = [];
  const usersRoot = resolveDataRootPath(dataRoot, 'users');
  const workspacesRoot = resolveDataRootPath(dataRoot, 'workspaces');

  if (existsSync(usersRoot)) {
    for (const entry of readdirSync(usersRoot, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (entry.isDirectory() && existsSync(userDbPath(dataRoot, entry.name))) {
        owners.push({ scope: 'user', userId: entry.name });
      }
    }
  }

  if (existsSync(workspacesRoot)) {
    for (const entry of readdirSync(workspacesRoot, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (
        entry.isDirectory() &&
        entry.name !== '.staging' &&
        existsSync(workspaceDbPath(dataRoot, entry.name))
      ) {
        owners.push({ scope: 'workspace', workspaceId: entry.name });
      }
    }
  }

  const records = owners.flatMap((owner) => {
    const db = openCommandRequestDb(dataRoot, owner);

    try {
      pruneCommandRequestRecords(db, referenceTime);
      return (
        db.sqlite
          .prepare(`${COMMAND_REQUEST_SELECT} ORDER BY created_at ASC, request_key ASC`)
          .all() as CommandRequestRow[]
      ).map((row) => {
        const record = mapCommandRequestRow(row);
        assertCommandRequestDbOwner(db, record.scope);
        return record;
      });
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
 * @param owner Exact Core, User, or Workspace database owner.
 * @returns Open migrated scoped database.
 */
function openCommandRequestDb(dataRoot: string, owner: CommandRequestOwner): CommandRequestDb {
  const db =
    owner.scope === 'core'
      ? openCoreDb(dataRoot)
      : owner.scope === 'user'
        ? openUserDb(dataRoot, owner.userId)
        : openWorkspaceDb(dataRoot, owner.workspaceId);

  if (db.scope === 'core') {
    applyMigrations(db);
  } else {
    applyScopedMigrations(db);
  }
  return db;
}

/**
 * Selects one exact durable owner from a command request scope.
 *
 * @param scope Non-secret command scope identifiers.
 * @returns Exact Core, User, or Workspace database owner.
 * @throws Error when the scope names zero or multiple owners.
 */
function commandRequestOwner(scope: CommandRequestScope): CommandRequestOwner {
  const coreId = scope.coreId;
  const userId = scope.userId;
  const workspaceId = scope.workspaceId;

  if (coreId === 'server' && userId === undefined && workspaceId === undefined) {
    return { scope: 'core' };
  }
  if (coreId === undefined && userId && workspaceId === undefined) {
    return { scope: 'user', userId };
  }
  if (coreId === undefined && workspaceId && userId === undefined) {
    return { scope: 'workspace', workspaceId };
  }

  throw new Error('Command request scope must name exactly one Core, User, or Workspace owner.');
}

/**
 * Verifies that one open database matches a command request's authoritative scope.
 *
 * @param db Open Core, User, or Workspace database.
 * @param scope Command request scope stored in or destined for that database.
 * @throws Error when the request scope selects a different durable owner.
 */
function assertCommandRequestDbOwner(db: CommandRequestDb, scope: CommandRequestScope): void {
  const owner = commandRequestOwner(scope);

  if (db.scope === 'core' && owner.scope === 'core') {
    return;
  }
  if (db.scope === 'user' && owner.scope === 'user' && owner.userId === db.userId) {
    return;
  }
  if (
    db.scope === 'workspace' &&
    owner.scope === 'workspace' &&
    owner.workspaceId === db.workspaceId
  ) {
    return;
  }

  throw new Error('Command request scope does not match its owning database.');
}

/**
 * Removes expired command requests from one open database.
 *
 * @param db Scoped database to prune.
 * @param referenceTime Current ISO timestamp used for expiry.
 */
function pruneCommandRequestRecords(db: CommandRequestDb, referenceTime: string): void {
  if (db.scope === 'core' || db.scope === 'user') {
    db.sqlite.prepare('DELETE FROM idempotency_requests WHERE expires_at <= ?').run(referenceTime);
    return;
  }

  db.sqlite
    .prepare(
      `DELETE FROM idempotency_requests
       WHERE expires_at <= ?
         AND NOT (
           command_name = 'goal.steering.send'
           AND response_kind = 'pending_user_turn'
           AND EXISTS (
             SELECT 1
             FROM pending_user_turn_records AS pending
             WHERE pending.pending_turn_id = idempotency_requests.response_id
               AND pending.request_id = idempotency_requests.request_id
               AND pending.workspace_id = json_extract(idempotency_requests.scope_json, '$.workspaceId')
               AND pending.thread_id = json_extract(idempotency_requests.scope_json, '$.threadId')
           )
         )`
    )
    .run(referenceTime);
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
      ...(row.responseJson === null ? {} : { conversationMetadata: JSON.parse(row.responseJson) }),
    }),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
