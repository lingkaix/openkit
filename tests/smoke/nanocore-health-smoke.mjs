import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:http2';
import { connect as connectTcp, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensureLocalUser } from '../../apps/nanocore/dist/auth/identity.js';
import { FsStore } from '../../apps/nanocore/dist/lib/store.js';
import { shutdownControlStoreWorkerClient } from '../../apps/nanocore/dist/storage/control-store-worker-client.js';
import { openCoreDb } from '../../apps/nanocore/dist/storage/db.js';
import { applyMigrations } from '../../apps/nanocore/dist/storage/migrate.js';
import { createWorkspaceDeletionRequest } from '../../apps/nanocore/dist/workspace-deletion-request.js';
import { recordWorkspaceOwnerMembership } from '../../apps/nanocore/dist/workspace-membership.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Runs the NanoCore built-artifact health smoke check.
 *
 * @returns {Promise<void>} Resolves after the smoke check passes.
 */
async function main() {
  const appPort = await findOpenPort();
  const nanoHostPort = await findOpenPort();
  const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-nano-smoke-'));
  const deletion = await seedWorkspaceDeletionRequest(dataRoot);
  await writeNanoHostConfig(dataRoot, nanoHostPort);
  const child = spawn(process.execPath, [join(repoRoot, 'apps/nanocore/dist/index.js')], {
    cwd: join(repoRoot, 'apps/nanocore'),
    env: {
      ...process.env,
      OPENKIT_CORE_MODE: 'local',
      OPENKIT_BIND_HOST: '127.0.0.1',
      OPENKIT_DATA_ROOT: dataRoot,
      OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR: '1',
      PORT: String(appPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = captureOutput(child);
  let nanoHostClient;

  try {
    const baseUrl = `http://127.0.0.1:${appPort}`;

    await waitForHttp(`${baseUrl}/api/health`, child, output);
    await assertOkJson(`${baseUrl}/api/health`, 'health');
    await assertOkJson(`${baseUrl}/api/meta`, 'meta');
    const fencedRead = await fetch(`${baseUrl}/api/app/operations/workspace.dashboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: deletion.workspaceId }),
    });
    const fencedReadBody = await fencedRead.json();
    if (fencedRead.status !== 403 || fencedReadBody.code !== 'workspace_access_denied') {
      throw new Error(
        `Recovered deletion fence returned ${fencedRead.status}: ${JSON.stringify(fencedReadBody)}.`
      );
    }
    const continuedDeletion = await fetch(`${baseUrl}/api/app/operations/workspace.delete`, {
      body: JSON.stringify({
        workspaceId: deletion.workspaceId,
        confirmation: deletion.request.confirmation,
        expectedRegistryRevision: deletion.request.expectedRegistryRevision,
      }),
      headers: {
        'content-type': 'application/json',
        'x-openkit-request-id': deletion.request.requestId,
      },
      method: 'POST',
    });
    const continuedDeletionBody = await continuedDeletion.json();
    if (
      continuedDeletion.status !== 200 ||
      continuedDeletionBody.deletion?.phase !== 'cleaned' ||
      continuedDeletionBody.deletion?.requestId !== deletion.request.requestId ||
      continuedDeletionBody.deletion?.status !== 'deleted'
    ) {
      throw new Error(
        `Same-request deletion continuation failed with ${continuedDeletion.status}: ${JSON.stringify(continuedDeletionBody)}`
      );
    }
    const privateOnApp = await fetch(`${baseUrl}/api/nanohost/transport/session/admit`, {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    if (privateOnApp.status !== 404) {
      throw new Error(`App listener exposed NanoHost transport with ${privateOnApp.status}.`);
    }
    const harnessOnApp = await fetch(`${baseUrl}/worker-control/harness/poll`, {
      body: '{"nextExpectedSequence":0,"schemaVersion":1}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    if (harnessOnApp.status !== 404) {
      throw new Error(`App listener exposed NanoHost Harness routes with ${harnessOnApp.status}.`);
    }

    nanoHostClient = connect(`http://127.0.0.1:${nanoHostPort}`);
    const appOnNanoHost = await requestHttp2(nanoHostClient, 'GET', '/api/health');
    if (appOnNanoHost.status !== 404) {
      throw new Error(`NanoHost listener exposed App health with ${appOnNanoHost.status}.`);
    }
    const privateAdmission = await requestHttp2(
      nanoHostClient,
      'POST',
      '/api/nanohost/transport/session/admit',
      '{}'
    );
    if (privateAdmission.status !== 401) {
      throw new Error(
        `NanoHost listener did not reach private admission: ${privateAdmission.status}.`
      );
    }
    const privateHarness = await requestHttp2(
      nanoHostClient,
      'POST',
      '/worker-control/harness/poll',
      '{"nextExpectedSequence":0,"schemaVersion":1}'
    );
    if (privateHarness.status !== 409) {
      throw new Error(`NanoHost listener did not reach private Harness: ${privateHarness.status}.`);
    }
    nanoHostClient.close();
    nanoHostClient = undefined;
    await stopProcess(child);
    console.log('OpenKit NanoCore dual-listener and deletion-recovery built-artifact smoke PASS');
  } finally {
    nanoHostClient?.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolveExit) => {
        child.once('exit', resolveExit);
        child.kill('SIGKILL');
      });
    }
    await rm(dataRoot, { force: true, recursive: true });
  }
}

/** Seeds one active Workspace and pre-listener deletion request in the disposable data root. */
async function seedWorkspaceDeletionRequest(dataRoot) {
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    const localUserId = ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Deletion recovery smoke');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: localUserId,
      workspaceId: workspace.id,
    });
    const request = {
      confirmation: `permanently-delete-workspace:${workspace.id}:1`,
      expectedRegistryRevision: 1,
      requestId: '00000000-0000-4000-8000-000000000001',
    };
    createWorkspaceDeletionRequest(dataRoot, {
      ...request,
      createdAt: new Date().toISOString(),
      initiatingUserId: localUserId,
      originalOwnerUserId: localUserId,
      workspaceId: workspace.id,
    });
    return { request, workspaceId: workspace.id };
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
  }
}

