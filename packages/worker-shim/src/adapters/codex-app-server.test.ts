import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { LIFECYCLE_DEFAULTS } from '../lifecycle-deadline.js';
import { CodexAppServer, type CodexAuthTokensRefreshReply } from './codex-app-server.js';

/** Unspawned stdio transport; the test owns its native frames and observes response writes. */
function diagnosticFixture(
  values: string[] = [],
  options: {
    readonly onBroken?: (reason: string) => void;
    readonly refreshAuthTokens?: ConstructorParameters<typeof CodexAppServer>[5];
  } = {}
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdio: ChildProcessWithoutNullStreams['stdio'] = [stdin, stdout, stderr, null, null];
  const child = Object.assign(new ChildProcess(), { stdin, stdout, stderr, stdio });
  const rpc = new CodexAppServer(
    child,
    values,
    () => undefined,
    options.onBroken ?? (() => undefined),
    undefined,
    options.refreshAuthTokens
  );
  return {
    rpc,
    stdin,
    stdout,
    stderr,
    close: () => {
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

// Work Data Retention, Confidentiality: late known material must not survive stream truncation.
it('excludes a late registered long credential split across stderr chunks', () => {
  const values: string[] = [];
  const f = diagnosticFixture(values);
  const credential = 'a'.repeat(22_000) + 'Z';
  values.push(credential);
  try {
    f.stderr.write(Buffer.from(credential.slice(0, 20_000)));
    f.stderr.write(Buffer.from(credential.slice(20_000)));
    const diagnostic = f.rpc.stderrDiagnostic();
    // Keep the synthetic credential and diagnostic out of failed assertion output.
    expect(diagnostic.includes(credential.slice(0, 16_384))).toBe(false);
    expect(Buffer.byteLength(diagnostic) <= 16 * 1024).toBe(true);
  } finally {
    f.close();
  }
});

it('preserves exclusion of a short credential split across stderr chunks', () => {
  const credential = 'synthetic-small-credential';
  const f = diagnosticFixture([credential]);
  try {
    f.stderr.write(Buffer.from(credential.slice(0, 8)));
    f.stderr.write(Buffer.from(credential.slice(8)));
    const diagnostic = f.rpc.stderrDiagnostic();
    expect(diagnostic === '[redacted]').toBe(true);
    expect(diagnostic.includes(credential)).toBe(false);
  } finally {
    f.close();
  }
});

it('preserves exact ordinary diagnostic text across stderr chunks', () => {
  const f = diagnosticFixture();
  try {
    f.stderr.write(Buffer.from('ordinary '));
    f.stderr.write(Buffer.from('diagnostic text'));
    expect(f.rpc.stderrDiagnostic() === 'ordinary diagnostic text').toBe(true);
  } finally {
    f.close();
  }
});

it('preserves the exact 16 KiB ordinary diagnostic prefix', () => {
  const f = diagnosticFixture();
  try {
    f.stderr.write(Buffer.from('p'.repeat(20_000)));
    const diagnostic = f.rpc.stderrDiagnostic();
    expect(diagnostic === 'p'.repeat(16 * 1024)).toBe(true);
    expect(Buffer.byteLength(diagnostic)).toBe(16 * 1024);
  } finally {
    f.close();
  }
});

// Codex native control deadline: a pending private refresh must lose its original allowance.
it('aborts the pending private refresh callback at the native request deadline', async () => {
  const held = Promise.withResolvers<CodexAuthTokensRefreshReply>();
  const complete = vi.fn(() => Promise.resolve());
  const reply = {
    result: {
      accessToken: 'synthetic-refresh-access',
      chatgptAccountId: 'synthetic-refresh-account',
      chatgptPlanType: null,
    },
    complete,
  };
  // The optional test parameter permits observing the same callback on OLD without setup refusal.
  const refreshAuthTokens = vi.fn((_params: unknown, _signal?: AbortSignal) => held.promise);
  const onBroken = vi.fn<(reason: string) => void>();
  const f = diagnosticFixture([], { onBroken, refreshAuthTokens });
  let responseWrites = 0;
  f.stdin.on('data', () => {
    responseWrites += 1;
  });
  vi.useFakeTimers();
  try {
    const params = { reason: 'unauthorized', previousAccountId: 'synthetic-refresh-account' };
    f.stdout.write(
      `${JSON.stringify({ id: 1, method: 'account/chatgptAuthTokens/refresh', params })}\n`
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshAuthTokens).toHaveBeenCalledTimes(1);
    expect(refreshAuthTokens.mock.calls[0]?.[0]).toEqual(params);
    const signal = refreshAuthTokens.mock.calls[0]?.[1];

    await vi.advanceTimersByTimeAsync(LIFECYCLE_DEFAULTS.nativeRequestMs - 1);
    expect(signal?.aborted ?? false).toBe(false);
    expect(onBroken).not.toHaveBeenCalled();
    expect(responseWrites).toBe(0);
    expect(complete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onBroken.mock.calls).toEqual([
      ['Codex native authentication refresh deadline expired.'],
    ]);
    const abortedAtDeadline = signal?.aborted;

    // A late reply cannot write or complete. Join the callback before the deciding assertion.
    held.resolve(reply);
    await held.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(responseWrites).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(abortedAtDeadline).toBe(true);
  } finally {
    held.resolve(reply);
    try {
      await held.promise;
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      f.close();
      vi.useRealTimers();
    }
  }
});
