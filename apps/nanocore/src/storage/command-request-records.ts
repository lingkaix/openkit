import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compareCodeUnits, readRetainedV1, WorkspaceIdSchema } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { assertScopeAdmitted } from '../bootstrap/readiness.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import type {
  CommandRequestName,
  CommandRequestRecord,
  CommandRequestResponseKind,
  CommandRequestScope,
} from '../lib/store.js';
import type { AppDb } from './app-db.js';
import { lightAppDbPath, openExistingAppDb } from './app-db.js';
import {
  CATALOG_COMMAND_RECEIPTS,
  type ControlCatalogCommandReceiptInput,
  ControlCatalogCommandReceiptInputSchema,
} from './catalog-command-receipt-codecs.js';
import {
  type CommandRequestOwner,
  commandRequestOwner,
  commandRequestValues,
  normalizeCommandRequestResponse,
  parseStoredCommandScope,
  prepareControlCommandRequestStatement,
  readCommandResponseMetadata,
} from './command-request-codecs.js';
import {
  CONTROL_NATIVE_EVALUATION_RECEIPT_SQL,
  pruneControlAdmissionReceipts,
} from './control-store-admission.js';
import {
  CONTROL_NATIVE_CORE_LIFECYCLE_COMMANDS,
  CONTROL_NATIVE_RECEIPT_COMMANDS,
  CONTROL_NATIVE_USER_RECEIPT_COMMANDS,
  CONTROL_NATIVE_WORKSPACE_KNOWLEDGE_COMMANDS,
  isControlNativeReceiptCommand,
} from './control-store-admission-codecs.js';
import {
  ControlProductPreconditionError,
  openControlStoreProductReadHandle,
} from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import {
  bindCoreSqlite,
  bindWorkspaceSqlite,
  type CoreDb,
  openCoreDb,
  openUserDb,
  openUserReadDb,
  openWorkspaceDb,
  type UserDb,
  type WorkspaceDb,
} from './db.js';
import { coreDbPath, resolveDataRootPath, userDbPath, workspaceDbPath } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import {
  isSeparateScopedNotebookReceipt,
  SCOPED_NOTEBOOK_SERVER_RECEIPTS,
} from './scoped-notebook-sql-codecs.js';
import {
  type ControlWorkspaceCommandReceiptInput,
  ControlWorkspaceCommandReceiptInputSchema,
  WORKSPACE_LOCAL_COMMAND_RECEIPTS,
} from './workspace-command-receipt-codecs.js';

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

