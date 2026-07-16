import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  configureRealCodexRuntime,
  streamCodexAuthFromSsh,
} from './real-codex-goal-mode-runner.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const coreClientDist = join(root, 'packages/core-client/dist/index.js');
const nanoCoreDist = join(root, 'apps/nanocore/dist/index.js');
const restartRequired = 'Real Codex runtime configuration requires a NanoCore restart.';
const defaultTask =
  'Run `sleep 30`, then inspect README.md and report one concise implementation observation.';

/**
 * Returns the opt-in A1 acceptance configuration.
 *
 * @param {Record<string, string | undefined>} env Process environment.
 * @param {(path: string) => boolean} fileExists File existence check.
 * @returns {{ enabled: boolean, reason: string, config: Record<string, any> }} Acceptance decision.
 */
export function evaluateA1RestartConfig(env = process.env, fileExists = existsSync) {
  const config = {
    dataRoot: env.OPENKIT_L6_NANOCORE_DATA_ROOT ?? '',
    port: Number(env.OPENKIT_L6_A1_RESTART_PORT ?? '4317'),
    repositoryRoot: env.OPENKIT_L6_TASK_REPO_ROOT ?? '',
    taskInput: env.OPENKIT_L6_A1_RESTART_TASK_INPUT ?? defaultTask,
  };
  const required = [
    [env.OPENKIT_L6_A1_RESTART, '1', 'set OPENKIT_L6_A1_RESTART=1'],
    [env.OPENKIT_L6_ALLOW_PROVIDER_QUOTA, '1', 'acknowledge provider quota'],
    [env.OPENKIT_CONTAINER_BACKEND, 'openshell', 'use the stock OpenShell backend'],
    [env.OPENKIT_CONTAINER_PLACEMENT, 'remote', 'use remote worker placement'],
  ];
  const missing = required.find(([actual, expected]) => actual !== expected);
  if (missing) return { config, enabled: false, reason: missing[2] };
  if (!config.dataRoot) return { config, enabled: false, reason: 'set the NanoCore data root' };
  if (!config.repositoryRoot || !fileExists(join(config.repositoryRoot, '.git'))) {
    return { config, enabled: false, reason: 'set a disposable git repository' };
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    return { config, enabled: false, reason: 'set a valid restart port' };
  }
  if (fileExists(join(config.dataRoot, 'server/db/core.sqlite'))) {
    return { config, enabled: false, reason: 'use a fresh NanoCore data root' };
  }
  return { config, enabled: true, reason: '' };
}

/**
 * Starts one NanoCore process group that can be killed and restarted in place.
 *
 * @param {Record<string, any>} config Fixed data root and port.
 * @param {Record<string, string | undefined>} env Child environment.
 * @param {typeof spawn} spawnProcess Process launcher.
 * @param {typeof process.kill} killProcess Process-group signal implementation.
 * @returns {{ crash: () => Promise<void>, restart: () => void, stop: () => Promise<void> }} Owner.
 */
function startNanoCore(config, env, spawnProcess = spawn, killProcess = process.kill) {
  let child;
  const launch = () => {
    child = spawnProcess(process.execPath, [nanoCoreDist], {
      detached: true,
      env: { ...env, OPENKIT_DATA_ROOT: config.dataRoot, PORT: String(config.port) },
      stdio: 'inherit',
    });
    if (!child.pid) throw new Error('NanoCore did not start.');
  };
  const crash = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    killProcess(-child.pid, 'SIGKILL');
    await closed;
  };
  launch();
  return { crash, restart: launch, stop: crash };
}

/** Imports the built public Core Client. */
async function createClient(config) {
  const { createCoreClient } = await import(pathToFileURL(coreClientDist).href);
  return createCoreClient({ baseUrl: `http://127.0.0.1:${config.port}` });
}

/** Polls until a check returns a truthy value or the deadline expires. */
async function waitFor(check, timeoutMs, wait = delay) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(200);
  }
  throw new Error('A1 restart acceptance timed out.');
}

/** Waits for the public diagnostics endpoint to accept product work. */
async function waitForCore(config, clientFactory, wait) {
  return waitFor(
    async () => {
      try {
        const core = await clientFactory(config);
        return (await core.app.getDiagnostics()).boot?.acceptingProductWork ? core : null;
      } catch {
        return null;
      }
    },
    30_000,
    wait
  );
}

/** Reads the exact durable boundary proving that the original worker reached sequence zero. */
function readReconnectBarrier(dataRoot, workerSessionId) {
  const db = new DatabaseSync(join(dataRoot, 'server/db/core.sqlite'), { readOnly: true });
  try {
    return (
      db
        .prepare(
          `SELECT backend.state AS backendState,
                  backend.workspace_handoff_state AS handoffState,
                  lease.status AS leaseStatus,
                  lease.last_worker_sequence AS lastWorkerSequence,
                  lease.worker_process_key_hash AS workerProcessKeyHash,
                  (SELECT COUNT(*) FROM worker_control_records AS record
                   WHERE record.package_snapshot_id = backend.package_snapshot_id
                     AND record.operation = 'final_status') AS finalStatusCount
           FROM worker_backend_sessions AS backend
           JOIN scheduler_session_leases AS lease ON lease.lease_id = backend.lease_id
           WHERE backend.backend_session_id = ?`
        )
        .get(workerSessionId) ?? null
    );
  } finally {
    db.close();
  }
}

