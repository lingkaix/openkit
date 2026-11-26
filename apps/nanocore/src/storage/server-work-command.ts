import { isDeepStrictEqual } from 'node:util';
import type { GatewayRouteLineageEntry } from '@openkit/protocol';
import { OperationError } from '../operation-error-core.js';
import type { ControlKernelStore } from './control-kernel-port.js';
import { frameControlScalarText } from './control-store-input.js';
import type {
  ControlProductEntry,
  ControlProductMutation,
} from './control-store-product-records.js';
import type { stageServerKnowledgeAdmission } from './server-work-admission.js';
import type { ServerCallUsage } from './server-work-call.js';
import type {
  ServerCallAdmission,
  ServerWorkIntent,
  ServerWorkReceipt,
  ServerWorkStore,
} from './server-work-port.js';
import {
  type StorageDecision,
  type StorageReceiptLookup,
  type StorageResult,
  storageRequestId,
} from './storage-owner.js';
import type {
  ControlWorkObservationPreparation,
  ControlWorkObservationResult,
  RetainedWorkObservation,
} from './work-observations.js';

type Kernel = Pick<ControlKernelStore, 'decideServerWork' | 'inspectServerWork'>;

/** App injects the admitted native owner and the separately admitted exact Core decision. */
export interface ServerWorkCommandBinding {
  readonly deploymentId: string;
  readonly owner: Omit<ServerWorkStore, 'stage'> & {
    stage<Intent extends ServerWorkIntent>(
      intent: Intent,
      payload: string
    ): Promise<StorageResult<'server-work', Intent>>;
    readLocalReceipt(
      requestId: string
    ): Promise<StorageResult<'server-work', ServerWorkReceipt | null>>;
    stageKnowledge?(
      command: Parameters<typeof stageServerKnowledgeAdmission>[1]
    ): Promise<StorageResult<'server-work', ReturnType<typeof stageServerKnowledgeAdmission>>>;
    readUsageIds?(
      receipt: ServerWorkReceipt<ServerCallUsage>
    ): Promise<StorageResult<'server-work', string[] | null>>;
    writeRouteLineage?(
      receipt: AppliedServerWorkReceipt<ServerCallAdmission>,
      input: {
        readonly logicalModelId: string;
        readonly entry: GatewayRouteLineageEntry;
        readonly entryIndex?: number;
      }
    ): Promise<StorageResult<'server-work', number>>;
    publishTurnProgress?(
      admission: ServerWorkIntent & { readonly verb: 'admit-turn' },
      input: {
        readonly products: readonly ControlProductMutation[];
        readonly entries: readonly ControlProductEntry[];
      }
    ): Promise<StorageResult<'server-work', void>>;
    appendObservation?(
      admission: ServerWorkIntent & { readonly verb: 'admit-turn' },
      input: ControlWorkObservationPreparation
    ): Promise<
      StorageResult<
        'server-work',
        | Pick<RetainedWorkObservation, 'disposition' | 'observation'>
        | Exclude<ControlWorkObservationResult, RetainedWorkObservation>
      >
    >;
  };
  readonly kernel: Kernel & Pick<ControlKernelStore, 'status'>;
  /** Holds the original Server producer through the covering native acknowledgement. */
  withProducer?<Value>(effect: () => Promise<Value>): Promise<Value>;
  /** The live actor, credential, pinned route and budget must still allow the effect. */
  readonly verifyCallAuthority?: (intent: ServerCallAdmission) => boolean | Promise<boolean>;
  /** Live permission correlation for credential-bearing ordinary Server calls. */
  readonly callBudgetRef?: (input: {
    readonly actor: ServerCallAdmission['target']['actor'];
    readonly credentialRef: string | null;
    readonly routeRef: string;
  }) => string | null | Promise<string | null>;
}

/** Both exact storage owners must be available before a live caller prepares or stages work. */
export function serverWorkBindingAvailable(
  binding: ServerWorkCommandBinding | undefined
): binding is ServerWorkCommandBinding {
  return binding?.owner.status().state === 'ready' && binding.kernel.status().state === 'ready';
}

/** Enrolls one entire operation in the acknowledged Server writer's backup exclusion. */
export async function withServerWorkProducer<Value>(
  binding: Pick<ServerWorkCommandBinding, 'withProducer'> | undefined,
  effect: () => Promise<Value>
): Promise<Value> {
  return binding?.withProducer ? binding.withProducer(effect) : effect();
}

export type AppliedServerWorkReceipt<I extends ServerWorkIntent> = Extract<
  ServerWorkReceipt<I>,
  { disposition: 'applied' }
>;

/** Frames the original proposed occurrence and exact scalar payload with the frozen A1 identity. */
export function serverWorkIntent<
  Verb extends ServerWorkIntent['verb'],
  Target extends Pick<ServerWorkIntent['target'], 'actor' | 'credentialRef'>,
>(
  binding: Pick<ServerWorkCommandBinding, 'deploymentId'>,
  verb: Verb,
  occurrenceKey: string,
  expectedGeneration: string | null,
  target: Target,
  payload: string
) {
  const occurrence = {
    deploymentId: binding.deploymentId,
    sourceOwner: 'server-work',
    verb,
    occurrenceKey,
  } as const;
  const requestId = storageRequestId(occurrence);
  return {
    ...occurrence,
    requestId,
    expectedGeneration,
    inputDigest: frameControlScalarText(payload).digest,
    target: { ...target, recordRef: requestId },
  };
}

