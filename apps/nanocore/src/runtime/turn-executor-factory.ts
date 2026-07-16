import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { requireSchedulerSessionLeaseAdmissionContext } from '../scheduler-records.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import type { VaultBackend } from '../vault/vault-backend.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { OpenShellCellController } from './openshell-cell.js';
import { OpenShellCli } from './openshell-cli.js';
import type { OpenShellNetworkEndpoint } from './openshell-policy.js';
import type { TurnExecutor } from './types.js';
import type { WorkerBackendSessionRecord } from './worker-backend-sessions.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import { waitForWorkerControlFinalStatus } from './worker-control-records.js';
import {
  OpenShellWorkerGovernanceBackend,
  type WorkerGovernanceBackendSessionIdentity,
} from './worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';

/** Environment variables used by NanoCore turn executor selection. */
export interface TurnExecutorFactoryEnv {
  /** Deterministic internal self-check executor switch used by tests and smoke runs. */
  OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR?: string | undefined;
  /** Worker runtime selector. Supported product value: `container`. */
  OPENKIT_WORKER_RUNTIME?: string | undefined;
  /** Container placement selected for real Worker Agent execution. */
  OPENKIT_CONTAINER_PLACEMENT?: string | undefined;
  /** Container backend family selected for real Worker Agent execution. */
  OPENKIT_CONTAINER_BACKEND?: string | undefined;
  /** Worker image or source passed to `openshell sandbox create`. */
  OPENKIT_OPENSHELL_WORKER_IMAGE?: string | undefined;
  /** Direct NanoCore worker-control URL reached by the sandbox worker. */
  OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL?: string | undefined;
  /** SSH destination that owns the remote disposable Cell lifecycle helper. */
  OPENKIT_OPENSHELL_CELL_SSH_TARGET?: string | undefined;
  /** OpenShell gateway name used for remote placement. */
  OPENKIT_OPENSHELL_GATEWAY?: string | undefined;
  /** OpenShell gateway endpoint used for remote placement. */
  OPENKIT_OPENSHELL_GATEWAY_URL?: string | undefined;
  /** Optional host Codex config file uploaded into explicitly configured OpenShell workers. */
  OPENKIT_OPENSHELL_CODEX_CONFIG_TOML?: string | undefined;
  /** Optional Codex model used by one-shot OpenShell worker commands. */
  OPENKIT_OPENSHELL_CODEX_MODEL?: string | undefined;
  /** JSON array of additional OpenShell network endpoints authorized for selected worker binaries. */
  OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS?: string | undefined;
  /** HTTP port used when deriving the default worker-control upstream. */
  PORT?: string | undefined;
}

/** Options for creating the configured NanoCore turn executor. */
export interface CreateConfiguredTurnExecutorOptions {
  /** Optional Core database for durable workspace synchronization records. */
  coreDb?: CoreDb | undefined;
  /** Environment variables to read. Defaults to `process.env`. */
  env?: TurnExecutorFactoryEnv | undefined;
  /** Worker control gateway shared with NanoCore worker-control routes. */
  workerControlGateway?: WorkerControlGateway | undefined;
  /** Optional vault backend used for grant-derived provider attachments. */
  vaultBackend?: (() => VaultBackend) | undefined;
  /** Optional process-local store owner shared with the public App API. */
  storeForUserId?: ((userId: string) => FsStore) | undefined;
}

/** Shared real-worker lifecycle selected from NanoCore runtime configuration. */
export interface ConfiguredWorkerLifecycleRuntime {
  /** Cleans one exact durable backend identity during restart or online recovery. */
  readonly cleanupBackendSession: (
    identity: WorkerGovernanceBackendSessionIdentity
  ) => Promise<void>;
  /** Restores and closes one worker whose final status is already durable. */
  readonly reconcileAcceptedFinalStatus: (session: WorkerBackendSessionRecord) => Promise<{
    readonly status: 'completed' | 'failed';
    readonly turn: ReturnType<FsStore['getTurnById']>;
  }>;
  /** Configured disposable Cell placement. */
  readonly placement: 'local' | 'remote';
  /** Restores read-only access to one exact durable backend session. */
  readonly restoreBackendSession: (session: WorkerBackendSessionRecord) => Promise<void>;
  /** Product turn executor backed by the same cleanup owner. */
  readonly turnExecutor: TurnExecutor;
}

