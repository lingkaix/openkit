import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from 'node:constants';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Maximum accepted bytes before the first complete Pi session header newline. */
const PI_SESSION_HEADER_MAX_BYTES = 64 * 1024;

/** Maximum accepted bytes of one encoded restricted session handle. */
export const PI_SESSION_HANDLE_MAX_BYTES = 16 * 1024;

/**
 * The restricted handle of one exact Pi conversation: its session file and the header identity
 * proved from that file. The Harness stores the encoded bytes under the AgentSession id, and the
 * SHA-256 of exactly those bytes is the binding's native handle digest.
 */
export interface PiSessionHandle {
  /** Working directory recorded in the session header. */
  readonly cwd: string;
  /** Absolute session file path, a strict child of the admitted state root. */
  readonly path: string;
  /** Session id recorded in the session header. */
  readonly sessionId: string;
}

/** Failure of an exact identity proof; the message never carries file content. */
export class PiSessionIdentityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PiSessionIdentityError';
  }
}

/**
 * Encodes a handle as its canonical bytes, with keys in a fixed order.
 *
 * @param handle Proved handle.
 * @returns Canonical JSON text of the handle.
 */
export function encodePiSessionHandle(handle: PiSessionHandle): string {
  return JSON.stringify({ cwd: handle.cwd, path: handle.path, sessionId: handle.sessionId });
}

/**
 * Returns the native handle digest of one encoded handle.
 *
 * @param encoded Canonical handle text from {@link encodePiSessionHandle}.
 * @returns Lowercase hexadecimal SHA-256 of the UTF-8 bytes.
 */
export function digestPiSessionHandle(encoded: string): string {
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

/**
 * Parses a retained handle without trusting any field it does not name.
 *
 * @param encoded Handle text the Harness read from retained storage.
 * @param stateRoot Admitted retained state root.
 * @returns The parsed handle.
 * @throws PiSessionIdentityError when the text is not exactly a canonical handle under the root.
 */
export function parsePiSessionHandle(encoded: string, stateRoot: string): PiSessionHandle {
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new PiSessionIdentityError('Pi session handle is malformed.');
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'cwd,path,sessionId' ||
    typeof value.cwd !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.trim().length === 0
  ) {
    throw new PiSessionIdentityError('Pi session handle is malformed.');
  }
  const handle = { cwd: value.cwd, path: value.path, sessionId: value.sessionId };
  if (encodePiSessionHandle(handle) !== encoded) {
    throw new PiSessionIdentityError('Pi session handle is not canonical.');
  }
  requirePiSessionPath(stateRoot, handle.path);
  return handle;
}

/**
 * Allocates a fresh session file path that no earlier binding used.
 *
 * @param stateRoot Admitted retained state root.
 * @returns Absent session file path inside a new directory under `<stateRoot>/sessions`.
 */
export async function allocatePiSessionPath(stateRoot: string): Promise<string> {
  const root = resolve(stateRoot);
  await requirePiDirectory(root);
  const sessionsRoot = join(root, 'sessions');
  try {
    await mkdir(sessionsRoot, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
  }
  await requirePiDirectory(sessionsRoot);
  const bindingRoot = await mkdtemp(join(sessionsRoot, 'binding-'));
  const path = join(bindingRoot, 'session.jsonl');
  await requireAbsentPiSession(root, path);
  return path;
}

/**
 * Requires a session path that is still absent, without following symbolic links.
 *
 * @param stateRoot Admitted retained state root.
 * @param path Candidate session file path.
 * @throws PiSessionIdentityError when the path exists or leaves the root.
 */
export async function requireAbsentPiSession(stateRoot: string, path: string): Promise<void> {
  await requirePiSessionAncestors(stateRoot, path);
  try {
    const handle = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    await handle.close();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw new PiSessionIdentityError('Pi pending session path must remain absent.');
  }
  throw new PiSessionIdentityError('Pi pending session path must remain absent.');
}

/**
 * Proves the exact nonempty session header without reading the retained history.
 *
 * @param stateRoot Admitted retained state root.
 * @param path Session file path.
 * @param expectedCwd Admitted working directory the header must record.
 * @param expectedSessionId Session id the header must record, when one is already bound.
 * @returns The proved handle.
 * @throws PiSessionIdentityError when the file is missing, empty, a symbolic link, malformed, or
 *   records another id or working directory.
 */
export async function provePiSessionHeader(
  stateRoot: string,
  path: string,
  expectedCwd: string,
  expectedSessionId?: string
): Promise<PiSessionHandle> {
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    await requirePiSessionAncestors(stateRoot, path);
    file = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stats = await file.stat();
    if (!stats.isFile() || stats.size <= 0) throw new Error('not a nonempty file');
    const bytes = Buffer.alloc(Math.min(stats.size, PI_SESSION_HEADER_MAX_BYTES + 1));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const newline = bytes.subarray(0, bytesRead).indexOf(10);
    if (newline < 0 || newline > PI_SESSION_HEADER_MAX_BYTES) throw new Error('header bound');
    const header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, newline))
    ) as unknown;
    if (
      !isRecord(header) ||
      header.type !== 'session' ||
      typeof header.id !== 'string' ||
      header.id.trim().length === 0 ||
      header.cwd !== expectedCwd ||
      (expectedSessionId !== undefined && header.id !== expectedSessionId)
    ) {
      throw new Error('header identity');
    }
    return { cwd: expectedCwd, path, sessionId: header.id };
  } catch {
    throw new PiSessionIdentityError('Pi session header proof failed.');
  } finally {
    await file?.close().catch(() => undefined);
  }
}

/**
 * Requires a session path to be an absolute, normalized, strict child of the state root.
 *
 * @param stateRoot Admitted retained state root.
 * @param path Candidate session file path.
 * @returns The same path.
 * @throws PiSessionIdentityError when the path is relative, unnormalized, or outside the root.
 */
export function requirePiSessionPath(stateRoot: string, path: string): string {
  const root = resolve(stateRoot);
  const selected = resolve(path);
  const child = relative(root, selected);
  if (
    !isAbsolute(path) ||
    selected !== path ||
    !child ||
    child.startsWith('..') ||
    isAbsolute(child)
  ) {
    throw new PiSessionIdentityError('Pi session path is outside its retained state root.');
  }
  return selected;
}

/** Rejects symbolic-link or non-directory ancestors beneath the admitted state root. */
async function requirePiSessionAncestors(stateRoot: string, path: string): Promise<void> {
  const root = resolve(stateRoot);
  const selected = requirePiSessionPath(root, path);
  await requirePiDirectory(root);
  const child = relative(root, dirname(selected));
  let current = root;
  if (!child) return;
  for (const segment of child.split(sep)) {
    current = join(current, segment);
    await requirePiDirectory(current);
  }
}

/** Requires one path component to be a real directory. */
async function requirePiDirectory(path: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch {
    throw new PiSessionIdentityError('Pi session path ancestor is missing or invalid.');
  }
  if (!stats.isDirectory()) {
    throw new PiSessionIdentityError('Pi session path ancestor is missing or invalid.');
  }
}

/** Checks a Node filesystem error without widening unknown exceptions. */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** Checks whether one JSON value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
