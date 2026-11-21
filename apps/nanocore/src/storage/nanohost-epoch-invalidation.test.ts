// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { sha256CanonicalJson } from '@openkit/protocol/digest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it, vi } from 'vitest';
import type { ControlKernelStore } from './control-kernel-port.js';
import {
  fenceNanoHostEpochBeforeSuccessor,
  prepareNanoHostEpochInvalidation,
  vaultEpochFenceOccurrence,
} from './nanohost-epoch-invalidation.js';
import type {
  NanoHostEpochInvalidation,
  NanoHostEpochReceipt,
  NanoHostStore,
} from './nanohost-port.js';
import { type StorageResult, storageRequestId } from './storage-owner.js';

const target = {
  runtimeTargetId: 'fixture-target',
  physicalEpoch: 'b'.repeat(64),
  holderReceiptIds: ['holder-a', 'holder-b'],
};
const generation = '8';
const placement = {
  deploymentId: 'fixture-deployment',
  runtimeTargetId: target.runtimeTargetId,
  physicalEpoch: target.physicalEpoch,
  generation,
};
const occurrence = vaultEpochFenceOccurrence(placement);
const intent: NanoHostEpochInvalidation = {
  ...occurrence,
  requestId: storageRequestId(occurrence),
  expectedGeneration: generation,
  inputDigest: sha256CanonicalJson(target),
  target,
};
const receipt: NanoHostEpochReceipt = {
  intent,
  receiptDigest: 'd'.repeat(64),
  disposition: 'applied',
  result: { fencedHolderReceiptIds: ['holder-b', 'holder-a'] },
};
const committed = { state: 'ready', value: { state: 'settled', receipt } } as const;
const absent = { state: 'ready', value: { state: 'absent' } } as const;

