import { expect, it } from 'vitest';
import {
  allocateEntityId,
  PROTOCOL_VERSION,
  ProductItemPreviewEventSchema,
  ProductSseEventEnvelopeSchema,
  ServerEventSchema,
} from '../index.js';

const body = {
  workspaceId: allocateEntityId('ws'),
  threadId: allocateEntityId('th'),
  turnId: allocateEntityId('tu'),
  itemId: allocateEntityId('it'),
};
const event = {
  type: 'item-preview',
  itemId: body.itemId,
  itemType: 'command-execution',
  preview: {
    text: 'Exact tail 🙂',
    field: 'output',
    side: 'tail',
    sizeBytes: 5_000_000,
    truncated: true,
  },
  body,
};
const envelope = (data: unknown) => ({
  protocolVersion: PROTOCOL_VERSION,
  event: 'item.delta',
  sequence: 1,
  requestId: null,
  timestamp: '2026-11-08T17:00:00.000Z',
  ...body,
  data,
});

it('admits only a bounded outward preview and preserves its original body selector', () => {
  expect(ProductItemPreviewEventSchema.parse(event)).toEqual(event);
  expect(ProductSseEventEnvelopeSchema.parse(envelope(event)).data).toEqual(event);
  expect(ServerEventSchema.safeParse(event).success).toBe(false);
});

it('rejects oversized or malformed previews without treating them as unknown future events', () => {
  for (const preview of [
    { ...event.preview, text: '🙂'.repeat(1025) },
    { ...event.preview, side: 'middle' },
    { ...event.preview, sizeBytes: -1 },
  ]) {
    expect(ProductSseEventEnvelopeSchema.safeParse(envelope({ ...event, preview })).success).toBe(
      false
    );
  }
  expect(
    ProductSseEventEnvelopeSchema.safeParse(
      envelope({ ...event, body: { ...body, threadId: allocateEntityId('th') } })
    ).success
  ).toBe(false);
  expect(
    ProductSseEventEnvelopeSchema.safeParse(
      envelope({ ...event, body: { ...body, path: '/arbitrary' } })
    ).success
  ).toBe(false);
});
