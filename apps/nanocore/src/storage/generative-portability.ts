import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LightAppAdmittedSchema } from '@openkit/app-api-schemas';
import { LightAppAdmittedSchemaSchema } from '@openkit/app-api-schemas';
import type Database from 'better-sqlite3';

import { listSqliteAuditEvents } from '../audit-events.js';
import { collectionTableName, fieldColumnName, quoteIdent } from '../generative-kernel/native.js';
import type { FsStore } from '../lib/store.js';
import type { AppDb } from './app-db.js';
import { lightAppRoot, lightAppsRoot, openExistingAppDb } from './app-db.js';

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
