import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CreateLightAppResponse,
  LIGHT_APP_CAPABILITIES,
  LIGHT_APP_KERNEL_FORMAT_VERSION,
  type LightAppAdmittedCollection,
  type LightAppAdmittedSchema,
  LightAppAdmittedSchemaSchema,
  type LightAppBatchRequest,
  type LightAppBatchResponse,
  type LightAppDefinitionSource,
  type LightAppRecord,
  type UpdateLightAppRecordRequest,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import { ensureCanonicalDirectoryAsync, publishDurableFile } from '@openkit/storage';
import { recordAppAuditEvent } from '../audit-events.js';
import { type AppDb, assertAppAuthority, lightAppRoot } from '../storage/app-db.js';

import {
  commandRequestKey,
  getCommandRequestRecordFromDb,
  recordCommandRequestRecordInDb,
} from '../storage/command-request-records.js';
import { commandInputHash } from '../storage/control-store-input.js';
import type { ControlPhysicalForecastFiles } from '../storage/control-store-worker-protocol.js';
import { applyAppMigrations, hasPendingAppMigrations } from '../storage/migrate.js';
import {
  assertWritable,
  boundedKernelResponse,
  catalogItemFromMetadata,
  columnFor,
  decodeSqlValue,
  parseBatchEntries,
  parseSchema,
  projectApp,
  projectRestoredApp,
  readMetadata,
  readProjectedRecord,
  readRecordRow,
  replayBatch,
  replayNamedRecord,
  requireCurrentSchema,
  resolveCollection,
} from './app-model.js';
import { KernelCommandError } from './errors.js';
import { compileRecordFilter } from './filter.js';
import {
  additiveSchemaDdl,
  collectionTableName,
  createSchemaDdl,
  fieldColumnName,
  quoteIdent,
} from './native.js';
import {
  type ControlAppInput,
  type ControlAppResult,
  ControlAppResultSchema,
} from './native-command-codecs.js';
import { admitLightAppSchema, assertSafeSchemaEvolution } from './schema.js';
import {
  assertSnapshotIntegrity,
  planLightAppSnapshot,
  prepareLightAppSnapshot,
} from './snapshots.js';
import { allocateRecordId } from './uuid.js';
import { encodeSqlValue, normalizeLightAppFieldValue } from './values.js';

const RECORD_LIMIT = LIGHT_APP_CAPABILITIES.maxRecords;
const DATA_OBJECT_BYTE_LIMIT = LIGHT_APP_CAPABILITIES.maxDataObjectBytes;
type KernelCommandContext = Pick<ControlAppInput, 'actor' | 'requestId' | 'execution'>;
/** Immutable preparation selected only after this App's admitted predecessor has committed. */
export interface PreparedControlApp {
  readonly admitted?: LightAppAdmittedSchema;
  readonly schemaJson?: string;
  readonly schemaDigest?: string;
}

