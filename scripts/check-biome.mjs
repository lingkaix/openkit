#!/usr/bin/env node
/** Run Biome check while refusing a zero-file scan as successful repository source verification. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function appendFailure(stderr, message) {
  return `${stderr}${stderr.length > 0 && !stderr.endsWith('\n') ? '\n' : ''}${message}\n`;
}

/**
 * Execute `biome check` with the supplied arguments and preserve its result unless a successful
 * scan cannot prove that it processed any file.
 */
export function runBiomeCheck(args, { spawn = spawnSync } = {}) {
  const result = spawn('pnpm', ['exec', 'biome', 'check', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.error) {
    return {
      status: 1,
      stdout,
      stderr: appendFailure(stderr, `Biome check failed to start: ${result.error.message}`),
    };
  }
  if (result.signal) {
    return {
      status: 1,
      stdout,
      stderr: appendFailure(stderr, `Biome check terminated by signal ${result.signal}.`),
    };
  }
  if (result.status !== 0) return { status: result.status ?? 1, stdout, stderr };

  const count = /(?:^|\r?\n)Checked (\d+) files? in\b/u.exec(`${stdout}\n${stderr}`);
  if (!count) {
    return {
      status: 1,
      stdout,
      stderr: appendFailure(
        stderr,
        'Biome check did not report its checked-file count; refusing to report successful source verification.'
      ),
    };
  }
  if (Number(count[1]) === 0) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = runBiomeCheck(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status;
}
