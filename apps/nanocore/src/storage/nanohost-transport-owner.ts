import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { z } from 'zod';
import type {
  ControlNanoHostTransportInput,
  ControlNanoHostTransportResult,
} from '../auth/nanohost-transport-codecs.js';
import type { NanoHostRuntimeTargetRecord } from '../runtime/nanohost-runtime-target-records.js';
import { ControlStoreWorkerError } from './control-store-worker-error.js';
import type {
  ControlCoreJournalInput,
  SandboxReleaseRefusalAttachmentSchema,
} from './core-journal-codecs.js';
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

export interface NanoHostReleaseRefusal {
  record(
    input: Extract<ControlCoreJournalInput, { kind: 'sandbox-release-refusal' }>
  ): Promise<void>;
  reconcile(): Promise<readonly string[]>;
  handoff(
    input: Extract<ControlCoreJournalInput, { kind: 'sandbox-release-refusal-handoff' }>,
    attachment: z.output<typeof SandboxReleaseRefusalAttachmentSchema> | null
  ): Promise<void>;
  withCarriage<Value>(
    integrationBindingRef: string,
    sandboxBindingRef: string,
    handoff: (fenced: boolean) => Value
  ): Promise<Value>;
}

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
    readonly releaseRefusal?: NanoHostReleaseRefusal;
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

/** A Native owner read could not cross the existing serving ACK boundary. */
export class NanoHostAcknowledgementUnavailable extends Error {
  constructor(cause: ControlStoreWorkerError) {
    super('NanoHost acknowledged storage is unavailable.', { cause });
  }
}

/** Reuses the serving owner's bounded wait without changing synchronous fixture reads. */
export function afterAdmittedNanoHostAcknowledgement<Value>(
  storage: AdmittedNanoHostTransportStorage | undefined,
  read: () => Value,
  signal?: AbortSignal
): Value | Promise<Value> {
  const owner = storage?.owner;
  if (!owner?.afterWorkerControlAcknowledgement) return read();
  return owner.afterWorkerControlAcknowledgement(read, signal).catch((error: unknown) => {
    if (error instanceof ControlStoreWorkerError)
      throw new NanoHostAcknowledgementUnavailable(error);
    throw error;
  });
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
