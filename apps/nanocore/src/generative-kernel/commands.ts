import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  type CreateLightAppResponse,
  type GetLightAppResponse,
  type LightAppAdmittedCollection,
  type LightAppAdmittedSchema,
  LightAppAdmittedSchemaSchema,
  type LightAppBatchRequest,
  type LightAppBatchResponse,
  type LightAppCatalogItem,
  type LightAppRecord,
  type LightAppSchemaInput,
  type ListLightAppRecordsResponse,
  type ListLightAppsResponse,
  type UpdateLightAppRecordRequest,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';

import { recordAppAuditEvent } from '../audit-events.js';
import type { CommandRequestName, CommandRequestRecord, FsStore } from '../lib/store.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import {
  type AppDb,
  createAppDb,
  isSqliteBusy,
  lightAppDbPath,
  lightAppRoot,
  lightAppsRoot,
  openExistingAppDb,
  writeDurableFile,
} from '../storage/app-db.js';
import { KernelCommandError } from './errors.js';
import { compileRecordFilter } from './filter.js';
import {
  additiveSchemaDdl,
  collectionTableName,
  createSchemaDdl,
  fieldColumnName,
  quoteIdent,
} from './native.js';
import { admitLightAppSchema } from './schema.js';
import { allocateAppId, allocateRecordId } from './uuid.js';

const APP_DIRECTORY_LIMIT = 128;
const RECORD_LIMIT = 10_000;
const DATA_OBJECT_BYTE_LIMIT = 16 * 1024;
const TEXT_BYTE_LIMIT = 4096;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isCanonicalUtcDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
const BATCH_POST = /^\/api\/collections\/([^/]+)\/records$/;
const BATCH_PATCH = /^\/api\/collections\/([^/]+)\/records\/([^/]+)$/;
const EMPTY_DIGEST = `sha256:${createHash('sha256').update('').digest('hex')}`;

/** Discoverable Kernel vocabulary returned by app get. */
export const LIGHT_APP_CAPABILITIES = {
  fieldTypes: ['text', 'number', 'bool', 'date', 'select', 'relation'],
  filterOperators: ['=', '!=', '>', '>=', '<', '<=', '&&', '||'],
  maxPerPage: 100,
  maxRecords: 10_000,
  maxBatchEntries: 50,
  maxFilterBytes: 2048,
} as const satisfies {
  fieldTypes: Array<'text' | 'number' | 'bool' | 'date' | 'select' | 'relation'>;
  filterOperators: Array<'=' | '!=' | '>' | '>=' | '<' | '<=' | '&&' | '||'>;
  maxPerPage: 100;
  maxRecords: 10_000;
  maxBatchEntries: 50;
  maxFilterBytes: 2048;
};

const LIGHT_APP_CAPABILITIES_VIEW = {
  fieldTypes: [...LIGHT_APP_CAPABILITIES.fieldTypes],
  filterOperators: [...LIGHT_APP_CAPABILITIES.filterOperators],
  maxPerPage: 100 as const,
  maxRecords: 10_000 as const,
  maxBatchEntries: 50 as const,
  maxFilterBytes: 2048 as const,
};

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
  /** Caller request id. */
  readonly requestId: string;
}

type AppMetadataRow = {
  appId: string;
  workspaceId: string;
  title: string;
  purpose: string;
  appRevision: number;
  schemaRevision: number;
  schemaDigest: string;
  schemaJson: string;
  lifecycle: 'active' | 'retired';
};

type KernelCommandSpec<T> = {
  command: CommandRequestName;
  responseKind: 'light_app' | 'light_app_record' | 'light_app_batch';
  input: unknown;
  execute: () => T;
  replay: (record: CommandRequestRecord) => T;
  responseId: (result: T) => string;
};

type ParsedBatchEntry =
  | {
      method: 'POST';
      collection: LightAppAdmittedCollection;
      data: Record<string, string | number | boolean | null>;
    }
  | {
      method: 'PATCH';
      collection: LightAppAdmittedCollection;
      recordId: string;
      expectedRecordRevision: number;
      data: Record<string, string | number | boolean | null>;
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
  return {
    page,
    perPage,
    totalItems,
    totalPages,
    items: items.slice(start, start + perPage),
  };
}

/**
 * Creates one Light App from a file-authored schema.
 *
 * @param context Command context.
 * @param schema Schema proposal.
 * @returns Created app.
 */
export async function createLightApp(
  context: KernelCommandContext,
  schema: LightAppSchemaInput
): Promise<CreateLightAppResponse> {
  const appId = allocateAppId(context.workspaceId, context.requestId);
  const appRoot = lightAppRoot(context.dataRoot, context.workspaceId, appId);
  const admitted = admitLightAppSchema(schema, appId, 1);
  if (existsSync(appRoot)) {
    return replayOrRecoverCreate(context, appId, schema);
  }
  ensureLightAppsInventory(context.dataRoot, context.workspaceId);
  if (countAppDirectories(context.dataRoot, context.workspaceId) >= APP_DIRECTORY_LIMIT) {
    throw new KernelCommandError('limit_exceeded', 'Workspace Light App limit exceeded.', {
      limit: 'apps',
      maximum: APP_DIRECTORY_LIMIT,
    });
  }
  try {
    mkdirSync(appRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return replayOrRecoverCreate(context, appId, schema);
    }
    throw error;
  }
  const schemaJson = `${JSON.stringify(admitted)}\n`;
  const schemaDigest = persistDefinition(appRoot, schemaJson);
  const appDb = createAppDb(context.dataRoot, context.workspaceId, appId);
  try {
    return await runKernelCommand(context, appDb, {
      command: 'kernel.apps.create',
      responseKind: 'light_app',
      input: { schema },
      execute: () =>
        commitNewApp(appDb, {
          admitted,
          schemaDigest,
          schemaJson,
          actor: context.actor,
          requestId: context.requestId,
        }),
      replay: () => projectApp(appDb),
      responseId: (result) => result.appId,
    });
  } catch (error) {
    throw mapSqliteError(error);
  } finally {
    appDb.sqlite.close();
  }
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
  const item = inspectCatalogItem(dataRoot, workspaceId, appId);
  if (item.lifecycle === 'unavailable') {
    return { ...item, schema: null, capabilities: LIGHT_APP_CAPABILITIES_VIEW };
  }
  const appDb = openExistingAppDb(dataRoot, workspaceId, appId);
  try {
    return projectApp(appDb);
  } finally {
    appDb.sqlite.close();
  }
}

