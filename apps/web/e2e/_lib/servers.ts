import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { allocateEntityId } from '@openkit/protocol';
import {
  confirmFixtureAssistantContext,
  seedDemoWorkspaceDataRoot,
  seedSyntheticLocalSchedulerTarget,
} from './demo-data.js';
import { startFixtureAssistantProvider } from './simulator-inference.js';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(webRoot, '../..');
const nanoCoreRoot = join(repoRoot, 'apps', 'nanocore');
const nanoCoreEntry = join(nanoCoreRoot, 'dist', 'index.js');
const PORT_START_ATTEMPTS = 3;
type HarnessChildProcess = ChildProcessByStdio<null, Readable, Readable>;

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
  /** Confirms context Policy as the local fixture owner and supplies a loopback Assistant provider. */
  withAssistant?: boolean;
}

/** Owner identity created by the disposable server bootstrap ceremony. */
export interface ServerBootstrapOwner {
  /** Owner Browser sign-in email. */
  email: string;
  /** Owner display name. */
  name: string;
  /** Owner Browser sign-in password. */
  password: string;
}

/**
 * Starts NanoCore and Vite dev server on dynamic ports.
 *
 * Sets `VITE_CORE_BASE_URL` so the rebuilt SPA talks to the spawned NanoCore
 * (relative `/api` still proxies via `vite.config.ts` when the env is unset).
 * Both listeners retry bounded distinct probed ports after an early exit. Web candidates
 * are selected before Core boots so server-mode auth/CORS configuration can trust the final Web origin.
 *
 * @param options Stack options.
 * @returns Running stack metadata and cleanup function.
 */
