import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalIdentifierName,
  compareCodeUnits,
  PolicyDigestV1Schema,
  readRetainedV1,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { sha256CanonicalJson } from '@openkit/protocol/digest';
import type Database from 'better-sqlite3';
import { z } from 'zod';
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
  type CommandRequestOwner,
  commandRequestOwner,
  commandRequestValues,
  normalizeCommandRequestResponse,
  PERMANENT_COMMANDS,
  parseCommandScope,
  parseStoredCommandScope,
  prepareControlCommandRequestStatement,
  readCommandResponseMetadata,
} from './command-request-codecs.js';
import { pruneControlAdmissionReceipts } from './control-store-admission.js';
import {
  ControlProductPreconditionError,
  openControlStoreProductReadHandle,
} from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import {
  bindCoreSqlite,
  bindWorkspaceSqlite,
  type CoreDb,
  openUserReadDb,
  type UserDb,
  type WorkspaceDb,
} from './db.js';
import { coreDbPath, resolveDataRootPath, userDbPath, workspaceDbPath } from './fs-layout.js';
import { vaultEpochFenceOccurrence } from './nanohost-epoch-invalidation.js';
import type { NanoHostEpochInvalidation, NanoHostEpochReceipt } from './nanohost-port.js';
import { type StorageReceiptLookup, storageReceipt, storageRequestId } from './storage-owner.js';
import {
  NanoHostEpochInvalidationSchema,
  type VaultEpochPlacement,
} from './vault-native-codecs.js';

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
  readonly expiresAt: string | null;
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
export const COMMAND_REQUEST_SELECT = APP_COMMAND_REQUEST_SELECT.replace(
  'SELECT\n',
  'SELECT\n  schema_version AS schemaVersion,\n'
);

/** The owning database selects the versioned Core row or the separately versioned native App row. */
function commandRequestSelect(db: CommandRequestDb): string {
  return db.scope === 'app' ? APP_COMMAND_REQUEST_SELECT : COMMAND_REQUEST_SELECT;
}

export { normalizeCommandRequestResponse, prepareControlCommandRequestStatement };

/**
 * Stores an App command only on its actual native worker connection.
 *
 * @param db Native App database that owns the request scope.
 * @param record Complete command request record.
 */
export function recordCommandRequestRecordInDb(db: AppDb, record: CommandRequestRecord): void {
  if (db.scope !== 'app')
    throw new Error('Native admission receipts belong to the database worker.');
  assertControlProductWriter(db.sqlite);
  assertCommandRequestDbOwner(db, record.scope);
  writeCommandRequestRecordInDb(db, record);
}