/** Returns the applied original receipt after local publication and its covering ACK. */
export async function publishServerWorkDraft<I extends ServerWorkIntent>(
  binding: ServerWorkCommandBinding,
  intent: I,
  payload: string
): Promise<AppliedServerWorkReceipt<I>> {
  if (!serverWorkBindingAvailable(binding)) throw serverWorkUnavailable();
  const result = await publishServerWorkCommand({
    intent,
    kernel: binding.kernel,
    store: {
      stage: (value) => binding.owner.stage(value, payload),
      settle: (receipt) => binding.owner.settle(receipt),
      isPublished: (receipt) => binding.owner.isPublished(receipt),
      readLocalReceipt: (requestId) => binding.owner.readLocalReceipt(requestId),
    },
  });
  return requireAppliedServerWork(result);
}

/** A caller may act only after an applied receipt and covering owner publication. */
export function requireAppliedServerWork<I extends ServerWorkIntent>(
  result: StorageResult<'server-work' | 'control-kernel', StorageDecision<ServerWorkReceipt<I>>>
): AppliedServerWorkReceipt<I> {
  if (result.state === 'unavailable') throw serverWorkUnavailable();
  if (result.value.state !== 'settled')
    throw new OperationError('recovery_required', 'Inspect the original Server work outcome.', 409);
  if (result.value.receipt.disposition !== 'applied')
    throw new OperationError(
      'server_work_refused',
      'Server work authority refused the operation.',
      403
    );
  return result.value.receipt;
}

/** Refuses a Server operation before it can use an unbound product or Call owner. */
export function serverWorkUnavailable(): OperationError {
  return new OperationError('operation_storage_unavailable', 'Server work is unavailable.', 503);
}

/** Stages the owner draft, recovers the original kernel decision and acknowledges publication. */
export async function publishServerWorkCommand<Intent extends ServerWorkIntent>(input: {
  readonly intent: Intent;
  readonly store?: Pick<ServerWorkStore, 'stage' | 'settle' | 'isPublished'> & {
    readLocalReceipt(
      requestId: string
    ): Promise<StorageResult<'server-work', ServerWorkReceipt | null>>;
  };
  readonly kernel?: Kernel;
}): Promise<
  StorageResult<'server-work' | 'control-kernel', StorageDecision<ServerWorkReceipt<Intent>>>
> {
  const { intent, store, kernel } = input;
  if (!store || !kernel) return { state: 'unavailable', owner: 'server-work', reason: 'disabled' };

  const staged = await store.stage(intent);
  if (staged.state === 'unavailable') return staged;
  if (!isDeepStrictEqual(staged.value, intent))
    return { state: 'ready', value: { state: 'conflict' } };

  return settleStagedServerWorkCommand(intent, store, kernel);
}

/** Joins a draft assigned and already committed by the Server Knowledge singleton owner. */
export async function settleStagedServerWorkCommand<Intent extends ServerWorkIntent>(
  intent: Intent,
  store: Pick<ServerWorkCommandBinding['owner'], 'readLocalReceipt' | 'settle' | 'isPublished'>,
  kernel: Kernel
): Promise<
  StorageResult<'server-work' | 'control-kernel', StorageDecision<ServerWorkReceipt<Intent>>>
> {
  const local = await store.readLocalReceipt(intent.requestId);
  if (local.state === 'unavailable') return local;

  // A settled owner beside an older kernel can only inspect. A fresh decision is unsafe.
  let inspected: StorageResult<'control-kernel', StorageReceiptLookup<ServerWorkReceipt<Intent>>>;
  if (local.value) {
    inspected = await kernel.inspectServerWork(intent);
  } else {
    const decision = await Promise.resolve()
      .then(() => kernel.decideServerWork(intent))
      .catch(
        (): StorageResult<'control-kernel', StorageDecision<ServerWorkReceipt<Intent>>> => ({
          state: 'ready',
          value: { state: 'unknown' },
        })
      );
    if (decision.state === 'unavailable') return decision;
    inspected =
      decision.value.state === 'unknown' ? await kernel.inspectServerWork(intent) : decision;
  }
  if (inspected.state === 'unavailable') return inspected;
  if (inspected.value.state === 'absent') return { state: 'ready', value: { state: 'unknown' } };
  if (inspected.value.state !== 'settled') return { state: 'ready', value: inspected.value };

  const { receipt } = inspected.value;
  if (
    !isDeepStrictEqual(receipt.intent, intent) ||
    (local.value && !isDeepStrictEqual(local.value, receipt))
  )
    return { state: 'ready', value: { state: 'conflict' } };
  if (local.value) return { state: 'ready', value: inspected.value };
  // Read the original publication after a lost owner ACK. Unproved publication stays unknown.
  const settled = await Promise.resolve()
    .then(() => store.settle(receipt))
    .catch(() => null);
  if (settled?.state === 'unavailable') return settled;
  if (!settled) {
    if (receipt.disposition === 'refused') return { state: 'ready', value: { state: 'unknown' } };
    const published = await store.isPublished(receipt);
    if (published.state === 'unavailable') return published;
    if (!published.value) return { state: 'ready', value: { state: 'unknown' } };
  }
  return { state: 'ready', value: inspected.value };
}
