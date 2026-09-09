import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LightAppAdmittedSchema } from '@openkit/app-api-schemas';
import { LightAppAdmittedSchemaSchema } from '@openkit/app-api-schemas';
import Database from 'better-sqlite3';

import { listSqliteAuditEvents } from '../audit-events.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import {
  collectionTableName,
  createSchemaDdl,
  fieldColumnName,
  quoteIdent,
} from '../generative-kernel/native.js';
import { encodeSqlValue, normalizeLightAppFieldValue } from '../generative-kernel/values.js';
import type { FsStore } from '../lib/store.js';
import type { AppDb } from './app-db.js';
import { lightAppRoot, lightAppsRoot, openExistingAppDb, writeDurableFile } from './app-db.js';
import type { WorkspaceDb } from './db.js';
import { applyAppMigrations } from './migrate.js';

/** Portable Light App identity row. */
export interface ExportedLightApp {
  schemaVersion: 1;
  recordType: 'light-app';
  id: string;
  ownerScope: 'workspace';
  lineage: { workspaceId: string };
  createdAt: string;
  updatedAt: string;
  contentDigest: string;
  app: {
    workspaceId: string;
    title: string;
    purpose: string;
    appRevision: number;
    schemaRevision: number;
    schemaDigest: string;
    lifecycle: 'active' | 'retired';
    creator: unknown;
    lastMutator: unknown;
    createRequestId: string;
    lastRequestId: string;
  };
}

/** Portable admitted schema revision bytes. */
export interface ExportedLightAppDefinition {
  schemaVersion: 1;
  recordType: 'light-app-definition';
  id: string;
  ownerScope: 'workspace';
  lineage: { workspaceId: string; appId: string };
  createdAt: string;
  updatedAt: string;
  contentDigest: string;
  definition: {
    appId: string;
    schemaRevision: number;
    schemaText: string;
    digest: string;
  };
}

/** Portable native record keyed by field id. */
export interface ExportedLightAppRecord {
  schemaVersion: 1;
  recordType: 'light-app-record';
  id: string;
  ownerScope: 'workspace';
  lineage: { workspaceId: string; appId: string; collectionId: string };
  createdAt: string;
  updatedAt: string;
  contentDigest: string;
  record: {
    appId: string;
    collectionId: string;
    revision: number;
    schemaRevision: number;
    creator: unknown;
    lastMutator: unknown;
    createRequestId: string;
    lastRequestId: string;
    values: Record<string, string | number | boolean | null>;
  };
}

/** Combined portable Light App families for one Workspace. */
export interface LightAppExportFamilies {
  apps: ExportedLightApp[];
  definitions: ExportedLightAppDefinition[];
  records: ExportedLightAppRecord[];
  auditEvents: ReturnType<typeof listSqliteAuditEvents>;
}

/**
 * Projects complete Light App portable families or fails closed on unavailable authority.
 *
 * @param dataRoot Data root.
 * @param workspaceId Workspace id.
 * @returns Portable app, definition, and record families.
 */
