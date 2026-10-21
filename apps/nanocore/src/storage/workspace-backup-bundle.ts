import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type EntityKind, isEntityId } from '@openkit/protocol';
import { type Node as JsonNode, type ParseError, parseTree, visit } from 'jsonc-parser';
import { z } from 'zod';
import type { FileStorageAdmission, FileStorageReservation } from './artifacts/file-admission.js';
import { FileAdmissionError } from './artifacts/file-admission.js';
import { assertWorkspaceArchiveFilePath } from './workspace-archive.js';

/** Safe refusal category for offline callers; no source exception or content escapes. */
export class WorkspaceBackupBundleError extends Error {
  constructor(
    readonly code:
      | 'invalid-bundle'
      | 'unsafe-path'
      | 'release-mismatch'
      | 'unsupported-format'
      | 'capacity-exceeded'
  ) {
    super('Workspace backup bundle verification failed.');
    this.name = 'WorkspaceBackupBundleError';
  }
}

/** Root manifest of the operational bundle, distinct from analytical export V3. */
export const WORKSPACE_BACKUP_MANIFEST_FILE = 'manifest.json';
/** Completion marker; a digest binding, not a signature or source-authentication proof. */
export const WORKSPACE_BACKUP_SEAL_FILE = 'seal.json';

// Match the existing archive's file, expanded-byte and entry ceilings. Metadata has
// a separate finite parsing budget; content is copied and read in bounded chunks.
const MAX_FILE_BYTES = 2_147_483_648;
const MAX_TOTAL_BYTES = 34_359_738_368;
const MAX_ENTRIES = 200_000;
const MAX_METADATA_BYTES = 16_777_216;
const CHUNK_BYTES = 65_536;
const METADATA_FILES = new Set([WORKSPACE_BACKUP_MANIFEST_FILE, WORKSPACE_BACKUP_SEAL_FILE]);
const textSchema = z.string().min(1);
const integerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}(?![\s\S])/);

/** Builds a named-kind boundary without inventing an identifier or a derivation. */
function identitySchema(kind: EntityKind) {
  return z.string().refine((value) => isEntityId(kind, value));
}

/** Requires the existing canonical USTAR path grammar and a regular-file suffix. */
function isBundlePath(path: string): boolean {
  try {
    if (path.endsWith('/')) return false;
    assertWorkspaceArchiveFilePath(path);
    return true;
  } catch {
    return false;
  }
}

const pathSchema = textSchema.refine(isBundlePath);
const inventoryEntrySchema = z.strictObject({
  path: pathSchema.refine((path) => !METADATA_FILES.has(path)),
  bytes: integerSchema.max(MAX_FILE_BYTES),
  sha256: digestSchema,
  mode: integerSchema.max(0o777),
});
const inventorySchema = z.array(inventoryEntrySchema).max(MAX_ENTRIES);
const lineageSchema = z.object({
  sourceDeploymentId: identitySchema('dep'),
  backupId: identitySchema('wsbak'),
  manifestDigest: digestSchema,
});
const releaseSchema = z.object({ version: textSchema, buildId: textSchema });
const coverageSchema = z.object({
  includedAuthorities: z.array(textSchema),
  snapshotRoots: z.array(pathSchema),
  omittedProjections: z.array(textSchema),
  omittedVolumes: z.array(textSchema),
  externalDependencies: z.array(
    z.object({
      kind: z.enum([
        'vault',
        'worker-volume',
        'native-session',
        'server-knowledge',
        'external-source',
        'agent',
        'configuration',
        'catalog',
        'repository',
        'mount',
      ]),
      reference: textSchema,
      availability: z.enum(['available', 'unavailable', 'omitted']),
    })
  ),
});
const manifestSchema = z.object({
  format: z.literal('openkit-workspace-backup'),
  version: z.literal(1),
  purpose: z.enum(['backup', 'move']),
  backupId: identitySchema('wsbak'),
  workspaceId: identitySchema('ws'),
  sourceDeploymentId: identitySchema('dep'),
  knowledgeBaseIds: z.array(identitySchema('kb')).min(1),
  capturedRevision: integerSchema,
  priorMoves: z.array(lineageSchema),
  release: releaseSchema,
  databaseFormats: z.array(
    z.object({
      path: pathSchema,
      markers: z.record(textSchema, integerSchema.min(1)),
    })
  ),
  requiredFeatures: z.array(textSchema),
  capture: z.object({
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    consistency: z.enum(['workspace-consistent', 'quiescent']),
  }),
  inventory: inventorySchema,
  inventoryDigest: digestSchema,
  coverage: coverageSchema,
  accounts: z.object({
    ownerId: identitySchema('usr'),
    memberIds: z.array(identitySchema('usr')),
    privateAudienceRefs: z.array(textSchema),
  }),
});
const sealSchema = z.object({
  format: z.literal('openkit-workspace-backup-seal'),
  version: z.literal(1),
  backupId: identitySchema('wsbak'),
  purpose: z.enum(['backup', 'move']),
  manifestDigest: digestSchema,
});

