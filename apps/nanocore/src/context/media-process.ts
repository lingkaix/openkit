import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** An authorized immutable source. Emit at most 64KiB per chunk and honor cancellation. */
export interface MediaByteSource {
  sourceKey: string;
  revision: string;
  originalDigest: string;
  byteLength: number;
  open(signal: AbortSignal): AsyncIterable<Uint8Array>;
}
/** Digest of the observed processor versions and actual enforced invocation/resource configuration; it is not binary or image attestation. */
export interface MediaResourceProfile {
  resourceProfileDigest: string;
}
/** Existing shared disk-owner reservation; completed writes become occupied filesystem bytes. */
export interface MediaStageReservation {
  recordWritten(bytes: bigint): void;
  release(): void;
}
/** Hard OS bounds. Address space is per process; Bubblewrap has fixed supervisor overhead. */
export interface MediaProcessLimits {
  addressSpaceBytes: number;
  cpuSeconds: number;
  wallTimeMs: number;
}
/** Fixed release-authored native programs, never a user-selected executable. */
export type MediaExecutable =
  | '/usr/bin/pdfinfo'
  | '/usr/bin/pdftotext'
  | '/usr/bin/timeout'
  | '/usr/bin/identify'
  | '/usr/bin/convert'
  | '/usr/bin/pdftoppm';
/** Closed infrastructure failures, without peer text, host paths or source bodies. */
export class MediaProcessFailure extends Error {
  constructor(
    readonly reason:
      | 'dependency-unavailable'
      | 'source-unavailable'
      | 'source-changed'
      | 'resource-limited'
      | 'cleanup-unavailable'
  ) {
    super(reason);
  }
}
const INFO_BYTES = 16_384;

/** Proves fork refusal under the actual runtime identity before admitting source bytes. */
export async function assertMediaIsolation(
  limits: MediaProcessLimits,
  signal: AbortSignal,
  environment: Readonly<Record<string, string>> = {}
): Promise<void> {
  const proof = await runMediaProcess(
    '/usr/bin/timeout',
    ['1', '/usr/bin/true'],
    limits,
    signal,
    undefined,
    4096,
    environment
  );
  if (
    proof.code !== 125 ||
    proof.stdout.length !== 0 ||
    proof.stderr.toString('utf8') !==
      'timeout: fork system call failed: Resource temporarily unavailable\n'
  )
    throw new MediaProcessFailure('dependency-unavailable');
}

/** Owns private staging and proved cleanup through the source owner's existing shared reservation. */
export async function withStagedMediaSource<T>(
  source: MediaByteSource,
  temporaryRoot: string,
  reserveTemporaryBytes: (bytes: number) => MediaStageReservation,
  signal: AbortSignal,
  prefix: string,
  consume: (path: string) => Promise<T>
): Promise<T> {
  let reservation: MediaStageReservation;
  try {
    reservation = reserveTemporaryBytes(source.byteLength);
  } catch {
    throw new MediaProcessFailure('resource-limited');
  }
  let directory: string | undefined;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    directory = await mkdtemp(join(temporaryRoot, prefix));
    await chmod(directory, 0o700);
    const path = join(directory, 'input.pdf');
    await stageSource(source, path, signal, (bytes) => reservation.recordWritten(bytes));
    outcome = { ok: true, value: await consume(path) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  // Cleanup uncertainty retains capacity and cannot expose a partially accepted representation.
  try {
    if (directory) await rm(directory, { recursive: true, force: true });
    reservation.release();
  } catch {
    throw new MediaProcessFailure('cleanup-unavailable');
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Copies bounded chunks into a new private file and verifies the exact canonical digest. */
async function stageSource(
  source: MediaByteSource,
  path: string,
  signal: AbortSignal,
  recordWritten: (bytes: bigint) => void
): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  const hash = createHash('sha256');
  let observed = 0;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  try {
    iterator = source.open(signal)[Symbol.asyncIterator]();
    while (true) {
      const next = await withCancellation(iterator.next(), signal);
      if (next.done) break;
      if (
        !(next.value instanceof Uint8Array) ||
        next.value.byteLength > source.byteLength - observed
      )
        throw new MediaProcessFailure('source-changed');
      if (next.value.byteLength === 0 || next.value.byteLength > 65_536)
        throw new MediaProcessFailure('source-unavailable');
      signal.throwIfAborted();
      // Own this bounded view while asynchronous I/O runs; the producer cannot mutate the digest proof.
      const chunk = Buffer.from(next.value);
      await file.writeFile(chunk);
      recordWritten(BigInt(chunk.byteLength));
      hash.update(chunk);
      observed += chunk.byteLength;
    }
    if (observed !== source.byteLength || `sha256:${hash.digest('hex')}` !== source.originalDigest)
      throw new MediaProcessFailure('source-changed');
  } finally {
    await file.close();
    // A source owner must honor the signal; its uncooperative iterator cannot delay cleanup.
    void iterator?.return?.().catch(() => {});
  }
  await chmod(path, 0o400);
}

/** Fixed executable, namespace and sanitized environment; neither path nor media bytes select code. */
export function runMediaProcess(
  executable: MediaExecutable,
  args: string[],
  limits: MediaProcessLimits,
  signal: AbortSignal,
  sourcePath: string | undefined,
  outputLimit: number,
  environment: Readonly<Record<string, string>> = {}
): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new MediaProcessFailure('resource-limited'));
      return;
    }
    const invocation = mediaProcessInvocation(executable, args, limits, sourcePath, environment);
    const command = spawn(invocation.command, invocation.arguments, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: invocation.environment,
      cwd: '/',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let failure: MediaProcessFailure | undefined;
    const stop = (reason: MediaProcessFailure['reason']) => {
      failure ??= new MediaProcessFailure(reason);
      if (command.pid) {
        try {
          process.kill(-command.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    };
    const abort = () => stop('resource-limited');
    signal.addEventListener('abort', abort, { once: true });
    command.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) stop('resource-limited');
      else stdout.push(chunk);
    });
    command.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > INFO_BYTES) stop('resource-limited');
      else stderr.push(chunk);
    });
    command.on('error', () => {
      failure ??= new MediaProcessFailure('dependency-unavailable');
    });
    command.on('close', (code, terminationSignal) => {
      signal.removeEventListener('abort', abort);
      if (failure) {
        reject(failure);
        return;
      }
      // Bubblewrap relays a signalled sandbox child's exit as 128+signal instead of signalling itself.
      if (terminationSignal || code === 137 || code === 152) {
        reject(new MediaProcessFailure('resource-limited'));
        return;
      }
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    if (signal.aborted) abort();
  });
}

