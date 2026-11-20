import { isDeepStrictEqual } from 'node:util';
import type { ControlKernelStore } from './control-kernel-port.js';
import type { ServerWorkIntent, ServerWorkReceipt, ServerWorkStore } from './server-work-port.js';
import type { StorageDecision, StorageReceiptLookup, StorageResult } from './storage-owner.js';

/** Stages the owner draft, recovers the original kernel decision and acknowledges publication. */
export async function publishServerWorkCommand<Intent extends ServerWorkIntent>(input: {
  readonly intent: Intent;
  readonly store?: Pick<ServerWorkStore, 'stage' | 'settle' | 'isPublished'> & {
    readLocalReceipt(
      requestId: string
    ): Promise<StorageResult<'server-work', ServerWorkReceipt | null>>;
  };
  readonly kernel?: Pick<ControlKernelStore, 'decideServerWork' | 'inspectServerWork'>;
}): Promise<
  StorageResult<'server-work' | 'control-kernel', StorageDecision<ServerWorkReceipt<Intent>>>
> {
  const { intent, store, kernel } = input;
  if (!store || !kernel) return { state: 'unavailable', owner: 'server-work', reason: 'disabled' };

  const staged = await store.stage(intent);
  if (staged.state === 'unavailable') return staged;
  if (!isDeepStrictEqual(staged.value, intent))
    return { state: 'ready', value: { state: 'conflict' } };

  const local = await store.readLocalReceipt(intent.requestId);
  if (local.state === 'unavailable') return local;

  // A settled owner beside an older kernel can only inspect. A fresh decision is unsafe.
  let inspected: StorageResult<'control-kernel', StorageReceiptLookup<ServerWorkReceipt<Intent>>>;
  if (local.value) {
    inspected = await kernel.inspectServerWork(intent);
  } else {
    const decision = await kernel.decideServerWork(intent).catch(
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
  const settled = await store.settle(receipt).catch(() => null);
  if (settled?.state === 'unavailable') return settled;
  if (!settled) {
    if (receipt.disposition === 'refused') return { state: 'ready', value: { state: 'unknown' } };
    const published = await store.isPublished(receipt);
    if (published.state === 'unavailable') return published;
    if (!published.value) return { state: 'ready', value: { state: 'unknown' } };
  }
  return { state: 'ready', value: inspected.value };
}
