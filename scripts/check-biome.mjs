#!/usr/bin/env node
/** Run Biome check while refusing a zero-file scan as successful repository source verification. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const displayColor = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'gu');
const summaryPattern = /(?:^|\r?\n)Checked (\d+) files? in\b/u;
const summaryLimit = 4096;

function withoutDisplayColor(text) {
  displayColor.lastIndex = 0;
  return text.replace(displayColor, '');
}

/** Retain only the trailing text required to recognize Biome's checked-file summary. */
function createSummary() {
  let carry = '';
  let count = null;
  return {
    push(text) {
      carry = `${carry}${text}`.slice(-summaryLimit);
      const match = summaryPattern.exec(withoutDisplayColor(carry));
      if (match) count = Number(match[1]);
    },
    get count() {
      return count;
    },
  };
}

function pipeForward(stream, destination, summary) {
  if (!stream) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      summary.push(buffer.toString('utf8'));
      if (!destination.write(buffer)) {
        stream.pause();
        destination.once('drain', () => stream.resume());
      }
    });
    stream.on('end', finish);
    stream.on('error', finish);
    stream.on('close', finish);
  });
}

function writeFailure(destination, stderrOpen, message) {
  if (!stderrOpen) destination.write('\n');
  destination.write(`${message}\n`);
}

/**
 * Execute `biome check` with the supplied arguments. Child bytes are forwarded as they arrive.
 * A zero status changes only when the forwarded summary cannot prove that Biome checked a file.
 * A signal is returned so the parent can end by that same signal.
 */
export function runBiomeCheck(
  args,
  { spawn: spawnImpl = spawn, stdout = process.stdout, stderr = process.stderr } = {}
) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl('pnpm', ['exec', 'biome', 'check', ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      writeFailure(stderr, true, `Biome check failed to start: ${error.message}`);
      resolve({ status: 1, signal: null });
      return;
    }
    const summary = createSummary();
    let stderrOpen = true;
    const stdoutDone = pipeForward(child.stdout, stdout, summary);
    const stderrDone = pipeForward(child.stderr, stderr, summary);
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrOpen = buffer.length === 0 || buffer[buffer.length - 1] === 0x0a;
      });
    }
    let settled = false;
    const finish = (status, signal, startMessage) => {
      if (settled) return;
      settled = true;
      Promise.all([stdoutDone, stderrDone]).then(() => {
        if (startMessage) {
          writeFailure(stderr, stderrOpen, startMessage);
          resolve({ status: 1, signal: null });
          return;
        }
        if (signal) {
          resolve({ status: null, signal });
          return;
        }
        if (status !== 0) {
          resolve({ status, signal: null });
          return;
        }
        if (summary.count === null) {
          writeFailure(
            stderr,
            stderrOpen,
            'Biome check did not report its checked-file count; refusing to report successful source verification.'
          );
          resolve({ status: 1, signal: null });
          return;
        }
        if (summary.count === 0) {
          writeFailure(
            stderr,
            stderrOpen,
            'Biome check processed zero files; refusing to report successful source verification.'
          );
          resolve({ status: 1, signal: null });
          return;
        }
        resolve({ status: 0, signal: null });
      });
    };
    child.once('error', (error) => {
      if (child.stdout && typeof child.stdout.destroy === 'function') child.stdout.destroy();
      if (child.stderr && typeof child.stderr.destroy === 'function') child.stderr.destroy();
      finish(1, null, `Biome check failed to start: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      finish(signal ? null : (code ?? 1), signal, null);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runBiomeCheck(process.argv.slice(2));
  if (result.signal) {
    process.kill(process.pid, result.signal);
    await new Promise(() => {});
  }
  process.exitCode = result.status;
}
