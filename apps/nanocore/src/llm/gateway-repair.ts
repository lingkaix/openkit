import { isDeepStrictEqual } from 'node:util';
import type { AuditEvent } from '@openkit/protocol';
import type {
  ControlKernelStore,
  RepairCallInspection,
  RepairCallIntent,
  RepairCallOutcome,
  RepairCallReservation,
} from '../storage/control-kernel-port.js';
import type { StorageResult } from '../storage/storage-owner.js';
import type { LLMGatewayTransportContext } from './provider-dispatcher.js';

type RepairTransport = Required<
  Pick<LLMGatewayTransportContext, 'singleAttempt' | 'finalRequestAdmission'>
>;
type RepairProviderResult<Reply> = Omit<RepairCallOutcome, 'disposition'> &
  (
    | { readonly disposition: 'succeeded'; readonly reply: Reply }
    | { readonly disposition: 'failed' | 'unknown' }
  );
type RepairResult<Reply> =
  | RepairCallInspection
  | { readonly state: 'failed'; readonly auditEventId: AuditEvent['id'] }
  | { readonly state: 'succeeded'; readonly auditEventId: AuditEvent['id']; readonly reply: Reply };

const unknown = { state: 'ready', value: { state: 'unknown' } } as const;

/** Runs one prepared trusted repair invocation under its original kernel reservation. */
export async function runRepairModelCall<Reply>(input: {
  readonly intent: RepairCallIntent;
  readonly kernel?: Pick<
    ControlKernelStore,
    'reserveRepairCall' | 'inspectRepairCall' | 'settleRepairCall'
  >;
  /** Rechecks the prepared route and credential against the final Gateway payload. */
  readonly checkCurrentAuthority: (
    reservation: RepairCallReservation,
    ...request: Parameters<RepairTransport['finalRequestAdmission']>
  ) => Promise<'allowed' | 'policy' | 'vault'>;
  /** The trusted planner's pinned route uses this transport at its final contact boundary. */
  readonly invoke: (transport: RepairTransport) => Promise<RepairProviderResult<Reply>>;
}): Promise<StorageResult<'control-kernel', RepairResult<Reply>>> {
  const { intent, kernel } = input;
  if (!kernel) return { state: 'unavailable', owner: 'control-kernel', reason: 'disabled' };

  const inspectOriginal = () =>
    Promise.resolve()
      .then(() => kernel.inspectRepairCall(intent))
      .catch(() => unknown);
  const reserve = await Promise.resolve()
    .then(() => kernel.reserveRepairCall(intent))
    .catch(() => null);
  if (
    reserve === null ||
    (reserve.state === 'unavailable' && reserve.reason === 'recovery-required') ||
    (reserve.state === 'ready' && reserve.value.state === 'unknown')
  )
    return inspectOriginal();
  if (reserve.state === 'unavailable') return reserve;
  if (reserve.value.state === 'refused') {
    const original = await inspectOriginal();
    if (
      original.state === 'ready' &&
      (original.value.state === 'reserved' || original.value.state === 'terminal')
    )
      return original;
  }
  if (reserve.value.state !== 'reserved-now') return { state: 'ready', value: reserve.value };

  const { reservation } = reserve.value;
  if (
    !isDeepStrictEqual(reservation.intent, intent) ||
    !isDeepStrictEqual(reservation.result.step.execution, intent.target.entryStep.execution) ||
    reservation.result.step.stepId === intent.target.entryStep.stepId
  )
    return { state: 'ready', value: { state: 'conflict' } };

  const contact: { checked: boolean; verdict?: 'allowed' | 'policy' | 'vault' } = {
    checked: false,
  };
  const response = await Promise.resolve()
    .then(() =>
      input.invoke({
        singleAttempt: true,
        finalRequestAdmission: async (...request) => {
          if (contact.checked) throw new Error('The repair contact was already checked.');
          contact.checked = true;
          contact.verdict = await input.checkCurrentAuthority(reservation, ...request);
          if (contact.verdict !== 'allowed') throw new Error('Repair authority was refused.');
        },
      })
    )
    .catch(() => null);
  const denied =
    contact.verdict === 'policy' || contact.verdict === 'vault' ? contact.verdict : null;
  const observed = contact.verdict === 'allowed' ? response : null;
  const outcome: RepairCallOutcome = {
    disposition: denied ? 'failed' : (observed?.disposition ?? 'unknown'),
    ...(observed?.inputTokens !== undefined &&
    Number.isSafeInteger(observed.inputTokens) &&
    observed.inputTokens >= 0
      ? { inputTokens: observed.inputTokens }
      : {}),
    ...(observed?.outputTokens !== undefined &&
    Number.isSafeInteger(observed.outputTokens) &&
    observed.outputTokens >= 0
      ? { outputTokens: observed.outputTokens }
      : {}),
  };
  const settled = await Promise.resolve()
    .then(() => kernel.settleRepairCall(reservation, outcome))
    .catch(() => null);
  if (!settled) return unknown;
  if (settled.state === 'unavailable') return settled;
  if (settled.value.state !== 'settled') return unknown;

  const auditEventId = settled.value.receipt;
  if (denied) return { state: 'ready', value: { state: 'refused', reason: denied } };
  if (observed?.disposition === 'succeeded')
    return { state: 'ready', value: { state: 'succeeded', auditEventId, reply: observed.reply } };
  if (observed?.disposition === 'failed')
    return { state: 'ready', value: { state: 'failed', auditEventId } };
  return unknown;
}
