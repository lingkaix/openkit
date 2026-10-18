import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createKnowledgePackageManifest,
  isKnowledgePackagePath,
  type KnowledgePackageInventoryEntry,
  type KnowledgePackageManifest,
  type KnowledgePackageMetadata,
  MAX_KNOWLEDGE_PACKAGE_MANIFEST_BYTES,
  parseKnowledgePackageManifest,
  serializeKnowledgePackageManifest,
} from './manifest.js';

/** Caller admission limits include manifest bytes and all physical entries except the root. */
export interface KnowledgePackageLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

/** An admitted source file; its private native path never enters the package manifest. */
export interface KnowledgePackageFile extends KnowledgePackageInventoryEntry {
  readonly sourcePath: string;
}

const chunkBytes = 64 * 1024;

function validateLimits(limits: KnowledgePackageLimits): void {
  if (
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries < 1 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1
  )
    throw new Error('Knowledge package limits must be positive safe integers.');
}

function checkUsage(entries: number, bytes: number, limits: KnowledgePackageLimits): void {
  if (!Number.isSafeInteger(bytes) || entries > limits.maxEntries || bytes > limits.maxBytes)
    throw new Error('Knowledge package resource limit exceeded.');
}

/** Hashes stable regular bytes in bounded chunks, optionally copying into a fresh output file. */
async function verifyFile(
  path: string,
  expected: KnowledgePackageInventoryEntry,
  output?: string
): Promise<void> {
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(expected.byteLength))
      throw new Error('Knowledge package member is not the declared regular file.');
    if (output)
      destination = await open(
        output,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      );
    const buffer = Buffer.alloc(chunkBytes);
    const hash = createHash('sha256');
    let total = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expected.byteLength)
        throw new Error('Knowledge package member changed during capture.');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (destination) {
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(chunk, written, bytesRead - written, null);
          if (result.bytesWritten === 0)
            throw new Error('Knowledge package output write made no progress.');
          written += result.bytesWritten;
        }
      }
    }
    const after = await source.stat({ bigint: true });
    if (
      total !== expected.byteLength ||
      `sha256:${hash.digest('hex')}` !== expected.contentDigest ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n
    )
      throw new Error('Knowledge package member bytes do not match their captured identity.');
  } finally {
    try {
      await destination?.close();
    } finally {
      await source.close();
    }
  }
}

/** Reads only the separately bounded manifest; large included files never enter a whole-file buffer. */
async function readManifest(
  directory: string,
  limits: KnowledgePackageLimits
): Promise<KnowledgePackageManifest> {
  const file = await open(
    join(directory, 'manifest.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_KNOWLEDGE_PACKAGE_MANIFEST_BYTES)
    )
      throw new Error('Knowledge package manifest must be a bounded regular file.');
    checkUsage(1, Number(before.size), limits);
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      BigInt(length) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('Knowledge package manifest changed during validation.');
    const text = buffer.subarray(0, length).toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buffer.subarray(0, length)))
      throw new Error('Knowledge package manifest is not UTF-8.');
    return parseKnowledgePackageManifest(JSON.parse(text));
  } finally {
    await file.close();
  }
}

/** Checks format integrity in a private, immutable staging tree; this grants no Source or publication authority. */
export async function verifyKnowledgePackageFormat(input: {
  readonly directory: string;
  readonly limits: KnowledgePackageLimits;
}): Promise<KnowledgePackageManifest> {
  const { directory, limits } = input;
  validateLimits(limits);
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error('Knowledge package root must be a directory.');
  const manifest = await readManifest(directory, limits);
  const expected = new Map(manifest.contentInventory.map((file) => [file.path, file]));
  const reserved = new Set(
    manifest.mounts.filter((mount) => !mount.default).map((mount) => `raw/${mount.name}`)
  );
  let entries = 0;
  let bytes = 0;
  const pending = [''];
  const found = new Set<string>();
  while (pending.length > 0) {
    const parent = pending.pop()!;
    const children = await opendir(join(directory, parent));
    for await (const { name } of children) {
      checkUsage(entries + 1, bytes, limits);
      const relative = parent ? `${parent}/${name}` : name;
      const stat = await lstat(join(directory, relative));
      entries += 1;
      if (stat.isDirectory()) {
        if (!isKnowledgePackagePath(`${relative}/member.md`) || reserved.has(relative))
          throw new Error('Knowledge package directory is outside its declared layout.');
        pending.push(relative);
      } else {
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error('Knowledge package links and special files are refused.');
        bytes += stat.size;
        if (relative !== 'manifest.json') {
          const member = expected.get(relative);
          if (!member) throw new Error('Knowledge package contains an undeclared file.');
          if (stat.size !== member.byteLength)
            throw new Error('Knowledge package member length does not match.');
          found.add(relative);
        }
      }
      checkUsage(entries, bytes, limits);
    }
  }
  if (found.size !== expected.size)
    throw new Error('Knowledge package is missing an inventoried file.');
  for (const file of manifest.contentInventory) await verifyFile(join(directory, file.path), file);
  return manifest;
}

/** Captures already-admitted native files into a fresh private directory without rewriting their bytes. */
export async function writeKnowledgePackageFormat(input: {
  readonly directory: string;
  readonly metadata: KnowledgePackageMetadata;
  readonly files: readonly KnowledgePackageFile[];
  readonly limits: KnowledgePackageLimits;
}): Promise<KnowledgePackageManifest> {
  const { directory, metadata, files, limits } = input;
  validateLimits(limits);
  const manifest = createKnowledgePackageManifest(metadata, files);
  const text = serializeKnowledgePackageManifest(manifest);
  const manifestBytes = Buffer.byteLength(text);
  if (manifestBytes > MAX_KNOWLEDGE_PACKAGE_MANIFEST_BYTES)
    throw new Error('Knowledge package manifest is too large.');
  const parents = new Set<string>();
  for (const file of manifest.contentInventory) {
    let parent = dirname(file.path);
    while (parent !== '.') {
      parents.add(parent);
      parent = dirname(parent);
    }
  }
  checkUsage(
    1 + files.length + parents.size,
    manifest.contentInventory.reduce((total, file) => total + file.byteLength, manifestBytes),
    limits
  );
  // Creation is exclusive. Cleanup below can remove only this call's new private staging tree.
  await mkdir(directory, { mode: 0o700 });
  try {
    for (const parent of [...parents].sort())
      await mkdir(join(directory, parent), { recursive: true, mode: 0o700 });
    const sources = new Map(files.map((file) => [file.path, file.sourcePath]));
    for (const file of manifest.contentInventory)
      await verifyFile(sources.get(file.path)!, file, join(directory, file.path));
    const output = await open(
      join(directory, 'manifest.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
    try {
      await output.writeFile(text, 'utf8');
    } finally {
      await output.close();
    }
    await verifyKnowledgePackageFormat({ directory, limits });
    return manifest;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
