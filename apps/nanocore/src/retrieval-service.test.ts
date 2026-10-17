// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type RetrievalDocument,
  type RetrievalScope,
  RetrievalService,
} from './retrieval-service.js';

const TEST_TIMEOUT_MS = 30_000;
const RPC_TIMEOUT_MS = 250;
const POLL_INTERVAL_MS = 5;
const PROCESS_OBSERVATION_MS = 5_000;
const LARGE_SOURCE_BYTES = 32 * 1024 * 1024;
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIR, '../../..');
const KERNEL_EXECUTABLE = resolveKernelExecutable();

const testRoots: string[] = [];
const services: RetrievalService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const root of testRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('NanoCore retrieval service supervision', () => {
  it(
    'returns only generic exact digest-window positions and refuses incomplete byte or match coverage',
    async () => {
      const fixture = createFixture(),
        service = createService(fixture, 10_000);
      const bytes = Buffer.from('binary\0needle\0needle');
      writeFileSync(join(fixture.sourcesRoot, 'source'), bytes);
      const request = {
        path: 'source',
        source_bytes: bytes.length,
        start: 0,
        end: bytes.length,
        patterns: [
          {
            window_bytes: 6,
            encoding: 'bytes' as const,
            digests: [createHash('sha256').update('needle').digest('hex')],
          },
        ],
        bounds: { max_bytes: bytes.length, max_matches: 2, timeout_ms: 1000 },
      };
      expect(await service.digestWindows(request)).toEqual({
        start: 0,
        end: bytes.length,
        bytes: bytes.length,
        range_digest: createHash('sha256').update(bytes).digest('hex'),
        matches: [
          { start: 7, end: 13 },
          { start: 14, end: 20 },
        ],
      });
      await expect(
        service.digestWindows({ ...request, bounds: { ...request.bounds, max_matches: 1 } })
      ).rejects.toMatchObject({ code: 'resource-limited', uncertain: false });
      await expect(
        service.digestWindows({ ...request, bounds: { ...request.bounds, max_bytes: 1 } })
      ).rejects.toMatchObject({ code: 'resource-limited', uncertain: false });
      await expect(service.digestWindows({ ...request, path: '../source' })).rejects.toMatchObject({
        code: 'invalid-request',
        uncertain: false,
      });
      await expect(service.health()).resolves.toBeUndefined();
    },
    TEST_TIMEOUT_MS
  );
  it(
    'cancels an active generic scan and starts a fresh healthy child for the next operation',
    async () => {
      const fixture = createFixture(),
        service = createService(fixture, 10_000);
      const bytes = Buffer.alloc(1024 * 1024, 65);
      writeFileSync(join(fixture.sourcesRoot, 'source'), bytes);
      await service.start();
      const controller = new AbortController();
      const scan = service.digestWindows(
        {
          path: 'source',
          source_bytes: bytes.length,
          start: 0,
          end: bytes.length,
          patterns: [{ window_bytes: 43, encoding: 'bytes', digests: ['0'.repeat(64)] }],
          bounds: { max_bytes: bytes.length, max_matches: 1, timeout_ms: 10000 },
        },
        controller.signal
      );
      const timer = setTimeout(() => controller.abort(), 20);
      try {
        await expect(scan).rejects.toMatchObject({ uncertain: false });
      } finally {
        clearTimeout(timer);
      }
      await expect(service.health()).resolves.toBeUndefined();
    },
    TEST_TIMEOUT_MS
  );
  it(
    'starts a healthy service, restarts a failed child with no retained scope grant, and shuts it down',
    async () => {
      const fixture = createFixture();
      const service = createService(fixture, 2_000);

      await service.start();
      await service.health();
      const firstPid = await waitForKernelPid(fixture);

      const view = createInlineView('private', 'private-marker');
      await expect(service.publish(view, null)).resolves.toHaveLength(64);
      await expect(
        service.search({ mode: 'exact', query: 'private-marker', scopes: [view], limit: 20 })
      ).resolves.toMatchObject({
        complete: true,
        hits: [{ scope: 'private' }],
      });

      signalKernel(firstPid, fixture, 'SIGKILL');

      const revoked = await service.search({
        mode: 'exact',
        query: 'private-marker',
        scopes: [],
        limit: 20,
      });
      const restartedPid = await waitForKernelPid(fixture);
      expect(restartedPid).not.toBe(firstPid);
      expect(revoked).toMatchObject({
        complete: true,
        generations: {},
        hits: [],
        coverage: { admitted_objects: 0 },
      });

      await service.close();
      await expect(waitForKernelExit(restartedPid)).resolves.toBeUndefined();
      await expect(service.health()).rejects.toMatchObject({
        code: 'unavailable',
        uncertain: false,
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    'does not replay a publish whose acknowledgement was lost',
    async () => {
      const fixture = createFixture();
      const service = createService(fixture, 10_000);
      const document = createLargeFileDocument(fixture.sourcesRoot, 'large-source');
      const view = { scope: 'uncertain', documents: [document] };

      try {
        await service.start();
        const pid = await waitForKernelPid(fixture);
        const pending = service.publish(view, null);
        const scopeDirectory = join(
          fixture.storeRoot,
          createHash('sha256').update(view.scope).digest('hex')
        );

        await waitFor(
          () =>
            readdirSync(scopeDirectory, { withFileTypes: true }).some(
              (entry) => entry.isDirectory() && entry.name === `.stage-${pid}`
            ),
          'kernel publication staging directory'
        );
        signalKernel(pid, fixture, 'SIGSTOP');
        expect(existsSync(join(scopeDirectory, 'CURRENT'))).toBe(false);
        signalKernel(pid, fixture, 'SIGKILL');

        await expect(pending).rejects.toMatchObject({
          code: 'unavailable',
          uncertain: true,
        });

        await expect(service.inspect(view.scope)).resolves.toBeNull();
      } finally {
        await service.close();
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    'bounds a stopped RPC, terminates the failed child, and serves the next explicit operation',
    async () => {
      const fixture = createFixture();
      const service = createService(fixture, RPC_TIMEOUT_MS);

      try {
        await service.start();
        const stoppedPid = await waitForKernelPid(fixture);
        signalKernel(stoppedPid, fixture, 'SIGSTOP');
        const startedAt = Date.now();

        await expect(service.inspect('blocked')).rejects.toMatchObject({
          code: 'resource-limited',
          uncertain: false,
        });
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        await expect(waitForKernelExit(stoppedPid)).resolves.toBeUndefined();

        await expect(service.health()).resolves.toBeUndefined();
        const restartedPid = await waitForKernelPid(fixture);
        expect(restartedPid).not.toBe(stoppedPid);
      } finally {
        await service.close();
      }
    },
    TEST_TIMEOUT_MS
  );
});

function createService(
  fixture: { sourcesRoot: string; storeRoot: string },
  timeoutMs: number
): RetrievalService {
  const service = new RetrievalService({
    executable: KERNEL_EXECUTABLE,
    sourcesRoot: fixture.sourcesRoot,
    storeRoot: fixture.storeRoot,
    timeoutMs,
  });
  services.push(service);
  return service;
}

function createFixture(): { sourcesRoot: string; storeRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'openkit-retrieval-supervision-'));
  testRoots.push(root);
  const fixture = {
    sourcesRoot: join(root, 'sources'),
    storeRoot: join(root, 'store'),
  };
  mkdirSync(fixture.sourcesRoot, { recursive: true });
  mkdirSync(fixture.storeRoot, { recursive: true });
  return fixture;
}

function createInlineView(scope: string, text: string): RetrievalScope {
  const digest = createHash('sha256').update(text).digest('hex');
  return {
    scope,
    documents: [
      {
        key: { namespace: 'nanocore-test', id: 'inline-source' },
        revision: '1',
        digest,
        size: Buffer.byteLength(text),
        name: 'inline-source',
        media_type: 'text/plain',
        content: { kind: 'inline-text' as const, text },
      },
    ],
  };
}

function createLargeFileDocument(sourcesRoot: string, name: string): RetrievalDocument {
  mkdirSync(sourcesRoot, { recursive: true });
  const path = join(sourcesRoot, name);
  const descriptor = openSync(path, 'wx', 0o600);
  const block = Buffer.alloc(64 * 1024, 0x61);
  const digest = createHash('sha256');
  try {
    for (let written = 0; written < LARGE_SOURCE_BYTES; written += block.length) {
      writeSync(descriptor, block);
      digest.update(block);
    }
  } finally {
    closeSync(descriptor);
  }
  return {
    key: { namespace: 'nanocore-test', id: name },
    revision: '1',
    digest: digest.digest('hex'),
    size: LARGE_SOURCE_BYTES,
    name,
    media_type: 'text/plain',
    content: { kind: 'text' as const, path: name },
  };
}

function resolveKernelExecutable(): string {
  const configured = process.env.OPENKIT_RETRIEVAL_KERNEL_EXECUTABLE;
  if (configured) return resolve(configured);
  const candidates = [
    join(REPOSITORY_ROOT, 'target/debug/retrieval-kernel'),
    join(REPOSITORY_ROOT, 'target/release/retrieval-kernel'),
    join(REPOSITORY_ROOT, 'apps/retrieval-kernel/target/debug/retrieval-kernel'),
    join(REPOSITORY_ROOT, 'apps/retrieval-kernel/target/release/retrieval-kernel'),
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(
      'Retrieval Kernel executable is missing; build @openkit/retrieval-kernel before this seam test.'
    );
  }
  return executable;
}

async function waitForKernelPid(fixture: {
  sourcesRoot: string;
  storeRoot: string;
}): Promise<number> {
  let found: number | undefined;
  await waitFor(() => {
    found = findKernelPids(fixture)[0];
    return found !== undefined;
  }, 'retrieval-kernel child process');
  return found as number;
}

function findKernelPids(fixture: { sourcesRoot: string; storeRoot: string }): number[] {
  return readdirSync('/proc', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((pid) => {
      try {
        const args = readFileSync(`/proc/${pid}/cmdline`)
          .toString('utf8')
          .split('\0')
          .filter(Boolean);
        return (
          args.some((arg) => arg.endsWith('/retrieval-kernel')) &&
          args.includes('service') &&
          args.includes(fixture.sourcesRoot) &&
          args.includes(fixture.storeRoot)
        );
      } catch {
        return false;
      }
    });
}

function signalKernel(
  pid: number,
  fixture: { sourcesRoot: string; storeRoot: string },
  signal: NodeJS.Signals
): void {
  if (!findKernelPids(fixture).includes(pid)) {
    throw new Error(`Refusing to signal PID ${pid}: it is not the fixture Retrieval Kernel.`);
  }
  process.kill(pid, signal);
}

async function waitForKernelExit(pid: number): Promise<void> {
  await waitFor(() => !existsSync(`/proc/${pid}`), `retrieval-kernel PID ${pid} to exit`);
}

async function waitFor(predicate: () => boolean, subject: string): Promise<void> {
  const deadline = Date.now() + PROCESS_OBSERVATION_MS;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out while waiting for ${subject}.`);
}
