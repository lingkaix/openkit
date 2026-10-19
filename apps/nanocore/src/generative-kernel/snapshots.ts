import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LightAppSnapshot } from '@openkit/app-api-schemas';
import { readRetainedV1, TimestampSchema, writeRetainedV1 } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { type AppDb, lightAppRoot, writeDurableFile } from '../storage/app-db.js';
import { KernelCommandError } from './errors.js';

// Recovery metadata versions its own grammar, independently of the API and copied SQLite format.
const StoredLightAppSnapshotV1Schema = z.object({
  snapshotId: z.string().uuid(),
  createdAt: TimestampSchema,
  reason: z.enum(['definition-migration', 'kernel-format-migration']),
  appRevision: z.number().int().positive(),
  schemaRevision: z.number().int().positive(),
  definitionVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  kernelFormatVersion: z.number().int().positive(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

/**
 * Publishes a complete consistent SQLite copy before changing definition or format.
 *
 * serialize includes committed WAL contents and the current transaction's rows.
 * The metadata file is published last, so a partial copy is never selectable.
 *
 * @param appDb Open app database, optionally inside its synchronous write transaction.
 * @param reason Migration that requires the recovery copy.
 * @returns Inspectable recovery metadata.
 */
export function snapshotLightApp(
  appDb: AppDb,
  reason: LightAppSnapshot['reason']
): LightAppSnapshot {
  const row = appDb.sqlite
    .prepare(
      'SELECT app_revision AS appRevision, schema_revision AS schemaRevision, schema_digest AS definitionVersion FROM app_metadata WHERE app_id = ?'
    )
    .get(appDb.appId) as { appRevision: number; schemaRevision: number; definitionVersion: string };
  const hasMarker = (
    appDb.sqlite.pragma('table_info(app_metadata)') as Array<{ name: string }>
  ).some((column) => column.name === 'kernel_format_version');
  const kernelFormatVersion = hasMarker
    ? Number(appDb.sqlite.prepare('SELECT kernel_format_version FROM app_metadata').pluck().get())
    : 1;
  const bytes = appDb.sqlite.serialize();
  const metadata: LightAppSnapshot = {
    snapshotId: randomUUID(),
    createdAt: new Date().toISOString(),
    reason,
    ...row,
    kernelFormatVersion,
    digest: sqliteDigest(bytes),
  };
  const root = snapshotRoot(appDb.dataRoot, appDb.workspaceId, appDb.appId);
  const path = join(root, `${metadata.snapshotId}.sqlite`);
  try {
    mkdirSync(root, { recursive: true });
    // Persist the app directory entry for a newly created snapshot directory.
    const parent = openSync(lightAppRoot(appDb.dataRoot, appDb.workspaceId, appDb.appId), 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    writeDurableFile(path, bytes);
    writeDurableFile(
      join(root, `${metadata.snapshotId}.json`),
      `${JSON.stringify(writeRetainedV1(metadata))}\n`
    );
  } catch (error) {
    if (existsSync(path)) rmSync(path, { force: true });
    const metadataPath = join(root, `${metadata.snapshotId}.json`);
    if (existsSync(metadataPath)) rmSync(metadataPath, { force: true });
    throw error;
  }
  return metadata;
}

/**
 * Lists published recovery copies without opening or migrating app authority.
 *
 * @param dataRoot Data root.
 * @param workspaceId Owning Workspace.
 * @param appId App identity.
 * @returns Published recovery metadata.
 */
export function readLightAppSnapshots(
  dataRoot: string,
  workspaceId: string,
  appId: string
): LightAppSnapshot[] {
  const root = snapshotRoot(dataRoot, workspaceId, appId);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    .map((name) => {
      const metadata = readRetainedV1(JSON.parse(readFileSync(join(root, name), 'utf8')), (value) =>
        StoredLightAppSnapshotV1Schema.parse(value)
      );
      if (`${metadata.snapshotId}.json` !== name) {
        throw new KernelCommandError(
          'unavailable',
          'Snapshot identity does not match its metadata.'
        );
      }
      return metadata;
    })
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.snapshotId.localeCompare(right.snapshotId)
    );
}

/**
 * Reads and verifies the exact bytes of one explicitly selected recovery copy.
 *
 * @param dataRoot Data root.
 * @param workspaceId Owning Workspace.
 * @param appId App identity.
 * @param snapshotId Selected recovery copy.
 * @returns Verified bytes and metadata.
 */
export function readLightAppSnapshot(
  dataRoot: string,
  workspaceId: string,
  appId: string,
  snapshotId: string
): { bytes: Buffer; metadata: LightAppSnapshot } {
  const metadata = readLightAppSnapshots(dataRoot, workspaceId, appId).find(
    (snapshot) => snapshot.snapshotId === snapshotId
  );
  if (!metadata) throw new KernelCommandError('not_found', 'App snapshot was not found.');
  const bytes = readFileSync(
    join(snapshotRoot(dataRoot, workspaceId, appId), `${metadata.snapshotId}.sqlite`)
  );
  if (sqliteDigest(bytes) !== metadata.digest) {
    throw new KernelCommandError('unavailable', 'App snapshot digest does not match.');
  }
  return { bytes, metadata };
}

/** Returns the directory owned by one app's recovery copies. */
function snapshotRoot(dataRoot: string, workspaceId: string, appId: string): string {
  return join(lightAppRoot(dataRoot, workspaceId, appId), 'snapshots');
}

/** Returns a SHA-256 digest of exact SQLite bytes. */
function sqliteDigest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Checks a restored candidate before publication, including relational integrity. */
export function assertSnapshotIntegrity(sqlite: Database.Database): void {
  if (
    sqlite.pragma('quick_check', { simple: true }) !== 'ok' ||
    (sqlite.pragma('foreign_key_check') as unknown[]).length !== 0
  ) {
    throw new KernelCommandError('unavailable', 'App snapshot failed integrity checks.');
  }
}
