import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LightAppSnapshot } from '@openkit/app-api-schemas';
import {
  compareCodeUnits,
  readRetainedV1,
  TimestampSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import {
  ensureCanonicalDirectoryAsync,
  publishDurableFile,
  removeDurableFile,
  syncVerifiedFile,
} from '@openkit/storage';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { type AppDb, lightAppRoot } from '../storage/app-db.js';

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

/** Exact immutable snapshot plan selected only after the App's earlier native requests settle. */
export interface PreparedLightAppSnapshot {
  readonly root: string;
  readonly path: string;
  readonly metadataPath: string;
  readonly copyBytes: number;
  readonly metadata: Omit<LightAppSnapshot, 'digest'>;
  readonly metadataBytes: number;
}

/** Freezes the committed head and all destinations before asking the existing capacity owner. */
export function planLightAppSnapshot(
  appDb: AppDb,
  reason: LightAppSnapshot['reason']
): PreparedLightAppSnapshot {
  const row = appDb.sqlite
    .prepare(
      'SELECT app_revision AS appRevision, schema_revision AS schemaRevision, schema_digest AS definitionVersion FROM app_metadata WHERE app_id = ?'
    )
    .get(appDb.appId) as Pick<
    LightAppSnapshot,
    'appRevision' | 'schemaRevision' | 'definitionVersion'
  >;
  const hasMarker = (
    appDb.sqlite.pragma('table_info(app_metadata)') as Array<{ name: string }>
  ).some((column) => column.name === 'kernel_format_version');
  const kernelFormatVersion = hasMarker
    ? Number(appDb.sqlite.prepare('SELECT kernel_format_version FROM app_metadata').pluck().get())
    : 1;
  const copyBytes =
    Number(appDb.sqlite.pragma('page_count', { simple: true })) *
    Number(appDb.sqlite.pragma('page_size', { simple: true }));
  if (!Number.isSafeInteger(copyBytes) || copyBytes <= 0)
    throw new KernelCommandError('unavailable', 'App snapshot size is unavailable.');
  const metadata = {
    snapshotId: randomUUID(),
    createdAt: new Date().toISOString(),
    reason,
    ...row,
    kernelFormatVersion,
  };
  const root = snapshotRoot(appDb.dataRoot, appDb.workspaceId, appDb.appId);
  const directory = lstatSync(root, { throwIfNoEntry: false });
  if (directory && !directory.isDirectory() && !directory.isSymbolicLink())
    throw Object.assign(new Error('App snapshot destination already exists.'), { code: 'EEXIST' });
  if (directory && (directory.isSymbolicLink() || realpathSync(root) !== root))
    throw new KernelCommandError('unavailable', 'App snapshot directory is unavailable.');
  return {
    root,
    path: join(root, `${metadata.snapshotId}.sqlite`),
    metadataPath: join(root, `${metadata.snapshotId}.json`),
    copyBytes,
    metadata,
    metadataBytes: Buffer.byteLength(
      `${JSON.stringify(writeRetainedV1({ ...metadata, digest: `sha256:${'0'.repeat(64)}` }))}\n`
    ),
  };
}

/** Publishes only the exact already-admitted plan; backup yields without a whole-file owner-thread hash. */
export async function prepareLightAppSnapshot(
  appDb: AppDb,
  plan: PreparedLightAppSnapshot
): Promise<LightAppSnapshot> {
  const { root, path, metadataPath } = plan;
  try {
    await ensureCanonicalDirectoryAsync(root);
    const directory = lstatSync(root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(root) !== root)
      throw new KernelCommandError('unavailable', 'App snapshot directory is unavailable.');
    await appDb.sqlite.backup(path);
    const copy = statSync(path);
    if (copy.size !== plan.copyBytes)
      throw new KernelCommandError('unavailable', 'App snapshot size changed.');
    await syncVerifiedFile({
      path,
      expectedIdentity: `${copy.dev}:${copy.ino}`,
      expectedBytes: copy.size,
      expectedMtimeMs: copy.mtimeMs,
      expectedCtimeMs: copy.ctimeMs,
      expectedMode: copy.mode & 0o777,
    });
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const metadata: LightAppSnapshot = { ...plan.metadata, digest: `sha256:${hash.digest('hex')}` };
    const bytes = `${JSON.stringify(writeRetainedV1(metadata))}\n`;
    if (Buffer.byteLength(bytes) !== plan.metadataBytes)
      throw new KernelCommandError('unavailable', 'App snapshot metadata changed.');
    await publishDurableFile({ destinationPath: metadataPath, bytes });
    return metadata;
  } catch (error) {
    // An occupied parent can raise EEXIST before either publication exists.
    if (existsSync(path)) await removeDurableFile({ destinationPath: path });
    if (existsSync(metadataPath)) await removeDurableFile({ destinationPath: metadataPath });
    throw error;
  }
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
        compareCodeUnits(left.createdAt, right.createdAt) ||
        compareCodeUnits(left.snapshotId, right.snapshotId)
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
  if (sqlite.pragma('quick_check', { simple: true }) !== 'ok') {
    throw new KernelCommandError('unavailable', 'App snapshot failed integrity checks.');
  }
  assertSnapshotRelations(sqlite);
}

/** Checks relational integrity after the App read owner has checked SQLite integrity. */
export function assertSnapshotRelations(sqlite: Database.Database): void {
  if ((sqlite.pragma('foreign_key_check') as unknown[]).length !== 0) {
    throw new KernelCommandError('unavailable', 'App snapshot failed integrity checks.');
  }
}
