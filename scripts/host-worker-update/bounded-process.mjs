/** Bounded local children for the operator's existing SSH and registry tools. */
import { spawn } from 'node:child_process';

const unavailable = 'Operator process unavailable; inspect before any new effect.';

/**
 * Collect complete bytes once; disconnect never proves a remote effect finished.
 * Callers own fixed command selection, authority and result schema admission.
 * @param {string} executable Locally selected tool, never request-selected shell code.
 * @param {string[]} args Fixed tool arguments with separately admitted data.
 * @param {object} options Explicit input, deadline and byte limits.
 * @returns {Promise<object>} Private complete process result; failures contain no tool output.
 */
export function runBoundedProcess(executable, args, options) {
  return new Promise((resolve, reject) => {
    const { input, timeoutMs, maxStdoutBytes, maxStderrBytes, signal, env } = options;
    if (signal?.aborted || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      ![maxStdoutBytes, maxStderrBytes].every((n) => Number.isSafeInteger(n) && n >= 0)) {
      reject(Error(unavailable));
      return;
    }
    const started = performance.now();
    const child = spawn(executable, args, { detached: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let outputBytes = 0, errorBytes = 0, settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', fail);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // This group contains only this invocation's local child and descendants.
      // Killing SSH cannot prove the remote operation's outcome.
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(Error(unavailable));
    };
    const timer = setTimeout(fail, timeoutMs);
    signal?.addEventListener('abort', fail, { once: true });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.stdout.on('data', (bytes) => {
      if (settled) return;
      outputBytes += bytes.length;
      if (outputBytes > maxStdoutBytes) return fail();
      stdout.push(bytes);
    });
    child.stderr.on('data', (bytes) => {
      if (settled) return;
      errorBytes += bytes.length;
      if (errorBytes > maxStderrBytes) return fail();
      stderr.push(bytes);
    });
    child.on('close', (exitCode, exitSignal) => {
      if (settled) return;
      if (performance.now() - started >= timeoutMs || exitSignal !== null) return fail();
      settled = true;
      cleanup();
      resolve({ exitCode, signal: exitSignal, timedOut: false,
        stdout: Buffer.concat(stdout, outputBytes), stderr: Buffer.concat(stderr, errorBytes) });
    });
    if (signal?.aborted) return fail();
    child.stdin.end(input);
  });
}
