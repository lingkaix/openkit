import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createWriterCaseOwner, WRITER_SUITE_HOOK_RUNNER_MARGIN_MS } from './writer-case-owner.js';

/** Waits on the real clock. */
const elapse = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A promise that the test settles. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// S3a-r2d A8 finding 1: the owner fails closed. Each stop below is a stub, so no writer runs.
describe('writer case owner', () => {
  it('refuses a stop with no token while no unit runs', async () => {
    const owner = createWriterCaseOwner();
    const stop = vi.fn(async () => undefined);
    expect(owner.owns()).toBe(false);
    await owner.shutdown(stop);
    expect(stop).not.toHaveBeenCalled();
  });

  it('ends a suite hook token at its runner timeout, and keeps it until then', async () => {
    const owner = createWriterCaseOwner();
    const late = vi.fn(async () => undefined);
    const work = deferred();
    const tried = deferred();
    const stale = owner.runHook(async () => {
      await work.promise;
      await owner.shutdown(late);
      tried.resolve();
    }, 20);
    // S3a-r2e: the owner completes the hook at its bound, while the hook's own code still runs.
    let outcome = 'pending';
    stale.then(
      () => {
        outcome = 'settled';
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error.message : String(error);
      }
    );
    await elapse(60);
    expect(outcome).toBe(
      'Suite hook timed out in 20 ms: the writer owner ended it and revoked its writer token.'
    );
    work.resolve();
    await tried.promise;
    expect(late).not.toHaveBeenCalled();
    // Control: a stop before the timeout runs once.
    const own = vi.fn(async () => undefined);
    await owner.runHook(() => owner.shutdown(own), 10_000);
    expect(own).toHaveBeenCalledTimes(1);
  });

  it('lets a sibling suite hook supersede a stale one at its entry', async () => {
    const owner = createWriterCaseOwner();
    const late = vi.fn(async () => undefined);
    const own = vi.fn(async () => undefined);
    const work = deferred();
    const stale = owner.runHook(async () => {
      await work.promise;
      await owner.shutdown(late);
    }, 60_000);
    await owner.runHook(async () => {
      work.resolve();
      await stale;
      await owner.shutdown(own);
    }, 60_000);
    expect(late).not.toHaveBeenCalled();
    expect(own).toHaveBeenCalledTimes(1);
  });

  it('runs a suite hook only after a published shutdown settles', async () => {
    const owner = createWriterCaseOwner();
    const drain = deferred();
    await owner.runHook(async () => {
      void owner.shutdown(() => drain.promise);
    }, 10_000);
    const order: string[] = [];
    const next = owner.runHook(async () => {
      order.push('body');
    }, 10_000);
    await elapse(10);
    expect(order).toEqual([]);
    drain.resolve();
    await next;
    expect(order).toEqual(['body']);
  });

  it('revokes a suite hook token before it rejects at its bound (S3a-r2e A8 finding 1)', async () => {
    const owner = createWriterCaseOwner();
    const work = deferred();
    let underStale: (<T>(run: () => T) => T) | undefined;
    const stale = owner.runHook(async () => {
      underStale = AsyncLocalStorage.snapshot();
      await work.promise;
    }, 20);
    // The first code that sees the rejection reads ownership under the stale hook's own token.
    let seen: unknown = 'pending';
    stale.then(
      () => {
        seen = 'settled';
      },
      () => {
        seen = underStale?.(() => owner.owns());
      }
    );
    await elapse(60);
    work.resolve();
    await stale.catch(() => undefined);
    expect(seen).toBe(false);
  });

  it('ends every inner token when the runner completes a case', async () => {
    const owner = createWriterCaseOwner();
    const late = vi.fn(async () => undefined);
    const work = deferred();
    let inner: Promise<void> | undefined;
    await owner.runTest(async () => {
      expect(owner.owns()).toBe(true);
      inner = owner.runCase(async () => {
        await work.promise;
        await owner.shutdown(late);
      });
    });
    work.resolve();
    await inner;
    expect(late).not.toHaveBeenCalled();
    expect(owner.owns()).toBe(false);
  });
});

