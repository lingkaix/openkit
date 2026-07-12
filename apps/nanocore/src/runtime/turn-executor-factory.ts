import { SimulatedTurnExecutor } from '../lib/simulator.js';
import type { CoreDb } from '../storage/db.js';
import type { VaultBackend } from '../vault/vault-backend.js';
import { OpenShellCli } from './openshell-cli.js';
import type { OpenShellNetworkEndpoint } from './openshell-policy.js';
import type { TurnExecutor } from './types.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import { OpenShellWorkerGovernanceBackend } from './worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';

/** Environment variables used by NanoCore turn executor selection. */
export interface TurnExecutorFactoryEnv {
  /** Deterministic internal self-check executor switch used by tests and smoke runs. */
  OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR?: string | undefined;
  /** Deprecated production executor selector rejected by container-only NanoCore. */
  OPENKIT_TURN_EXECUTOR?: string | undefined;
  /** Worker runtime selector. Supported product value: `container`. */
  OPENKIT_WORKER_RUNTIME?: string | undefined;
  /** Container placement selected for real Worker Agent execution. */
  OPENKIT_CONTAINER_PLACEMENT?: string | undefined;
  /** Container backend family selected for real Worker Agent execution. */
  OPENKIT_CONTAINER_BACKEND?: string | undefined;
  /** Deprecated remote container backend selector rejected by container-only NanoCore. */
  OPENKIT_REMOTE_CONTAINER_BACKEND?: string | undefined;
  /** OpenShell gateway name used by the local-container executor. */
  OPENKIT_OPENSHELL_GATEWAY?: string | undefined;
  /** Remote OpenShell gateway URL used by the remote-container executor. */
  OPENKIT_OPENSHELL_GATEWAY_URL?: string | undefined;
  /** Whether remote OpenShell gateway TLS verification should be skipped. */
  OPENKIT_OPENSHELL_GATEWAY_INSECURE?: string | undefined;
  /** Worker image or source passed to `openshell sandbox create`. */
  OPENKIT_OPENSHELL_WORKER_IMAGE?: string | undefined;
  /** Whether OpenShell sandboxes should be retained after turn completion. */
  OPENKIT_OPENSHELL_RETAIN_SANDBOXES?: string | undefined;
  /** NanoCore worker-control upstream reached by the sandbox sidecar. */
  OPENKIT_OPENSHELL_CONTROL_RELAY_UPSTREAM?: string | undefined;
  /** OpenShell binary path or command name. */
  OPENKIT_OPENSHELL_BINARY?: string | undefined;
  /** Optional host Codex config file uploaded into explicitly configured OpenShell workers. */
  OPENKIT_OPENSHELL_CODEX_CONFIG_TOML?: string | undefined;
  /** Optional host Codex auth JSON uploaded into explicitly configured OpenShell workers. */
  OPENKIT_OPENSHELL_CODEX_AUTH_JSON?: string | undefined;
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
  const workerControlGateway = options.workerControlGateway ?? new WorkerControlGateway();

  if (env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR === '1') {
    return new SimulatedTurnExecutor();
  }

  rejectDeprecatedRuntimeEnv(env);

  const runtime = normalizeEnvValue(env.OPENKIT_WORKER_RUNTIME) ?? 'container';
  if (runtime !== 'container') {
    throw new Error(`Unsupported OPENKIT_WORKER_RUNTIME: ${runtime}.`);
  }

  const backend = normalizeEnvValue(env.OPENKIT_CONTAINER_BACKEND) ?? 'openshell';
  if (backend !== 'openshell') {
    throw new Error(`Unsupported OPENKIT_CONTAINER_BACKEND: ${backend}.`);
  }

  const placement = normalizeContainerPlacement(env.OPENKIT_CONTAINER_PLACEMENT);
  return createOpenShellTurnExecutor(
    env,
    workerControlGateway,
    options.coreDb,
    placement,
    options.vaultBackend
  );
}

/**
 * Rejects runtime selector environment variables removed from the product surface.
 *
 * @param env Environment variables to read.
 * @throws Error when a deprecated runtime selector is present.
 */
function rejectDeprecatedRuntimeEnv(env: TurnExecutorFactoryEnv): void {
  if (normalizeEnvValue(env.OPENKIT_TURN_EXECUTOR)) {
    throw new Error('OPENKIT_TURN_EXECUTOR is no longer supported.');
  }

  if (normalizeEnvValue(env.OPENKIT_REMOTE_CONTAINER_BACKEND)) {
    throw new Error('OPENKIT_REMOTE_CONTAINER_BACKEND is no longer supported.');
  }
}

/**
 * Parses the real worker container placement.
 *
 * @param value Raw placement environment value.
 * @returns Container placement, defaulting to local.
 * @throws Error when the placement is unsupported.
 */
function normalizeContainerPlacement(value: string | undefined): 'local' | 'remote' {
  const placement = normalizeEnvValue(value) ?? 'local';

  if (placement === 'local' || placement === 'remote') {
    return placement;
  }

  throw new Error(`Unsupported OPENKIT_CONTAINER_PLACEMENT: ${placement}.`);
}

