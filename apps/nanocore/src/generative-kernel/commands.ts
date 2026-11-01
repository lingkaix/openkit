import { copyVerifiedFile, createDirectoryExclusive, removeDurableFile } from '@openkit/storage';
import { syncCanonicalDirectoryAsync } from '../storage/canonical-filesystem.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import {
  asObject,
  boundedKernelResponse,
  catalogItemFromMetadata,
  columnFor,
  mapAppSqliteError as mapSqliteError,
  parseFields,
  projectApp,
  projectRecord,
  projectRestoredApp,
  readMetadata,
  readProjectedRecord,
  replayBatch,
  replayNamedRecord,
  requireCurrentSchema,
  resolveCollection,
} from './app-model.js';
import {
  type ControlAppInput,
  ControlAppInputSchema,
  type ControlAppResult,
} from './native-command-codecs.js';

export { assertKernelMutationRequestSize, boundedKernelResponse } from './app-model.js';

import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CreateLightAppResponse,
  type GetLightAppResponse,
  LIGHT_APP_CAPABILITIES,
  type LightAppAdmittedCollection,
  type LightAppBatchRequest,
  type LightAppBatchResponse,
  type LightAppCatalogItem,
  type LightAppDefinitionSource,
  LightAppDefinitionSourceSchema,
  type LightAppRecord,
  type LightAppSchemaInput,
  type LightAppSnapshot,
  type ListLightAppRecordsResponse,
  type ListLightAppsResponse,
  type UpdateLightAppRecordRequest,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import { compareCodeUnits } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import type { FsStore } from '../lib/store.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import {
  type AppDb,
  assertAppDefinitionMatches,
  lightAppDbPath,
  lightAppRoot,
  lightAppsRoot,
  openAppDbReadOnly,
  openExistingAppDb,
} from '../storage/app-db.js';
import { KernelCommandError } from './errors.js';
import { compileRecordFilter } from './filter.js';
import { collectionTableName, quoteIdent } from './native.js';
import { admitLightAppSchema } from './schema.js';
import { assertSnapshotRelations, readLightAppSnapshots } from './snapshots.js';
import { allocateAppId, allocateRecordId } from './uuid.js';

const APP_DIRECTORY_LIMIT = LIGHT_APP_CAPABILITIES.maxAppDirectories;
const _RECORD_LIMIT = LIGHT_APP_CAPABILITIES.maxRecords;
const _DATA_OBJECT_BYTE_LIMIT = LIGHT_APP_CAPABILITIES.maxDataObjectBytes;

/** Shared Kernel command execution context. */
export interface KernelCommandContext {
  /** Product store for receipts. */
  readonly store: FsStore;
  /** In-flight command map. */
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  /** Data root. */
  readonly dataRoot: string;
  /** Selected Workspace. */
  readonly workspaceId: string;
  /** Authenticated actor. */
  readonly actor: ActorRef;
  /** Actual executing Turn and Thread from trusted native invocation, independent of presentation Items. */
  readonly execution?: { readonly threadId: string; readonly turnId: string };
  /** Caller request id. */
  readonly requestId: string;
  /** Repeat current authority after native or immutable preparation awaits. */
  readonly recheckAdmission?: (() => Promise<void>) | undefined;
}

/** Raw explicit catalog request bound by the existing app-local receipt. */
export interface LightAppRequestedDefinition {
  /** Selected catalog entry. */
  readonly entryId: string;
  /** Exact requested version; omission selects the pin/default only for a fresh request. */
  readonly digest?: string | undefined;
}

type KernelCommandSpec<T> = {
  command: ControlAppInput['receipt']['command'];
  responseKind: 'light_app' | 'light_app_record' | 'light_app_batch';
  input: unknown;
  change:
    | Exclude<ControlAppInput['change'], { kind: 'rollback' }>
    | Pick<
        Extract<ControlAppInput['change'], { kind: 'rollback' }>,
        'kind' | 'expectedAppRevision' | 'snapshotId'
      >;
  replay: (db: AppDb) => T;
  responseId: (result: T) => string;
};

/**
 * Lists Light Apps by scanning app directories.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @param page Positive page.
 * @param perPage Page size.
 * @returns Paged catalog.
 */
