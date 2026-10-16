import { describe, expect, it, vi } from 'vitest';
import {
  type AgentTool,
  type InternalAgentProviderRequest,
  runInternalAgentLoop,
} from './internal-agent-loop.js';
import { redactInternalAgentText } from './redaction.js';

describe('internal Agent text redaction', () => {
  it.each([
    {
      text: 'authorization: Bearer secret-value',
      secret: 'secret-value',
      expected: 'authorization: Bearer [redacted]',
    },
    { text: 'token=abc123', secret: 'abc123', expected: 'token=[redacted]' },
    { text: 'hf_x', secret: 'hf_x', expected: '[redacted]' },
  ])('retains the existing plain-text credential mask: $text', ({ text, secret, expected }) => {
    const result = redactInternalAgentText(text);

    expect(result).toBe(expected);
    expect(result).not.toContain(secret);
    expect(result).toMatch(/redacted/i);
  });

  it('redacts decoded JSON string content while preserving the complete structure', () => {
    const input = JSON.stringify({
      text: 'Example: Authorization: Bearer EXAMPLE',
      path: 'guide.md',
      nested: { text: 'token=abc123', count: 3, active: true, empty: null },
      examples: ['hf_x', 'Safe guidance. 世界\n'],
    });

    const result = redactInternalAgentText(input);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({
      text: expect.any(String),
      path: 'guide.md',
      nested: { text: expect.any(String), count: 3, active: true, empty: null },
      examples: [expect.any(String), 'Safe guidance. 世界\n'],
    });
    expect(parsed.text).toContain('Example:');
    for (const secret of ['EXAMPLE', 'abc123', 'hf_x']) expect(result).not.toContain(secret);
  });

  it.each([
    `${String.raw` { "z" : 1e+2, "negativeZero": -0, "text" : "Safe guidance. 世界\n" } `}\n`,
    String.raw`[ 1, null, true, "A safe quote: \"hello\"" ]`,
    '  "Safe root string. 世界"  ',
  ])('preserves safe JSON bytes exactly: %j', (input) => {
    expect(() => JSON.parse(input)).not.toThrow();
    expect(redactInternalAgentText(input)).toBe(input);
  });

  it.each([
    JSON.stringify({ hf_x: 'Safe value' }),
    String.raw`{ "\u0068f_x" : "Safe value" }`,
  ])('redacts decoded JSON property names without changing safe values: %j', (input) => {
    const result = redactInternalAgentText(input);

    expect(JSON.parse(result)).toEqual({ '[redacted]': 'Safe value' });
  });

  it('keeps already-redacted structured content valid and unchanged on another pass', () => {
    const masked = redactInternalAgentText('Example: Authorization: Bearer EXAMPLE');
    const input = JSON.stringify({ text: masked, nested: [redactInternalAgentText('hf_x')] });

    const result = redactInternalAgentText(input);

    expect(() => JSON.parse(result)).not.toThrow();
    expect(result).toBe(input);
    expect(redactInternalAgentText(result)).toBe(result);
  });
});

describe('structured credential redaction', () => {
  it.each([
    JSON.stringify({ text: 'token="EXAMPLE"', count: 3 }),
    String.raw`{ "text" : "to\u006ben=\u0022EXAMPLE\u0022", "count" : 3 }`,
    String.raw`{ "text" : "token=\u0045\u0058\u0041\u004d\u0050\u004c\u0045", "count" : 3 }`,
  ])('masks decoded credential values without damaging JSON: %j', (input) => {
    const result = redactInternalAgentText(input);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ text: expect.any(String), count: 3 });
    expect(parsed.text).not.toContain('EXAMPLE');
    expect(parsed.text).toMatch(/redacted/i);
    expect(redactInternalAgentText(result)).toBe(result);
  });

  it('masks a quoted credential in a decoded property name', () => {
    const result = redactInternalAgentText(
      JSON.stringify({ 'token="EXAMPLE"': 'Safe value', count: 3 })
    );
    const parsed = JSON.parse(result);
    const key = Object.keys(parsed).find((value) => value !== 'count');

    expect(key).toBeDefined();
    expect(key).not.toContain('EXAMPLE');
    expect(key).toMatch(/redacted/i);
    expect(parsed[key!]).toBe('Safe value');
    expect(parsed.count).toBe(3);
  });

  it('preserves number and formatting bytes outside a redacted string token', () => {
    const input =
      ' { "text" : "hf_x", "number" : 1.2300e+04, "negativeZero": -0, "large": 9007199254740993 } ';
    const result = redactInternalAgentText(input);

    expect(result).toBe(input.replace('hf_x', '[redacted]'));
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('sends sanitized valid Tool JSON to the next actual loop Provider request', async () => {
    const source = JSON.stringify({ text: 'token="EXAMPLE"', count: 3 });
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: source }],
    }));
    const tool: AgentTool = {
      name: 'environment.status',
      description: 'Read a synthetic status.',
      inputSchema: { type: 'object', additionalProperties: false },
      execute,
    };
    const requests: InternalAgentProviderRequest[] = [];
    const provider = async (request: InternalAgentProviderRequest) => {
      requests.push(request);
      return {
        message: {
          role: 'assistant' as const,
          content:
            requests.length === 1
              ? [{ type: 'toolCall' as const, callId: 'status_1', name: tool.name, arguments: {} }]
              : [{ type: 'text' as const, text: 'Done.' }],
          truncated: false,
        },
      };
    };

    const result = await runInternalAgentLoop(
      {
        systemPrompt: 'Use the supplied status Tool.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Read status.' }] }],
        tools: [tool],
        model: {
          logicalModelId: 'assistant',
          capabilities: ['chat-completions', 'tool-calling'],
          modelFamilyId: 'gpt-5',
        },
        limits: { maxModelTurns: 3, maxToolCalls: 1, deadlineMs: 5_000 },
        signal: new AbortController().signal,
      },
      provider
    );

    expect(result.kind).toBe('quiescent');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    const observations = requests[1]!.messages.filter((message) => message.role === 'tool');
    expect(observations).toHaveLength(1);
    expect(observations[0]!.content).toHaveLength(1);
    const content = observations[0]!.content[0]!;
    expect(content.type).toBe('text');
    if (content.type !== 'text') throw new Error('Expected text Tool observation.');
    expect(content.text).not.toContain('EXAMPLE');
    const parsed = JSON.parse(content.text);
    expect(parsed).toEqual({ text: expect.stringMatching(/redacted/i), count: 3 });
    expect(source).toBe(JSON.stringify({ text: 'token="EXAMPLE"', count: 3 }));
  });
});
