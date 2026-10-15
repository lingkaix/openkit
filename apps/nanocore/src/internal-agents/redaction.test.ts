import { describe, expect, it } from 'vitest';
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
      path: 'SKILL.md',
      nested: { text: 'token=abc123', count: 3, active: true, empty: null },
      examples: ['hf_x', 'Safe guidance. 世界\n'],
    });

    const result = redactInternalAgentText(input);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({
      text: expect.any(String),
      path: 'SKILL.md',
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