/** Exact effect-bearing file inventory; unknown fields are not descriptive extensions. */
export type WorkspaceBackupInventoryEntry = Readonly<z.infer<typeof inventoryEntrySchema>>;
/** Historical move attribution; never destination authority. */
export type WorkspaceBackupLineage = Readonly<z.infer<typeof lineageSchema>>;
/** Declared coverage, not proof of complete database or reference closure. */
export type WorkspaceBackupCoverage = Readonly<z.infer<typeof coverageSchema>>;
/** Known version-1 manifest fields; ignored descriptive content is not forwarded. */
export type WorkspaceBackupManifest = Readonly<z.infer<typeof manifestSchema>>;
/** Known completion-marker fields, binding the exact original manifest bytes. */
export type WorkspaceBackupSeal = Readonly<z.infer<typeof sealSchema>>;

/** Trusted release expectations and existing request-owned staging/capacity admission. */
export interface WorkspaceBackupVerificationInput {
  readonly bundleRoot: string;
  readonly stagingParent: string;
  readonly admission: FileStorageAdmission;
  readonly expectedRelease: Readonly<{ version: string; buildId: string }>;
  readonly supportedDatabaseFormats: Readonly<Record<string, number>>;
  readonly supportedRequiredFeatures?: readonly string[];
  /** Internal source decision only: verify a prepared MOVE without manufacturing a transferable seal. */
  readonly allowPreparedMove?: boolean;
}

/** Callback-scoped verified bytes; no live admission, capture or complete-closure authority. */
export interface VerifiedWorkspaceBackupBundle {
  readonly verification: 'structural-only';
  readonly manifest: WorkspaceBackupManifest;
  readonly seal: WorkspaceBackupSeal | null;
  readonly manifestDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Reads an inventoried private copy only while the consuming callback is active. */
  readonly readFile: (path: string) => AsyncIterable<Uint8Array>;
}

/** Refuses duplicate identities, paths or contradictory file/directory ownership. */
function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length)
    throw new Error('Workspace backup repeats a core identity.');
}

/** Validates the exact inventory without reordering the original serialized entries. */
function validateInventory(value: unknown): WorkspaceBackupInventoryEntry[] {
  const parsed = inventorySchema.safeParse(value);
  if (!parsed.success) throw new Error('Workspace backup inventory is invalid.');
  const paths = new Set(parsed.data.map((entry) => entry.path));
  assertUnique(parsed.data.map((entry) => entry.path));
  let bytes = 0;
  for (const entry of parsed.data) {
    bytes += entry.bytes;
    if (bytes > MAX_TOTAL_BYTES) throw new Error('Workspace backup exceeds its byte limit.');
    const parts = entry.path.split('/');
    parts.pop();
    while (parts.length > 0) {
      if (paths.has(parts.join('/'))) throw new Error('Workspace backup file paths conflict.');
      parts.pop();
    }
  }
  return parsed.data;
}

