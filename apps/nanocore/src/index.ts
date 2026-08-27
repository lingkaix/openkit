import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import {
  createServer as createHttp2Server,
  createSecureServer as createSecureHttp2Server,
} from 'node:http2';
import { createServer as createHttpsServer } from 'node:https';

import { serve } from '@hono/node-server';

import {
  createApp,
  createDefaultVaultUnlockState,
  createDefaultWorkerControlGateway,
} from './app.js';
import { createBetterAuth, resolveBetterAuthSecret } from './auth/better-auth.js';
import {
  ensureServerBootstrapToken,
  writeServerBootstrapTokenEmission,
} from './auth/bootstrap-token.js';
import { ensureLocalUser } from './auth/identity.js';
import {
  bindRequiresServerAuthenticatedTls,
  createNanoHostTransportSessionAuthority,
  type NanoHostTransportListener,
  resolveNanoHostTransportListener,
} from './auth/nanohost-transport-session.js';
import {
  recordBootAuditEvent,
  recordBootStartAuditEvent,
  recordShutdownAuditEvent,
} from './bootstrap/audit.js';
import { acquireDataRootLock, type DataRootLock } from './bootstrap/lock.js';
import { formatBootFailureMessage, runBootPhases } from './bootstrap/phases.js';
import { loadBootPolicyKernel } from './bootstrap/policy.js';
import { createBootId, createShutdownReadinessSnapshot } from './bootstrap/readiness.js';
import { closeWithDeadline } from './bootstrap/shutdown.js';
import { checkBootVaultBackend } from './bootstrap/vault.js';
import { resolveBindHost, resolveBindPort } from './config/bind-host.js';
import { resolveDataRoot } from './config/data-root.js';
import { resolveMode } from './config/mode.js';
import {
  createRuntimeConfigManager,
  loadRuntimeConfig,
  type RuntimeConfigSnapshot,
} from './config/runtime-config.js';
import { classifyGoalStepCheckpointAfterSchedulerRecovery } from './goal-routes.js';
import { FsStore } from './lib/store.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from './mode-entry-routes.js';
import { recordBootPolicySelfCheckDecisions } from './policy/permission-decisions.js';
import { resolveEnvSecretRef } from './providers/registry.js';
import { createVaultProviderCredentialResolver } from './providers/vault-credential-resolver.js';
import { fenceNanoHostRuntimeTargetAfterRestart } from './runtime/nanohost-runtime-target.js';
import { createNanoHostSessionDispatch } from './runtime/nanohost-session-dispatch.js';
import {
  type OpenShellRefreshStatusCollector,
  type OpenShellRefreshStatusPollingService,
  startOpenShellRefreshStatusPollingService,
} from './runtime/openshell-refresh-status-polling-service.js';
import {
  type SchedulerDispatchRetryService,
  startSchedulerDispatchRetryService,
} from './runtime/scheduler-dispatch-service.js';
import {
  type SchedulerHealthProbeService,
  startSchedulerHealthProbeService,
} from './runtime/scheduler-health-probe-loop.js';
import {
  type SchedulerLeaseMaintenanceService,
  startSchedulerLeaseMaintenanceService,
} from './runtime/scheduler-lease-maintenance-service.js';
import {
  type RunSchedulerRestartRecoveryInput,
  runSchedulerRecoveryMaintenance,
  runSchedulerRestartRecovery,
} from './runtime/scheduler-restart-recovery.js';
import {
  type ConfiguredWorkerLifecycleRuntime,
  createConfiguredWorkerLifecycleRuntime,
} from './runtime/turn-executor-factory.js';
import { getWorkerBackendSession } from './runtime/worker-backend-sessions.js';
import { listExportableWorkerCheckpoints } from './runtime/worker-checkpoints.js';
import type { WorkerControlFinalStatusAcceptedInput } from './runtime/worker-control-gateway.js';
import { terminalizeGovernedWorkerTurn } from './runtime/worker-turn-failure.js';
import {
  CONFIGURED_WORKER_INITIAL_LEASE_DURATION_MS,
  CONFIGURED_WORKER_STARTUP_TIMEOUT_MS,
  completeSchedulerLeaseForTerminalTurn,
  requireSchedulerSessionLeaseAdmissionContext,
} from './scheduler-records.js';
import {
  type CoreDb,
  listExistingWorkspaceDatabaseScopes,
  openBootVerifiedWorkspaceDb,
  openCoreDbWithIntegrityCheck,
  verifyAndMigrateExistingScopedDatabases,
} from './storage/db.js';
import {
  ensureConfigTemplateSurface,
  ensureLayout,
  readDataRootLayoutMarker,
} from './storage/fs-layout.js';
import { rebuildExistingWorkspaceDerivedIndexes } from './storage/index-rebuild.js';
import { applyMigrations, listAppliedMigrationIds } from './storage/migrate.js';
import type { VaultUnlockState } from './vault/vault-unlock-state.js';
import { ensureUserQuickChatWorkspace } from './workspace-membership.js';

