// openkit-test-platform: posix
// The temporary repository resolves esbuild through a POSIX directory symlink to installed dependencies.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const bundlePath = 'skills/openkit-ops/scripts/openkit';

test('CLI drift check compares working-tree bytes and preserves the bundle and index', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-cli-drift-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'skills/openkit-cli.mjs');
  const bundle = join(root, bundlePath);
  const checker = join(root, 'scripts/check-openkit-cli.mjs');
  mkdirSync(dirname(bundle), { recursive: true });
  mkdirSync(dirname(checker), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts/check-openkit-cli.mjs'), checker);
  symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const generate = () =>
    execFileSync(
      join(repoRoot, 'node_modules/.bin/esbuild'),
      [
        'skills/openkit-cli.mjs',
        '--bundle',
        '--platform=node',
        '--target=node24',
        '--format=cjs',
        '--minify',
        `--outfile=${bundlePath}`,
      ],
      { cwd: root, stdio: 'pipe' }
    );
  const check = (expectedStatus) => {
    const before = {
      bundle: readFileSync(bundle),
      index: readFileSync(join(root, '.git/index')),
      mtimeMs: statSync(bundle).mtimeMs,
      mode: statSync(bundle).mode,
    };
    const result = spawnSync(process.execPath, [checker], {
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.equal(result.stdout, '');
    if (expectedStatus === 0) assert.equal(result.stderr, '');
    else assert.match(result.stderr, /CLI is stale\. Run pnpm build:openkit\./u);
    assert.deepEqual(readFileSync(bundle), before.bundle);
    assert.deepEqual(readFileSync(join(root, '.git/index')), before.index);
    assert.equal(statSync(bundle).mtimeMs, before.mtimeMs);
    assert.equal(statSync(bundle).mode, before.mode);
  };

  git('init', '--quiet');
  writeFileSync(source, 'console.log("initial");\n');
  generate();
  git('add', 'skills');

  await t.test('consistent staged source and bundle pass', () => check(0));
  await t.test('consistent unstaged source and bundle pass', () => {
    writeFileSync(source, 'console.log("unstaged");\n');
    generate();
    check(0);
  });
  await t.test('staged source with its current unstaged bundle passes', () => {
    git('add', 'skills/openkit-cli.mjs');
    check(0);
  });
  await t.test('changed source with a stale bundle fails without repair', () => {
    writeFileSync(source, 'console.log("changed source");\n');
    check(1);
  });
  await t.test('staged source with a stale bundle fails without repair', () => {
    git('add', 'skills');
    check(1);
  });
  await t.test('changed bundle with unchanged source fails without repair', () => {
    generate();
    git('add', 'skills');
    writeFileSync(bundle, '#!/usr/bin/env node\nconsole.log("stale bundle");\n');
    check(1);
  });
});

// Real elapsed time and sockets are intentional: a MockAgent delay does not exercise the HTTP headers timeout.
test('CLI waits beyond 300 seconds only for long KM work and never retries either request', {
  timeout: 700_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-cli-km-budget-'));
  const requests = [];
  const replied = [];
  const timers = new Set();
  const children = [];
  const maintenance = {
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: 'tu_00000000-0000-7000-8000-000000000001',
    outcome: 'no-change',
    notebookRevision: 'a'.repeat(40),
    summary: 'The overview is current.',
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ path: request.url, body: body ? JSON.parse(body) : null });
    const timer = setTimeout(() => {
      timers.delete(timer);
      replied.push(request.url);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.url.endsWith('/knowledge.maintain') ? maintenance : []));
    }, 305_000);
    timers.add(timer);
    response.once('close', () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  });
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const requestId = '00000000-0000-4000-8000-000000000001';
  const cases = [
    {
      operation: 'knowledge.maintain',
      input: {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        requestId,
        instruction: 'Inspect the overview.',
      },
    },
    { operation: 'workspace.list', input: {} },
  ];
  const results = await Promise.all(
    cases.map(async ({ operation, input }) => {
      const started = performance.now();
      const child = spawn(
        process.execPath,
        [join(repoRoot, 'skills/openkit-cli.mjs'), 'ops', 'call', operation, '--input', '-'],
        {
          cwd: root,
          // An invented fixture token avoids every OS credential-store read; no real credential enters the test.
          env: {
            HOME: root,
            XDG_CONFIG_HOME: root,
            PATH: root,
            OPENKIT_NANOCORE_URL: endpoint,
            OPENKIT_NANOCORE_TOKEN: 'okt_synthetic_budget_fixture',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 690_000,
        }
      );
      children.push(child);
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
      });
      const completed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) =>
          resolve({ operation, code, signal, stdout, stderr, elapsed: performance.now() - started })
        );
      });
      child.stdin.end(JSON.stringify(input));
      return completed;
    })
  );
  for (const result of results)
    t.diagnostic(
      JSON.stringify({
        operation: result.operation,
        exitCode: result.code,
        signal: result.signal,
        elapsedMs: Math.round(result.elapsed),
        requests: requests.filter((request) => request.path.endsWith(`/${result.operation}`))
          .length,
      })
    );
  // Check the unrelated-path control even when the intended KM assertion is RED.
  await t.test('unrelated calls retain their default finite transport budget without retry', () => {
    const ordinary = results.find((result) => result.operation === 'workspace.list');
    assert.equal(ordinary.signal, null, ordinary.stderr);
    assert.equal(ordinary.code, 3, ordinary.stdout);
    assert.equal(JSON.parse(ordinary.stdout).error.code, 'connection_failed');
    // Undici's coarse timer may differ by one tick; an early setup or validation failure is not this control.
    assert.ok(ordinary.elapsed >= 299_000, `Transport ended too early: ${ordinary.elapsed} ms`);
    assert.equal(requests.filter((request) => request.path.endsWith('/workspace.list')).length, 1);
    assert.equal(replied.includes('/api/app/operations/workspace.list'), false);
  });
  await t.test(
    'KM receives the delayed response once instead of the default headers timeout',
    () => {
      const km = results.find((result) => result.operation === 'knowledge.maintain');
      assert.equal(km.signal, null, km.stderr);
      assert.equal(
        requests.filter((request) => request.path.endsWith('/knowledge.maintain')).length,
        1
      );
      assert.equal(km.code, 0, km.stdout);
      const envelope = JSON.parse(km.stdout);
      assert.equal(envelope.ok, true);
      assert.deepEqual(envelope.data, maintenance);
      assert.equal(envelope.requestId, requestId);
      assert.ok(km.elapsed >= 305_000, `Response was not delayed: ${km.elapsed} ms`);
      assert.equal(replied.includes('/api/app/operations/knowledge.maintain'), true);
    }
  );
});