/** Freezes the known-field projection, including its nested arrays and records. */
function freezeProjection<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeProjection(child);
    Object.freeze(value);
  }
  return value;
}

/** Parses the known manifest core and ignores, but never forwards, descriptive additions. */
export function parseWorkspaceBackupManifest(value: unknown): WorkspaceBackupManifest {
  if (
    value &&
    typeof value === 'object' &&
    'inventory' in value &&
    Array.isArray(value.inventory)
  ) {
    for (const entry of value.inventory) {
      if (entry && typeof entry.path === 'string' && !isBundlePath(entry.path))
        throw new WorkspaceBackupBundleError('unsafe-path');
    }
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new Error('Workspace backup manifest is invalid.');
  const manifest = parsed.data;
  validateInventory(manifest.inventory);
  assertUnique(manifest.knowledgeBaseIds);
  assertUnique(manifest.requiredFeatures);
  assertUnique(manifest.accounts.memberIds);
  assertUnique(manifest.databaseFormats.map((database) => database.path));
  assertUnique(manifest.priorMoves.map((move) => move.backupId));
  if (
    Date.parse(manifest.capture.completedAt) < Date.parse(manifest.capture.startedAt) ||
    (manifest.purpose === 'move' && manifest.capture.consistency !== 'quiescent')
  ) {
    throw new Error('Workspace backup capture facts conflict.');
  }
  const paths = new Set(manifest.inventory.map((entry) => entry.path));
  for (const database of manifest.databaseFormats) {
    if (!paths.has(database.path) || Object.keys(database.markers).length === 0) {
      throw new Error('Workspace backup database coverage is invalid.');
    }
  }
  return freezeProjection(manifest);
}

/** Parses the known seal core; possession of a valid seal supplies no authorization. */
export function parseWorkspaceBackupSeal(value: unknown): WorkspaceBackupSeal {
  const parsed = sealSchema.safeParse(value);
  if (!parsed.success) throw new Error('Workspace backup seal is invalid.');
  return freezeProjection(parsed.data);
}

/** One strictly decoded metadata document and source offsets for exact-byte digest selection. */
interface DecodedMetadata {
  readonly value: unknown;
  readonly text: string;
  readonly tree: JsonNode;
}

/** Rejects malformed UTF-8, duplicate JSON keys, comments, trailing commas and excessive nesting. */
function decodeMetadata(bytes: Uint8Array): DecodedMetadata {
  if (bytes.byteLength > MAX_METADATA_BYTES)
    throw new Error('Workspace backup metadata is too large.');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const keys: (Set<string> | null)[] = [];
  const enter = (members: Set<string> | null) => {
    keys.push(members);
    if (keys.length > 64) throw new Error('Workspace backup metadata is too deeply nested.');
  };
  visit(
    text,
    {
      onObjectBegin: () => enter(new Set()),
      onObjectProperty: (name) => {
        const members = keys.at(-1);
        if (!members || members.has(name))
          throw new Error('Workspace backup metadata repeats a key.');
        members.add(name);
      },
      onObjectEnd: () => {
        keys.pop();
      },
      onArrayBegin: () => enter(null),
      onArrayEnd: () => {
        keys.pop();
      },
      onError: () => {
        throw new Error('Workspace backup metadata is invalid JSON.');
      },
    },
    { disallowComments: true, allowTrailingComma: false }
  );
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!tree || errors.length > 0) throw new Error('Workspace backup metadata is invalid JSON.');
  return { value: JSON.parse(text) as unknown, text, tree };
}

