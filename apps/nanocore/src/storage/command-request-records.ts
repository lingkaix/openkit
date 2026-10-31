import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ArtifactIdSchema,
  ArtifactReviewIdSchema,
  compareCodeUnits,
  InvitationIdSchema,
  KnowledgeReviewIdSchema,
  KnowledgeSourceIdSchema,
  MaterialIdSchema,
  MaterialRevisionIdSchema,
  PresentationIdSchema,
  ResourceCandidateIdSchema,
  readRetainedV1,
  ThreadIdSchema,
  TurnIdSchema,
  UserIdSchema,
  VaultGrantIdSchema,
  VaultReferenceIdSchema,
  WorkerStorageTargetIdSchema,
  WorkspaceIdSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { assertScopeAdmitted } from '../bootstrap/readiness.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import type {
  CommandRequestName,
  CommandRequestRecord,
  CommandRequestResponse,
  CommandRequestResponseKind,
  CommandRequestScope,
  ConversationCommandReceiptMetadata,
} from '../lib/store.js';
import type { AppDb } from './app-db.js';
import { lightAppDbPath, openExistingAppDb } from './app-db.js';
import {
  CONTROL_NATIVE_EVALUATION_RECEIPT_SQL,
  CONTROL_NATIVE_RECEIPT_COMMANDS,
  pruneControlAdmissionReceipts,
} from './control-store-admission.js';
import {
  assertControlProductWriter,
  openControlStoreProductReadHandle,
} from './control-store-products.js';
import type { ControlSqlStatement } from './control-store-worker-protocol.js';
import {
  bindWorkspaceSqlite,
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
  readonly schemaVersion?: number;
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
type CommandRequestDb = CoreDb | UserDb | WorkspaceDb | AppDb;

/** Exact physical owner selected by one command request scope. */
type CommandRequestOwner =
  | { readonly scope: 'core' }
  | { readonly scope: 'user'; readonly userId: string }
  | { readonly scope: 'workspace'; readonly workspaceId: string }
  | { readonly scope: 'app'; readonly workspaceId: string; readonly appId: string };

/** Fixed v1 payload for the sole extra metadata allowed on a retained command receipt. */
const StoredConversationMetadataV1Schema = z
  .object({
    targetRef: z.string().min(1),
    logicalModelId: z.string().min(1).nullable(),
    receivingWorkspaceId: WorkspaceIdSchema,
    receivingThreadId: ThreadIdSchema,
    downstream: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('task'), turnId: TurnIdSchema }).strict(),
        z
          .object({
            kind: z.literal('goal'),
            goalId: z.string().min(1),
            turnId: TurnIdSchema,
          })
          .strict(),
      ])
      .nullable(),
    resultKind: z.enum([
      'knowledge-answer',
      'provider-answer',
      'clarification',
      'task-handoff',
      'goal-handoff',
      'worker-turn',
      'goal-intent',
      'goal-steering',
      'refused',
    ]),
    status: z.union([z.literal(200), z.literal(202)]),
  })
  .strict();

/** Retained descriptive metadata is normalized without relaxing current receipt emission. */
const StoredConversationMetadataV1ReaderSchema = StoredConversationMetadataV1Schema.extend({
  downstream: z
    .discriminatedUnion('kind', [
      StoredConversationMetadataV1Schema.shape.downstream.unwrap().options[0].strip(),
      StoredConversationMetadataV1Schema.shape.downstream.unwrap().options[1].strip(),
    ])
    .nullable(),
}).strip();

/** The response discriminator selects its declared entity owner; other owners keep opaque keys. */
const COMMAND_RESPONSE_ID_SCHEMAS: Record<CommandRequestResponseKind, z.ZodType<string> | null> = {
  workspace: WorkspaceIdSchema,
  workspace_invitation: InvitationIdSchema,
  workspace_member: null,
  workspace_recovery: WorkspaceIdSchema,
  workspace_deletion: null,
  user: UserIdSchema,
  knowledge: null,
  knowledge_notebook_revision: null,
  knowledge_source: KnowledgeSourceIdSchema,
  thread: ThreadIdSchema,
  turn: TurnIdSchema,
  approval: null,
  pending_request: null,
  git_push_record: null,
  artifact: ArtifactIdSchema,
  artifact_review: ArtifactReviewIdSchema,
  evaluation_candidate_set: null,
  evaluation_judgement: null,
  workspace_sync_review: null,
  knowledge_proposal: null,
  knowledge_proposal_review: KnowledgeReviewIdSchema,
  light_app_definition: null,
  light_app_catalog: WorkspaceIdSchema,
  skill_version: null,
  skill_catalog: WorkspaceIdSchema,
  skill_candidate: ResourceCandidateIdSchema,
  goal: null,
  goal_plan: null,
  goal_review: null,
  pending_user_turn: null,
  steering_terminal_outcome: null,
  material: MaterialIdSchema,
  material_revision: MaterialRevisionIdSchema,
  thread_material_binding: MaterialIdSchema,
  light_app: null,
  light_app_record: null,
  light_app_batch: null,
  generative_presentation: PresentationIdSchema,
  worker_environment: WorkerStorageTargetIdSchema,
  catalog_mcp: null,
  vault_reference: VaultReferenceIdSchema,
  vault_grant: VaultGrantIdSchema,
};

