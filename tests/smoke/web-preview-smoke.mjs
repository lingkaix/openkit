import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  try {
    await waitForHttp(url, child);
    await assertBuiltIndex(url);
    console.log('OpenKit Web built-artifact smoke PASS');
  } finally {
    await stopProcess(child);
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
 * @returns {Promise<void>} Resolves once the process exits or is killed.
 */
async function stopProcess(child) {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    sleep(2_000).then(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
    }),
  ]);
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