/** Hashes raw bytes using the shared digest spelling, without normalization or serialization. */
function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Validates and hashes the original UTF-8 inventory-array bytes, preserving every byte and field order. */
export function workspaceBackupInventoryDigest(inventoryBytes: Uint8Array): string {
  validateInventory(decodeMetadata(inventoryBytes).value);
  return digest(inventoryBytes);
}

/** Selects the original inventory array, not a parser's reordered or re-serialized projection. */
function originalInventoryBytes(bytes: Buffer, metadata: DecodedMetadata): Buffer {
  const property = metadata.tree.children?.find(
    (node) => node.children?.[0]?.value === 'inventory'
  );
  const array = property?.children?.[1];
  if (metadata.tree.type !== 'object' || array?.type !== 'array') {
    throw new Error('Workspace backup inventory is missing.');
  }
  const start = Buffer.byteLength(metadata.text.slice(0, array.offset), 'utf8');
  const length = Buffer.byteLength(
    metadata.text.slice(array.offset, array.offset + array.length),
    'utf8'
  );
  return bytes.subarray(start, start + length);
}

/** Rejects unsupported required extensions even when they occur in otherwise descriptive content. */
function assertRequiredFeatures(value: unknown, supported: ReadonlySet<string>): void {
  if (value === null || typeof value !== 'object') return;
  if (!Array.isArray(value) && Object.hasOwn(value, 'requiredFeatures')) {
    const features: unknown = (value as Record<string, unknown>).requiredFeatures;
    if (
      !Array.isArray(features) ||
      features.some((feature) => typeof feature !== 'string' || !supported.has(feature))
    ) {
      throw new WorkspaceBackupBundleError('unsupported-format');
    }
  }
  for (const child of Object.values(value)) assertRequiredFeatures(child, supported);
}

/** One source tree's bounded regular-file inventory, collected without following links. */
interface SourceTree {
  readonly files: Map<string, BigIntStats>;
  readonly directories: Set<string>;
}

/** Resolves an existing directory without accepting a symlink at any path component. */
async function existingRoot(path: string): Promise<string> {
  const root = resolve(path);
  if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory()) {
    throw new WorkspaceBackupBundleError('unsafe-path');
  }
  return root;
}

/**
 * Addresses only an owned, open directory, not the mutable source pathname.
 * Node has no fd-relative opendir API. The kernel descriptor alias supplies that
 * anchor on the server; an unavailable alias fails closed, with no path fallback.
 */
function sourceDirectoryPath(directory: FileHandle): string {
  return `/proc/self/fd/${directory.fd}`;
}

/** Opens one no-follow directory and verifies the inode selected by its anchored parent. */
async function openSourceDirectory(path: string, expected: BigIntStats): Promise<FileHandle> {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const stat = await directory.stat({ bigint: true });
    if (
      !expected.isDirectory() ||
      !stat.isDirectory() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino
    ) {
      throw new Error('Workspace backup directory changed.');
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

/** Bounds incremental enumeration before reading content; directory handles prevent swap escapes. */
async function inspectTree(root: FileHandle): Promise<SourceTree> {
  const files = new Map<string, BigIntStats>();
  const directories = new Set<string>();
  const device = (await root.stat({ bigint: true })).dev;
  let count = 0;
  let bytes = 0n;
  const walk = async (directory: FileHandle, prefix: string): Promise<void> => {
    const children = await opendir(sourceDirectoryPath(directory), { bufferSize: 1 });
    for await (const { name } of children) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!isBundlePath(path)) throw new WorkspaceBackupBundleError('unsafe-path');
      if (++count > MAX_ENTRIES) throw new Error('Workspace backup tree is invalid.');
      const childPath = join(sourceDirectoryPath(directory), name);
      const stat = await lstat(childPath, { bigint: true });
      if (stat.dev !== device || stat.isSymbolicLink()) {
        throw new WorkspaceBackupBundleError('unsafe-path');
      }
      if (stat.isDirectory()) {
        const child = await openSourceDirectory(childPath, stat);
        try {
          directories.add(path);
          await walk(child, path);
        } finally {
          await child.close();
        }
      } else {
        if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_FILE_BYTES)) {
          throw new Error('Workspace backup contains an invalid file.');
        }
        bytes += stat.size;
        if (bytes > BigInt(MAX_TOTAL_BYTES))
          throw new Error('Workspace backup exceeds its byte limit.');
        files.set(path, stat);
      }
    }
  };
  await walk(root, '');
  return { files, directories };
}

