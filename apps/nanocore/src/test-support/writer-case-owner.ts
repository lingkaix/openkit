import { AsyncLocalStorage } from 'node:async_hooks';
import { aroundEach } from 'vitest';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';

/**
 * The suite owner of the process-wide control-store writer in one test file (S3a-r2c). A case owns
 * the writer from its setup until Vitest finishes it, its hooks included. Vitest can finish a case
 * while its body or a hook still runs (a timeout). That code keeps its case's token, so it no
 * longer owns the writer, and its shutdown does nothing. An owned shutdown is published in the run
 * that starts it. The next case's setup joins it and forgets it only after it settles.
 */
export interface WriterCaseOwner {
  /** True under the current case, or outside every case while no case runs. */
  owns(): boolean;
  /**
   * Starts an owned shutdown and publishes it in the same run. A call that is not owned returns a
   * settled promise and stops nothing.
   * @param stop The shutdown to start; the process-wide writer's shutdown by default.
   */
  shutdown(stop?: () => Promise<void>): Promise<void>;
  /** Joins a published shutdown until it settles. A join that Vitest abandons leaves it published. */
  join(): Promise<void>;
  /**
   * Runs one case under a new token. The file's aroundEach hook uses it; a directed witness can
   * nest it.
   */
  runCase<T>(run: () => Promise<T>): Promise<T>;
}

/** Installs the writer owner for every case of the calling test file. Call it at module scope. */
export function installWriterCaseOwner(): WriterCaseOwner {
  const caseOf = new AsyncLocalStorage<object>();
  let current: object | undefined;
  let published: Promise<void> | undefined;
  const owner: WriterCaseOwner = {
    owns: () => caseOf.getStore() === current,
    shutdown(stop = shutdownControlStoreWorkerClient) {
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
    async runCase(run) {
      const previous = current;
      const token = {};
      current = token;
      try {
        return await caseOf.run(token, run);
      } finally {
        if (current === token) current = previous;
      }
    },
  };
  aroundEach((runTest) => owner.runCase(runTest));
  return owner;
}
