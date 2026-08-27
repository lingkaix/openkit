import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { acquireDataRootLock, DataRootLockError, dataRootLockPath } from './lock.js';

/** Creates an isolated data root for lock tests. */
function createDataRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-data-root-lock-'));
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
});
