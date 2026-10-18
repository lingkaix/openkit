import { expect, it, vi } from 'vitest';
import { readRetainedV1, writeRetainedV1 } from './retained-format.js';

it('writes version one and decodes its owned bytes without changing descriptive additions', () => {
  const record = writeRetainedV1({ id: 'fixture', annotation: 'retained' });
  const decode = vi.fn((input: unknown) => input);
  expect(record.schemaVersion).toBe(1);
  expect(readRetainedV1(record, decode)).toBe(record);
  expect(decode).toHaveBeenCalledExactlyOnceWith(record);
});

it('refuses missing or unknown versions before invoking the family decoder', () => {
  const decode = vi.fn();
  for (const input of [{ id: 'fixture' }, { id: 'fixture', schemaVersion: 2 }]) {
    expect(() => readRetainedV1(input, decode)).toThrow('Unsupported retained record format.');
  }
  expect(decode).not.toHaveBeenCalled();
});
