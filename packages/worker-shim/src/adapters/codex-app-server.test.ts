import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { CodexAppServer } from './codex-app-server.js';

/** Unspawned stdio transport for diagnostic admission; it supplies no native result. */
function diagnosticFixture(values: string[] = []) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdio: ChildProcessWithoutNullStreams['stdio'] = [stdin, stdout, stderr, null, null];
  const child = Object.assign(new ChildProcess(), { stdin, stdout, stderr, stdio });
  const rpc = new CodexAppServer(
    child,
    values,
    () => undefined,
    () => undefined
  );
  return {
    rpc,
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