export function listExportableLightAppFamilies(
  dataRoot: string,
  workspaceId: string
): LightAppExportFamilies {
  const root = lightAppsRoot(dataRoot, workspaceId);
  if (!existsSync(root)) {
    return { apps: [], definitions: [], records: [], auditEvents: [] };
  }
  const apps: ExportedLightApp[] = [];
  const definitions: ExportedLightAppDefinition[] = [];
  const records: ExportedLightAppRecord[] = [];
  const auditEvents: ReturnType<typeof listSqliteAuditEvents> = [];
  const appIds = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const appId of appIds) {
    let appDb: AppDb;
    try {
      appDb = openExistingAppDb(dataRoot, workspaceId, appId);
    } catch {
      throw new Error(`Unresolved Light App authority cannot be exported: ${appId}`);
    }
    try {
      const metadata = appDb.sqlite
        .prepare(
          `SELECT app_id AS appId, workspace_id AS workspaceId, title, purpose,
                  app_revision AS appRevision, schema_revision AS schemaRevision,
                  schema_digest AS schemaDigest, schema_json AS schemaJson, lifecycle,
                  created_at AS createdAt, updated_at AS updatedAt,
                  creator_json AS creatorJson, last_mutator_json AS lastMutatorJson,
                  create_request_id AS createRequestId, last_request_id AS lastRequestId
           FROM app_metadata WHERE app_id = ?`
        )
        .get(appId) as
        | {
            appId: string;
            workspaceId: string;
            title: string;
            purpose: string;
            appRevision: number;
            schemaRevision: number;
            schemaDigest: string;
            schemaJson: string;
            lifecycle: 'active' | 'retired';
            createdAt: string;
            updatedAt: string;
            creatorJson: string;
            lastMutatorJson: string;
            createRequestId: string;
            lastRequestId: string;
          }
        | undefined;
      if (!metadata) {
        throw new Error(`Unresolved Light App authority cannot be exported: ${appId}`);
      }
      const schema = LightAppAdmittedSchemaSchema.parse(JSON.parse(metadata.schemaJson));
      assertNativeInventory(appDb.sqlite, schema);
      apps.push({
        schemaVersion: 1,
        recordType: 'light-app',
        id: appId,
        ownerScope: 'workspace',
        lineage: { workspaceId },
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        contentDigest: metadata.schemaDigest,
        app: {
          workspaceId,
          title: metadata.title,
          purpose: metadata.purpose,
          appRevision: metadata.appRevision,
          schemaRevision: metadata.schemaRevision,
          schemaDigest: metadata.schemaDigest,
          lifecycle: metadata.lifecycle,
          creator: JSON.parse(metadata.creatorJson),
          lastMutator: JSON.parse(metadata.lastMutatorJson),
          createRequestId: metadata.createRequestId,
          lastRequestId: metadata.lastRequestId,
        },
      });
      const definitionRoot = join(lightAppRoot(dataRoot, workspaceId, appId), 'definitions');
      if (!existsSync(definitionRoot)) {
        throw new Error(`Missing Light App definition directory: ${appId}`);
      }
      const definitionFiles = readdirSync(definitionRoot)
        .filter((name) => name.endsWith('.json'))
        .sort();
      if (definitionFiles.length === 0) {
        throw new Error(`Missing Light App definition bytes: ${appId}`);
      }
      for (const fileName of definitionFiles) {
        const schemaText = readFileSync(join(definitionRoot, fileName), 'utf8');
        const digest = `sha256:${createHash('sha256').update(schemaText, 'utf8').digest('hex')}`;
        const expectedHex = digest.slice('sha256:'.length);
        if (fileName !== `${expectedHex}.json`) {
          throw new Error(`Light App definition digest mismatch: ${appId}`);
        }
        const admitted = LightAppAdmittedSchemaSchema.parse(JSON.parse(schemaText));
        definitions.push({
          schemaVersion: 1,
          recordType: 'light-app-definition',
          id: `${appId}:${admitted.schemaRevision}:${expectedHex}`,
          ownerScope: 'workspace',
          lineage: { workspaceId, appId },
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
          contentDigest: digest,
          definition: {
            appId,
            schemaRevision: admitted.schemaRevision,
            schemaText,
            digest,
          },
        });
      }
      const currentHex = metadata.schemaDigest.slice('sha256:'.length);
      if (!definitionFiles.includes(`${currentHex}.json`)) {
        throw new Error(`Current Light App definition is missing: ${appId}`);
      }
      for (const collection of schema.collections) {
        const table = quoteIdent(collectionTableName(collection.id));
        const rows = appDb.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Array<
          Record<string, unknown>
        >;
        for (const row of rows) {
          const values: Record<string, string | number | boolean | null> = {};
          for (const field of collection.fields) {
            values[field.id] = decodeSqlValue(field.type, row[fieldColumnName(field.id)]) as
              | string
              | number
              | boolean
              | null;
          }
          const recordId = String(row.id);
          records.push({
            schemaVersion: 1,
            recordType: 'light-app-record',
            id: recordId,
            ownerScope: 'workspace',
            lineage: { workspaceId, appId, collectionId: collection.id },
            createdAt: String(row.created),
            updatedAt: String(row.updated),
            contentDigest: digestJson(values),
            record: {
              appId,
              collectionId: collection.id,
              revision: Number(row.revision),
              schemaRevision: Number(row.write_schema_revision),
              creator: JSON.parse(String(row.creator_json)),
              lastMutator: JSON.parse(String(row.last_mutator_json)),
              createRequestId: String(row.create_request_id),
              lastRequestId: String(row.last_request_id),
              values,
            },
          });
        }
      }
      auditEvents.push(...listSqliteAuditEvents(appDb.sqlite));
    } finally {
      appDb.sqlite.close();
    }
  }
  return { apps, definitions, records, auditEvents };
}