const dataRoot = resolveDataRoot(process.env);
const bootId = createBootId();
const SHUTDOWN_DEADLINE_MS = 5_000;
const SCHEDULER_LEASE_MAINTENANCE_INTERVAL_MS = 30_000;
const SCHEDULER_LEASE_RENEWAL_LEAD_MS = 300_000;
const SCHEDULER_LEASE_RENEWAL_DURATION_MS = 900_000;
const SCHEDULER_LEASE_MAX_TOTAL_MS = 7_200_000;
const SCHEDULER_DISPATCH_RETRY_INTERVAL_MS = 30_000;
const SCHEDULER_DISPATCH_RETRY_MAX_DISPATCHES = 5;
const SCHEDULER_HEALTH_PROBE_INTERVAL_MS = 30_000;
const SCHEDULER_HEALTH_PROBE_LIVE_INTERVAL_MS = 60_000;
const SCHEDULER_HEALTH_PROBE_IDLE_INTERVAL_MS = 300_000;
const SCHEDULER_HEALTH_PROBE_FAILURE_THRESHOLD = 3;
const SCHEDULER_HEALTH_PROBE_SUCCESS_THRESHOLD = 2;
let dataRootLock: DataRootLock | null = null;
let openshellRefreshStatusPolling: OpenShellRefreshStatusPollingService | null = null;
let schedulerDispatchRetry: SchedulerDispatchRetryService | null = null;
let schedulerHealthProbe: SchedulerHealthProbeService | null = null;
let schedulerLeaseMaintenance: SchedulerLeaseMaintenanceService | null = null;
let schedulerEpoch = 1;
let runtimeConfigSnapshot: RuntimeConfigSnapshot | undefined;
let mode: ReturnType<typeof resolveMode> | undefined;
let bindHost: string | undefined;
let bindPort: number | undefined;
let appTlsListen: NativeTlsListenOptions | null | undefined;
let nanoHostListener: NanoHostTransportListener | null | undefined;
let nanoHostTlsListen: NativeTlsListenOptions | null | undefined;
let coreDb: CoreDb | undefined;
let vaultUnlockState: VaultUnlockState | undefined;
let bootWorkerControlGateway: ReturnType<typeof createDefaultWorkerControlGateway> | undefined;
let workerLifecycleRuntime: ConfiguredWorkerLifecycleRuntime | undefined;
let runRecoveryMaintenance: (() => Promise<void>) | undefined;
let sharedStore: FsStore | undefined;
const restartCloseoutPackageSnapshots = new Set<string>();
const nanohostTransportSessionAuthority = createNanoHostTransportSessionAuthority();
const nanoHostSessionDispatch = createNanoHostSessionDispatch({
  sessionAuthority: nanohostTransportSessionAuthority,
});

process.once('exit', releaseProcessResources);

