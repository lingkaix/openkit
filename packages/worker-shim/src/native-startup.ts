import { LIFECYCLE_DEFAULTS } from './lifecycle-deadline.js';

/** Bounds cold startup through native acceptance, independently of active Turn capacity. */
export class NativeStartupAdmission {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  /** Uses the lifecycle-owned default unless a deterministic probe supplies a smaller bound. */
  public constructor(private readonly limit: number = LIFECYCLE_DEFAULTS.nativeStartupConcurrency) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error('Native startup concurrency must be a positive integer.');
  }

  /** Starts preparation only after admission; the caller creates its native deadlines inside work. */
  public async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      // An interrupt can arrive after admission but before this continuation runs.
      signal?.throwIfAborted();
      return await work();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }

  /** Removes abandoned waits before they can acquire a slot or launch a native process. */
  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const remove = () => {
        signal?.removeEventListener('abort', abort);
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const abort = () => {
        remove();
        reject(signal!.reason);
      };
      const waiter = () => {
        remove();
        this.active += 1;
        resolve();
      };
      this.queue.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

/** All native adapter families in this Sandbox-local shim share startup capacity. */
export const nativeStartupAdmission = new NativeStartupAdmission();