const APP_COMMAND_REQUEST_SELECT = `SELECT
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

/** App receipts retain the existing native Kernel format; Core/User/Workspace version their JSON row. */
const COMMAND_REQUEST_SELECT = APP_COMMAND_REQUEST_SELECT.replace(
  'SELECT\n',
  'SELECT\n  schema_version AS schemaVersion,\n'
);

/** The owning database selects the versioned Core row or the separately versioned native App row. */
function commandRequestSelect(db: CommandRequestDb): string {
  return db.scope === 'app' ? APP_COMMAND_REQUEST_SELECT : COMMAND_REQUEST_SELECT;
}

/** Fixed retained scope payload; resolving the exact database owner remains a separate existing check. */
const StoredCommandScopeV1Schema = z.record(z.string(), z.string());

/**
 * Validates kind-named response pointers, rejects unsupported fields and validates bounded Chat metadata.
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
  if (!Object.hasOwn(COMMAND_RESPONSE_ID_SCHEMAS, response.kind)) {
    throw new Error('Command receipt response kind is unsupported.');
  }
  COMMAND_RESPONSE_ID_SCHEMAS[response.kind]?.parse(response.id);
  if (response.conversationMetadata === undefined) {
    return { kind: response.kind, id: response.id };
  }
  if (command !== 'conversation.submit') {
    throw new Error('Only conversation.submit may store extra command receipt metadata.');
  }
  const parsed = StoredConversationMetadataV1Schema.safeParse(response.conversationMetadata);
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
  const response = normalizeCommandRequestResponse(record.command, record.response);

  if (owner.scope === 'workspace' && !workspaceRecordExists(dataRoot, owner.workspaceId)) {
    throw new Error(`Workspace not found: ${owner.workspaceId}`);
  }
  if (owner.scope === 'app' && !workspaceRecordExists(dataRoot, owner.workspaceId)) {
    throw new Error(`Workspace not found: ${owner.workspaceId}`);
  }

  const db = openCommandRequestDb(dataRoot, owner);

  try {
    recordCommandRequestRecordInDb(db, { ...record, response });
  } finally {
    db.sqlite.close();
  }
}

/** Resolves shared judgement receipt ownership from its actual retained target, never a new scope marker. */
function nativeEvaluationReceipt(db: CommandRequestDb, record: CommandRequestRecord): boolean {
  if (db.scope !== 'workspace' || record.command !== 'evaluation.judgement-add') return false;
  return (
    !!db.sqlite
      .prepare(
        `SELECT 1 FROM idempotency_requests WHERE request_key=? AND ${CONTROL_NATIVE_EVALUATION_RECEIPT_SQL}`
      )
      .get(record.key) ||
    !!db.sqlite
      .prepare(`SELECT 1 WHERE EXISTS (SELECT 1 FROM artifact_reviews AS review,json_each(review.judgements) AS annotation WHERE review.workspace_id=? AND json_extract(annotation.value,'$.requestId')=?)
      OR EXISTS (SELECT 1 FROM workspace_material_revisions AS revision,json_each(revision.judgements) AS annotation WHERE revision.workspace_id=? AND json_extract(annotation.value,'$.requestId')=?)`)
      .get(db.workspaceId, record.requestId, db.workspaceId, record.requestId)
  );
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
  if (
    (db.scope === 'core' || db.scope === 'workspace') &&
    (CONTROL_NATIVE_RECEIPT_COMMANDS.some((command) => command === record.command) ||
      nativeEvaluationReceipt(db, record))
  ) {
    throw new Error('Native admission receipts belong to the database worker.');
  }
  writeCommandRequestRecordInDb(db, record);
  pruneCommandRequestRecords(db, new Date().toISOString());
}

/** Writes one original native receipt inside its complete owning command tuple, with only the native operation/scope maintenance partition. */
export function recordControlCommandRequestRecordInDb(
  db: CoreDb | WorkspaceDb,
  record: CommandRequestRecord
): void {
  assertControlProductWriter(db.sqlite);
  assertCommandRequestDbOwner(db, record.scope);
  if (
    !CONTROL_NATIVE_RECEIPT_COMMANDS.some((command) => command === record.command) &&
    !nativeEvaluationReceipt(db, record)
  )
    throw new Error('The command has no native receipt owner.');
  writeCommandRequestRecordInDb(db, record);
  pruneControlAdmissionReceipts(
    db.sqlite,
    db.scope === 'core' ? { kind: 'server' } : { kind: 'workspace', workspaceId: db.workspaceId },
    record.createdAt
  );
}

/** Preserves the existing complete row read/check/write body; public entry points own authority and disjoint pruning. */
function writeCommandRequestRecordInDb(db: CommandRequestDb, record: CommandRequestRecord): void {
  const scope = StoredCommandScopeV1Schema.parse(record.scope);
  const response = normalizeCommandRequestResponse(record.command, record.response);
  const previous = db.sqlite
    .prepare(`${commandRequestSelect(db)} WHERE request_key = ?`)
    .get(record.key) as CommandRequestRow | undefined;
  if (previous && db.scope !== 'app') readRetainedV1(previous, () => undefined);
  let responseJson =
    response.conversationMetadata === undefined
      ? null
      : JSON.stringify(response.conversationMetadata);
  if (
    previous?.responseJson &&
    previous.command === record.command &&
    previous.inputHash === record.inputHash &&
    previous.scopeJson === JSON.stringify(scope) &&
    previous.responseKind === response.kind &&
    previous.responseId === response.id
  ) {
    const retained =
      db.scope === 'app' ? decodeCommandRequestPayloadV1(previous) : mapCommandRequestRow(previous);
    if (JSON.stringify(retained.response) === JSON.stringify(response))
      responseJson = previous.responseJson;
  }
  const values = commandRequestValues(record);
  values.response_json = responseJson;
  const columns = Object.keys(values).filter(
    (column) => db.scope !== 'app' || column !== 'schema_version'
  ) as (keyof typeof values)[];
  db.sqlite
    .prepare(
      `INSERT OR REPLACE INTO idempotency_requests (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((column) => values[column]));
}