/** Retains bounded startup output for a deciding smoke failure. */
function captureOutput(child) {
  let output = '';
  const append = (chunk) => {
    output = `${output}${chunk}`.slice(-4096);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return () => output;
}

/** Writes one secret-free dual-listener NanoHost deployment config. */
async function writeNanoHostConfig(dataRoot, nanoHostPort) {
  const configRoot = join(dataRoot, 'config');
  await mkdir(configRoot, { recursive: true });
  await writeFile(
    join(configRoot, 'server.jsonc'),
    `${JSON.stringify(
      {
        nanohost: {
          bind: { host: '127.0.0.1', port: nanoHostPort },
          credentialRef: 'nanohost-transport:smoke',
          credentialSlots: {
            A: {
              companionPath: '/run/openkit-smoke/nanohost-A.meta',
              secretPath: '/run/openkit-smoke/nanohost-A.token',
            },
            B: {
              companionPath: '/run/openkit-smoke/nanohost-B.meta',
              secretPath: '/run/openkit-smoke/nanohost-B.token',
            },
          },
          deploymentId: 'dep_0190f4c8-0000-7000-8000-000000000601',
          identityId: 'nanohost-smoke',
          rendezvousUrl: `http://127.0.0.1:${nanoHostPort}`,
        },
        schemaVersion: 1,
      },
      null,
      2
    )}\n`
  );
}

/** Sends one bounded request over the dedicated native HTTP/2 listener. */
function requestHttp2(client, method, path, body = '') {
  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        ':method': method,
        ':path': path,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      { endStream: false }
    );
    let status = 0;
    request.on('response', (headers) => {
      status = Number(headers[':status']);
    });
    request.on('error', reject);
    request.on('data', () => {});
    request.on('end', () => resolve({ status }));
    request.end(body);
  });
}

/**
 * Verifies that one URL responds with successful JSON.
 *
 * @param {string} url URL to fetch.
 * @param {string} label Human-readable assertion label.
 * @returns {Promise<Record<string, unknown>>} Parsed JSON response.
 * @throws {Error} When the endpoint fails or returns non-JSON.
 */
async function assertOkJson(url, label) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${label} endpoint returned ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

/**
 * Waits until an HTTP URL returns a successful status.
 *
 * @param {string} url URL to poll.
 * @param {import('node:child_process').ChildProcessWithoutNullStreams} child Process to monitor.
 * @returns {Promise<void>} Resolves once the URL is reachable.
 * @throws {Error} When the process exits or the deadline is reached.
 */
async function waitForHttp(url, child, output) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Process exited before ${url} became ready: code=${child.exitCode}, signal=${child.signalCode}.\n${output()}`
      );
    }

    try {
      const response = await fetch(url);

      if (response.ok) {
        return;
      }
    } catch {
      await sleep(100);
    }
  }

  throw new Error(`Timed out waiting for ${url}.`);
}

