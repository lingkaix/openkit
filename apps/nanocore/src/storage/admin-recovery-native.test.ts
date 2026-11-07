// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOpenKitOperatorCli } from '../auth/admin-recovery.js';
import { acquireDataRootLock, DataRootLockError, dataRootLockPath } from '../bootstrap/lock.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestCoreDb, createTestWorkspaceDb } from '../test-support/store.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { coreDbPath, workspaceDbPath } from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';

const interception = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  gate: undefined as SharedArrayBuffer | undefined,
  point: 'none' as 'none' | 'commit' | 'after-commit' | 'close' | 'reject-close',
  terminationRequests: 0,
  terminationGate: undefined as Promise<void> | undefined,
  releaseTermination: undefined as (() => void) | undefined,
}));

// Reuse the native client harness's actual-Worker prelude; only the fault boundary is intercepted.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const require = createRequire(import.meta.url);
        const prelude = `
          const {workerData} = require('node:worker_threads');
          const Database = require(workerData.databaseModule);
          const originalExec = Database.prototype.exec;
          const originalClose = Database.prototype.close;
          function hold(point) {
            if (workerData.point === point && Atomics.compareExchange(workerData.gate, 0, 0, 1) === 0)
              Atomics.wait(workerData.gate, 1, 0);
          }
          Database.prototype.exec = function(sql) {
            if (/^COMMIT$/i.test(sql)) hold('commit');
            const result = originalExec.call(this, sql);
            if (/^COMMIT$/i.test(sql)) {
              Atomics.add(workerData.gate, 2, 1);
              hold('after-commit');
            }
            return result;
          };
          Database.prototype.close = function() {
            if (workerData.point === 'reject-close') {
              Atomics.add(workerData.gate, 0, 1);
              throw new Error('injected native close failure');
            }
            hold('close');
            const result = originalClose.call(this);
            Atomics.add(workerData.gate, 3, 1);
            return result;
          };
        `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            databaseModule: require.resolve('better-sqlite3'),
            gate: new Int32Array(interception.gate!),
            point: interception.point,
          },
        });
        interception.workers.push(this);
      }

      override async terminate(): Promise<number> {
        interception.terminationRequests++;
        await interception.terminationGate;
        return super.terminate();
      }
    },
  };
});

const roots: string[] = [];
const NOW = new Date('2026-09-02T00:00:00.000Z');
const EXPIRES_AT = '2026-09-02T12:00:00.000Z';

/** Builds canonical fixture authority before any deliberate storage fault. */
function fixture(point: typeof interception.point = 'none') {
  const root = mkdtempSync(join(tmpdir(), 'admin-recovery-native-'));
  roots.push(root);
  const coreDb = createTestCoreDb(root);
  let userId: string;
  try {
    userId = ensureLocalUser(coreDb);
  } finally {
    coreDb.sqlite.close();
  }
  const outputPath = join(root, 'recovery.json');
  interception.gate = new SharedArrayBuffer(16);
  interception.point = point;
  const gate = new Int32Array(interception.gate);
  const args = [
    'admin',
    'recover-access',
    '--data-root',
    root,
    '--owner-user-id',
    userId,
    '--expires-at',
    EXPIRES_AT,
    '--output',
    outputPath,
    '--confirm',
    `issue-server-admin-token:${userId}:${EXPIRES_AT}`,
  ];
  return { root, outputPath, gate, args };
}

/** Observes only counts through a separate query-only handle, never credential values. */
function recoveryCounts(root: string): { tokens: number; audits: number } {
  const reader = new Database(coreDbPath(root), { readonly: true, fileMustExist: true });
  try {
    reader.pragma('query_only = ON');
    return {
      tokens: reader.prepare('SELECT count(*) FROM openkit_access_tokens').pluck().get() as number,
      audits: reader
        .prepare("SELECT count(*) FROM audit_events WHERE action = 'auth.admin-recovery.issue'")
        .pluck()
        .get() as number,
    };
  } finally {
    reader.close();
  }
}