describe('NanoHost original epoch invalidation relay', () => {
  it('closes native readiness before Core reserves holders and reuses the staged intent', async () => {
    const store = {
      beginEpochRetirement: vi.fn(
        async (_placement: typeof placement) => ({ state: 'ready', value: undefined }) as const
      ),
      readEpochInvalidation: vi
        .fn<NanoHostStore['readEpochInvalidation']>()
        .mockResolvedValueOnce({ state: 'ready', value: null })
        .mockResolvedValue({ state: 'ready', value: intent }),
    };
    const reserveHolderIntent = vi.fn(async () => {
      expect(store.beginEpochRetirement).toHaveBeenCalledExactlyOnceWith(placement);
      return { state: 'ready', value: intent } as const;
    });

    await expect(
      prepareNanoHostEpochInvalidation(store, occurrence, placement, reserveHolderIntent)
    ).resolves.toEqual({ state: 'ready', value: intent });
    await expect(
      prepareNanoHostEpochInvalidation(store, occurrence, placement, reserveHolderIntent)
    ).resolves.toEqual({ state: 'ready', value: intent });
    expect(store.readEpochInvalidation).toHaveBeenLastCalledWith(intent.requestId);
    expect(store.beginEpochRetirement).toHaveBeenCalledTimes(1);
    expect(reserveHolderIntent).toHaveBeenCalledExactlyOnceWith(placement);
  });

  it('retries the original retirement after a lost reservation acknowledgement', async () => {
    const store = {
      beginEpochRetirement: vi.fn(
        async (_placement: typeof placement) => ({ state: 'ready', value: undefined }) as const
      ),
      readEpochInvalidation: vi.fn(async () => ({ state: 'ready', value: null }) as const),
    };
    const reserveHolderIntent = vi
      .fn<
        (
          input: typeof placement
        ) => Promise<StorageResult<'control-kernel', NanoHostEpochInvalidation | null>>
      >()
      .mockRejectedValueOnce(new Error('fixture acknowledgement lost after reservation'))
      .mockResolvedValue({ state: 'ready', value: intent });

    await expect(
      prepareNanoHostEpochInvalidation(store, occurrence, placement, reserveHolderIntent)
    ).rejects.toThrow('acknowledgement lost');
    await expect(
      prepareNanoHostEpochInvalidation(store, occurrence, placement, reserveHolderIntent)
    ).resolves.toEqual({ state: 'ready', value: intent });
    expect(reserveHolderIntent.mock.calls).toEqual([[placement], [placement]]);
    expect(store.beginEpochRetirement.mock.calls).toEqual([[placement], [placement]]);
  });

  it('distinguishes an incomplete reservation from a proved empty holder set', async () => {
    const store = {
      beginEpochRetirement: vi.fn(
        async (_placement: typeof placement) => ({ state: 'ready', value: undefined }) as const
      ),
      readEpochInvalidation: vi.fn(async () => ({ state: 'ready', value: null }) as const),
    };
    await expect(
      prepareNanoHostEpochInvalidation(store, occurrence, placement, async () => ({
        state: 'ready',
        value: null,
      }))
    ).resolves.toEqual({
      state: 'unavailable',
      owner: 'control-kernel',
      reason: 'recovery-required',
    });
    const emptyTarget = { ...target, holderReceiptIds: [] };
    const emptyIntent = {
      ...intent,
      target: emptyTarget,
      inputDigest: sha256CanonicalJson(emptyTarget),
    };
    await expect(
      prepareNanoHostEpochInvalidation(store, occurrence, placement, async () => ({
        state: 'ready',
        value: emptyIntent,
      }))
    ).resolves.toEqual({ state: 'ready', value: emptyIntent });
  });

  it('inspects a committed fence after acknowledgement loss without sending it twice', async () => {
    const store = {
      stageEpochInvalidation: vi.fn(async () => ({ state: 'ready', value: undefined }) as const),
      settleEpochInvalidation: vi.fn(async () => ({ state: 'ready', value: undefined }) as const),
    };
    const kernel = {
      inspectNanoHostEpochFence: vi
        .fn<ControlKernelStore['inspectNanoHostEpochFence']>()
        .mockResolvedValue(committed)
        .mockResolvedValueOnce(absent),
      fenceNanoHostEpoch: vi.fn(async () => {
        throw new Error('fixture acknowledgement lost after commit');
      }),
    };
    await expect(fenceNanoHostEpochBeforeSuccessor(store, kernel, intent)).rejects.toThrow(
      'acknowledgement lost'
    );
    expect(store.settleEpochInvalidation).not.toHaveBeenCalled();

    await expect(fenceNanoHostEpochBeforeSuccessor(store, kernel, intent)).resolves.toEqual(
      committed
    );
    expect(kernel.fenceNanoHostEpoch).toHaveBeenCalledExactlyOnceWith(intent);
    expect(kernel.inspectNanoHostEpochFence).toHaveBeenLastCalledWith(intent);
    expect(store.settleEpochInvalidation).toHaveBeenCalledExactlyOnceWith(receipt);
  });

  it('keeps successor readiness held for an incomplete holder receipt', async () => {
    const store = {
      stageEpochInvalidation: vi.fn(async () => ({ state: 'ready', value: undefined }) as const),
      settleEpochInvalidation: vi.fn(async () => ({ state: 'ready', value: undefined }) as const),
    };
    const partial = {
      ...receipt,
      result: { fencedHolderReceiptIds: ['holder-a'] },
    };
    const kernel = {
      inspectNanoHostEpochFence: vi.fn(async () => absent),
      fenceNanoHostEpoch: vi.fn(
        async () => ({ state: 'ready', value: { state: 'settled', receipt: partial } }) as const
      ),
    };
    await expect(fenceNanoHostEpochBeforeSuccessor(store, kernel, intent)).resolves.toEqual({
      state: 'ready',
      value: { state: 'conflict' },
    });
    expect(store.settleEpochInvalidation).not.toHaveBeenCalled();
  });
});