/**
 * Stops one spawned child process.
 *
 * @param {import('node:child_process').ChildProcessWithoutNullStreams} child Process to stop.
 * @returns {Promise<void>} Resolves only after an orderly zero-code exit.
 * @throws {Error} When the process misses the shutdown deadline or exits unsuccessfully.
 */
async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode !== 0 || child.signalCode !== null) {
      throw new Error(
        `NanoCore exited before shutdown: code=${child.exitCode}, signal=${child.signalCode}.`
      );
    }
    return;
  }

  const exit = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  child.kill('SIGTERM');
  const result = await Promise.race([exit, sleep(2_000).then(() => null)]);

  if (result === null) {
    child.kill('SIGKILL');
    await exit;
    throw new Error('NanoCore did not exit cleanly within 2000ms after SIGTERM.');
  }

  if (result.code !== 0) {
    throw new Error(
      `NanoCore exited unsuccessfully after SIGTERM: code=${result.code}, signal=${result.signal}.`
    );
  }
}

/**
 * Finds one available localhost TCP port.
 *
 * @returns {Promise<number>} Available port.
 */
async function findOpenPort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (typeof address !== 'object' || address === null) {
        server.close(() => reject(new Error('Could not allocate a TCP port.')));
        return;
      }

      server.close(() => resolvePort(address.port));
    });
  });
}

/**
 * Resolves after a delay.
 *
 * @param {number} ms Delay in milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Test-local source observation leaves the actual built App body intact except for one fixed entry marker. */
async function installAttentionObserver({ appUrl, clientUrl }) {
  const { isMainThread } = await import('node:worker_threads');
  if (!isMainThread) return;
  const { registerHooks } = await import('node:module');
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url !== appUrl) return result;
      const text =
        typeof result.source === 'string'
          ? result.source
          : Buffer.from(result.source).toString('utf8');
      const signature = 'export function createApp(options = {}) {';
      if (text.split(signature).length !== 2)
        throw new Error('Actual App entry observation is unavailable.');
      process.stdout.write('ATTENTION_SMOKE_OBSERVER\n');
      return {
        ...result,
        source: text.replace(
          signature,
          `${signature}\nprocess.stdout.write('ATTENTION_SMOKE_APP\\n');`
        ),
      };
    },
  });
  const { getControlStoreWorkerClient, ControlStoreWorkerError } = await import(clientUrl);
  const client = getControlStoreWorkerClient();
  const original = client.attention.bind(client);
  client.attention = async (database, input) => {
    const reply = await original(database, input);
    if (input.action !== 'reconcile') return reply;
    if (!database.startsWith('core:') || reply.kind !== 'reconciled')
      throw new Error('Actual native Attention reconciliation was not selected.');
    process.stdout.write('ATTENTION_SMOKE_ACK\n');
    const next = await new Promise((resolve) =>
      process.stdin.once('data', (bytes) => resolve(bytes.toString().trim()))
    );
    if (next === 'fail') throw new ControlStoreWorkerError('native', 'unknown');
    if (next !== 'release') throw new Error('Unexpected smoke control input.');
    return reply;
  };
}