/** Confirms the operator still excludes a second process at an observed boundary. */
function expectRootLocked(root: string): void {
  expect(() => {
    const acquired = acquireDataRootLock(root, { bootId: 'recovery-native-contender' });
    acquired.release();
  }).toThrow(DataRootLockError);
}

/** Releases only this test's actual native thread. */
function release(gate: Int32Array): void {
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
}

/** Waits for the actual fault crossing, with early completion exposed as a failing observation. */
async function waitForHold(gate: Int32Array, settled: () => boolean): Promise<void> {
  while (Atomics.load(gate, 0) === 0 && !settled()) await nextTurn();
}

afterEach(async () => {
  if (interception.gate) release(new Int32Array(interception.gate));
  interception.releaseTermination?.();
  // A deliberate close failure can reject the already-joined shutdown promise.
  if (interception.point === 'reject-close')
    await shutdownControlStoreWorkerClient().catch(() => {});
  else await shutdownControlStoreWorkerClient();
  for (const worker of interception.workers.splice(0)) await worker.terminate();
  vi.restoreAllMocks();
  interception.gate = undefined;
  interception.point = 'none';
  interception.terminationRequests = 0;
  interception.terminationGate = undefined;
  interception.releaseTermination = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('stopped-server recovery native commit boundary', () => {
  it.each(['fresh-server', 'workspace', 'unbound-server'] as const)(
    'refuses the unsupported no-initialization open shape %s before native effects',
    async (shape) => {
      const f = fixture();
      const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
      const path =
        shape === 'workspace' ? workspaceDbPath(f.root, workspaceId) : coreDbPath(f.root);
      if (shape === 'workspace') {
        const workspace = createTestWorkspaceDb(f.root, workspaceId);
        try {
          applyScopedMigrations(workspace, undefined, 'pre-knowledge');
        } finally {
          workspace.sqlite.close();
        }
      }
      const coreDigest = createHash('sha256')
        .update(readFileSync(coreDbPath(f.root)))
        .digest('hex');
      const scopeDigest = createHash('sha256').update(readFileSync(path)).digest('hex');
      const command =
        shape === 'workspace'
          ? {
              database: `workspace:${path}`,
              path,
              dataRoot: f.root,
              create: false,
              productOwner: { kind: 'workspace' as const, workspaceId },
            }
          : {
              database: `core:${path}`,
              path,
              ...(shape === 'unbound-server' ? {} : { dataRoot: f.root }),
              create: shape === 'fresh-server',
              productOwner: { kind: 'server' as const },
            };

      // The approved omission applies only to existing exact-root server scopes; its guard is native.
      // Existing native open failures conservatively retain unknown outcome classification.
      await expect(getControlStoreWorkerClient().open(command)).rejects.toMatchObject({
        code: 'precondition',
        commit: 'unknown',
      });
      expect(interception.workers.length).toBeGreaterThan(0);
      expect(Atomics.load(f.gate, 2)).toBe(0);
      expect(recoveryCounts(f.root)).toEqual({ tokens: 0, audits: 0 });
      expect(
        createHash('sha256')
          .update(readFileSync(coreDbPath(f.root)))
          .digest('hex')
      ).toBe(coreDigest);
      expect(existsSync(path)).toBe(true);
      expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(scopeDigest);
    }
  );

  it('commits without a Main Token or Audit writer and closes both handles before locked stdout', async () => {
    const f = fixture();
    const originalPrepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      if (
        /^\s*(?:INSERT|UPDATE|DELETE)\b[\s\S]*\b(?:openkit_access_tokens|audit_events)\b/iu.test(
          sql
        )
      )
        throw new Error('Recovery mutation executed on Main.');
      return originalPrepare.call(this, sql);
    });
    const mainClose = vi.spyOn(Database.prototype, 'close');
    let outputCount = 0;

    const result = await runOpenKitOperatorCli(f.args, {
      now: () => NOW,
      write(line) {
        // Remote Auth's stopped-server recovery contract retains the lock through close and stdout.
        expectRootLocked(f.root);
        expect(Atomics.load(f.gate, 3)).toBeGreaterThan(0);
        expect(mainClose).toHaveBeenCalled();
        expect(
          line.includes('okt_') || line.includes('sha256:') || line.includes(f.outputPath)
        ).toBe(false);
        outputCount++;
      },
    });

    expect(result).toMatchObject({ status: 'completed' });
    expect(outputCount).toBe(1);
    expect(recoveryCounts(f.root)).toEqual({ tokens: 1, audits: 1 });
    expect(existsSync(dataRootLockPath(f.root))).toBe(false);
  });

  it('retains the file and lock but publishes no completed result before the covering FULL commit', async () => {
    const f = fixture('commit');
    const phases: string[] = [];
    let outputCount = 0;
    let settled = false;
    const result = Promise.resolve()
      .then(() =>
        runOpenKitOperatorCli(f.args, {
          now: () => NOW,
          onPhase: (phase) => phases.push(phase),
          write: () => {
            outputCount++;
          },
        })
      )
      .then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        }
      );
    try {
      await waitForHold(f.gate, () => settled);
      // Storage's durable acknowledgement rule and the file-first recovery owner fix this order.
      expect(Atomics.load(f.gate, 0)).toBe(1);
      expect(settled).toBe(false);
      expect(existsSync(f.outputPath)).toBe(true);
      expect(phases).toContain('file-durable');
      expect(phases).not.toContain('transaction-committed');
      expect(recoveryCounts(f.root)).toEqual({ tokens: 0, audits: 0 });
      expect(outputCount).toBe(0);
      expectRootLocked(f.root);
    } finally {
      release(f.gate);
    }
    expect(await result).toMatchObject({ value: { status: 'completed' } });
    expect(recoveryCounts(f.root)).toEqual({ tokens: 1, audits: 1 });
    expect(outputCount).toBe(1);
  });

  it('rolls back the Token when its Audit fails and resumes the identical file without duplicates', async () => {
    const f = fixture();
    const faultDb = new Database(coreDbPath(f.root), { fileMustExist: true });
    try {
      // Deliberate effect fault after canonical setup, not a fabricated successful record.
      faultDb.exec(`CREATE TRIGGER reject_recovery_audit
        BEFORE INSERT ON audit_events WHEN NEW.action = 'auth.admin-recovery.issue'
        BEGIN SELECT RAISE(ABORT, 'injected recovery Audit failure'); END`);
    } finally {
      faultDb.close();
    }
    let outputCount = 0;
    const options = {
      now: () => NOW,
      write: () => {
        outputCount++;
      },
    };
    await expect(runOpenKitOperatorCli(f.args, options)).rejects.toThrow();
    expect(interception.workers.length).toBeGreaterThan(0);
    expect(outputCount).toBe(0);
    expect(recoveryCounts(f.root)).toEqual({ tokens: 0, audits: 0 });
    expect(existsSync(dataRootLockPath(f.root))).toBe(false);
    const envelopeDigest = createHash('sha256').update(readFileSync(f.outputPath)).digest('hex');
    const repairedFault = new Database(coreDbPath(f.root), { fileMustExist: true });
    try {
      repairedFault.exec('DROP TRIGGER reject_recovery_audit');
    } finally {
      repairedFault.close();
    }

    const resumed = await runOpenKitOperatorCli(f.args, options);
    const repeated = await runOpenKitOperatorCli(f.args, options);
    expect(resumed).toMatchObject({ status: 'completed' });
    expect(repeated).toEqual(resumed);
    expect(createHash('sha256').update(readFileSync(f.outputPath)).digest('hex')).toBe(
      envelopeDigest
    );
    expect(recoveryCounts(f.root)).toEqual({ tokens: 1, audits: 1 });
    expect(outputCount).toBe(2);
  });

  it('keeps stdout and root-lock release pending until native database close finishes', async () => {
    const f = fixture('close');
    let outputCount = 0;
    let settled = false;
    const result = Promise.resolve()
      .then(() =>
        runOpenKitOperatorCli(f.args, {
          now: () => NOW,
          write: () => {
            outputCount++;
          },
        })
      )
      .then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        }
      );
    try {
      await waitForHold(f.gate, () => settled);
      expect(Atomics.load(f.gate, 0)).toBe(1);
      expect(Atomics.load(f.gate, 2)).toBeGreaterThan(0);
      expect(Atomics.load(f.gate, 3)).toBe(0);
      expect(settled).toBe(false);
      expect(recoveryCounts(f.root)).toEqual({ tokens: 1, audits: 1 });
      expect(outputCount).toBe(0);
      expectRootLocked(f.root);
    } finally {
      release(f.gate);
    }
    expect(await result).toMatchObject({ value: { status: 'completed' } });
    expect(outputCount).toBe(1);
    expect(existsSync(dataRootLockPath(f.root))).toBe(false);
  });

  it('joins actual worker termination after rejected native close before releasing the root lock', async () => {
    const f = fixture('reject-close');
    interception.terminationGate = new Promise<void>((resolve) => {
      interception.releaseTermination = resolve;
    });
    let outputCount = 0;
    let settled = false;
    const result = Promise.resolve()
      .then(() =>
        runOpenKitOperatorCli(f.args, {
          now: () => NOW,
          write: () => {
            outputCount++;
          },
        })
      )
      .then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        }
      );
    let exited = false;
    try {
      while (interception.terminationRequests === 0 && !settled) await nextTurn();
      expect(interception.terminationRequests).toBeGreaterThan(0);
      const worker = interception.workers[0]!;
      worker.once('exit', () => {
        exited = true;
      });
      expect(Atomics.load(f.gate, 0)).toBeGreaterThan(0);
      expect(Atomics.load(f.gate, 3)).toBe(0);
      expect(settled).toBe(false);
      expect(exited).toBe(false);
      expect(outputCount).toBe(0);
      expectRootLocked(f.root);
      expect(recoveryCounts(f.root)).toEqual({ tokens: 1, audits: 1 });
    } finally {
      interception.releaseTermination?.();
    }
    expect(await result).toHaveProperty('error');
    expect(exited).toBe(true);
    expect(outputCount).toBe(0);
    expect(existsSync(dataRootLockPath(f.root))).toBe(false);
    expect(recoveryCounts(f.root)).toEqual({ tokens: 1, audits: 1 });
  });

  it.each(['after-commit', 'close'] as const)(
    'preserves the committed attempt after native acknowledgement loss at %s until an explicit retry',
    async (point) => {
      const f = fixture(point);
      let outputCount = 0;
      let settled = false;
      const options = {
        now: () => NOW,
        write: () => {
          outputCount++;
        },
      };
      const result = Promise.resolve()
        .then(() => runOpenKitOperatorCli(f.args, options))
        .then(
          (value) => {
            settled = true;
            return { value };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          }
        );
      await waitForHold(f.gate, () => settled);
      expect(Atomics.load(f.gate, 0)).toBe(1);
      expect(settled).toBe(false);
      expect(recoveryCounts(f.root)).toEqual({ tokens: 1, audits: 1 });
      expect(outputCount).toBe(0);
      expectRootLocked(f.root);
      const envelopeDigest = createHash('sha256').update(readFileSync(f.outputPath)).digest('hex');
      const worker = interception.workers[0]!;
      let exited = false;
      worker.once('exit', () => {
        exited = true;
      });
      await worker.terminate();
      expect(await result).toHaveProperty('error');
      expect(exited).toBe(true);
      expect(outputCount).toBe(0);
      expect(recoveryCounts(f.root)).toEqual({ tokens: 1, audits: 1 });
      expect(existsSync(dataRootLockPath(f.root))).toBe(false);

      // Recovery uses the existing exact file/Token/Audit inspection; no automatic RPC replay.
      release(f.gate);
      interception.point = 'none';
      const resumed = await runOpenKitOperatorCli(f.args, options);
      expect(resumed).toMatchObject({ status: 'completed' });
      expect(createHash('sha256').update(readFileSync(f.outputPath)).digest('hex')).toBe(
        envelopeDigest
      );
      expect(recoveryCounts(f.root)).toEqual({ tokens: 1, audits: 1 });
      expect(outputCount).toBe(1);
    }
  );
});
