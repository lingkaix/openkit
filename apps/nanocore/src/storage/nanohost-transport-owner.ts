import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { z } from 'zod';
import type {
  ControlNanoHostTransportInput,
  ControlNanoHostTransportResult,
} from '../auth/nanohost-transport-codecs.js';
import type { NanoHostRuntimeTargetRecord } from '../runtime/nanohost-runtime-target-records.js';
import { ControlStoreWorkerError } from './control-store-worker-error.js';
import type { ControlHarnessLifecycleInputSchema } from './harness-lifecycle-codecs.js';
import type { NanoHostRuntimeTargetEpochKernel } from './nanohost-epoch-invalidation.js';
import {
  type NanoHostRuntimeTargetTransition,
  prepareNanoHostRuntimeTargetTransition,
} from './nanohost-epoch-invalidation-native.js';
import type {
  ControlRuntimeTargetInput,
  ControlRuntimeTargetResult,
} from './runtime-target-codecs.js';
import type { StorageResult } from './storage-owner.js';

/** The private A2 binding keeps all transport reads on its acknowledged NanoHost generation. */
export interface AdmittedNanoHostTransportStorage {
  readonly owner: {
    read<Value>(query: (sqlite: Database.Database) => Value): StorageResult<'nanohost', Value>;
    afterWorkerControlAcknowledgement?<Value>(
      read: () => Value | Promise<Value>,
      signal?: AbortSignal
    ): Promise<Value>;
    /** Reads only the admitted RuntimeTarget when a separate Native write is awaiting its ACK. */
    readRuntimeTarget?(
      targetId: string
    ): StorageResult<'nanohost', NanoHostRuntimeTargetRecord | null>;
    transport(input: ControlNanoHostTransportInput): Promise<ControlNanoHostTransportResult>;
    harnessLifecycle(
      input: z.output<typeof ControlHarnessLifecycleInputSchema.nanoHostLocal>
    ): Promise<void>;
    transitionRuntimeTarget(
      kernel: NanoHostRuntimeTargetEpochKernel,
      original: NanoHostRuntimeTargetTransition
    ): Promise<StorageResult<'nanohost' | 'control-kernel', ControlRuntimeTargetResult>>;
  };
  readonly kernel: NanoHostRuntimeTargetEpochKernel;
}

/** Captures a distinct authenticated transport occurrence before submitting its original tuple. */
export async function transitionAdmittedNanoHostRuntimeTarget(
  { owner, kernel }: AdmittedNanoHostTransportStorage,
  input: ControlRuntimeTargetInput
): Promise<StorageResult<'nanohost' | 'control-kernel', ControlRuntimeTargetResult>> {
  const occurrenceId = randomUUID();
  const submit = async () => {
    const original = owner.read((sqlite) =>
      prepareNanoHostRuntimeTargetTransition(sqlite, input, occurrenceId)
    );
    return original.state === 'ready'
      ? await owner.transitionRuntimeTarget(kernel, original.value)
      : original;
  };
  try {
    return await (owner.afterWorkerControlAcknowledgement?.(submit) ?? submit());
  } catch (error) {
    if (error instanceof ControlStoreWorkerError)
      return { state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' };
    throw error;
  }
}
