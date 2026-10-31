import { describe, expect, it } from 'vitest';
import {
  createRawProviderOutputObserver,
  type RawModelOutputPosition,
} from './raw-provider-output.js';

const END_REASONING = 'visible reason';
const REDACTED_REASONING = 'opaque reasoning';
const ANSWER = 'Hello';
const TOOL_ARGUMENTS = '{}';

/** Feeds one pi-messages stream and keeps the observation available. */
function observeStream(events: readonly unknown[]): RawModelOutputPosition[] {
  const positions: RawModelOutputPosition[] = [];
  const observe = createRawProviderOutputObserver('pi-messages', (position) => {
    positions.push(position);
  });
  expect(() => {
    for (const event of events) observe(event);
  }).not.toThrow();
  return positions;
}

function reasoningPositions(
  positions: readonly RawModelOutputPosition[]
): RawModelOutputPosition[] {
  return positions.filter((position) => position.field === 'reasoning');
}

describe('pi-messages reasoning deltas', () => {
  it('keeps the observation and records non-redacted thinking_end content with the text', () => {
    const positions = observeStream([
      { type: 'thinking_delta', contentIndex: 0, delta: 'hid' },
      { type: 'thinking_delta', contentIndex: 0, delta: 'den' },
      { type: 'thinking_end', contentIndex: 0, content: END_REASONING, redacted: false },
      { type: 'text_delta', contentIndex: 1, delta: ANSWER },
      { type: 'text_end', contentIndex: 1, content: ANSWER },
      { type: 'toolcall_delta', contentIndex: 2, delta: TOOL_ARGUMENTS },
      { type: 'toolcall_end', contentIndex: 2 },
    ]);
    expect(reasoningPositions(positions)).toEqual([
      expect.objectContaining({
        field: 'reasoning',
        fromBytePosition: 0,
        bytePosition: Buffer.byteLength(END_REASONING),
      }),
    ]);
    expect(
      positions.some(
        (position) =>
          position.field === 'text' && position.bytePosition === Buffer.byteLength(ANSWER)
      )
    ).toBe(true);
    expect(
      positions.some(
        (position) =>
          position.field === 'tool-arguments' &&
          position.bytePosition === Buffer.byteLength(TOOL_ARGUMENTS)
      )
    ).toBe(true);
  });

  it('records no reasoning for a redacted thinking_end and keeps the text', () => {
    const positions = observeStream([
      { type: 'thinking_delta', contentIndex: 0, delta: 'hid' },
      { type: 'thinking_delta', contentIndex: 0, delta: 'den' },
      {
        type: 'thinking_end',
        contentIndex: 0,
        content: REDACTED_REASONING,
        redacted: true,
      },
      { type: 'text_delta', contentIndex: 1, delta: ANSWER },
      { type: 'text_end', contentIndex: 1, content: ANSWER },
      { type: 'toolcall_delta', contentIndex: 2, delta: TOOL_ARGUMENTS },
      { type: 'toolcall_end', contentIndex: 2 },
    ]);
    expect(reasoningPositions(positions)).toEqual([]);
    expect(
      positions.some(
        (position) =>
          position.field === 'text' && position.bytePosition === Buffer.byteLength(ANSWER)
      )
    ).toBe(true);
    expect(
      positions.some(
        (position) =>
          position.field === 'tool-arguments' &&
          position.bytePosition === Buffer.byteLength(TOOL_ARGUMENTS)
      )
    ).toBe(true);
  });

  it('never records reasoning bytes from thinking deltas', () => {
    const delta = 'unproved';
    const positions = observeStream([
      { type: 'thinking_delta', contentIndex: 0, delta },
      { type: 'thinking_end', contentIndex: 0, content: END_REASONING },
      { type: 'text_delta', contentIndex: 1, delta: ANSWER },
    ]);
    expect(
      reasoningPositions(positions).every(
        (position) =>
          position.fromBytePosition === 0 &&
          position.bytePosition === Buffer.byteLength(END_REASONING) &&
          position.bytePosition !== Buffer.byteLength(delta)
      )
    ).toBe(true);
    expect(reasoningPositions(positions)).toHaveLength(1);
  });
});
