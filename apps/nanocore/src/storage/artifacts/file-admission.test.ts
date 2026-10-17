import { describe, expect, it } from 'vitest';
import { FileByteAdmission, FileStorageAdmission } from './file-admission.js';

describe('file byte admission', () => {
  it('admits empty files and one billion actual bytes, then refuses the next byte', () => {
    const admission = new FileByteAdmission();
    admission.consume(0);
    for (let bytes = 0; bytes < 1_000_000_000; bytes += 65_536) {
      admission.consume(Math.min(65_536, 1_000_000_000 - bytes));
    }
    expect(admission.byteLength).toBe(1_000_000_000);
    expect(() => admission.consume(1)).toThrow('byte limit');
    expect(admission.byteLength).toBe(1_000_000_000);
  });

  it('shares one upload budget across files but gives separate Worker files independent limits', () => {
    const submission = new FileByteAdmission();
    submission.consume(400_000_000);
    submission.consume(600_000_000);
    expect(() => submission.consume(1)).toThrow('byte limit');
    for (let file = 0; file < 2; file += 1) {
      const worker = new FileByteAdmission();
      worker.consume(1_000_000_000);
      expect(worker.byteLength).toBe(1_000_000_000);
    }
  });

  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('refuses an invalid actual byte length: %s', (size) =>
    expect(() => new FileByteAdmission().consume(size)).toThrow('invalid'));
});

describe('shared filesystem admission', () => {
  const writes = {
    stagingBytes: 100n,
    extractionBytes: 200n,
    derivativeBytes: 50n,
    publicationBytes: 100n,
  };

  it('releases an unused capture forecast without permitting increases or reuse after release', () => {
    const admission = new FileStorageAdmission(
      '.',
      () => 10n,
      () => 110n
    );
    const captured = admission.reserve({
      stagingBytes: 100n,
      extractionBytes: 0n,
      derivativeBytes: 0n,
      publicationBytes: 0n,
    });
    captured.reduceTo(20n);
    const other = admission.reserve({
      stagingBytes: 80n,
      extractionBytes: 0n,
      derivativeBytes: 0n,
      publicationBytes: 0n,
    });
    expect(() => captured.reduceTo(21n)).toThrow('capacity');
    captured.recordWritten(20);
    captured.reduceTo(0n);
    captured.release();
    expect(() => captured.reduceTo(0n)).toThrow('capacity');
    other.release();
  });

  it('admits only one contender when both fit alone but their reservations do not fit together', async () => {
    const admission = new FileStorageAdmission(
      '.',
      () => 100n,
      () => 900n
    );
    const results = await Promise.allSettled([
      Promise.resolve().then(() => admission.reserve(writes)),
      Promise.resolve().then(() => admission.reserve(writes)),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    const accepted = results[0];
    if (accepted?.status !== 'fulfilled') throw new Error('The first request was refused.');
    accepted.value.release();
    accepted.value.release();
    expect(() => admission.reserve(writes)).not.toThrow();
  });

  it('admits equality and rechecks occupied disk and the current configured reserve', () => {
    let free = 550n;
    let reserve = 100n;
    const admission = new FileStorageAdmission(
      '.',
      () => reserve,
      () => free
    );
    const accepted = admission.reserve(writes);
    accepted.assertAvailable();
    free = 549n;
    expect(() => accepted.assertAvailable()).toThrow('Storage capacity');
    free = 550n;
    reserve = 101n;
    expect(() => accepted.assertAvailable()).toThrow('Storage capacity');
    accepted.release();
    expect(() => accepted.assertAvailable()).toThrow('Storage capacity');
  });

  it('converts completed writes into occupied capacity without reserving their bytes twice', () => {
    let free = 550n;
    const admission = new FileStorageAdmission(
      '.',
      () => 100n,
      () => free
    );
    const accepted = admission.reserve(writes);
    free -= 100n;
    accepted.recordWritten(100);
    expect(() => accepted.assertAvailable()).not.toThrow();
    expect(() => accepted.recordWritten(351)).toThrow('Storage capacity');
    accepted.release();
    expect(() => accepted.recordWritten(1)).toThrow('Storage capacity');
  });

  it('does not invent free capacity after sampling failure', () => {
    const admission = new FileStorageAdmission(
      '.',
      () => 100n,
      () => {
        throw new Error('unavailable');
      }
    );
    expect(() => admission.reserve(writes)).toThrow('Storage capacity');
  });
});