/** Prepares immutable definitions and a committed recovery copy outside the SQL body. */
export async function prepareControlApp(
  appDb: AppDb,
  input: ControlAppInput,
  admitPhysical: (files: ControlPhysicalForecastFiles) => Promise<void>
): Promise<PreparedControlApp> {
  assertControlAppReceipt(appDb, input);
  const change = input.change;
  if (change.kind !== 'create')
    assertAppAuthority(
      appDb,
      change.kind === 'format-complete' ||
        change.kind === 'format-journal' ||
        change.kind === 'rollback'
    );
  if (getCommandRequestRecordFromDb(appDb, input.receipt.key, input.receipt.createdAt)) return {};
  if (change.kind === 'format-journal') {
    const current = readMetadata(appDb);
    assertWritable(current);
    if (current.appRevision !== change.expectedAppRevision)
      throw new KernelCommandError('conflict', 'App revision is stale.', {
        path: 'expectedAppRevision',
        expectedRevision: change.expectedAppRevision,
        currentRevision: current.appRevision,
      });
    if (hasPendingAppMigrations(appDb.sqlite)) {
      const snapshot = planLightAppSnapshot(appDb, 'kernel-format-migration');
      await admitPhysical([
        { path: snapshot.path, publicationBytes: snapshot.copyBytes },
        { path: snapshot.metadataPath, publicationBytes: snapshot.metadataBytes },
      ]);
      await prepareLightAppSnapshot(appDb, snapshot);
    }
    applyAppMigrations(appDb.sqlite);
    return {};
  }
  if (change.kind !== 'create' && change.kind !== 'schema') return {};
  const current = change.kind === 'schema' ? readMetadata(appDb) : undefined;
  if (current && change.kind === 'schema') {
    assertWritable(current);
    if (current.appRevision !== change.expectedAppRevision)
      throw new KernelCommandError('conflict', 'App revision is stale.', {
        path: 'expectedAppRevision',
        expectedRevision: change.expectedAppRevision,
        currentRevision: current.appRevision,
      });
    if (current.schemaRevision !== change.expectedSchemaRevision)
      throw new KernelCommandError('conflict', 'Schema revision is stale.', {
        path: 'expectedSchemaRevision',
        expectedRevision: change.expectedSchemaRevision,
        currentRevision: current.schemaRevision,
      });
  }
  const schemaRevision = current ? nextSchemaRevision(appDb, current.schemaRevision) : 1;
  const admitted = change.sourceSelection
    ? LightAppAdmittedSchemaSchema.parse({ ...change.schema, appId: appDb.appId, schemaRevision })
    : admitLightAppSchema(
        change.schema,
        appDb.appId,
        schemaRevision,
        current ? parseSchema(current) : undefined
      );
  if (current && change.sourceSelection) assertSafeSchemaEvolution(admitted, parseSchema(current));
  const schemaJson = `${JSON.stringify(admitted)}\n`;
  const schemaDigest = `sha256:${createHash('sha256').update(schemaJson).digest('hex')}`;
  const root = lightAppRoot(appDb.dataRoot, appDb.workspaceId, appDb.appId);
  const definitionPath = join(root, 'definitions', `${schemaDigest.slice('sha256:'.length)}.json`);
  const snapshot = current ? planLightAppSnapshot(appDb, 'definition-migration') : undefined;
  const files = [
    ...(!existsSync(definitionPath)
      ? [{ path: definitionPath, publicationBytes: Buffer.byteLength(schemaJson) }]
      : []),
    ...(snapshot
      ? [
          { path: snapshot.path, publicationBytes: snapshot.copyBytes },
          { path: snapshot.metadataPath, publicationBytes: snapshot.metadataBytes },
        ]
      : []),
  ];
  if (files.length) await admitPhysical(files);
  await persistDefinition(root, schemaJson);
  if (snapshot) await prepareLightAppSnapshot(appDb, snapshot);
  return { admitted, schemaJson, schemaDigest };
}
/** Applies the exact business/Audit/original-receipt tuple in its caller's native savepoint. */
export function applyControlApp(
  appDb: AppDb,
  input: ControlAppInput,
  prepared: PreparedControlApp
): ControlAppResult {
  const context = input;
  const appId = appDb.appId;
  const change = input.change;
  if (
    input.workspaceId !== appDb.workspaceId ||
    input.appId !== appId ||
    input.requestId !== input.receipt.requestId ||
    input.receipt.scope.workspaceId !== appDb.workspaceId ||
    input.receipt.scope.appId !== appId
  )
    throw new KernelCommandError('unavailable', 'App command ownership does not match.');
  assertControlAppReceipt(appDb, input);
  const old = getCommandRequestRecordFromDb(appDb, input.receipt.key, input.receipt.createdAt);
  if (old) {
    if (old.inputHash !== input.receipt.inputHash)
      throw new KernelCommandError('idempotency_key_conflict', 'Idempotency key conflict.');
    return change.kind === 'record-create' || change.kind === 'record-update'
      ? replayNamedRecord(appDb, old.response.id)
      : change.kind === 'record-batch'
        ? replayBatch(appDb, input, change.body)
        : change.kind === 'rollback'
          ? projectRestoredApp(appDb)
          : projectApp(appDb);
  }
  const result = applyChange();
  const response = boundedKernelResponse(ControlAppResultSchema.parse(result));
  if (!response) throw new KernelCommandError('unavailable', 'App result is absent.');
  const id = 'id' in response ? response.id : appId;
  recordCommandRequestRecordInDb(appDb, {
    ...input.receipt,
    response: { kind: input.receipt.responseKind, id },
  });
  return response;
  function applyChange(): ControlAppResult {
    switch (change.kind) {
      case 'create': {
        if (!prepared.admitted || !prepared.schemaJson || !prepared.schemaDigest)
          throw new KernelCommandError('unavailable', 'App preparation is absent.');
        if (appDb.sqlite.prepare('SELECT 1 FROM app_metadata LIMIT 1').get())
          throw new KernelCommandError(
            'recovery_required',
            'Interrupted app creation cannot be replayed.'
          );
        return commitNewApp(appDb, context, {
          admitted: prepared.admitted,
          schemaJson: prepared.schemaJson,
          schemaDigest: prepared.schemaDigest,
          ...(change.sourceSelection ? { sourceSelection: change.sourceSelection } : {}),
        });
      }
      case 'schema': {
        const { expectedAppRevision, expectedSchemaRevision, sourceSelection } = change;
        const current = readMetadata(appDb);
        assertWritable(current);
        if (current.appRevision !== expectedAppRevision) {
          throw new KernelCommandError('conflict', 'App revision is stale.', {
            path: 'expectedAppRevision',
            expectedRevision: expectedAppRevision,
            currentRevision: current.appRevision,
          });
        }
        if (current.schemaRevision !== expectedSchemaRevision) {
          throw new KernelCommandError('conflict', 'Schema revision is stale.', {
            path: 'expectedSchemaRevision',
            expectedRevision: expectedSchemaRevision,
            currentRevision: current.schemaRevision,
          });
        }
        const { admitted, schemaJson, schemaDigest } = prepared;
        if (!admitted || !schemaJson || !schemaDigest)
          throw new KernelCommandError('unavailable', 'App preparation is absent.');
        for (const statement of additiveSchemaDdl(parseSchema(current), admitted)) {
          appDb.sqlite.exec(statement);
        }
        // SQLite retains deferred counters for the dropped table even after its valid replacement exists.
        // Check actual foreign keys before clearing those counters; later writes change only app metadata, audit and receipts.
        assertSnapshotIntegrity(appDb.sqlite);
        appDb.sqlite.pragma('defer_foreign_keys = OFF');
        const now = new Date().toISOString();
        appDb.sqlite
          .prepare(
            `UPDATE app_metadata SET
              title = ?, purpose = ?, app_revision = ?, schema_revision = ?,
              schema_digest = ?, schema_json = ?, definition_source_json = ?, updated_at = ?, last_mutator_json = ?, last_request_id = ?
             WHERE app_id = ?`
          )
          .run(
            admitted.title,
            admitted.purpose,
            current.appRevision + 1,
            admitted.schemaRevision,
            schemaDigest,
            schemaJson,
            sourceSelection ? JSON.stringify(sourceSelection) : null,
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
          admitted.schemaRevision,
          {
            schemaRevision: admitted.schemaRevision,
            collectionIds: admitted.collections.map((collection) => collection.id),
          }
        );
        return projectApp(appDb);
      }
      case 'retire': {
        const { expectedAppRevision } = change;
        const metadata = readMetadata(appDb);
        assertWritable(metadata);
        if (metadata.appRevision !== expectedAppRevision) {
          throw new KernelCommandError('conflict', 'App revision is stale.', {
            path: 'expectedAppRevision',
            expectedRevision: expectedAppRevision,
            currentRevision: metadata.appRevision,
          });
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
          metadata.appRevision + 1,
          { schemaRevision: metadata.schemaRevision }
        );
        return projectApp(appDb);
      }
      case 'record-create': {
        const { collectionSelector, schemaRevision, data } = change;
        const recordId = allocateRecordId(appId, input.requestId, 0, 'create');
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
        const record = readProjectedRecord(appDb, collection, schema.schemaRevision, recordId);
        recordKernelAudit(
          appDb,
          context,
          'kernel.records.create',
          `light-app:${appId}:record:${recordId}`,
          1,
          { schemaRevision: schema.schemaRevision, records: [record] }
        );
        return record;
      }
      case 'record-update': {
        const { collectionSelector, recordId, body, lineage } = change;
        applyRecordUpdate(appDb, context, collectionSelector, recordId, body, true, lineage);
        return readProjectedRecord(
          appDb,
          resolveCollection(parseSchema(readMetadata(appDb)), collectionSelector),
          body.schemaRevision,
          recordId
        );
      }
      case 'record-batch':
        return executeBatch(appDb, context, change.body);
      case 'format-complete': {
        const { expectedAppRevision } = change;
        const metadata = readMetadata(appDb);
        assertWritable(metadata);
        if (metadata.appRevision !== expectedAppRevision)
          throw new KernelCommandError('conflict', 'App revision is stale.', {
            path: 'expectedAppRevision',
            expectedRevision: expectedAppRevision,
            currentRevision: metadata.appRevision,
          });
        if (metadata.kernelFormatVersion !== LIGHT_APP_KERNEL_FORMAT_VERSION)
          throw new KernelCommandError('unavailable', 'App kernel format is unsupported.');
        const changed = appDb.sqlite
          .prepare(
            "UPDATE app_metadata SET app_revision = ?, updated_at = ?, last_mutator_json = ?, last_request_id = ? WHERE app_id = ? AND app_revision = ? AND lifecycle = 'active'"
          )
          .run(
            expectedAppRevision + 1,
            new Date().toISOString(),
            JSON.stringify(context.actor),
            context.requestId,
            appId,
            expectedAppRevision
          ).changes;
        if (changed !== 1) throw new KernelCommandError('conflict', 'App revision is stale.');
        recordKernelAudit(
          appDb,
          context,
          'kernel.format.upgrade',
          `light-app:${appId}`,
          expectedAppRevision + 1,
          { schemaRevision: metadata.schemaRevision }
        );
        return projectApp(appDb);
      }
      case 'rollback': {
        const { expectedAppRevision } = change;
        const selected = { metadata: { schemaRevision: change.schemaRevision } };
        const candidateDb = appDb;
        const sqlite = appDb.sqlite;
        sqlite
          .prepare(
            'UPDATE app_metadata SET app_revision = ?, updated_at = ?, last_mutator_json = ?, last_request_id = ? WHERE app_id = ?'
          )
          .run(
            expectedAppRevision + 1,
            new Date().toISOString(),
            JSON.stringify(context.actor),
            context.requestId,
            appId
          );
        recordKernelAudit(
          candidateDb,
          context,
          'kernel.snapshots.rollback',
          `light-app:${appId}`,
          expectedAppRevision + 1,
          { schemaRevision: selected.metadata.schemaRevision }
        );
        return projectRestoredApp(candidateDb);
      }
      case 'format-journal':
        throw new KernelCommandError(
          'unavailable',
          'Format journal requires its separate native maintenance stage.'
        );
    }
  }
}

