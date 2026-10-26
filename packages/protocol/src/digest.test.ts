import { describe, expect, it } from 'vitest';
import { sha256CanonicalJson, sha256Hex } from './digest.js';

describe('SHA-256 digests', () => {
  // Fixed with Python hashlib over literal bytes, independently of the Protocol encoder.
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abc\n', 'edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb'],
  ])('hashes exact text %j as bare lowercase hex', (exact, expected) => {
    expect(sha256Hex(exact)).toBe(expected);
  });

  it('hashes only the selected byte view without decoding or framing it', () => {
    // Retention Content Addressing preserves original bytes; the view excludes both sentinels.
    const bytes = new Uint8Array([11, 0, 255, 128, 10, 12]);
    expect(sha256Hex(bytes.subarray(1, 5))).toBe(
      '6d6f7836f1e146dc0204afb5133dae52fdc05603d8ac2dc793b481b0e0829fd1'
    );
  });

  it('hashes the exact UTF-8 canonical JSON projection without a prefix or newline', () => {
    // QP-1: expected bytes and hash were derived without the candidate; see the oracle report.
    expect(
      sha256CanonicalJson({
        '\ufb33': 'bmp',
        '\ud83d\ude00': 'astral',
        '\u00e9': 'composed',
        'e\u0301': 'decomposed',
        z: undefined,
        a: [{ z: 2, absent: undefined, a: 0 }, null],
        '2': 'two',
        '10': 'ten',
      })
    ).toBe('36e84388f3a78db9a3fa616cab6129b680abe443ea2ef9fd2f79e0caaeed612d');
  });
});