/** Compares the opened object with the non-linked source selected before content reads. */
function sameSource(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    left.nlink === 1n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Reads once through owned no-follow parents, refusing file replacement, growth and mutation. */
async function readSource(
  root: FileHandle,
  path: string,
  expected: BigIntStats,
  consume: (chunk: Buffer) => Promise<void>
): Promise<void> {
  const owned: FileHandle[] = [];
  let directory = root;
  const parts = path.split('/');
  try {
    for (const part of parts.slice(0, -1)) {
      const parentPath = join(sourceDirectoryPath(directory), part);
      const stat = await lstat(parentPath, { bigint: true });
      if (stat.dev !== expected.dev) throw new Error('Workspace backup directory changed.');
      directory = await openSourceDirectory(parentPath, stat);
      owned.push(directory);
    }
    const file = await open(
      join(sourceDirectoryPath(directory), parts.at(-1)!),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    owned.push(file);
    if (!sameSource(await file.stat({ bigint: true }), expected)) {
      throw new Error('Workspace backup source changed.');
    }
    const size = Number(expected.size);
    let offset = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - offset + 1));
      const result = await file.read(buffer, 0, buffer.length, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
      if (offset > size) throw new Error('Workspace backup source grew.');
      await consume(buffer.subarray(0, result.bytesRead));
    }
    if (offset !== size || !sameSource(await file.stat({ bigint: true }), expected)) {
      throw new Error('Workspace backup source changed.');
    }
  } finally {
    await Promise.all(owned.map((file) => file.close()));
  }
}

/** Reads only a bounded selected metadata file; OS errors remain inside the verifier boundary. */
async function readMetadata(root: FileHandle, path: string, tree: SourceTree): Promise<Buffer> {
  const stat = tree.files.get(path);
  if (!stat || stat.size > BigInt(MAX_METADATA_BYTES))
    throw new Error('Workspace backup metadata is missing or too large.');
  const chunks: Buffer[] = [];
  await readSource(root, path, stat, async (chunk) => {
    chunks.push(chunk);
  });
  return Buffer.concat(chunks);
}

/** Checks the exact file/directory set and owner-required permissions before any copy is exposed. */
function assertInventoryTree(
  manifest: WorkspaceBackupManifest,
  tree: SourceTree,
  prepared = false
): void {
  const expectedFiles = new Set([
    ...[...METADATA_FILES].filter((path) => !prepared || path !== WORKSPACE_BACKUP_SEAL_FILE),
    ...manifest.inventory.map((entry) => entry.path),
  ]);
  if (
    tree.files.size !== expectedFiles.size ||
    [...tree.files.keys()].some((path) => !expectedFiles.has(path))
  ) {
    throw new Error('Workspace backup file inventory does not match.');
  }
  const expectedDirectories = new Set<string>();
  for (const entry of manifest.inventory) {
    const stat = tree.files.get(entry.path);
    if (
      !stat ||
      stat.size !== BigInt(entry.bytes) ||
      (stat.mode & 0o7777n) !== BigInt(entry.mode)
    ) {
      throw new Error('Workspace backup file facts do not match.');
    }
    const parts = entry.path.split('/');
    parts.pop();
    while (parts.length > 0) {
      expectedDirectories.add(parts.join('/'));
      parts.pop();
    }
  }
  if (
    tree.directories.size !== expectedDirectories.size ||
    [...tree.directories].some((path) => !expectedDirectories.has(path))
  ) {
    throw new Error('Workspace backup directory inventory does not match.');
  }
}