/**
 * Creates the turn executor selected by NanoCore runtime configuration.
 *
 * @param options Environment and shared worker-control gateway.
 * @returns Configured turn executor.
 * @throws Error when runtime, placement, or backend configuration is unsupported.
 */
export function createConfiguredTurnExecutor(
  options: CreateConfiguredTurnExecutorOptions = {}
): TurnExecutor {
  const env = options.env ?? process.env;

  if (env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR === '1') {
    return new SimulatedTurnExecutor();
  }

  return createConfiguredWorkerLifecycleRuntime(options).turnExecutor;
}

/**
 * Creates one shared physical-backend owner for execution and durable cleanup recovery.
 *
 * @param options Environment, Core database, and shared worker-control gateway.
 * @returns Turn executor and exact cleanup callback backed by one backend instance.
 * @throws Error when runtime configuration is unsupported or Core storage is unavailable.
 */
export function createConfiguredWorkerLifecycleRuntime(
  options: CreateConfiguredTurnExecutorOptions = {}
): ConfiguredWorkerLifecycleRuntime {
  const env = options.env ?? process.env;
  const workerControlGateway = options.workerControlGateway ?? new WorkerControlGateway();

  const runtime = normalizeEnvValue(env.OPENKIT_WORKER_RUNTIME) ?? 'container';
  if (runtime !== 'container') {
    throw new Error(`Unsupported OPENKIT_WORKER_RUNTIME: ${runtime}.`);
  }

  const backend = normalizeEnvValue(env.OPENKIT_CONTAINER_BACKEND) ?? 'openshell';
  if (backend !== 'openshell') {
    throw new Error(`Unsupported OPENKIT_CONTAINER_BACKEND: ${backend}.`);
  }

  const placement = parseContainerPlacement(env.OPENKIT_CONTAINER_PLACEMENT);
  if (!options.coreDb) {
    throw new Error('Real worker execution requires the durable Core database.');
  }
  return createOpenShellWorkerLifecycleRuntime(
    env,
    workerControlGateway,
    options.coreDb,
    placement,
    options.vaultBackend,
    options.storeForUserId
  );
}

/**
 * Parses the real worker Cell placement.
 *
 * @param value Raw placement environment value.
 * @returns Local or remote Cell placement.
 * @throws Error when the placement is unsupported.
 */
function parseContainerPlacement(value: string | undefined): 'local' | 'remote' {
  const placement = normalizeEnvValue(value) ?? 'local';

  if (placement === 'local' || placement === 'remote') {
    return placement;
  }

  throw new Error(`Unsupported OPENKIT_CONTAINER_PLACEMENT: ${placement}.`);
}

/**
 * Creates the OpenShell-backed worker lifecycle runtime.
 *
 * @param env Environment variables to read.
 * @param workerControlGateway Shared worker-control gateway for direct worker sessions.
 * @param coreDb Durable Core database and deployment identity source.
 * @param placement Local or remote disposable Cell placement.
 * @param vaultBackend Optional vault backend used for runtime provider grants.
 * @param storeForUserId Optional process-local store owner shared with the App API.
 * @returns Shared worker lifecycle runtime.
 */
