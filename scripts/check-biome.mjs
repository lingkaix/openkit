#!/usr/bin/env node
/** Run Biome check while refusing a zero-file scan as successful repository source verification. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const displayColor = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'gu');
const summaryLine = /^Checked (\d+) files? in\b/u;

function withoutDisplayColor(text) {
  displayColor.lastIndex = 0;
  return text.replace(displayColor, '');
}

/**
 * Recognize a checked-file summary only as a complete line.
 * Keep at most 4096 characters of each line's prefix, not its unbounded unfinished tail.
 * The summary starts at column zero; its duration and diagnostic suffix are not needed.
 */
function createLineParser() {
  let pending = '';
  let truncated = false;
  let count = null;
  return {
    push(text) {
      let rest = text;
      while (rest.length > 0) {
        const newlineAt = rest.indexOf('\n');
        const end = newlineAt === -1 ? rest.length : newlineAt;
        const available = 4096 - pending.length;
        pending += rest.slice(0, Math.min(end, available));
        truncated ||= end > available;
        if (newlineAt === -1) return;
        const line = withoutDisplayColor(pending);
        const match = summaryLine.exec(line);
        // A truncated prefix must not manufacture the word boundary after "in".
        if (match && (!truncated || match[0].length < line.length)) count = Number(match[1]);
        pending = '';
        truncated = false;
        rest = rest.slice(newlineAt + 1);
      }
    },
    get count() {
      return count;
    },
  };
}

/** A positive count on either channel proves that Biome checked a file. */
function provedCount(parsers) {
  let sawZero = false;
  for (const parser of parsers) {
    if (parser.count === null) continue;
    if (parser.count > 0) return parser.count;
    sawZero = true;
  }
  return sawZero ? 0 : null;
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
 * Stdout and stderr each parse their own complete lines. A zero status changes only when neither
 * channel can prove that Biome checked a file. A signal is returned so the parent can end by it.
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
    const stdoutSummary = createLineParser();
    const stderrSummary = createLineParser();
    let stderrOpen = true;
    const stdoutDone = pipeForward(child.stdout, stdout, stdoutSummary);
    const stderrDone = pipeForward(child.stderr, stderr, stderrSummary);
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
        const count = provedCount([stdoutSummary, stderrSummary]);
        if (count === null) {
          writeFailure(
            stderr,
            stderrOpen,
            'Biome check did not report its checked-file count; refusing to report successful source verification.'
          );
          resolve({ status: 1, signal: null });
          return;
        }
        if (count === 0) {
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