/**
 * Updates one Light App schema within the initial evolution ceiling.
 *
 * @param context Command context.
 * @param appId App UUID.
 * @param expectedAppRevision Expected app revision.
 * @param expectedSchemaRevision Expected schema revision.
 * @param schema Next schema proposal.
 * @returns Updated app.
 */
export async function updateLightAppSchema(
  context: KernelCommandContext,
  appId: string,
  expectedAppRevision: number,
  expectedSchemaRevision: number,
  schema: LightAppSchemaInput
): Promise<GetLightAppResponse> {
  return withAppDb(context.dataRoot, context.workspaceId, appId, async (appDb) => {
    return runKernelCommand(context, appDb, {
      command: 'kernel.schema.update',
      responseKind: 'light_app',
      input: { expectedAppRevision, expectedSchemaRevision, schema },
      execute: () => {
        const current = readMetadata(appDb);
        assertWritable(current);
        if (
          current.appRevision !== expectedAppRevision ||
          current.schemaRevision !== expectedSchemaRevision
        ) {
          throw new KernelCommandError('conflict', 'App or schema revision is stale.');
        }
        const admitted = admitLightAppSchema(
          schema,
          appId,
          expectedSchemaRevision + 1,
          parseSchema(current)
        );
        const schemaJson = `${JSON.stringify(admitted)}\n`;
        const schemaDigest = persistDefinition(
          lightAppRoot(context.dataRoot, context.workspaceId, appId),
          schemaJson
        );
        for (const statement of additiveSchemaDdl(parseSchema(current), admitted)) {
          appDb.sqlite.exec(statement);
        }
        const now = new Date().toISOString();
        appDb.sqlite
          .prepare(
            `UPDATE app_metadata SET
              title = ?, purpose = ?, app_revision = ?, schema_revision = ?,
              schema_digest = ?, schema_json = ?, updated_at = ?, last_mutator_json = ?, last_request_id = ?
             WHERE app_id = ?`
          )
          .run(
            admitted.title,
            admitted.purpose,
            current.appRevision + 1,
            admitted.schemaRevision,
            schemaDigest,
            schemaJson,
            now,
            JSON.stringify(context.actor),
            context.requestId,
            appId
          );
        recordKernelAudit(
          appDb,
          context,
          'kernel.schema.update',
          `light-app:${appId}`,
          admitted.schemaRevision
        );
        return projectApp(appDb);
      },
      replay: () => projectApp(appDb),
      responseId: (result) => result.appId,
    });
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
): Promise<GetLightAppResponse> {
  return withAppDb(context.dataRoot, context.workspaceId, appId, async (appDb) =>
    runKernelCommand(context, appDb, {
      command: 'kernel.apps.retire',
      responseKind: 'light_app',
      input: { expectedAppRevision },
      execute: () => {
        const metadata = readMetadata(appDb);
        assertWritable(metadata);
        if (metadata.appRevision !== expectedAppRevision) {
          throw new KernelCommandError('conflict', 'App revision is stale.');
        }
        const now = new Date().toISOString();
        appDb.sqlite
          .prepare(
            `UPDATE app_metadata SET lifecycle = 'retired', app_revision = ?, updated_at = ?, last_mutator_json = ?, last_request_id = ?
             WHERE app_id = ?`
          )
          .run(
            metadata.appRevision + 1,
            now,
            JSON.stringify(context.actor),
            context.requestId,
            appId
          );
        recordKernelAudit(
          appDb,
          context,
          'kernel.apps.retire',
          `light-app:${appId}`,
          metadata.appRevision + 1
        );
        return projectApp(appDb);
      },
      replay: () => projectApp(appDb),
      responseId: (result) => result.appId,
    })
  );
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
    const totalRow = appDb.sqlite
      .prepare(`SELECT COUNT(*) AS total FROM ${table} ${where}`)
      .get(...params) as { total: number };
    const totalItems = totalRow.total;
    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / perPage);
    const offset = (page - 1) * perPage;
    const rows = appDb.sqlite
      .prepare(`SELECT * FROM ${table} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, perPage, offset) as Record<string, unknown>[];
    return {
      page,
      perPage,
      totalItems,
      totalPages,
      schemaRevision: schema.schemaRevision,
      completeResult: page === 1 && totalItems <= perPage,
      items: rows.map((row) => projectRecord(collection, schema.schemaRevision, row, fieldSet)),
    };
  } catch (error) {
    throw mapSqliteError(error);
  } finally {
    appDb.sqlite.close();
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
    return readProjectedRecord(appDb, collection, schema.schemaRevision, recordId, fields);
  } finally {
    appDb.sqlite.close();
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
  return withAppDb(context.dataRoot, context.workspaceId, appId, async (appDb) =>
    runKernelCommand(context, appDb, {
      command: 'kernel.records.create',
      responseKind: 'light_app_record',
      input: { collectionSelector, schemaRevision, data },
      execute: () => {
        const metadata = readMetadata(appDb);
        assertWritable(metadata);
        const schema = requireCurrentSchema(metadata, schemaRevision);
        const collection = resolveCollection(schema, collectionSelector);
        assertRecordCeiling(appDb, schema, 1);
        insertRecordRow(
          appDb,
          collection,
          schema,
          recordId,
          data,
          context.actor,
          context.requestId
        );
        recordKernelAudit(
          appDb,
          context,
          'kernel.records.create',
          `light-app:${appId}:record:${recordId}`,
          1
        );
        return readProjectedRecord(appDb, collection, schema.schemaRevision, recordId);
      },
      replay: () => replayNamedRecord(appDb, recordId),
      responseId: (result) => result.id,
    })
  );
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
  lineage?: { presentationId: string; actionName: string; itemId: string }
): Promise<LightAppRecord> {
  return withAppDb(context.dataRoot, context.workspaceId, appId, async (appDb) =>
    runKernelCommand(context, appDb, {
      command: 'kernel.records.update',
      responseKind: 'light_app_record',
      input: { collectionSelector, recordId, ...body, ...(lineage ?? {}) },
      execute: () => {
        applyRecordUpdate(appDb, context, collectionSelector, recordId, body);
        return readProjectedRecord(
          appDb,
          resolveCollection(parseSchema(readMetadata(appDb)), collectionSelector),
          body.schemaRevision,
          recordId
        );
      },
      replay: () => replayNamedRecord(appDb, recordId),
      responseId: (result) => result.id,
    })
  );
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
  return withAppDb(context.dataRoot, context.workspaceId, appId, async (appDb) =>
    runKernelCommand(context, appDb, {
      command: 'kernel.records.batch',
      responseKind: 'light_app_batch',
      input: body,
      execute: () => executeBatch(appDb, context, body),
      replay: () => replayBatch(appDb, context, body),
      responseId: () => appId,
    })
  );
}

/**
 * Opens an app database, runs work, and always closes the handle.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @param appId App id.
 * @param work Async work.
 * @returns Work result.
 */
async function withAppDb<T>(
  dataRoot: string,
  workspaceId: string,
  appId: string,
  work: (appDb: AppDb) => Promise<T>
): Promise<T> {
  const appDb = openExistingAppDb(dataRoot, workspaceId, appId);
  try {
    return await work(appDb);
  } catch (error) {
    throw mapSqliteError(error);
  } finally {
    appDb.sqlite.close();
  }
}

/**
 * Runs one app-local idempotent Kernel command.
 *
 * @param context Command context.
 * @param appDb Open app database.
 * @param spec Command spec.
 * @returns Command result.
 */
async function runKernelCommand<T>(
  context: KernelCommandContext,
  appDb: AppDb,
  spec: KernelCommandSpec<T>
): Promise<T> {
  return runIdempotentCommand({
    store: context.store,
    inflightCommands: context.inflightCommands,
    command: spec.command,
    requestId: context.requestId,
    scope: {
      workspaceId: context.workspaceId,
      appId: appDb.appId,
      actorId: actorScopeId(context.actor),
    },
    input: { actor: context.actor, ...asObject(spec.input) },
    responseKind: spec.responseKind,
    appDb,
    appTransaction: true,
    execute: spec.execute,
    replay: spec.replay,
    responseId: spec.responseId,
  });
}

/**
 * Replays or refuses an existing app directory for create.
 *
 * @param context Command context.
 * @param appId Allocated app id.
 * @param schema Original schema input.
 * @returns Replayed create result.
 */
async function replayOrRecoverCreate(
  context: KernelCommandContext,
  appId: string,
  schema: LightAppSchemaInput
): Promise<CreateLightAppResponse> {
  if (!existsSync(lightAppDbPath(context.dataRoot, context.workspaceId, appId))) {
    throw new KernelCommandError(
      'recovery_required',
      'Interrupted app creation cannot be replayed.'
    );
  }
  let appDb: AppDb;
  try {
    appDb = openExistingAppDb(context.dataRoot, context.workspaceId, appId);
  } catch {
    throw new KernelCommandError(
      'recovery_required',
      'Interrupted app creation cannot be replayed.'
    );
  }
  try {
    return await runKernelCommand(context, appDb, {
      command: 'kernel.apps.create',
      responseKind: 'light_app',
      input: { schema },
      execute: () => {
        throw new KernelCommandError(
          'recovery_required',
          'Interrupted app creation cannot be replayed.'
        );
      },
      replay: () => projectApp(appDb),
      responseId: (result) => result.appId,
    });
  } finally {
    appDb.sqlite.close();
  }
}

/**
 * Commits the first app metadata, DDL, and audit event.
 *
 * @param appDb Open app database.
 * @param input Admitted schema and lineage.
 * @returns Created app projection.
 */
function commitNewApp(
  appDb: AppDb,
  input: {
    admitted: LightAppAdmittedSchema;
    schemaDigest: string;
    schemaJson: string;
    actor: ActorRef;
    requestId: string;
  }
): GetLightAppResponse {
  const now = new Date().toISOString();
  for (const statement of createSchemaDdl(input.admitted)) {
    appDb.sqlite.exec(statement);
  }
  appDb.sqlite
    .prepare(
      `INSERT INTO app_metadata (
        app_id, workspace_id, title, purpose, app_revision, schema_revision,
        schema_digest, schema_json, lifecycle, created_at, updated_at,
        creator_json, last_mutator_json, create_request_id, last_request_id
      ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.admitted.appId,
      appDb.workspaceId,
      input.admitted.title,
      input.admitted.purpose,
      input.schemaDigest,
      input.schemaJson,
      now,
      now,
      JSON.stringify(input.actor),
      JSON.stringify(input.actor),
      input.requestId,
      input.requestId
    );
  recordAppAuditEvent({
    sqlite: appDb.sqlite,
    workspaceId: appDb.workspaceId,
    actor: input.actor,
    requestId: input.requestId,
    category: 'system',
    action: 'kernel.apps.create',
    resource: `light-app:${input.admitted.appId}`,
    resourceRevision: 1,
    outcome: 'succeeded',
    summary: 'Created Light App.',
  });
  return projectApp(appDb);
}

/**
 * Executes one batch inside the app transaction.
 *
 * @param appDb Open app database.
 * @param context Command context.
 * @param body Batch body.
 * @returns Batch result.
 */
function executeBatch(
  appDb: AppDb,
  context: KernelCommandContext,
  body: LightAppBatchRequest
): LightAppBatchResponse {
  const metadata = readMetadata(appDb);
  assertWritable(metadata);
  const schema = requireCurrentSchema(metadata, body.schemaRevision);
  const parsed = parseBatchEntries(schema, body);
  const created = parsed.filter((entry) => entry.method === 'POST').length;
  assertRecordCeiling(appDb, schema, created);
  const updateTargets = new Set<string>();
  const createdIds = new Set<string>();
  const resultIds: string[] = [];
  parsed.forEach((entry, index) => {
    if (entry.method === 'POST') {
      const recordId = allocateRecordId(appDb.appId, context.requestId, index, 'batch');
      createdIds.add(recordId);
      insertRecordRow(
        appDb,
        entry.collection,
        schema,
        recordId,
        entry.data,
        context.actor,
        context.requestId,
        createdIds
      );
      resultIds.push(recordId);
      return;
    }
    if (updateTargets.has(entry.recordId) || createdIds.has(entry.recordId)) {
      throw new KernelCommandError(
        'validation_failed',
        'Batch update targets must be unique existing records.'
      );
    }
    updateTargets.add(entry.recordId);
    applyRecordUpdate(
      appDb,
      context,
      entry.collection.id,
      entry.recordId,
      {
        schemaRevision: schema.schemaRevision,
        expectedRecordRevision: entry.expectedRecordRevision,
        data: entry.data,
      },
      false
    );
    resultIds.push(entry.recordId);
  });
  recordKernelAudit(
    appDb,
    context,
    'kernel.records.batch',
    `light-app:${appDb.appId}`,
    schema.schemaRevision
  );
  return {
    app: catalogItemFromMetadata(readMetadata(appDb)),
    items: resultIds.map((recordId) => replayNamedRecord(appDb, recordId)),
  };
}

/**
 * Replays one batch from the verified original request.
 *
 * @param appDb Open app database.
 * @param context Command context.
 * @param body Original batch body.
 * @returns Current records in request order.
 */
function replayBatch(
  appDb: AppDb,
  context: KernelCommandContext,
  body: LightAppBatchRequest
): LightAppBatchResponse {
  const schema = parseSchema(readMetadata(appDb));
  const parsed = parseBatchEntries(schema, body);
  return {
    app: catalogItemFromMetadata(readMetadata(appDb)),
    items: parsed.map((entry, index) => {
      const recordId =
        entry.method === 'POST'
          ? allocateRecordId(appDb.appId, context.requestId, index, 'batch')
          : entry.recordId;
      return replayNamedRecord(appDb, recordId);
    }),
  };
}

/**
 * Inserts one native record row.
 *
 * @param appDb Open app database.
 * @param collection Admitted collection.
 * @param schema Admitted schema.
 * @param recordId Allocated record id.
 * @param data Caller field values.
 * @param actor Actor.
 * @param requestId Request id.
 * @param pendingCreatedIds In-batch created ids that relations may not target.
 */
function insertRecordRow(
  appDb: AppDb,
  collection: LightAppAdmittedCollection,
  schema: LightAppAdmittedSchema,
  recordId: string,
  data: Record<string, unknown>,
  actor: ActorRef,
  requestId: string,
  pendingCreatedIds: ReadonlySet<string> = new Set()
): void {
  const now = new Date().toISOString();
  const values = validateRecordData(appDb, collection, schema, data, true, pendingCreatedIds);
  const columns = [
    'id',
    'revision',
    'created',
    'updated',
    'creator_json',
    'last_mutator_json',
    'create_request_id',
    'last_request_id',
    'write_schema_revision',
    ...collection.fields.map((field) => fieldColumnName(field.id)),
  ];
  const placeholders = columns.map(() => '?').join(', ');
  const quoted = columns.map((column) => quoteIdent(column)).join(', ');
  appDb.sqlite
    .prepare(
      `INSERT INTO ${quoteIdent(collectionTableName(collection.id))} (${quoted}) VALUES (${placeholders})`
    )
    .run(
      recordId,
      1,
      now,
      now,
      JSON.stringify(actor),
      JSON.stringify(actor),
      requestId,
      requestId,
      schema.schemaRevision,
      ...collection.fields.map((field) => encodeSqlValue(field.type, values[field.name] ?? null))
    );
}

/**
 * Applies one record update.
 *
 * @param appDb Open app database.
 * @param context Command context.
 * @param collectionSelector Collection selector.
 * @param recordId Record id.
 * @param body Update body.
 * @param audit Whether to write an audit event.
 */
function applyRecordUpdate(
  appDb: AppDb,
  context: KernelCommandContext,
  collectionSelector: string,
  recordId: string,
  body: UpdateLightAppRecordRequest,
  audit = true
): void {
  const metadata = readMetadata(appDb);
  assertWritable(metadata);
  const schema = requireCurrentSchema(metadata, body.schemaRevision);
  const collection = resolveCollection(schema, collectionSelector);
  const current = readRecordRow(appDb, collection, recordId);
  if (Number(current.revision) !== body.expectedRecordRevision) {
    throw new KernelCommandError('conflict', 'Record revision is stale.');
  }
  const values = validateRecordData(appDb, collection, schema, body.data, false);
  const merged: Record<string, unknown> = {};
  for (const field of collection.fields) {
    merged[field.name] = Object.hasOwn(body.data, field.name)
      ? values[field.name]
      : decodeSqlValue(field.type, current[fieldColumnName(field.id)]);
  }
  if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > DATA_OBJECT_BYTE_LIMIT) {
    throw new KernelCommandError('limit_exceeded', 'Record data exceeds 16 KiB.', {
      limit: 'dataObjectBytes',
      maximum: DATA_OBJECT_BYTE_LIMIT,
    });
  }
  const assignments = [
    'revision = ?',
    'updated = ?',
    'last_mutator_json = ?',
    'last_request_id = ?',
    'write_schema_revision = ?',
  ];
  const params: unknown[] = [
    Number(current.revision) + 1,
    new Date().toISOString(),
    JSON.stringify(context.actor),
    context.requestId,
    schema.schemaRevision,
  ];
  for (const field of collection.fields) {
    if (!Object.hasOwn(body.data, field.name)) {
      continue;
    }
    assignments.push(`${quoteIdent(fieldColumnName(field.id))} = ?`);
    params.push(encodeSqlValue(field.type, values[field.name] ?? null));
  }
  params.push(recordId);
  const result = appDb.sqlite
    .prepare(
      `UPDATE ${quoteIdent(collectionTableName(collection.id))} SET ${assignments.join(', ')} WHERE id = ?`
    )
    .run(...params);
  if (result.changes !== 1) {
    throw new KernelCommandError('not_found', 'Record not found.');
  }
  if (audit) {
    recordKernelAudit(
      appDb,
      context,
      'kernel.records.update',
      `light-app:${appDb.appId}:record:${recordId}`,
      Number(current.revision) + 1
    );
  }
}

/**
 * Validates one record data object against the admitted collection.
 *
 * @param appDb Open app database.
 * @param collection Admitted collection.
 * @param schema Admitted schema.
 * @param data Caller values.
 * @param create Whether omitted required fields fail.
 * @param pendingCreatedIds In-batch created ids.
 * @returns Normalized field values keyed by name.
 */
function validateRecordData(
  appDb: AppDb,
  collection: LightAppAdmittedCollection,
  schema: LightAppAdmittedSchema,
  data: Record<string, unknown>,
  create: boolean,
  pendingCreatedIds: ReadonlySet<string> = new Set()
): Record<string, unknown> {
  const encoded = JSON.stringify(data);
  if (Buffer.byteLength(encoded, 'utf8') > DATA_OBJECT_BYTE_LIMIT) {
    throw new KernelCommandError('limit_exceeded', 'Record data exceeds 16 KiB.', {
      limit: 'dataObjectBytes',
      maximum: DATA_OBJECT_BYTE_LIMIT,
    });
  }
  const known = new Set(collection.fields.map((field) => field.name));
  for (const key of Object.keys(data)) {
    if (!known.has(key)) {
      throw new KernelCommandError('validation_failed', `Unknown field: ${key}.`, { path: key });
    }
  }
  const values: Record<string, unknown> = {};
  for (const field of collection.fields) {
    const present = Object.hasOwn(data, field.name);
    if (!present) {
      if (create && field.required) {
        throw new KernelCommandError('validation_failed', `Field ${field.name} is required.`, {
          path: field.name,
        });
      }
      continue;
    }
    const value = data[field.name];
    if (value === null) {
      if (field.required) {
        throw new KernelCommandError('validation_failed', `Field ${field.name} cannot be null.`, {
          path: field.name,
        });
      }
      values[field.name] = null;
      continue;
    }
    values[field.name] = coerceFieldValue(appDb, schema, field, value, pendingCreatedIds);
  }
  return values;
}

/**
 * Coerces and checks one field value.
 *
 * @param appDb Open app database.
 * @param schema Admitted schema.
 * @param field Admitted field.
 * @param value Caller value.
 * @param pendingCreatedIds In-batch created ids.
 * @returns Canonical stored value.
 */
function coerceFieldValue(
  appDb: AppDb,
  schema: LightAppAdmittedSchema,
  field: LightAppAdmittedCollection['fields'][number],
  value: unknown,
  pendingCreatedIds: ReadonlySet<string>
): unknown {
  switch (field.type) {
    case 'text': {
      if (typeof value !== 'string') {
        throw new KernelCommandError('validation_failed', `Field ${field.name} must be text.`, {
          path: field.name,
        });
      }
      const max = (field.options as { max?: number } | undefined)?.max ?? TEXT_BYTE_LIMIT;
      if (Buffer.byteLength(value, 'utf8') > max) {
        throw new KernelCommandError('limit_exceeded', `Field ${field.name} exceeds text limit.`, {
          path: field.name,
          limit: 'textBytes',
          maximum: max,
        });
      }
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new KernelCommandError(
          'validation_failed',
          `Field ${field.name} must be a finite number.`,
          { path: field.name }
        );
      }
      const options =
        (field.options as { onlyInt?: boolean; min?: number; max?: number } | undefined) ?? {};
      if (options.onlyInt && !Number.isSafeInteger(value)) {
        throw new KernelCommandError(
          'validation_failed',
          `Field ${field.name} must be a safe integer.`,
          { path: field.name }
        );
      }
      if (options.min !== undefined && value < options.min) {
        throw new KernelCommandError('validation_failed', `Field ${field.name} is below minimum.`, {
          path: field.name,
        });
      }
      if (options.max !== undefined && value > options.max) {
        throw new KernelCommandError('validation_failed', `Field ${field.name} is above maximum.`, {
          path: field.name,
        });
      }
      return value;
    }
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new KernelCommandError('validation_failed', `Field ${field.name} must be boolean.`, {
          path: field.name,
        });
      }
      return value;
    case 'date':
      if (typeof value !== 'string' || !isCanonicalUtcDate(value)) {
        throw new KernelCommandError(
          'validation_failed',
          `Field ${field.name} must be a canonical UTC date.`,
          { path: field.name }
        );
      }
      return value;
    case 'select': {
      const values = (field.options as { values: string[] }).values;
      if (typeof value !== 'string' || !values.includes(value)) {
        throw new KernelCommandError(
          'validation_failed',
          `Field ${field.name} must be an admitted select value.`,
          { path: field.name }
        );
      }
      return value;
    }
    case 'relation': {
      if (typeof value !== 'string') {
        throw new KernelCommandError(
          'validation_failed',
          `Field ${field.name} must be a record id.`,
          { path: field.name }
        );
      }
      if (pendingCreatedIds.has(value)) {
        throw new KernelCommandError(
          'validation_failed',
          'Batch relations cannot target records created in the same batch.'
        );
      }
      const targetId = (field.options as { collection: string }).collection;
      const target = schema.collections.find((collection) => collection.id === targetId);
      if (!target) {
        throw new KernelCommandError(
          'validation_failed',
          `Field ${field.name} has an unknown relation target.`
        );
      }
      const exists = appDb.sqlite
        .prepare(`SELECT 1 AS ok FROM ${quoteIdent(collectionTableName(target.id))} WHERE id = ?`)
        .get(value) as { ok: number } | undefined;
      if (!exists) {
        throw new KernelCommandError(
          'validation_failed',
          `Field ${field.name} references a missing record.`,
          { path: field.name }
        );
      }
      return value;
    }
    default:
      throw new KernelCommandError(
        'validation_failed',
        `Unsupported field type for ${field.name}.`
      );
  }
}

