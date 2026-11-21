import type { z } from 'zod';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type {
  ControlHarnessLifecycleInput,
  ControlHarnessLifecycleInputSchema,
} from '../storage/harness-lifecycle-codecs.js';
import type { AdmittedNanoHostTransportStorage } from '../storage/nanohost-transport-owner.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import type * as Records from './nanohost-harness-records.js';

export {
  type CreateNanoHostHarnessRuntimeInput,
  type DispatchNanoHostHarnessOperationInput,
  deriveNanoHostAgentSessionCompatibilityKey,
  type ExpireNanoHostHarnessQueuedOperationInput,
  type FenceNanoHostSandboxRuntimeInput,
  type InspectNanoHostAgentSessionContinuityInput,
  inspectNanoHostAgentSessionContinuity,
  listNanoHostMeasuredHarnessIdentities,
  type MarkNanoHostHarnessOperationUnknownInput,
  NANO_HOST_HARNESS_OPERATIONS,
  NANO_HOST_HARNESS_RESULT_BUDGET_MS,
  type NanoHostAgentSessionContinuityInspection,
  type NanoHostHarnessCommand,
  type NanoHostHarnessOperation,
  type NanoHostHarnessResult,
  type NanoHostHarnessResultSettlement,
  type OpenNanoHostAgentSessionBindingInput,
  type PreparedNanoHostHarnessOperation,
  type PrepareNanoHostHarnessOperationInput,
  prepareNanoHostHarnessOperation,
  type QueueNanoHostHarnessOperationInput,
  readConsumedNanoHostHarnessResult,
  readNanoHostHarnessCloseReceiver,
  readNanoHostIdleCloseAuthority,
  readNanoHostMeasuredHarnessIdentity,
  readNanoHostThreadAgentSessionBinding,
  type SettleNanoHostHarnessOperationInput,
} from './nanohost-harness-records.js';