export { normalizeCommandRequestResponse, prepareControlCommandRequestStatement };

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

  // Validate the pointer first, then refuse standalone native backfill before
  // opening a database or creating layout for a command owned by a whole tuple.
  if (
    (owner.scope === 'core' || owner.scope === 'workspace' || owner.scope === 'user') &&
    isControlNativeReceiptCommand(record.command, owner.scope)
  )
    throw new Error('Native admission receipts belong to the database worker.');

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
      OR EXISTS (SELECT 1 FROM workspace_material_revisions AS revision,json_each(revision.judgements) AS annotation WHERE revision.workspace_id=? AND json_extract(annotation.value,'$.requestId')=?)
      OR EXISTS (SELECT 1 FROM evaluation_candidate_sets AS candidate,json_each(candidate.payload_json,'$.judgements') AS annotation WHERE candidate.workspace_id=? AND json_extract(annotation.value,'$.requestId')=?)`)
      .get(
        db.workspaceId,
        record.requestId,
        db.workspaceId,
        record.requestId,
        db.workspaceId,
        record.requestId
      )
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
  if (db.scope === 'app') assertControlProductWriter(db.sqlite);
  if (
    (db.scope === 'core' || db.scope === 'workspace' || db.scope === 'user') &&
    (isControlNativeReceiptCommand(record.command, db.scope) || nativeEvaluationReceipt(db, record))
  ) {
    throw new Error('Native admission receipts belong to the database worker.');
  }
  writeCommandRequestRecordInDb(db, record);
  pruneCommandRequestRecords(db, new Date().toISOString());
}

/** Writes one original native receipt inside its complete owning command tuple, with only the native operation/scope maintenance partition. */
export function recordControlCommandRequestRecordInDb(
  db: CoreDb | WorkspaceDb | UserDb,
  record: CommandRequestRecord
): void {
  assertControlProductWriter(db.sqlite);
  assertCommandRequestDbOwner(db, record.scope);
  if (
    !isControlNativeReceiptCommand(record.command, db.scope) &&
    !nativeEvaluationReceipt(db, record)
  )
    throw new Error('The command has no native receipt owner.');
  writeCommandRequestRecordInDb(db, record);
  pruneControlAdmissionReceipts(
    db.sqlite,
    db.scope === 'core'
      ? { kind: 'server' }
      : db.scope === 'user'
        ? { kind: 'user', userId: db.userId }
        : { kind: 'workspace', workspaceId: db.workspaceId },
    record.createdAt
  );
}

/** Commits only the original standalone scoped receipt; later maintenance cannot roll it back. */
export function recordControlScopedNotebookReceiptInDb(
  db: CoreDb | UserDb,
  record: CommandRequestRecord
): void {
  assertControlProductWriter(db.sqlite);
  assertCommandRequestDbOwner(db, record.scope);
  if (!isSeparateScopedNotebookReceipt(db.scope, record.command))
    throw new ControlProductPreconditionError();
  writeCommandRequestRecordInDb(db, record);
}

/** Retains the original post-receipt maintenance commit and its current reference-time owner. */
export function pruneControlScopedNotebookReceiptsInDb(
  db: CoreDb | UserDb,
  command: CommandRequestName,
  referenceTime: string
): void {
  assertControlProductWriter(db.sqlite);
  if (!isSeparateScopedNotebookReceipt(db.scope, command))
    throw new ControlProductPreconditionError();
  pruneControlAdmissionReceipts(
    db.sqlite,
    db.scope === 'user' ? { kind: 'user', userId: db.userId } : { kind: 'server' },
    referenceTime
  );
}

/** Applies only the two original Candidate receipt stages on the supplied physical writer. */
export function applyCatalogCommandReceiptInDb(
  db: WorkspaceDb,
  value: ControlCatalogCommandReceiptInput
): void {
  assertControlProductWriter(db.sqlite);
  const input = ControlCatalogCommandReceiptInputSchema.parse(value);
  if (!db.sqlite.inTransaction || db.workspaceId !== input.workspaceId)
    throw new ControlProductPreconditionError();
  if (input.stage === 'maintenance') {
    // The old producer pruned ordinary expired rows after its receipt committed.
    // Only these three moved names rejoin that original partition here.
    pruneCommandRequestRecords(db, input.referenceTime, true);
    return;
  }
  const record = { ...input.receipt, scope: parseStoredCommandScope(input.receipt.scope) };
  assertCommandRequestDbOwner(db, record.scope);
  if (
    record.key !== commandRequestKey(record.command, record.requestId, record.scope) ||
    record.expiresAt !== commandRequestExpiresAt(record.createdAt) ||
    (record.command === 'catalog.skill-candidate-submit'
      ? record.scope.candidateId !== undefined
      : record.scope.candidateId !== record.response.id)
  )
    throw new ControlProductPreconditionError();
  writeCommandRequestRecordInDb(db, record);
}

/** Applies only the two public Workspace commands' original standalone receipt stages. */
export function applyWorkspaceCommandReceiptInDb(
  db: UserDb | WorkspaceDb,
  value: ControlWorkspaceCommandReceiptInput
): void {
  assertControlProductWriter(db.sqlite);
  const input = ControlWorkspaceCommandReceiptInputSchema.parse(value);
  if (
    !db.sqlite.inTransaction ||
    ('userId' in input
      ? db.scope !== 'user' || db.userId !== input.userId
      : db.scope !== 'workspace' || db.workspaceId !== input.workspaceId)
  )
    throw new ControlProductPreconditionError();
  if ('receipt' in input) {
    const record = input.receipt;
    assertCommandRequestDbOwner(db, record.scope);
    if (
      record.key !== commandRequestKey(record.command, record.requestId, record.scope) ||
      record.expiresAt !== commandRequestExpiresAt(record.createdAt) ||
      (record.command === 'workspace.update' &&
        (db.scope !== 'workspace' || record.response.id !== db.workspaceId))
    )
      throw new ControlProductPreconditionError();
    writeCommandRequestRecordInDb(db, record);
  } else {
    // This is the original later commit, using the clock sampled after the receipt ACK.
    pruneControlAdmissionReceipts(
      db.sqlite,
      db.scope === 'user'
        ? { kind: 'user', userId: db.userId }
        : { kind: 'workspace', workspaceId: db.workspaceId },
      input.referenceTime
    );
  }
}

/** Preserves the existing complete row read/check/write body; public entry points own authority and disjoint pruning. */
function writeCommandRequestRecordInDb(db: CommandRequestDb, record: CommandRequestRecord): void {
  const scope = parseStoredCommandScope(record.scope);
  const response = normalizeCommandRequestResponse(record.command, record.response);
  const previous = db.sqlite
    .prepare(`${commandRequestSelect(db)} WHERE request_key = ?`)
    .get(record.key) as CommandRequestRow | undefined;
  if (previous && db.scope !== 'app') readRetainedV1(previous, () => undefined);
  let responseJson =
    response.conversationMetadata === undefined && response.steerMetadata === undefined
      ? null
      : JSON.stringify(response.conversationMetadata ?? response.steerMetadata);
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

  // commandRequestKey owns the operation prefix; this selects maintenance, never authority.
  const separator = key.indexOf('|');
  const command = separator < 0 ? '' : key.slice(0, separator);
  const workerOwnedKey =
    owner.scope !== 'app' &&
    (isControlNativeReceiptCommand(command, owner.scope) ||
      ((owner.scope === 'core' || owner.scope === 'workspace') &&
        command === 'evaluation.judgement-add'));
  if (workerOwnedKey && owner.scope === 'workspace')
    assertScopeAdmitted(dataRoot, 'workspace', owner.workspaceId);
  // Native admission owns migration and pruning. Observation only opens an existing reader.
  const reader =
    workerOwnedKey && owner.scope !== 'user'
      ? openControlStoreProductReadHandle(
          path,
          owner.scope === 'workspace'
            ? { kind: 'workspace', workspaceId: owner.workspaceId }
            : { kind: 'server' }
        )
      : undefined;
  const db = reader
    ? owner.scope === 'workspace'
      ? bindWorkspaceSqlite(reader.sqlite, dataRoot, owner.workspaceId)
      : bindCoreSqlite(reader.sqlite, dataRoot)
    : workerOwnedKey && owner.scope === 'user'
      ? openUserReadDb(dataRoot, owner.userId)
      : openCommandRequestDb(dataRoot, owner);

  try {
    if (!workerOwnedKey && db.scope !== 'app') pruneCommandRequestRecords(db, referenceTime);
    return getCommandRequestRecordFromDb(db, key, referenceTime);
  } finally {
    if (reader) reader.close();
    else db.sqlite.close();
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
  // Ordinary callers retain the original single-selection cut on their supplied connection.
  return sqlite
    .transaction(() => {
      const records: CommandRequestRecord[] = [];
      for (const page of readCommandRequestRecordPagesFromSqlite(sqlite)) records.push(...page);
      return records;
    })
    .deferred();
}

/** Exact request-qualified receipts retain the original decoder, expiry and winner validation. */
export function readPendingCommandRequestRecords(
  sqlite: Database.Database,
  requestId: string
): CommandRequestRecord[] {
  return (
    sqlite
      .prepare(`${COMMAND_REQUEST_SELECT} WHERE coalesce(
    json_extract(scope_json,'$.approvalRequestId'),json_extract(scope_json,'$.userInputRequestId'),
    json_extract(scope_json,'$.pendingRequestId'))=?`)
      .all(requestId) as CommandRequestRow[]
  ).map(mapCommandRequestRow);
}

/** Decodes the complete original scoped receipt census in released native pages, without pruning. */
export function* readCommandRequestRecordPagesFromSqlite(
  sqlite: Database.Database
): Generator<readonly CommandRequestRecord[], void, void> {
  let afterKey: string | undefined;
  for (;;) {
    const rows = sqlite
      .prepare(
        `${COMMAND_REQUEST_SELECT}${afterKey === undefined ? '' : ' WHERE request_key > ?'} ORDER BY request_key ASC LIMIT 128`
      )
      .all(...(afterKey === undefined ? [] : [afterKey])) as CommandRequestRow[];
    if (rows.length === 0) return;
    yield rows.map(mapCommandRequestRow);
    if (rows.length < 128) return;
    afterKey = rows.at(-1)!.key;
  }
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
    for (const { path, owner } of existingCommandRequestDatabases(dataRoot)) {
      const sqlite =
        owner.scope === 'user'
          ? openUserReadDb(dataRoot, owner.userId).sqlite
          : openControlStoreProductReadHandle(
              path,
              owner.scope === 'workspace'
                ? { kind: 'workspace', workspaceId: owner.workspaceId }
                : { kind: 'server' }
            ).sqlite;
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

/** Existing receipt file paired with its directory-owned scope; never retained or an admission grant. */
type ExistingCommandRequestDatabase = {
  readonly path: string;
  readonly owner: Exclude<CommandRequestOwner, { readonly scope: 'app' }>;
};

/**
 * Lists existing command receipt files with their physical scopes.
 *
 * @param dataRoot Data root to inspect.
 * @returns Existing Core, User, and Workspace database paths and scope identities.
 * @throws Error when a scanned directory contains a symbolic link.
 */
function existingCommandRequestDatabases(dataRoot: string): ExistingCommandRequestDatabase[] {
  const paths: ExistingCommandRequestDatabase[] = [];
  const corePath = coreDbPath(dataRoot);
  if (existsSync(corePath)) {
    paths.push({ path: corePath, owner: { scope: 'core' } });
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
      if (existsSync(path)) paths.push({ path, owner: { scope: 'user', userId: entry.name } });
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
      if (existsSync(path))
        paths.push({ path, owner: { scope: 'workspace', workspaceId: entry.name } });
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
    if (owner.scope === 'workspace') assertScopeAdmitted(dataRoot, 'workspace', owner.workspaceId);
    if (owner.scope === 'user') assertScopeAdmitted(dataRoot, 'user', owner.userId);
    const reader =
      owner.scope === 'workspace'
        ? openControlStoreProductReadHandle(workspaceDbPath(dataRoot, owner.workspaceId), {
            kind: 'workspace',
            workspaceId: owner.workspaceId,
          })
        : undefined;
    const db =
      reader && owner.scope === 'workspace'
        ? bindWorkspaceSqlite(reader.sqlite, dataRoot, owner.workspaceId)
        : owner.scope === 'user'
          ? openUserReadDb(dataRoot, owner.userId)
          : openCommandRequestDb(dataRoot, owner);

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
      if (reader) reader.close();
      else db.sqlite.close();
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
    return openExistingAppDb(dataRoot, owner.workspaceId, owner.appId, 'format-upgrade');
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
 * @param catalogMaintenance Preserves the original Candidate maintenance partition after its separate record ACK.
 */
function pruneCommandRequestRecords(
  db: CommandRequestDb,
  referenceTime: string,
  catalogMaintenance = false
): void {
  if (db.scope === 'app') {
    return;
  }
  const commands =
    db.scope === 'workspace'
      ? [
          ...CONTROL_NATIVE_RECEIPT_COMMANDS,
          ...CONTROL_NATIVE_WORKSPACE_KNOWLEDGE_COMMANDS,
          ...WORKSPACE_LOCAL_COMMAND_RECEIPTS,
          ...(catalogMaintenance ? [] : CATALOG_COMMAND_RECEIPTS),
        ]
      : db.scope === 'user'
        ? CONTROL_NATIVE_USER_RECEIPT_COMMANDS
        : [
            ...CONTROL_NATIVE_RECEIPT_COMMANDS,
            ...CONTROL_NATIVE_CORE_LIFECYCLE_COMMANDS,
            ...SCOPED_NOTEBOOK_SERVER_RECEIPTS,
          ];

  db.sqlite
    .prepare(
      `DELETE FROM idempotency_requests WHERE expires_at <= ? AND command_name NOT IN (${commands.map(() => '?').join(',')})${db.scope === 'workspace' ? ` AND NOT ${CONTROL_NATIVE_EVALUATION_RECEIPT_SQL}` : ''}`
    )
    .run(referenceTime, ...commands);
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
    scope: parseStoredCommandScope(JSON.parse(row.scopeJson)),
    inputHash: row.inputHash,
    response: normalizeCommandRequestResponse(row.command, {
      kind: row.responseKind,
      id: row.responseId,
      ...(row.responseJson === null
        ? {}
        : readCommandResponseMetadata(row.command, row.responseJson)),
    }),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
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
    .sort(([left], [right]) => compareCodeUnits(left, right))
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