/**
 * Encodes one JSON field value as a SQLite bind parameter.
 *
 * @param type Field type.
 * @param value Canonical value.
 * @returns SQLite value.
 */
function encodeSqlValue(type: string, value: unknown): unknown {
  if (value === null) {
    return null;
  }
  if (type === 'bool') {
    return value === true ? 1 : 0;
  }
  return value;
}

/**
 * Decodes one SQLite value to the public JSON type.
 *
 * @param type Field type.
 * @param value SQLite value.
 * @returns JSON value.
 */
function decodeSqlValue(type: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (type === 'bool') {
    return Number(value) === 1;
  }
  return value;
}

/**
 * Projects one native row to the public record wire shape.
 *
 * @param collection Admitted collection.
 * @param schemaRevision Current schema revision.
 * @param row Native row.
 * @param fields Optional field allow-list.
 * @returns Public record.
 */
function projectRecord(
  collection: LightAppAdmittedCollection,
  schemaRevision: number,
  row: Record<string, unknown>,
  fields?: ReadonlySet<string>
): LightAppRecord {
  const data: Record<string, string | number | boolean | null> = {};
  for (const field of collection.fields) {
    if (fields && !fields.has(field.name)) {
      continue;
    }
    data[field.name] = decodeSqlValue(field.type, row[fieldColumnName(field.id)]) as
      | string
      | number
      | boolean
      | null;
  }
  return {
    id: String(row.id),
    collectionId: collection.id,
    collectionName: collection.name,
    revision: Number(row.revision),
    schemaRevision,
    created: String(row.created),
    updated: String(row.updated),
    data,
  };
}