/** Returns the exact fixed launch configuration used both for execution and processor-profile identity. Private source paths are normalized by the processor before hashing. */
export function mediaProcessInvocation(
  executable: MediaExecutable,
  args: string[],
  limits: MediaProcessLimits,
  sourcePath: string | undefined,
  environment: Readonly<Record<string, string>> = {}
): { command: string; arguments: string[]; environment: Record<string, string> } {
  return {
    command: '/usr/bin/prlimit',
    arguments: [
      `--as=${limits.addressSpaceBytes}`,
      `--cpu=${limits.cpuSeconds}`,
      '--core=0',
      '--fsize=0',
      '--nofile=64',
      '--',
      '/usr/bin/bwrap',
      '--unshare-all',
      '--uid',
      '65534',
      '--gid',
      '65534',
      '--die-with-parent',
      '--new-session',
      '--cap-drop',
      'ALL',
      '--clearenv',
      '--setenv',
      'LC_ALL',
      'C',
      '--setenv',
      'HOME',
      '/nonexistent',
      ...Object.entries(environment).flatMap(([key, value]) => ['--setenv', key, value]),
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind-try',
      '/lib',
      '/lib',
      '--ro-bind-try',
      '/lib64',
      '/lib64',
      '--ro-bind-try',
      '/etc/fonts',
      '/etc/fonts',
      // ImageMagick's installed read-only coder/color policy belongs to the selected utility, not the source file.
      ...(executable === '/usr/bin/identify' || executable === '/usr/bin/convert'
        ? [
            '--ro-bind-try',
            '/etc/ImageMagick-6',
            '/etc/ImageMagick-6',
            '--ro-bind-try',
            '/etc/ImageMagick-7',
            '/etc/ImageMagick-7',
          ]
        : []),
      // Poppler reads installed font caches without giving the processor a writable cache or home.
      ...(executable === '/usr/bin/pdftoppm'
        ? ['--ro-bind-try', '/var/cache/fontconfig', '/var/cache/fontconfig']
        : []),
      ...(sourcePath ? ['--ro-bind', sourcePath, '/input.pdf'] : []),
      '--remount-ro',
      '/',
      '--',
      '/usr/bin/prlimit',
      '--nproc=0',
      '--',
      executable,
      ...args,
    ],
    environment: { LC_ALL: 'C' },
  };
}

/** Releases an abort listener on both completion and cancellation without waiting on a source. */
function withCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
    if (signal.aborted) abort();
  });
}

/** Validates immutable source metadata before any native processing or private staging. */
export function validMediaSource(source: MediaByteSource): boolean {
  return (
    typeof source.sourceKey === 'string' &&
    source.sourceKey.length > 0 &&
    source.sourceKey.length <= 1024 &&
    typeof source.revision === 'string' &&
    source.revision.length > 0 &&
    source.revision.length <= 256 &&
    /^sha256:[0-9a-f]{64}$/.test(source.originalDigest) &&
    Number.isSafeInteger(source.byteLength) &&
    source.byteLength >= 0 &&
    source.byteLength <= 1_000_000_000 &&
    typeof source.open === 'function'
  );
}