function createOpenShellWorkerLifecycleRuntime(
  env: TurnExecutorFactoryEnv,
  workerControlGateway: WorkerControlGateway,
  coreDb: CoreDb,
  placement: 'local' | 'remote',
  vaultBackend?: (() => VaultBackend) | undefined,
  storeForUserId?: ((userId: string) => FsStore) | undefined
): ConfiguredWorkerLifecycleRuntime {
  const sandboxImageRef =
    normalizeEnvValue(env.OPENKIT_OPENSHELL_WORKER_IMAGE) ?? 'openkit/worker-codex:dev';
  const sshTarget =
    placement === 'remote'
      ? readRequiredRemoteEnv(
          'OPENKIT_OPENSHELL_CELL_SSH_TARGET',
          env.OPENKIT_OPENSHELL_CELL_SSH_TARGET
        )
      : undefined;
  const gatewayName =
    placement === 'remote' ? parseRemoteGatewayName(env.OPENKIT_OPENSHELL_GATEWAY) : 'openshell';
  const gatewayUrl =
    placement === 'remote'
      ? parseRemoteGatewayUrl(
          readRequiredRemoteEnv('OPENKIT_OPENSHELL_GATEWAY_URL', env.OPENKIT_OPENSHELL_GATEWAY_URL)
        )
      : 'http://127.0.0.1:17670';
  const workerControlBaseUrl = resolveWorkerControlBaseUrl(env, placement);
  const codexModel = normalizeEnvValue(env.OPENKIT_OPENSHELL_CODEX_MODEL);
  const layoutMarker = readDataRootLayoutMarker(coreDb.dataRoot);
  const backend = new OpenShellWorkerGovernanceBackend({
    codexConfigTomlPath: normalizeEnvValue(env.OPENKIT_OPENSHELL_CODEX_CONFIG_TOML),
    cellLifecycle: new OpenShellCellController(sshTarget ? { sshTarget } : {}),
    cli: new OpenShellCli(),
    dataRoot: coreDb.dataRoot,
    deploymentId: layoutMarker.deploymentId,
    extraNetworkEndpoints: parseExtraNetworkEndpoints(
      env.OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS
    ),
    gatewayName,
    gatewayUrl,
    placement,
    workerControlGateway,
  });
  const turnExecutor =
    env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR === '1'
      ? new SimulatedTurnExecutor()
      : new WorkerGovernanceTurnExecutor({
          awaitWorkerCompletion: (environmentPackage, leaseId) =>
            waitForWorkerControlFinalStatus(coreDb, {
              leaseId,
              lineage: {
                agentSessionId: environmentPackage.scope.agentSessionId,
                packageSnapshotId: environmentPackage.snapshotId,
                requestId: environmentPackage.scope.requestId ?? null,
                threadId: environmentPackage.scope.threadId,
                turnId: environmentPackage.scope.turnId,
                workspaceId: environmentPackage.scope.workspaceId,
              },
            }),
          backend,
          coreDb,
          environmentBackend: {
            ...(codexModel ? { codexModel } : {}),
            workerControlBaseUrl,
            gatewayUrl,
            kind: 'openshell',
            placement,
            sandboxImageRef,
          },
          ...(vaultBackend ? { vaultBackend } : {}),
        });

  /** Restores the existing immutable package, owner, and read-only backend handle. */
  async function restoreDurableSession(session: WorkerBackendSessionRecord): Promise<{
    readonly environmentPackage: AgentEnvironmentPackage;
    readonly userId: string;
  }> {
    const admission = requireSchedulerSessionLeaseAdmissionContext(coreDb, session.leaseId);
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, admission.userId, session.workspaceId);
    let environmentPackage: AgentEnvironmentPackage;
    try {
      applyScopedMigrations(workspaceDb);
      environmentPackage = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        session.workspaceId,
        session.packageSnapshotId
      ).snapshot;
    } finally {
      workspaceDb.sqlite.close();
    }
    const capabilities = await backend.describeCapabilities();
    if (
      session.backendKind !== 'openshell' ||
      session.backendVersion !== (capabilities.version ?? null) ||
      session.workerImage !== environmentPackage.runtime.image.ref ||
      session.workspaceHandoffState !== 'complete'
    ) {
      throw new Error('Restart backend session does not match its immutable runtime package.');
    }
    await backend.restoreSession(environmentPackage, {
      agentSessionId: session.agentSessionId,
      backendKind: session.backendKind,
      backendSessionId: session.backendSessionId,
      backendTarget: session.backendTarget,
      deploymentId: session.deploymentId,
      packageSnapshotId: session.packageSnapshotId,
      stagingDirectoryRef: session.stagingDirectoryRef,
      transientProviderInstanceId: session.transientProviderInstanceId,
    });
    return { environmentPackage, userId: admission.userId };
  }

  return {
    cleanupBackendSession: (identity) => backend.cleanupSession(identity),
    placement,
    reconcileAcceptedFinalStatus: async (session) => {
      if (!(turnExecutor instanceof WorkerGovernanceTurnExecutor)) {
        throw new Error('The self-check executor cannot reconcile a real worker session.');
      }
      const { environmentPackage, userId } = await restoreDurableSession(session);
      const store = storeForUserId?.(userId) ?? new FsStore({ dataRoot: coreDb.dataRoot, userId });
      const recoveredStatus = await turnExecutor.resumeAcceptedFinalStatus(
        store,
        environmentPackage,
        session
      );
      return { status: recoveredStatus, turn: store.getTurnById(session.turnId) };
    },
    restoreBackendSession: async (session) => {
      await restoreDurableSession(session);
    },
    turnExecutor,
  };
}