/** Opens the existing Core FIFO before posting an exact Harness lifecycle tuple. */
async function harnessWriter(coreDb: CoreDb) {
  const scope = nativeProductScope(coreDb.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: coreDb.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  return { client, database };
}

/** Publishes a caller-owned snapshot through the one physical Core writer and covering FULL ACK. */
async function publishHarness(coreDb: CoreDb, input: ControlHarnessLifecycleInput) {
  const snapshot = structuredClone(input);
  const { client, database } = await harnessWriter(coreDb);
  return client.harnessLifecycle(database, snapshot);
}

type LocalHarnessWriter = Pick<AdmittedNanoHostTransportStorage['owner'], 'harnessLifecycle'>;

function publishLocalHarness(
  owner: CoreDb | LocalHarnessWriter,
  input: z.output<typeof ControlHarnessLifecycleInputSchema.nanoHostLocal>
): Promise<unknown> {
  return 'harnessLifecycle' in owner
    ? owner.harnessLifecycle(structuredClone(input))
    : publishHarness(owner, input);
}

/** Commits the runtime and its Sandbox through the selected writer before returning. */
export async function createNanoHostHarnessRuntime(
  writer: CoreDb | LocalHarnessWriter,
  input: Parameters<typeof Records.createNanoHostHarnessRuntime>[1]
): Promise<void> {
  await publishLocalHarness(writer, { ...input, kind: 'runtime.create' });
}

/** Commits the sandbox.remove-for-harness tuple through the selected writer before returning. */
export async function removeNanoHostSandboxRuntimeForHarness(
  writer: CoreDb | LocalHarnessWriter,
  harnessInstanceId: Parameters<typeof Records.removeNanoHostSandboxRuntimeForHarness>[1]
): Promise<void> {
  await publishLocalHarness(writer, {
    ...{ harnessInstanceId },
    kind: 'sandbox.remove-for-harness',
  });
}

/** Commits the sandbox.remove-by-binding tuple through the selected writer before returning. */
export async function removeNanoHostSandboxRuntimeByBinding(
  writer: CoreDb | LocalHarnessWriter,
  sandboxBindingRef: Parameters<typeof Records.removeNanoHostSandboxRuntimeByBinding>[1]
): Promise<void> {
  await publishLocalHarness(writer, {
    ...{ sandboxBindingRef },
    kind: 'sandbox.remove-by-binding',
  });
}

/** Commits the harness.drain tuple through the selected writer before returning. */
export async function drainNanoHostHarnessAdmission(
  writer: CoreDb | LocalHarnessWriter,
  input: Parameters<typeof Records.drainNanoHostHarnessAdmission>[1]
): Promise<void> {
  await publishLocalHarness(writer, { ...input, kind: 'harness.drain' });
}

/** Commits the sandbox.drain tuple through the selected writer before returning. */
export async function drainNanoHostSandboxAdmission(
  writer: CoreDb | LocalHarnessWriter,
  input: Parameters<typeof Records.drainNanoHostSandboxAdmission>[1]
): Promise<void> {
  await publishLocalHarness(writer, { ...input, kind: 'sandbox.drain' });
}

/** Commits the sandbox.fence tuple through the selected writer before returning. */
export async function fenceNanoHostSandboxRuntime(
  writer: CoreDb | LocalHarnessWriter,
  input: Parameters<typeof Records.fenceNanoHostSandboxRuntime>[1]
): Promise<void> {
  await publishLocalHarness(writer, { ...input, kind: 'sandbox.fence' });
}

/** Commits the session-binding.open tuple through the selected writer before returning. */
export async function openNanoHostAgentSessionBinding(
  writer: CoreDb | LocalHarnessWriter,
  input: Parameters<typeof Records.openNanoHostAgentSessionBinding>[1]
): Promise<void> {
  await publishLocalHarness(writer, { ...input, kind: 'session-binding.open' });
}

/** Commits the measured-identity.copy tuple through the selected writer before returning. */
export async function copyNanoHostMeasuredHarnessIdentity(
  writer: CoreDb | LocalHarnessWriter,
  input: Parameters<typeof Records.copyNanoHostMeasuredHarnessIdentity>[1]
): Promise<void> {
  await publishLocalHarness(writer, { ...input, kind: 'measured-identity.copy' });
}

/** Split live Harness decisions bound to one acknowledged Core and NanoHost pair. */
export interface AdmittedNanoHostHarnessTurnLifecycle {
  queue(input: Parameters<typeof Records.queueNanoHostHarnessOperation>[1]): Promise<number>;
  dispatch(
    input: Parameters<typeof Records.dispatchNanoHostHarnessOperation>[1]
  ): Promise<Records.NanoHostHarnessCommand | null>;
  settle(
    input: Parameters<typeof Records.settleNanoHostHarnessOperation>[1]
  ): Promise<'settled' | 'replayed'>;
  acknowledge(input: Parameters<typeof Records.acknowledgeNanoHostHarnessResult>[1]): Promise<void>;
}

/** Queues only the exact prepared tuple; existing enqueue diagnostics include the owning FULL acknowledgement. */
export async function queueNanoHostHarnessOperation(
  coreDb: CoreDb,
  input: Parameters<typeof Records.queueNanoHostHarnessOperation>[1],
  admitted?: AdmittedNanoHostHarnessTurnLifecycle
): Promise<number> {
  const startedAt = performance.now();
  try {
    if (admitted) return await admitted.queue(input);
    return (await publishHarness(coreDb, {
      kind: 'operation.queue',
      prepared: input.prepared,
      body: input.body,
      harnessInstanceId: input.harnessInstanceId,
      operation: input.operation,
      timestamp: input.timestamp,
    })) as number;
  } finally {
    try {
      const durationMs = performance.now() - startedAt;
      if (durationMs >= 100)
        console.error(
          JSON.stringify({
            stage: 'harness-enqueue',
            durationMs: Math.round(durationMs),
            timestamp: new Date().toISOString(),
            harnessInstanceId: input.harnessInstanceId,
          })
        );
    } catch {
      // Diagnostics must not change the owning operation.
    }
  }
}

/** Commits the existing operation.dispatch tuple through the Core owner before returning. */
export async function dispatchNanoHostHarnessOperation(
  coreDb: CoreDb,
  input: Parameters<typeof Records.dispatchNanoHostHarnessOperation>[1]
): Promise<Records.NanoHostHarnessCommand | null> {
  const { sandboxIntegrationBindingRef, now } = input;
  const { client, database } = await harnessWriter(coreDb);
  return (await client.harnessLifecycle(database, {
    kind: 'operation.dispatch',
    sandboxIntegrationBindingRef,
    ...(now ? { observedAt: now() } : {}),
  })) as Records.NanoHostHarnessCommand | null;
}

/** Commits the operation.expire tuple through the selected writer before returning. */
export async function expireNanoHostHarnessQueuedOperation(
  writer: CoreDb | LocalHarnessWriter,
  input: Parameters<typeof Records.expireNanoHostHarnessQueuedOperation>[1]
): Promise<void> {
  await publishLocalHarness(writer, { ...input, kind: 'operation.expire' });
}

/** Commits the existing operation.settle tuple through the Core owner before returning. */
export async function settleNanoHostHarnessOperation(
  coreDb: CoreDb,
  input: Parameters<typeof Records.settleNanoHostHarnessOperation>[1],
  admitted?: AdmittedNanoHostHarnessTurnLifecycle
): Promise<'settled' | 'replayed'> {
  if (admitted) return admitted.settle(input);
  return (await publishHarness(coreDb, { ...input, kind: 'operation.settle' })) as
    | 'settled'
    | 'replayed';
}

/** Commits the operation.unknown tuple through the selected writer before returning. */
export async function markNanoHostHarnessOperationUnknown(
  writer: CoreDb | LocalHarnessWriter,
  input: Parameters<typeof Records.markNanoHostHarnessOperationUnknown>[1]
): Promise<void> {
  await publishLocalHarness(writer, { ...input, kind: 'operation.unknown' });
}

/** Commits the existing result.acknowledge tuple through the Core owner before returning. */
export async function acknowledgeNanoHostHarnessResult(
  coreDb: CoreDb,
  input: Parameters<typeof Records.acknowledgeNanoHostHarnessResult>[1],
  admitted?: AdmittedNanoHostHarnessTurnLifecycle
): Promise<void> {
  if (admitted) return admitted.acknowledge(input);
  await publishHarness(coreDb, { ...input, kind: 'result.acknowledge' });
}

/** Restores only the current healthy resident after native current capture dispositions and the covering FULL commit. */
export async function restoreNanoHostSandboxAdmissionIfSafe(
  coreDb: CoreDb,
  input: { readonly sandboxRuntimeId: string }
): Promise<void> {
  await publishHarness(coreDb, { ...input, kind: 'sandbox.restore-admission' });
}

/** Claims the existing reversible whole-Sandbox drain after the caller's durable proof handoff. */
export async function claimNanoHostIdleSandboxDrain(
  coreDb: CoreDb,
  input: Omit<Extract<ControlHarnessLifecycleInput, { kind: 'sandbox.claim-idle-drain' }>, 'kind'>
): Promise<void> {
  await publishHarness(coreDb, { ...input, kind: 'sandbox.claim-idle-drain' });
}

/** Claims only the exact healthy Harness drain after its Workspace capture recovery acknowledgement. */
export async function claimNanoHostIdleCaptureDrain(
  coreDb: CoreDb,
  input: Omit<
    Extract<ControlHarnessLifecycleInput, { kind: 'harness.claim-idle-capture-drain' }>,
    'kind'
  >
): Promise<void> {
  await publishHarness(coreDb, { ...input, kind: 'harness.claim-idle-capture-drain' });
}

/** Publishes the new binding's exact original environment comparison lineage after the covering FULL commit. */
export async function initializeNanoHostRuntimeCheckVersions(
  writer: CoreDb | LocalHarnessWriter,
  input: Omit<
    Extract<ControlHarnessLifecycleInput, { kind: 'session-binding.initialize-check-versions' }>,
    'kind'
  >
): Promise<void> {
  await publishLocalHarness(writer, {
    ...input,
    kind: 'session-binding.initialize-check-versions',
  });
}
/** Appends only one original credential replacement lineage after exact current-value comparison and FULL commit. */
export async function appendNanoHostRuntimeCheckVersion(
  writer: CoreDb | LocalHarnessWriter,
  input: Omit<
    Extract<ControlHarnessLifecycleInput, { kind: 'session-binding.append-check-version' }>,
    'kind'
  >
): Promise<void> {
  await publishLocalHarness(writer, { ...input, kind: 'session-binding.append-check-version' });
}
