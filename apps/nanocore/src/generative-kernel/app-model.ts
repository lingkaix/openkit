import {
  type CreateLightAppResponse,
  LIGHT_APP_CAPABILITIES,
  type LightAppAdmittedCollection,
  type LightAppAdmittedSchema,
  LightAppAdmittedSchemaSchema,
  type LightAppBatchRequest,
  type LightAppBatchResponse,
  LightAppDefinitionSourceSchema,
  type LightAppRecord,
} from '@openkit/app-api-schemas';
import type { AppDb } from '../storage/app-db.js';
import { isSqliteBusy } from '../storage/app-db.js';
import { KernelCommandError } from './errors.js';
import { collectionTableName, fieldColumnName, quoteIdent } from './native.js';
import { allocateRecordId } from './uuid.js';

const MUTATION_REQUEST_BYTE_LIMIT = LIGHT_APP_CAPABILITIES.maxMutationRequestBytes;
const READ_RESPONSE_BYTE_LIMIT = LIGHT_APP_CAPABILITIES.maxReadResponseBytes;
const BATCH_POST = /^\/api\/collections\/([^/]+)\/records$/;
const BATCH_PATCH = /^\/api\/collections\/([^/]+)\/records\/([^/]+)$/;

/**
 * Refuses oversized logical mutation input before any Kernel effect.
 *
 * @param input Complete admitted operation input, including its resource and request identity.
 */
export function assertKernelMutationRequestSize(input: unknown): void {
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MUTATION_REQUEST_BYTE_LIMIT)
    throw new KernelCommandError('limit_exceeded', 'Mutation request exceeds 1 MiB.', {
      limit: 'mutationRequestBytes',
      maximum: MUTATION_REQUEST_BYTE_LIMIT,
    });
}

/**
 * Checks the complete projection without truncation; mutation callers use it before commit.
 *
 * @param response Complete Kernel projection or expanded meaning response.
 * @returns The unchanged bounded response.
 */
export function boundedKernelResponse<T>(response: T): T {
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > READ_RESPONSE_BYTE_LIMIT)
    throw new KernelCommandError('limit_exceeded', 'Read response exceeds 2 MiB.', {
      limit: 'readResponseBytes',
      maximum: READ_RESPONSE_BYTE_LIMIT,
    });
  return response;
}

/** Current admitted app metadata stored with Kernel data. */
export type AppMetadataRow = {
  appId: string;
  workspaceId: string;
  title: string;
  purpose: string;
  appRevision: number;
  schemaRevision: number;
  schemaDigest: string;
  schemaJson: string;
  lifecycle: 'active' | 'retired';
  kernelFormatVersion: number;
  definitionSourceJson: string | null;
};

export type ParsedBatchEntry =
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

