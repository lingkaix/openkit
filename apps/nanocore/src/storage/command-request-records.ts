import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AuditEventIdSchema,
  canonicalIdentifierName,
  compareCodeUnits,
  deriveEntityId,
  PolicyDigestV1Schema,
  readRetainedV1,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { sha256CanonicalJson } from '@openkit/protocol/digest';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { auditEventFromRow } from '../audit-events.js';
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
import type {
  ChannelInboundEnvelope,
  ChannelInboundKey,
  ChannelInboundReceipt,
  PairingAuditIntent,
  PairingAuditReceipt,
} from './communication-port.js';
import { pruneControlAdmissionReceipts } from './control-store-admission.js';
import {
  ChannelInboundEnvelopeSchema,
  ChannelInboundKeySchema,
  ChannelInboundOriginSchema,
  ChannelInboundOutcomeSchema,
  PairingAuditIntentSchema,
  ServerWorkKernelIntentSchema,
  ServerWorkKernelRefusalSchema,
} from './control-store-admission-codecs.js';
import { openControlStoreProductReadHandle } from './control-store-product-records.js';
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
import type { ServerWorkIntent, ServerWorkReceipt } from './server-work-port.js';
import type { StorageReceiptLookup } from './storage-owner.js';
import { storageReceipt, storageRequestId } from './storage-owner.js';

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

const retainedPairingReceiptSchema = z
  .object({
    intent: PairingAuditIntentSchema,
    disposition: z.literal('applied'),
    result: z.strictObject({ eventId: AuditEventIdSchema }),
    receiptDigest: PolicyDigestV1Schema,
  })
  .strict();

/** Reads the complete pairing receipt after the caller verifies current read authority. */
export function inspectPairingAuditReceipt(
  db: CoreDb,
  intent: PairingAuditIntent,
  completeHistory: boolean
): StorageReceiptLookup<PairingAuditReceipt> {
  if (
    intent.requestId !== storageRequestId(intent) ||
    intent.occurrenceKey !== intent.target.eventId
  )
    return { state: 'conflict' };
  const row = readKernelRequestRow(db, intent.requestId);
  if (!row) return { state: completeHistory ? 'absent' : 'unknown' };
  try {
    const receipt = readRetainedV1(row, () =>
      retainedPairingReceiptSchema.parse(JSON.parse(row.responseJson ?? 'null'))
    );
    if (
      !matchesKernelRequestRow(row, receipt.intent, receipt.result.eventId) ||
      receipt.result.eventId !== receipt.intent.target.eventId ||
      receipt.intent.occurrenceKey !== receipt.intent.target.eventId
    )
      return { state: 'unknown' };
    const expected = storageReceipt(receipt.intent, {
      disposition: 'applied',
      result: receipt.result,
    });
    if (receipt.receiptDigest !== expected.receiptDigest) return { state: 'unknown' };
    if (canonicalIdentifierName(intent) !== canonicalIdentifierName(receipt.intent))
      return { state: 'conflict' };
    const audit = db.sqlite
      .prepare('SELECT * FROM audit_events WHERE audit_event_id = ?')
      .get(receipt.result.eventId);
    if (!audit || sha256CanonicalJson(auditEventFromRow(audit)) !== receipt.intent.inputDigest)
      return { state: 'unknown' };
    return { state: 'settled', receipt };
  } catch {
    return { state: 'unknown' };
  }
}

/** Writes the original permanent pairing receipt in the native Audit transaction. */
export function writePairingAuditReceipt(
  db: CoreDb,
  intent: PairingAuditIntent,
  createdAt: string
): PairingAuditReceipt {
  assertControlProductWriter(db.sqlite);
  const receipt = retainedPairingReceiptSchema.parse(
    storageReceipt(intent, {
      disposition: 'applied',
      result: { eventId: intent.target.eventId },
    })
  );
  insertKernelRequest(db, intent, receipt.result.eventId, receipt, createdAt);
  return receipt;
}

