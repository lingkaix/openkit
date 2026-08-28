// openkit-test-platform-divergence
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smokeScript = join(repoRoot, 'tests/smoke/web-preview-smoke.mjs');

test('Web preview smoke exits after PASS and terminates the preview process tree', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-web-preview-cleanup-'));
  const fakeBin = join(fixtureRoot, 'bin');
  const previewScript = join(fixtureRoot, 'preview.mjs');
  const previewPidFile = join(fixtureRoot, 'preview.pid');
  const fakePnpm = join(fakeBin, 'pnpm');
  mkdirSync(fakeBin);
  writeFileSync(
    previewScript,
    `import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const portIndex = process.argv.indexOf('--port');
const port = Number(process.argv[portIndex + 1]);
writeFileSync(process.env.FAKE_PREVIEW_PID_FILE, String(process.pid));
process.on('SIGTERM', () => {});
createServer((request, response) => {
  response.statusCode = 200;
  response.setHeader('content-type', request.url === '/' ? 'text/html' : 'text/javascript');
  response.end(
    request.url === '/'
      ? '<div id="root"></div><script src="/assets/app.js"></script>'
      : 'globalThis.__openkitPreviewSmoke = true;'
  );
}).listen(port, '127.0.0.1');
`
  );
  writeFileSync(
    fakePnpm,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process');
spawn(process.execPath, [process.env.FAKE_PREVIEW_SCRIPT, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
setInterval(() => {}, 1_000);
`,
    { mode: 0o755 }
  );

  const smoke = spawn(process.execPath, [smokeScript], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      FAKE_PREVIEW_PID_FILE: previewPidFile,
      FAKE_PREVIEW_SCRIPT: previewScript,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  smoke.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  smoke.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const closed = new Promise((resolveClose) => smoke.once('close', resolveClose));
  let deadline;

  try {
    const outcome = await Promise.race([
      new Promise((resolveExit) => {
        smoke.once('exit', (code, signal) => resolveExit({ code, kind: 'exit', signal }));
      }),
      new Promise((resolveTimeout) => {
        deadline = setTimeout(() => resolveTimeout({ kind: 'timeout' }), 5_000);
      }),
    ]);

    assert.match(
      stdout,
      /OpenKit Web built-artifact smoke PASS/u,
      `web preview fixture did not reach PASS\nstderr:\n${stderr}`
    );
    assert.deepEqual(
      outcome,
      { code: 0, kind: 'exit', signal: null },
      `web preview smoke retained its preview process tree after PASS\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  } finally {
    clearTimeout(deadline);
    if (smoke.exitCode === null && smoke.signalCode === null) {
      if (process.platform === 'win32' || smoke.pid === undefined) {
        smoke.kill('SIGKILL');
      } else {
        process.kill(-smoke.pid, 'SIGKILL');
      }
    }
    await closed;

    if (existsSync(previewPidFile) && readFileSync(previewPidFile, 'utf8').trim()) {
      const previewPid = Number(readFileSync(previewPidFile, 'utf8'));
      assert.throws(
        () => process.kill(previewPid, 0),
        (error) => error instanceof Error && 'code' in error && error.code === 'ESRCH',
        'Web preview smoke cleanup left the preview process alive'
      );
    }
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});
