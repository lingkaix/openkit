import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemoWorkspaceAuthority, seedDemoWorkspaceDataRoot } from '../support/demo-data.mjs';

const storyRunnerRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(storyRunnerRoot, '../..');
const nanoCoreRoot = join(repoRoot, 'apps', 'nanocore');

/**
 * Starts an isolated NanoCore and Web development stack for story execution.
 *
 * @param {{ dataRoot?: string, mode?: 'local' | 'server', useSimulator?: boolean }} options Stack options.
 * @returns {Promise<{ coreUrl: string, dataRoot: string, webUrl: string, stop(): Promise<void> }>} Running stack metadata.
 */
export async function startIsolatedStoryWebStack(options = {}) {
  const corePort = await findOpenPort();
  const webPort = await findOpenPort();
  const dataRoot = options.dataRoot ?? (await mkdtemp(join(tmpdir(), 'openkit-story-e2e-')));
  const coreUrl = `http://127.0.0.1:${corePort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const mode = options.mode ?? 'local';
  let core = null;
  let web = null;
  const coreEnv = {
    ...process.env,
    BETTER_AUTH_TRUSTED_ORIGINS: webUrl,
    BETTER_AUTH_URL: coreUrl,
    OPENKIT_CORE_MODE: mode,
    OPENKIT_DATA_ROOT: dataRoot,
    PORT: String(corePort),
  };

  if (mode === 'local') {
    seedDemoWorkspaceDataRoot(dataRoot);
    await seedDemoWorkspaceAuthority(dataRoot);
  }

  if (options.useSimulator ?? true) {
    coreEnv.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR = '1';
  } else {
    delete coreEnv.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;
  }

  try {
    core = spawn(process.execPath, [join(nanoCoreRoot, 'dist', 'index.js')], {
      cwd: nanoCoreRoot,
      env: coreEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForHttp(`${coreUrl}/api/health`, core);

    web = spawn(
      'pnpm',
      [
        '--filter',
        '@openkit/web',
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        String(webPort),
        '--strictPort',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          VITE_CACHE_DIR: join(dataRoot, 'vite-cache'),
          VITE_CORE_URL: coreUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    await waitForHttp(webUrl, web);

    return {
      coreUrl,
      dataRoot,
      webUrl,
      stop: async () => {
        await Promise.all([stopProcess(web), stopProcess(core)]);
        await rm(dataRoot, { force: true, recursive: true });
      },
    };
  } catch (error) {
    await Promise.all([web, core].filter(Boolean).map((child) => stopProcess(child)));
    await rm(dataRoot, { force: true, recursive: true });
    throw error;
  }
}

/**
 * Waits until an HTTP URL returns a successful response.
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