export async function startIsolatedWebStack(
  options: IsolatedWebStackOptions = {}
): Promise<IsolatedWebStack> {
  await assertRetrievalKernel();
  await assertNanoCoreBuilt();

  const startupPorts = await findOpenPorts(PORT_START_ATTEMPTS * 2);
  const corePorts = startupPorts.slice(0, PORT_START_ATTEMPTS);
  const webPorts = startupPorts.slice(PORT_START_ATTEMPTS);
  const stackRoot = await mkdtemp(join(tmpdir(), 'openkit-web-e2e-'));
  const dataRoot = options.dataRoot ?? join(stackRoot, 'data-root');
  const fixtureRoot = join(stackRoot, 'fixture');
  const cleanupRoots = options.dataRoot ? [dataRoot, stackRoot] : [stackRoot];
  const webUrls = webPorts.map((port) => `http://127.0.0.1:${port}`);
  const mode = options.mode ?? 'local';
  let corePort = corePorts[0]!;
  let coreUrl = `http://127.0.0.1:${corePort}`;
  let webUrl = webUrls[0]!;
  let assistantProvider: Awaited<ReturnType<typeof startFixtureAssistantProvider>> | undefined;
  const writeServerConfig = async (): Promise<void> => {
    await writeFile(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        mode: 'server',
        server: {
          bind: { host: '127.0.0.1', port: corePort },
          cors: { origins: webUrls },
          publicBaseUrl: coreUrl,
        },
      })
    );
  };

  try {
    await Promise.all([
      mkdir(dataRoot, { recursive: true }),
      mkdir(fixtureRoot, { recursive: true }),
    ]);

    if (mode === 'server' && !options.dataRoot) {
      await mkdir(join(dataRoot, 'config'), { recursive: true });
      await writeServerConfig();
    }

    if (mode === 'local') {
      if (options.withAssistant) assistantProvider = await startFixtureAssistantProvider();
      await seedDemoWorkspaceDataRoot(dataRoot, assistantProvider?.baseUrl);
      if (assistantProvider) await confirmFixtureAssistantContext(dataRoot);
    }
  } catch (error) {
    await Promise.allSettled([
      ...(assistantProvider ? [assistantProvider.stop()] : []),
      ...cleanupRoots.map((root) => rm(root, { force: true, recursive: true })),
    ]);
    throw error;
  }

  let coreFailureCode: string | undefined;
  let coreInstanceOwnsPort = () => false;
  /** Recognizes this Core child's bound App listener and safe boot failure phases without publishing its output. */
  const spawnCore = (): HarnessChildProcess => {
    coreFailureCode = undefined;
    const coreEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(mode === 'server'
        ? { BETTER_AUTH_SECRET: 'openkit-web-e2e-server-secret-at-least-32-characters' }
        : {}),
      BETTER_AUTH_TRUSTED_ORIGINS: webUrls.join(','),
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
    const child = spawn(process.execPath, [nanoCoreEntry], {
      cwd: nanoCoreRoot,
      env: coreEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let ownsPort = false;
    const listenerAnnouncement = `App server is running on ${coreUrl}\n`;
    coreInstanceOwnsPort = () => ownsPort;
    child.stdout.on('data', (bytes: Buffer) => {
      stdout = `${stdout}${bytes.toString('utf8')}`.slice(-4_000);
      if (stripVTControlCharacters(stdout).includes(listenerAnnouncement)) ownsPort = true;
    });
    const phases = new Set([
      'config',
      'data-root-layout',
      'instance-lock',
      'migrations',
      'policy-kernel',
      'vault',
      'local-identity',
      'scheduler-restart-recovery',
    ]);
    child.stderr.on('data', (bytes: Buffer) => {
      const phase = bytes.toString('utf8').match(/critical phase "([a-z-]+)"/)?.[1];
      if (phase && phases.has(phase)) coreFailureCode = `boot.critical.${phase}`;
    });
    return child;
  };
  let core = spawnCore();
  let web: HarnessChildProcess | null = null;
  const useWebProcessGroup = process.platform !== 'win32';

  /** Stops and replaces only NanoCore while preserving the stack's port and data-root owners. */
  const restartCore = async (): Promise<void> => {
    await stopProcess(core);
    core = spawnCore();
    await waitForHttp(`${coreUrl}/api/health`, core, coreInstanceOwnsPort, () => coreFailureCode);
    if (mode === 'local' && (options.useSimulator ?? true)) {
      await seedSyntheticLocalSchedulerTarget(dataRoot);
    }
  };

  /** Stops every spawned process and removes the exact roots owned by this stack. */
  const stop = async (): Promise<void> => {
    await Promise.all([
      stopProcess(core),
      ...(web ? [stopProcess(web, useWebProcessGroup ? web.pid : undefined)] : []),
    ]);
    await Promise.all([
      ...(assistantProvider ? [assistantProvider.stop()] : []),
      ...cleanupRoots.map((root) => rm(root, { force: true, recursive: true })),
    ]);
  };

  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await waitForHttp(
          `${coreUrl}/api/health`,
          core,
          coreInstanceOwnsPort,
          () => coreFailureCode
        );
        break;
      } catch (error) {
        if ((core.exitCode === null && core.signalCode === null) || attempt + 1 >= corePorts.length)
          throw error;
        corePort = corePorts[attempt + 1]!;
        coreUrl = `http://127.0.0.1:${corePort}`;
        if (mode === 'server' && !options.dataRoot) await writeServerConfig();
        core = spawnCore();
      }
    }
    if (mode === 'local' && (options.useSimulator ?? true)) {
      await seedSyntheticLocalSchedulerTarget(dataRoot);
    }
    for (let attempt = 0; attempt < webPorts.length; attempt += 1) {
      const webPort = webPorts[attempt]!;
      webUrl = webUrls[attempt]!;
      const webChild = spawn(
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
            OPENKIT_WEB_E2E: '1',
            VITE_CACHE_DIR: join(fixtureRoot, 'vite-cache'),
            VITE_CORE_BASE_URL: coreUrl,
            VITE_CORE_URL: coreUrl,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      web = webChild;
      let webStdout = '';
      let webStderr = '';
      let webInstanceOwnsPort = false;
      webChild.stdout.on('data', (bytes: Buffer) => {
        webStdout = `${webStdout}${bytes.toString('utf8')}`.slice(-4_000);
        if (stripVTControlCharacters(webStdout).includes(`http://127.0.0.1:${webPort}/`)) {
          webInstanceOwnsPort = true;
        }
      });
      webChild.stderr.on('data', (bytes: Buffer) => {
        webStderr = `${webStderr}${bytes.toString('utf8')}`.slice(-4_000);
      });
      const webOwnsPort = () => webInstanceOwnsPort;
      const webFailureDetail = () => {
        const tail = webStderr.trim().split('\n').slice(-8).join('\n').trim();
        return tail ? `stderr tail:\n${tail}` : undefined;
      };
      try {
        await waitForHttp(webUrl, webChild, webOwnsPort, webFailureDetail);
        await waitForHttp(`${webUrl}/src/main.tsx`, webChild, webOwnsPort, webFailureDetail);
        break;
      } catch (error) {
        if (
          (webChild.exitCode === null && webChild.signalCode === null) ||
          attempt + 1 >= webPorts.length
        )
          throw error;
        await stopProcess(webChild, useWebProcessGroup ? webChild.pid : undefined);
        web = null;
      }
    }
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
 * Completes the disposable server's first-owner bootstrap through the public operation.
 *
 * The stack-owned emission file is ephemeral test material. The returned administrator
 * token is never retained; only the created owner id crosses this boundary.
 *
 * @param stack Running isolated server stack.
 * @param owner Owner identity to create.
 * @returns Created owner user id.
 */
export async function completeServerBootstrap(
  stack: IsolatedWebStack,
  owner: ServerBootstrapOwner
): Promise<string> {
  const refused = await fetch(`${stack.coreUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(owner),
  });
  await refused.body?.cancel();
  if (refused.status !== 403) {
    throw new Error(`Pre-bootstrap signup must refuse; received ${refused.status}.`);
  }

  const emission = await readFile(
    join(stack.dataRoot, 'server', 'files', 'auth', 'bootstrap-token.txt'),
    'utf8'
  );
  const token = /^Token: (\S+)$/m.exec(emission)?.[1];
  if (!token) throw new Error('Disposable server bootstrap emission is unavailable.');

  const response = await fetch(`${stack.coreUrl}/api/app/operations/bootstrap.consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token,
      ownerUserId: allocateEntityId('usr'),
      displayName: owner.name,
      email: owner.email,
      password: owner.password,
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  });
  if (response.status !== 201) {
    await response.body?.cancel();
    throw new Error(`Public server bootstrap must succeed; received ${response.status}.`);
  }

  const body = (await response.json()) as { record?: { ownerUserId?: unknown } };
  const ownerUserId = body.record?.ownerUserId;
  if (typeof ownerUserId !== 'string' || ownerUserId.length === 0) {
    throw new Error('Public server bootstrap did not return a created owner.');
  }
  return ownerUserId;
}