/** Projects a restored migration base without admitting old-format data operations. */
export function projectRestoredApp(appDb: AppDb): CreateLightAppResponse {
  const hasMarker = (
    appDb.sqlite.pragma('table_info(app_metadata)') as Array<{ name: string }>
  ).some((column) => column.name === 'kernel_format_version');
  if (hasMarker) return projectApp(appDb);
  const row = appDb.sqlite
    .prepare(
      'SELECT title, purpose, app_revision AS appRevision, schema_revision AS schemaRevision, schema_digest AS schemaDigest FROM app_metadata WHERE app_id = ?'
    )
    .get(appDb.appId) as {
    title: string;
    purpose: string;
    appRevision: number;
    schemaRevision: number;
    schemaDigest: string;
  };
  return {
    appId: appDb.appId,
    ...row,
    lifecycle: 'unavailable',
    kernelFormatVersion: 1,
    definitionVersion: row.schemaDigest,
    definitionSource: null,
    schema: null,
    capabilities: LIGHT_APP_CAPABILITIES,
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
export function replayBatch(
  appDb: AppDb,
  context: { readonly requestId: string },
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
 * Decodes one SQLite value to the public JSON type.
 *
 * @param type Field type.
 * @param value SQLite value.
 * @returns JSON value.
 */
export function decodeSqlValue(type: string, value: unknown): unknown {
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
export function projectRecord(
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
export function readProjectedRecord(
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
export function readRecordRow(
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
export function replayNamedRecord(appDb: AppDb, recordId: string): LightAppRecord {
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
export function parseBatchEntries(
  schema: LightAppAdmittedSchema,
  body: LightAppBatchRequest
): ParsedBatchEntry[] {
  return body.requests.map((entry): ParsedBatchEntry => {
    if (entry.method === 'POST') {
      const match = BATCH_POST.exec(entry.url);
      if (!match) {
        throw new KernelCommandError('validation_failed', 'Unsupported batch create URL.', {
          path: 'requests',
        });
      }
      const parsedBody = entry.body as { data?: Record<string, unknown> };
      if (!parsedBody || typeof parsedBody !== 'object' || parsedBody.data === undefined) {
        throw new KernelCommandError('validation_failed', 'Batch create bodies require data.', {
          path: 'requests',
        });
      }
      return {
        method: 'POST' as const,
        collection: resolveCollection(schema, decodeURIComponent(match[1]!)),
        data: parsedBody.data as Record<string, string | number | boolean | null>,
      };
    }
    const match = BATCH_PATCH.exec(entry.url);
    if (!match) {
      throw new KernelCommandError('validation_failed', 'Unsupported batch update URL.', {
        path: 'requests',
      });
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
        'Batch update bodies require data and expectedRecordRevision.',
        { path: 'requests' }
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
export function projectApp(appDb: AppDb): CreateLightAppResponse {
  const metadata = readMetadata(appDb);
  return {
    ...catalogItemFromMetadata(metadata),
    schema: parseSchema(metadata),
    capabilities: LIGHT_APP_CAPABILITIES,
  };
}

/**
 * Reads app_metadata.
 *
 * @param appDb Open app database.
 * @returns Metadata row.
 */
export function readMetadata(appDb: AppDb): AppMetadataRow {
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
        kernel_format_version AS kernelFormatVersion,
        definition_source_json AS definitionSourceJson,
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
export function parseSchema(metadata: AppMetadataRow): LightAppAdmittedSchema {
  return LightAppAdmittedSchemaSchema.parse(JSON.parse(metadata.schemaJson));
}

/**
 * Requires the caller schema revision to match the live schema.
 *
 * @param metadata Metadata row.
 * @param schemaRevision Caller schema revision.
 * @returns Admitted schema.
 */
export function requireCurrentSchema(
  metadata: AppMetadataRow,
  schemaRevision: number
): LightAppAdmittedSchema {
  if (metadata.schemaRevision !== schemaRevision) {
    throw new KernelCommandError('schema_stale', 'Schema revision is stale.', {
      path: 'schemaRevision',
      expectedRevision: schemaRevision,
      currentRevision: metadata.schemaRevision,
    });
  }
  return parseSchema(metadata);
}

/**
 * Rejects writes against a retired app.
 *
 * @param metadata Metadata row.
 */
export function assertWritable(metadata: Pick<AppMetadataRow, 'lifecycle'>): void {
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
export function resolveCollection(
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
 * Resolves a filter or sort operand to SQL.
 *
 * @param collection Admitted collection.
 * @param operand Field or metadata name.
 * @returns SQL column and type.
 */
export function columnFor(
  collection: LightAppAdmittedCollection,
  operand: string,
  path: 'filter' | 'sort' = 'filter'
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
    throw new KernelCommandError('validation_failed', `Unknown field: ${operand}.`, { path });
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
export function parseFields(
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
      throw new KernelCommandError('validation_failed', `Unknown field: ${name}.`, {
        path: 'fields',
      });
    }
  }
  return new Set(names);
}

/**
 * Builds a catalog item from metadata.
 *
 * @param metadata Metadata row.
 * @returns Catalog item.
 */
export function catalogItemFromMetadata(metadata: AppMetadataRow) {
  return {
    appId: metadata.appId,
    title: metadata.title,
    purpose: metadata.purpose,
    appRevision: metadata.appRevision,
    schemaRevision: metadata.schemaRevision,
    schemaDigest: metadata.schemaDigest,
    kernelFormatVersion: metadata.kernelFormatVersion,
    definitionVersion: metadata.schemaDigest,
    definitionSource: metadata.definitionSourceJson
      ? LightAppDefinitionSourceSchema.parse(JSON.parse(metadata.definitionSourceJson))
      : null,
    lifecycle: metadata.lifecycle,
  };
}

/**
 * Narrows unknown command input to an object.
 *
 * @param value Input value.
 * @returns Object, or empty object.
 */
export function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
} /**
 * Maps SQLite failures onto Kernel error codes.
 *
 * @param error Caught error.
 * @returns Mapped error.
 */
export function mapAppSqliteError(error: unknown): unknown {
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
    return new KernelCommandError('validation_failed', 'Record failed a native constraint.', {
      path: 'data',
    });
  }
  return error;
}
