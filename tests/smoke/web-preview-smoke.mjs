import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROCESS_TERMINATION_GRACE_MS = 500;
const PROCESS_KILL_TIMEOUT_MS = 2_000;

/**
 * Runs the Web built-artifact preview smoke check.
 *
 * @returns {Promise<void>} Resolves after the smoke check passes.
 */
async function main() {
  const port = await findOpenPort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    'pnpm',
    [
      '--filter',
      '@openkit/web',
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: repoRoot,
      detached: process.platform !== 'win32',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const childClose = new Promise((resolveClose) => child.once('close', resolveClose));

  try {
    await waitForHttp(url, child);
    await assertBuiltIndex(url);
    console.log('OpenKit Web built-artifact smoke PASS');
  } finally {
    await stopProcess(child, childClose);
  }
}

/**
 * Verifies that the built Web root document and one built script asset are reachable.
 *
 * @param {string} url Root preview URL.
 * @returns {Promise<void>} Resolves after the root and asset checks pass.
 * @throws {Error} When the built document or asset is missing.
 */
async function assertBuiltIndex(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Web preview root returned ${response.status}.`);
  }

  const html = await response.text();

  if (!html.includes('<div id="root">')) {
    throw new Error('Web preview root did not include the app root element.');
  }

  const scriptMatch = /<script[^>]+src="([^"]+\.js)"[^>]*>/u.exec(html);

  if (!scriptMatch) {
    throw new Error('Web preview root did not reference a built JavaScript asset.');
  }

  const assetResponse = await fetch(new URL(scriptMatch[1], url));

  if (!assetResponse.ok) {
    throw new Error(`Web preview script asset returned ${assetResponse.status}.`);
  }
}

/**
 * Waits until an HTTP URL returns a successful status.
 *
 * @param {string} url URL to poll.
 * @param {import('node:child_process').ChildProcessWithoutNullStreams} child Process to monitor.
 * @returns {Promise<void>} Resolves once the URL is reachable.
 * @throws {Error} When the process exits or the deadline is reached.
 */
async function waitForHttp(url, child) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Process exited before ${url} became ready: ${child.exitCode}.`);
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
 * @param {Promise<unknown>} childClose Resolves after the child closes and its stdio drains.
 * @returns {Promise<void>} Resolves once the process group exits and the child closes.
 * @throws {Error} When signaling fails or the process remains live after bounded cleanup.
 */
async function stopProcess(child, childClose) {
  const cleanupPhases = [
    ['SIGTERM', PROCESS_TERMINATION_GRACE_MS],
    ['SIGKILL', PROCESS_KILL_TIMEOUT_MS],
  ];

  if (process.platform === 'win32' || child.pid === undefined) {
    for (const [signal, timeoutMs] of cleanupPhases) {
      if (
        child.exitCode === null &&
        child.signalCode === null &&
        !child.kill(signal) &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        throw new Error(`Could not deliver ${signal} to the Web preview process.`);
      }
      if (await waitForClose(childClose, timeoutMs)) {
        return;
      }
    }
    throw new Error('Web preview process did not close after SIGTERM and SIGKILL.');
  }

  const processGroupId = child.pid;
  for (const [signal, timeoutMs] of cleanupPhases) {
    try {
      process.kill(-processGroupId, signal);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        throw error;
      }
    }
    if (await waitForProcessGroupCleanup(processGroupId, childClose, timeoutMs)) {
      return;
    }
  }

  throw new Error(
    'Web preview process group remained live after the SIGTERM and SIGKILL cleanup deadlines.'
  );
}

/**
 * Waits for a detached process group to vanish and its leader's stdio to drain.
 *
 * @param {number} processGroupId Detached process-group id.
 * @param {Promise<unknown>} childClose Resolves after the child closes and its stdio drains.
 * @param {number} timeoutMs Cleanup deadline in milliseconds.
 * @returns {Promise<boolean>} True when both cleanup conditions settle before the deadline.
 * @throws {Error} When the process group cannot be probed.
 */
async function waitForProcessGroupCleanup(processGroupId, childClose, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        return await waitForClose(childClose, Math.max(0, deadline - Date.now()));
      }
      throw error;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(10);
  }
}

/**
 * Waits a bounded interval for one child close event.
 *
 * @param {Promise<unknown>} childClose Resolves after the child closes and its stdio drains.
 * @param {number} timeoutMs Close deadline in milliseconds.
 * @returns {Promise<boolean>} True when close settles before the deadline.
 */
async function waitForClose(childClose, timeoutMs) {
  return await Promise.race([childClose.then(() => true), sleep(timeoutMs).then(() => false)]);
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
