#!/usr/bin/env node
/** Run Biome check while refusing a zero-file scan as successful repository source verification. */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function appendFailure(stderr, message) {
  return `${stderr}${stderr.length > 0 && !stderr.endsWith('\n') ? '\n' : ''}${message}\n`;
}

function signalStatus(signal) {
  const number = constants.signals[signal];
  return Number.isInteger(number) ? 128 + number : 1;
}

const displayColor = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'gu');

/** Remove SGR color sequences so a colored summary can still supply its checked-file count. */
function withoutDisplayColor(text) {
  return text.replace(displayColor, '');
}

function checkedFileCount(stdout, stderr) {
  const visible = withoutDisplayColor(`${stdout}\n${stderr}`);
  const count = /(?:^|\r?\n)Checked (\d+) files? in\b/u.exec(visible);
  return count ? Number(count[1]) : null;
}

/**
 * Keep a non-zero child status, including a signal status. A zero status changes only when the
 * output cannot prove that Biome checked at least one file.
 */
function judgeResult(status, stdout, stderr) {
  if (status !== 0) return { status, stdout, stderr };
  const count = checkedFileCount(stdout, stderr);
  if (count === null) {
    return {
      status: 1,
      stdout,
      stderr: appendFailure(
        stderr,
        'Biome check did not report its checked-file count; refusing to report successful source verification.'
      ),
    };
  }
  if (count === 0) {
    return {
      status: 1,
      stdout,
      stderr: appendFailure(
        stderr,
        'Biome check processed zero files; refusing to report successful source verification.'
      ),
    };
  }
  return { status: 0, stdout, stderr };
}

function collectStream(stream) {
  if (!stream) return Promise.resolve('');
  const chunks = [];
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', finish);
    stream.on('error', finish);
    stream.on('close', finish);
  });
}

/**
 * Execute `biome check` with the supplied arguments. Both output channels are streamed, and the
 * child exit status is preserved unless a successful scan cannot prove that it processed any file.
 */
export function runBiomeCheck(args, { spawn: spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl('pnpm', ['exec', 'biome', 'check', ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        status: 1,
        stdout: '',
        stderr: appendFailure('', `Biome check failed to start: ${error.message}`),
      });
      return;
    }
    const stdoutPromise = collectStream(child.stdout);
    const stderrPromise = collectStream(child.stderr);
    let settled = false;
    const finish = (status, startMessage) => {
      if (settled) return;
      settled = true;
      Promise.all([stdoutPromise, stderrPromise]).then(([stdout, stderr]) => {
        resolve(
          judgeResult(status, stdout, startMessage ? appendFailure(stderr, startMessage) : stderr)
        );
      });
    };
    child.once('error', (error) => {
      if (child.stdout && typeof child.stdout.destroy === 'function') child.stdout.destroy();
      if (child.stderr && typeof child.stderr.destroy === 'function') child.stderr.destroy();
      finish(1, `Biome check failed to start: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      finish(signal ? signalStatus(signal) : (code ?? 1), null);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runBiomeCheck(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status;
}