/**
 * Reads and projects one record, or throws not_found.
 *
 * @param appDb Open app database.
 * @param collection Admitted collection.
 * @param schemaRevision Schema revision.
 * @param recordId Record id.
 * @param fields Optional field projection.
 * @returns Public record.
 */
function readProjectedRecord(
  appDb: AppDb,
  collection: LightAppAdmittedCollection,
  schemaRevision: number,
  recordId: string,
  fields?: string
): LightAppRecord {
  const row = readRecordRow(appDb, collection, recordId);
  return projectRecord(collection, schemaRevision, row, parseFields(collection, fields));
}

/**
 * Reads one native record row.
 *
 * @param appDb Open app database.
 * @param collection Admitted collection.
 * @param recordId Record id.
 * @returns Native row.
 */
function readRecordRow(
  appDb: AppDb,
  collection: LightAppAdmittedCollection,
  recordId: string
): Record<string, unknown> {
  const row = appDb.sqlite
    .prepare(`SELECT * FROM ${quoteIdent(collectionTableName(collection.id))} WHERE id = ?`)
    .get(recordId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new KernelCommandError('not_found', 'Record not found.');
  }
  return row;
}

/**
 * Replays the current record named by a receipt.
 *
 * @param appDb Open app database.
 * @param recordId Record id.
 * @returns Current record.
 */
