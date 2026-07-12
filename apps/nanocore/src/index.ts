import { serve } from '@hono/node-server';

import {
  createApp,
  createDefaultVaultUnlockState,
  createDefaultWorkerControlGateway,
} from './app.js';
import {
  ensureServerBootstrapToken,
  writeServerBootstrapTokenEmission,
} from './auth/bootstrap-token.js';
import { ensureLocalUser } from './auth/identity.js';
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
import { resolveBindHost } from './config/bind-host.js';
import { resolveDataRoot } from './config/data-root.js';
import { resolveMode } from './config/mode.js';
import {
  createRuntimeConfigManager,
  loadRuntimeConfig,
  type RuntimeConfigSnapshot,
} from './config/runtime-config.js';
import { FsStore } from './lib/store.js';
import { recordBootPolicySelfCheckDecisions } from './policy/permission-decisions.js';
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
import { runSchedulerRestartRecovery } from './runtime/scheduler-restart-recovery.js';
import { createConfiguredTurnExecutor } from './runtime/turn-executor-factory.js';
import { schedulerLeaseHasAppliedSupplyRefreshAck } from './scheduler-records.js';
import {
  type CoreDb,
  openCoreDbWithIntegrityRecovery,
  recoverExistingScopedDatabases,
} from './storage/db.js';
import {
  ensureConfigTemplateSurface,
  ensureLayout,
  readDataRootLayoutMarker,
} from './storage/fs-layout.js';
import { rebuildExistingWorkspaceDerivedIndexes } from './storage/index-rebuild.js';
import { applyMigrations, listAppliedMigrationIds } from './storage/migrate.js';
import type { VaultUnlockState } from './vault/vault-unlock-state.js';

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
let coreDb: CoreDb | undefined;
let vaultUnlockState: VaultUnlockState | undefined;

process.once('exit', releaseProcessResources);