/**
 * Validates presentation Item references for export.
 *
 * @param store File store.
 * @param workspaceId Workspace id.
 * @param presentations Portable presentation rows.
 */
export function assertExportableGenerativePresentations(
  store: FsStore,
  workspaceId: string,
  presentations: readonly unknown[]
): void {
  const items = store.listWorkspaceItemRevisions(workspaceId);
  const byId = new Map(items.map((item) => [item.id, item]));
  const presentationsById = new Map(
    presentations.map((row) => {
      const record = row as { id: string; lineage: { itemId: string; threadId: string } };
      return [record.id, record];
    })
  );
  for (const row of presentations) {
    const record = row as { id: string; lineage: { itemId: string; threadId: string } };
    const item = byId.get(record.lineage.itemId);
    if (!item) {
      continue;
    }
    if (
      item.type !== 'generative-ui-reference' ||
      item.presentationId !== record.id ||
      item.threadId !== record.lineage.threadId
    ) {
      throw new Error(`Inconsistent generative-ui-reference cannot be exported: ${item.id}`);
    }
  }
  for (const item of items) {
    if (item.type !== 'generative-ui-reference') {
      continue;
    }
    if (!presentationsById.has(item.presentationId)) {
      throw new Error(`Dangling generative-ui-reference cannot be exported: ${item.id}`);
    }
  }
}

/**
 * Remints and reconstructs Light Apps under a staged Workspace directory.
 *
 * @param input Staged workspace root, remint maps, and exported families.
 * @returns Source-to-target app id map.
 */