/** One serialization owner for current scoped writes and later native command composition. */
function commandRequestValues(record: CommandRequestRecord) {
  const scope = StoredCommandScopeV1Schema.parse(record.scope);
  const response = normalizeCommandRequestResponse(record.command, record.response);
  return {
    schema_version: writeRetainedV1({}).schemaVersion,
    request_key: record.key,
    command_name: record.command,
    request_id: record.requestId,
    scope_json: JSON.stringify(scope),
    input_hash: record.inputHash,
    response_kind: response.kind,
    response_id: response.id,
    response_json:
      response.conversationMetadata === undefined
        ? null
        : JSON.stringify(response.conversationMetadata),
    created_at: record.createdAt,
    expires_at: record.expiresAt,
  };
}

/**
 * Prepares the original Workspace receipt for its caller's complete native tuple.
 *
 * This pure operation neither activates a command nor grants admission. The caller
 * retains the original key, input, scope, clock and response facts and must select
 * the matching physical Workspace writer. An existing key refuses the transaction;
 * replay must use the original receipt before attempting a fresh effect. Unlike
 * the legacy writer, this insertion cannot replace another command outcome.
 *
 * @param workspaceId Explicit Workspace owning the native transition.
 * @param record Original command completion, never a reconstructed success.
 * @returns One trusted statement for the existing native savepoint and FULL ACK.
 */
export function prepareControlCommandRequestStatement(
  workspaceId: string,
  record: CommandRequestRecord
): Extract<ControlSqlStatement, { mode: 'run' }> {
  WorkspaceIdSchema.parse(workspaceId);
  const owner = commandRequestOwner(StoredCommandScopeV1Schema.parse(record.scope));
  if (owner.scope !== 'workspace' || owner.workspaceId !== workspaceId)
    throw new Error('Native command receipt requires its exact Workspace owner.');
  const values = commandRequestValues(record);
  const columns = Object.keys(values);
  return {
    mode: 'run',
    sql: `INSERT INTO idempotency_requests (${columns.join(', ')})
          VALUES (${columns.map(() => '?').join(', ')})`,
    parameters: Object.values(values),
    expectChanges: 1,
  };
}

