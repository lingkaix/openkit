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
  restoreWorkspaceDeletionMutationAdmission,
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
import { BootConfigError, resolveMode } from './config/mode.js';
import {
  createRuntimeConfigManager,
  loadRuntimeConfig,
  type RuntimeConfigSnapshot,
  unknownModelContextFailure,
} from './config/runtime-config.js';
import { readReleaseIdentity } from './diagnostics/release-identity.js';
import { NANOCORE_HTTP_SERVER_OPTIONS } from './http-server-options.js';
import { AutomationStore } from './lib/automation-store.js';
import { FsStore } from './lib/store.js';
import { ProviderSubscriptionAccountManager } from './llm/provider-subscription-accounts.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from './mode-entry-routes.js';
import { recordBootPolicySelfCheckDecisions } from './policy/permission-decisions.js';
import { resolveEnvSecretRef } from './providers/registry.js';
import {
  createProviderCredentialConfigured,
  createVaultProviderCredentialResolver,
} from './providers/vault-credential-resolver.js';
import { closeRetrievalServices, getRetrievalService } from './retrieval-service.js';
import { markSchedulerAttemptForTerminalTurn } from './runtime/execution-attempt-records.js';
import {
  classifyNanoHostAttemptsAfterRestart,
  type RunNanoHostAttemptRecoveryInput,
  runNanoHostAttemptRecoveryMaintenance,
} from './runtime/nanohost-attempt-recovery.js';
import { fenceNanoHostRuntimeTargetAfterRestart } from './runtime/nanohost-runtime-target.js';
import { createNanoHostSessionDispatch } from './runtime/nanohost-session-dispatch.js';
import {
  installPendingRequestAdmission,
  recoverPendingRequestsAtBoot,
} from './runtime/pending-request-flow.js';
import { prepareRecurringOccurrence } from './runtime/recurring-schedule-preparation.js';
import {
  type RecurringScheduleService,
  startRecurringScheduleService,
} from './runtime/recurring-schedule-service.js';
import {
  type SchedulerAttemptMaintenanceInput,
  type SchedulerAttemptMaintenanceService,
  startSchedulerAttemptMaintenanceService,
} from './runtime/scheduler-attempt-maintenance-service.js';
import {
  type SchedulerDispatchRetryService,
  startSchedulerDispatchRetryService,
} from './runtime/scheduler-dispatch-service.js';
import {
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
import { createDefaultWorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import { terminalizeGovernedWorkerTurn } from './runtime/worker-turn-failure.js';
import { requireSchedulerExecutionAttemptAdmissionContext } from './scheduler-records.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import {
  type CoreDb,
  isFreshCoreInitializationScope,
  listExistingWorkspaceDatabaseScopes,
  openBootVerifiedWorkspaceDb,
  openCoreDbWithIntegrityCheck,
  verifyAndMigrateExistingScopedDatabases,
} from './storage/db.js';
import {
  ensureConfigTemplateSurface,
  ensureLayout,
  readDataRootLayoutMarker,
  resolveDataRootPath,
} from './storage/fs-layout.js';
import { rebuildInvalidExistingWorkspaceDerivedIndexes } from './storage/index-rebuild.js';
import { applyMigrations, listAppliedMigrationIds } from './storage/migrate.js';
import { appendRecoveredTurnObservation } from './storage/work-observation-recovery.js';
import { cleanupWorkspaceArchiveRequestStaging } from './storage/workspace-archive.js';
import { discardAbandonedWorkspaceStaging } from './storage/workspace-file-records.js';
import { shutdownTelemetry, startTelemetry } from './telemetry.js';
import type { VaultUnlockState } from './vault/vault-unlock-state.js';
import { reconcileWorkerMcpItems } from './worker-mcp-routes.js';
import { ensureUserQuickChatWorkspace } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const dataRoot = resolveDataRoot(process.env);
const bootId = createBootId();
const SHUTDOWN_DEADLINE_MS = 5_000;
const SCHEDULER_ATTEMPT_MAINTENANCE_INTERVAL_MS = 30_000;
const SCHEDULER_DISPATCH_RETRY_INTERVAL_MS = 30_000;
const SCHEDULER_DISPATCH_RETRY_MAX_DISPATCHES = 5;
let dataRootLock: DataRootLock | null = null;
let schedulerDispatchRetry: SchedulerDispatchRetryService | null = null;
let schedulerAttemptMaintenance: SchedulerAttemptMaintenanceService | null = null;
let recurringSchedules: RecurringScheduleService | null = null;
let releaseIdentity: ReturnType<typeof readReleaseIdentity> | undefined;
let runtimeConfigSnapshot: RuntimeConfigSnapshot | undefined;
let mode: ReturnType<typeof resolveMode> | undefined;
let bindHost: string | undefined;
let bindPort: number | undefined;
let appTlsListen: NativeTlsListenOptions | null | undefined;
let nanoHostListener: NanoHostTransportListener | null | undefined;
let nanoHostTlsListen: NativeTlsListenOptions | null | undefined;
let coreDb: CoreDb | undefined;
let freshCoreInitialization = false;
let vaultUnlockState: VaultUnlockState | undefined;
let bootWorkerControlGateway: ReturnType<typeof createDefaultWorkerControlGateway> | undefined;
let workerLifecycleRuntime: ConfiguredWorkerLifecycleRuntime | undefined;
let runRecoveryMaintenance: SchedulerAttemptMaintenanceInput['runRecoveryMaintenance'] | undefined;
let sharedStore: FsStore | undefined;
const restartCloseoutPackageSnapshots = new Set<string>();
const nanohostTransportSessionAuthority = createNanoHostTransportSessionAuthority();
const workspaceMutationAdmission = new WorkspaceMutationAdmission();
// Recovery can stage files before the live configuration manager is assembled.
let readFileReserveBytes = () =>
  runtimeConfigSnapshot?.openKitConfig.server?.fileReserveBytes ?? 1_000_000_000;
const fileAdmission = new FileStorageAdmission(dataRoot, () => BigInt(readFileReserveBytes()));
const nanoHostSessionDispatch = createNanoHostSessionDispatch({
  fileAdmission,
  get coreDb() {
    return coreDb;
  },
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
        try {
          releaseIdentity = readReleaseIdentity();
        } catch (error) {
          if (!(error instanceof BootConfigError)) throw error;
          return {
            status: 'failed' as const,
            reason: {
              code: error.code,
              message: error.message,
              blocks: ['product_work'],
            },
          };
        }
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

        const unknownContext = unknownModelContextFailure(runtimeConfigSnapshot);
        if (unknownContext) {
          return { status: 'failed', reason: unknownContext };
        }

        return { status: 'ok' };
      },
    },
    {
      name: 'data-root-layout',
      subsystem: 'storage',
      critical: true,
      run: () => {
        freshCoreInitialization = isFreshCoreInitializationScope(dataRoot);
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
        cleanupWorkspaceArchiveRequestStaging(dataRoot);
        return { status: 'ok' };
      },
    },
    {
      name: 'migrations',
      subsystem: 'storage',
      critical: true,
      run: () => {
        coreDb = openCoreDbWithIntegrityCheck(dataRoot, {
          freshInitialization: freshCoreInitialization,
        });
        applyMigrations(coreDb);
        verifyAndMigrateExistingScopedDatabases(dataRoot);
        const indexRebuildEvents = rebuildInvalidExistingWorkspaceDerivedIndexes(dataRoot);
        recordBootStartAudit({
          coreDb,
          layoutVersion: readDataRootLayoutMarker(dataRoot).layoutVersion,
          lockAcquisition: requireBootValue(dataRootLock, 'Data-root lock was not acquired.')
            .acquisition,
          migrationIds: listAppliedMigrationIds(coreDb),
          indexRebuildEvents,
        });

        if (indexRebuildEvents.length === 0) {
          return { status: 'ok' };
        }

        return {
          status: 'ok',
          reasons: [
            {
              code: 'storage.index-rebuilt',
              message: `Rebuilt ${indexRebuildEvents.length} workspace index set(s).`,
              blocks: [],
            },
          ],
        };
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
        restoreWorkspaceDeletionMutationAdmission({
          coreDb: recoveryCoreDb,
          dataRoot,
          workspaceMutationAdmission,
        });
        fenceNanoHostRuntimeTargetAfterRestart(recoveryCoreDb, new Date().toISOString());
        // Startup owns abandoned private staging before dispatch and upload admission open.
        // A later read-only Store construction must not remove another live request's bytes.
        discardAbandonedWorkspaceStaging(dataRoot);
        sharedStore ??= new FsStore({ dataRoot });
        const recoveryStore = sharedStore;
        bootWorkerControlGateway = createDefaultWorkerControlGateway(
          recoveryCoreDb,
          scheduleCommittedFinalStatusCloseout
        );
        workerLifecycleRuntime = createConfiguredWorkerLifecycleRuntime({
          fileAdmission,
          coreDb: recoveryCoreDb,
          // Defer snapshot reads until admission, after the shared manager is initialized below.
          readRuntimeConfig: () => runtimeConfigManager.current(),
          nanoHostSessionDispatch,
          store: recoveryStore,
          vaultBackend: () =>
            requireBootValue(vaultUnlockState, 'Vault unlock state was not initialized.').backend(),
          workerControlGateway: bootWorkerControlGateway,
          workspaceMutationAdmission,
        });
        const recoveryRuntime = workerLifecycleRuntime;
        const recoveryInput = {
          executionBackend: requireBootValue(
            recoveryRuntime.turnExecutor.executionBackend,
            'Execution backend was not initialized.'
          ),
          reconcileAcceptedFinalStatus: recoveryRuntime.reconcileAcceptedFinalStatus,
          store: recoveryStore,
          cleanupBackendSession: recoveryRuntime.cleanupBackendSession,
          isTurnExecutionActive: recoveryRuntime.isTurnExecutionActive,
          projectRecoveredTurn: async (subject) => {
            const admission = requireSchedulerExecutionAttemptAdmissionContext(
              recoveryCoreDb,
              subject.attemptId
            );
            const anchored = 'state' in subject;
            const result = terminalizeGovernedWorkerTurn({
              agentSessionId: subject.agentSessionId,
              completedAt: new Date().toISOString(),
              errorCode: 'worker_governance_restart_recovery',
              message: anchored
                ? 'Worker execution was interrupted during scheduler recovery.'
                : 'Worker execution stopped during scheduler recovery.',
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

            if ('id' in result && result.error?.code === 'worker_governance_restart_recovery') {
              const workspaceDb = openBootVerifiedWorkspaceDb(dataRoot, result.workspaceId);
              try {
                appendRecoveredTurnObservation(
                  workspaceDb,
                  result,
                  anchored ? 'anchored-cleanup' : 'pre-anchor'
                );
              } finally {
                workspaceDb.sqlite.close();
              }
            }
            return { status: result.status };
          },
          prepareBackendCleanup: recoveryRuntime.prepareBackendCleanup,
          restoreBackendSession: recoveryRuntime.restoreBackendSession,
        } satisfies RunNanoHostAttemptRecoveryInput;
        await runSchedulerRestartRecovery(recoveryCoreDb, recoveryInput);
        await classifyNanoHostAttemptsAfterRestart(recoveryCoreDb, recoveryInput);
        const checkpointRecoveryFailures =
          await classifyWorkerCheckpointsAfterSchedulerRecovery(recoveryCoreDb);
        const pendingWorkspace = {
          coreDb: recoveryCoreDb,
          agentAuthority: (record: import('./runtime/pending-requests.js').PendingRequestRecord) =>
            runtimeConfigSnapshot!.agentManifests.some(
              (manifest) => manifest.id === record.agentId
            ),
          openWorkspace: (workspaceId: string) =>
            openBootVerifiedWorkspaceDb(dataRoot, workspaceId),
        };
        installPendingRequestAdmission(recoveryStore, pendingWorkspace);
        recoverPendingRequestsAtBoot(recoveryStore, pendingWorkspace);
        runRecoveryMaintenance = {
          scheduler: () => runSchedulerRecoveryMaintenance(recoveryCoreDb, recoveryInput),
          native: () => runNanoHostAttemptRecoveryMaintenance(recoveryCoreDb, recoveryInput),
          checkpoints: () => classifyWorkerCheckpointsAfterSchedulerRecovery(recoveryCoreDb),
        };
        for (const row of recoveryCoreDb.sqlite
          .prepare(
            `SELECT input_ref AS packageSnapshotId
             FROM scheduler_execution_attempts
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

// Retrieval failure is contained in the supervised child; dependent requests fail explicitly.
try {
  await getRetrievalService(dataRoot, resolveDataRootPath(dataRoot, 'server')).start();
} catch {
  console.warn('Retrieval service is unavailable; dependent retrieval requests will fail.');
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

const providerSubscriptionAccountManager = new ProviderSubscriptionAccountManager({
  coreDb,
  vaultBackend: () => activeVaultUnlockState.backend(),
});
const providerCredentialConfigured = createProviderCredentialConfigured({
  coreDb,
  fallback: resolveEnvSecretRef,
});
const runtimeConfigManager = createRuntimeConfigManager({
  captureCoverage: requireBootValue(sharedStore, 'Shared Workspace store was not initialized.'),
  dataRoot,
  initialSnapshot: runtimeConfigSnapshot,
  subscriptionAccounts: providerSubscriptionAccountManager,
  providerCredentialConfigured,
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
const store = requireBootValue(sharedStore, 'Shared Workspace store was not initialized.');
const automationStore = new AutomationStore(coreDb, workspaceMutationAdmission);
const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
reconcileWorkerMcpItems(coreDb.dataRoot, store);

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

readFileReserveBytes = () =>
  runtimeConfigManager.current().openKitConfig.server?.fileReserveBytes ?? 1_000_000_000;
const app = createApp({
  automationStore,
  fileAdmission,
  ...(auth ? { auth } : {}),
  bootReadiness,
  coreDb,
  dataRoot,
  getBootReadiness: () => bootReadiness,
  mode,
  nanoHostSessionDispatch,
  nanohostTransportSessionAuthority,
  runtimeConfigManager,
  providerSubscriptionAccountManager,
  store,
  turnExecutor,
  vaultUnlockState: activeVaultUnlockState,
  workerLifecycleRuntime: activeWorkerLifecycleRuntime,
  workerControlGateway,
  workerMcpGateway,
  workerPlacement,
  releaseIdentity: requireBootValue(releaseIdentity, 'Release identity was not read.'),
  workspaceMutationAdmission,
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
    path.startsWith('/api/worker-capabilities/') ||
    path.startsWith('/worker-control/') ||
    path.startsWith('/inference/') ||
    path.startsWith('/capabilities/')
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

startTelemetry({ bootId });
const appServer = appTlsListen
  ? serve(
      {
        createServer: createHttpsServer,
        fetch: appFetch,
        hostname,
        port,
        serverOptions: { ...appTlsListen, ...NANOCORE_HTTP_SERVER_OPTIONS },
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
        serverOptions: NANOCORE_HTTP_SERVER_OPTIONS,
      },
      (info) => {
        console.log(`App server is running on http://${info.address}:${info.port}`);
      }
    );
// Native HTTP/2 sessions have no idle-close timer (timeout = 0), including TLS.
// Their long-lived h2 clients therefore need no HTTP/1 keep-alive margin options.
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
  providerCredentialConfigured,
  subscriptionAccounts: providerSubscriptionAccountManager,
  coreDb,
  dependencies: { providerCredentialResolver: schedulerProviderCredentialResolver },
  intervalMs: SCHEDULER_DISPATCH_RETRY_INTERVAL_MS,
  maxDispatches: SCHEDULER_DISPATCH_RETRY_MAX_DISPATCHES,
  runtimeConfigSnapshot: () => runtimeConfigManager.current(),
  store,
  turnExecutor,
  executionBackend: requireBootValue(
    turnExecutor.executionBackend,
    'Execution backend was not initialized.'
  ),
  onError: (error) => {
    console.warn(
      `Scheduler dispatch retry failed: ${error instanceof Error ? error.message : String(error)}`
    );
  },
});
recurringSchedules = startRecurringScheduleService({
  schedules: automationStore,
  store,
  prepare: (occurrence) =>
    prepareRecurringOccurrence({
      occurrence,
      snapshot: runtimeConfigManager.current(),
      store,
      backendId: turnExecutor.executionBackend?.id ?? null,
      providerCredentialConfigured,
      subscriptionAccounts: providerSubscriptionAccountManager,
    }),
  onError: () => console.warn('Recurring schedule maintenance requires inspection.'),
});
schedulerAttemptMaintenance = startSchedulerAttemptMaintenanceService({
  runRecoveryMaintenance: requireBootValue(
    runRecoveryMaintenance,
    'Scheduler recovery maintenance was not initialized.'
  ),
  intervalMs: SCHEDULER_ATTEMPT_MAINTENANCE_INTERVAL_MS,
});

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
        'SELECT attempt_id AS attemptId FROM scheduler_execution_attempts WHERE binding_ref = ?'
      )
      .get(input.sandboxBindingRef) as { readonly attemptId: string } | undefined;
    const session = lease ? getWorkerBackendSession(database, lease.attemptId) : null;
    if (!session) {
      throw new Error('Accepted worker final status has no durable backend session.');
    }
    const result = await runtime.reconcileAcceptedFinalStatus(session);
    markSchedulerAttemptForTerminalTurn(database, result.turn);
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
  recurringSchedules?.stop();
  schedulerDispatchRetry?.stop();
  schedulerAttemptMaintenance?.stop();
  const stepsCompleted = [
    'scheduler.recurring-schedules.stop',
    'scheduler.dispatch-retry.stop',
    'scheduler.attempt-maintenance.stop',
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
  void shutdownTelemetry().catch(() => undefined);
  void Promise.all([workerMcpGateway.close(), closeRetrievalServices()])
    .catch(() => undefined)
    .then(() => {
      let remaining = nanoHostServer ? 2 : 1;
      const markClosed = () => {
        remaining -= 1;
        if (remaining === 0) {
          onClosed();
        }
      };
      appServer.close(markClosed);
      nanoHostServer?.close(markClosed);
    });
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