/** Writes the original receipt in its complete native tuple and prunes ordinary expiry only on that physical owner. */
export function recordControlCommandRequestRecordInDb(
  db: CoreDb | WorkspaceDb | UserDb,
  record: CommandRequestRecord
): void {
  assertControlProductWriter(db.sqlite);
  assertCommandRequestDbOwner(db, record.scope);
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

const permanentKernelScope = '{"coreId":"server"}';
const ordinaryCommandRequestFilter =
  "NOT (command_name = 'fence-vault-epoch' AND response_kind = 'storage-receipt' AND expires_at IS NULL)";

type KernelRequestRow = Omit<CommandRequestRow, 'command' | 'responseKind'> & {
  command: string;
  responseKind: string;
};

function readKernelRequestRow(db: CoreDb, requestId: string): KernelRequestRow | undefined {
  return db.sqlite.prepare(`${COMMAND_REQUEST_SELECT} WHERE request_key = ?`).get(requestId) as
    | KernelRequestRow
    | undefined;
}

function matchesKernelRequestRow(
  row: KernelRequestRow,
  intent: { verb: string; requestId: string; inputDigest: string },
  responseId: string
): boolean {
  return (
    row.command === intent.verb &&
    row.responseKind === 'storage-receipt' &&
    row.requestId === intent.requestId &&
    row.key === intent.requestId &&
    row.scopeJson === permanentKernelScope &&
    row.inputHash === intent.inputDigest &&
    row.responseId === responseId &&
    row.expiresAt === null
  );
}

function insertKernelRequest(
  db: CoreDb,
  intent: { verb: string; requestId: string; inputDigest: string },
  responseId: string,
  payload: unknown,
  createdAt: string
): void {
  assertControlProductWriter(db.sqlite);
  db.sqlite
    .prepare(`INSERT INTO idempotency_requests
      (schema_version, request_key, command_name, request_id, scope_json, input_hash,
       response_kind, response_id, response_json, created_at, expires_at)
      VALUES (1, ?, ?, ?, ?, ?, 'storage-receipt', ?, ?, ?, NULL)`)
    .run(
      intent.requestId,
      intent.verb,
      intent.requestId,
      permanentKernelScope,
      intent.inputDigest,
      responseId,
      canonicalIdentifierName(payload),
      createdAt
    );
}

export { vaultEpochFenceOccurrence } from './nanohost-epoch-invalidation.js';

/** Reconnecting the same physical Epoch does not reopen the retired writer. */
export function vaultEpochMayAuthorizeWriter(db: CoreDb, placement?: VaultEpochPlacement): boolean {
  if (!placement) {
    return (
      db.sqlite
        .prepare(
          "SELECT 1 FROM idempotency_requests WHERE command_name='fence-vault-epoch' LIMIT 1"
        )
        .get() === undefined
    );
  }
  const key = storageRequestId(vaultEpochFenceOccurrence(placement));
  if (readKernelRequestRow(db, key)) return false;
  return (
    db.sqlite
      .prepare(`SELECT 1 FROM idempotency_requests
    WHERE command_name='fence-vault-epoch' AND response_id=?
      AND (schema_version<>1 OR response_kind<>'storage-receipt' OR response_json IS NULL
        OR json_extract(response_json, '$.intent.target.physicalEpoch') IS NULL
        OR (json_extract(response_json, '$.intent.deploymentId')=?
          AND json_extract(response_json, '$.intent.target.physicalEpoch')=?))
    LIMIT 1`)
      .get(placement.runtimeTargetId, placement.deploymentId, placement.physicalEpoch) === undefined
  );
}

const retainedEpochReceiptSchema = z.strictObject({
  intent: NanoHostEpochInvalidationSchema,
  disposition: z.literal('applied'),
  result: z.strictObject({
    fencedHolderReceiptIds: NanoHostEpochInvalidationSchema.shape.target.shape.holderReceiptIds,
  }),
  receiptDigest: PolicyDigestV1Schema,
});

const reservedEpochFenceSchema = z.strictObject({
  state: z.literal('reserved'),
  intent: NanoHostEpochInvalidationSchema,
});
const retainedEpochFenceSchema = z.union([reservedEpochFenceSchema, retainedEpochReceiptSchema]);

function parseEpochFenceIntent(input: unknown): NanoHostEpochInvalidation | null {
  const parsed = NanoHostEpochInvalidationSchema.safeParse(input);
  if (!parsed.success) return null;
  const candidate = parsed.data;
  const expected = vaultEpochFenceOccurrence({
    deploymentId: candidate.deploymentId,
    generation: candidate.expectedGeneration,
    runtimeTargetId: candidate.target.runtimeTargetId,
    physicalEpoch: candidate.target.physicalEpoch,
  });
  const digest = sha256CanonicalJson(candidate.target);
  if (
    expected.occurrenceKey !== candidate.occurrenceKey ||
    candidate.requestId !== storageRequestId(expected) ||
    (candidate.inputDigest !== digest && candidate.inputDigest !== `sha256:${digest}`) ||
    canonicalIdentifierName(candidate.target.holderReceiptIds) !==
      canonicalIdentifierName([...new Set(candidate.target.holderReceiptIds)].sort())
  )
    return null;
  return candidate;
}

/** Reads the original, including its pre-fence hold, without making an effect decision. */
export function readNanoHostEpochFenceRecord(
  db: CoreDb,
  requestId: string
):
  | { readonly state: 'absent' | 'unknown' }
  | { readonly state: 'reserved'; readonly intent: NanoHostEpochInvalidation }
  | { readonly state: 'settled'; readonly receipt: NanoHostEpochReceipt } {
  const row = readKernelRequestRow(db, requestId);
  if (!row) return { state: 'absent' };
  try {
    const retained = readRetainedV1(row, () =>
      retainedEpochFenceSchema.parse(JSON.parse(row.responseJson ?? 'null'))
    );
    if (
      !matchesKernelRequestRow(row, retained.intent, retained.intent.target.runtimeTargetId) ||
      !parseEpochFenceIntent(retained.intent)
    )
      return { state: 'unknown' };
    if ('state' in retained) return retained;
    if (
      canonicalIdentifierName(retained.result.fencedHolderReceiptIds) !==
        canonicalIdentifierName(retained.intent.target.holderReceiptIds) ||
      storageReceipt(retained.intent, { disposition: 'applied', result: retained.result })
        .receiptDigest !== retained.receiptDigest
    )
      return { state: 'unknown' };
    return { state: 'settled', receipt: retained };
  } catch {
    return { state: 'unknown' };
  }
}

export function inspectNanoHostEpochFenceReceipt(
  db: CoreDb,
  input: NanoHostEpochInvalidation,
  completeHistory: boolean
): StorageReceiptLookup<NanoHostEpochReceipt> {
  const intent = parseEpochFenceIntent(input);
  if (!intent) return { state: 'conflict' };
  const record = readNanoHostEpochFenceRecord(db, intent.requestId);
  if (record.state === 'unknown') return record;
  if (record.state === 'settled' || record.state === 'reserved') {
    const original = record.state === 'settled' ? record.receipt.intent : record.intent;
    if (canonicalIdentifierName(original) !== canonicalIdentifierName(intent))
      return { state: 'conflict' };
    if (record.state === 'settled') return record;
  }
  return { state: completeHistory ? 'absent' : 'unknown' };
}

/** Closes predecessor admission under the exact occurrence before publishing its census. */
export function insertNanoHostEpochFenceReservation(
  db: CoreDb,
  input: NanoHostEpochInvalidation
): void {
  const intent = parseEpochFenceIntent(input);
  if (!intent) throw new Error('NanoHost Epoch census is outside its original occurrence.');
  insertKernelRequest(
    db,
    intent,
    intent.target.runtimeTargetId,
    {
      state: 'reserved',
      intent,
    },
    new Date().toISOString()
  );
}

export function writeNanoHostEpochFenceReceipt(
  db: CoreDb,
  intent: NanoHostEpochInvalidation
): NanoHostEpochReceipt {
  const receipt = retainedEpochReceiptSchema.parse(
    storageReceipt(intent, {
      disposition: 'applied',
      result: { fencedHolderReceiptIds: intent.target.holderReceiptIds },
    })
  );
  assertControlProductWriter(db.sqlite);
  const changed = db.sqlite
    .prepare(`UPDATE idempotency_requests SET response_json=?
    WHERE request_key=? AND response_kind='storage-receipt' AND response_json=?`)
    .run(
      canonicalIdentifierName(receipt),
      intent.requestId,
      canonicalIdentifierName({ state: 'reserved', intent })
    );
  if (changed.changes !== 1) throw new Error('NanoHost Epoch fence lost its original reservation.');
  return receipt;
}

/** One row serializer on an actual scoped connection; command entry points retain authority, transaction and maintenance ownership. */
export function writeCommandRequestRecordInDb(
  db: CommandRequestDb,
  record: CommandRequestRecord
): void {
  const scope = parseStoredCommandScope(record.scope);
  const response = normalizeCommandRequestResponse(record.command, record.response);
  const previous = db.sqlite
    .prepare(`${commandRequestSelect(db)} WHERE request_key = ?`)
    .get(record.key) as CommandRequestRow | undefined;
  const previousCommand: string | undefined = previous?.command;
  if (previousCommand === 'fence-vault-epoch') throw new ControlProductPreconditionError();
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

  if (owner.scope === 'workspace') assertScopeAdmitted(dataRoot, 'workspace', owner.workspaceId);
  // Every Core/Workspace/User observation uses the existing read-only owner, never a Main migration or pruning writer.
  const reader =
    owner.scope === 'core' || owner.scope === 'workspace'
      ? openControlStoreProductReadHandle(
          path,
          owner.scope === 'core'
            ? { kind: 'server' }
            : { kind: 'workspace', workspaceId: owner.workspaceId }
        )
      : undefined;
  const db =
    owner.scope === 'app'
      ? openExistingAppDb(dataRoot, owner.workspaceId, owner.appId)
      : owner.scope === 'user'
        ? openUserReadDb(dataRoot, owner.userId)
        : owner.scope === 'workspace'
          ? bindWorkspaceSqlite(reader!.sqlite, dataRoot, owner.workspaceId)
          : bindCoreSqlite(reader!.sqlite, dataRoot);

  try {
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
  const row = db.sqlite
    .prepare(
      `${commandRequestSelect(db)} WHERE request_key = ? AND ${ordinaryCommandRequestFilter}`
    )
    .get(key) as CommandRequestRow | undefined;

  if (!row) {
    return null;
  }

  const record =
    db.scope === 'app' ? decodeCommandRequestPayloadV1(row) : mapCommandRequestRow(row);
  assertCommandRequestDbOwner(db, record.scope);
  if (record.expiresAt !== null && record.expiresAt <= referenceTime) {
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
        `${COMMAND_REQUEST_SELECT} WHERE ${ordinaryCommandRequestFilter}${afterKey === undefined ? '' : ' AND request_key > ?'} ORDER BY request_key ASC LIMIT 128`
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
          .prepare(
            `${COMMAND_REQUEST_SELECT} WHERE ${ordinaryCommandRequestFilter} ORDER BY created_at ASC, request_key ASC`
          )
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
      owner.scope === 'core' || owner.scope === 'workspace'
        ? openControlStoreProductReadHandle(
            owner.scope === 'core'
              ? coreDbPath(dataRoot)
              : workspaceDbPath(dataRoot, owner.workspaceId),
            owner.scope === 'core'
              ? { kind: 'server' }
              : { kind: 'workspace', workspaceId: owner.workspaceId }
          )
        : undefined;
    const db =
      owner.scope === 'user'
        ? openUserReadDb(dataRoot, owner.userId)
        : owner.scope === 'app'
          ? openExistingAppDb(dataRoot, owner.workspaceId, owner.appId)
          : owner.scope === 'workspace'
            ? bindWorkspaceSqlite(reader!.sqlite, dataRoot, owner.workspaceId)
            : bindCoreSqlite(reader!.sqlite, dataRoot);

    try {
      return (
        db.sqlite
          .prepare(
            `${COMMAND_REQUEST_SELECT} WHERE ${ordinaryCommandRequestFilter} ORDER BY created_at ASC, request_key ASC`
          )
          .all() as CommandRequestRow[]
      )
        .map((row) => {
          const record = mapCommandRequestRow(row);
          assertCommandRequestDbOwner(db, record.scope);
          return record;
        })
        .filter((record) => record.expiresAt === null || record.expiresAt > referenceTime);
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
 * Verifies that one open database matches a command request's authoritative scope.
 *
 * @param db Open Core, User, or Workspace database.
 * @param scope Command request scope stored in or destined for that database.
 * @throws Error when the request scope selects a different durable owner.
 */
export function assertCommandRequestDbOwner(
  db: CommandRequestDb,
  scope: CommandRequestScope
): void {
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
  const scope = parseCommandScope(row.command, JSON.parse(row.scopeJson));
  if (PERMANENT_COMMANDS.includes(row.command)) {
    if (
      row.expiresAt !== null ||
      (row.command === 'scheduler.external-trigger.admit' && row.requestId !== scope.eventKey) ||
      row.key !== commandRequestKey(row.command, row.requestId, scope)
    )
      throw new Error('The retained external-event command identity conflicts.');
  } else if (row.expiresAt === null) {
    throw new Error('An ordinary command receipt has no expiry.');
  }
  return {
    key: row.key,
    command: row.command,
    requestId: row.requestId,
    scope,
    inputHash: row.inputHash,
    response: normalizeCommandRequestResponse(row.command, {
      kind: row.responseKind,
      id: row.responseId,
      // The Discord channel owner keeps its event state in the response JSON.
      ...(row.responseJson === null || row.command === 'channel.discord.inbound'
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