export function importLightAppFamilies(input: {
  workspaceRoot: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  apps: readonly ExportedLightApp[];
  definitions: readonly ExportedLightAppDefinition[];
  records: readonly ExportedLightAppRecord[];
}): Map<string, string> {
  const appIds = new Map<string, string>();
  for (const app of input.apps) {
    appIds.set(app.id, randomUUID());
  }
  const definitionsByApp = new Map<string, ExportedLightAppDefinition[]>();
  for (const definition of input.definitions) {
    const list = definitionsByApp.get(definition.definition.appId) ?? [];
    list.push(definition);
    definitionsByApp.set(definition.definition.appId, list);
  }
  for (const app of input.apps) {
    const targetAppId = appIds.get(app.id);
    if (!targetAppId) {
      throw new Error(`Missing reminted Light App id: ${app.id}`);
    }
    const familyDefinitions = definitionsByApp.get(app.id) ?? [];
    for (const definition of familyDefinitions) {
      const actualDigest = digestText(definition.definition.schemaText);
      if (
        definition.definition.digest !== actualDigest ||
        definition.contentDigest !== actualDigest
      ) {
        throw new Error(`Imported Light App definition digest mismatch: ${definition.id}`);
      }
    }
    const current = familyDefinitions.find(
      (definition) => definition.definition.digest === app.app.schemaDigest
    );
    if (!current) {
      throw new Error(`Imported Light App is missing its current definition: ${app.id}`);
    }
    const rewrittenSchema = rewriteAdmittedSchema(current.definition.schemaText, targetAppId);
    const schemaText = `${JSON.stringify(rewrittenSchema)}\n`;
    const digest = `sha256:${createHash('sha256').update(schemaText, 'utf8').digest('hex')}`;
    const appRoot = join(input.workspaceRoot, 'light-apps', targetAppId);
    mkdirSync(join(appRoot, 'definitions'), { recursive: true });
    for (const definition of definitionsByApp.get(app.id) ?? []) {
      const historical = rewriteAdmittedSchema(definition.definition.schemaText, targetAppId);
      const historicalText = `${JSON.stringify(historical)}\n`;
      const historicalDigest = `sha256:${createHash('sha256')
        .update(historicalText, 'utf8')
        .digest('hex')}`;
      const definitionPath = join(
        appRoot,
        'definitions',
        `${historicalDigest.slice('sha256:'.length)}.json`
      );
      if (!existsSync(definitionPath)) {
        writeDurableFile(definitionPath, historicalText);
      }
    }
    const sqlite = new Database(join(appRoot, 'data.sqlite'));
    try {
      applyAppMigrations(sqlite);
      for (const statement of createSchemaDdl(rewrittenSchema)) {
        sqlite.exec(statement);
      }
      sqlite.exec('BEGIN');
      sqlite.pragma('defer_foreign_keys = ON');
      sqlite
        .prepare(
          `INSERT INTO app_metadata (
            app_id, workspace_id, title, purpose, app_revision, schema_revision,
            schema_digest, schema_json, lifecycle, created_at, updated_at,
            creator_json, last_mutator_json, create_request_id, last_request_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          targetAppId,
          input.targetWorkspaceId,
          app.app.title,
          app.app.purpose,
          app.app.appRevision,
          app.app.schemaRevision,
          digest,
          schemaText,
          app.app.lifecycle,
          app.createdAt,
          app.updatedAt,
          JSON.stringify(app.app.creator),
          JSON.stringify(app.app.lastMutator),
          app.app.createRequestId,
          app.app.lastRequestId
        );
      for (const exported of input.records.filter((record) => record.record.appId === app.id)) {
        if (exported.contentDigest !== digestJson(exported.record.values)) {
          throw new Error(`Imported Light App record digest mismatch: ${exported.id}`);
        }
        const collection = rewrittenSchema.collections.find(
          (candidate) => candidate.id === exported.record.collectionId
        );
        if (!collection) {
          throw new Error(`Imported Light App record is missing its collection: ${exported.id}`);
        }
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
        const values = [
          exported.id,
          exported.record.revision,
          exported.createdAt,
          exported.updatedAt,
          JSON.stringify(exported.record.creator),
          JSON.stringify(exported.record.lastMutator),
          exported.record.createRequestId,
          exported.record.lastRequestId,
          exported.record.schemaRevision,
          ...collection.fields.map((field) => {
            const raw = exported.record.values[field.id];
            if (raw === undefined) {
              throw new Error(`Imported Light App record is missing field ${field.id}.`);
            }
            if (raw === null) {
              if (field.required) {
                throw new Error(`Imported Light App record has a null required field: ${field.id}`);
              }
              return encodeSqlValue(field.type, null);
            }
            try {
              return encodeSqlValue(field.type, normalizeLightAppFieldValue(field, raw));
            } catch (error) {
              if (error instanceof KernelCommandError) {
                throw new Error(
                  `Imported Light App record is invalid: ${exported.id}: ${error.message}`
                );
              }
              throw error;
            }
          }),
        ];
        sqlite
          .prepare(
            `INSERT INTO ${quoteIdent(collectionTableName(collection.id))} (${columns
              .map((column) => quoteIdent(column))
              .join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
          )
          .run(...values);
      }
      const foreignKeyFailures = sqlite.pragma('foreign_key_check') as unknown[];
      if (foreignKeyFailures.length > 0) {
        sqlite.exec('ROLLBACK');
        throw new Error(`Imported Light App relations failed integrity: ${app.id}`);
      }
      sqlite.exec('COMMIT');
    } catch (error) {
      try {
        sqlite.exec('ROLLBACK');
      } catch {
        // The connection may already be rolled back.
      }
      throw error;
    } finally {
      sqlite.close();
    }
  }
  return appIds;
}

/**
 * Remints retained presentations for the target Workspace.
 *
 * @param input Workspace database and remint maps.
 */
export function importGenerativePresentations(input: {
  workspaceDb: WorkspaceDb;
  presentations: readonly Record<string, unknown>[];
  targetWorkspaceId: string;
  threadIds: ReadonlyMap<string, string>;
  turnIds: ReadonlyMap<string, string>;
  itemIds: ReadonlyMap<string, string>;
  appIds: ReadonlyMap<string, string>;
  presentationIds: ReadonlyMap<string, string>;
}): void {
  for (const row of input.presentations) {
    const sourceId = String(row.id);
    const lineage = asRecord(row.lineage);
    const presentation = asRecord(row.presentation);
    const targetId = requiredMapValue(input.presentationIds, sourceId, 'presentation');
    const threadId = requiredMapValue(input.threadIds, String(lineage.threadId), 'thread');
    const turnId = requiredMapValue(input.turnIds, String(lineage.turnId), 'turn');
    const itemId = requiredMapValue(input.itemIds, String(lineage.itemId), 'item');
    const source = rewritePresentationSource(presentation.source, input.appIds, input.itemIds);
    const actions = presentation.actions;
    const messages = presentation.messages;
    const exportedDigest = String(row.contentDigest);
    if (exportedDigest !== digestJson(messages)) {
      throw new Error(`Imported presentation content digest mismatch: ${sourceId}`);
    }
    const originRequestId =
      (typeof presentation.originRequestId === 'string' && presentation.originRequestId) ||
      (typeof presentation.requestId === 'string' ? presentation.requestId : null);
    input.workspaceDb.sqlite
      .prepare(
        `INSERT INTO generative_presentations (
          presentation_id, workspace_id, thread_id, turn_id, item_id, created_at, actor_json,
          request_id, origin_request_id, semantic_input_hash, title, fallback_text, protocol_version,
          catalog_id, messages_json, content_digest, source_json, actions_json, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        targetId,
        input.targetWorkspaceId,
        threadId,
        turnId,
        itemId,
        String(row.createdAt),
        JSON.stringify(presentation.actor),
        null,
        originRequestId,
        String(presentation.semanticInputHash),
        String(presentation.title),
        String(presentation.fallbackText),
        String(presentation.protocolVersion),
        String(presentation.catalogId),
        JSON.stringify(messages),
        digestJson(messages),
        JSON.stringify(source),
        JSON.stringify(actions),
        String(presentation.observedAt)
      );
  }
}

function assertNativeInventory(sqlite: Database.Database, schema: LightAppAdmittedSchema): void {
  const expected = new Set(
    schema.collections.map((collection) => collectionTableName(collection.id))
  );
  const tables = sqlite
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'c_*' ORDER BY name`
    )
    .all() as Array<{ name: string }>;
  for (const table of tables) {
    if (!expected.has(table.name)) {
      throw new Error(`Unknown native Light App table cannot be exported: ${table.name}`);
    }
  }
  for (const name of expected) {
    if (!tables.some((table) => table.name === name)) {
      throw new Error(`Missing native Light App table cannot be exported: ${name}`);
    }
  }
  const reserved = new Set([
    'id',
    'revision',
    'created',
    'updated',
    'creator_json',
    'last_mutator_json',
    'create_request_id',
    'last_request_id',
    'write_schema_revision',
  ]);
  for (const collection of schema.collections) {
    const expectedColumns = new Set([
      ...reserved,
      ...collection.fields.map((field) => fieldColumnName(field.id)),
    ]);
    const columns = sqlite
      .prepare(`PRAGMA table_info(${quoteIdent(collectionTableName(collection.id))})`)
      .all() as Array<{ name: string }>;
    for (const column of columns) {
      if (!expectedColumns.has(column.name)) {
        throw new Error(
          `Unknown native Light App column cannot be exported: ${collection.id}.${column.name}`
        );
      }
    }
    for (const name of expectedColumns) {
      if (!columns.some((column) => column.name === name)) {
        throw new Error(
          `Missing native Light App column cannot be exported: ${collection.id}.${name}`
        );
      }
    }
  }
}

function rewriteAdmittedSchema(schemaText: string, targetAppId: string): LightAppAdmittedSchema {
  const parsed = LightAppAdmittedSchemaSchema.parse(JSON.parse(schemaText));
  return { ...parsed, appId: targetAppId };
}

function rewritePresentationSource(
  source: unknown,
  appIds: ReadonlyMap<string, string>,
  itemIds: ReadonlyMap<string, string>
): unknown {
  const record = asRecord(source);
  if (record.kind === 'kernel-records') {
    return {
      ...record,
      appId: requiredMapValue(appIds, String(record.appId), 'app'),
    };
  }
  if (record.kind === 'item') {
    return {
      ...record,
      itemId: requiredMapValue(itemIds, String(record.itemId), 'item'),
    };
  }
  return record;
}

function decodeSqlValue(type: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (type === 'bool') {
    return Number(value) === 1;
  }
  return value;
}

function digestJson(value: unknown): string {
  return digestText(JSON.stringify(value));
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Portable generative record must be an object.');
  }
  return value as Record<string, unknown>;
}

function requiredMapValue(map: ReadonlyMap<string, string>, key: string, label: string): string {
  const value = map.get(key);
  if (!value) {
    throw new Error(`Missing reminted ${label} identity: ${key}`);
  }
  return value;
}
