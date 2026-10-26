import { describe, expect, it } from 'vitest';
import { canonicalIdentifierName, canonicalJsonText } from '../index.js';

describe('canonical JSON text', () => {
  it('omits undefined object members recursively without changing array order or null', () => {
    // QP-1's digest projection permits omission; IDs retain their stricter name domain.
    const value = { z: undefined, a: [{ z: 2, absent: undefined, a: 0 }, null] };
    expect(canonicalJsonText(value)).toBe('{"a":[{"a":0,"z":2},null]}');
    expect(() => canonicalIdentifierName(value)).toThrow();
  });

  it('emits UTF-16-sorted members directly and preserves exact Unicode strings', () => {
    // QP-1 and Protocol IDs require code-unit order, including integer-looking keys.
    expect(
      canonicalJsonText({
        '\ufb33': 'bmp',
        '\ud83d\ude00': 'astral',
        '\u00e9': 'composed',
        'e\u0301': 'decomposed',
        '2': 'two',
        '10': 'ten',
      })
    ).toBe(
      '{"10":"ten","2":"two","e\u0301":"decomposed","\u00e9":"composed","\ud83d\ude00":"astral","\ufb33":"bmp"}'
    );
  });

  it('uses ECMAScript finite-number text across decimal and exponent boundaries', () => {
    // QP-1 adopts ECMAScript number text rather than a rounded decimal serializer.
    // Parse the selected decimal to retain its IEEE 754 rounding input without a lossy source literal.
    expect(
      canonicalJsonText([
        Number('333333333.33333329'),
        1e30,
        4.5,
        0.002,
        1e-27,
        -0,
        1e-7,
        1e-6,
        1e20,
        1e21,
      ])
    ).toBe('[333333333.3333333,1e+30,4.5,0.002,1e-27,0,1e-7,0.000001,100000000000000000000,1e+21]');
  });

  it.each([1n, () => 1, Symbol('value')])('refuses non-JSON scalar values %s', (value) => {
    expect(() => canonicalJsonText(value)).toThrow();
  });

  it('refuses missing values, cycles and invalid Unicode at the general entry', () => {
    // QP-1 permits omission only for object members; strict ID admission alone cannot prove this.
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const value of [undefined, [undefined], Array(1), cycle, '\ud800', { '\udfff': 1 }]) {
      expect(() => canonicalJsonText(value)).toThrow();
    }
  });

  it('refuses symbol object members instead of silently dropping them', () => {
    expect(() => canonicalJsonText({ [Symbol('member')]: 1 })).toThrow();
  });

  it('refuses array subclasses and non-enumerable named array members', () => {
    // QP-1 admits plain arrays, without silently discarding non-JSON own members.
    class NativeArray extends Array<number> {}
    const named = [1];
    Object.defineProperty(named, 'extra', { value: 2 });

    for (const value of [new NativeArray(1, 2), named]) {
      expect.soft(() => canonicalJsonText(value)).toThrow();
    }
  });

  it('admits null-prototype JSON objects', () => {
    const value = Object.assign(Object.create(null), { b: 2, a: 1 });
    expect(canonicalJsonText(value)).toBe('{"a":1,"b":2}');
  });

  it('refuses a class instance without executing its toJSON method', () => {
    let calls = 0;
    class NativeValue {
      toJSON() {
        calls += 1;
        return { value: 'coerced' };
      }
    }

    expect(() => canonicalJsonText(new NativeValue())).toThrow();
    expect(calls).toBe(0);
  });
});
