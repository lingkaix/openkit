import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:http2';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureLocalUser } from '../../apps/nanocore/dist/auth/identity.js';
import { FsStore } from '../../apps/nanocore/dist/lib/store.js';
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
  const deletion = seedWorkspaceDeletionRequest(dataRoot);
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
    const fencedRead = await fetch(
      `${baseUrl}/api/app/workspaces/${deletion.workspaceId}/dashboard`
    );
    if (fencedRead.status !== 403) {
      throw new Error(`Recovered deletion fence allowed a read with ${fencedRead.status}.`);
    }
    const continuedDeletion = await fetch(
      `${baseUrl}/api/app/workspaces/${deletion.workspaceId}/delete`,
      {
        body: JSON.stringify(deletion.request),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
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
function seedWorkspaceDeletionRequest(dataRoot) {
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Deletion recovery smoke');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
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
      originalOwnerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    return { request, workspaceId: workspace.id };
  } finally {
    coreDb.sqlite.close();
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
          deploymentId: 'deployment-smoke',
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

await main();
