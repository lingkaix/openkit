import { describe, expect, it } from 'vitest';
import { policyDigest, sha256CanonicalJson, sha256Hex } from './digest.js';

describe('SHA-256 digests', () => {
  it('preserves tagged Policy identity digests without changing the accepted values', () => {
    // Independent Python hashlib over these literal canonical bytes, not the moved implementation.
    expect(policyDigest(null)).toBe(
      'sha256:74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b'
    );
    expect(policyDigest({ b: 2, a: 1 })).toBe(
      'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777'
    );
    expect(policyDigest([1, 'x', null])).toBe(
      'sha256:c3462050a94ca819b16ded452c5ac9dc70605f7e5c841ab7bff396cf60e2cc67'
    );
    expect(() => policyDigest({ absent: undefined })).toThrow();
    expect(() => policyDigest(Number.NaN)).toThrow();
  });
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
