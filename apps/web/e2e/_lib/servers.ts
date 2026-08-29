import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemoWorkspaceDataRoot } from './demo-data.js';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(webRoot, '../..');
const nanoCoreRoot = join(repoRoot, 'apps', 'nanocore');
const nanoCoreEntry = join(nanoCoreRoot, 'dist', 'index.js');

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
  /** Restarts only NanoCore on the stack's existing port and data root. */
  restartCore(): Promise<void>;
  /** Stops all spawned processes and removes every stack-owned temporary root. */
  stop(): Promise<void>;
}

/**
 * Options for an isolated web e2e stack.
 */
export interface IsolatedWebStackOptions {
  /** Optional pre-created data root that remains owned and removed by the stack. */
  dataRoot?: string;
  /** NanoCore mode. */
  mode?: 'local' | 'server';
  /** Whether the simulator should be used. */
  useSimulator?: boolean;
}

/**
 * Starts NanoCore and Vite dev server on dynamic ports.
 *
 * Sets `VITE_CORE_BASE_URL` so the rebuilt SPA talks to the spawned NanoCore
 * (relative `/api` still proxies via `vite.config.ts` when the env is unset).
 *
 * @param options Stack options.
 * @returns Running stack metadata and cleanup function.
 */
export async function startIsolatedWebStack(
  options: IsolatedWebStackOptions = {}
): Promise<IsolatedWebStack> {
  await assertNanoCoreBuilt();

  const corePort = await findOpenPort();
  const webPort = await findOpenPort();
  const stackRoot = await mkdtemp(join(tmpdir(), 'openkit-web-e2e-'));
  const dataRoot = options.dataRoot ?? join(stackRoot, 'data-root');
  const fixtureRoot = join(stackRoot, 'fixture');
  const cleanupRoots = options.dataRoot ? [dataRoot, stackRoot] : [stackRoot];
  const coreUrl = `http://127.0.0.1:${corePort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const mode = options.mode ?? 'local';

  try {
    await Promise.all([
      mkdir(dataRoot, { recursive: true }),
      mkdir(fixtureRoot, { recursive: true }),
    ]);

    if (mode === 'server' && !options.dataRoot) {
      await mkdir(join(dataRoot, 'config'), { recursive: true });
      await writeFile(
        join(dataRoot, 'config', 'server.jsonc'),
        JSON.stringify({
          schemaVersion: 1,
          mode: 'server',
          server: {
            bind: { host: '127.0.0.1', port: corePort },
            cors: { origins: [webUrl] },
            publicBaseUrl: coreUrl,
          },
        })
      );
    }

    if (mode === 'local') {
      await seedDemoWorkspaceDataRoot(dataRoot, fixtureRoot);
    }
  } catch (error) {
    await Promise.allSettled(
      cleanupRoots.map((root) => rm(root, { force: true, recursive: true }))
    );
    throw error;
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

  if (options.useSimulator ?? true) {
    coreEnv.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR = '1';
  } else {
    delete coreEnv.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;
  }

  /** Spawns NanoCore with the immutable port, data-root, and mode owned by this stack. */
  const spawnCore = (): ChildProcessWithoutNullStreams =>
    spawn(process.execPath, [nanoCoreEntry], {
      cwd: nanoCoreRoot,
      env: coreEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  let core = spawnCore();
  let web: ChildProcessWithoutNullStreams | null = null;
  const useWebProcessGroup = process.platform !== 'win32';

  /** Stops and replaces only NanoCore while preserving the stack's port and data-root owners. */
  const restartCore = async (): Promise<void> => {
    await stopProcess(core);
    core = spawnCore();
    await waitForHttp(`${coreUrl}/api/health`, core);
  };

  /** Stops every spawned process and removes the exact roots owned by this stack. */
  const stop = async (): Promise<void> => {
    await Promise.all([
      stopProcess(core),
      ...(web ? [stopProcess(web, useWebProcessGroup ? web.pid : undefined)] : []),
    ]);
    await Promise.all(cleanupRoots.map((root) => rm(root, { force: true, recursive: true })));
  };

  try {
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
        detached: useWebProcessGroup,
        env: {
          ...process.env,
          VITE_CACHE_DIR: join(fixtureRoot, 'vite-cache'),
          VITE_CORE_BASE_URL: coreUrl,
          VITE_CORE_URL: coreUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    await waitForHttp(webUrl, web);
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    coreUrl,
    dataRoot,
    webUrl,
    restartCore,
    stop,
  };
}

/**
 * Ensures NanoCore was built before spawning `dist/index.js`.
 *
 * @throws {Error} When the NanoCore entry is missing.
 */
async function assertNanoCoreBuilt(): Promise<void> {
  try {
    await access(nanoCoreEntry);
  } catch {
    throw new Error(
      `NanoCore build missing at ${nanoCoreEntry}. Run \`pnpm --filter @openkit/nanocore build\` before web e2e.`
    );
  }
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
 * @param child Child process to stop.
 * @param processGroupId Detached POSIX process-group id when descendants share cleanup ownership.
 * @throws When a detached process group remains live after the TERM and KILL cleanup deadlines.
 */
async function stopProcess(
  child: ChildProcessWithoutNullStreams,
  processGroupId?: number
): Promise<void> {
  if (processGroupId !== undefined) {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        process.kill(-processGroupId, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          return;
        }
        throw error;
      }

      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        try {
          process.kill(-processGroupId, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            return;
          }
          throw error;
        }
        await sleep(10);
      }
    }
    throw new Error(
      'Detached Web process group remained alive after the SIGTERM and SIGKILL cleanup deadlines.'
    );
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise<boolean>((resolve) => child.once('exit', () => resolve(true)));
  child.kill('SIGTERM');
  const terminated = await Promise.race([exited, sleep(2_000).then(() => false)]);

  if (terminated || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill('SIGKILL');
  await Promise.race([exited, sleep(2_000)]);
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