/**
 * Resolves the worker-control URL for one Cell placement.
 *
 * @param env Environment variables to read.
 * @param placement Local or remote Cell placement.
 * @returns Worker-control URL reached by the sandbox.
 * @throws When remote placement omits the required URL.
 */
function resolveWorkerControlBaseUrl(
  env: TurnExecutorFactoryEnv,
  placement: 'local' | 'remote'
): string {
  const configured = normalizeEnvValue(env.OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL);

  if (configured) {
    return parseWorkerControlBaseUrl(configured, placement);
  }
  if (placement === 'remote') {
    throw new Error(
      'OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL is required when OPENKIT_CONTAINER_PLACEMENT=remote.'
    );
  }
  return `http://host.openshell.internal:${normalizeEnvValue(env.PORT) ?? '3000'}/api/worker-control`;
}

/**
 * Validates the direct worker-control base URL injected into one sandbox.
 *
 * @param value Configured worker-control URL.
 * @param placement Local or remote Cell placement.
 * @returns Canonical credential-free HTTP(S) URL.
 * @throws When the URL cannot identify the public worker-control route.
 */
function parseWorkerControlBaseUrl(value: string, placement: 'local' | 'remote'): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(
      'OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL must be a credential-free HTTP(S) /api/worker-control URL.',
      { cause: error }
    );
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/api/worker-control' ||
    url.search ||
    url.hash ||
    (placement === 'remote' &&
      (url.hostname === 'localhost' ||
        url.hostname === '[::1]' ||
        url.hostname === '[::]' ||
        url.hostname === '0.0.0.0' ||
        /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname)))
  ) {
    throw new Error(
      'OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL must be a credential-free HTTP(S) /api/worker-control URL.'
    );
  }
  return `${url.origin}/api/worker-control`;
}

/**
 * Validates the remote OpenShell Gateway name before it reaches CLI argv.
 *
 * @param value Raw optional Gateway name.
 * @returns Safe Gateway name or the stock default.
 * @throws When the name could be interpreted as an option or path.
 */
function parseRemoteGatewayName(value: string | undefined): string {
  const gatewayName = normalizeEnvValue(value) ?? 'openshell';

  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(gatewayName)) {
    throw new Error('OPENKIT_OPENSHELL_GATEWAY must be a safe OpenShell gateway name.');
  }
  return gatewayName;
}

/**
 * Reads one required remote Cell environment value.
 *
 * @param name Environment variable name.
 * @param value Raw environment value.
 * @returns Trimmed value.
 * @throws When the value is absent.
 */
function readRequiredRemoteEnv(name: string, value: string | undefined): string {
  const normalized = normalizeEnvValue(value);

  if (!normalized) {
    throw new Error(`${name} is required when OPENKIT_CONTAINER_PLACEMENT=remote.`);
  }
  return normalized;
}

/**
 * Validates one loopback OpenShell Gateway origin reached through an operator SSH tunnel.
 *
 * @param value Gateway URL.
 * @returns Canonical Gateway origin.
 * @throws When the URL is not a credential-free loopback HTTP origin.
 */
function parseRemoteGatewayUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('OPENKIT_OPENSHELL_GATEWAY_URL must be a loopback HTTP origin.', {
      cause: error,
    });
  }
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('OPENKIT_OPENSHELL_GATEWAY_URL must be a loopback HTTP origin.');
  }
  return url.origin;
}

