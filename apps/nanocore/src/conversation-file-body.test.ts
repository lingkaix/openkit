import { describe, expect, it, vi } from 'vitest';
import {
  ConversationFileBody,
  MAX_CONVERSATION_FILE_METADATA_BYTES,
} from './conversation-file-body.js';

/** Splits the framing across arbitrary request chunks without automatic read-ahead. */
function source(parts: readonly Uint8Array[]) {
  let ordinal = 0;
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (ordinal < parts.length) controller.enqueue(parts[ordinal++]!);
    else controller.close();
  });
  return { stream: new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), pull, cancel };
}

describe('bounded conversation file framing', () => {
  it('handles split metadata and ordered zero-length and arbitrary binary parts', async () => {
    const json = Buffer.from('{"input":"héllo"}');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(json.length);
    const input = source([
      prefix.subarray(0, 1),
      prefix.subarray(1),
      json.subarray(0, 4),
      json.subarray(4),
      new Uint8Array([0, 0xff, 0xc0, 0x80]),
    ]);
    const body = new ConversationFileBody(input.stream);
    expect(await body.metadata()).toEqual({ input: 'héllo' });
    const empty = [];
    for await (const chunk of body.payload(0)) empty.push(chunk);
    expect(empty).toEqual([]);
    const parts: Buffer[] = [];
    for await (const chunk of body.payload(4)) parts.push(chunk);
    expect(Buffer.concat(parts)).toEqual(Buffer.from([0, 0xff, 0xc0, 0x80]));
    await body.assertEnd();
    await body.cancel();
  });

  it.each([
    0,
    MAX_CONVERSATION_FILE_METADATA_BYTES + 1,
  ])('refuses metadata length %s before reading its body', async (length) => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(length);
    const input = source([prefix, new Uint8Array([9])]);
    const body = new ConversationFileBody(input.stream);
    await expect(body.metadata()).rejects.toThrow('framing');
    expect(input.pull).toHaveBeenCalledTimes(1);
    await body.cancel();
    expect(input.cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels unread retry bytes after metadata without reading the selected original', async () => {
    const json = Buffer.from('{}');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(json.length);
    const input = source([Buffer.concat([prefix, json]), new Uint8Array([0xff])]);
    const body = new ConversationFileBody(input.stream);
    expect(await body.metadata()).toEqual({});
    await body.cancel();
    expect(input.pull).toHaveBeenCalledTimes(1);
    expect(input.cancel).toHaveBeenCalledTimes(1);
  });
});
