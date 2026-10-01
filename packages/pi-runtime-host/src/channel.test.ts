import { describe, expect, it } from 'vitest';
import {
  CHANNEL_FRAME_MAX_BYTES,
  CHANNEL_REQUEST_MAX_BYTES,
  createLineReader,
  encodeFrame,
  HostRequestSchema,
} from './channel.ts';

const credential = 'A'.repeat(43);
const open = {
  agentDir: '/sandbox/agent',
  capabilityBaseUrl: 'http://127.0.0.1:17892/capabilities',
  capabilityCredential: credential,
  id: 1,
  inferenceBaseUrl: 'http://127.0.0.1:17892/inference/v1',
  inferenceCredential: 'B'.repeat(43),
  mcpServers: ['openkit-work'],
  model: {
    contextWindow: 1000,
    inputModalities: ['text'],
    maxOutputTokens: 100,
    modelId: 'logical-a',
    reasoning: false,
  },
  op: 'open',
  skillTargetPaths: [],
  resume: null,
  stateRoot: '/sandbox/state',
  workingDirectory: '/workspace',
};

describe('HostRequestSchema', () => {
  it('accepts an exact open request', () => {
    expect(HostRequestSchema.safeParse(open).success).toBe(true);
  });

  it.each([
    ['a direct provider URL', { inferenceBaseUrl: 'https://api.example.com/v1' }],
    ['a non-loopback capability URL', { capabilityBaseUrl: 'http://10.0.0.1:17892/capabilities' }],
    ['a URL with user info', { inferenceBaseUrl: 'http://user@127.0.0.1:17892/inference/v1' }],
    ['a malformed credential', { inferenceCredential: 'short' }],
    ['a relative state root', { stateRoot: 'state' }],
    ['duplicate MCP server ids', { mcpServers: ['openkit-work', 'openkit-work'] }],
    ['an unknown field', { apiKey: 'x' }],
    [
      'output larger than the context window',
      { model: { ...open.model, contextWindow: 10, maxOutputTokens: 100 } },
    ],
    ['a model without text input', { model: { ...open.model, inputModalities: ['image'] } }],
  ])('rejects %s', (_name, overrides) => {
    expect(HostRequestSchema.safeParse({ ...open, ...overrides }).success).toBe(false);
  });

  it('rejects an empty prompt and an unknown operation', () => {
    expect(
      HostRequestSchema.safeParse({ id: 2, op: 'turn', prompt: '', turnId: 't' }).success
    ).toBe(false);
    expect(HostRequestSchema.safeParse({ id: 2, op: 'steer' }).success).toBe(false);
  });
});

describe('createLineReader', () => {
  it('splits chunks into lines and reports an oversized line once', () => {
    const lines: string[] = [];
    let overflows = 0;
    const read = createLineReader(
      (line) => lines.push(line),
      () => {
        overflows += 1;
      }
    );
    read(Buffer.from('{"a":1}\n{"b"'));
    read(Buffer.from(':2}\n\n'));
    read(Buffer.alloc(CHANNEL_REQUEST_MAX_BYTES + 1, 0x61));
    read(Buffer.from('tail\n{"c":3}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(overflows).toBe(1);
  });

  it('rejects a line that is not UTF-8', () => {
    const lines: string[] = [];
    let overflows = 0;
    const read = createLineReader(
      (line) => lines.push(line),
      () => {
        overflows += 1;
      }
    );
    read(Buffer.from([0xff, 0xfe, 0x0a]));
    expect(lines).toEqual([]);
    expect(overflows).toBe(1);
  });
});

describe('encodeFrame', () => {
  it('redacts every secret and bounds the frame', () => {
    const line = encodeFrame(
      { event: 'extension_error', message: `key ${credential} and ${credential}` },
      [credential]
    );
    expect(line).not.toContain(credential);
    expect(line).toBe('{"event":"extension_error","message":"key [redacted] and [redacted]"}\n');
    expect(() =>
      encodeFrame({ event: 'extension_error', message: 'x'.repeat(CHANNEL_FRAME_MAX_BYTES) }, [])
    ).toThrow();
  });
});