function replayNamedRecord(appDb: AppDb, recordId: string): LightAppRecord {
  const schema = parseSchema(readMetadata(appDb));
  for (const collection of schema.collections) {
    const row = appDb.sqlite
      .prepare(`SELECT * FROM ${quoteIdent(collectionTableName(collection.id))} WHERE id = ?`)
      .get(recordId) as Record<string, unknown> | undefined;
    if (row) {
      return projectRecord(collection, schema.schemaRevision, row);
    }
  }
  throw new KernelCommandError('recovery_required', 'Named record authority is missing.');
}

/**
 * Parses batch virtual paths and bodies.
 *
 * @param schema Admitted schema.
 * @param body Batch body.
 * @returns Parsed entries.
 */
function parseBatchEntries(
  schema: LightAppAdmittedSchema,
  body: LightAppBatchRequest
): ParsedBatchEntry[] {
  return body.requests.map((entry): ParsedBatchEntry => {
    if (entry.method === 'POST') {
      const match = BATCH_POST.exec(entry.url);
      if (!match) {
        throw new KernelCommandError('validation_failed', 'Unsupported batch create URL.');
      }
      const parsedBody = entry.body as { data?: Record<string, unknown> };
      if (!parsedBody || typeof parsedBody !== 'object' || parsedBody.data === undefined) {
        throw new KernelCommandError('validation_failed', 'Batch create bodies require data.');
      }
      return {
        method: 'POST' as const,
        collection: resolveCollection(schema, decodeURIComponent(match[1]!)),
        data: parsedBody.data as Record<string, string | number | boolean | null>,
      };
    }
    const match = BATCH_PATCH.exec(entry.url);
    if (!match) {
      throw new KernelCommandError('validation_failed', 'Unsupported batch update URL.');
    }
    const parsedBody = entry.body as {
      expectedRecordRevision?: number;
      data?: Record<string, unknown>;
    };
    if (
      !parsedBody ||
      typeof parsedBody !== 'object' ||
      parsedBody.data === undefined ||
      parsedBody.expectedRecordRevision === undefined
    ) {
      throw new KernelCommandError(
        'validation_failed',
        'Batch update bodies require data and expectedRecordRevision.'
      );
    }
    return {
      method: 'PATCH' as const,
      collection: resolveCollection(schema, decodeURIComponent(match[1]!)),
      recordId: match[2]!,
      expectedRecordRevision: parsedBody.expectedRecordRevision,
      data: parsedBody.data as Record<string, string | number | boolean | null>,
    };
  });
}