/**
 * Parses optional extra OpenShell network endpoint declarations from JSON.
 *
 * @param value Raw JSON environment value.
 * @returns Parsed endpoint declarations.
 * @throws Error when the value is not valid endpoint JSON.
 */
function parseExtraNetworkEndpoints(value: string | undefined): OpenShellNetworkEndpoint[] {
  const normalized = normalizeEnvValue(value);

  if (!normalized) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    throw new Error('OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS must be valid JSON.', {
      cause: error,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new Error('OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS must be a JSON array.');
  }

  return parsed.map((entry, index) => parseExtraNetworkEndpoint(entry, index));
}

/**
 * Parses one extra OpenShell network endpoint declaration.
 *
 * @param value Raw endpoint value.
 * @param index Endpoint index for diagnostics.
 * @returns Parsed endpoint declaration.
 * @throws Error when the endpoint is malformed.
 */
function parseExtraNetworkEndpoint(value: unknown, index: number): OpenShellNetworkEndpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS[${index}] must be an object.`);
  }

  const record = value as Record<string, unknown>;
  const name = parseRequiredString(
    record.name,
    `OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS[${index}].name`
  );

  if (name === 'openkit_worker_control' || name === 'openkit_worker_inference') {
    throw new Error(
      `OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS[${index}].name is reserved: ${name}.`
    );
  }
  const host = parseRequiredString(
    record.host,
    `OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS[${index}].host`
  );
  const port = parseRequiredPort(
    record.port,
    `OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS[${index}].port`
  );
  const protocol = parseOptionalProtocol(
    record.protocol,
    `OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS[${index}].protocol`
  );
  const access = parseOptionalAccess(
    record.access,
    `OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS[${index}].access`
  );
  const binaries = parseOptionalStringArray(
    record.binaries,
    `OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS[${index}].binaries`
  );

  return {
    ...(access ? { access } : {}),
    ...(binaries ? { binaries } : {}),
    host,
    name,
    port,
    ...(protocol ? { protocol } : {}),
  };
}

/**
 * Parses a required string field.
 *
 * @param value Raw field value.
 * @param field Field name used in diagnostics.
 * @returns Trimmed string.
 * @throws Error when the field is absent or not a string.
 */
function parseRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value.trim();
}

/**
 * Parses an optional OpenShell L7 network protocol.
 *
 * @param value Raw field value.
 * @param field Field name used in diagnostics.
 * @returns Protocol or undefined.
 * @throws Error when the field is not a supported OpenShell L7 protocol.
 */
function parseOptionalProtocol(
  value: unknown,
  field: string
): OpenShellNetworkEndpoint['protocol'] {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'rest' || value === 'websocket' || value === 'graphql' || value === 'sql') {
    return value;
  }

  throw new Error(`${field} must be "rest", "websocket", "graphql", or "sql".`);
}

/**
 * Parses a required TCP port.
 *
 * @param value Raw field value.
 * @param field Field name used in diagnostics.
 * @returns Port number.
 * @throws Error when the field is not a valid TCP port.
 */
function parseRequiredPort(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${field} must be an integer between 1 and 65535.`);
  }

  return value;
}

/**
 * Parses an optional OpenShell network access mode.
 *
 * @param value Raw field value.
 * @param field Field name used in diagnostics.
 * @returns Access mode or undefined.
 * @throws Error when the field is not a supported access mode.
 */
function parseOptionalAccess(value: unknown, field: string): OpenShellNetworkEndpoint['access'] {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'read-only' || value === 'read-write') {
    return value;
  }

  throw new Error(`${field} must be "read-only" or "read-write".`);
}

/**
 * Parses an optional string array field.
 *
 * @param value Raw field value.
 * @param field Field name used in diagnostics.
 * @returns String array or undefined.
 * @throws Error when the field is not a non-empty string array.
 */
function parseOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || !entry.trim())
  ) {
    throw new Error(`${field} must be a non-empty string array.`);
  }

  return value.map((entry) => entry.trim());
}

/**
 * Normalizes a nullable environment value.
 *
 * @param value Environment value.
 * @returns Trimmed value, or undefined when absent or blank.
 */
function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}