/** Copies and verifies one inventoried original; neither packaged content nor databases are executed. */
async function copyVerifiedFile(
  root: FileHandle,
  staging: string,
  entry: WorkspaceBackupInventoryEntry,
  stat: BigIntStats,
  reservation: FileStorageReservation
): Promise<void> {
  reservation.assertAvailable();
  const destination = join(staging, entry.path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const target = await open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  try {
    await readSource(root, entry.path, stat, async (chunk) => {
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const result = await target.write(chunk, written, chunk.length - written);
        if (result.bytesWritten === 0) throw new Error('Workspace backup copy made no progress.');
        written += result.bytesWritten;
        reservation.recordWritten(result.bytesWritten);
      }
    });
    if (`sha256:${hash.digest('hex')}` !== entry.sha256)
      throw new Error('Workspace backup file digest does not match.');
    await target.chmod(0o400);
  } finally {
    await target.close();
  }
}

/**
 * Verifies the structural bundle and supplies only private verified content copies.
 *
 * Raw metadata stays internal for exact digests. The callback cannot reopen source
 * paths through this API, and escaped readers refuse after cleanup. Capacity is
 * released only after owned staging is removed. These copies are temporary, not
 * durable capture protection or a database/reference-closure admission result.
 *
 * @param input Trusted release expectations, source root and existing capacity owner.
 * @param consume Callback that finishes its reads before returning.
 * @returns The callback's result, unchanged; callback errors also remain unchanged.
 */
