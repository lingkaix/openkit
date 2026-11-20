import { describe, expect, it, vi } from 'vitest';
import { captureDiscordPublishedFact } from './discord-published-fact.js';

const reference = {
  slotId: 'metric',
  collectionId: 'public',
  collectionSetRevision: '1',
  sourceId: 'page',
  sourceRevision: '7',
  sourceDigest: 'expected-digest',
  factId: 'total',
};
const fact = { value: 12, unit: 'entries', asOf: '2026-11-20' };

describe('Discord fact capture', () => {
  it('does not read an unselected source or a stale selection', async () => {
    const readExact = vi.fn();
    await expect(
      captureDiscordPublishedFact({
        requested: reference,
        currentInventory: () => [{ ...reference, collectionSetRevision: '2' }],
        readExact,
      })
    ).resolves.toBeUndefined();
    expect(readExact).not.toHaveBeenCalled();
  });

  it('retains the exact fact and revision but refuses a withdrawal during read', async () => {
    let current = [reference];
    const input = {
      requested: reference,
      currentInventory: () => current,
      readExact: async () => ({ sourceDigest: reference.sourceDigest, fact }),
    };
    await expect(captureDiscordPublishedFact(input)).resolves.toEqual({ ...reference, ...fact });
    await expect(
      captureDiscordPublishedFact({
        ...input,
        readExact: async () => {
          current = [];
          return input.readExact();
        },
      })
    ).resolves.toBeUndefined();
  });
});
