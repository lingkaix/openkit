// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const caddyfile = join(repoRoot, 'Caddyfile');
const dockerfile = join(repoRoot, 'containers', 'app', 'Dockerfile');
const entrypoint = join(repoRoot, 'containers', 'app', 'entrypoint.sh');

test('uses the App HTTP upstream without publishing NanoHost transport', async () => {
  const source = await readFile(caddyfile, 'utf8');
  const privateTransport = source.indexOf('handle /api/nanohost/transport/*');
  const publicApi = source.indexOf('handle /api/*');

  assert.ok(privateTransport >= 0 && privateTransport < publicApi, source);
  assert.match(source.slice(privateTransport, publicApi), /respond 404/u);
  assert.equal(
    [...source.matchAll(/reverse_proxy 127\.0\.0\.1:\{\$OPENKIT_HTTP_PORT:4317\}/gu)].length,
    3,
    source
  );
  assert.doesNotMatch(source, /h2c:\/\//u);
});

test('routes container signals through the supervising entrypoint exactly once', async () => {
  const source = await readFile(dockerfile, 'utf8');
  assert.match(source, /ENTRYPOINT \["tini", "--", "\/usr\/local\/bin\/openkit-app-entrypoint"\]/u);
  assert.doesNotMatch(source, /ENTRYPOINT \["tini", "-g"/u);
});

test('waits for NanoCore through the App health endpoint and stops both processes on INT', async () => {
  const result = await runEntrypoint({
    readiness: 'after-30',
    signal: 'SIGINT',
    signalAt: 'caddy',
  });
  assert.equal(result.close?.code, 130, result.output);
  assert.equal(result.curlCount, '31\n');
  assert.ok(!result.curlArguments.includes('--http2-prior-knowledge'), result.output);
  assert.ok(result.curlArguments.includes(result.healthUrl), result.output);
  assert.equal(result.nodeStop, 'stopped\n', result.output);
  assert.equal(result.caddyStop, 'stopped\n', result.output);
  assert.deepEqual(result.caddyArguments, [
    'run',
    '--config',
    '/etc/caddy/Caddyfile',
    '--adapter',
    'caddyfile',
  ]);
});

test('terminates during readiness without starting Caddy', async () => {
  const result = await runEntrypoint({
    readiness: 'blocking',
    signal: 'SIGTERM',
    signalAt: 'curl',
  });
  assert.equal(result.close?.code, 143, result.output);
  assert.equal(result.nodeStop, 'stopped\n', result.output);
  assert.equal(result.caddyArguments, null, result.output);
});

test('preserves a nonzero Caddy exit and stops NanoCore', async () => {
  const result = await runEntrypoint({ caddyExit: '17', readiness: 'immediate', signal: null });
  assert.equal(result.close?.code, 17, result.output);
  assert.equal(result.nodeStop, 'stopped\n', result.output);
});

/** Runs one isolated entrypoint lifecycle. */
async function runEntrypoint({ caddyExit = '', readiness, signal, signalAt = 'caddy' }) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'openkit-app-entrypoint-'));
  const binRoot = join(fixtureRoot, 'bin');
  const caddyRecord = join(fixtureRoot, 'caddy-argv.txt');
  const caddyStopRecord = join(fixtureRoot, 'caddy-stop.txt');
  const curlCount = join(fixtureRoot, 'curl-count.txt');
  const curlRecord = join(fixtureRoot, 'curl-argv.txt');
  const curlStarted = join(fixtureRoot, 'curl-started.txt');
  const nodeStopRecord = join(fixtureRoot, 'node-stop.txt');
  const httpPort = '44321';
  const healthUrl = `http://127.0.0.1:${httpPort}/api/health`;
  await mkdir(binRoot);
  await Promise.all([
    writeExecutable(
      join(binRoot, 'node'),
      `#!/bin/sh
trap 'printf "stopped\\n" > "$OPENKIT_TEST_NODE_STOP_RECORD"; exit 0' TERM INT
while :; do
  /bin/sleep 1
done
`
    ),
    writeExecutable(
      join(binRoot, 'curl'),
      `#!/bin/sh
printf 'started\n' > "$OPENKIT_TEST_CURL_STARTED"
if [ "$OPENKIT_TEST_READINESS" = 'blocking' ]; then
  /bin/sleep 0.2
  exit 0
fi
count=0
if [ -f "$OPENKIT_TEST_CURL_COUNT" ]; then
  count=$(cat "$OPENKIT_TEST_CURL_COUNT")
fi
count=$((count + 1))
printf '%s\n' "$count" > "$OPENKIT_TEST_CURL_COUNT"
printf '%s\n' "$@" > "$OPENKIT_TEST_CURL_RECORD"
saw_health=0
for argument in "$@"; do
  if [ "$argument" = "$OPENKIT_TEST_HEALTH_URL" ]; then
    saw_health=1
  fi
done
[ "$OPENKIT_TEST_READINESS" = 'immediate' ] && exit 0
[ "$count" -ge 31 ] && [ "$saw_health" -eq 1 ]
`
    ),
    writeExecutable(join(binRoot, 'sleep'), '#!/bin/sh\nexit 0\n'),
    writeExecutable(
      join(binRoot, 'caddy'),
      `#!/bin/sh
printf '%s\n' "$@" > "$OPENKIT_TEST_CADDY_RECORD"
if [ -n "$OPENKIT_TEST_CADDY_EXIT" ]; then
  exit "$OPENKIT_TEST_CADDY_EXIT"
fi
trap 'printf "stopped\n" > "$OPENKIT_TEST_CADDY_STOP_RECORD"; exit 0' TERM INT
while :; do
  /bin/sleep 1
done
`
    ),
  ]);

  const child = spawn('/bin/bash', [entrypoint], {
    detached: true,
    env: {
      ...process.env,
      CADDY_HTTP_PORT: '8080',
      OPENKIT_DATA_ROOT: join(fixtureRoot, 'data'),
      OPENKIT_HTTP_PORT: httpPort,
      OPENKIT_TEST_CADDY_RECORD: caddyRecord,
      OPENKIT_TEST_CADDY_STOP_RECORD: caddyStopRecord,
      OPENKIT_TEST_CADDY_EXIT: caddyExit,
      OPENKIT_TEST_CURL_COUNT: curlCount,
      OPENKIT_TEST_CURL_RECORD: curlRecord,
      OPENKIT_TEST_CURL_STARTED: curlStarted,
      OPENKIT_TEST_HEALTH_URL: healthUrl,
      OPENKIT_TEST_NODE_STOP_RECORD: nodeStopRecord,
      OPENKIT_TEST_READINESS: readiness,
      PATH: `${binRoot}:/usr/bin:/bin`,
      PORT: httpPort,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = collectOutput(child);
  let close = null;

  try {
    await waitForFile(signalAt === 'curl' ? curlStarted : caddyRecord);
    if (signal !== null) {
      child.kill(signal);
    }
    close = await Promise.race([onceClosed(child), delay(3_000).then(() => null)]);
  } finally {
    if (close === null) {
      terminateProcessGroup(child.pid, 'SIGKILL');
      await Promise.race([onceClosed(child), delay(750)]);
    }
  }

  try {
    return {
      caddyArguments: await readLines(caddyRecord),
      caddyStop: await readFile(caddyStopRecord, 'utf8').catch(() => null),
      close,
      curlArguments: (await readFile(curlRecord, 'utf8').catch(() => '')).trim().split('\n'),
      curlCount: await readFile(curlCount, 'utf8').catch(() => null),
      healthUrl,
      nodeStop: await readFile(nodeStopRecord, 'utf8').catch(() => null),
      output: output(),
    };
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
}

/** Reads one line-oriented record when present. */
async function readLines(target) {
  const contents = await readFile(target, 'utf8').catch(() => null);
  return contents === null ? null : contents.trim().split('\n');
}

/** Waits for one test-double record. */
async function waitForFile(target) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      await readFile(target);
      return;
    } catch {}
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${target}`);
}

/** Writes one executable test double. */
async function writeExecutable(target, source) {
  await writeFile(target, source, 'utf8');
  await chmod(target, 0o755);
}

/** Resolves when one child closes, including when it already closed. */
function onceClosed(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveClose) =>
    child.once('close', (code, signal) => resolveClose({ code, signal }))
  );
}

/** Collects bounded test-double output for assertion diagnostics. */
function collectOutput(child) {
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  return () => Buffer.concat(chunks).toString('utf8');
}

/** Stops the entrypoint and every fake process in its isolated process group. */
function terminateProcessGroup(processId, signal) {
  if (processId === undefined) {
    return;
  }
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }
}

/** Resolves after a short test-only bound. */
function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
