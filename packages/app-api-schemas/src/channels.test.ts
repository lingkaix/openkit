import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { CHANNEL_OPERATION_DEFINITIONS, NotificationDeliverySchema } from './channels.js';
import { operationMcpEligible } from './operation-contract.js';

describe('first channel contracts', () => {
  it('keeps one-use pairing secrets out of MCP delivery', () => {
    expect(operationMcpEligible(CHANNEL_OPERATION_DEFINITIONS['channel.discord.pair'])).toBe(false);
    expect(CHANNEL_OPERATION_DEFINITIONS['channel.discord.pair'].returnsOneTimeSecret).toBe(true);
  });

  it('requires exact retry identity and refuses caller-selected recipients and adapters', () => {
    const schema = CHANNEL_OPERATION_DEFINITIONS['notification.send'].inputSchema;
    const deliveryId = '10000000-0000-4000-8000-000000000001';
    expect(schema.safeParse({ deliveryId }).success).toBe(false);
    expect(schema.safeParse({ deliveryId, expectedAttemptId: null }).success).toBe(true);
    expect(
      schema.safeParse({ deliveryId, expectedAttemptId: 7, recipientUserId: allocateEntityId('usr') }).success
    ).toBe(false);
    expect(schema.safeParse({ deliveryId, expectedAttemptId: 7, channel: 'email' }).success).toBe(
      false
    );
  });

  it('does not interpret a request decision as an external transport state', () => {
    expect(NotificationDeliverySchema.shape.status.safeParse('granted').success).toBe(false);
    expect(NotificationDeliverySchema.shape.status.safeParse('delivery-unknown').success).toBe(
      true
    );
  });
});