describe('native no-Turn epoch fence', () => {
  it('replays the exact retiring placement and applied fence before successor readiness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-epoch-fence-'));
    const databasePath = join(root, 'state.sqlite');
    const sqlite = new Database(databasePath);
    try {
      try {
        migrate(drizzle(sqlite), {
          migrationsFolder: fileURLToPath(
            new URL('../../drizzle/extensions/nanohost/', import.meta.url)
          ),
        });
        sqlite
          .prepare(`INSERT INTO nanohost_runtime_targets
            (target_id, identity_id, deployment_id, connection_generation, predecessor_fenced,
              ready, fresh_empty, physical_epoch, observed_at, slot_count)
            VALUES (?, 'fixture-identity', ?, 8, 1, 1, 1, ?, '2026-11-20T00:00:00.000Z', 1)`)
          .run(intent.target.runtimeTargetId, intent.deploymentId, intent.target.physicalEpoch);
      } finally {
        sqlite.close();
      }

      const require = createRequire(import.meta.url);
      const worker = new Worker(
        `
        const assert = require('node:assert/strict');
        const { workerData } = require('node:worker_threads');
        (async () => {
          const Database = require(workerData.sqlite);
          const {
            applyNanoHostRuntimeTargetMutation, beginNanoHostEpochRetirement, readNanoHostEpochInvalidation,
            readNanoHostRuntimeTargetRetirement, readPendingNanoHostEpochRetirement,
            settleNanoHostEpochInvalidation, stageNanoHostEpochInvalidation,
            verifyNanoHostRetiringPlacement, verifyNanoHostStagedEpochInvalidation,
          } = await import(workerData.fenceModule);
          const { transitionNanoHostRuntimeTarget } = await import(workerData.relayModule);
          const { placement, intent, receipt, databasePath } = workerData;
          const allocation = {
            kind: 'allocate', targetId: intent.target.runtimeTargetId,
            deploymentId: intent.deploymentId, identityId: 'fixture-identity',
            observedAt: '2026-11-20T00:00:01.000Z',
          };
          let db = new Database(databasePath, { fileMustExist: true });
          const observe = read => {
            const reader = new Database(databasePath, { fileMustExist: true, readonly: true });
            try { return read(reader); } finally { reader.close(); }
          };
          const write = callback => db.transaction(callback).immediate();
          const mutate = input => write(() => applyNanoHostRuntimeTargetMutation(db, input));
          const begin = (value = placement) => write(() => beginNanoHostEpochRetirement(db, value));
          const stage = (value = intent) => write(() => stageNanoHostEpochInvalidation(db, value));
          const settle = value => write(() => settleNanoHostEpochInvalidation(db, value));
          const ready = value => ({ state: 'ready', value });
          const unavailable = { state: 'unavailable', owner: 'control-kernel', reason: 'recovery-required' };
          const store = {
            readRuntimeTargetRetirement: async value => ready(observe(
              reader => readNanoHostRuntimeTargetRetirement(reader, value),
            )),
            readEpochInvalidation: async id => ready(observe(
              reader => readNanoHostEpochInvalidation(reader, id),
            )),
            beginEpochRetirement: async value => ready(begin(value)),
            stageEpochInvalidation: async value => ready(stage(value)),
            settleEpochInvalidation: async value => ready(settle(value)),
            mutateRuntimeTarget: async value => ready(mutate(value)),
          };
          let reserved = false;
          let originalReceipt = null;
          let reservations = 0;
          let decisions = 0;
          const kernel = {
            reserveHolderIntent: async value => {
              reservations++;
              assert.deepEqual(value, placement);
              assert.equal(observe(reader => verifyNanoHostRetiringPlacement(reader, value)), true);
              assert.equal(observe(reader => verifyNanoHostStagedEpochInvalidation(reader, intent)), false);
              reserved = true;
              return ready(intent);
            },
            inspectNanoHostEpochFence: async value => {
              assert.deepEqual(value, intent);
              return ready(originalReceipt
                ? { state: 'settled', receipt: originalReceipt }
                : { state: 'absent' });
            },
            fenceNanoHostEpoch: async value => {
              assert.deepEqual(value, intent);
              if (!reserved) return ready({ state: 'unknown' });
              assert.equal(observe(reader => verifyNanoHostStagedEpochInvalidation(reader, value)), true);
              decisions++;
              originalReceipt = receipt;
              throw new Error('Core fence acknowledgement lost');
            },
          };
          const transition = value => transitionNanoHostRuntimeTarget(store, kernel, value);
          try {
            assert.deepEqual(readNanoHostRuntimeTargetRetirement(db, allocation), placement);
            assert.equal(verifyNanoHostRetiringPlacement(db, placement), false);
            assert.throws(() => readNanoHostRuntimeTargetRetirement(db, {
              ...allocation, identityId: 'wrong-identity',
            }), /identity or deployment conflicts/);
            assert.equal(readNanoHostRuntimeTargetRetirement(db, {
              kind: 'close', targetId: allocation.targetId, closedGeneration: 7,
              authoritativeGeneration: 8, observedAt: allocation.observedAt,
            }), null);
            assert.deepEqual(readNanoHostRuntimeTargetRetirement(db, {
              kind: 'restart', observedAt: allocation.observedAt,
            }), placement);
            assert.throws(() => mutate(allocation), /must be fenced/);
            assert.throws(stage, /no exact retiring placement/);
            begin();
            assert.equal(db.prepare('SELECT ready FROM nanohost_runtime_targets').pluck().get(), 0);
            db.close();
            db = new Database(databasePath, { fileMustExist: true });
            assert.equal(db.prepare('SELECT physical_epoch FROM nanohost_runtime_targets').pluck().get(), null);
            db.prepare('UPDATE nanohost_runtime_targets SET ready = 1').run();
            assert.throws(() => readPendingNanoHostEpochRetirement(db), /contradicts the current target/);
            db.prepare('UPDATE nanohost_runtime_targets SET ready = 0').run();
            assert.deepEqual(readPendingNanoHostEpochRetirement(db), placement);
            assert.equal(readNanoHostEpochInvalidation(db, intent.requestId), null);
            assert.equal(verifyNanoHostRetiringPlacement(db, { ...placement, generation: '9' }), false);
            assert.throws(() => mutate(allocation), /no applied Vault receipt/);
            begin();
            await assert.rejects(transition(allocation), /Core fence acknowledgement lost/);
            db.close();
            db = new Database(databasePath, { fileMustExist: true });
            assert.deepEqual(readPendingNanoHostEpochRetirement(db), placement);
            assert.deepEqual(readNanoHostEpochInvalidation(db, intent.requestId), intent);
            assert.equal(verifyNanoHostStagedEpochInvalidation(db, {
              ...intent, target: { ...intent.target, holderReceiptIds: ['holder-a'] },
            }), false);
            stage();
            assert.throws(() => mutate(allocation), /no applied Vault receipt/);
            assert.throws(() => settle({
              ...receipt, result: { fencedHolderReceiptIds: ['holder-a'] },
            }), /no exact original intent/);
            assert.throws(() => mutate(allocation), /no applied Vault receipt/);
            await assert.rejects(transition({
              ...allocation, kind: 'ready', connectionGeneration: 8, predecessorFenced: true,
              ready: true, freshEmpty: true, physicalEpoch: intent.target.physicalEpoch,
            }), /generation cannot become ready/);
            assert.equal((await transition(allocation)).value.connectionGeneration, 9);
            assert.equal(reservations, 1);
            assert.equal(decisions, 1);
            assert.equal(readPendingNanoHostEpochRetirement(db), null);
            settle(receipt);
            const successorReadiness = {
              ...allocation, kind: 'ready', connectionGeneration: 9, predecessorFenced: true,
              ready: true, freshEmpty: true, physicalEpoch: 'e'.repeat(64),
            };
            db.close();
            db = new Database(databasePath, { fileMustExist: true });
            reserved = false;
            originalReceipt = null;
            assert.deepEqual(await transition(successorReadiness), unavailable);
            assert.equal(db.prepare('SELECT ready FROM nanohost_runtime_targets').pluck().get(), 0);
            originalReceipt = receipt;
            assert.equal((await transition(successorReadiness)).value.ready, true);
            assert.equal(reservations, 1);
            assert.equal(decisions, 1);
          } finally {
            db.close();
          }
        })().catch(error => { process.nextTick(() => { throw error; }); });
        `,
        {
          eval: true,
          workerData: {
            databasePath,
            placement,
            intent,
            receipt,
            sqlite: require.resolve('better-sqlite3'),
            fenceModule: new URL(
              '../../dist/storage/nanohost-epoch-invalidation-native.js',
              import.meta.url
            ).href,
            relayModule: new URL(
              '../../dist/storage/nanohost-epoch-invalidation.js',
              import.meta.url
            ).href,
          },
        }
      );
      try {
        await new Promise<void>((resolve, reject) => {
          worker.once('error', reject);
          worker.once('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`NanoHost epoch fixture exited ${code}.`))
          );
        });
      } finally {
        await worker.terminate();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
