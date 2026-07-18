import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemoWorkspaceDataRoot } from './demo-data.js';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(webRoot, '../..');
const nanoCoreRoot = join(repoRoot, 'apps', 'nanocore');

/**
 * Running isolated web e2e stack.
 */
export interface IsolatedWebStack {
  /** Core HTTP base URL. */
  coreUrl: string;
  /** Temporary NanoCore data root. */
  dataRoot: string;
  /** Web HTTP base URL. */
  webUrl: string;
  /** Stops all spawned processes and removes the data root. */
  stop(): Promise<void>;
}

/**
 * Options for an isolated web e2e stack.
 */
export interface IsolatedWebStackOptions {
  /** Optional pre-created data root. */
  dataRoot?: string;
  /** NanoCore mode. */
  mode?: 'local' | 'server';
  /** Whether the simulator should be used. */
  useSimulator?: boolean;
}

/**
 * Starts NanoCore and Vite dev server on dynamic ports.
 *
 * @param options Stack options.
 * @returns Running stack metadata and cleanup function.
 */
export async function startIsolatedWebStack(
  options: IsolatedWebStackOptions = {}
): Promise<IsolatedWebStack> {
  const corePort = await findOpenPort();
  const webPort = await findOpenPort();
  const dataRoot = options.dataRoot ?? (await mkdtemp(join(tmpdir(), 'openkit-web-e2e-')));
  const coreUrl = `http://127.0.0.1:${corePort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const mode = options.mode ?? 'local';

  if (mode === 'server' && !options.dataRoot) {
    await mkdir(join(dataRoot, 'config'), { recursive: true });
    await writeFile(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        server: { cors: { origins: [webUrl] }, publicBaseUrl: coreUrl },
      })
    );
  }

  const coreEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(mode === 'server'
      ? { BETTER_AUTH_SECRET: 'openkit-web-e2e-server-secret-at-least-32-characters' }
      : {}),
    BETTER_AUTH_TRUSTED_ORIGINS: webUrl,
    BETTER_AUTH_URL: coreUrl,
    OPENKIT_CORE_MODE: mode,
    OPENKIT_DATA_ROOT: dataRoot,
    PORT: String(corePort),
  };

  if (mode === 'local') {
    seedDemoWorkspaceDataRoot(dataRoot);
  }

  if (options.useSimulator ?? true) {
    coreEnv.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR = '1';
  } else {
    delete coreEnv.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;
  }

  const core = spawn(process.execPath, [join(nanoCoreRoot, 'dist', 'index.js')], {
    cwd: nanoCoreRoot,
    env: coreEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHttp(`${coreUrl}/api/health`, core);

  const web = spawn(
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
}

/**
 * Waits until an HTTP URL returns a successful response.
 *
 * @param url URL to poll.
 * @param process Child process to monitor.
 */
async function waitForHttp(url: string, process: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Process exited before ${url} became ready: ${process.exitCode}`);
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
 * @param process Child process to stop.
 */
async function stopProcess(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null || process.killed) {
    return;
  }

  process.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => process.once('exit', () => resolve())),
    sleep(2_000).then(() => {
      if (process.exitCode === null && !process.killed) {
        process.kill('SIGKILL');
      }
    }),
  ]);
}

/**
 * Finds one available localhost TCP port.
 *
 * @returns Available port.
 */
async function findOpenPort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (typeof address !== 'object' || address === null) {
        server.close(() => reject(new Error('Could not allocate a TCP port.')));
        return;
      }

      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Resolves after a delay.
 *
 * @param ms Delay in milliseconds.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
