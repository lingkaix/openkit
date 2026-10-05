import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createLocalSimulatorCredentialCheckValues,
  findWorkerCredentialMatches,
  requireWorkerCredentialCheckValues,
  type WorkerCredentialCheckValues,
} from './worker-credential-guard.js';

/** Builds independent synthetic evidence in the two distinct hash domains. @returns Original comparison proof. */
function evidence(): WorkerCredentialCheckValues {
  return {
    sensitiveValues: [],
    loopbackDigests: [
      createHash('sha256').update('a'.repeat(43)).digest('hex'),
      createHash('sha256').update('b'.repeat(43)).digest('hex'),
    ],
    routeTokenHashes: {
      workerControl: createHash('sha256').update(Buffer.alloc(32, 17)).digest('hex'),
      inference: createHash('sha256').update(Buffer.alloc(32, 34)).digest('hex'),
      capability: createHash('sha256').update(Buffer.alloc(32, 51)).digest('hex'),
    },
  };
}

describe('worker credential byte guard', () => {
  it('uses the explicit local empty comparison set without admitting it as Worker evidence', () => {
    const local = createLocalSimulatorCredentialCheckValues();
    expect(findWorkerCredentialMatches(Buffer.from('a'.repeat(43)), local)).toEqual([]);
    expect(() => requireWorkerCredentialCheckValues(local)).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
  });

  it('coalesces overlapping literal matches using UTF-8 byte offsets, ignoring empty values and duplicates', () => {
    const proof = evidence();
    proof.sensitiveValues = ['éabc', 'bcdef', 'éabc', ''];
    expect(findWorkerCredentialMatches(Buffer.from('前éabcdef後'), proof)).toEqual([
      { start: 3, end: 11 },
    ]);
    expect(
      findWorkerCredentialMatches(Buffer.from('abcdef'), { ...proof, sensitiveValues: ['x'] })
    ).toEqual([]);
  });

  it.each([
    17, 34, 51,
  ])('checks decoded route hash %s in a longer alphabet run without accepting alternative spellings', (byte) => {
    const raw = Buffer.alloc(32, byte);
    const token = raw.toString('base64url');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alternate = `${token.slice(0, -1)}${alphabet[alphabet.indexOf(token.at(-1) as string) + 1]}`;
    expect(Buffer.from(alternate, 'base64url')).toEqual(raw);
    expect(findWorkerCredentialMatches(Buffer.from(`prefix_${token}_suffix`), evidence())).toEqual([
      { start: 7, end: 50 },
    ]);
    expect(findWorkerCredentialMatches(Buffer.from(alternate), evidence())).toEqual([]);
    expect(createHash('sha256').update(token).digest('hex')).not.toBe(
      createHash('sha256').update(raw).digest('hex')
    );
  });

  it.each(['a', 'b'])('checks loopback text digest %s in a longer alphabet run', (character) => {
    expect(
      findWorkerCredentialMatches(Buffer.from(`prefix_${character.repeat(43)}_suffix`), evidence())
    ).toEqual([{ start: 7, end: 50 }]);
  });

  it('ignores unknown additive route fields without expanding the injected set', () => {
    const proof = evidence();
    const bytes = Buffer.alloc(32, 99);
    Object.assign(proof.routeTokenHashes, {
      future: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(findWorkerCredentialMatches(Buffer.from(bytes.toString('base64url')), proof)).toEqual(
      []
    );
  });

  it.each([
    null,
    {},
    { ...evidence(), sensitiveValues: [7] },
    { ...evidence(), loopbackDigests: [] },
    { ...evidence(), loopbackDigests: ['a'.repeat(64), 'a'.repeat(64)] },
    { ...evidence(), routeTokenHashes: { ...evidence().routeTokenHashes, inference: '' } },
  ])('refuses unavailable or contradictory evidence even for empty candidate bytes (%#)', (proof) => {
    expect(() =>
      findWorkerCredentialMatches(Buffer.alloc(0), proof as WorkerCredentialCheckValues)
    ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
  });
});