/**
 * Runs one stock OpenShell task across a direct local NanoCore kill and restart.
 *
 * @param {Record<string, any>} options Focused process and public-client test seams.
 * @returns {Promise<Record<string, unknown>>} Redacted acceptance summary.
 */
export async function runA1NanoCoreRestart(options = {}) {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const decision = evaluateA1RestartConfig(env, fileExists);
  if (!decision.enabled) return { status: 'skipped', reason: decision.reason };
  if (!options.createClient && !fileExists(coreClientDist)) throw new Error('Build Core Client.');
  if (!options.startProcess && !fileExists(nanoCoreDist)) throw new Error('Build NanoCore.');

  const config = decision.config;
  (options.mkdir ?? mkdirSync)(config.dataRoot, { mode: 0o700, recursive: true });
  const owner = (options.startProcess ?? startNanoCore)(config, env);
  const clientFactory = options.createClient ?? createClient;
  const wait = options.wait ?? delay;
  const configure = options.configureRuntime ?? configureRealCodexRuntime;
  const syncAuth = options.syncCodexAuth ?? ((input) => streamCodexAuthFromSsh({ env, ...input }));
  const readBarrier = options.readReconnectBarrier ?? readReconnectBarrier;

  try {
    let core = await waitForCore(config, clientFactory, wait);
    try {
      await configure(core, { nanoCoreDataRoot: config.dataRoot }, syncAuth);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(restartRequired)) throw error;
      await owner.crash();
      owner.restart();
      core = await waitForCore(config, clientFactory, wait);
      await configure(core, { nanoCoreDataRoot: config.dataRoot }, syncAuth);
    }

    const workspace = await core.core.createWorkspace({ name: 'A1 restart acceptance' });
    const thread = await core.core.createThread({
      name: 'A1 restart acceptance',
      workspaceId: workspace.id,
    });
    await core.repositories.setDefault(workspace.id, {
      displayName: 'A1 restart repository',
      localPath: config.repositoryRoot,
    });

    let taskError;
    void core.app
      .startTaskMode(workspace.id, thread.id, { input: config.taskInput })
      .catch((error) => {
        taskError = error;
      });
    const before = await waitFor(
      async () => {
        if (taskError) throw taskError;
        const handles = (await core.app.listBackendWorkspaceHandles(workspace.id)).items ?? [];
        const handle = handles.length === 1 ? handles[0] : null;
        if (!handle || handle.cleanupStatus !== 'pending') return null;
        const barrier = readBarrier(config.dataRoot, handle.workerSessionId);
        return barrier?.backendState === 'launching' &&
          barrier.handoffState === 'complete' &&
          (barrier.leaseStatus === 'active' || barrier.leaseStatus === 'idle') &&
          barrier.lastWorkerSequence >= 1 &&
          barrier.workerProcessKeyHash &&
          barrier.finalStatusCount === 0
          ? { barrier, handle }
          : null;
      },
      60_000,
      wait
    );

    await owner.crash();
    owner.restart();
    core = await waitForCore(config, clientFactory, wait);
    await waitFor(
      async () => {
        const items = (await core.core.listThreadItems(workspace.id, thread.id)).items ?? [];
        return items.some(
          (item) => item.type === 'assistant-message' && item.status === 'completed'
        );
      },
      300_000,
      wait
    );
    const after = await waitFor(
      async () => {
        const handles = (await core.app.listBackendWorkspaceHandles(workspace.id)).items ?? [];
        return handles.length === 1 && handles[0].cleanupStatus === 'cleaned' ? handles[0] : null;
      },
      60_000,
      wait
    );
    const afterBarrier = await waitFor(
      () => {
        const barrier = readBarrier(config.dataRoot, after.workerSessionId);
        return barrier?.backendState === 'cleaned' && barrier.finalStatusCount === 1
          ? barrier
          : null;
      },
      30_000,
      wait
    );
    if (
      after.id !== before.handle.id ||
      after.workerSessionId !== before.handle.workerSessionId ||
      afterBarrier.lastWorkerSequence <= before.barrier.lastWorkerSequence
    ) {
      throw new Error('NanoCore replaced the surviving OpenShell worker.');
    }
    return { cleanupStatus: after.cleanupStatus, sameWorker: true, status: 'ok' };
  } finally {
    await owner.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runA1NanoCoreRestart().then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(
        `${error instanceof Error ? error.message : String(error)} Data root retained.`
      );
      process.exitCode = 1;
    }
  );
}