/** Observes the actual native recovery reply and App entry in one real built child, without a product hook. */
async function checkAttentionStartup(command) {
  const appPort = await findOpenPort();
  const nanoHostPort = await findOpenPort();
  const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-attention-startup-'));
  await seedWorkspaceDeletionRequest(dataRoot);
  await writeNanoHostConfig(dataRoot, nanoHostPort);
  const preload = join(dataRoot, 'attention-observer.mjs');
  const appUrl = pathToFileURL(join(repoRoot, 'apps/nanocore/dist/app.js')).href;
  const clientUrl = pathToFileURL(
    join(repoRoot, 'apps/nanocore/dist/storage/control-store-worker-client.js')
  ).href;
  // These fixed markers contain no command payload, path, account or credential.
  await writeFile(
    preload,
    `await (${installAttentionObserver.toString()})(${JSON.stringify({ appUrl, clientUrl })});\n`
  );
  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(preload).href, join(repoRoot, 'apps/nanocore/dist/index.js')],
    {
      cwd: join(repoRoot, 'apps/nanocore'),
      env: {
        ...process.env,
        OPENKIT_CORE_MODE: 'local',
        OPENKIT_BIND_HOST: '127.0.0.1',
        OPENKIT_DATA_ROOT: dataRoot,
        OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR: '1',
        PORT: String(appPort),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  const output = captureOutput(child);
  try {
    await waitForMarker(child, output, 'ATTENTION_SMOKE_ACK');
    if (
      !hasSmokeMarker(output, 'ATTENTION_SMOKE_OBSERVER') ||
      hasSmokeMarker(output, 'ATTENTION_SMOKE_APP')
    )
      throw new Error(
        `App construction overtook actual Attention recovery or its observer was absent.\n${output()}`
      );
    await assertNotListening(appPort);
    await assertNotListening(nanoHostPort);
    let inputError;
    child.stdin.once('error', (error) => {
      inputError = error;
    });
    const closed = command === 'fail' ? waitForChildClose(child, output) : undefined;
    child.stdin.end(`${command}\n`);
    if (command === 'release') {
      await waitForMarker(child, output, 'ATTENTION_SMOKE_APP');
      await waitForHttp(`http://127.0.0.1:${appPort}/api/health`, child, output);
      if (
        output()
          .split(/\r?\n/u)
          .filter((line) => line === 'ATTENTION_SMOKE_APP').length !== 1
      )
        throw new Error(`The actual App entry was not observed once after recovery.\n${output()}`);
      if (inputError) throw inputError;
      await stopProcess(child);
    } else {
      const exit = await closed;
      if (inputError) throw inputError;
      if (exit.code !== 1 || exit.signal !== null || hasSmokeMarker(output, 'ATTENTION_SMOKE_APP'))
        throw new Error(
          `Unknown recovery reply did not fail before App/listener admission.\n${output()}`
        );
      await assertNotListening(appPort);
      await assertNotListening(nanoHostPort);
    }
    console.log(`OpenKit actual native Attention startup ${command} smoke PASS`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = waitForChildClose(child, output);
      child.kill('SIGKILL');
      await closed;
    }
    await rm(dataRoot, { force: true, recursive: true });
  }
}

/** Fixed whole lines cannot be confused with a stack's quoted source excerpt. */
function hasSmokeMarker(output, marker) {
  return output().split(/\r?\n/u).includes(marker);
}

/** Uses the original smoke deadline and real child output; unrelated early boot failure is never a pass. */
function waitForMarker(child, output, marker) {
  return new Promise((resolveMarker, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      child.stdout.off('data', check);
      child.stderr.off('data', check);
      child.off('close', ended);
      if (error) reject(error);
      else resolveMarker();
    };
    const check = () => {
      if (hasSmokeMarker(output, marker)) finish();
    };
    const ended = () =>
      finish(new Error(`Child exited before selected native Attention reply.\n${output()}`));
    const timer = setTimeout(
      () => finish(new Error(`Selected native Attention reply was not observed.\n${output()}`)),
      30_000
    );
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('close', ended);
    check();
  });
}

/** Joins both child exit and stdio flush before inspecting the absence of App admission. */
function waitForChildClose(child, output) {
  return new Promise((resolveClose, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child did not close.\n${output()}`)), 30_000);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveClose({ code, signal });
    });
  });
}

/** A real socket refusal proves that neither configured listener opened while the actual reply was held. */
function assertNotListening(port) {
  return new Promise((resolveRefusal, reject) => {
    const socket = connectTcp({ host: '127.0.0.1', port });
    socket.setTimeout(30_000);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('Listener opened before recovery.'));
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Listener refusal was not observed.'));
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolveRefusal();
      else reject(error);
    });
  });
}

await checkAttentionStartup('release');
await checkAttentionStartup('fail');
await main();
