import type { CommunicationStore } from './communication-port.js';
import type { ControlKernelStore } from './control-kernel-port.js';
import type { StorageResult, StorageUnavailable } from './storage-owner.js';

/** Inspects and relays one local fact. Pending means local Audit still awaits an exact applied receipt. */
export async function relayNextPairingAudit(
  communication: Pick<CommunicationStore, 'readPendingPairingAudit' | 'settlePairingAudit'>,
  kernel: Pick<ControlKernelStore, 'inspectPairingAudit' | 'relayPairingAudit'>
): Promise<
  | StorageResult<'communication', 'idle' | 'pending' | 'relayed'>
  | StorageUnavailable<'control-kernel'>
> {
  const next = await communication.readPendingPairingAudit();
  if (next.state !== 'ready') return next;
  if (!next.value) return { state: 'ready', value: 'idle' };

  const { relay, audit } = next.value;
  const inspected = await kernel.inspectPairingAudit(relay);
  if (inspected.state !== 'ready') return inspected;
  // A prior post may have committed even when its acknowledgement never reached this owner.
  const result =
    inspected.value.state === 'absent' ? await kernel.relayPairingAudit(relay, audit) : inspected;
  if (result.state !== 'ready') return result;
  if (result.value.state !== 'settled' || result.value.receipt.disposition !== 'applied') {
    return { state: 'ready', value: 'pending' };
  }

  if (result.value.receipt.result.eventId !== audit.id) {
    throw new Error('Kernel receipt names a different communication Audit event.');
  }

  const settled = await communication.settlePairingAudit(result.value.receipt);
  return settled.state === 'ready' ? { state: 'ready', value: 'relayed' } : settled;
}