export function listLightApps(
  dataRoot: string,
  workspaceId: string,
  page = 1,
  perPage = 30
): ListLightAppsResponse {
  assertPage(page, perPage);
  const items = listCatalogItems(dataRoot, workspaceId);
  const totalItems = items.length;
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / perPage);
  const start = (page - 1) * perPage;
  return boundedKernelResponse({
    page,
    perPage,
    totalItems,
    totalPages,
    items: items.slice(start, start + perPage),
  });
}

/**
 * Creates one Light App from an authored proposal or an exact Core-selected definition.
 *
 * @param context Command context.
 * @param schema Authored proposal, or the Core-admitted definition when sourceSelection is present.
 * @param sourceSelection Explicit exact catalog source, when selected.
 * @param requestedDefinition Raw catalog selector bound on fresh execution and replay.
 * @returns Created app.
 */
export async function createLightApp(
  context: KernelCommandContext,
  schema: LightAppSchemaInput,
  sourceSelection?: LightAppDefinitionSource,
  requestedDefinition?: LightAppRequestedDefinition
): Promise<CreateLightAppResponse> {
  if (sourceSelection) LightAppDefinitionSourceSchema.parse(sourceSelection);
  const appId = allocateAppId(context.workspaceId, context.requestId);
  return runNativeAppCommand(context, appId, {
    command: 'kernel.apps.create',
    responseKind: 'light_app',
    input: requestedDefinition ? { requestedDefinition } : { schema, sourceSelection },
    change: {
      kind: 'create',
      schema,
      ...(sourceSelection ? { sourceSelection } : {}),
      ...(requestedDefinition ? { requestedDefinition } : {}),
    },
    replay: (db) => projectApp(db),
    responseId: (result) => result.appId,
  });
}

/**
 * Reads one Light App catalog entry and admitted schema.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @param appId App UUID.
 * @returns App projection.
 */
