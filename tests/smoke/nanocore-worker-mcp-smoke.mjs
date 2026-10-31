import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect as connectHttp2 } from 'node:http2';
import { connect as connectTcp, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Checks only built-process boot and public/private listener readiness; Task/MCP belongs in L3. */
async function main() {
  const appPort = await findOpenPort();
  let nanoHostPort = await findOpenPort();
  while (nanoHostPort === appPort) nanoHostPort = await findOpenPort();
  const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-worker-readiness-'));
  let child;
  let h2;
  try {
    await mkdir(join(dataRoot, 'config'));
    const slot = (name) => ({
      companionPath: join(dataRoot, 'fixture-delivery', `${name}.json`),
      secretPath: join(dataRoot, 'fixture-delivery', `${name}.token`),
    });
    // These isolated delivery locations remain unused: readiness issues no credential.
    await writeFile(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        mode: 'local',
        nanohost: {
          bind: { host: '127.0.0.1', port: nanoHostPort },
          credentialRef: 'nanohost-transport:worker-readiness',
          credentialSlots: { A: slot('A'), B: slot('B') },
          deploymentId: 'dep_0190f4c8-0000-7000-8000-000000000602',
          identityId: 'nanohost-worker-readiness',
          rendezvousUrl: `http://127.0.0.1:${nanoHostPort}`,
        },
      })
    );
    const env = {
      ...process.env,
      OPENKIT_BIND_HOST: '127.0.0.1',
      OPENKIT_CORE_MODE: 'local',
      OPENKIT_DATA_ROOT: dataRoot,
      PORT: String(appPort),
    };
    delete env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;
    child = spawn(process.execPath, [join(repoRoot, 'apps/nanocore/dist/index.js')], {
      cwd: join(repoRoot, 'apps/nanocore'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Drain output without publishing fixture delivery locations or process values.
    child.stdout.resume();
    child.stderr.resume();
    const baseUrl = `http://127.0.0.1:${appPort}`;
    await waitForHealth(baseUrl, child);
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    assert.equal((await fetch(`${baseUrl}/api/meta`)).status, 200);
    h2 = connectHttp2(`http://127.0.0.1:${nanoHostPort}`);
    // Retain a listener on the connection while requests own their deciding error.
    h2.on('error', () => undefined);
    assert.equal(await requestStatus(h2, 'GET', '/api/health'), 404);
    assert.equal(await requestStatus(h2, 'POST', '/api/nanohost/transport/session/admit'), 401);
    const closed = new Promise((resolveClose) => h2.once('close', resolveClose));
    h2.close();
    await closed;
    h2 = undefined;
    await stopProcess(child);
    await assertPortClosed(appPort);
    await assertPortClosed(nanoHostPort);
  } finally {
    h2?.destroy();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
      child.kill('SIGKILL');
      await exited;
    }
    await rm(dataRoot, { recursive: true, force: true });
  }
  console.log('OpenKit NanoCore Worker-listener built-artifact readiness smoke PASS');
}

/** Waits under the original thirty-second boot bound without starting product work. */
async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`NanoCore exited before readiness: ${child.exitCode}/${child.signalCode}.`);
    try {
      if ((await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('NanoCore did not become ready within 30000ms.');
}

/** Observes only the public status of one built private-listener route. */
function requestStatus(client, method, path) {
  return new Promise((resolveStatus, reject) => {
    const request = client.request({ ':method': method, ':path': path });
    request.once('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('Listener readiness timed out.')));
    let status;
    request.once('response', (headers) => {
      status = headers[':status'];
    });
    request.resume();
    request.once('end', () => resolveStatus(status));
    request.end();
  });
}

/** Requires the disposable server's orderly zero-code shutdown under the original bound. */
async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    assert.equal(child.exitCode, 0);
    assert.equal(child.signalCode, null);
    return;
  }
  let timer;
  try {
    const exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('NanoCore did not stop within 10000ms.')), 10_000);
    });
    child.kill('SIGTERM');
    assert.equal(await Promise.race([exited, timeout]), 0);
  } finally {
    clearTimeout(timer);
  }
}

/** Allocates a disposable loopback listener port without a fixed-port collision. */
function findOpenPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

/** Proves shutdown released each actual listener. */
function assertPortClosed(port) {
  return new Promise((resolveClosed, reject) => {
    const socket = connectTcp({ host: '127.0.0.1', port });
    socket.setTimeout(2_000, () => socket.destroy(new Error('Listener shutdown probe timed out.')));
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('A listener survived shutdown.'));
    });
    socket.once('error', (error) =>
      error.code === 'ECONNREFUSED' ? resolveClosed() : reject(error)
    );
  });
}

main().catch(() => {
  // Report a bounded artifact failure without copying server output or fixture locations.
  console.error('NanoCore Worker-listener readiness smoke FAIL');
  process.exitCode = 1;
});
