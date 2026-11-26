import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import {
  createServer as createHttp2Server,
  createSecureServer as createSecureHttp2Server,
} from 'node:http2';
import { createServer as createHttpsServer } from 'node:https';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { workspaceIdForOwner } from '@openkit/protocol';
import { ensureCanonicalDirectory } from '@openkit/storage';
import {
  createApp,
  createDefaultVaultUnlockState,
  createDefaultWorkerControlGateway,
  prepareCommunicationOwner,
  prepareNanoHostOwner,
  prepareServerWorkOwner,
  readNanoHostRestartCensus,
  restoreWorkspaceDeletionMutationAdmission,
  settlePreparedNanoHostImage,
} from './app.js';
import { createBetterAuth, resolveBetterAuthSecret } from './auth/better-auth.js';
import { ensureServerBootstrapTokenForStartup } from './auth/bootstrap-ensure.js';
import { writeServerBootstrapTokenEmission } from './auth/bootstrap-token.js';
import { ensureLocalUser, getLocalUserId } from './auth/identity.js';
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
import { acquireDataRootLock, type DataRootLock, dataRootLockPath } from './bootstrap/lock.js';
import { bindBootNanoHostAttemptRecovery } from './bootstrap/nanohost-recovery.js';
import { formatBootFailureMessage, runBootPhases } from './bootstrap/phases.js';
import { loadBootPolicyKernel } from './bootstrap/policy.js';
import {
  computeBootReadinessSnapshot,
  computeCurrentReadiness,
  createBootId,
  createShutdownReadinessSnapshot,
  refuseScope,
  withScopeAdmissionReadiness,
} from './bootstrap/readiness.js';
import { closeWithDeadline, forceShutdownAtDeadline } from './bootstrap/shutdown.js';
import { checkBootVaultBackend } from './bootstrap/vault.js';
import {
  restoreWorkspaceRecoveryAdmission,
  restoreWorkspaceRetirementAdmission,
} from './bootstrap/workspace-recovery.js';
import { resolveBindHost, resolveBindPort } from './config/bind-host.js';
import { resolveDataRoot } from './config/data-root.js';
import { BootConfigError, resolveMode } from './config/mode.js';
import {
  createRuntimeConfigManager,
  loadRuntimeConfig,
  type RuntimeConfigSnapshot,
} from './config/runtime-config.js';
import { readReleaseIdentity } from './diagnostics/release-identity.js';
import { NANOCORE_HTTP_SERVER_OPTIONS } from './http-server-options.js';
import { NotebookError } from './knowledge/notebook-error.js';
import {
  admitServerKnowledgeBoot,
  recoverServerKnowledgeManagerTurns,
} from './knowledge/server-knowledge-maintenance.js';
import { AutomationStore } from './lib/automation-store.js';
import { FsStore } from './lib/store.js';
import { resolveLogicalModelCatalog } from './llm/logical-models.js';
import { ProviderSubscriptionAccountManager } from './llm/provider-subscription-accounts.js';
import { closeActiveLocalAiSupervisor } from './local-ai/supervisor.js';
import {
  classifyDirectTaskCheckpointAfterSchedulerRecovery,
  recoverWorkspaceAssistantTurns,
} from './mode-entry-routes.js';
import { createListenerFetches } from './nanohost-listener.js';
import {
  createNativeTlsReloadCheck,
  loadNativeTlsMaterial,
  type NativeTlsListenOptions,
  readNativeTlsSource,
} from './native-listener-tls.js';
import { recordBootPolicySelfCheckDecisions } from './policy/permission-decisions.js';
import { resolveEnvSecretRef } from './providers/registry.js';
import {
  createProviderCredentialConfigured,
  createVaultProviderCredentialResolver,
} from './providers/vault-credential-resolver.js';
import { closeRetrievalServices, getRetrievalService } from './retrieval-service.js';
import {
  classifyNanoHostAttemptsAfterRestart,
  type RunNanoHostAttemptRecoveryInput,
  runNanoHostAttemptRecoveryMaintenance,
} from './runtime/nanohost-attempt-recovery.js';
import { createProductionNanoHostSessionDispatch } from './runtime/nanohost-session-dispatch.js';
import { recoverPendingRequestsAtBoot } from './runtime/pending-request-flow.js';
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
  schedulerRestartRecoveryOutcome,
} from './runtime/scheduler-restart-recovery.js';
import {
  type ConfiguredWorkerLifecycleRuntime,
  createConfiguredWorkerLifecycleRuntime,
} from './runtime/turn-executor-factory.js';
import { listExportableWorkerCheckpoints } from './runtime/worker-checkpoints.js';
import type { WorkerControlFinalStatusAcceptedHook } from './runtime/worker-control-gateway.js';
import { createDefaultWorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import { terminalizeGovernedWorkerTurn } from './runtime/worker-turn-failure.js';
import { requireSchedulerExecutionAttemptAdmissionContext } from './scheduler-records.js';
import { drainSecurityNotices } from './security/publication.js';
import { SecurityTriggerStore } from './security/trigger.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { communicationOwner } from './storage/communication-owner.js';
import type { ControlStoreProductReadHandle } from './storage/control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './storage/control-store-worker-client.js';
import {
  admitDataRootForBoot,
  type CoreDb,
  listExistingWorkspaceDatabaseScopes,
  openAdmittedWorkspaceReadDb,
  openCoreDbWithIntegrityCheck,
  openCoreReadDb,
  verifyExistingCoreBaseline,
} from './storage/db.js';
import { DEFAULT_FILE_RESERVE_BYTES } from './storage/file-reserve.js';
import {
  ensureConfigTemplateSurface,
  ensureLayout,
  readDataRootLayoutMarker,
  resolveDataRootPath,
  workspaceDbPath,
} from './storage/fs-layout.js';
import { rebuildInvalidExistingWorkspaceDerivedIndexes } from './storage/index-rebuild.js';
import { applyMigrations, listAppliedMigrationIds } from './storage/migrate.js';
import { nanoHostStoreDescriptor } from './storage/nanohost-store-descriptor.js';
import { transitionAdmittedNanoHostRuntimeTarget } from './storage/nanohost-transport-owner.js';
import { openServerWorkProductReadHandle } from './storage/server-work-product-reads.js';
import { serverWorkStorageDescriptor } from './storage/server-work-schema.js';
import { appendRecoveredTurnObservation } from './storage/work-observation-recovery.js';
import {
  runWorkspaceSnapshotMaintenance,
  WORKSPACE_BACKUP_POLICY,
} from './storage/workspace-backup.js';
import { discardAbandonedWorkspaceStaging } from './storage/workspace-file-records.js';
import { verifyAndMigrateExistingScopedDatabases } from './storage/workspace-storage-migration.js';
import { shutdownTelemetry, startTelemetry } from './telemetry.js';
import { closeRevokedCredentialBindings } from './vault/vault-operation-implementations.js';
import type { VaultUnlockState } from './vault/vault-unlock-state.js';
import { reconcileWorkerMcpItems } from './worker-mcp-routes.js';
import { ensureUserQuickChatWorkspace } from './workspace-membership.js';

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
let appServer: ReturnType<typeof serve> | undefined;
let nanoHostServer: ReturnType<typeof serve> | null = null;
let workerMcpGateway: ReturnType<typeof createDefaultWorkerMcpGateway> | undefined;
let codexResetMaintenance: ReturnType<typeof setInterval> | undefined;
const processShutdownAbort = new AbortController();
let shutdownCompletion: Promise<void> | undefined;
let bootReadiness = computeBootReadinessSnapshot({ bootId });
let releaseIdentity: ReturnType<typeof readReleaseIdentity> | undefined;
let runtimeConfigSnapshot: RuntimeConfigSnapshot | undefined;
let mode: ReturnType<typeof resolveMode> | undefined;
let bindHost: string | undefined;
let bindPort: number | undefined;
let appTlsListen: NativeTlsListenOptions | null | undefined;
let checkListenerTlsChange: (() => Promise<boolean>) | undefined;
let nanoHostListener: NanoHostTransportListener | null | undefined;
let nanoHostTlsListen: NativeTlsListenOptions | null | undefined;
let coreDb: CoreDb | undefined;
// Audit may use the existing native lifetime only after Core migrations succeed.
let coreMigrationsComplete = false;
let communicationBinding: Awaited<ReturnType<typeof prepareCommunicationOwner>> = {
  state: 'unavailable',
  owner: 'communication',
  reason: 'missing',
};
let nanoHostStorage: Awaited<ReturnType<typeof prepareNanoHostOwner>> = {
  state: 'unavailable',
  owner: 'nanohost',
  reason: 'missing',
};
let freshCoreInitialization = false;
let vaultUnlockState: VaultUnlockState | undefined;
let bootWorkerControlGateway: ReturnType<typeof createDefaultWorkerControlGateway> | undefined;
let workerLifecycleRuntime: ConfiguredWorkerLifecycleRuntime | undefined;
let runRecoveryMaintenance: SchedulerAttemptMaintenanceInput['runRecoveryMaintenance'] | undefined;
let sharedStore: FsStore | undefined;
let serverWorkReader: ControlStoreProductReadHandle | undefined;
const nanohostTransportSessionAuthority = createNanoHostTransportSessionAuthority();
// Recovery can stage files before the live configuration manager is assembled.
let readFileReserveBytes = () =>
  runtimeConfigSnapshot?.openKitConfig.server?.fileReserveBytes ?? DEFAULT_FILE_RESERVE_BYTES;
const fileAdmission = new FileStorageAdmission(dataRoot, () => BigInt(readFileReserveBytes()));
getControlStoreWorkerClient().setFileStorageAdmission(dataRoot, fileAdmission);
const nanoHostSessionDispatch = createProductionNanoHostSessionDispatch({
  fileAdmission,
  get coreDb() {
    return coreDb;
  },
  get nativeStorage() {
    return nanoHostStorage;
  },
  settlePreparedImage: (input) => settlePreparedNanoHostImage(coreDb, nanoHostStorage, input),
  sessionAuthority: nanohostTransportSessionAuthority,
});

process.once('exit', releaseProcessResources);
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

const bootResult = await runBootPhases({
  bootId,
  signal: processShutdownAbort.signal,
  phases: [
    {
      name: 'data-root-admission',
      subsystem: 'storage',
      critical: true,
      run: async () => {
        try {
          freshCoreInitialization = await admitDataRootForBoot(dataRoot);
        } catch (error) {
          return {
            status: 'failed',
            reason: {
              code: 'data_root_admission_failed',
              message: error instanceof Error ? error.message : String(error),
              blocks: ['product_work'],
            },
          };
        }
        return { status: 'ok' };
      },
    },
    {
      name: 'config',
      subsystem: 'config',
      critical: true,
      run: async () => {
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
        runtimeConfigSnapshot = loadRuntimeConfig(dataRoot, {
          quarantineMalformedWorkspaceConfig: true,
          version: 1,
        });
        mode = resolveMode(process.env, runtimeConfigSnapshot.openKitConfig);
        bindPort = resolveBindPort(process.env, runtimeConfigSnapshot.openKitConfig);
        resolveBetterAuthSecret(process.env, mode);
        ensureConfigTemplateSurface(dataRoot);
        runtimeConfigSnapshot = loadRuntimeConfig(dataRoot, {
          quarantineMalformedWorkspaceConfig: true,
          version: 1,
        });
        bindHost = resolveBindHost(process.env, mode, runtimeConfigSnapshot.openKitConfig);
        bindPort = resolveBindPort(process.env, runtimeConfigSnapshot.openKitConfig);
        nanoHostListener = resolveNanoHostTransportListener(
          runtimeConfigSnapshot.openKitConfig.nanohost,
          bindPort
        );
        const appUsesTls = bindRequiresServerAuthenticatedTls(bindHost);
        if (appUsesTls || nanoHostListener?.secure) {
          const source = readNativeTlsSource(process.env);
          const { listenOptions, publicGeneration } = await loadNativeTlsMaterial(source);
          appTlsListen = appUsesTls ? listenOptions : null;
          nanoHostTlsListen = nanoHostListener?.secure ? listenOptions : null;
          checkListenerTlsChange = createNativeTlsReloadCheck(source, publicGeneration);
        } else {
          appTlsListen = null;
          nanoHostTlsListen = null;
        }

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
        if (freshCoreInitialization) {
          ensureLayout(dataRoot);
        } else {
          // Stopped restore can omit an empty runtime directory. Core has already been
          // checked without creating files and will be checked again under the lock.
          const runtimePath = dirname(dataRootLockPath(dataRoot));
          ensureCanonicalDirectory(runtimePath, 0o777, 'retry-creation');
        }
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
      run: async () => {
        if (!freshCoreInitialization) await verifyExistingCoreBaseline(dataRoot);
        coreDb = openCoreDbWithIntegrityCheck(dataRoot, {
          freshInitialization: freshCoreInitialization,
        });
        applyMigrations(coreDb);
        coreMigrationsComplete = true;
        restoreWorkspaceRetirementAdmission({ coreDb });
        restoreWorkspaceRecoveryAdmission(coreDb);
        // Only active server registry facts establish an expected Workspace; deletion may remove roots.
        for (const { workspaceId } of coreDb.sqlite
          .prepare(
            "SELECT workspace_id AS workspaceId FROM workspace_registry WHERE status = 'active'"
          )
          .all() as Array<{ workspaceId: string }>) {
          if (!existsSync(workspaceDbPath(dataRoot, workspaceId))) {
            refuseScope(dataRoot, { scope: 'workspace', id: workspaceId, check: 'database' });
          }
        }
        try {
          admitServerKnowledgeBoot(coreDb);
        } catch (error) {
          if (!(error instanceof NotebookError)) throw error;
          return {
            status: 'failed',
            reason: {
              code: 'knowledge.server_recovery_required',
              message:
                'Server Knowledge authority failed closed; check=integrity; stage=migrations.',
              blocks: ['product_work'],
            },
          };
        }
        const writer = getControlStoreWorkerClient();
        const serverWorkOpen = freshCoreInitialization
          ? await writer.provisionServerOwner(dataRoot, serverWorkStorageDescriptor)
          : await writer.openServerOwner(dataRoot, serverWorkStorageDescriptor);
        const serverWorkRead =
          serverWorkOpen.state === 'ready'
            ? await openServerWorkProductReadHandle(dataRoot, writer)
            : serverWorkOpen;
        if (serverWorkRead.state === 'ready') serverWorkReader = serverWorkRead.value;
        await verifyAndMigrateExistingScopedDatabases(dataRoot, () => {
          // File validation cannot query projections that still need their scoped migrations.
          FsStore.validateFileAuthority(dataRoot, serverWorkReader);
        });
        const indexRebuildEvents = rebuildInvalidExistingWorkspaceDerivedIndexes(dataRoot);
        await recordBootStartAudit({
          coreDb,
          layoutVersion: readDataRootLayoutMarker(dataRoot).layoutVersion,
          lockAcquisition: requireBootValue(dataRootLock, 'Data-root lock was not acquired.')
            .acquisition,
          migrationIds: listAppliedMigrationIds(coreDb),
          indexRebuildEvents,
        });
        const serverWorkBinding =
          serverWorkRead.state === 'ready'
            ? await prepareServerWorkOwner(coreDb, () => runtimeConfigManager.current())
            : serverWorkRead;
        sharedStore ??= new FsStore({
          dataRoot,
          ...(serverWorkReader && { serverWorkReader }),
          ...(serverWorkBinding.state === 'ready' && { serverWork: serverWorkBinding.value }),
        });

        const reasons = [];
        if (indexRebuildEvents.length !== 0)
          reasons.push({
            code: 'storage.index-rebuilt',
            message: `Rebuilt ${indexRebuildEvents.length} workspace index set(s).`,
            blocks: [],
          });
        if (serverWorkBinding.state === 'unavailable')
          reasons.push({
            code: 'storage.server_work_unavailable',
            message: `Server work storage is unavailable: ${serverWorkBinding.reason}.`,
            blocks: [],
          });
        return { status: 'ok', reasons };
      },
    },
    {
      name: 'policy-kernel',
      subsystem: 'policy',
      critical: true,
      run: async () => {
        const kernel = loadBootPolicyKernel();
        await recordBootPolicySelfCheckDecisions({
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
      run: async () => {
        if (mode === 'local') {
          await ensureLocalUser(requireBootValue(coreDb, 'Core database was not initialized.'));
        }

        return { status: 'ok' };
      },
    },
    {
      name: 'communication-admission',
      subsystem: 'storage',
      critical: false,
      run: async () => {
        const db = requireBootValue(coreDb, 'Core database was not initialized.');
        const writer = getControlStoreWorkerClient();
        const kernel = writer.communicationKernel(db);
        const provisioned =
          freshCoreInitialization && kernel.status().state === 'ready'
            ? await writer.provisionServerOwner(dataRoot, communicationOwner)
            : undefined;
        communicationBinding =
          provisioned?.state === 'unavailable'
            ? provisioned
            : await prepareCommunicationOwner({
                coreDb: db,
                mode: requireBootValue(mode, 'Core mode was not resolved.'),
                kernel,
              });
        if (communicationBinding.state === 'ready') return { status: 'ok' };
        return {
          status: 'degraded',
          reason: {
            code: 'storage.communication_unavailable',
            message: 'Communication storage is unavailable.',
            blocks: [],
          },
        };
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
        });
        // Startup fences the exact admitted RuntimeTarget before any native transport starts.
        const writer = getControlStoreWorkerClient();
        const provisioned = freshCoreInitialization
          ? await writer.provisionServerOwner(dataRoot, nanoHostStoreDescriptor)
          : undefined;
        nanoHostStorage =
          provisioned?.state === 'unavailable'
            ? provisioned
            : await prepareNanoHostOwner(recoveryCoreDb, { enabled: () => true });
        if (nanoHostStorage.state === 'ready') {
          const restart = await transitionAdmittedNanoHostRuntimeTarget(nanoHostStorage.value, {
            kind: 'restart',
            observedAt: new Date().toISOString(),
          });
          if (restart.state === 'unavailable') nanoHostStorage = { ...restart, owner: 'nanohost' };
        }
        // Startup owns abandoned private staging before dispatch and upload admission open.
        // A later read-only Store construction must not remove another live request's bytes.
        discardAbandonedWorkspaceStaging(dataRoot);
        sharedStore ??= new FsStore({ dataRoot });
        await recoverServerKnowledgeManagerTurns(sharedStore);
        await recoverWorkspaceAssistantTurns(sharedStore);
        const recoveryStore = sharedStore;
        let wakeRestartCloseout: WorkerControlFinalStatusAcceptedHook | undefined;
        bootWorkerControlGateway = createDefaultWorkerControlGateway(
          recoveryCoreDb,
          (accepted) => wakeRestartCloseout?.(accepted),
          nanoHostStorage
        );
        workerLifecycleRuntime = createConfiguredWorkerLifecycleRuntime({
          fileAdmission,
          coreDb: recoveryCoreDb,
          // Defer snapshot reads until admission, after the shared manager is initialized below.
          readRuntimeConfig: () => runtimeConfigManager.current(),
          nanoHostSessionDispatch,
          nanoHostRecovery: {
            owner:
              nanoHostStorage.state === 'ready'
                ? { state: 'ready', value: nanoHostStorage.value.owner }
                : nanoHostStorage,
            ...(nanoHostStorage.state === 'ready'
              ? {
                  admitSubmission: nanoHostStorage.value.owner.firstSubmission,
                  harnessTurnLifecycle: nanoHostStorage.value.owner.harnessTurnLifecycle,
                  idleSandbox: {
                    writeIdleHarnessDrain: nanoHostStorage.value.owner.writeIdleHarnessDrain,
                    releaseStorage: nanoHostStorage.value.owner.releaseIdleSandboxStorage,
                  },
                  readWorkerCompletion: nanoHostStorage.value.owner.readWorkerCompletion,
                  releaseTerminalScopes: nanoHostStorage.value.owner.releaseTerminalScopes,
                  writeStorageAttachment: nanoHostStorage.value.owner.writeStorageAttachment,
                  commitCloseout: nanoHostStorage.value.owner.classifyRecovery,
                }
              : {}),
          },
          releaseIdentity: requireBootValue(releaseIdentity, 'Release identity was not read.'),
          store: recoveryStore,
          vaultBackend: () =>
            requireBootValue(vaultUnlockState, 'Vault unlock state was not initialized.').backend(),
          workerControlGateway: bootWorkerControlGateway,
        });
        const recoveryRuntime = workerLifecycleRuntime;
        const admittedNanoHostRecovery =
          nanoHostStorage.state === 'ready'
            ? {
                state: 'ready' as const,
                value: bindBootNanoHostAttemptRecovery(nanoHostStorage.value.owner, {
                  coreDb: recoveryCoreDb,
                  reconcileAcceptedFinalStatus: recoveryRuntime.reconcileAcceptedFinalStatus,
                }),
              }
            : nanoHostStorage;
        const recoveryInput = {
          executionBackend: requireBootValue(
            recoveryRuntime.turnExecutor.executionBackend,
            'Execution backend was not initialized.'
          ),
          store: recoveryStore,
          admittedNanoHostRecovery,
          reconcileExecutions: () => recoveryRuntime.executionReconciler.runOnce(),
          cleanupBackendSession: recoveryRuntime.cleanupBackendSession,
          prepareBackendCleanup: recoveryRuntime.prepareBackendCleanup,
          restoreBackendSession: recoveryRuntime.restoreBackendSession,
          isTurnExecutionActive: recoveryRuntime.isTurnExecutionActive,
          projectRecoveredTurn: async (subject) => {
            const admission = requireSchedulerExecutionAttemptAdmissionContext(
              recoveryCoreDb,
              subject.attemptId
            );
            const anchored = 'state' in subject;
            const result = await terminalizeGovernedWorkerTurn({
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
              const workspaceDb = openAdmittedWorkspaceReadDb(
                dataRoot,
                workspaceIdForOwner(result.owner)
              );
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
        } satisfies RunNanoHostAttemptRecoveryInput;
        const schedulerRecovery = await runSchedulerRestartRecovery(recoveryCoreDb, recoveryInput);
        const nativeRecovery = await classifyNanoHostAttemptsAfterRestart(
          recoveryCoreDb,
          recoveryInput
        );
        const reconnects = readNanoHostRestartCensus(recoveryCoreDb, nanoHostStorage);
        if (reconnects.state === 'ready') {
          const pending = new Map(reconnects.value.map(({ grant }) => [grant.inputRef, grant]));
          wakeRestartCloseout = ({ lineage, sandboxBindingRef }) => {
            const grant = pending.get(lineage.packageSnapshotId);
            if (!grant || grant.bindingRef !== sandboxBindingRef || grant.turnId !== lineage.turnId)
              return;
            pending.delete(lineage.packageSnapshotId);
            void runNanoHostAttemptRecoveryMaintenance(recoveryCoreDb, recoveryInput).catch(() => {
              pending.set(lineage.packageSnapshotId, grant);
              console.warn('Worker final-status closeout requires recovery.');
            });
          };
        } else if (reconnects.reason === 'recovery-required') {
          console.warn('NanoHost reconnect census requires the admitted attempt evidence.');
        }
        const checkpointRecoveryFailures =
          await classifyWorkerCheckpointsAfterSchedulerRecovery(recoveryCoreDb);
        const pendingWorkspace = {
          coreDb: recoveryCoreDb,
          agentWorkPaused: () =>
            runtimeConfigSnapshot!.openKitConfig.security?.pauseAgentWork === true,
          agentAuthority: (record: import('./runtime/pending-requests.js').PendingRequestRecord) =>
            runtimeConfigSnapshot!.agentManifests.some(
              (manifest) => manifest.id === record.agentId
            ),
          openWorkspace: (workspaceId: string) =>
            openAdmittedWorkspaceReadDb(dataRoot, workspaceId),
        };
        recoveryStore.startPendingRequestDelivery(pendingWorkspace);
        await recoverPendingRequestsAtBoot(recoveryStore, pendingWorkspace);
        runRecoveryMaintenance = {
          scheduler: async () => {
            try {
              await new SecurityTriggerStore(recoveryCoreDb).advanceContainment(
                runtimeConfigManager,
                recoveryStore,
                turnExecutor
              );
            } finally {
              try {
                await drainSecurityNotices({ coreDb: recoveryCoreDb, store: recoveryStore });
              } finally {
                // Containment and notice failures must not consume ordinary recovery capacity.
                await runSchedulerRecoveryMaintenance(recoveryCoreDb, recoveryInput);
              }
            }
          },
          native: () => runNanoHostAttemptRecoveryMaintenance(recoveryCoreDb, recoveryInput),
          checkpoints: () => classifyWorkerCheckpointsAfterSchedulerRecovery(recoveryCoreDb),
        };
        return schedulerRestartRecoveryOutcome(
          [...schedulerRecovery.failedAttemptIds, ...nativeRecovery.failedAttemptIds],
          checkpointRecoveryFailures
        );
      },
    },
  ],
});
if (shutdownCompletion) await shutdownCompletion;
bootReadiness = bootResult.readiness;

if (coreDb && coreMigrationsComplete) {
  try {
    await recordBootAuditEvent({
      coreDb,
      result: {
        ...bootResult,
        readiness: withScopeAdmissionReadiness(bootResult.readiness, dataRoot),
      },
    });
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
  throw new Error(message);
}

// Retrieval failure is contained in the supervised child; dependent requests fail explicitly.
try {
  await getRetrievalService(dataRoot, resolveDataRootPath(dataRoot, 'server')).start();
} catch {
  console.warn('Retrieval service is unavailable; dependent retrieval requests will fail.');
}
if (shutdownCompletion) await shutdownCompletion;

runtimeConfigSnapshot = requireBootValue(runtimeConfigSnapshot, 'Runtime config was not loaded.');
mode = requireBootValue(mode, 'Core mode was not resolved.');
coreDb = requireBootValue(coreDb, 'Core database was not initialized.');
// Boot owns migration authority. Preserve the Core object captured by boot services,
// but release its writer before any serving adapter can retain a database view.
const servingCoreDb = openCoreReadDb(dataRoot);
try {
  coreDb.sqlite.close();
} catch (error) {
  servingCoreDb.sqlite.close();
  throw error;
}
Object.assign(coreDb, servingCoreDb);
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
  onReferenceRevoked: (referenceId) =>
    closeRevokedCredentialBindings(
      {
        coreDb: activeCoreDb,
        closeMcpCredentialGrants: async (grantIds) => {
          if (!workerMcpGateway?.closeCredentialGrants)
            throw new Error('MCP credential cleanup is unavailable.');
          await workerMcpGateway.closeCredentialGrants(grantIds);
        },
        store: requireBootValue(sharedStore, 'Shared Workspace store was not initialized.'),
        turnExecutor: requireBootValue(
          workerLifecycleRuntime,
          'Worker lifecycle runtime was not initialized.'
        ).turnExecutor,
      },
      { referenceId }
    ),
});
const providerCredentialConfigured = createProviderCredentialConfigured({
  coreDb,
  fallback: resolveEnvSecretRef,
});
const bootNanoHostIdentity = runtimeConfigSnapshot.openKitConfig.nanohost?.identityId;
const runtimeConfigManager = createRuntimeConfigManager({
  captureCoverage: requireBootValue(sharedStore, 'Shared Workspace store was not initialized.'),
  checkListenerTlsChange,
  dataRoot,
  initialSnapshot: runtimeConfigSnapshot,
  readNanoHostResidentTurnLimit: () =>
    bootNanoHostIdentity &&
    nanohostTransportSessionAuthority.authoritativeGeneration(bootNanoHostIdentity) !== null
      ? (workerLifecycleRuntime?.readNanoHostResidentTurnLimit() ?? null)
      : null,
  subscriptionAccounts: providerSubscriptionAccountManager,
  providerCredentialConfigured,
});
await runtimeConfigManager.bindNativePolicyPublication(activeCoreDb);
requireBootValue(
  sharedStore,
  'Shared Workspace store was not initialized.'
).setWorkspaceConfigurationPublisher(runtimeConfigManager.publishWorkspaceConfiguration);

if (mode === 'local') {
  // A quarantined Personal scope must not prevent the server or healthy siblings from booting.
  const userId = getLocalUserId(coreDb);
  await ensureUserQuickChatWorkspace({
    coreDb,
    store: requireBootValue(sharedStore, 'Shared Workspace store was not initialized.'),
    userId,
  });
  if (shutdownCompletion) await shutdownCompletion;
}
if (mode === 'server') {
  const bootstrap = await ensureServerBootstrapTokenForStartup(coreDb);
  if (bootstrap) {
    writeServerBootstrapTokenEmission(dataRoot, bootstrap);
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
const automationStore = new AutomationStore(coreDb);
workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
await reconcileWorkerMcpItems(coreDb.dataRoot, store);
if (shutdownCompletion) await shutdownCompletion;

/**
 * Ensures the personal Quick Chat Workspace before Better Auth records a new active session.
 *
 * @param userId Active canonical user starting the session.
 */
async function onActiveUserSession(userId: string): Promise<void> {
  await ensureUserQuickChatWorkspace({ coreDb: activeCoreDb, store, userId });
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
  runtimeConfigManager.current().openKitConfig.server?.fileReserveBytes ??
  DEFAULT_FILE_RESERVE_BYTES;
let prepareKnowledgeMaintenance: ((instant: string) => Promise<void>) | undefined;
const app = createApp({
  communicationStorage: { binding: communicationBinding },
  onKnowledgeMaintenanceReady: (prepare) => {
    prepareKnowledgeMaintenance = prepare;
  },
  automationStore,
  fileAdmission,
  ...(auth ? { auth } : {}),
  bootReadiness: withScopeAdmissionReadiness(bootReadiness, dataRoot),
  coreDb,
  dataRoot,
  getBootReadiness: () => {
    const snapshot = runtimeConfigManager.current();
    let llmGatewayAvailable = false;
    try {
      const models = resolveLogicalModelCatalog(
        snapshot.gatewayConfig,
        snapshot.providerRegistry,
        providerSubscriptionAccountManager,
        providerCredentialConfigured
      );
      llmGatewayAvailable =
        snapshot.gatewayConfig.enabled &&
        models.length > 0 &&
        models.every(
          (model) =>
            model.routes.length > 0 &&
            model.routes.every(
              (route) =>
                route.available &&
                snapshot.providerRegistry.get(route.providerProfileId)?.readiness?.status !==
                  'degraded'
            )
        );
    } catch {
      // Invalid supply is unavailable; public readiness never exposes parser or credential text.
    }
    return computeCurrentReadiness({
      snapshot: bootReadiness,
      vaultHealth: activeVaultUnlockState.backend().health().state,
      llmGatewayAvailable,
      dataRoot,
    });
  },
  mode,
  nanoHostSessionDispatch,
  nanoHostStorage,
  enableNanoHostEnrollment: true,
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
const { appFetch, nanoHostFetch } = createListenerFetches(app.fetch);

startTelemetry({
  bootId,
  logDirectory: resolveDataRootPath(dataRoot, 'server', 'logs'),
  readReserveBytes: () => readFileReserveBytes(),
  serviceVersion: releaseIdentity?.releaseTag ?? releaseIdentity?.sourceCommit ?? undefined,
  deploymentEnvironment: mode,
});
appServer = appTlsListen
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
nanoHostServer = nanoHostListener
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
  agentWorkPaused: () =>
    runtimeConfigManager.current().openKitConfig.security?.pauseAgentWork === true,
  prepareKnowledgeMaintenance: (instant) => prepareKnowledgeMaintenance?.(instant),
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
  runRecoveryMaintenance: {
    ...requireBootValue(
      runRecoveryMaintenance,
      'Scheduler recovery maintenance was not initialized.'
    ),
    snapshots: async () => {
      const release = releaseIdentity;
      // Unknown source identity cannot produce a verifiable generation.
      if (!release?.sourceCommit) return;
      const stagingParent = join(dataRoot, 'server/backups');
      ensureCanonicalDirectory(stagingParent);
      await runWorkspaceSnapshotMaintenance({
        ...WORKSPACE_BACKUP_POLICY,
        source: {
          kind: 'live-workspace',
          dataRoot,
          coreDb: activeCoreDb,
          store,
          // Refuse accepted work at its existing checkpoints, then join its owned cleanup.
          currentAuthority: () => processShutdownAbort.signal.throwIfAborted(),
        },
        admission: fileAdmission,
        stagingParent,
        expectedSourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
        expectedRelease: {
          version: release.releaseTag ?? 'source',
          buildId: release.sourceCommit,
        },
      });
    },
  },
  intervalMs: SCHEDULER_ATTEMPT_MAINTENANCE_INTERVAL_MS,
});

/** The account owner joins overlapping enabled-account passes; the process owns timer cancellation. */
codexResetMaintenance = setInterval(() => {
  void providerSubscriptionAccountManager
    .checkExpiringCodexResets(processShutdownAbort.signal)
    .catch(() => console.warn('Codex reset maintenance requires inspection.'));
}, 5 * 60_000);
codexResetMaintenance.unref();

/**
 * Releases process-local resources during an orderly shutdown.
 *
 * @param signal Signal that requested shutdown.
 */
function shutdown(signal: NodeJS.Signals): void {
  if (shutdownCompletion) return;
  console.log(`Received ${signal}; shutting down NanoCore.`);
  bootReadiness = createShutdownReadinessSnapshot(bootReadiness);
  clearInterval(codexResetMaintenance);
  processShutdownAbort.abort();
  recurringSchedules?.stop();
  schedulerDispatchRetry?.stop();
  const maintenanceStopped = schedulerAttemptMaintenance?.stop();
  const executionsStopped = workerLifecycleRuntime?.executionReconciler.stop();
  const stepsCompleted = [
    'scheduler.recurring-schedules.stop',
    'scheduler.dispatch-retry.stop',
    'scheduler.attempt-maintenance.stop',
  ];
  let listenerCloseFailed = false;
  shutdownCompletion = closeWithDeadline({
    close: (onClosed) => {
      // The phase harness evaluates this function without the module binding.
      const localAiClosed =
        typeof closeActiveLocalAiSupervisor === 'function'
          ? closeActiveLocalAiSupervisor()
          : Promise.resolve();
      void Promise.resolve(localAiClosed)
        .catch((error) => {
          console.error('Local AI shutdown failed.', error);
        })
        .then(() => Promise.allSettled([maintenanceStopped, executionsStopped]))
        .then((results) => {
          for (const result of results)
            if (result.status === 'rejected')
              console.error('Execution maintenance shutdown failed.', result.reason);
          return closeNanoCoreListeners();
        })
        .catch((error) => {
          listenerCloseFailed = true;
          console.error('Owned listener shutdown failed.', error);
        })
        .then(async () => {
          vaultUnlockState?.lock();
          await recordShutdownAudit(
            signal,
            [
              ...stepsCompleted,
              listenerCloseFailed ? 'shutdown.failed' : 'http-server.close',
              'vault.lock',
            ],
            false
          );
          // The shutdown Audit has its FULL ACK. Release Main's reader before the
          // native owner's final drain and checkpoint so normal close leaves no sidecars.
          if (!closeProcessCoreDatabase()) throw new Error('Core reader shutdown failed.');
          await shutdownControlStoreWorkerClient();
        })
        .then(() => {
          if (listenerCloseFailed) {
            finishShutdown();
          } else {
            dataRootLock?.release();
            onClosed();
          }
        })
        .catch((error) => {
          console.error('Owned storage/listener shutdown failed.', error);
          finishShutdown();
        });
    },
    deadlineMs: SHUTDOWN_DEADLINE_MS,
    onClosed: () => finishShutdown(0),
    onDeadline: () => forceShutdownAtDeadline(signal, stepsCompleted.length),
  });
}

/** Closes both process listeners before completing orderly shutdown. */
async function closeNanoCoreListeners(): Promise<void> {
  void shutdownTelemetry().catch(() => undefined);
  await Promise.all([workerMcpGateway?.close(), closeRetrievalServices()]);
  // Stop accepting connections first; drain both earlier and in-flight bound closes before the writer.
  const listenersClosed = Promise.allSettled(
    [appServer, nanoHostServer]
      .filter((server) => server != null)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error?: Error) => {
              if (error) reject(error);
              else resolve();
            })
          )
      )
  );
  await nanohostTransportSessionAuthority.closeAllPhysicalConnections();
  const closed = await listenersClosed;
  // A connection admitted while listener closure was in flight is still in the existing authority.
  await nanohostTransportSessionAuthority.closeAllPhysicalConnections();
  const failures = closed.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'NanoCore listener close failed.'
    );
}

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
    let workspaceDb: ReturnType<typeof openAdmittedWorkspaceReadDb> | null = null;
    try {
      workspaceDb = openAdmittedWorkspaceReadDb(dataRoot, workspaceId);
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

/** Finishes shutdown through one terminal path. */
function finishShutdown(exitCode = 1): void {
  vaultUnlockState?.lock();
  // The acknowledged Audit covers completed steps; terminal database close cannot audit itself.
  const finalExitCode = closeProcessCoreDatabase() ? exitCode : 1;
  // On incomplete shutdown only process termination may release the flock.
  process.exit(finalExitCode);
}

/** Locks secret state and closes the serving reader; an undrained writer owns the flock until exit. */
function releaseProcessResources(): void {
  vaultUnlockState?.lock();
  if (!closeProcessCoreDatabase()) process.exitCode = 1;
}

/** Closes the process-owned readers before the corresponding native writers drain. */
function closeProcessCoreDatabase(): boolean {
  const readers = [
    ['Server work', serverWorkReader?.sqlite],
    ['Core', coreDb?.sqlite],
  ] as const;
  // Detach ownership before close so the exit handler cannot repeat a failed close.
  serverWorkReader = undefined;
  coreDb = undefined;
  let closed = true;
  for (const [name, sqlite] of readers) {
    if (!sqlite?.open) continue;
    try {
      sqlite.close();
    } catch (error) {
      console.error(
        `Failed to close ${name} database during shutdown: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      closed = false;
    }
  }
  return closed;
}

/**
 * Records best-effort orderly shutdown audit evidence.
 *
 * @param signal Signal that requested shutdown.
 * @param stepsCompleted Ordered shutdown steps completed before lock release.
 * @param deadlineForcedExit Whether the shutdown deadline forced exit.
 */
async function recordShutdownAudit(
  signal: NodeJS.Signals,
  stepsCompleted: string[],
  deadlineForcedExit: boolean
): Promise<void> {
  if (!coreMigrationsComplete) return;
  try {
    await recordShutdownAuditEvent({
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
async function recordBootStartAudit(input: {
  coreDb: CoreDb;
  layoutVersion: number;
  lockAcquisition: DataRootLock['acquisition'];
  migrationIds: string[];
  indexRebuildEvents: unknown[];
}): Promise<void> {
  try {
    await recordBootStartAuditEvent({
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