export function getLightApp(
  dataRoot: string,
  workspaceId: string,
  appId: string
): GetLightAppResponse {
  try {
    lstatSync(lightAppRoot(dataRoot, workspaceId, appId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new KernelCommandError('not_found', 'Light App was not found.');
    }
    // An inspection failure does not prove absence; the existing reader projects unavailable.
  }
  const item = inspectCatalogItem(dataRoot, workspaceId, appId);
  if (item.lifecycle === 'unavailable') {
    return boundedKernelResponse({ ...item, schema: null, capabilities: LIGHT_APP_CAPABILITIES });
  }
  const appDb = openExistingAppDb(dataRoot, workspaceId, appId);
  try {
    return boundedKernelResponse(projectApp(appDb));
  } finally {
    if (appDb.sqlite.open) appDb.sqlite.close();
  }
}

/**
 * Updates one Light App schema within the initial evolution ceiling.
 *
 * @param context Command context.
 * @param appId App UUID.
 * @param expectedAppRevision Expected app revision.
 * @param expectedSchemaRevision Expected schema revision.
 * @param schema Next authored proposal, or the Core-admitted selected definition.
 * @param sourceSelection Explicit exact catalog source; direct edits clear source selection.
 * @param requestedDefinition Raw catalog selector bound independently of mutable selection pointers.
 * @returns Updated app.
 */
export async function updateLightAppSchema(
  context: KernelCommandContext,
  appId: string,
  expectedAppRevision: number,
  expectedSchemaRevision: number,
  schema: LightAppSchemaInput,
  sourceSelection?: LightAppDefinitionSource,
  requestedDefinition?: LightAppRequestedDefinition
): Promise<CreateLightAppResponse> {
  if (sourceSelection) LightAppDefinitionSourceSchema.parse(sourceSelection);
  return runNativeAppCommand(context, appId, {
    command: 'kernel.schema.update',
    responseKind: 'light_app',
    input: requestedDefinition
      ? { expectedAppRevision, expectedSchemaRevision, requestedDefinition }
      : { expectedAppRevision, expectedSchemaRevision, schema, sourceSelection },
    change: {
      kind: 'schema',
      expectedAppRevision,
      expectedSchemaRevision,
      schema,
      ...(sourceSelection ? { sourceSelection } : {}),
      ...(requestedDefinition ? { requestedDefinition } : {}),
    },
    replay: (db) => projectApp(db),
    responseId: (result) => result.appId,
  });
}

/**
 * Lists the consistent recovery copies retained by one app.
 *
 * @param dataRoot Data root.
 * @param workspaceId Owning Workspace.
 * @param appId App identity.
 * @returns Published snapshot metadata.
 */
export function listLightAppSnapshots(
  dataRoot: string,
  workspaceId: string,
  appId: string
): { snapshots: LightAppSnapshot[] } {
  return boundedKernelResponse({ snapshots: readLightAppSnapshots(dataRoot, workspaceId, appId) });
}

/**
 * Explicitly upgrades an app through the existing native app migration journal.
 *
 * Journal DDL commits before the ordinary command revision and receipt.
 * An interruption in that gap returns no success; retry inspects the actual journal and finishes the command without replaying completed DDL.
 *
 * @param context Authorized command context.
 * @param appId App identity.
 * @param expectedAppRevision Exact current app revision.
 * @returns Current-format app authority.
 */
export async function upgradeLightAppFormat(
  context: KernelCommandContext,
  appId: string,
  expectedAppRevision: number
): Promise<CreateLightAppResponse> {
  return runNativeAppCommand(context, appId, {
    command: 'kernel.format.upgrade',
    responseKind: 'light_app',
    input: { expectedAppRevision },
    change: { kind: 'format-complete', expectedAppRevision },
    replay: (db) => projectApp(db),
    responseId: (result) => result.appId,
  });
}

/**
 * Restores a selected complete SQLite copy, intentionally discarding later data.
 *
 * The candidate carries the existing app-local receipt and audit before atomic placement.
 * No application handle stays open across the replacement or an await.
 * Old-format recovery copies remain unavailable until explicit format upgrade.
 *
 * @param context Authorized command context.
 * @param appId App identity.
 * @param expectedAppRevision Exact current app revision.
 * @param snapshotId Explicit recovery copy.
 * @returns Restored app or explicit old-format unavailable projection.
 */
export async function rollbackLightAppSnapshot(
  context: KernelCommandContext,
  appId: string,
  expectedAppRevision: number,
  snapshotId: string
): Promise<CreateLightAppResponse> {
  return runNativeAppCommand(context, appId, {
    command: 'kernel.snapshots.rollback',
    responseKind: 'light_app',
    input: { expectedAppRevision, snapshotId },
    change: { kind: 'rollback', expectedAppRevision, snapshotId },
    replay: (db) => projectRestoredApp(db),
    responseId: (result) => result.appId,
  });
}

/**
 * Retires one Light App, disabling further writes.
 *
 * @param context Command context.
 * @param appId App UUID.
 * @param expectedAppRevision Expected app revision.
 * @returns Retired app.
 */
export async function retireLightApp(
  context: KernelCommandContext,
  appId: string,
  expectedAppRevision: number
): Promise<CreateLightAppResponse> {
  return runNativeAppCommand(context, appId, {
    command: 'kernel.apps.retire',
    responseKind: 'light_app',
    input: { expectedAppRevision },
    change: { kind: 'retire', expectedAppRevision },
    replay: (db) => projectApp(db),
    responseId: (result) => result.appId,
  });
}

/**
 * Lists records for one collection.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @param appId App UUID.
 * @param collectionSelector Collection id or name.
 * @param query List query.
 * @returns Paged records.
 */
export function listRecords(
  dataRoot: string,
  workspaceId: string,
  appId: string,
  collectionSelector: string,
  query: {
    schemaRevision: number;
    page?: number | undefined;
    perPage?: number | undefined;
    filter?: string | undefined;
    sort?: string | undefined;
    fields?: string | undefined;
  }
): ListLightAppRecordsResponse {
  const page = query.page ?? 1;
  const perPage = query.perPage ?? 30;
  assertPage(page, perPage);
  const appDb = openExistingAppDb(dataRoot, workspaceId, appId);
  try {
    const metadata = readMetadata(appDb);
    const schema = requireCurrentSchema(metadata, query.schemaRevision);
    const collection = resolveCollection(schema, collectionSelector);
    const fieldSet = parseFields(collection, query.fields);
    const compiled = compileRecordFilter(query.filter, (operand) => columnFor(collection, operand));
    const order = compileSort(collection, query.sort);
    const table = quoteIdent(collectionTableName(collection.id));
    const where = compiled ? `WHERE ${compiled.sql}` : '';
    const params = [...(compiled?.params ?? [])];
    return appDb.sqlite.transaction(() => {
      const totalRow = appDb.sqlite
        .prepare(`SELECT COUNT(*) AS total FROM ${table} ${where}`)
        .get(...params) as { total: number };
      const totalItems = totalRow.total;
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / perPage);
      const offset = (page - 1) * perPage;
      const rows = appDb.sqlite
        .prepare(`SELECT * FROM ${table} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...params, perPage, offset) as Record<string, unknown>[];
      return boundedKernelResponse({
        page,
        perPage,
        totalItems,
        totalPages,
        schemaRevision: schema.schemaRevision,
        completeResult: page === 1 && totalItems <= perPage,
        items: rows.map((row) => projectRecord(collection, schema.schemaRevision, row, fieldSet)),
      });
    })();
  } catch (error) {
    throw mapSqliteError(error);
  } finally {
    if (appDb.sqlite.open) appDb.sqlite.close();
  }
}

/**
 * Reads one record.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @param appId App UUID.
 * @param collectionSelector Collection id or name.
 * @param recordId Record UUID.
 * @param schemaRevision Inspected schema revision.
 * @param fields Optional field projection.
 * @returns Current record.
 */
export function getRecord(
  dataRoot: string,
  workspaceId: string,
  appId: string,
  collectionSelector: string,
  recordId: string,
  schemaRevision: number,
  fields?: string
): LightAppRecord {
  const appDb = openExistingAppDb(dataRoot, workspaceId, appId);
  try {
    const metadata = readMetadata(appDb);
    const schema = requireCurrentSchema(metadata, schemaRevision);
    const collection = resolveCollection(schema, collectionSelector);
    return boundedKernelResponse(
      readProjectedRecord(appDb, collection, schema.schemaRevision, recordId, fields)
    );
  } finally {
    if (appDb.sqlite.open) appDb.sqlite.close();
  }
}

/**
 * Creates one record.
 *
 * @param context Command context.
 * @param appId App UUID.
 * @param collectionSelector Collection id or name.
 * @param schemaRevision Inspected schema revision.
 * @param data Field values.
 * @returns Created record.
 */
export async function createRecord(
  context: KernelCommandContext,
  appId: string,
  collectionSelector: string,
  schemaRevision: number,
  data: Record<string, unknown>
): Promise<LightAppRecord> {
  const recordId = allocateRecordId(appId, context.requestId, 0, 'create');
  return runNativeAppCommand(context, appId, {
    command: 'kernel.records.create',
    responseKind: 'light_app_record',
    input: { collectionSelector, schemaRevision, data },
    change: { kind: 'record-create', collectionSelector, schemaRevision, data },
    replay: (db) => replayNamedRecord(db, recordId),
    responseId: (result) => result.id,
  });
}

/**
 * Updates one record with expected revisions.
 *
 * @param context Command context.
 * @param appId App UUID.
 * @param collectionSelector Collection id or name.
 * @param recordId Record UUID.
 * @param body Update body.
 * @returns Updated record.
 */
export async function updateRecord(
  context: KernelCommandContext,
  appId: string,
  collectionSelector: string,
  recordId: string,
  body: UpdateLightAppRecordRequest,
  lineage?: { presentationId: string; actionName: string; itemId: string; sourceFilter?: string }
): Promise<LightAppRecord> {
  return runNativeAppCommand(context, appId, {
    command: 'kernel.records.update',
    responseKind: 'light_app_record',
    input: { collectionSelector, recordId, ...body, ...(lineage ?? {}) },
    change: {
      kind: 'record-update',
      collectionSelector,
      recordId,
      body,
      ...(lineage ? { lineage } : {}),
    },
    replay: (db) => replayNamedRecord(db, recordId),
    responseId: (result) => result.id,
  });
}

/**
 * Applies a bounded atomic batch of creates and updates.
 *
 * @param context Command context.
 * @param appId App UUID.
 * @param body Batch body.
 * @returns Ordered current records.
 */
export async function batchRecords(
  context: KernelCommandContext,
  appId: string,
  body: LightAppBatchRequest
): Promise<LightAppBatchResponse> {
  return runNativeAppCommand(context, appId, {
    command: 'kernel.records.batch',
    responseKind: 'light_app_batch',
    input: body,
    change: { kind: 'record-batch', body },
    replay: (db) => replayBatch(db, context, body),
    responseId: () => appId,
  });
}

/**
 * Compiles a sort clause with id as the unique tiebreaker.
 *
 * @param collection Admitted collection.
 * @param sort Caller sort text.
 * @returns SQL ORDER BY.
 */
function compileSort(collection: LightAppAdmittedCollection, sort: string | undefined): string {
  const clauses: string[] = [];
  if (sort && sort.trim() !== '') {
    const parts = sort
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > LIGHT_APP_CAPABILITIES.maxSortFields) {
      throw new KernelCommandError('validation_failed', 'Sort accepts at most three fields.', {
        path: 'sort',
      });
    }
    for (const part of parts) {
      const descending = part.startsWith('-');
      const ascending = part.startsWith('+');
      const name = descending || ascending ? part.slice(1) : part;
      const column = columnFor(collection, name, 'sort');
      clauses.push(`${column.sql} ${descending ? 'DESC' : 'ASC'}`);
    }
  }
  clauses.push('id ASC');
  return clauses.join(', ');
}

/**
 * Enforces page and offset limits.
 *
 * @param page Page number.
 * @param perPage Page size.
 */
function assertPage(page: number, perPage: number): void {
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(perPage) ||
    perPage < 1 ||
    perPage > LIGHT_APP_CAPABILITIES.maxPerPage
  ) {
    throw new KernelCommandError(
      'validation_failed',
      'Page and perPage must be positive integers.',
      { path: 'page' }
    );
  }
  if ((page - 1) * perPage > LIGHT_APP_CAPABILITIES.maxOffset) {
    throw new KernelCommandError('limit_exceeded', 'List offset exceeds 10,000.', {
      limit: 'offset',
      maximum: LIGHT_APP_CAPABILITIES.maxOffset,
    });
  }
}

/**
 * Lists catalog items for one Workspace.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @returns Sorted catalog items.
 */
function listCatalogItems(dataRoot: string, workspaceId: string): LightAppCatalogItem[] {
  const root = lightAppsRoot(dataRoot, workspaceId);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => inspectCatalogItem(dataRoot, workspaceId, entry.name))
    .sort((left, right) => compareCodeUnits(left.appId, right.appId));
}

/**
 * Projects one catalog item from app authority, including unavailable apps.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @param appId App id.
 * @returns Catalog item.
 */
function inspectCatalogItem(
  dataRoot: string,
  workspaceId: string,
  appId: string
): LightAppCatalogItem {
  try {
    const appDb = openExistingAppDb(dataRoot, workspaceId, appId);
    try {
      return catalogItemFromMetadata(readMetadata(appDb));
    } finally {
      if (appDb.sqlite.open) appDb.sqlite.close();
    }
  } catch {
    // Migration inspection can expose the old marker and exact revision while ordinary Kernel data access remains closed until explicit upgrade.
    try {
      const migrationDb = openExistingAppDb(dataRoot, workspaceId, appId, 'format-upgrade');
      try {
        const {
          schema: _schema,
          capabilities: _capabilities,
          ...item
        } = projectRestoredApp(migrationDb);
        return item;
      } finally {
        migrationDb.sqlite.close();
      }
    } catch {
      /* Missing, corrupt, and unknown formats have no admitted projection. */
    }
    return {
      appId,
      title: 'Unavailable app',
      purpose: '',
      appRevision: null,
      schemaRevision: null,
      schemaDigest: null,
      kernelFormatVersion: null,
      definitionVersion: null,
      definitionSource: null,
      lifecycle: 'unavailable',
    };
  }
}

/**
 * Ensures the Light App inventory directory exists.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 */
function ensureLightAppsInventory(dataRoot: string, workspaceId: string): void {
  mkdirSync(lightAppsRoot(dataRoot, workspaceId), { recursive: true });
}

/**
 * Counts app directories including interrupted creations.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @returns Directory count.
 */
function countAppDirectories(dataRoot: string, workspaceId: string): number {
  const root = lightAppsRoot(dataRoot, workspaceId);
  if (!existsSync(root)) {
    return 0;
  }
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

/** Executes only readonly projections with a short App connection. */
function readApp<T>(
  context: KernelCommandContext,
  appId: string,
  replay: (db: AppDb) => T,
  permitOldFormat = false
): T {
  const db = openExistingAppDb(
    context.dataRoot,
    context.workspaceId,
    appId,
    permitOldFormat ? 'format-upgrade' : 'current'
  );
  try {
    return boundedKernelResponse(replay(db));
  } finally {
    db.sqlite.close();
  }
}

/** Collapses duplicates before preparation; native business, Audit and original receipt share one ACK. */
function runNativeAppCommand<T extends ControlAppResult>(
  context: KernelCommandContext,
  appId: string,
  spec: KernelCommandSpec<T>
): Promise<T> {
  return runIdempotentCommand({
    store: context.store,
    inflightCommands: context.inflightCommands,
    command: spec.command,
    requestId: context.requestId,
    scope: { workspaceId: context.workspaceId, appId },
    input: { actor: context.actor, ...asObject(spec.input) },
    responseKind: spec.responseKind,
    responseId: spec.responseId,
    replay: () =>
      readApp(
        context,
        appId,
        spec.replay,
        spec.command === 'kernel.format.upgrade' || spec.command === 'kernel.snapshots.rollback'
      ),
    execute: async (receipt) => {
      await context.recheckAdmission?.();
      const client = getControlStoreWorkerClient();
      const root = lightAppRoot(context.dataRoot, context.workspaceId, appId);
      const fresh = spec.change.kind === 'create';
      if (fresh) {
        if (spec.change.kind === 'create' && !spec.change.sourceSelection)
          admitLightAppSchema(spec.change.schema, appId, 1);
        if (existsSync(root))
          throw new KernelCommandError(
            'recovery_required',
            'Interrupted app creation cannot be replayed.'
          );
        ensureLightAppsInventory(context.dataRoot, context.workspaceId);
        if (countAppDirectories(context.dataRoot, context.workspaceId) >= APP_DIRECTORY_LIMIT)
          throw new KernelCommandError('limit_exceeded', 'Workspace Light App limit exceeded.', {
            limit: 'apps',
            maximum: APP_DIRECTORY_LIMIT,
          });
        createDirectoryExclusive(root, 0o777);
      } else {
        const checked = openExistingAppDb(
          context.dataRoot,
          context.workspaceId,
          appId,
          spec.change.kind === 'format-complete' || spec.change.kind === 'rollback'
            ? 'format-upgrade'
            : 'current'
        );
        checked.sqlite.close();
      }
      const path = lightAppDbPath(context.dataRoot, context.workspaceId, appId);
      const database = `app:${path}`;
      await client.open({
        database,
        path,
        create: fresh,
        dataRoot: context.dataRoot,
        physicalScope: { kind: 'app', workspaceId: context.workspaceId, appId },
      });
      await context.recheckAdmission?.();
      const input: Omit<ControlAppInput, 'change'> & { change: KernelCommandSpec<T>['change'] } = {
        workspaceId: context.workspaceId,
        appId,
        actor: context.actor,
        requestId: context.requestId,
        ...(context.execution ? { execution: context.execution } : {}),
        receipt: ControlAppInputSchema.shape.receipt.parse(receipt),
        change: spec.change,
      };
      const publish = async (owned: typeof input) => {
        if (owned.change.kind === 'format-complete') {
          await client.appKernel(
            database,
            ControlAppInputSchema.parse({
              ...owned,
              change: { ...owned.change, kind: 'format-journal' },
            })
          );
          await context.recheckAdmission?.();
        }
        if (owned.change.kind === 'rollback') return publishRollback(context, database, owned);
        return client.appKernel(database, ControlAppInputSchema.parse(owned));
      };
      const result = context.execution
        ? await client.runTurnPublication(database, [context.execution.turnId], input, publish)
        : await publish(input);
      return boundedKernelResponse(result) as T;
    },
  });
}

/** Prepares an immutable complete candidate; only ordered native maintenance may replace canonical authority. */
async function publishRollback(
  context: KernelCommandContext,
  database: string,
  input: Omit<ControlAppInput, 'change'> & { change: KernelCommandSpec<ControlAppResult>['change'] }
): Promise<ControlAppResult> {
  if (input.change.kind !== 'rollback') throw new Error('Expected App rollback.');
  const client = getControlStoreWorkerClient();
  const { appId } = input;
  const change = input.change;
  const selected = readLightAppSnapshots(context.dataRoot, context.workspaceId, appId).find(
    (row) => row.snapshotId === change.snapshotId
  );
  if (!selected) throw new KernelCommandError('not_found', 'App snapshot was not found.');
  const root = lightAppRoot(context.dataRoot, context.workspaceId, appId);
  const sourcePath = join(root, 'snapshots', `${selected.snapshotId}.sqlite`);
  const source = statSync(sourcePath);
  // Pinned SQLite maps one 32 KiB WAL-index region for a fresh, empty-WAL readonly copy.
  const capacity = client.reserveAppRollback(database, source.size + APP_ROLLBACK_SIDECAR_BYTES);
  const candidatePath = join(root, `restore-${randomUUID()}.sqlite`);
  let transferred = false;
  let unknown = false;
  let ownsSidecars = false;
  try {
    await copyVerifiedFile({
      sourcePath,
      destinationPath: candidatePath,
      expectedBytes: source.size,
      maxBytes: source.size,
      expectedSha256: selected.digest,
      mode: 0o400,
    });
    capacity.recordWritten(source.size);
    const sidecars = [`${candidatePath}-wal`, `${candidatePath}-shm`];
    for (const path of sidecars)
      if (lstatSync(path, { throwIfNoEntry: false }))
        throw new KernelCommandError(
          'unavailable',
          'App rollback candidate sidecar already exists.'
        );
    ownsSidecars = true;
    let sqlite: Database.Database | undefined;
    try {
      sqlite = openAppDbReadOnly(candidatePath);
      assertSnapshotRelations(sqlite);
      const candidate: AppDb = {
        scope: 'app',
        sqlite,
        dataRoot: context.dataRoot,
        workspaceId: context.workspaceId,
        appId,
      };
      assertAppDefinitionMatches(candidate);
      const row = sqlite
        .prepare(
          'SELECT app_id AS appId,workspace_id AS workspaceId,schema_digest AS digest FROM app_metadata'
        )
        .get() as { appId: string; workspaceId: string; digest: string };
      if (
        row.appId !== appId ||
        row.workspaceId !== context.workspaceId ||
        row.digest !== selected.definitionVersion
      )
        throw new KernelCommandError('unavailable', 'App snapshot identity does not match.');
    } finally {
      sqlite?.close();
      await clearRollbackCandidateSidecars(candidatePath);
    }
    await syncCanonicalDirectoryAsync(root);
    const candidate = statSync(candidatePath);
    await context.recheckAdmission?.();
    transferred = true;
    return await client.appKernel(
      database,
      ControlAppInputSchema.parse({
        ...input,
        change: {
          ...input.change,
          schemaRevision: selected.schemaRevision,
          definitionVersion: selected.definitionVersion,
          snapshotDigest: selected.digest,
          candidate: {
            path: candidatePath,
            dev: String(candidate.dev),
            ino: String(candidate.ino),
            size: candidate.size,
            mtimeMs: candidate.mtimeMs,
            ctimeMs: candidate.ctimeMs,
          },
        },
      }),
      capacity
    );
  } catch (error) {
    unknown = error instanceof ControlStoreWorkerError && error.commit === 'unknown';
    throw error;
  } finally {
    if (!unknown) await discardRollbackCandidate(candidatePath, ownsSidecars);
    // Failed cleanup leaves the existing forecast held; absence must precede release.
    if (!transferred) capacity.release();
  }
}

const APP_ROLLBACK_SIDECAR_BYTES = 32_768;

/** Removes only the closed auxiliary files of the uniquely owned, empty-WAL candidate. */
async function clearRollbackCandidateSidecars(candidatePath: string): Promise<void> {
  for (const suffix of ['-wal', '-shm']) {
    const path = `${candidatePath}${suffix}`;
    const sidecar = lstatSync(path, { throwIfNoEntry: false });
    if (!sidecar) continue;
    if (
      !sidecar.isFile() ||
      sidecar.isSymbolicLink() ||
      sidecar.nlink !== 1 ||
      (suffix === '-wal' ? sidecar.size !== 0 : sidecar.size > APP_ROLLBACK_SIDECAR_BYTES)
    )
      throw new KernelCommandError('unavailable', 'App rollback candidate sidecar changed.');
    await removeDurableFile({ destinationPath: path });
    if (lstatSync(path, { throwIfNoEntry: false }))
      throw new KernelCommandError(
        'unavailable',
        'App rollback candidate sidecar cleanup is incomplete.'
      );
  }
}

/** Proves known-outcome scratch removal before the caller can release its physical forecast. */
async function discardRollbackCandidate(
  candidatePath: string,
  ownsSidecars: boolean
): Promise<void> {
  if (ownsSidecars) await clearRollbackCandidateSidecars(candidatePath);
  await removeDurableFile({ destinationPath: candidatePath });
  await removeDurableFile({ destinationPath: `${candidatePath}-journal` });
  if (
    lstatSync(candidatePath, { throwIfNoEntry: false }) ||
    lstatSync(`${candidatePath}-journal`, { throwIfNoEntry: false })
  )
    throw new KernelCommandError('unavailable', 'App rollback candidate cleanup is incomplete.');
}
