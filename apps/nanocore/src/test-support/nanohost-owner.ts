import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, Worker } from 'node:worker_threads';
import { sha256CanonicalJson } from '@openkit/protocol/digest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { onTestFinished } from 'vitest';
import type {
  ControlNanoHostTransportInput,
  ControlNanoHostTransportResult,
} from '../auth/nanohost-transport-codecs.js';
import {
  type NanoHostRuntimeTargetEpochKernel,
  type NanoHostRuntimeTargetEpochStore,
  transitionNanoHostRuntimeTarget,
  vaultEpochFenceOccurrence,
} from '../storage/nanohost-epoch-invalidation.js';
import {
  inspectNanoHostRuntimeTargetTransition,
  type NanoHostRuntimeTargetTransition,
  readNanoHostEpochInvalidation,
} from '../storage/nanohost-epoch-invalidation-native.js';
import type { NanoHostEpochInvalidation, NanoHostEpochReceipt } from '../storage/nanohost-port.js';
import {
  type AdmittedNanoHostTransportStorage,
  transitionAdmittedNanoHostRuntimeTarget,
} from '../storage/nanohost-transport-owner.js';
import type {
  ControlRuntimeTargetInput,
  ControlRuntimeTargetResult,
} from '../storage/runtime-target-codecs.js';
import { type StorageResult, storageRequestId } from '../storage/storage-owner.js';

type HarnessTuple = Parameters<AdmittedNanoHostTransportStorage['owner']['harnessLifecycle']>[0];
type LocalTransportTuple = Exclude<
  ControlNanoHostTransportInput,
  { kind: 'lifecycle-audit' | 'decommission-audit' }
>;

type Command =
  | { kind: 'begin'; input: Parameters<NanoHostRuntimeTargetEpochStore['beginEpochRetirement']>[0] }
  | { kind: 'stage'; input: NanoHostEpochInvalidation }
  | { kind: 'settle'; input: NanoHostEpochReceipt }
  | { kind: 'target'; input: NanoHostRuntimeTargetTransition }
  | { kind: 'transport'; input: LocalTransportTuple }
  | { kind: 'harness'; input: HarnessTuple }
  | { kind: 'reopen' };

function ready<Value>(value: Value) {
  return { state: 'ready', value } as const;
}

interface NanoHostFixtureOwner {
  readonly storage: AdmittedNanoHostTransportStorage;
  readonly sqlite: Database.Database;
  transition(input: ControlRuntimeTargetInput): Promise<ControlRuntimeTargetResult>;
  reopen(): Promise<void>;
  setup(write: (sqlite: Database.Database) => void): void;
}