/**
 * Projects app metadata as a get response.
 *
 * @param appDb Open app database.
 * @returns App projection.
 */
function projectApp(appDb: AppDb): GetLightAppResponse {
  const metadata = readMetadata(appDb);
  return {
    ...catalogItemFromMetadata(metadata),
    schema: parseSchema(metadata),
    capabilities: LIGHT_APP_CAPABILITIES_VIEW,
  };
}

/**
 * Reads app_metadata.
 *
 * @param appDb Open app database.
 * @returns Metadata row.
 */
function readMetadata(appDb: AppDb): AppMetadataRow {
  const row = appDb.sqlite
    .prepare(
      `SELECT
        app_id AS appId,
        workspace_id AS workspaceId,
        title,
        purpose,
        app_revision AS appRevision,
        schema_revision AS schemaRevision,
        schema_digest AS schemaDigest,
        schema_json AS schemaJson,
        lifecycle
       FROM app_metadata WHERE app_id = ?`
    )
    .get(appDb.appId) as AppMetadataRow | undefined;
  if (!row) {
    throw new KernelCommandError('unavailable', 'App authority is incomplete.');
  }
  return row;
}

/**
 * Parses the admitted schema document.
 *
 * @param metadata Metadata row.
 * @returns Admitted schema.
 */