/**
 * Gets one active command idempotency request from its owning scoped database.
 *
 * Native product lookups do not prune; unrelated Main-owned families retain their existing expiry maintenance.
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
  if (owner.scope === 'app' && !workspaceRecordExists(dataRoot, owner.workspaceId)) {
    return null;
  }

  const path =
    owner.scope === 'core'
      ? coreDbPath(dataRoot)
      : owner.scope === 'user'
        ? userDbPath(dataRoot, owner.userId)
        : owner.scope === 'app'
          ? lightAppDbPath(dataRoot, owner.workspaceId, owner.appId)
          : workspaceDbPath(dataRoot, owner.workspaceId);

  if (!existsSync(path)) {
    return null;
  }

  const db = openCommandRequestDb(dataRoot, owner);

  try {
    // commandRequestKey owns the operation prefix; this selects maintenance, never authority.
    const workerOwnedKey =
      (db.scope === 'core' || db.scope === 'workspace') &&
      (CONTROL_NATIVE_RECEIPT_COMMANDS.some((command) => key.startsWith(`${command}|`)) ||
        key.startsWith('evaluation.judgement-add|'));
    if (!workerOwnedKey) pruneCommandRequestRecords(db, referenceTime);
    return getCommandRequestRecordFromDb(db, key, referenceTime);
  } finally {
    db.sqlite.close();
  }
}

/**
 * Reads whether the published Workspace has native canonical metadata, without a file-authority fallback or migration.
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
  const path = workspaceDbPath(dataRoot, workspaceId);
  if (!existsSync(path)) return false;
  const reader = openControlStoreProductReadHandle(path, { kind: 'workspace', workspaceId });
  try {
    return reader.get('workspace', workspaceId) !== undefined;
  } finally {
    reader.close();
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
  const row = db.sqlite.prepare(`${commandRequestSelect(db)} WHERE request_key = ?`).get(key) as
    | CommandRequestRow
    | undefined;

  if (!row) {
    return null;
  }

  const record =
    db.scope === 'app' ? decodeCommandRequestPayloadV1(row) : mapCommandRequestRow(row);
  assertCommandRequestDbOwner(db, record.scope);
  if (record.expiresAt <= referenceTime) {
    if (db.scope === 'app') {
      throw new KernelCommandError(
        'recovery_required',
        'The original request requires recovery and cannot be replayed.'
      );
    }
    return null;
  }
  return record;
}

/** Reads retained receipts on the caller's scoped connection without migration, pruning, or another write connection. */
export function readCommandRequestRecordsFromSqlite(
  sqlite: Database.Database
): CommandRequestRecord[] {
  return (sqlite.prepare(COMMAND_REQUEST_SELECT).all() as CommandRequestRow[]).map(
    mapCommandRequestRow
  );
}

/** Read-only inventory of command receipts, including expired rows. */
export type DurableCommandRequestRead =
  | { readonly records: readonly CommandRequestRecord[]; readonly status: 'readable' }
  | { readonly status: 'unreadable' };

/**
 * Reads every existing command receipt without pruning, migrating, or creating a database.
 *
 * Expired rows remain visible so cleanup cannot treat a pruned receipt as absent provenance.
 *
 * @param dataRoot Data root whose existing Core, User, and Workspace databases should be read.
 * @returns Receipt rows, or `unreadable` when a database or row cannot be read.
 */
export function readDurableCommandRequestRecords(dataRoot: string): DurableCommandRequestRead {
  try {
    const records: CommandRequestRecord[] = [];
    for (const path of existingCommandRequestDatabasePaths(dataRoot)) {
      const sqlite = new Database(path, { fileMustExist: true, readonly: true });
      try {
        const table = sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get('idempotency_requests') as { name: string } | undefined;
        if (!table) {
          return { status: 'unreadable' };
        }
        const rows = sqlite
          .prepare(`${COMMAND_REQUEST_SELECT} ORDER BY created_at ASC, request_key ASC`)
          .all() as CommandRequestRow[];
        for (const row of rows) {
          records.push(mapCommandRequestRow(row));
        }
      } finally {
        sqlite.close();
      }
    }
    records.sort(
      (left, right) =>
        compareCodeUnits(left.createdAt, right.createdAt) || compareCodeUnits(left.key, right.key)
    );
    return { records, status: 'readable' };
  } catch {
    return { status: 'unreadable' };
  }
}

