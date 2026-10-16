/** Real child processes exercise byte limits, cancellation and unknown completion. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBoundedProcess } from './bounded-process.mjs';

test('one child receives exact stdin and returns complete bounded bytes', async () => {
  const result = await runBoundedProcess(
    process.execPath,
    ['-e', 'process.stdin.pipe(process.stdout)'],
    {
      input: Buffer.from('synthetic input\n'),
      timeoutMs: 5000,
      maxStdoutBytes: 100,
      maxStderrBytes: 10,
    }
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toString(), 'synthetic input\n');
  assert.equal(result.stderr.length, 0);
});

for (const stream of ['stdout', 'stderr']) {
  test(`${stream} overflow refuses rather than accepting truncated bytes`, async () => {
    await assert.rejects(
      runBoundedProcess(process.execPath, ['-e', `process.${stream}.write('x'.repeat(2048))`], {
        input: '',
        timeoutMs: 5000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
      }),
      /Operator process unavailable/
    );
  });
}

test('deadline stops collection even while a descendant holds the inherited pipe', async () => {
  const started = performance.now();
  await assert.rejects(
    runBoundedProcess(
      process.execPath,
      [
        '-e',
        "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});setTimeout(()=>{},30000)",
      ],
      {
        input: '',
        timeoutMs: 300,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
      }
    ),
    /Operator process unavailable/
  );
  assert.ok(performance.now() - started < 5000);
});

test('abort and missing executable reveal no command or operating-system diagnostic', async () => {
  const controller = new AbortController();
  controller.abort();
  const options = { input: '', timeoutMs: 5000, maxStdoutBytes: 1024, maxStderrBytes: 1024 };
  for (const [executable, extra] of [
    [process.execPath, { signal: controller.signal }],
    ['openkit-synthetic-missing-executable', {}],
  ]) {
    await assert.rejects(runBoundedProcess(executable, [], { ...options, ...extra }), {
      message: 'Operator process unavailable; inspect before any new effect.',
    });
  }
});