const retainedChannelReceiptSchema = z.strictObject({
  intent: ChannelInboundEnvelopeSchema,
  disposition: z.literal('applied'),
  result: ChannelInboundOutcomeSchema,
  receiptDigest: PolicyDigestV1Schema,
});
const retainedChannelRequestSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('reserved'), envelope: ChannelInboundEnvelopeSchema }),
  z.strictObject({ state: z.literal('origin-bound'), origin: ChannelInboundOriginSchema }),
  z.strictObject({
    state: z.literal('settled'),
    origin: ChannelInboundOriginSchema.nullable(),
    receipt: retainedChannelReceiptSchema,
  }),
]);
type RetainedChannelRequest = z.infer<typeof retainedChannelRequestSchema>;

export function channelRequestEnvelope(state: RetainedChannelRequest): ChannelInboundEnvelope {
  if (state.state === 'reserved') return state.envelope;
  if (state.state === 'origin-bound') return state.origin.envelope;
  return state.receipt.intent;
}

/** Validates the permanent occurrence, version, stage and complete receipt before disclosure. */
export function inspectChannelInboundReceipt(
  db: CoreDb,
  key: ChannelInboundKey,
  completeHistory: boolean
): RetainedChannelRequest | { state: 'absent' } | { state: 'unknown' } {
  const parsed = ChannelInboundKeySchema.safeParse({
    deploymentId: key.deploymentId,
    sourceOwner: key.sourceOwner,
    verb: key.verb,
    occurrenceKey: key.occurrenceKey,
  });
  if (!parsed.success) return { state: 'unknown' };
  const requestId = storageRequestId(parsed.data);
  const row = readKernelRequestRow(db, requestId);
  if (!row) return { state: completeHistory ? 'absent' : 'unknown' };
  try {
    const state = readRetainedV1(row, () =>
      retainedChannelRequestSchema.parse(JSON.parse(row.responseJson ?? 'null'))
    );
    const envelope = channelRequestEnvelope(state);
    if (
      !matchesKernelRequestRow(row, envelope, requestId) ||
      envelope.requestId !== storageRequestId(envelope) ||
      envelope.requestId !== requestId
    )
      return { state: 'unknown' };
    if (state.state === 'settled') {
      if (
        (state.receipt.result.kind === 'handled') !== (state.origin === null) ||
        (state.origin &&
          canonicalIdentifierName(state.origin.envelope) !== canonicalIdentifierName(envelope)) ||
        state.receipt.receiptDigest !==
          storageReceipt(envelope, {
            disposition: 'applied',
            result: state.receipt.result,
          }).receiptDigest
      )
        return { state: 'unknown' };
    }
    return state;
  } catch {
    return { state: 'unknown' };
  }
}

/** Allocates one permanent reservation for the first authenticated occurrence. */
export function insertChannelInboundReservation(
  db: CoreDb,
  envelope: ChannelInboundEnvelope,
  createdAt: string
): void {
  insertKernelRequest(
    db,
    envelope,
    envelope.requestId,
    {
      state: 'reserved',
      envelope,
    },
    createdAt
  );
}

/** The saved phase and exact original payload guard all later stage transitions. */
export function replaceChannelInboundStage(
  db: CoreDb,
  original: RetainedChannelRequest,
  next: RetainedChannelRequest
): void {
  assertControlProductWriter(db.sqlite);
  const envelope = channelRequestEnvelope(original);
  const changed = db.sqlite
    .prepare(`UPDATE idempotency_requests
    SET response_json = ?
    WHERE request_key = ? AND response_kind = 'storage-receipt' AND response_json = ?`)
    .run(canonicalIdentifierName(next), envelope.requestId, canonicalIdentifierName(original));
  if (changed.changes !== 1) throw new Error('Channel occurrence lost its original stage.');
}

/** Commits the outcome at the original permanent key and preserves its bound origin. */
export function writeChannelInboundSettlement(
  db: CoreDb,
  original: Extract<RetainedChannelRequest, { state: 'reserved' | 'origin-bound' }>,
  outcome: Extract<ChannelInboundReceipt, { disposition: 'applied' }>['result']
): ChannelInboundReceipt {
  const envelope = channelRequestEnvelope(original);
  const receipt = storageReceipt(envelope, { disposition: 'applied', result: outcome });
  replaceChannelInboundStage(db, original, {
    state: 'settled',
    origin: original.state === 'origin-bound' ? original.origin : null,
    receipt,
  });
  return receipt;
}

