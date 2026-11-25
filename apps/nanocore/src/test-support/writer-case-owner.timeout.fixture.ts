import { appendFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { installWriterCaseOwner } from './writer-case-owner.js';

/**
 * The real runner-timeout schedule of the writer owner (S3a-r2e A8 finding 1). Only a nested
 * Vitest run from `writer-case-owner.test.ts` runs this file. A real `owner.beforeAll` times out
 * at its bound. The runner skips its case and runs a plain `afterAll` that releases the timed-out
 * hook. The hook then tries to stop the writer before any successor owner enters. Each
 * stop is a stub, so no writer runs. The file appends each event to the path in
 * `WRITER_OWNER_TIMEOUT_EVENTS` as one JSON line.
 */

/** The bound of the timed-out suite hook in milliseconds. The nested run's caller expects 25. */
const TIMED_OUT_HOOK_BOUND_MS = 25;

const eventsPath = process.env.WRITER_OWNER_TIMEOUT_EVENTS;
if (!eventsPath) throw new Error('WRITER_OWNER_TIMEOUT_EVENTS names no events file.');
const events = eventsPath;

/** Appends one event line. */
function record(event: Record<string, unknown>): void {
  appendFileSync(events, `${JSON.stringify(event)}\n`);
}

/** A promise that this file settles. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const owner = installWriterCaseOwner();
let stops = 0;
const stop = async () => {
  stops += 1;
};
const release = deferred();
const resumed = deferred();

describe('a suite hook that the runner times out', () => {
  owner.beforeAll(async () => {
    record({ event: 'hook-entered', owns: owner.owns() });
    await release.promise;
    record({ event: 'hook-resumed', owns: owner.owns() });
    await owner.shutdown(stop);
    resumed.resolve();
  }, TIMED_OUT_HOOK_BOUND_MS);
  it('does not run after its suite hook times out', () => {
    record({ event: 'case-ran' });
  });
  // A plain suite hook: no owner token. It releases the timed-out hook and waits for its stop.
  afterAll(async () => {
    record({ event: 'teardown-entered', stops });
    release.resolve();
    await resumed.promise;
    record({ event: 'teardown-done', stops });
  });
});

describe('the successor suite', () => {
  owner.beforeAll(async () => {
    record({ event: 'successor-entered', stops });
    await owner.shutdown(stop);
    record({ event: 'successor-stopped', stops });
  }, 10_000);
  it('owns the writer in its case', () => {
    record({ event: 'successor-case', owns: owner.owns() });
    expect(owner.owns()).toBe(true);
  });
});
