import { createRequire } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import {
  createPrivateTreeSync,
  directoryContainsFiles,
  ensureCanonicalDirectory,
  materializePrivateTreeSync,
  publishCanonicalPath,
  removePrivateTreeSync,
} from '@openkit/storage';
import { extract } from 'tar-stream';
import { assertArtifactBytes, type LocalArtifact } from './catalog.js';
import { localAiRoot } from './store.js';

const require = createRequire(import.meta.url);
const bunzip = require('seek-bzip') as {
  decode(input: Buffer, output?: number | Buffer, multistream?: boolean): Buffer;
};

/** Reports bytes of one artifact while they are still untrusted. */
export type DownloadProgress = (received: number, total: number) => void;

/**
 * Downloads one pinned artifact when its published directory is empty.
 * A published directory is reused without hashing it again.
 */
export async function ensureArtifact(
  dataRoot: string,
  artifact: LocalArtifact,
  fetchImpl: typeof fetch = fetch,
  onProgress?: DownloadProgress,
  signal?: AbortSignal
): Promise<void> {
  const root = localAiRoot(dataRoot);
  const destination = join(root, artifact.publishPath);
  if (directoryContainsFiles(destination)) return;
  ensureCanonicalDirectory(root);
  ensureCanonicalDirectory(join(root, 'staging'));
  const body = await readVerifiedBody(artifact, fetchImpl, onProgress, signal);
  if (artifact.archive === 'file') {
    const fileName = artifact.fileName;
    if (!fileName) throw new Error('File artifact has no name.');
    const extracted = createPrivateTreeSync(join(root, 'staging'), 'artifact-');
    try {
      materializePrivateTreeSync(extracted, [{ kind: 1, path: fileName, content: body }]);
      ensureCanonicalDirectory(join(destination, '..'));
      publishCanonicalPath(extracted, destination);
    } catch (error) {
      removePrivateTreeSync(extracted);
      throw error;
    }
    return;
  }
  const tar = artifact.archive === 'tar.gz' ? gunzipSync(body) : bunzip.decode(body);
  const entries = await readTarEntries(tar);
  const extracted = createPrivateTreeSync(join(root, 'staging'), 'artifact-');
  try {
    materializePrivateTreeSync(extracted, entries);
    ensureCanonicalDirectory(join(destination, '..'));
    publishCanonicalPath(extracted, destination);
  } catch (error) {
    removePrivateTreeSync(extracted);
    throw error;
  }
}

/** Reads the body and refuses a length or digest mismatch before any file is written. */
async function readVerifiedBody(
  artifact: LocalArtifact,
  fetchImpl: typeof fetch,
  onProgress?: DownloadProgress,
  signal?: AbortSignal
): Promise<Buffer> {
  throwIfDownloadAborted(signal);
  const response = await fetchImpl(artifact.url, signal ? { signal } : undefined);
  throwIfDownloadAborted(signal);
  if (!response.ok || !response.body) {
    throw new Error(`Artifact download failed with status ${response.status}.`);
  }
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      throwIfDownloadAborted(signal);
      const next = await reader.read().catch((error: unknown) => {
        throwIfDownloadAborted(signal);
        throw error;
      });
      if (next.done) break;
      received += next.value.byteLength;
      if (received > artifact.bytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Artifact length exceeds ${artifact.bytes}.`);
      }
      chunks.push(next.value);
      onProgress?.(received, artifact.bytes);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  throwIfDownloadAborted(signal);
  const body = Buffer.concat(chunks);
  assertArtifactBytes(artifact, body);
  return body;
}

/** Stops a download before any verified bytes are published. */
function throwIfDownloadAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Artifact download was cancelled.');
}

/** Flattens one archive. A single leading `package` directory is the npm layout and is removed. */
async function readTarEntries(
  tar: Buffer
): Promise<Array<{ readonly content?: Buffer; readonly kind: 0 | 1 | 2; readonly path: string }>> {
  const raw: Array<{ path: string; content?: Buffer; directory: boolean; symlink?: string }> = [];
  await new Promise<void>((resolve, reject) => {
    const parser = extract();
    parser.on(
      'entry',
      (header: { name: string; linkname?: string; type?: string | null }, stream, next) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: unknown) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        });
        stream.on('end', () => {
          const safe = safeTarPath(header.name);
          if (safe && header.type === 'symlink' && safeSymlinkTarget(header.linkname)) {
            raw.push({ path: safe, directory: false, symlink: header.linkname });
          } else if (safe && header.type !== 'symlink') {
            raw.push({
              path: safe,
              directory: header.type === 'directory',
              ...(header.type === 'directory' ? {} : { content: Buffer.concat(chunks) }),
            });
          }
          next();
        });
        stream.on('error', reject);
        stream.resume();
      }
    );
    parser.on('finish', () => resolve());
    parser.on('error', reject);
    Readable.from(tar).pipe(parser);
  });
  const prefix = sharedPrefix(raw.map((entry) => entry.path));
  const stripped = raw.map((entry) => ({
    ...entry,
    path: prefix ? entry.path.slice(prefix.length) : entry.path,
  }));
  const files = new Map<string, Buffer>();
  const links = new Map<string, string>();
  for (const entry of stripped) {
    if (!entry.path) continue;
    if (entry.symlink) links.set(entry.path, entry.symlink);
    else if (!entry.directory) files.set(entry.path, entry.content ?? Buffer.alloc(0));
  }
  const resolveLink = (path: string, seen: Set<string>): Buffer | undefined => {
    const file = files.get(path);
    if (file) return file;
    const link = links.get(path);
    if (!link || seen.has(path)) return undefined;
    const target = safeLinkPath(path, link);
    if (!target) return undefined;
    seen.add(path);
    return resolveLink(target, seen);
  };
  for (const path of links.keys()) {
    if (files.has(path)) continue;
    const content = resolveLink(path, new Set());
    if (content) files.set(path, content);
  }
  return [...files.entries()].map(([path, content]) => ({
    // kind 2 is the existing materializer's executable file. llama-server is the only member that must be exec'd.
    kind: (path === 'llama-server' || path.endsWith('/llama-server') ? 2 : 1) as 1 | 2,
    path,
    content,
  }));
}

/** Accepts an in-archive relative symlink target. */
function safeSymlinkTarget(target: string | undefined): target is string {
  return !!target && !target.startsWith('/') && !target.split('/').includes('..');
}

/** Resolves one relative symlink against its directory and refuses a path that leaves the archive. */
function safeLinkPath(path: string, target: string): string | null {
  const resolved = normalize(join(dirname(path), target));
  if (resolved.startsWith('..') || resolved.startsWith('/')) return null;
  return resolved;
}

/** Rejects paths that would escape the staging directory. */
function safeTarPath(name: string): string | null {
  const parts = name.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

/** Returns `name/` when every entry lives under one directory, including npm's `package`. */
function sharedPrefix(paths: readonly string[]): string {
  const first = paths[0]?.split('/')[0];
  if (!first) return '';
  if (paths.every((path) => path === first || path.startsWith(`${first}/`))) return `${first}/`;
  return '';
}