const bootResult = await runBootPhases({
  bootId,
  phases: [
    {
      name: 'config',
      subsystem: 'config',
      critical: true,
      run: () => {
        runtimeConfigSnapshot = loadRuntimeConfig(dataRoot, { version: 1 });
        mode = resolveMode(process.env, runtimeConfigSnapshot.openKitConfig);
        bindPort = resolveBindPort(process.env, runtimeConfigSnapshot.openKitConfig);
        resolveBetterAuthSecret(process.env, mode);
        ensureConfigTemplateSurface(dataRoot);
        runtimeConfigSnapshot = loadRuntimeConfig(dataRoot, { version: 1 });
        bindHost = resolveBindHost(process.env, mode, runtimeConfigSnapshot.openKitConfig);
        bindPort = resolveBindPort(process.env, runtimeConfigSnapshot.openKitConfig);
        nanoHostListener = resolveNanoHostTransportListener(
          runtimeConfigSnapshot.openKitConfig.nanohost,
          bindPort
        );
        appTlsListen = resolveNativeTlsListenOptions(bindHost, process.env);
        nanoHostTlsListen = nanoHostListener
          ? resolveNativeTlsListenOptions(
              nanoHostListener.hostname,
              process.env,
              nanoHostListener.secure
            )
          : null;

        for (const diagnostic of runtimeConfigSnapshot.diagnostics) {
          console.warn(diagnostic.message);
        }

        return { status: 'ok' };
      },
    },
    {
      name: 'data-root-layout',
      subsystem: 'storage',
      critical: true,
      run: () => {
        ensureLayout(dataRoot);
        return { status: 'ok' };
      },
    },
    {
      name: 'instance-lock',
      subsystem: 'storage',
      critical: true,
      run: () => {
        dataRootLock = acquireDataRootLock(dataRoot, { bootId });
        return { status: 'ok' };
      },
    },
    {
      name: 'migrations',
      subsystem: 'storage',
      critical: true,
      run: () => {
        coreDb = openCoreDbWithIntegrityCheck(dataRoot);
        applyMigrations(coreDb);
        verifyAndMigrateExistingScopedDatabases(dataRoot);
        const indexRebuildEvents = rebuildExistingWorkspaceDerivedIndexes(dataRoot);
        recordBootStartAudit({
          coreDb,
          layoutVersion: readDataRootLayoutMarker(dataRoot).layoutVersion,
          lockAcquisition: requireBootValue(dataRootLock, 'Data-root lock was not acquired.')
            .acquisition,
          migrationIds: listAppliedMigrationIds(coreDb),
          indexRebuildEvents,
        });

        if (indexRebuildEvents.length > 0) {
          return {
            status: 'degraded',
            reason: {
              code: 'storage.index-rebuilt',
              message: `Rebuilt ${indexRebuildEvents.length} workspace index set(s).`,
              blocks: [],
            },
          };
        }

        return { status: 'ok' };
      },
    },
    {
      name: 'policy-kernel',
      subsystem: 'policy',
      critical: true,
      run: () => {
        const kernel = loadBootPolicyKernel();
        recordBootPolicySelfCheckDecisions({
          bootId,
          coreDb: requireBootValue(coreDb, 'Core database was not initialized.'),
          kernel,
        });
        return { status: 'ok' };
      },
    },
    {
      name: 'vault',
      subsystem: 'vault',
      critical: false,
      run: () => {
        const config = requireBootValue(
          runtimeConfigSnapshot,
          'Runtime config was not loaded.'
        ).openKitConfig;
        vaultUnlockState = createDefaultVaultUnlockState({
          dataRoot,
          mode: requireBootValue(mode, 'Core mode was not resolved.'),
        });

        return checkBootVaultBackend({
          dataRoot,
          ...(config.vault?.encryptedFile?.keyFilePath
            ? { keyFilePath: config.vault.encryptedFile.keyFilePath }
            : {}),
          vaultUnlockState,
        });
      },
    },
    {
      name: 'local-identity',
      subsystem: 'config',
      critical: true,
      run: () => {
        if (mode === 'local') {
          ensureLocalUser(requireBootValue(coreDb, 'Core database was not initialized.'));
        }

        return { status: 'ok' };
      },
    },
    {
      name: 'scheduler-restart-recovery',
      subsystem: 'scheduler',
      critical: true,
      run: async () => {
        const recoveryCoreDb = requireBootValue(coreDb, 'Core database was not initialized.');
        fenceNanoHostRuntimeTargetAfterRestart(recoveryCoreDb, new Date().toISOString());
        sharedStore ??= new FsStore({ dataRoot });
        const recoveryStore = sharedStore;
        bootWorkerControlGateway = createDefaultWorkerControlGateway(
          recoveryCoreDb,
          scheduleCommittedFinalStatusCloseout
        );
        workerLifecycleRuntime = createConfiguredWorkerLifecycleRuntime({
          coreDb: recoveryCoreDb,
          nanoHostSessionDispatch,
          store: recoveryStore,
          vaultBackend: () =>
            requireBootValue(vaultUnlockState, 'Vault unlock state was not initialized.').backend(),
          workerControlGateway: bootWorkerControlGateway,
        });
        const recoveryRuntime = workerLifecycleRuntime;
        const recoveryInput = {
          cleanupBackendSession: recoveryRuntime.cleanupBackendSession,
          projectRecoveredTurn: async (subject) => {
            const admission = requireSchedulerSessionLeaseAdmissionContext(
              recoveryCoreDb,
              subject.leaseId
            );
            const anchored = 'state' in subject;
            const result = terminalizeGovernedWorkerTurn({
              agentSessionId: subject.agentSessionId,
              completedAt: new Date().toISOString(),
              errorCode: 'worker_governance_restart_recovery',
              message: anchored
                ? 'Worker execution was interrupted during NanoCore restart recovery.'
                : 'Worker execution stopped during NanoCore restart recovery.',
              outcome: anchored ? 'interrupted' : 'failed',
              requestId: admission.requestId,
              store: recoveryStore,
              turnId: subject.turnId,
            });

            if (
              result.status !== 'completed' &&
              result.status !== 'failed' &&
              result.status !== 'interrupted' &&
              result.status !== 'cancelled' &&
              result.status !== 'missing'
            ) {
              throw new Error(
                `Restart recovery left turn ${subject.turnId} non-terminal: ${result.status}.`
              );
            }

            return { status: result.status };
          },
          prepareBackendCleanup: recoveryRuntime.prepareBackendCleanup,
          restoreBackendSession: recoveryRuntime.restoreBackendSession,
        } satisfies RunSchedulerRestartRecoveryInput;
        schedulerEpoch = (await runSchedulerRestartRecovery(recoveryCoreDb, recoveryInput))
          .schedulerEpoch;
        const checkpointRecoveryFailures =
          await classifyWorkerCheckpointsAfterSchedulerRecovery(recoveryCoreDb);
        runRecoveryMaintenance = () =>
          runSchedulerRecoveryMaintenance(recoveryCoreDb, schedulerEpoch, recoveryInput);
        for (const row of recoveryCoreDb.sqlite
          .prepare(
            `SELECT package_snapshot_id AS packageSnapshotId
             FROM scheduler_session_leases
             WHERE recovery_state = 'awaiting-reconnect'`
          )
          .all() as Array<{ readonly packageSnapshotId: string }>) {
          restartCloseoutPackageSnapshots.add(row.packageSnapshotId);
        }
        return checkpointRecoveryFailures === 0
          ? { status: 'ok' }
          : {
              status: 'degraded',
              reason: {
                code: 'scheduler.checkpoint_recovery_required',
                message: `${checkpointRecoveryFailures} worker checkpoint recovery attempt(s) require inspection.`,
                blocks: [],
              },
            };
      },
    },
  ],
});
let bootReadiness = bootResult.readiness;

