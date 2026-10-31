import { describe, expect, it } from 'vitest';
import { isRecord } from '../index.js';

describe('record access guard', () => {
  it.each([
    null,
    undefined,
    false,
    0,
    '',
    'text',
    [],
    [1],
    () => undefined,
  ])('refuses a value without record access: %s', (value) => expect(isRecord(value)).toBe(false));

  it('preserves object access without claiming plain-object or schema validation', () => {
    class Example {
      value = 1;
    }
    for (const value of [{}, Object.create(null), new Example(), new Date(0)])
      expect(isRecord(value)).toBe(true);
  });
});