/**
 * Creates the OpenShell-backed local-container turn executor.
 *
 * @param env Environment variables to read.
 * @param workerControlGateway Shared worker-control gateway for sidecar sessions.
 * @returns Worker governance turn executor.
 */
function createOpenShellTurnExecutor(
  env: TurnExecutorFactoryEnv,
  workerControlGateway: WorkerControlGateway,
  coreDb?: CoreDb | undefined,
  placement: 'local' | 'remote' = 'local',
  vaultBackend?: (() => VaultBackend) | undefined
): WorkerGovernanceTurnExecutor {
  const sandboxImageRef =
    normalizeEnvValue(env.OPENKIT_OPENSHELL_WORKER_IMAGE) ?? 'openkit/worker-codex:dev';
  const controlRelayUpstream =
    normalizeEnvValue(env.OPENKIT_OPENSHELL_CONTROL_RELAY_UPSTREAM) ??
    defaultControlRelayUpstream(env, placement);
  const gatewayName = normalizeEnvValue(env.OPENKIT_OPENSHELL_GATEWAY) ?? 'openshell';
  const gatewayUrl = parseOpenShellGatewayUrl(env, placement);
  const gatewayInsecure = parseBooleanEnv(env.OPENKIT_OPENSHELL_GATEWAY_INSECURE, false);
  const openshellBinary = normalizeEnvValue(env.OPENKIT_OPENSHELL_BINARY) ?? 'openshell';
  const codexModel = normalizeEnvValue(env.OPENKIT_OPENSHELL_CODEX_MODEL);

  return new WorkerGovernanceTurnExecutor({
    backend: new OpenShellWorkerGovernanceBackend({
      codexAuthJsonPath: normalizeEnvValue(env.OPENKIT_OPENSHELL_CODEX_AUTH_JSON),
      codexConfigTomlPath: normalizeEnvValue(env.OPENKIT_OPENSHELL_CODEX_CONFIG_TOML),
      cli: new OpenShellCli({ binary: openshellBinary }),
      extraNetworkEndpoints: parseExtraNetworkEndpoints(
        env.OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS
      ),
      gatewayName,
      ...(gatewayUrl ? { gatewayUrl } : {}),
      gatewayInsecure,
      placement,
      retainSandboxes: parseBooleanEnv(env.OPENKIT_OPENSHELL_RETAIN_SANDBOXES, false),
      sandboxSource: sandboxImageRef,
      workerControlGateway,
    }),
    coreDb,
    environmentBackend: {
      ...(codexModel ? { codexModel } : {}),
      controlRelayUpstream,
      ...(gatewayUrl ? { gatewayUrl } : {}),
      kind: 'openshell',
      placement,
      sandboxImageRef,
    },
    ...(vaultBackend ? { vaultBackend } : {}),
  });
}

/**
 * Builds the default worker-control upstream for local OpenShell placement only.
 *
 * @param env Environment variables to read.
 * @param placement OpenShell runtime placement.
 * @returns Local relay upstream.
 * @throws Error when remote placement omits an explicit relay upstream.
 */
function defaultControlRelayUpstream(
  env: TurnExecutorFactoryEnv,
  placement: 'local' | 'remote'
): string {
  if (placement === 'remote') {
    throw new Error(
      'OPENKIT_OPENSHELL_CONTROL_RELAY_UPSTREAM is required when OPENKIT_CONTAINER_PLACEMENT=remote.'
    );
  }

  return `http://host.openshell.internal:${normalizeEnvValue(env.PORT) ?? '3000'}/api/worker-control`;
}

/**
 * Parses the optional remote OpenShell gateway URL.
 *
 * @param env Environment variables to read.
 * @param placement OpenShell runtime placement.
 * @returns Gateway URL for remote placement, otherwise undefined.
 * @throws Error when remote placement omits or malforms the gateway URL.
 */
function parseOpenShellGatewayUrl(
  env: TurnExecutorFactoryEnv,
  placement: 'local' | 'remote'
): string | undefined {
  const gatewayUrl = normalizeEnvValue(env.OPENKIT_OPENSHELL_GATEWAY_URL);

  if (placement === 'local') {
    return gatewayUrl;
  }

  if (!gatewayUrl) {
    throw new Error(
      'OPENKIT_OPENSHELL_GATEWAY_URL is required when OPENKIT_CONTAINER_PLACEMENT=remote.'
    );
  }

  try {
    const parsed = new URL(gatewayUrl);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
  } catch (error) {
    throw new Error('OPENKIT_OPENSHELL_GATEWAY_URL must be a valid HTTP(S) URL.', {
      cause: error,
    });
  }

  return gatewayUrl;
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

/**
 * Parses a boolean environment switch.
 *
 * @param value Raw environment value.
 * @param defaultValue Value returned when the env var is absent.
 * @returns Parsed boolean.
 */
function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  const normalized = normalizeEnvValue(value)?.toLowerCase();

  if (normalized === undefined) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(normalized);
}
