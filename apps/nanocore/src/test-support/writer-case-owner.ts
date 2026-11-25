import { AsyncLocalStorage } from 'node:async_hooks';
import { aroundEach, afterAll as vitestAfterAll, beforeAll as vitestBeforeAll } from 'vitest';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';

// Captured at import, before a case can install fake timers.
const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = globalThis;

/**
 * The owner of the process-wide control-store writer in one test file (S3a-r2c, S3a-r2d). Each unit
 * that the runner runs gets its own token: a case with its hooks (from `aroundEach`), and each
 * suite hook (`beforeAll`, `afterAll`) from its entry through the runner's completion of it. Only
 * code under the current unit's token can stop the writer. Code with no token is refused. The
 * runner can finish a unit while its code still runs (a timeout); that code keeps its old token, so
 * its stop does nothing. No final process-level teardown stops the writer without a token: the
 * last case's own teardown stops it, and Vitest then ends the worker.
 */
export interface WriterCaseOwner {
  /** True only under the token of the unit that the runner runs now. */
  owns(): boolean;
  /**
   * Starts an owned shutdown and publishes it in the same run. A call that is not owned returns a
   * settled promise and stops nothing.
   * @param stop The shutdown to start; the process-wide writer's shutdown by default.
   */
  shutdown(stop?: () => Promise<void>): Promise<void>;
  /** Joins a published shutdown until it settles. A join that Vitest abandons leaves it published. */
  join(): Promise<void>;
  /** Runs nested work under a new token inside the current case. A directed witness uses it. */
  runCase<T>(run: () => Promise<T>): Promise<T>;
  /**
   * Runs one suite hook under a new token. The token is current from entry until the hook settles
   * or its runner timeout passes, whichever comes first. The hook joins a published shutdown first.
   * The registered suite hooks use it; a directed witness calls it directly.
   */
  runHook<T>(run: () => Promise<T>, timeout: number): Promise<T>;
  /** Registers a `beforeAll` hook that runs through `runHook` with the same timeout. */
  beforeAll(run: () => unknown, timeout: number): void;
  /** Registers an `afterAll` hook that runs through `runHook` with the same timeout. */
  afterAll(run: () => unknown, timeout: number): void;
}

/**
 * The installed owner of the calling test file, for shared helpers that stop the writer from their
 * own hooks. Undefined in a file that installs no owner.
 */
let installed: WriterCaseOwner | undefined;

/**
 * Stops the writer through the calling file's owner, or directly in a file that installs none.
 * @param stop The helper's own shutdown.
 */
export function stopWriterThroughFileOwner(stop: () => Promise<void>): Promise<void> {
  return installed ? installed.shutdown(stop) : stop();
}

/** Creates an owner without registering it. `installWriterCaseOwner` registers it. */
export function createWriterCaseOwner(): WriterCaseOwner & {
  /** Runs one case under a new token. The runner's completion of the case ends every inner token. */
  runTest<T>(run: () => Promise<T>): Promise<T>;
} {
  const tokenOf = new AsyncLocalStorage<object>();
  let current: object | undefined;
  let caseToken: object | undefined;
  let published: Promise<void> | undefined;
  const owner = {
    owns() {
      const token = tokenOf.getStore();
      return token !== undefined && token === current;
    },
    shutdown(stop: () => Promise<void> = shutdownControlStoreWorkerClient) {
      if (!owner.owns()) return Promise.resolve();
      const shutdown = stop();
      published = shutdown;
      return shutdown;
    },
    async join() {
      const crossing = published;
      if (!crossing) return;
      await crossing.catch(() => undefined);
      if (published === crossing) published = undefined;
    },
    async runTest<T>(run: () => Promise<T>) {
      const token = {};
      current = token;
      caseToken = token;
      try {
        return await tokenOf.run(token, run);
      } finally {
        current = undefined;
        caseToken = undefined;
      }
    },
    async runCase<T>(run: () => Promise<T>) {
      const previous = current;
      const token = {};
      current = token;
      try {
        return await tokenOf.run(token, run);
      } finally {
        if (current === token) current = previous;
      }
    },
    async runHook<T>(run: () => Promise<T>, timeout: number) {
      const token = {};
      current = token;
      // The runner completes the hook at its timeout. Its token ends then, or when it settles.
      const end = () => {
        if (current === token) current = caseToken;
      };
      const timer = realSetTimeout(end, timeout);
      try {
        await owner.join();
        return await tokenOf.run(token, run);
      } finally {
        realClearTimeout(timer);
        end();
      }
    },
    beforeAll(run: () => unknown, timeout: number) {
      vitestBeforeAll(() => owner.runHook(async () => run(), timeout), timeout);
    },
    afterAll(run: () => unknown, timeout: number) {
      vitestAfterAll(() => owner.runHook(async () => run(), timeout), timeout);
    },
  };
  return owner;
}

/** Installs the writer owner for every case and suite hook of the calling test file. Call it at module scope. */
export function installWriterCaseOwner(): WriterCaseOwner {
  if (installed) throw new Error('This test file already installed a writer owner.');
  const owner = createWriterCaseOwner();
  aroundEach((runTest) => owner.runTest(runTest));
  installed = owner;
  return owner;
}