const nanocoreRoot = fileURLToPath(new URL('../..', import.meta.url));
const vitestCli = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs'
);

/** Runs `writer-case-owner.timeout.fixture.ts` in a nested Vitest run. */
async function runTimeoutFixture(): Promise<{
  code: number | null;
  output: string;
  events: Record<string, unknown>[];
  report: {
    numFailedTests: number;
    testResults: { assertionResults: { title: string; status: string }[] }[];
  };
}> {
  const scratch = mkdtempSync(join(tmpdir(), 'writer-owner-timeout-'));
  try {
    const config = join(scratch, 'vitest.config.mjs');
    const eventsPath = join(scratch, 'events.jsonl');
    const reportPath = join(scratch, 'report.json');
    writeFileSync(eventsPath, '');
    writeFileSync(
      config,
      `export default { root: ${JSON.stringify(nanocoreRoot)}, test: {
        include: ['src/test-support/writer-case-owner.timeout.fixture.ts'],
        pool: 'forks', maxWorkers: 1, fileParallelism: false, watch: false } };\n`
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NO_COLOR: '1',
      WRITER_OWNER_TIMEOUT_EVENTS: eventsPath,
    };
    for (const key of Object.keys(env)) {
      if (key.startsWith('VITEST') || key === 'FORCE_COLOR') delete env[key];
    }
    const { code, output } = await new Promise<{ code: number | null; output: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          [
            vitestCli,
            'run',
            '--config',
            config,
            '--reporter=default',
            '--reporter=json',
            `--outputFile.json=${reportPath}`,
          ],
          { cwd: nanocoreRoot, env, timeout: 90_000 },
          (error, stdout, stderr) => {
            const exit = error && 'code' in error ? error.code : 0;
            resolve({ code: typeof exit === 'number' ? exit : null, output: `${stdout}${stderr}` });
          }
        );
      }
    );
    const events = readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    return { code, output, events, report };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// S3a-r2e A8 finding 1, the real runner timeout: a real owner.beforeAll times out at its bound and
// a plain afterAll releases it. The released hook's stop must stop nothing during the teardown,
// before any successor owner enters. The successor suite's own stop runs once.
describe('writer suite hook timeout in a real Vitest run (S3a-r2e A8 finding 1)', () => {
  it('a timed-out suite hook stops nothing during its suite teardown before a successor owner enters', async () => {
    expect(WRITER_SUITE_HOOK_RUNNER_MARGIN_MS).toBeGreaterThan(0);
    const run = await runTimeoutFixture();
    expect(run.events, run.output).toEqual([
      { event: 'hook-entered', owns: true },
      { event: 'teardown-entered', stops: 0 },
      { event: 'hook-resumed', owns: false },
      { event: 'teardown-done', stops: 0 },
      { event: 'successor-entered', stops: 0 },
      { event: 'successor-stopped', stops: 1 },
      { event: 'successor-case', owns: true },
    ]);
    // The owner, not Vitest, completed the timed-out hook. The run fails only for that hook.
    expect(run.code, run.output).toBe(1);
    expect(run.output).toContain(
      'Error: Suite hook timed out in 25 ms: the writer owner ended it and revoked its writer token.'
    );
    expect(run.output).not.toContain('Hook timed out in');
    expect(run.output).toMatch(/Failed Suites 1\b/);
    expect(run.report.numFailedTests, run.output).toBe(0);
    const [file] = run.report.testResults;
    expect(run.report.testResults).toHaveLength(1);
    expect(
      file?.assertionResults.map(({ title, status }) => ({ title, status })),
      run.output
    ).toEqual([
      { title: 'does not run after its suite hook times out', status: 'skipped' },
      { title: 'owns the writer in its case', status: 'passed' },
    ]);
  }, 120_000);
});