const serverWorkReceiptCarriage = z.strictObject({
  intent: ServerWorkKernelIntentSchema,
  receiptDigest: PolicyDigestV1Schema,
});
const retainedServerWorkReceiptSchema = z.discriminatedUnion('disposition', [
  serverWorkReceiptCarriage.extend({
    disposition: z.literal('applied'),
    result: z.strictObject({ decisionRef: AuditEventIdSchema }),
  }),
  serverWorkReceiptCarriage.extend({
    disposition: z.literal('refused'),
    reason: ServerWorkKernelRefusalSchema,
  }),
]);

export function serverWorkDecisionEventId(requestId: string): string {
  return deriveEntityId('aud', [requestId, 'server-work-decision/v1']);
}

export function serverWorkAuditResource(intent: ServerWorkIntent): string {
  const { target } = intent;
  if ('callId' in target) return `call:${target.callId}`;
  if ('turnId' in target) return `turn:${target.turnId}`;
  return `thread:${target.threadId}`;
}

/** Reads the original complete kernel decision and its covering Audit. */
export function inspectServerWorkReceipt<Intent extends ServerWorkIntent>(
  db: CoreDb,
  input: Intent,
  completeHistory: boolean
): StorageReceiptLookup<ServerWorkReceipt<Intent>> {
  const parsed = ServerWorkKernelIntentSchema.safeParse(input);
  if (!parsed.success || input.requestId !== storageRequestId(input)) return { state: 'conflict' };
  const row = readKernelRequestRow(db, input.requestId);
  if (!row) return { state: completeHistory ? 'absent' : 'unknown' };
  try {
    const receipt = readRetainedV1(row, () =>
      retainedServerWorkReceiptSchema.parse(JSON.parse(row.responseJson ?? 'null'))
    );
    const eventId = serverWorkDecisionEventId(receipt.intent.requestId);
    const { intent, receiptDigest, ...outcome } = receipt;
    if (
      !matchesKernelRequestRow(row, intent, eventId) ||
      receiptDigest !== storageReceipt(intent, outcome).receiptDigest ||
      (receipt.disposition === 'applied' && receipt.result.decisionRef !== eventId)
    )
      return { state: 'unknown' };
    if (canonicalIdentifierName(intent) !== canonicalIdentifierName(parsed.data))
      return { state: 'conflict' };
    const eventRow = db.sqlite
      .prepare('SELECT * FROM audit_events WHERE audit_event_id=?')
      .get(eventId);
    if (!eventRow) return { state: 'unknown' };
    const event = auditEventFromRow(eventRow);
    if (
      event.workspaceId !== null ||
      event.requestId !== intent.requestId ||
      event.action !== `server-work.${intent.verb}` ||
      event.createdAt !== row.createdAt ||
      event.resource !== serverWorkAuditResource(intent) ||
      canonicalIdentifierName(event.actor) !== canonicalIdentifierName(intent.target.actor) ||
      event.outcome !== (receipt.disposition === 'applied' ? 'succeeded' : 'denied') ||
      event.errorCode !==
        (receipt.disposition === 'applied' ? null : `server_work_${receipt.reason}`)
    )
      return { state: 'unknown' };
    return { state: 'settled', receipt: receipt as ServerWorkReceipt<Intent> };
  } catch {
    return { state: 'unknown' };
  }
}

export function writeServerWorkReceipt<Intent extends ServerWorkIntent>(
  db: CoreDb,
  receipt: ServerWorkReceipt<Intent>,
  createdAt: string
): void {
  const original = retainedServerWorkReceiptSchema.parse(receipt);
  insertKernelRequest(
    db,
    original.intent,
    serverWorkDecisionEventId(original.intent.requestId),
    original,
    createdAt
  );
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
  const row = db.sqlite.prepare(`${commandRequestSelect(db)} WHERE request_key = ?`).get(key) as
    | CommandRequestRow
    | undefined;

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
        `${COMMAND_REQUEST_SELECT} WHERE response_kind <> 'storage-receipt'${afterKey === undefined ? '' : ' AND request_key > ?'} ORDER BY request_key ASC LIMIT 128`
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
            `${COMMAND_REQUEST_SELECT} WHERE response_kind <> 'storage-receipt' ORDER BY created_at ASC, request_key ASC`
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
            `${COMMAND_REQUEST_SELECT} WHERE response_kind <> 'storage-receipt' ORDER BY created_at ASC, request_key ASC`
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