/**
 * Lists database files that already exist for command receipts.
 *
 * @param dataRoot Data root to inspect.
 * @returns Existing Core, User, and Workspace database paths.
 * @throws Error when a scanned directory contains a symbolic link.
 */
function existingCommandRequestDatabasePaths(dataRoot: string): string[] {
  const paths: string[] = [];
  const corePath = coreDbPath(dataRoot);
  if (existsSync(corePath)) {
    paths.push(corePath);
  }
  const usersRoot = resolveDataRootPath(dataRoot, 'users');
  if (existsSync(usersRoot)) {
    for (const entry of readdirSync(usersRoot, { withFileTypes: true }).sort((left, right) =>
      compareCodeUnits(left.name, right.name)
    )) {
      if (entry.isSymbolicLink()) {
        throw new Error('Command receipt user directory is symbolic.');
      }
      if (!entry.isDirectory()) continue;
      const path = userDbPath(dataRoot, entry.name);
      if (existsSync(path)) paths.push(path);
    }
  }
  const workspacesRoot = resolveDataRootPath(dataRoot, 'workspaces');
  if (existsSync(workspacesRoot)) {
    for (const entry of readdirSync(workspacesRoot, { withFileTypes: true }).sort((left, right) =>
      compareCodeUnits(left.name, right.name)
    )) {
      if (entry.isSymbolicLink()) {
        throw new Error('Command receipt workspace directory is symbolic.');
      }
      if (!entry.isDirectory() || entry.name === '.staging') continue;
      const path = workspaceDbPath(dataRoot, entry.name);
      if (existsSync(path)) paths.push(path);
    }
  }
  return paths;
}

/**
 * Lists active User- and Workspace-owned command requests in deterministic order.
 *
 * @param dataRoot Data root that owns the databases.
 * @param referenceTime Current ISO timestamp used for expiry.
 * @param workspaceId Optional exact Workspace owner, excluding all other database opens.
 * @returns Active command request records.
 */
