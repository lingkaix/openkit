import { type Item, ItemDeltaEventSchema } from '@openkit/protocol';
import { OperationError } from '../operation-error-core.js';

export const ITEM_DELTA_PROTOCOL_MESSAGE =
  'Item delta violates the declared Item protocol. Use a declared delta for the Item and introduce its part or request before referencing it.';

/** Fixed diagnostics omit rejected payload bytes, which can contain private model output. */
export class ItemDeltaProtocolError extends OperationError {
  /** Creates the existing open-code diagnostic without retaining rejected payloads. */
  constructor(
    readonly turnId?: string,
    readonly audited = false
  ) {
    super('core.protocol.invalid_delta', ITEM_DELTA_PROTOCOL_MESSAGE, 409);
  }
}

/** Validates one new delta from the actual Item and its complete preceding event sequence. */
export function assertItemDeltaSequence(
  data: unknown,
  item: Item | undefined,
  events: readonly { data: unknown }[]
): void {
  if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'item-delta') return;
  const parsed = ItemDeltaEventSchema.safeParse(data);
  if (
    !parsed.success ||
    !item ||
    parsed.data.itemId !== item.id ||
    parsed.data.itemType !== item.type
  )
    throw new ItemDeltaProtocolError();
  const delta = parsed.data;
  const parts = new Set<string>();
  const requests = new Set<string>();
  for (const event of events) {
    const prior = ItemDeltaEventSchema.safeParse(event.data);
    if (!prior.success || prior.data.itemId !== item.id || prior.data.itemType !== item.type)
      continue;
    if (prior.data.deltaKind === 'part-started') parts.add(prior.data.partId);
    if (prior.data.deltaKind === 'request-started') requests.add(prior.data.requestRefId);
    if (prior.data.deltaKind === 'request-resolved') requests.delete(prior.data.requestRefId);
  }
  if (
    (delta.deltaKind === 'indexed-text-delta' && !parts.has(delta.partId)) ||
    (delta.deltaKind === 'request-resolved' && !requests.has(delta.requestRefId))
  )
    throw new ItemDeltaProtocolError();
}
