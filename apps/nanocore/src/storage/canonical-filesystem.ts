import { constants } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { dirname } from 'node:path';

/** Synchronizes one directory without blocking asynchronous file collection or following a link. */
export async function syncCanonicalDirectoryAsync(path: string): Promise<void> {
  const descriptor = await fsPromises.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await descriptor.stat()).isDirectory())
      throw new Error(`Canonical path must be a directory: ${path}.`);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

/** Creates missing asynchronous publication parents and commits their entries before use. */
export async function ensureCanonicalDirectoryAsync(path: string): Promise<void> {
  const metadata = await fsPromises.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadata) {
    // Commit each parent before creating children so a failed retry has one entry to verify.
    await ensureCanonicalDirectoryAsync(dirname(path));
    try {
      await fsPromises.mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const current = metadata ?? (await fsPromises.lstat(path));
  if (!current.isDirectory() || current.isSymbolicLink())
    throw new Error(`Canonical path must be a directory: ${path}.`);
  await syncCanonicalDirectoryAsync(dirname(path));
}