export function listCommandRequestRecords(
  dataRoot: string,
  referenceTime: string,
  workspaceId?: string
): CommandRequestRecord[] {
  if (workspaceId !== undefined) assertScopeAdmitted(dataRoot, 'workspace', workspaceId);
  const owners: CommandRequestOwner[] =
    workspaceId === undefined
      ? []
      : [{ scope: 'workspace', workspaceId: WorkspaceIdSchema.parse(workspaceId) }];
  const usersRoot = resolveDataRootPath(dataRoot, 'users');
  const workspacesRoot = resolveDataRootPath(dataRoot, 'workspaces');

  if (workspaceId === undefined && existsSync(usersRoot)) {
    for (const entry of readdirSync(usersRoot, { withFileTypes: true }).sort((left, right) =>
      compareCodeUnits(left.name, right.name)
    )) {
      if (entry.isDirectory() && existsSync(userDbPath(dataRoot, entry.name))) {
        owners.push({ scope: 'user', userId: entry.name });
      }
    }
  }

  if (workspaceId === undefined && existsSync(workspacesRoot)) {
    for (const entry of readdirSync(workspacesRoot, { withFileTypes: true }).sort((left, right) =>
      compareCodeUnits(left.name, right.name)
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
    const db =
      workspaceId === undefined
        ? openCommandRequestDb(dataRoot, owner)
        : bindWorkspaceSqlite(
            openControlStoreProductReadHandle(workspaceDbPath(dataRoot, workspaceId), {
              kind: 'workspace',
              workspaceId,
            }).sqlite,
            dataRoot,
            workspaceId
          );

    try {
      return (
        db.sqlite
          .prepare(`${COMMAND_REQUEST_SELECT} ORDER BY created_at ASC, request_key ASC`)
          .all() as CommandRequestRow[]
      )
        .map((row) => {
          const record = mapCommandRequestRow(row);
          assertCommandRequestDbOwner(db, record.scope);
          return record;
        })
        .filter((record) => record.expiresAt > referenceTime);
    } finally {
      db.sqlite.close();
    }
  });

  return records.sort(
    (left, right) =>
      compareCodeUnits(left.createdAt, right.createdAt) || compareCodeUnits(left.key, right.key)
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
  if (owner.scope === 'app') {
    return openExistingAppDb(dataRoot, owner.workspaceId, owner.appId);
  }
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
  const appId = scope.appId;

  if (
    coreId === 'server' &&
    userId === undefined &&
    workspaceId === undefined &&
    appId === undefined
  ) {
    return { scope: 'core' };
  }
  if (coreId === undefined && userId && workspaceId === undefined && appId === undefined) {
    return { scope: 'user', userId };
  }
  if (coreId === undefined && workspaceId && userId === undefined && appId) {
    return { scope: 'app', workspaceId, appId };
  }
  if (coreId === undefined && workspaceId && userId === undefined && appId === undefined) {
    return { scope: 'workspace', workspaceId };
  }

  throw new Error(
    'Command request scope must name exactly one Core, User, Workspace, or App owner.'
  );
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
  if (
    db.scope === 'app' &&
    owner.scope === 'app' &&
    owner.workspaceId === db.workspaceId &&
    owner.appId === db.appId
  ) {
    return;
  }

  throw new Error('Command request scope does not match its owning database.');
}

/**
 * Removes expired main-owned receipts after a main-owned write; worker receipts remain with their tuple owner.
 *
 * @param db Scoped database to prune.
 * @param referenceTime Current ISO timestamp used for expiry.
 */
function pruneCommandRequestRecords(db: CommandRequestDb, referenceTime: string): void {
  if (db.scope === 'app') {
    return;
  }
  if (db.scope === 'user') {
    db.sqlite.prepare('DELETE FROM idempotency_requests WHERE expires_at <= ?').run(referenceTime);
    return;
  }

  db.sqlite
    .prepare(
      `DELETE FROM idempotency_requests WHERE expires_at <= ? AND command_name NOT IN (${CONTROL_NATIVE_RECEIPT_COMMANDS.map(() => '?').join(',')})${db.scope === 'workspace' ? ` AND NOT ${CONTROL_NATIVE_EVALUATION_RECEIPT_SQL}` : ''}`
    )
    .run(referenceTime, ...CONTROL_NATIVE_RECEIPT_COMMANDS);
}

/**
 * Maps one raw SQLite row to the public command request record.
 *
 * @param row Raw SQLite row.
 * @returns Command request record.
 */
export function mapCommandRequestRow(row: CommandRequestRow): CommandRequestRecord {
  return readRetainedV1(row, () => decodeCommandRequestPayloadV1(row));
}

/** Decodes the fixed receipt payload after its SQL row or native App format has been admitted. */
function decodeCommandRequestPayloadV1(row: CommandRequestRow): CommandRequestRecord {
  return {
    key: row.key,
    command: row.command,
    requestId: row.requestId,
    scope: StoredCommandScopeV1Schema.parse(JSON.parse(row.scopeJson)),
    inputHash: row.inputHash,
    response: normalizeCommandRequestResponse(row.command, {
      kind: row.responseKind,
      id: row.responseId,
      ...(row.responseJson === null
        ? {}
        : { conversationMetadata: readConversationMetadata(row.responseJson) }),
    }),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/** Reads only the retained metadata core before exact response-pointer validation. */
function readConversationMetadata(json: string): ConversationCommandReceiptMetadata {
  const result = StoredConversationMetadataV1ReaderSchema.safeParse(JSON.parse(json));
  if (!result.success) throw new Error('conversation.submit command receipt metadata is invalid.');
  return result.data;
}

const COMMAND_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Builds a stable string key for one command idempotency scope.
 *
 * @param scope Non-secret command scope ids.
 * @returns Stable scope key.
 */
function commandRequestScopeKey(scope: CommandRequestScope): string {
  return Object.entries(scope)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

/**
 * Builds the internal map key for one command idempotency record.
 *
 * @param command Stable command name.
 * @param requestId Caller-provided idempotency id.
 * @param scope Non-secret command scope ids.
 * @returns Internal command request key.
 */
export function commandRequestKey(
  command: CommandRequestName,
  requestId: string,
  scope: CommandRequestScope
): string {
  return `${command}|${requestId}|${commandRequestScopeKey(scope)}`;
}

/**
 * Computes the default expiry timestamp for an idempotency record.
 *
 * @param createdAt Record creation timestamp.
 * @returns Expiry timestamp after the retention window.
 */
export function commandRequestExpiresAt(createdAt: string): string {
  return new Date(new Date(createdAt).getTime() + COMMAND_REQUEST_RETENTION_MS).toISOString();
}
