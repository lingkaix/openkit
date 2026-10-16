import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const testRoots: string[] = [];
afterEach(() => {
  for (const root of testRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

import { ensureLayout } from '../storage/fs-layout.js';
import { acquireDataRootLock, DataRootLockError, dataRootLockPath } from './lock.js';

/** Creates an isolated data root for lock tests. */
function createDataRoot(): string {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-data-root-lock-'));
  testRoots.push(dataRoot);
  ensureLayout(dataRoot);
  return dataRoot;
}

/**
 * Writes a synthetic lock record for stale-lock tests.
 *
 * @param dataRoot Test data root.
 * @param record Lock fields to override.
 */
function writeSyntheticLockRecord(
  dataRoot: string,
  record: { bootId: string; pid: number; updatedAt: string }
): void {
  writeFileSync(
    dataRootLockPath(dataRoot),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        hostname: hostname(),
        createdAt: '2026-07-04T00:00:00.000Z',
        ...record,
      },
      null,
      2
    )}\n`
  );
}

/** Starts a real lock holder so process death and live exclusion use the production path. */
function startLockHolder(dataRoot: string) {
  const moduleUrl = new URL('./lock.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `const { acquireDataRootLock } = await import(${JSON.stringify(moduleUrl)});
       const lock = acquireDataRootLock(process.argv[1], { bootId: 'boot_child' });
       const fs = await import('node:fs');
       const path = await import('node:path');
       // Ordinary inventory reads must not release the live App's ownership.
       for (const entry of fs.readdirSync(path.dirname(lock.path), { withFileTypes: true })) {
         if (entry.isFile()) fs.readFileSync(path.join(path.dirname(lock.path), entry.name));
       }
       console.log('lock-held');
       setInterval(() => { void lock.path; }, 1000);`,
      dataRoot,
    ],
    {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const exited = once(child, 'exit');
  const ready = Promise.race([
    once(child.stdout, 'data').then(([chunk]) => {
      expect(String(chunk).trim()).toBe('lock-held');
    }),
    exited.then(() => {
      throw new Error('Lock holder exited before acquiring its lock.');
    }),
  ]);
  return { child, ready, exited };
}

describe('data-root instance lock', () => {
  it('writes holder identity and releases the lock', () => {
    const dataRoot = createDataRoot();
    const lock = acquireDataRootLock(dataRoot, {
      bootId: 'boot_test',
      now: () => '2026-07-04T00:00:00.000Z',
      pid: 1234,
    });

    const record = JSON.parse(readFileSync(dataRootLockPath(dataRoot), 'utf8')) as {
      bootId: string;
      pid: number;
      updatedAt: string;
    };

    expect(record).toMatchObject({
      bootId: 'boot_test',
      pid: 1234,
      updatedAt: '2026-07-04T00:00:00.000Z',
    });
    expect(lock.acquisition).toMatchObject({
      status: 'acquired',
      staleHolder: null,
    });

    lock.release();

    expect(existsSync(dataRootLockPath(dataRoot))).toBe(false);
  });

  it('rejects a second holder for the same data root', () => {
    const dataRoot = createDataRoot();
    const lock = acquireDataRootLock(dataRoot, { bootId: 'boot_first' });

    try {
      expect(() => acquireDataRootLock(dataRoot, { bootId: 'boot_second' })).toThrow(
        DataRootLockError
      );
    } finally {
      lock.release();
    }
  });

  it('allows reacquire after release', () => {
    const dataRoot = createDataRoot();

    acquireDataRootLock(dataRoot, { bootId: 'boot_first' }).release();
    const next = acquireDataRootLock(dataRoot, { bootId: 'boot_second' });

    try {
      expect(JSON.parse(readFileSync(dataRootLockPath(dataRoot), 'utf8'))).toMatchObject({
        bootId: 'boot_second',
      });
    } finally {
      next.release();
    }
  });

  it('breaks a stale lock whose local holder is dead', () => {
    const dataRoot = createDataRoot();
    writeSyntheticLockRecord(dataRoot, {
      bootId: 'boot_dead',
      pid: 999_999_999,
      updatedAt: '2026-07-04T00:00:00.000Z',
    });

    const lock = acquireDataRootLock(dataRoot, {
      bootId: 'boot_next',
      now: () => '2026-07-04T00:01:00.000Z',
    });

    try {
      expect(JSON.parse(readFileSync(dataRootLockPath(dataRoot), 'utf8'))).toMatchObject({
        bootId: 'boot_next',
      });
      expect(lock.acquisition).toMatchObject({
        status: 'stale_broken',
        staleHolder: {
          bootId: 'boot_dead',
          pid: 999_999_999,
        },
      });
    } finally {
      lock.release();
    }
  });

  it('breaks a dead local holder even when the heartbeat is fresh', () => {
    const dataRoot = createDataRoot();
    writeSyntheticLockRecord(dataRoot, {
      bootId: 'boot_fresh',
      pid: 999_999_999,
      updatedAt: '2026-07-04T00:00:59.000Z',
    });

    const lock = acquireDataRootLock(dataRoot, {
      bootId: 'boot_next',
      now: () => '2026-07-04T00:01:00.000Z',
    });

    try {
      expect(JSON.parse(readFileSync(dataRootLockPath(dataRoot), 'utf8'))).toMatchObject({
        bootId: 'boot_next',
      });
      expect(lock.acquisition).toMatchObject({
        status: 'stale_broken',
        staleHolder: {
          bootId: 'boot_fresh',
          pid: 999_999_999,
        },
      });
    } finally {
      lock.release();
    }
  });

  it('breaks a stale lock when the acquiring process reused its pid', () => {
    const dataRoot = createDataRoot();
    writeSyntheticLockRecord(dataRoot, {
      bootId: 'boot_previous',
      pid: process.pid,
      updatedAt: '2026-07-04T00:00:00.000Z',
    });

    const lock = acquireDataRootLock(dataRoot, {
      bootId: 'boot_next',
      now: () => '2026-07-04T00:01:00.000Z',
    });

    try {
      expect(lock.acquisition).toMatchObject({
        status: 'stale_broken',
        staleHolder: {
          bootId: 'boot_previous',
          pid: process.pid,
        },
      });
    } finally {
      lock.release();
    }
  });

  it.runIf(process.platform === 'linux')(
    'breaks a stale lock when its pid was reused by a process thread',
    () => {
      const dataRoot = createDataRoot();
      const threadPid = readdirSync('/proc/self/task')
        .map(Number)
        .find((pid) => pid !== process.pid);
      expect(threadPid).toBeDefined();
      writeSyntheticLockRecord(dataRoot, {
        bootId: 'boot_previous',
        pid: threadPid!,
        updatedAt: '2026-07-04T00:00:00.000Z',
      });

      const lock = acquireDataRootLock(dataRoot, { bootId: 'boot_next' });

      try {
        expect(lock.acquisition.status).toBe('stale_broken');
      } finally {
        lock.release();
      }
    }
  );

  it('acquires after SIGKILL even when the previous container hostname differs', async () => {
    const dataRoot = createDataRoot();
    const holder = startLockHolder(dataRoot);
    try {
      await holder.ready;
      const path = dataRootLockPath(dataRoot);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify({ ...record, hostname: 'retired-app-container' }));
      holder.child.kill('SIGKILL');
      expect(await holder.exited).toEqual([null, 'SIGKILL']);
      expect(existsSync(path)).toBe(true);

      const successor = acquireDataRootLock(dataRoot, { bootId: 'boot_successor' });
      try {
        expect(successor.acquisition.status).toBe('stale_broken');
        expect(JSON.parse(readFileSync(path, 'utf8')).bootId).toBe('boot_successor');
      } finally {
        successor.release();
      }
    } finally {
      holder.child.kill('SIGKILL');
      await holder.exited;
    }
  });

  it('refuses a second App while the real holder process is alive', async () => {
    const dataRoot = createDataRoot();
    const holder = startLockHolder(dataRoot);
    try {
      await holder.ready;
      expect(() => acquireDataRootLock(dataRoot, { bootId: 'boot_contender' })).toThrow(
        DataRootLockError
      );
      expect(JSON.parse(readFileSync(dataRootLockPath(dataRoot), 'utf8')).bootId).toBe(
        'boot_child'
      );
    } finally {
      holder.child.kill('SIGKILL');
      await holder.exited;
    }
  });
});