/** Opens the real extension baseline with a query-only caller and a FULL native fixture worker. */
export function openNanoHostTestOwner(): NanoHostFixtureOwner {
  const root = mkdtempSync(join(tmpdir(), 'openkit-split-nanohost-test-'));
  const path = join(root, 'server/extensions/nanohost/state.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const initial = new Database(path);
  try {
    initial.pragma('journal_mode = WAL');
    initial.pragma('foreign_keys = ON');
    migrate(drizzle(initial), {
      migrationsFolder: fileURLToPath(
        new URL('../../drizzle/extensions/nanohost/', import.meta.url)
      ),
    });
  } finally {
    initial.close();
  }
  const openReader = () => new Database(path, { fileMustExist: true, readonly: true });
  let reader = openReader();
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const Database = require(workerData.sqlite);
      const [epoch, transport, harness, harnessCodecs] = await Promise.all(workerData.modules.map(name => import(name)));
      const open = () => {
        const sqlite = new Database(workerData.path, { fileMustExist: true });
        sqlite.pragma('foreign_keys = ON');
        sqlite.pragma('synchronous = FULL');
        return sqlite;
      };
      let sqlite = open();
      parentPort.on('message', ({ command, port }) => {
        try {
          let value;
          if (command.kind === 'reopen') {
            sqlite.close();
            sqlite = open();
          } else {
            value = sqlite.transaction(() => {
              switch (command.kind) {
                case 'begin': return epoch.beginNanoHostEpochRetirement(sqlite, command.input);
                case 'stage': return epoch.stageNanoHostEpochInvalidation(sqlite, command.input);
                case 'settle': return epoch.settleNanoHostEpochInvalidation(sqlite, command.input);
                case 'target': return epoch.applyNanoHostRuntimeTargetMutation(sqlite, command.input);
                case 'transport': return transport.applyNanoHostTransportMutation(sqlite, command.input);
                case 'harness': return harness.applyControlHarnessLifecycle(
                  { sqlite }, harnessCodecs.ControlHarnessLifecycleInputSchema.nanoHostLocal.parse(command.input)
                );
              }
            }).immediate();
          }
          port.postMessage({ ok: true, value });
        } catch (error) {
          port.postMessage({ ok: false, message: error.message, code: error.code });
        } finally {
          port.close();
        }
      });
    })().catch(error => { process.nextTick(() => { throw error; }); });
    `,
    {
      eval: true,
      workerData: {
        path,
        sqlite: createRequire(import.meta.url).resolve('better-sqlite3'),
        modules: [
          new URL('../../dist/storage/nanohost-epoch-invalidation-native.js', import.meta.url).href,
          new URL('../../dist/auth/nanohost-transport-native.js', import.meta.url).href,
          new URL('../../dist/storage/harness-lifecycle-native.js', import.meta.url).href,
          new URL('../../dist/storage/harness-lifecycle-codecs.js', import.meta.url).href,
        ],
      },
    }
  );
  onTestFinished(async () => {
    await worker.terminate();
    if (reader.open) reader.close();
    rmSync(root, { recursive: true, force: true });
  });

  function submit<Value>(command: Command): Promise<Value> {
    const { port1, port2 } = new MessageChannel();
    return new Promise<Value>((resolve, reject) => {
      const remove = () => {
        port1.close();
        worker.off('error', fail);
        worker.off('exit', exited);
      };
      const fail = (error: Error) => {
        remove();
        reject(error);
      };
      const exited = () =>
        fail(new Error('NanoHost fixture worker exited before its acknowledgement.'));
      worker.once('error', fail);
      worker.once('exit', exited);
      port1.once('message', (reply) => {
        remove();
        if (reply.ok) resolve(reply.value as Value);
        else reject(Object.assign(new Error(reply.message), { code: reply.code }));
      });
      worker.postMessage({ command, port: port2 }, [port2]);
    });
  }

  const epoch: NanoHostRuntimeTargetEpochStore = {
    inspectRuntimeTargetTransition: async (input) =>
      inspectNanoHostRuntimeTargetTransition(reader, input),
    readEpochInvalidation: async (requestId) =>
      ready(readNanoHostEpochInvalidation(reader, requestId)),
    beginEpochRetirement: async (input) => ready(await submit<void>({ kind: 'begin', input })),
    stageEpochInvalidation: async (input) => ready(await submit<void>({ kind: 'stage', input })),
    settleEpochInvalidation: async (input) => ready(await submit<void>({ kind: 'settle', input })),
    mutateRuntimeTarget: (input) =>
      submit<StorageResult<'nanohost', ControlRuntimeTargetResult>>({ kind: 'target', input }),
  };

  // These fixtures exercise the native store. The real Core deciding transaction has its own suites.
  const receipts = new Map<string, NanoHostEpochReceipt>();
  const kernel: NanoHostRuntimeTargetEpochKernel = {
    async reserveHolderIntent(placement) {
      const occurrence = vaultEpochFenceOccurrence(placement);
      const target = {
        runtimeTargetId: placement.runtimeTargetId,
        physicalEpoch: placement.physicalEpoch,
        holderReceiptIds: [],
      };
      return ready({
        ...occurrence,
        requestId: storageRequestId(occurrence),
        expectedGeneration: placement.generation,
        inputDigest: sha256CanonicalJson(target),
        target,
      });
    },
    async inspectNanoHostEpochFence(intent) {
      const receipt = receipts.get(intent.requestId);
      return ready(receipt ? { state: 'settled', receipt } : { state: 'absent' });
    },
    async fenceNanoHostEpoch(intent) {
      const result = { fencedHolderReceiptIds: [] };
      const receipt = {
        intent,
        result,
        disposition: 'applied' as const,
        receiptDigest: sha256CanonicalJson({ intent, result }),
      };
      receipts.set(intent.requestId, receipt);
      return ready({ state: 'settled', receipt });
    },
  };
  const storage: AdmittedNanoHostTransportStorage = {
    kernel,
    owner: {
      read: (read) => ready(read(reader)),
      transport: (input) => {
        if (
          input.kind === 'lifecycle-audit' ||
          input.kind === 'decommission-audit' ||
          ('actor' in input && input.actor)
        )
          throw new Error('This NanoHost fixture accepts owner-local transport tuples.');
        return submit<ControlNanoHostTransportResult>({ kind: 'transport', input });
      },
      harnessLifecycle: async (input) => {
        await submit<null>({ kind: 'harness', input });
      },
      transitionRuntimeTarget: (authority, original) =>
        transitionNanoHostRuntimeTarget(epoch, authority, original),
    },
  };

  return {
    storage,
    get sqlite() {
      return reader;
    },
    async transition(input: ControlRuntimeTargetInput) {
      const result = await transitionAdmittedNanoHostRuntimeTarget(storage, input);
      if (result.state !== 'ready') throw new Error(result.reason);
      return result.value;
    },
    async reopen() {
      await submit<void>({ kind: 'reopen' });
      reader.close();
      reader = openReader();
    },
    setup(write: (sqlite: Database.Database) => void) {
      const fixture = new Database(path, { fileMustExist: true });
      try {
        fixture.pragma('foreign_keys = ON');
        fixture.transaction(() => write(fixture)).immediate();
      } finally {
        fixture.close();
      }
    },
  };
}