if (coreDb) {
  try {
    recordBootAuditEvent({ coreDb, result: bootResult });
  } catch (error) {
    console.warn(
      `Failed to record boot audit event: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

const criticalBootFailure = bootResult.outcomes.find(
  (outcome) => outcome.critical && outcome.outcome.status === 'failed'
);

if (criticalBootFailure || !bootReadiness.acceptingProductWork) {
  const message = formatBootFailureMessage(bootResult);
  console.error(message);
  vaultUnlockState?.lock();
  releaseDataRootLock();
  throw new Error(message);
}

runtimeConfigSnapshot = requireBootValue(runtimeConfigSnapshot, 'Runtime config was not loaded.');
mode = requireBootValue(mode, 'Core mode was not resolved.');
coreDb = requireBootValue(coreDb, 'Core database was not initialized.');
const activeCoreDb = coreDb;
const activeVaultUnlockState = requireBootValue(
  vaultUnlockState,
  'Vault unlock state was not initialized.'
);
const schedulerProviderCredentialResolver = createVaultProviderCredentialResolver({
  coreDb,
  fallback: resolveEnvSecretRef,
  vaultBackend: () => activeVaultUnlockState.backend(),
});

const runtimeConfigManager = createRuntimeConfigManager({
  dataRoot,
  initialSnapshot: runtimeConfigSnapshot,
});

if (mode === 'local') {
  ensureLocalUser(coreDb);
}
if (mode === 'server') {
  const bootstrap = ensureServerBootstrapToken(coreDb);
  if (bootstrap) {
    const emission = writeServerBootstrapTokenEmission(dataRoot, bootstrap);
    console.warn(
      `OpenKit server bootstrap token written once to ${emission.path}; it expires at ${bootstrap.expiresAt}.`
    );
  }
}
const workerControlGateway = requireBootValue(
  bootWorkerControlGateway,
  'Worker-control gateway was not initialized.'
);
const turnExecutor = requireBootValue(
  workerLifecycleRuntime,
  'Worker lifecycle runtime was not initialized.'
).turnExecutor;
const activeWorkerLifecycleRuntime = requireBootValue(
  workerLifecycleRuntime,
  'Worker lifecycle runtime was not initialized.'
);
const workerPlacement = 'local' as const;
const refreshStatusCollector = maybeOpenShellRefreshStatusCollector(turnExecutor);
const store = requireBootValue(sharedStore, 'Shared Workspace store was not initialized.');

/**
 * Ensures the personal Quick Chat Workspace before Better Auth records a new active session.
 *
 * @param userId Active canonical user starting the session.
 */
function onActiveUserSession(userId: string): void {
  ensureUserQuickChatWorkspace({ coreDb: activeCoreDb, store, userId });
}

const auth =
  mode === 'server'
    ? createBetterAuth(coreDb, {
        mode,
        onActiveUserSession,
        openKitConfig: runtimeConfigSnapshot.openKitConfig,
      })
    : undefined;

const app = createApp({
  ...(auth ? { auth } : {}),
  bootReadiness,
  coreDb,
  dataRoot,
  getBootReadiness: () => bootReadiness,
  mode,
  nanoHostSessionDispatch,
  nanohostTransportSessionAuthority,
  runtimeConfigManager,
  schedulerEpoch,
  store,
  turnExecutor,
  vaultUnlockState: activeVaultUnlockState,
  workerLifecycleRuntime: activeWorkerLifecycleRuntime,
  workerControlGateway,
  workerPlacement,
});
const hostname = requireBootValue(bindHost, 'HTTP bind host was not resolved.');
const port = requireBootValue(bindPort, 'HTTP bind port was not resolved.');
if (
  appTlsListen === undefined ||
  nanoHostListener === undefined ||
  nanoHostTlsListen === undefined
) {
  throw new Error('NanoCore listener configuration was not resolved during boot.');
}
/** Returns whether one request belongs exclusively to the private NanoHost listener. */
const isNanoHostPrivateRequest = (request: Request) => {
  const path = new URL(request.url).pathname;
  return (
    path.startsWith('/api/nanohost/transport/') ||
    path.startsWith('/worker-control/') ||
    path.startsWith('/inference/')
  );
};
const appFetch: typeof app.fetch = async (request, env, executionContext) =>
  isNanoHostPrivateRequest(request)
    ? new Response(null, { status: 404 })
    : app.fetch(request, env, executionContext);
const nanoHostFetch: typeof app.fetch = async (request, env, executionContext) =>
  isNanoHostPrivateRequest(request)
    ? app.fetch(request, env, executionContext)
    : new Response(null, { status: 404 });

const appServer = appTlsListen
  ? serve(
      {
        createServer: createHttpsServer,
        fetch: appFetch,
        hostname,
        port,
        serverOptions: appTlsListen,
      },
      (info) => {
        console.log(`App server is running on https://${info.address}:${info.port}`);
      }
    )
  : serve(
      {
        createServer: createHttpServer,
        fetch: appFetch,
        hostname,
        port,
      },
      (info) => {
        console.log(`App server is running on http://${info.address}:${info.port}`);
      }
    );
const nanoHostServer = nanoHostListener
  ? nanoHostTlsListen
    ? serve(
        {
          createServer: createSecureHttp2Server,
          fetch: nanoHostFetch,
          hostname: nanoHostListener.hostname,
          port: nanoHostListener.port,
          serverOptions: nanoHostTlsListen,
        },
        (info) => {
          console.log(`NanoHost server is running on https://${info.address}:${info.port}`);
        }
      )
    : serve(
        {
          createServer: createHttp2Server,
          fetch: nanoHostFetch,
          hostname: nanoHostListener.hostname,
          port: nanoHostListener.port,
        },
        (info) => {
          console.log(`NanoHost server is running on http://${info.address}:${info.port}`);
        }
      )
  : null;

schedulerDispatchRetry = startSchedulerDispatchRetryService({
  agentManifests: runtimeConfigManager.current().agentManifests,
  configVersion: runtimeConfigManager.current().version,
  coreDb,
  dependencies: { providerCredentialResolver: schedulerProviderCredentialResolver },
  expectedControlMode: 'poll',
  expectedDataPlaneMode: 'openshell-files',
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  intervalMs: SCHEDULER_DISPATCH_RETRY_INTERVAL_MS,
  leaseDurationMs: CONFIGURED_WORKER_INITIAL_LEASE_DURATION_MS,
  maxDispatches: SCHEDULER_DISPATCH_RETRY_MAX_DISPATCHES,
  providerRegistry: runtimeConfigManager.current().providerRegistry,
  schedulerEpoch,
  startupTimeoutMs: CONFIGURED_WORKER_STARTUP_TIMEOUT_MS,
  store,
  turnExecutor,
  onError: (error) => {
    console.warn(
      `Scheduler dispatch retry failed: ${error instanceof Error ? error.message : String(error)}`
    );
  },
});
schedulerLeaseMaintenance = startSchedulerLeaseMaintenanceService(coreDb, {
  runRecoveryMaintenance: requireBootValue(
    runRecoveryMaintenance,
    'Scheduler recovery maintenance was not initialized.'
  ),
  intervalMs: SCHEDULER_LEASE_MAINTENANCE_INTERVAL_MS,
  maxTotalLeaseMs: SCHEDULER_LEASE_MAX_TOTAL_MS,
  renewalDurationMs: SCHEDULER_LEASE_RENEWAL_DURATION_MS,
  renewalLeadMs: SCHEDULER_LEASE_RENEWAL_LEAD_MS,
  onError: (error) => {
    console.warn(
      `Scheduler lease maintenance failed: ${error instanceof Error ? error.message : String(error)}`
    );
  },
});
schedulerHealthProbe = startSchedulerHealthProbeService(coreDb, {
  failureThreshold: SCHEDULER_HEALTH_PROBE_FAILURE_THRESHOLD,
  idleIntervalMs: SCHEDULER_HEALTH_PROBE_IDLE_INTERVAL_MS,
  intervalMs: SCHEDULER_HEALTH_PROBE_INTERVAL_MS,
  liveIntervalMs: SCHEDULER_HEALTH_PROBE_LIVE_INTERVAL_MS,
  successThreshold: SCHEDULER_HEALTH_PROBE_SUCCESS_THRESHOLD,
  onError: (error) => {
    console.warn(
      `Scheduler health probe failed: ${error instanceof Error ? error.message : String(error)}`
    );
  },
});
if (refreshStatusCollector) {
  openshellRefreshStatusPolling = startOpenShellRefreshStatusPollingService({
    collector: refreshStatusCollector,
    intervalMs: SCHEDULER_HEALTH_PROBE_LIVE_INTERVAL_MS,
    onError: (error) => {
      console.warn(
        `OpenShell refresh status polling failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    },
  });
}

/** Schedules at most one process-local closeout for an accepted `final_status`. */
function scheduleCommittedFinalStatusCloseout(input: WorkerControlFinalStatusAcceptedInput): void {
  const database = coreDb;
  const runtime = workerLifecycleRuntime;
  const packageSnapshotId = input.lineage.packageSnapshotId;
  if (!database || !runtime || !restartCloseoutPackageSnapshots.delete(packageSnapshotId)) {
    return;
  }
  void (async () => {
    const lease = database.sqlite
      .prepare(
        'SELECT lease_id AS leaseId FROM scheduler_session_leases WHERE sandbox_binding_ref = ?'
      )
      .get(input.sandboxBindingRef) as { readonly leaseId: string } | undefined;
    const session = lease ? getWorkerBackendSession(database, lease.leaseId) : null;
    if (!session) {
      throw new Error('Accepted worker final status has no durable backend session.');
    }
    const result = await runtime.reconcileAcceptedFinalStatus(session);
    completeSchedulerLeaseForTerminalTurn(database, result.turn);
  })().catch((error) => {
    restartCloseoutPackageSnapshots.add(packageSnapshotId);
    console.warn(
      `Worker final-status closeout failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });
}

/**
 * Releases process-local resources during an orderly shutdown.
 *
 * @param signal Signal that requested shutdown.
 */
function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}; shutting down NanoCore.`);
  bootReadiness = createShutdownReadinessSnapshot(bootReadiness);
  schedulerDispatchRetry?.stop();
  schedulerHealthProbe?.stop();
  schedulerLeaseMaintenance?.stop();
  openshellRefreshStatusPolling?.stop();
  const stepsCompleted = [
    'scheduler.dispatch-retry.stop',
    'scheduler.health-probe.stop',
    'scheduler.lease-maintenance.stop',
    'openshell.refresh-status-polling.stop',
  ];
  closeWithDeadline({
    close: closeNanoCoreListeners,
    deadlineMs: SHUTDOWN_DEADLINE_MS,
    onClosed: () => finishShutdown(signal, [...stepsCompleted, 'http-server.close'], false, 0),
    onDeadline: () => finishShutdown(signal, [...stepsCompleted, 'shutdown.deadline'], true, 1),
  });
}

/** Closes both process listeners before completing orderly shutdown. */
function closeNanoCoreListeners(onClosed: () => void): void {
  let remaining = nanoHostServer ? 2 : 1;
  const markClosed = () => {
    remaining -= 1;
    if (remaining === 0) {
      onClosed();
    }
  };
  appServer.close(markClosed);
  nanoHostServer?.close(markClosed);
}

/**
 * Returns an OpenShell refresh status collector when the configured turn executor exposes one.
 *
 * @param executor Configured turn executor.
 * @returns Collector or null for runtimes without provider refresh polling.
 */
function maybeOpenShellRefreshStatusCollector(
  executor: unknown
): OpenShellRefreshStatusCollector | null {
  if (
    typeof executor === 'object' &&
    executor !== null &&
    'collectProviderRefreshStatuses' in executor &&
    typeof executor.collectProviderRefreshStatuses === 'function'
  ) {
    return executor as OpenShellRefreshStatusCollector;
  }

  return null;
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

/**
 * Returns a required boot value or throws a boot failure.
 *
 * @param value Boot value to check.
 * @param message Failure message.
 * @returns Non-null boot value.
 */
function requireBootValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }

  return value;
}

/**
 * Environment shape used to resolve native server-authenticated TLS material.
 */
interface TlsListenEnv {
  /** Absolute or process-relative path to the PEM certificate chain. */
  OPENKIT_TLS_CERT_FILE?: string;
  /** Absolute or process-relative path to the PEM private key. */
  OPENKIT_TLS_KEY_FILE?: string;
}

/** Native TLS material shared by the two process listeners when required. */
interface NativeTlsListenOptions {
  /** PEM certificate chain bytes. */
  readonly cert: Buffer;
  /** PEM private-key bytes. */
  readonly key: Buffer;
}

/**
 * Resolves native TLS listen options for the NanoCore process listener.
 *
 * Non-loopback binds require server-authenticated TLS and therefore PEM cert
 * plus key paths. Exact same-host loopback may remain plaintext. Missing TLS
 * material on a TLS-required bind fails closed with no plaintext downgrade.
 *
 * @param bindHost Resolved NanoCore bind host.
 * @param env Process environment carrying optional TLS file paths.
 * @returns HTTPS server options when TLS is required, otherwise null.
 * @throws Error when a non-loopback bind lacks readable TLS material.
 */
function resolveNativeTlsListenOptions(
  bindHost: string,
  env: TlsListenEnv,
  required = bindRequiresServerAuthenticatedTls(bindHost)
): NativeTlsListenOptions | null {
  if (!required) {
    return null;
  }

  const certPath = env.OPENKIT_TLS_CERT_FILE?.trim();
  const keyPath = env.OPENKIT_TLS_KEY_FILE?.trim();
  if (!certPath || !keyPath) {
    throw new Error(
      `TLS listener for bind host "${bindHost}" requires OPENKIT_TLS_CERT_FILE and OPENKIT_TLS_KEY_FILE.`
    );
  }

  try {
    return {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    };
  } catch (error) {
    throw new Error(
      `Failed to load NanoCore TLS listen material from OPENKIT_TLS_CERT_FILE / OPENKIT_TLS_KEY_FILE: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Classifies every persisted worker checkpoint after scheduler fencing has completed.
 *
 * @param recoveryCoreDb Fenced Core database containing scheduler authority.
 * @returns Count of checkpoints or Workspace scans that remain recovery-required.
 */
async function classifyWorkerCheckpointsAfterSchedulerRecovery(
  recoveryCoreDb: CoreDb
): Promise<number> {
  let failures = 0;
  const store = requireBootValue(sharedStore, 'Shared Workspace store was not initialized.');

  for (const { workspaceId } of listExistingWorkspaceDatabaseScopes(dataRoot)) {
    let workspaceDb: ReturnType<typeof openBootVerifiedWorkspaceDb> | null = null;
    try {
      workspaceDb = openBootVerifiedWorkspaceDb(dataRoot, workspaceId);
      for (const checkpoint of listExportableWorkerCheckpoints(workspaceDb, workspaceId)) {
        try {
          if (checkpoint.goalId === null && checkpoint.taskId === null) {
            await classifyDirectTaskCheckpointAfterSchedulerRecovery({
              coreDb: recoveryCoreDb,
              store,
              workspaceDb,
              checkpoint,
            });
          } else if (checkpoint.goalId !== null && checkpoint.taskId !== null) {
            await classifyGoalStepCheckpointAfterSchedulerRecovery({
              coreDb: recoveryCoreDb,
              store,
              workspaceDb,
              checkpoint,
            });
          } else {
            throw new Error('Worker checkpoint has only one Goal lineage owner.');
          }
        } catch (error) {
          failures += 1;
          console.warn(
            `Checkpoint recovery_required for ${workspaceId}/${checkpoint.threadId}/${checkpoint.turnId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    } catch (error) {
      failures += 1;
      console.warn(
        `Workspace checkpoint scan recovery_required for ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      workspaceDb?.sqlite.close();
    }
  }

  return failures;
}

/** Releases the data-root lock when this process acquired one. */
function releaseDataRootLock(): void {
  dataRootLock?.release();
}

/** Finishes shutdown through one terminal path. */
function finishShutdown(
  signal: NodeJS.Signals,
  stepsCompleted: string[],
  deadlineForcedExit: boolean,
  exitCode: number
): void {
  vaultUnlockState?.lock();
  recordShutdownAudit(signal, [...stepsCompleted, 'vault.lock'], deadlineForcedExit);
  releaseDataRootLock();
  process.exit(exitCode);
}

/** Locks secret state and releases the data-root lock during process exit. */
function releaseProcessResources(): void {
  vaultUnlockState?.lock();
  releaseDataRootLock();
}

/**
 * Records best-effort orderly shutdown audit evidence.
 *
 * @param signal Signal that requested shutdown.
 * @param stepsCompleted Ordered shutdown steps completed before lock release.
 * @param deadlineForcedExit Whether the shutdown deadline forced exit.
 */
function recordShutdownAudit(
  signal: NodeJS.Signals,
  stepsCompleted: string[],
  deadlineForcedExit: boolean
): void {
  try {
    recordShutdownAuditEvent({
      coreDb: requireBootValue(coreDb, 'Core database was not initialized.'),
      bootId,
      reason: signal,
      stepsCompleted,
      deadlineForcedExit,
    });
  } catch (error) {
    console.warn(
      `Failed to record shutdown audit event: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Records best-effort durable boot start evidence once storage is writable.
 *
 * @param input Boot start audit details.
 */
function recordBootStartAudit(input: {
  coreDb: CoreDb;
  layoutVersion: number;
  lockAcquisition: DataRootLock['acquisition'];
  migrationIds: string[];
  indexRebuildEvents: unknown[];
}): void {
  try {
    recordBootStartAuditEvent({
      coreDb: input.coreDb,
      bootId,
      layoutVersion: input.layoutVersion,
      lockAcquisition: input.lockAcquisition,
      migrationIds: input.migrationIds,
      indexRebuildEvents: input.indexRebuildEvents,
    });
  } catch (error) {
    console.warn(
      `Failed to record boot start audit event: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
