import { expect, it } from 'vitest';
import { compareCodeUnits } from './index.js';

it('orders projection strings by UTF-16 units without locale or Unicode normalization', () => {
  expect(['ä', 'z', 'Z', 'Å', 'a', '😀', '\uE000', 'é', 'e\u0301'].sort(compareCodeUnits)).toEqual([
    'Z',
    'a',
    'e\u0301',
    'z',
    'Å',
    'ä',
    'é',
    '😀',
    '\uE000',
  ]);
  expect(compareCodeUnits('same', 'same')).toBe(0);
});
