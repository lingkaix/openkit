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
  it.each([
    ['sequential', 'replays the exact applied fence before successor readiness'],
    ['paused-generation', 'rejects a paused allocation after another generation is fenced'],
    ['paused-no-fence', 'rejects a paused allocation when its original absent fence changes'],
    ['core-ack-loss', 'keeps the intervening successor ready after the original Core ACK is lost'],
    ['native-ack-loss', 'returns the exact committed allocation after the native ACK is lost'],
  ])('%s: %s', async (scenario) => {
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
            inspectNanoHostRuntimeTargetTransition, prepareNanoHostRuntimeTargetTransition,
            readPendingNanoHostEpochRetirement,
            settleNanoHostEpochInvalidation, stageNanoHostEpochInvalidation,
            verifyNanoHostRetiringPlacement, verifyNanoHostStagedEpochInvalidation,
          } = await import(workerData.fenceModule);
          const { sha256CanonicalJson } = await import(workerData.digestModule);
          const { transitionNanoHostRuntimeTarget, vaultEpochFenceOccurrence } = await import(workerData.relayModule);
          const { storageRequestId } = await import(workerData.ownerModule);
          const { placement, intent, receipt, databasePath, scenario } = workerData;
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
          const write = (callback, writer = db) => writer.transaction(callback).immediate();
          let occurrence = 0;
          const capture = (input, id = 'fixture-' + (++occurrence)) =>
            observe(reader => prepareNanoHostRuntimeTargetTransition(reader, input, id));
          const mutate = (original, writer = db) =>
            write(() => applyNanoHostRuntimeTargetMutation(writer, original), writer);
          const begin = (value = placement, writer = db) =>
            write(() => beginNanoHostEpochRetirement(writer, value), writer);
          const stage = (value = intent, writer = db) =>
            write(() => stageNanoHostEpochInvalidation(writer, value), writer);
          const settle = (value, writer = db) =>
            write(() => settleNanoHostEpochInvalidation(writer, value), writer);
          const ready = value => ({ state: 'ready', value });
          const unavailable = { state: 'unavailable', owner: 'control-kernel', reason: 'recovery-required' };
          const storeFor = (writer = () => db) => ({
            inspectRuntimeTargetTransition: async original => observe(
              reader => inspectNanoHostRuntimeTargetTransition(reader, original),
            ),
            readEpochInvalidation: async id => ready(observe(
              reader => readNanoHostEpochInvalidation(reader, id),
            )),
            beginEpochRetirement: async value => ready(begin(value, writer())),
            stageEpochInvalidation: async value => ready(stage(value, writer())),
            settleEpochInvalidation: async value => ready(settle(value, writer())),
            mutateRuntimeTarget: async original => mutate(original, writer()),
          });
          const store = storeFor();
          const withIndependentWriter = async callback => {
            const competingDb = new Database(databasePath, { fileMustExist: true });
            try {
              return await callback(storeFor(() => competingDb));
            } finally {
              competingDb.close();
            }
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
          const transition = original => transitionNanoHostRuntimeTarget(store, kernel, original);
          const makeReady = generation => ({
            ...allocation, kind: 'ready', connectionGeneration: generation, predecessorFenced: true,
            ready: true, freshEmpty: true, physicalEpoch: 'e'.repeat(64),
          });
          const reopen = () => {
            db.close();
            db = new Database(databasePath, { fileMustExist: true });
          };
          const row = () => observe(reader => reader.prepare(
            'SELECT * FROM nanohost_runtime_targets',
          ).get());
          const recoveryRequired = { state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' };
          const exerciseRace = async () => {
            const receipts = new Map();
            const coreDecisions = [];
            const coreInspections = [];
            let loseCoreAck = scenario === 'core-ack-loss';
            const decidingCore = {
              reserveHolderIntent: async retiring => {
                assert.equal(observe(reader => verifyNanoHostRetiringPlacement(reader, retiring)), true);
                if (retiring.generation === placement.generation &&
                    retiring.physicalEpoch === placement.physicalEpoch) return ready(intent);
                const occurrence = vaultEpochFenceOccurrence(retiring);
                const target = {
                  runtimeTargetId: retiring.runtimeTargetId,
                  physicalEpoch: retiring.physicalEpoch,
                  holderReceiptIds: [],
                };
                return ready({
                  ...occurrence, requestId: storageRequestId(occurrence),
                  expectedGeneration: retiring.generation, inputDigest: sha256CanonicalJson(target), target,
                });
              },
              inspectNanoHostEpochFence: async value => {
                coreInspections.push(value.requestId);
                const receipt = receipts.get(value.requestId);
                return ready(receipt ? { state: 'settled', receipt } : { state: 'absent' });
              },
              fenceNanoHostEpoch: async value => {
                assert.equal(observe(reader => verifyNanoHostStagedEpochInvalidation(reader, value)), true);
                coreDecisions.push(value.requestId);
                const committed = {
                  intent: value, receiptDigest: receipt.receiptDigest, disposition: 'applied',
                  result: { fencedHolderReceiptIds: value.target.holderReceiptIds },
                };
                receipts.set(value.requestId, committed);
                if (loseCoreAck) {
                  loseCoreAck = false;
                  throw new Error('Core fence acknowledgement lost');
                }
                return ready({ state: 'settled', receipt: committed });
              },
            };
            const run = (original, owner = store) =>
              transitionNanoHostRuntimeTarget(owner, decidingCore, original);
            const close = generation => ({
              kind: 'close', targetId: allocation.targetId, closedGeneration: generation,
              authoritativeGeneration: null, observedAt: allocation.observedAt,
            });

            if (scenario === 'paused-generation' || scenario === 'paused-no-fence') {
              if (scenario === 'paused-no-fence') {
                db.prepare('UPDATE nanohost_runtime_targets SET ready = 0, fresh_empty = 0, physical_epoch = NULL').run();
              }
              const delayedOriginal = capture(allocation);
              assert.equal(delayedOriginal.predecessor.generation, 8);
              assert.equal(delayedOriginal.predecessor.fence, null);
              const delay = Promise.withResolvers();
              const entered = Promise.withResolvers();
              const delayed = run(delayedOriginal, {
                ...store,
                mutateRuntimeTarget: async original => {
                  entered.resolve();
                  await delay.promise;
                  return mutate(original);
                },
              });
              await Promise.race([entered.promise, delayed.then(
                () => { throw new Error('Allocation settled before entering the paused writer'); },
              )]);
              try {
                const successor = scenario === 'paused-generation' ? 9 : 8;
                await withIndependentWriter(async competingStore => {
                  if (successor === 9) {
                    assert.equal((await run(capture(allocation), competingStore)).value.connectionGeneration, 9);
                  }
                  assert.equal((await run(capture(makeReady(successor)), competingStore)).value.ready, true);
                  assert.equal((await run(capture(close(successor)), competingStore)).value.ready, false);
                });
                reopen();
                const before = row();
                const latestFence = JSON.parse(before.vault_epoch_fence_json);
                assert.equal(latestFence.placement.generation, String(successor));
                assert.equal(latestFence.receipt.disposition, 'applied');
                delay.resolve();
                const result = await delayed;
                assert.equal(row().connection_generation, successor, 'paused writer advanced the generation');
                assert.deepEqual(result, recoveryRequired);
                assert.deepEqual(row(), before);
              } finally {
                delay.resolve();
                await delayed.catch(() => undefined);
              }
              return;
            }

            const original = capture(allocation);
            if (scenario === 'core-ack-loss') {
              await assert.rejects(run(original), /Core fence acknowledgement lost/);
              reopen();
              // The replacement has identical allocation bytes and a different occurrence.
              await withIndependentWriter(async competingStore => {
                assert.equal((await run(capture(allocation), competingStore)).value.connectionGeneration, 9);
                assert.equal((await run(capture(makeReady(9)), competingStore)).value.ready, true);
              });
              const before = row();
              const observed = coreInspections.slice();
              assert.deepEqual(await run(original), recoveryRequired);
              assert.deepEqual(coreDecisions, [intent.requestId]);
              assert.deepEqual(coreInspections, observed);
              assert.equal(row().connection_generation, 9);
              assert.equal(row().ready, 1);
              assert.deepEqual(row(), before);
              return;
            }

            let committed;
            await assert.rejects(run(original, {
              ...store,
              mutateRuntimeTarget: async value => {
                committed = mutate(value);
                assert.equal(committed.state, 'ready');
                assert.equal(committed.value.connectionGeneration, 9);
                throw new Error('Native allocation acknowledgement lost');
              },
            }), /Native allocation acknowledgement lost/);
            reopen();
            const before = row();
            const observed = coreInspections.slice();
            assert.deepEqual(await run(original), committed);
            assert.deepEqual(coreDecisions, [intent.requestId]);
            assert.deepEqual(coreInspections, observed);
            assert.equal(row().connection_generation, 9);
            assert.deepEqual(row(), before);
            assert.deepEqual(await run({
              ...original, input: { ...original.input, observedAt: '2026-11-21T00:00:00.000Z' },
            }), recoveryRequired);
            assert.deepEqual(row(), before);
          };
          try {
            if (scenario !== 'sequential') {
              await exerciseRace();
              return;
            }
            const original = capture(allocation);
            assert.deepEqual(original.retirement, placement);
            assert.equal(verifyNanoHostRetiringPlacement(db, placement), false);
            assert.throws(() => capture({
              ...allocation, identityId: 'wrong-identity',
            }), /identity or deployment conflicts/);
            assert.equal(capture({
              kind: 'close', targetId: allocation.targetId, closedGeneration: 7,
              authoritativeGeneration: 8, observedAt: allocation.observedAt,
            }).retirement, null);
            assert.deepEqual(capture({
              kind: 'restart', observedAt: allocation.observedAt,
            }).retirement, placement);
            assert.deepEqual(mutate(original), recoveryRequired);
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
            assert.throws(() => mutate(original), /no applied Vault receipt/);
            begin();
            await assert.rejects(transition(original), /Core fence acknowledgement lost/);
            db.close();
            db = new Database(databasePath, { fileMustExist: true });
            assert.deepEqual(readPendingNanoHostEpochRetirement(db), placement);
            assert.deepEqual(readNanoHostEpochInvalidation(db, intent.requestId), intent);
            assert.equal(verifyNanoHostStagedEpochInvalidation(db, {
              ...intent, target: { ...intent.target, holderReceiptIds: ['holder-a'] },
            }), false);
            stage();
            assert.throws(() => mutate(original), /no applied Vault receipt/);
            assert.throws(() => settle({
              ...receipt, result: { fencedHolderReceiptIds: ['holder-a'] },
            }), /no exact original intent/);
            assert.throws(() => mutate(original), /no applied Vault receipt/);
            assert.throws(() => capture(makeReady(8)), /generation cannot become ready/);
            assert.equal((await transition(original)).value.connectionGeneration, 9);
            assert.equal(reservations, 1);
            assert.equal(decisions, 1);
            assert.equal(readPendingNanoHostEpochRetirement(db), null);
            settle(receipt);
            const successorReadiness = capture(makeReady(9));
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
            scenario,
            placement,
            intent,
            receipt,
            sqlite: require.resolve('better-sqlite3'),
            fenceModule: new URL(
              '../../dist/storage/nanohost-epoch-invalidation-native.js',
              import.meta.url
            ).href,
            digestModule: import.meta.resolve('@openkit/protocol/digest'),
            ownerModule: new URL('../../dist/storage/storage-owner.js', import.meta.url).href,
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