/** One in-flight kernel build. A later stack waits for it instead of starting another. */
let retrievalKernelPreflight: Promise<void> | null = null;

/**
 * The executable NanoCore resolves: a packaged binary, otherwise the workspace
 * debug build from `pnpm --filter @openkit/retrieval-kernel build`.
 */
function retrievalKernelCandidates(): string[] {
  return ['/usr/local/bin/retrieval-kernel', join(repoRoot, 'target', 'debug', 'retrieval-kernel')];
}

/** True when NanoCore can spawn the retrieval executable. */
async function retrievalKernelReady(): Promise<boolean> {
  for (const candidate of retrievalKernelCandidates()) {
    try {
      await access(candidate);
      return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

/**
 * Builds the retrieval kernel once when isolated e2e has no executable.
 * A missing kernel makes task.start return 409 recovery_required.
 *
 * @throws {Error} When the existing package build fails or still produces no executable.
 */
async function assertRetrievalKernel(): Promise<void> {
  if (await retrievalKernelReady()) return;
  retrievalKernelPreflight ??= buildRetrievalKernel().finally(() => {
    retrievalKernelPreflight = null;
  });
  await retrievalKernelPreflight;
  if (await retrievalKernelReady()) return;
  throw new Error(
    'Retrieval kernel executable is missing after `pnpm --filter @openkit/retrieval-kernel build`. Isolated e2e cannot start.'
  );
}

/** Runs the repository's retrieval-kernel package build and stops on a non-zero exit. */
function buildRetrievalKernel(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--filter', '@openkit/retrieval-kernel', 'build'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    child.once('error', () => {
      reject(
        new Error(
          'Could not start `pnpm --filter @openkit/retrieval-kernel build`. Isolated e2e cannot start without the retrieval executable.'
        )
      );
    });
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Retrieval kernel build failed (${signal ?? `exit ${code ?? 'unknown'}`}). Isolated e2e cannot start.`
        )
      );
    });
  });
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
 * Waits for a successful response from this child's listener, aborting requests on exit or deadline.
 *
 * @param url URL to poll.
 * @param process Child process to monitor.
 * @param instanceOwnsListener Proof from this child's post-bind output that it owns the listener.
 * @param failureDetail Optional startup detail that the caller has approved for publication.
 */
async function waitForHttp(
  url: string,
  process: HarnessChildProcess,
  instanceOwnsListener: () => boolean,
  failureDetail?: () => string | undefined
): Promise<void> {
  const deadline = Date.now() + 30_000;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 30_000);
  let onClose = () => {};
  const processClosed = new Promise<void>((resolveClose) => {
    onClose = resolveClose;
    process.once('close', onClose);
  });
  process.once('exit', abort);

  try {
    while (
      !controller.signal.aborted &&
      Date.now() < deadline &&
      process.exitCode === null &&
      process.signalCode === null
    ) {
      const response = await fetch(url, { signal: controller.signal }).catch(() => null);
      // Readiness needs only headers. Do not leave a foreign or slow response body open.
      void response?.body?.cancel().catch(() => {});
      if (
        response?.ok === true &&
        !controller.signal.aborted &&
        Date.now() < deadline &&
        process.exitCode === null &&
        process.signalCode === null &&
        instanceOwnsListener()
      ) {
        return;
      }
      await delay(Math.max(0, Math.min(100, deadline - Date.now())), undefined, {
        signal: controller.signal,
      }).catch(() => {});
    }

    const exitState = process.exitCode ?? process.signalCode;
    if (exitState !== null) {
      // Allow the final stderr bytes to arrive, but never extend the probe deadline.
      await Promise.race([processClosed, sleep(Math.max(0, Math.min(100, deadline - Date.now())))]);
      throw new Error(
        `Process exited before ${url} became ready: ${exitState}; ${failureDetail?.() ?? 'boot.reason-unavailable'}`
      );
    }
    const detail = failureDetail?.();
    throw new Error(`Timed out waiting for ${url}${detail ? `; ${detail}` : ''}.`);
  } finally {
    clearTimeout(timer);
    process.off('exit', abort);
    process.off('close', onClose);
    controller.abort();
  }
}

/**
 * Stops one spawned child process.
 *
 * @param child Child process to stop.
 * @param processGroupId Detached POSIX process-group id when descendants share cleanup ownership.
 * @throws When a detached process group remains live after the TERM and KILL cleanup deadlines.
 */
async function stopProcess(child: HarnessChildProcess, processGroupId?: number): Promise<void> {
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
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ESRCH' || code === 'EPERM') {
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
 * Finds distinct available localhost TCP ports.
 *
 * @param count Number of ports to allocate.
 * @returns Available ports.
 */
async function findOpenPorts(count: number): Promise<number[]> {
  const servers: ReturnType<typeof createServer>[] = [];

  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', () => resolveListen());
      });
    }

    return servers.map((server) => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        throw new Error('Could not allocate a TCP port.');
      }
      return address.port;
    });
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          })
      )
    );
  }
}

/**
 * Resolves after a delay.
 *
 * @param ms Delay in milliseconds.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