const bootResult = await runBootPhases({
  bootId,
  phases: [
    {
      name: 'config',
      subsystem: 'config',
      critical: true,
      run: () => {
        ensureConfigTemplateSurface(dataRoot);
        runtimeConfigSnapshot = loadRuntimeConfig(dataRoot, { version: 1 });
        mode = resolveMode(process.env, runtimeConfigSnapshot.openKitConfig);

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
        const opened = openCoreDbWithIntegrityRecovery(dataRoot);
        coreDb = opened.coreDb;
        applyMigrations(coreDb);
        const storageRecoveryEvents = [
          ...opened.recoveryEvents,
          ...recoverExistingScopedDatabases(dataRoot),
        ];
        const indexRebuildEvents = rebuildExistingWorkspaceDerivedIndexes(dataRoot);
        recordBootStartAudit({
          coreDb,
          layoutVersion: readDataRootLayoutMarker(dataRoot).layoutVersion,
          lockAcquisition: requireBootValue(dataRootLock, 'Data-root lock was not acquired.')
            .acquisition,
          migrationIds: listAppliedMigrationIds(coreDb),
          indexRebuildEvents,
          storageRecoveryEvents,
        });

        if (storageRecoveryEvents.length > 0) {
          return {
            status: 'degraded',
            reason: {
              code: 'storage.quarantined',
              message: `Quarantined ${storageRecoveryEvents.length} corrupt storage file(s).`,
              blocks: [],
            },
          };
        }

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
          ...(config.vault?.localDefaultBackend
            ? { localDefaultBackend: config.vault.localDefaultBackend }
            : {}),
        });

        return checkBootVaultBackend({
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
      run: () => {
        schedulerEpoch = runSchedulerRestartRecovery(
          requireBootValue(coreDb, 'Core database was not initialized.')
        ).schedulerEpoch;
        return { status: 'ok' };
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
const serverCoreDb = coreDb;
const activeVaultUnlockState = requireBootValue(
  vaultUnlockState,
  'Vault unlock state was not initialized.'
);

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
const workerControlGateway = createDefaultWorkerControlGateway(coreDb);
const turnExecutor = createConfiguredTurnExecutor({
  coreDb,
  vaultBackend: () => activeVaultUnlockState.backend(),
  workerControlGateway,
});
const refreshStatusCollector = maybeOpenShellRefreshStatusCollector(turnExecutor);
const schedulerStoresByUserId = new Map<string, FsStore>();

const app = createApp({
  bootReadiness,
  coreDb,
  dataRoot,
  getBootReadiness: () => bootReadiness,
  mode,
  runtimeConfigManager,
  schedulerEpoch,
  turnExecutor,
  vaultUnlockState: activeVaultUnlockState,
  workerControlGateway,
});
const hostname = resolveBindHost(process.env, mode);
const port = Number(process.env.PORT ?? 3000);

const server = serve(
  {
    fetch: app.fetch,
    hostname,
    port,
  },
  (info) => {
    console.log(`Server is running on http://${info.address}:${info.port}`);
  }
);

schedulerDispatchRetry = startSchedulerDispatchRetryService({
  agentConfigs: runtimeConfigManager.current().agentConfigs,
  agentManifests: runtimeConfigManager.current().agentManifests,
  configVersion: runtimeConfigManager.current().version,
  coreDb,
  expectedControlMode: 'poll',
  expectedDataPlaneMode: 'openshell-files',
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  intervalMs: SCHEDULER_DISPATCH_RETRY_INTERVAL_MS,
  leaseDurationMs: SCHEDULER_LEASE_RENEWAL_DURATION_MS,
  maxDispatches: SCHEDULER_DISPATCH_RETRY_MAX_DISPATCHES,
  providerRegistry: runtimeConfigManager.current().providerRegistry,
  schedulerEpoch,
  startupTimeoutMs: 120_000,
  storeForUserId: schedulerStoreForUserId,
  turnExecutor,
  onError: (error) => {
    console.warn(
      `Scheduler dispatch retry failed: ${error instanceof Error ? error.message : String(error)}`
    );
  },
});
schedulerLeaseMaintenance = startSchedulerLeaseMaintenanceService(coreDb, {
  intervalMs: SCHEDULER_LEASE_MAINTENANCE_INTERVAL_MS,
  maxTotalLeaseMs: SCHEDULER_LEASE_MAX_TOTAL_MS,
  renewalDurationMs: SCHEDULER_LEASE_RENEWAL_DURATION_MS,
  renewalLeadMs: SCHEDULER_LEASE_RENEWAL_LEAD_MS,
  canRenewPackageSnapshot: (lease) => schedulerLeaseHasAppliedSupplyRefreshAck(serverCoreDb, lease),
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
    close: (onClosed) => server.close(onClosed),
    deadlineMs: SHUTDOWN_DEADLINE_MS,
    onClosed: () => finishShutdown(signal, [...stepsCompleted, 'http-server.close'], false, 0),
    onDeadline: () => finishShutdown(signal, [...stepsCompleted, 'shutdown.deadline'], true, 1),
  });
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
 * Returns the cached product store for one scheduler admission owner.
 *
 * @param userId Store owner user id recorded on the scheduler admission row.
 * @returns User-scoped product store.
 */
function schedulerStoreForUserId(userId: string): FsStore {
  const cached = schedulerStoresByUserId.get(userId);

  if (cached) {
    return cached;
  }

  const store = new FsStore({ dataRoot, userId });
  schedulerStoresByUserId.set(userId, store);
  return store;
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
  storageRecoveryEvents: unknown[];
}): void {
  try {
    recordBootStartAuditEvent({
      coreDb: input.coreDb,
      bootId,
      layoutVersion: input.layoutVersion,
      lockAcquisition: input.lockAcquisition,
      migrationIds: input.migrationIds,
      indexRebuildEvents: input.indexRebuildEvents,
      storageRecoveryEvents: input.storageRecoveryEvents,
    });
  } catch (error) {
    console.warn(
      `Failed to record boot start audit event: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