function parseSchema(metadata: AppMetadataRow): LightAppAdmittedSchema {
  return LightAppAdmittedSchemaSchema.parse(JSON.parse(metadata.schemaJson));
}

/**
 * Requires the caller schema revision to match the live schema.
 *
 * @param metadata Metadata row.
 * @param schemaRevision Caller schema revision.
 * @returns Admitted schema.
 */
function requireCurrentSchema(
  metadata: AppMetadataRow,
  schemaRevision: number
): LightAppAdmittedSchema {
  if (metadata.schemaRevision !== schemaRevision) {
    throw new KernelCommandError('schema_stale', 'Schema revision is stale.');
  }
  return parseSchema(metadata);
}

/**
 * Rejects writes against a retired app.
 *
 * @param metadata Metadata row.
 */
function assertWritable(metadata: AppMetadataRow): void {
  if (metadata.lifecycle !== 'active') {
    throw new KernelCommandError('unsupported_operation', 'Retired apps reject writes.');
  }
}

/**
 * Resolves a collection selector.
 *
 * @param schema Admitted schema.
 * @param selector Name or id.
 * @returns Admitted collection.
 */
function resolveCollection(
  schema: LightAppAdmittedSchema,
  selector: string
): LightAppAdmittedCollection {
  const collection = schema.collections.find(
    (candidate) => candidate.id === selector || candidate.name === selector
  );
  if (!collection) {
    throw new KernelCommandError('not_found', 'Collection not found.');
  }
  return collection;
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
    if (parts.length > 3) {
      throw new KernelCommandError('validation_failed', 'Sort accepts at most three fields.');
    }
    for (const part of parts) {
      const descending = part.startsWith('-');
      const ascending = part.startsWith('+');
      const name = descending || ascending ? part.slice(1) : part;
      const column = columnFor(collection, name);
      clauses.push(`${column.sql} ${descending ? 'DESC' : 'ASC'}`);
    }
  }
  clauses.push('id ASC');
  return clauses.join(', ');
}