export async function withVerifiedWorkspaceBackupBundle<T>(
  input: WorkspaceBackupVerificationInput,
  consume: (bundle: VerifiedWorkspaceBackupBundle) => Promise<T>
): Promise<T> {
  let staging: string | undefined;
  let reservation: FileStorageReservation | undefined;
  let active = false;
  let result!: T;
  let failed = false;
  let failure: unknown;
  try {
    let bundle: VerifiedWorkspaceBackupBundle;
    try {
      const root = await existingRoot(input.bundleRoot);
      const stagingParent = await existingRoot(input.stagingParent);
      const stagingRelative = relative(root, stagingParent);
      if (
        stagingRelative === '' ||
        (!stagingRelative.startsWith(`..${sep}`) &&
          stagingRelative !== '..' &&
          !isAbsolute(stagingRelative))
      ) {
        throw new Error('Workspace backup staging must be outside the source.');
      }
      const source = await openSourceDirectory(root, await lstat(root, { bigint: true }));
      try {
        if ((await realpath(sourceDirectoryPath(source))) !== root)
          throw new Error('Workspace backup root changed.');
        const tree = await inspectTree(source);
        const manifestBytes = await readMetadata(source, WORKSPACE_BACKUP_MANIFEST_FILE, tree);
        const prepared =
          input.allowPreparedMove === true && !tree.files.has(WORKSPACE_BACKUP_SEAL_FILE);
        const sealBytes = prepared
          ? Buffer.alloc(0)
          : await readMetadata(source, WORKSPACE_BACKUP_SEAL_FILE, tree);
        const manifestMetadata = decodeMetadata(manifestBytes);
        const sealMetadata = prepared ? null : decodeMetadata(sealBytes);
        const features = new Set(input.supportedRequiredFeatures ?? []);
        assertRequiredFeatures(manifestMetadata.value, features);
        if (sealMetadata) assertRequiredFeatures(sealMetadata.value, features);
        const manifest = parseWorkspaceBackupManifest(manifestMetadata.value);
        const seal = sealMetadata ? parseWorkspaceBackupSeal(sealMetadata.value) : null;
        if (prepared && manifest.purpose !== 'move') throw new Error('Only MOVE may be prepared.');
        const manifestDigest = digest(manifestBytes);
        if (
          seal !== null &&
          (seal.backupId !== manifest.backupId ||
            seal.purpose !== manifest.purpose ||
            seal.manifestDigest !== manifestDigest)
        ) {
          throw new Error('Workspace backup seal does not match.');
        }
        if (
          manifest.release.version !== input.expectedRelease.version ||
          manifest.release.buildId !== input.expectedRelease.buildId
        ) {
          throw new WorkspaceBackupBundleError('release-mismatch');
        }
        for (const database of manifest.databaseFormats) {
          for (const [marker, version] of Object.entries(database.markers)) {
            if (
              !Object.hasOwn(input.supportedDatabaseFormats, marker) ||
              input.supportedDatabaseFormats[marker] !== version
            ) {
              throw new WorkspaceBackupBundleError('unsupported-format');
            }
          }
        }
        if (
          workspaceBackupInventoryDigest(
            originalInventoryBytes(manifestBytes, manifestMetadata)
          ) !== manifest.inventoryDigest
        ) {
          throw new Error('Workspace backup inventory digest does not match.');
        }
        assertInventoryTree(manifest, tree, prepared);
        const totalBytes = manifest.inventory.reduce((sum, entry) => sum + entry.bytes, 0);
        if (totalBytes + manifestBytes.length + sealBytes.length > MAX_TOTAL_BYTES)
          throw new Error('Workspace backup exceeds its byte limit.');
        reservation = input.admission.reserve({
          stagingBytes: BigInt(totalBytes),
          extractionBytes: 0n,
          derivativeBytes: 0n,
          publicationBytes: 0n,
        });
        staging = await mkdtemp(join(stagingParent, 'workspace-backup-verify-'));
        for (const entry of manifest.inventory) {
          await copyVerifiedFile(source, staging, entry, tree.files.get(entry.path)!, reservation);
        }
        const verifiedRoot = staging;
        const paths = new Set(manifest.inventory.map((entry) => entry.path));
        /** Reads only the private copy; raw metadata and original source paths are not exposed. */
        const readFile = async function* (path: string): AsyncIterable<Uint8Array> {
          if (!active || !paths.has(path))
            throw new Error('Workspace backup verified content is unavailable.');
          const file = await open(
            join(verifiedRoot, path),
            constants.O_RDONLY | constants.O_NOFOLLOW
          );
          try {
            while (true) {
              if (!active) throw new Error('Workspace backup verified content is unavailable.');
              const bytes = Buffer.alloc(CHUNK_BYTES);
              const result = await file.read(bytes, 0, bytes.length, null);
              if (!active) throw new Error('Workspace backup verified content is unavailable.');
              if (result.bytesRead === 0) break;
              yield bytes.subarray(0, result.bytesRead);
            }
          } finally {
            await file.close();
          }
        };
        bundle = Object.freeze({
          verification: 'structural-only' as const,
          manifest,
          seal,
          manifestDigest,
          fileCount: manifest.inventory.length,
          totalBytes,
          readFile,
        });
      } finally {
        await source.close();
      }
    } catch (error) {
      // Only bounded categories cross this boundary, never paths or packaged content.
      if (error instanceof WorkspaceBackupBundleError) throw error;
      throw new WorkspaceBackupBundleError(
        error instanceof FileAdmissionError ? 'capacity-exceeded' : 'invalid-bundle'
      );
    }
    active = true;
    result = await consume(bundle);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    active = false;
    let removed = true;
    if (staging) {
      try {
        await rm(staging, { recursive: true, force: true });
      } catch {
        // Keep unused forecast reserved if cleanup cannot prove removal. Preserve
        // an earlier callback failure as well as the cleanup failure.
        removed = false;
        const cleanupError = new Error('Workspace backup verification staging cleanup failed.');
        failure = failed
          ? new AggregateError([failure, cleanupError], cleanupError.message)
          : cleanupError;
        failed = true;
      }
    }
    if (removed) reservation?.release();
  }
  if (failed) throw failure;
  return result;
}