/**
 * Commits the first app metadata, DDL, and audit event.
 *
 * @param appDb Open app database.
 * @param context Trusted command execution context.
 * @param input Admitted schema and source selection.
 * @returns Created app projection.
 */
function commitNewApp(
  appDb: AppDb,
  context: KernelCommandContext,
  input: {
    admitted: LightAppAdmittedSchema;
    schemaDigest: string;
    schemaJson: string;
    sourceSelection?: LightAppDefinitionSource;
  }
): CreateLightAppResponse {
  const now = new Date().toISOString();
  for (const statement of createSchemaDdl(input.admitted)) {
    appDb.sqlite.exec(statement);
  }
  appDb.sqlite
    .prepare(
      `INSERT INTO app_metadata (
        app_id, workspace_id, title, purpose, app_revision, schema_revision,
        schema_digest, schema_json, definition_source_json, lifecycle, created_at, updated_at,
        creator_json, last_mutator_json, create_request_id, last_request_id
      ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.admitted.appId,
      appDb.workspaceId,
      input.admitted.title,
      input.admitted.purpose,
      input.schemaDigest,
      input.schemaJson,
      input.sourceSelection ? JSON.stringify(input.sourceSelection) : null,
      now,
      now,
      JSON.stringify(context.actor),
      JSON.stringify(context.actor),
      context.requestId,
      context.requestId
    );
  recordKernelAudit(appDb, context, 'kernel.apps.create', `light-app:${input.admitted.appId}`, 1, {
    schemaRevision: input.admitted.schemaRevision,
    collectionIds: input.admitted.collections.map((collection) => collection.id),
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
        'Batch update targets must be unique existing records.',
        { path: 'requests' }
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
  const items = resultIds.map((recordId) => replayNamedRecord(appDb, recordId));
  recordKernelAudit(
    appDb,
    context,
    'kernel.records.batch',
    `light-app:${appDb.appId}`,
    schema.schemaRevision,
    { schemaRevision: schema.schemaRevision, records: items }
  );
  return { app: catalogItemFromMetadata(readMetadata(appDb)), items };
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
 * @param lineage Optional presentation binding used to re-check source membership.
 */
function applyRecordUpdate(
  appDb: AppDb,
  context: KernelCommandContext,
  collectionSelector: string,
  recordId: string,
  body: UpdateLightAppRecordRequest,
  audit = true,
  lineage?: {
    presentationId: string;
    actionName: string;
    itemId: string;
    sourceFilter?: string | undefined;
  }
): void {
  const metadata = readMetadata(appDb);
  assertWritable(metadata);
  const schema = requireCurrentSchema(metadata, body.schemaRevision);
  const collection = resolveCollection(schema, collectionSelector);
  const current = readRecordRow(appDb, collection, recordId);
  if (Number(current.revision) !== body.expectedRecordRevision) {
    throw new KernelCommandError('conflict', 'Record revision is stale.', {
      path: 'expectedRecordRevision',
      expectedRevision: body.expectedRecordRevision,
      currentRevision: Number(current.revision),
    });
  }
  if (lineage?.sourceFilter) {
    const compiled = compileRecordFilter(lineage.sourceFilter, (operand) =>
      columnFor(collection, operand)
    );
    if (compiled) {
      const match = appDb.sqlite
        .prepare(
          `SELECT 1 AS ok FROM ${quoteIdent(collectionTableName(collection.id))} WHERE id = ? AND (${compiled.sql})`
        )
        .get(recordId, ...compiled.params) as { ok: number } | undefined;
      if (!match) {
        throw new KernelCommandError(
          'validation_failed',
          'Record is no longer a member of the bound source query.',
          { path: 'filter' }
        );
      }
    }
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
      Number(current.revision) + 1,
      {
        schemaRevision: schema.schemaRevision,
        records: [
          { id: recordId, collectionId: collection.id, revision: Number(current.revision) + 1 },
        ],
      },
      lineage?.itemId
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
  const canonical = normalizeLightAppFieldValue(field, value);
  if (field.type !== 'relation') {
    return canonical;
  }
  const recordId = String(canonical);
  if (pendingCreatedIds.has(recordId)) {
    throw new KernelCommandError(
      'validation_failed',
      'Batch relations cannot target records created in the same batch.',
      { path: 'requests' }
    );
  }
  const targetId = (field.options as { collection: string }).collection;
  const target = schema.collections.find((collection) => collection.id === targetId);
  if (!target) {
    throw new KernelCommandError(
      'validation_failed',
      `Field ${field.name} has an unknown relation target.`,
      { path: 'data' }
    );
  }
  const exists = appDb.sqlite
    .prepare(`SELECT 1 AS ok FROM ${quoteIdent(collectionTableName(target.id))} WHERE id = ?`)
    .get(recordId) as { ok: number } | undefined;
  if (!exists) {
    throw new KernelCommandError(
      'validation_failed',
      `Field ${field.name} references a missing record.`,
      { path: field.name }
    );
  }
  return recordId;
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

/** Allocates beyond retained definition history, which survives app snapshot replacement. */
function nextSchemaRevision(appDb: AppDb, currentRevision: number): number {
  const root = join(lightAppRoot(appDb.dataRoot, appDb.workspaceId, appDb.appId), 'definitions');
  let highest = currentRevision;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      if (!entry.isFile()) throw new Error('Definition history must contain regular files.');
      const descriptor = openSync(
        join(root, entry.name),
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      let bytes: Buffer;
      try {
        bytes = readFileSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      const retained = LightAppAdmittedSchemaSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (`${digest}.json` !== entry.name || retained.appId !== appDb.appId) {
        throw new Error('Definition history identity does not match.');
      }
      highest = Math.max(highest, retained.schemaRevision);
    }
  } catch {
    throw new KernelCommandError('unavailable', 'App definition history is unavailable.');
  }
  return highest + 1;
}

/**
 * Writes one immutable definition file and returns its digest.
 *
 * @param appRoot App directory.
 * @param schemaJson Canonical schema JSON.
 * @returns sha256 digest.
 */
async function persistDefinition(appRoot: string, schemaJson: string): Promise<string> {
  const digest = `sha256:${createHash('sha256').update(schemaJson).digest('hex')}`;
  const path = join(appRoot, 'definitions', `${digest.slice('sha256:'.length)}.json`);
  if (!existsSync(path)) {
    await ensureCanonicalDirectoryAsync(join(appRoot, 'definitions'));
    await publishDurableFile({ destinationPath: path, bytes: schemaJson });
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
 * @param evidence Admitted identities and revisions, without business values.
 * @param itemId Optional presentation Item, separate from the executing Turn.
 */
function recordKernelAudit(
  appDb: AppDb,
  context: KernelCommandContext,
  action: string,
  resource: string,
  resourceRevision: number,
  evidence: {
    schemaRevision: number;
    collectionIds?: readonly string[];
    records?: readonly Pick<LightAppRecord, 'id' | 'collectionId' | 'revision'>[];
  },
  itemId?: string
): void {
  // Human evidence uses the existing summary, not a new retained payload format.
  // Existing admission bounds collections to 16 and affected batch records to 50.
  const facts = [`Schema revision ${evidence.schemaRevision}`];
  if (evidence.collectionIds?.length)
    facts.push(`collections ${evidence.collectionIds.join(', ')}`);
  for (const record of evidence.records ?? []) {
    facts.push(
      `collection ${record.collectionId}, record ${record.id}, record revision ${record.revision}`
    );
  }
  recordAppAuditEvent({
    sqlite: appDb.sqlite,
    workspaceId: appDb.workspaceId,
    actor: context.actor,
    requestId: context.requestId,
    threadId: context.execution?.threadId ?? null,
    turnId: context.execution?.turnId ?? null,
    itemId: itemId ?? null,
    category: 'system',
    action,
    resource,
    resourceRevision,
    outcome: 'succeeded',
    summary: `${action}. ${facts.join('; ')}.`,
  });
}

/** Reconstructs original logical command facts; preparation fields grant no receipt authority. */
function appCommandFacts(
  input: ControlAppInput
): readonly [
  ControlAppInput['receipt']['command'],
  ControlAppInput['receipt']['responseKind'],
  Record<string, unknown>,
] {
  const change = input.change;
  switch (change.kind) {
    case 'create':
      return [
        'kernel.apps.create',
        'light_app',
        change.requestedDefinition
          ? { requestedDefinition: change.requestedDefinition }
          : { schema: change.schema, sourceSelection: change.sourceSelection },
      ];
    case 'schema':
      return [
        'kernel.schema.update',
        'light_app',
        {
          expectedAppRevision: change.expectedAppRevision,
          expectedSchemaRevision: change.expectedSchemaRevision,
          ...(change.requestedDefinition
            ? { requestedDefinition: change.requestedDefinition }
            : { schema: change.schema, sourceSelection: change.sourceSelection }),
        },
      ];
    case 'retire':
      return [
        'kernel.apps.retire',
        'light_app',
        { expectedAppRevision: change.expectedAppRevision },
      ];
    case 'record-create':
      return [
        'kernel.records.create',
        'light_app_record',
        {
          collectionSelector: change.collectionSelector,
          schemaRevision: change.schemaRevision,
          data: change.data,
        },
      ];
    case 'record-update':
      return [
        'kernel.records.update',
        'light_app_record',
        {
          collectionSelector: change.collectionSelector,
          recordId: change.recordId,
          ...change.body,
          ...(change.lineage ?? {}),
        },
      ];
    case 'record-batch':
      return ['kernel.records.batch', 'light_app_batch', change.body];
    case 'format-journal':
    case 'format-complete':
      return [
        'kernel.format.upgrade',
        'light_app',
        { expectedAppRevision: change.expectedAppRevision },
      ];
    case 'rollback':
      return [
        'kernel.snapshots.rollback',
        'light_app',
        { expectedAppRevision: change.expectedAppRevision, snapshotId: change.snapshotId },
      ];
  }
}

/** Verifies original logical identity before every ordinary or maintenance effect. */
export function assertControlAppReceipt(appDb: AppDb, input: ControlAppInput): void {
  const appId = appDb.appId;
  if (
    input.workspaceId !== appDb.workspaceId ||
    input.appId !== appId ||
    input.requestId !== input.receipt.requestId ||
    input.receipt.scope.workspaceId !== appDb.workspaceId ||
    input.receipt.scope.appId !== appId
  )
    throw new KernelCommandError('unavailable', 'App command ownership does not match.');
  const [command, responseKind, logical] = appCommandFacts(input);
  if (
    input.receipt.command !== command ||
    input.receipt.responseKind !== responseKind ||
    input.receipt.key !==
      commandRequestKey(command, input.requestId, { workspaceId: appDb.workspaceId, appId }) ||
    input.receipt.inputHash !== commandInputHash({ actor: input.actor, ...logical })
  )
    throw new KernelCommandError('idempotency_key_conflict', 'Idempotency key conflict.');
}

/** Verifies the complete original receipt and bounded restored head after candidate COMMIT and reopen. */
export function assertCommittedControlAppRollback(appDb: AppDb, input: ControlAppInput): void {
  if (input.change.kind !== 'rollback')
    throw new KernelCommandError('unavailable', 'App rollback proof is unavailable.');
  assertControlAppReceipt(appDb, input);
  const receipt = getCommandRequestRecordFromDb(appDb, input.receipt.key, input.receipt.createdAt);
  const metadata = readMetadata(appDb);
  if (
    !receipt ||
    receipt.command !== input.receipt.command ||
    receipt.requestId !== input.requestId ||
    receipt.inputHash !== input.receipt.inputHash ||
    receipt.createdAt !== input.receipt.createdAt ||
    receipt.expiresAt !== input.receipt.expiresAt ||
    receipt.scope.workspaceId !== appDb.workspaceId ||
    receipt.scope.appId !== appDb.appId ||
    receipt.response.kind !== input.receipt.responseKind ||
    receipt.response.id !== appDb.appId ||
    metadata.appId !== appDb.appId ||
    metadata.workspaceId !== appDb.workspaceId ||
    metadata.appRevision !== input.change.expectedAppRevision + 1 ||
    metadata.schemaRevision !== input.change.schemaRevision ||
    metadata.schemaDigest !== input.change.definitionVersion ||
    metadata.kernelFormatVersion !== LIGHT_APP_KERNEL_FORMAT_VERSION
  )
    throw new KernelCommandError('unavailable', 'App rollback receipt or head is unavailable.');
}