/**
 * Resolves a filter or sort operand to SQL.
 *
 * @param collection Admitted collection.
 * @param operand Field or metadata name.
 * @returns SQL column and type.
 */
function columnFor(
  collection: LightAppAdmittedCollection,
  operand: string
): { sql: string; type: string } {
  if (
    operand === 'id' ||
    operand === 'created' ||
    operand === 'updated' ||
    operand === 'revision'
  ) {
    return { sql: quoteIdent(operand), type: operand === 'revision' ? 'number' : 'text' };
  }
  const field = collection.fields.find((candidate) => candidate.name === operand);
  if (!field) {
    throw new KernelCommandError('validation_failed', `Unknown field: ${operand}.`);
  }
  return { sql: quoteIdent(fieldColumnName(field.id)), type: field.type };
}

/**
 * Parses a fields projection.
 *
 * @param collection Admitted collection.
 * @param fields Comma-separated names.
 * @returns Allow-list, or undefined for all fields.
 */
function parseFields(
  collection: LightAppAdmittedCollection,
  fields: string | undefined
): ReadonlySet<string> | undefined {
  if (!fields || fields.trim() === '') {
    return undefined;
  }
  const names = fields
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const known = new Set(collection.fields.map((field) => field.name));
  for (const name of names) {
    if (!known.has(name)) {
      throw new KernelCommandError('validation_failed', `Unknown field: ${name}.`);
    }
  }
  return new Set(names);
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
    perPage > 100
  ) {
    throw new KernelCommandError(
      'validation_failed',
      'Page and perPage must be positive integers.'
    );
  }
  if ((page - 1) * perPage > 10_000) {
    throw new KernelCommandError('limit_exceeded', 'List offset exceeds 10,000.', {
      limit: 'offset',
      maximum: 10_000,
    });
  }
}

/**
 * Enforces the per-app record ceiling before inserts.
 *
 * @param appDb Open app database.
 * @param schema Admitted schema.
 * @param additional Rows about to be inserted.
 */
function assertRecordCeiling(
  appDb: AppDb,
  schema: LightAppAdmittedSchema,
  additional: number
): void {
  let total = 0;
  for (const collection of schema.collections) {
    const row = appDb.sqlite
      .prepare(`SELECT COUNT(*) AS total FROM ${quoteIdent(collectionTableName(collection.id))}`)
      .get() as { total: number };
    total += row.total;
  }
  if (total + additional > RECORD_LIMIT) {
    throw new KernelCommandError('limit_exceeded', 'App record limit exceeded.', {
      limit: 'records',
      maximum: RECORD_LIMIT,
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
    .sort((left, right) => left.appId.localeCompare(right.appId));
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
      appDb.sqlite.close();
    }
  } catch {
    return {
      appId,
      title: 'Unavailable app',
      purpose: '',
      appRevision: 1,
      schemaRevision: 1,
      schemaDigest: EMPTY_DIGEST,
      lifecycle: 'unavailable',
    };
  }
}

/**
 * Builds a catalog item from metadata.
 *
 * @param metadata Metadata row.
 * @returns Catalog item.
 */
function catalogItemFromMetadata(metadata: AppMetadataRow): LightAppCatalogItem {
  return {
    appId: metadata.appId,
    title: metadata.title,
    purpose: metadata.purpose,
    appRevision: metadata.appRevision,
    schemaRevision: metadata.schemaRevision,
    schemaDigest: metadata.schemaDigest,
    lifecycle: metadata.lifecycle,
  };
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

/**
 * Writes one immutable definition file and returns its digest.
 *
 * @param appRoot App directory.
 * @param schemaJson Canonical schema JSON.
 * @returns sha256 digest.
 */
function persistDefinition(appRoot: string, schemaJson: string): string {
  const digest = `sha256:${createHash('sha256').update(schemaJson).digest('hex')}`;
  const path = join(appRoot, 'definitions', `${digest.slice('sha256:'.length)}.json`);
  if (!existsSync(path)) {
    writeDurableFile(path, schemaJson);
  }
  return digest;
}

/**
 * Records one Kernel mutation audit event in the app database.
 *
 * @param appDb Open app database.
 * @param context Command context.
 * @param action Audit action.
 * @param resource Resource reference.
 * @param resourceRevision Resource revision.
 */
function recordKernelAudit(
  appDb: AppDb,
  context: KernelCommandContext,
  action: string,
  resource: string,
  resourceRevision: number
): void {
  recordAppAuditEvent({
    sqlite: appDb.sqlite,
    workspaceId: appDb.workspaceId,
    actor: context.actor,
    requestId: context.requestId,
    category: 'system',
    action,
    resource,
    resourceRevision,
    outcome: 'succeeded',
    summary: action,
  });
}

/**
 * Maps SQLite failures onto Kernel error codes.
 *
 * @param error Caught error.
 * @returns Mapped error.
 */
function mapSqliteError(error: unknown): unknown {
  if (error instanceof KernelCommandError) {
    return error;
  }
  if (isSqliteBusy(error)) {
    return new KernelCommandError('unavailable', 'App database is busy.');
  }
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code: string }).code)
      : '';
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return new KernelCommandError('conflict', 'Record uniqueness conflict.');
  }
  if (code.startsWith('SQLITE_CONSTRAINT')) {
    return new KernelCommandError('validation_failed', 'Record failed a native constraint.');
  }
  return error;
}

/**
 * Extracts a non-secret actor id for receipt scope.
 *
 * @param actor Actor.
 * @returns Actor id.
 */
function actorScopeId(actor: ActorRef): string {
  return actor.id;
}

/**
 * Narrows unknown command input to an object.
 *
 * @param value Input value.
 * @returns Object, or empty object.
 */
function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
