import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import type {
  RuntimeConfigChangeSchema,
  RuntimeConfigReloadPlanSchema,
  RuntimeConfigReloadRequest,
  RuntimeConfigReloadResponse,
  RuntimeConfigReloadSummarySchema,
  RuntimeConfigStatus,
} from '@openkit/app-api-schemas';
import {
  BLOCKED_DELEGATED_REFRESH_STRATEGIES,
  type GatewayConfig,
  GatewayConfigSchema,
  type InternalRoleProfilesConfig,
  InternalRoleProfilesConfigSchema,
  type ModelCatalog,
  parseWorkspaceDataSourceCatalog,
  type UserConfig,
  UserConfigSchema,
  type WorkspaceConfig,
  WorkspaceConfigSchema,
  type WorkspaceDataSourceCatalog,
  type WorkspaceMcpServerCatalog,
} from '@openkit/config-schema';
import {
  canonicalJsonText,
  compareCodeUnits,
  readRetainedV1,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { sha256CanonicalJson } from '@openkit/protocol/digest';
import type { CaptureCoverageBinding } from '@openkit/worker-protocol';
import { z } from 'zod';
import type { AgentManifest } from '../agents/manifest.js';
import { refuseScope } from '../bootstrap/readiness.js';
import {
  loadWorkspaceResourceCatalog,
  projectEffectiveWorkspaceMcpCatalog,
} from '../catalog/resource-catalog.js';
import {
  assertConfiguredModelsHaveKnownContext,
  resolveLogicalModelCatalog,
} from '../llm/logical-models.js';
import type { ProviderSubscriptionAccountManager } from '../llm/provider-subscription-accounts.js';
import { LISTENER_TLS_PLAN_PATH } from '../native-listener-tls.js';
import { loadProviderRegistryFromDataRoot } from '../providers/data-root.js';
import type { ProviderDiagnosticsSnapshot } from '../providers/diagnostics.js';
import { createProviderDiagnostics } from '../providers/diagnostics.js';
import { type ProviderCredentialConfigured, ProviderRegistry } from '../providers/registry.js';
import {
  getControlStoreWorkerClient,
  type WorkspaceFrozenAdmission,
} from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import {
  runtimePolicyIdentityForSnapshot,
  sameRuntimePolicyIdentity,
} from '../storage/runtime-policy-publication.js';
import { loadAgentManifests } from './agents-loader.js';
import { parseJsoncObject } from './jsonc.js';
import { loadModelCatalog } from './model-catalog.js';
import {
  loadOpenKitConfigWithDiagnostics,
  type OpenKitConfig,
  type OpenKitConfigDiagnostic,
} from './openkit-config.js';
import { loadProviderProfiles } from './providers-loader.js';
import {
  type TolerantConfigKind,
  type UnknownConfigKey,
  unknownConfigKeyMessage,
  unknownConfigKeys,
} from './unknown-config-keys.js';

/** Shared truthful refusal for source kinds outside the release's work-slot importer. */
export const WORKSPACE_MATERIALIZATION_UNSUPPORTED_MESSAGE =
  'Only credential-free remote Git sources can be materialized into a work slot in this release. Folder and other source kinds are not supported yet. Work without a source input still runs.';

type RuntimeConfigChange = z.infer<typeof RuntimeConfigChangeSchema>;
type RuntimeConfigReloadPlan = z.infer<typeof RuntimeConfigReloadPlanSchema>;
type RuntimeConfigReloadSummary = z.infer<typeof RuntimeConfigReloadSummarySchema>;

/** Runtime plan path for the current NanoHost transport fence. */
export const NANO_HOST_TRANSPORT_RESTART_PATH = 'nanohost.transport';

interface RuntimeConfigSnapshotConstructionInput {
  dataRoot: string | null;
  version: number;
  loadedAt?: string;
  sources: RuntimeConfigSource[];
  openKitConfig: OpenKitConfig;
  providerRegistry: ProviderRegistry;
  /** Deployment model extension metadata captured with the Provider registry. */
  modelCatalog: ModelCatalog;
  providerDiagnostics: ProviderDiagnosticsSnapshot;
  agentManifests: AgentManifest[];
  gatewayConfig: GatewayConfig;
  internalRoleProfiles: InternalRoleProfilesConfig;
  userConfigs: LoadedUserConfig[];
  workspaceConfigs: LoadedWorkspaceConfig[];
  workspaceDataSourceCatalogs: LoadedWorkspaceDataSourceCatalog[];
  workspaceMcpServerCatalogs: LoadedWorkspaceMcpServerCatalog[];
  diagnostics: RuntimeConfigDiagnostic[];
}

/**
 * Runtime config source input loaded from disk.
 */
interface RuntimeConfigSource {
  /** Source kind. */
  kind:
    | 'server-config'
    | 'gateway-config'
    | 'internal-role-profiles'
    | 'model-catalog'
    | 'provider-profiles'
    | 'agent-configs'
    | 'user-configs'
    | 'workspace-configs'
    | 'workspace-data-source-catalogs'
    | 'workspace-mcp-server-catalogs';
  /** Source path or glob-like description. */
  path: string;
}

/**
 * Parsed workspace config loaded from its canonical Workspace path.
 */
interface LoadedWorkspaceConfig {
  /** Workspace id that owns this config. */
  workspaceId: string;
  /** Absolute source path loaded from disk. */
  path: string;
  /** Parsed workspace config. */
  config: WorkspaceConfig;
}

/** Parsed User preference config loaded from its canonical User path. */
interface LoadedUserConfig {
  /** User id that owns this config. */
  userId: string;
  /** Absolute source path loaded from disk. */
  path: string;
  /** Parsed User preference config. */
  config: UserConfig;
}

/**
 * Parsed workspace data source catalog loaded from its canonical Workspace path.
 */
interface LoadedWorkspaceDataSourceCatalog {
  /** Workspace id that owns this catalog. */
  workspaceId: string;
  /** Absolute source path loaded from disk. */
  path: string;
  /** Parsed workspace data source catalog. */
  catalog: WorkspaceDataSourceCatalog;
}

/** Parsed Workspace MCP server catalog loaded from its canonical Workspace path. */
interface LoadedWorkspaceMcpServerCatalog {
  /** Workspace id that owns this catalog. */
  workspaceId: string;
  /** Absolute source path loaded from disk. */
  path: string;
  /** Parsed Workspace MCP server catalog. */
  catalog: WorkspaceMcpServerCatalog;
}

/**
 * Runtime config diagnostic collected while loading a snapshot.
 */
interface RuntimeConfigDiagnostic {
  /** Stable diagnostic code. */
  code: string;
  /** Redacted source path or source kind. */
  source: string;
  /** Human-readable diagnostic message. */
  message: string;
  /** Diagnostic severity. */
  severity: 'warning' | 'error';
}

/**
 * Immutable runtime config inputs used by NanoCore routes.
 */
export interface RuntimeConfigSnapshot {
  /** Monotonic snapshot version. */
  version: number;
  /** Snapshot load timestamp. */
  loadedAt: string;
  /** Stable hash of redacted semantic runtime inputs. */
  contentHash: string;
  /** Loaded source descriptors. */
  sources: RuntimeConfigSource[];
  /** Parsed OpenKit server config. */
  openKitConfig: OpenKitConfig;
  /** Runtime provider registry. */
  providerRegistry: ProviderRegistry;
  /** Deployment model extension metadata captured with the Provider registry. */
  modelCatalog: ModelCatalog;
  /** Redacted provider diagnostics. */
  providerDiagnostics: ProviderDiagnosticsSnapshot;
  /** Authored agent manifests. */
  agentManifests: AgentManifest[];
  /** Server-scoped logical model and private route configuration. */
  gatewayConfig: GatewayConfig;
  /** Server-scoped Internal Role Execution Profiles. */
  internalRoleProfiles: InternalRoleProfilesConfig;
  /** Parsed personal preference configs discovered under DATA_ROOT/users. */
  userConfigs: LoadedUserConfig[];
  /** Parsed workspace configs discovered under DATA_ROOT/workspaces. */
  workspaceConfigs: LoadedWorkspaceConfig[];
  /** Parsed workspace data source catalogs discovered under DATA_ROOT/workspaces. */
  workspaceDataSourceCatalogs: LoadedWorkspaceDataSourceCatalog[];
  /** Parsed MCP server catalogs discovered under DATA_ROOT/workspaces. */
  workspaceMcpServerCatalogs: LoadedWorkspaceMcpServerCatalog[];
  /** Runtime config diagnostics. */
  diagnostics: RuntimeConfigDiagnostic[];
}

/**
 * Options used when loading a runtime config snapshot from disk.
 */
interface LoadRuntimeConfigOptions {
  /** Snapshot version to assign. */
  version?: number;
  /** Timestamp to assign for deterministic tests. */
  loadedAt?: string;
  /** Live API-key presence, inspected without resolving Vault material. */
  providerCredentialConfigured?: ProviderCredentialConfigured | undefined;
  /** Live subscription owner for network-free Gateway supply admission. */
  subscriptionAccounts?:
    | Pick<ProviderSubscriptionAccountManager, 'gatewayUnavailableReason'>
    | undefined;
  /** Boot load only: refuse one malformed Workspace instead of failing the snapshot. */
  quarantineMalformedWorkspaceConfig?: boolean;
}

/**
 * Runtime config manager construction input.
 */
interface RuntimeConfigManagerOptions {
  /** Data root to reload from. */
  dataRoot: string | null;
  /** The listener owner's bounded check for a new valid public certificate generation. */
  checkListenerTlsChange?: (() => Promise<boolean>) | undefined;
  /** Optional initial snapshot for tests or already-loaded startup state. */
  initialSnapshot?: RuntimeConfigSnapshot;
  /** Live API-key presence, inspected without resolving Vault material. */
  providerCredentialConfigured?: ProviderCredentialConfigured | undefined;
  /** Live subscription owner reused at initial load and candidate reload. */
  subscriptionAccounts?:
    | Pick<ProviderSubscriptionAccountManager, 'gatewayUnavailableReason'>
    | undefined;
  /** Live capture-coverage sink updated on load and applied reload. */
  captureCoverage?: {
    setLiveCaptureCoverage(binding: CaptureCoverageBinding): void;
    /** Uses only the installed configuration snapshot, including its original failed-reload behavior. */
    setWorkspaceCaptureCoverageProjection?(
      projection: (workspaceId: string) => WorkspaceConfig | undefined
    ): void;
  };
}

/**
 * Runtime config fields for constructing an in-memory snapshot.
 */
interface RuntimeConfigSnapshotInput {
  /** Data root represented by this snapshot. */
  dataRoot: string | null;
  /** Parsed OpenKit config. */
  openKitConfig?: OpenKitConfig;
  /** Runtime provider registry. */
  providerRegistry?: ProviderRegistry;
  /** Deployment model extensions for an explicitly supplied registry. */
  modelCatalog?: ModelCatalog;
  /** Provider diagnostics. */
  providerDiagnostics?: ProviderDiagnosticsSnapshot;
  /** Authored agent manifests. */
  agentManifests?: AgentManifest[];
  gatewayConfig?: GatewayConfig;
  internalRoleProfiles?: InternalRoleProfilesConfig;
  userConfigs?: LoadedUserConfig[];
  /** Parsed workspace configs. */
  workspaceConfigs?: LoadedWorkspaceConfig[];
  /** Parsed workspace data source catalogs. */
  workspaceDataSourceCatalogs?: LoadedWorkspaceDataSourceCatalog[];
  /** Parsed Workspace MCP server catalogs. */
  workspaceMcpServerCatalogs?: LoadedWorkspaceMcpServerCatalog[];
  /** Snapshot version. */
  version?: number;
}

/**
 * Last-known-good runtime config manager.
 */
export interface RuntimeConfigManager {
  /** Returns the captured storage root for exact-target lifecycle dependency binding. */
  getDataRoot(): string | null;
  /** Returns the active runtime config snapshot. */
  current(): RuntimeConfigSnapshot;
  /** Binds the App's transport fence and returns a reader for the lifetime admission latch. */
  bindNanoHostTransportFence(fence: () => Promise<void>): () => boolean;
  /** Adds current process restart reasons to a candidate or failed plan for reporting. */
  reportCurrentRestart(plan: RuntimeConfigReloadPlan): RuntimeConfigReloadPlan;
  /** Acknowledges this manager's actual installed Policy on the canonical native Core opening. */
  bindNativePolicyPublication(coreDb: CoreDb): Promise<void>;
  /** Publishes a committed Workspace creation or name edit without activating other saved inputs. */
  publishWorkspaceConfiguration(workspaceId: string, name: string): Promise<void>;
  /** Validates and replaces only a restored target while its exact recovery freeze remains closed. */
  reloadRecoveredWorkspace(
    workspaceId: string,
    freeze: WorkspaceFrozenAdmission
  ): RuntimeConfigSnapshot | Promise<RuntimeConfigSnapshot>;
  /** Plans the draft or saved candidate with the same checks and live supply predicates. */
  prepareReloadCandidate(
    dataRoot: string,
    mode: RuntimeConfigReloadRequest['mode']
  ): { snapshot: RuntimeConfigSnapshot; plan: RuntimeConfigReloadPlan };
  /** Checks listener material without modifying the running TLS contexts. */
  checkListenerTlsCandidate(): Promise<RuntimeConfigChange | undefined>;
  /** Reloads runtime config from the configured data root. */
  reload(
    input: RuntimeConfigReloadRequest
  ): RuntimeConfigReloadResponse | Promise<RuntimeConfigReloadResponse>;
  /** Returns redacted runtime config status. */
  status(): RuntimeConfigStatus;
}

/** OpenKitConfig sibling fields whose process-bound identity takes effect only after restart. */
const RESTART_REQUIRED_CONFIG_PATHS = [
  'mode',
  'auth',
  'server',
  'vault',
  'appUpdate',
  'channels',
  'nanohost.bind',
  'nanohost.credentialRef',
  'nanohost.credentialSlots',
  'nanohost.deploymentId',
  'nanohost.identityId',
  'nanohost.rendezvousUrl',
] as const;

/**
 * Resolves authored capture intent from Server to Workspace to the exact Workspace-scoped Task.
 *
 * @param config Parsed server.jsonc configuration.
 * @param workspace Optional parsed Workspace configuration; absence inherits the Server.
 * @param taskId Trusted Task identity from the admission owner, never a Goal card id.
 * @returns Immutable pair for admission; omitted Server policy is on.
 */
export function captureCoverageBindingFromOpenKitConfig(
  config: OpenKitConfig,
  workspace?: Pick<WorkspaceConfig, 'workspace'>,
  taskId?: string | null
): CaptureCoverageBinding {
  return resolveCaptureCoverageBinding(
    { scope: 'server', value: config.policy?.workDataCapture?.value ?? 'on' },
    workspace,
    taskId
  );
}

/** Resolves lower authored scopes against the installed Server pair, without allocating durable state. */
export function resolveCaptureCoverageBinding(
  server: CaptureCoverageBinding,
  workspace?: Pick<WorkspaceConfig, 'workspace'>,
  taskId?: string | null
): CaptureCoverageBinding {
  const override = workspace?.workspace.policy?.workDataCapture;
  const task = taskId ? override?.tasks?.[taskId] : undefined;
  if (task) return { scope: 'task', value: task.value };
  if (override?.value !== undefined) return { scope: 'workspace', value: override.value };
  return structuredClone(server);
}

/**
 * Loads one runtime config snapshot from a data root.
 *
 * @param dataRoot Data root that owns DATA_ROOT/config.
 * @param options Optional version and timestamp controls.
 * @returns Runtime config snapshot.
 */
export function loadRuntimeConfig(
  dataRoot: string,
  options: LoadRuntimeConfigOptions = {}
): RuntimeConfigSnapshot {
  const configLoadResult = loadOpenKitConfigWithDiagnostics(dataRoot);
  const authoredDiagnostics: RuntimeConfigDiagnostic[] = [];
  const reportUnknownKey = (key: UnknownConfigKey, path: string): void => {
    authoredDiagnostics.push({
      code: 'authored_config.unknown_key',
      message: unknownConfigKeyMessage(key),
      severity: 'warning',
      source: `DATA_ROOT/${relative(dataRoot, path)}`,
    });
  };
  // Compose the existing loaders here so warning provenance is captured before metadata inheritance.
  const modelCatalog = loadModelCatalog(dataRoot, reportUnknownKey);
  const providerProfiles = loadProviderProfiles(dataRoot, modelCatalog, reportUnknownKey);
  const providerLoadResult = {
    modelCatalog,
    providerRegistry: new ProviderRegistry(providerProfiles.profiles),
    providerDiagnostics: createProviderDiagnostics(providerProfiles),
  };
  const agentLoadResult = loadAgentManifests(dataRoot);
  const gatewayDiagnostics: RuntimeConfigDiagnostic[] = [];
  const gatewayConfig = loadServerScopedConfig(
    join(dataRoot, 'config', 'gateway.jsonc'),
    GatewayConfigSchema,
    { schemaVersion: 1, enabled: true, logicalModels: [] },
    { diagnostics: gatewayDiagnostics, dataRoot, kind: 'gateway' }
  );
  const internalRoleProfiles = loadServerScopedConfig(
    join(dataRoot, 'config', 'internal-role-profiles.jsonc'),
    InternalRoleProfilesConfigSchema,
    { schemaVersion: 1, profiles: [] },
    { diagnostics: authoredDiagnostics, dataRoot, kind: 'internal-role' }
  );
  const userConfigs = loadUserConfigs(dataRoot, authoredDiagnostics);
  const quarantinedWorkspaceIds = options.quarantineMalformedWorkspaceConfig
    ? new Set<string>()
    : undefined;
  const workspaceConfigs = loadWorkspaceConfigs(
    dataRoot,
    authoredDiagnostics,
    undefined,
    quarantinedWorkspaceIds
  );
  const workspaceDataSourceCatalogs = loadWorkspaceDataSourceCatalogs(
    dataRoot,
    authoredDiagnostics,
    undefined,
    quarantinedWorkspaceIds
  );
  const workspaceMcpServerCatalogs = loadWorkspaceMcpServerCatalogs(
    dataRoot,
    undefined,
    quarantinedWorkspaceIds
  );
  // #604: a rotating-family refresh shape stays parseable; its delivery refuses before effects.
  for (const shape of gatewayConfig.providerAccessShapes ?? []) {
    if (shape.refresh && BLOCKED_DELEGATED_REFRESH_STRATEGIES.includes(shape.refresh.strategy))
      gatewayDiagnostics.push({
        code: 'credential_delegation_blocked',
        message: `Provider access shape ${shape.id} cannot delegate refresh: rotating-family recovery is unproved.`,
        severity: 'warning',
        source: 'DATA_ROOT/config/gateway.jsonc',
      });
  }
  const diagnostics: RuntimeConfigDiagnostic[] = [
    ...configLoadResult.diagnostics.map(configDiagnostic),
    ...authoredDiagnostics,
    ...providerLoadResult.providerDiagnostics.summaries.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      severity: 'error' as const,
      source: diagnostic.source,
    })),
    ...agentLoadResult.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      severity: diagnostic.severity,
      source: redactSourcePath(diagnostic.path),
    })),
    ...gatewayDiagnostics,
    ...gatewayCompositionDiagnostics(gatewayConfig, providerLoadResult.providerRegistry, options),
  ];
  const snapshot = createRuntimeConfigSnapshot({
    dataRoot,
    openKitConfig: configLoadResult.config,
    providerRegistry: providerLoadResult.providerRegistry,
    modelCatalog: providerLoadResult.modelCatalog,
    providerDiagnostics: providerLoadResult.providerDiagnostics,
    agentManifests: agentLoadResult.manifests,
    gatewayConfig,
    internalRoleProfiles,
    userConfigs,
    workspaceConfigs,
    workspaceDataSourceCatalogs,
    workspaceMcpServerCatalogs,
    version: options.version ?? 1,
    diagnostics,
    sources: [
      {
        kind: 'server-config',
        path: configLoadResult.path ?? 'DATA_ROOT/config/server.jsonc',
      },
      { kind: 'model-catalog', path: 'DATA_ROOT/config/model-catalog.jsonc' },
      { kind: 'provider-profiles', path: 'DATA_ROOT/config/providers/*.provider.jsonc' },
      { kind: 'agent-configs', path: 'DATA_ROOT/config/agents/*.agent.jsonc' },
      { kind: 'gateway-config', path: 'DATA_ROOT/config/gateway.jsonc' },
      { kind: 'internal-role-profiles', path: 'DATA_ROOT/config/internal-role-profiles.jsonc' },
      { kind: 'user-configs', path: 'DATA_ROOT/users/*/config/user.jsonc' },
      { kind: 'workspace-configs', path: 'DATA_ROOT/workspaces/*/config/workspace.jsonc' },
      {
        kind: 'workspace-data-source-catalogs',
        path: 'DATA_ROOT/workspaces/*/config/data-sources.jsonc',
      },
      {
        kind: 'workspace-mcp-server-catalogs',
        path: 'DATA_ROOT/workspaces/*/catalog/catalog.json',
      },
    ],
    ...(options.loadedAt ? { loadedAt: options.loadedAt } : {}),
  });

  return Object.freeze(snapshot);
}

const gatewayCompositionCodes = {
  speechAsChat: 'gateway.speech_model_as_chat',
  unknownContext: 'provider.unknown_model_context',
  unavailableMember: 'gateway.unavailable_member',
  invalidLogicalModel: 'gateway.invalid_logical_model',
};
const effectiveGatewayDiagnosticCodes = new Set([
  gatewayCompositionCodes.speechAsChat,
  gatewayCompositionCodes.unavailableMember,
  gatewayCompositionCodes.invalidLogicalModel,
]);

/** Checks the exact Gateway and Provider combination without contacting an upstream. */
function gatewayCompositionDiagnostics(
  gatewayConfig: GatewayConfig,
  providerRegistry: ProviderRegistry,
  options: LoadRuntimeConfigOptions
): RuntimeConfigDiagnostic[] {
  const gatewayDiagnostics: RuntimeConfigDiagnostic[] = [];
  for (const model of gatewayConfig.logicalModels) {
    for (const route of model.routes) {
      const profile = providerRegistry.get(route.providerProfileId);
      if (profile?.extensions?.openkit?.localBackend?.backendId === 'sherpa-onnx-asr') {
        gatewayDiagnostics.push({
          code: gatewayCompositionCodes.speechAsChat,
          message: `Logical model ${model.id} names speech model ${route.providerModel}.`,
          severity: 'error',
          source: 'DATA_ROOT/config/gateway.jsonc',
        });
      }
    }
  }
  try {
    assertConfiguredModelsHaveKnownContext(providerRegistry, gatewayConfig);
  } catch (error) {
    gatewayDiagnostics.push({
      code: gatewayCompositionCodes.unknownContext,
      message: error instanceof Error ? error.message : 'Provider model context limit is unknown.',
      severity: 'warning',
      source: 'DATA_ROOT/config/providers/*.provider.jsonc',
    });
  }
  try {
    for (const model of resolveLogicalModelCatalog(
      gatewayConfig,
      providerRegistry,
      options.subscriptionAccounts,
      options.providerCredentialConfigured
    )) {
      for (const route of model.routes) {
        if (!route.available)
          gatewayDiagnostics.push({
            code: gatewayCompositionCodes.unavailableMember,
            message: `Logical model route ${route.id} is unavailable: ${route.unavailableReason}.`,
            severity: 'warning',
            source: 'DATA_ROOT/config/gateway.jsonc',
          });
      }
    }
  } catch (error) {
    gatewayDiagnostics.push({
      code: gatewayCompositionCodes.invalidLogicalModel,
      message:
        error instanceof Error ? error.message : 'Gateway logical model configuration is invalid.',
      severity: 'error',
      source: 'DATA_ROOT/config/gateway.jsonc',
    });
  }
  return gatewayDiagnostics;
}

/**
 * Creates a runtime config manager backed by one data root.
 *
 * @param options Manager construction input.
 * @returns Runtime config manager.
 */
export function createRuntimeConfigManager(
  options: RuntimeConfigManagerOptions
): RuntimeConfigManager {
  let current =
    options.initialSnapshot ??
    loadRuntimeConfig(requireDataRoot(options.dataRoot), {
      quarantineMalformedWorkspaceConfig: true,
      subscriptionAccounts: options.subscriptionAccounts,
      providerCredentialConfigured: options.providerCredentialConfigured,
    });
  options.captureCoverage?.setWorkspaceCaptureCoverageProjection?.(
    (workspaceId) => findWorkspaceConfig(current, workspaceId)?.config
  );
  let lastReload: RuntimeConfigReloadSummary | null = null;
  let lastFailedReload: RuntimeConfigReloadSummary | null = null;
  let pendingRestart: RuntimeConfigChange[] = [];
  let fenceNanoHostTransport: (() => Promise<void>) | undefined;
  let nanoHostTransportFenced = false;
  /**
   * Pushes the snapshot's capture pair onto the optional live store sink.
   *
   * @param snapshot Active or newly applied runtime snapshot.
   */
  const applyCaptureCoverage = (snapshot: RuntimeConfigSnapshot): void => {
    options.captureCoverage?.setLiveCaptureCoverage(
      captureCoverageBindingFromOpenKitConfig(snapshot.openKitConfig)
    );
  };
  applyCaptureCoverage(current);

  let publicationBinding: { db: CoreDb; publisherId: string } | undefined;
  let installation: Promise<void> | undefined;

  /** Uses the installed generation for restart-held fields before checking safe-mode compatibility. */
  function prepareReloadCandidate(dataRoot: string, mode: RuntimeConfigReloadRequest['mode']) {
    const previous = current;
    const candidate = loadRuntimeConfig(dataRoot, {
      version: previous.version + 1,
      subscriptionAccounts: options.subscriptionAccounts,
      providerCredentialConfigured: options.providerCredentialConfigured,
    });
    const plan = diffRuntimeConfig(previous, candidate);
    if (plan.rejected.length > 0) return { snapshot: candidate, plan };

    assertCatalogContextRemovalIsValid(previous, candidate);
    if (mode === 'strict' || plan.requiresRestart.length === 0)
      return { snapshot: candidate, plan };

    const snapshot = applySafeRuntimeConfigReload(previous, candidate, plan, options);
    const diagnostics = runtimeConfigPlanDiagnostics(snapshot);
    return {
      snapshot,
      plan: {
        ...plan,
        ...diagnostics,
        applied: diagnostics.rejected.length > 0 ? [] : plan.applied,
        deferred: diagnostics.rejected.length > 0 ? [] : plan.deferred,
      },
    };
  }

  /** Plans a replacement only when the validated public generation differs from boot. */
  async function checkListenerTlsCandidate(): Promise<RuntimeConfigChange | undefined> {
    if (!(await options.checkListenerTlsChange?.())) return;
    return change(
      LISTENER_TLS_PLAN_PATH,
      'restart-required',
      'requires-restart',
      'The configured TLS certificate generation requires a NanoCore restart.'
    );
  }

  /** One bounded handoff excludes competing installers; it does not queue configuration requests. */
  function installSnapshot(
    next: RuntimeConfigSnapshot,
    validate: () => void = () => {},
    installed: () => void = () => {}
  ) {
    if (installation) throw new Error('Runtime Policy publication is still pending.');
    const previous = current;
    const install = () => {
      validate();
      if (current !== previous)
        throw new Error('Runtime configuration changed during publication.');
      if (next !== previous) {
        current = next;
        installed();
        applyCaptureCoverage(current);
      }
    };
    if (!publicationBinding) {
      install();
      return;
    }
    const { db, publisherId } = publicationBinding;
    const client = getControlStoreWorkerClient();
    const identity = runtimePolicyIdentityForSnapshot(next);
    const handoff = (async () => {
      const observed = await client.runtimePolicyPublication(db, { kind: 'inspect' });
      if (observed.publisherId !== null && observed.publisherId !== publisherId)
        throw new Error('Native Policy publisher is unavailable.');
      validate();
      if (current !== previous)
        throw new Error('Runtime configuration changed during publication.');
      if (
        observed.state === 'active' &&
        observed.identity &&
        sameRuntimePolicyIdentity(observed.identity, identity) &&
        sameRuntimePolicyIdentity(runtimePolicyIdentityForSnapshot(previous), identity)
      ) {
        install();
        return;
      }
      const transitionId = randomUUID();
      const target = { openingId: observed.openingId, publisherId, transitionId };
      await client.runtimePolicyPublication(db, {
        kind: 'close',
        ...target,
        expectedTransitionId: observed.transitionId,
      });
      // No awaited operation separates fresh validation from installation of the actual snapshot.
      install();
      await client.runtimePolicyPublication(db, { kind: 'activate', ...target, identity });
    })();
    const pending = handoff.finally(() => {
      if (installation === pending) installation = undefined;
    });
    installation = pending;
    // App startup can bind synchronously; consumers still await this original readiness result.
    void pending.catch(() => {});
    return pending;
  }

  async function bindNativePolicyPublication(coreDb: CoreDb): Promise<void> {
    if (!options.dataRoot || resolve(options.dataRoot) !== resolve(coreDb.dataRoot))
      throw new Error('Native Policy publication requires the exact manager data root.');
    if (publicationBinding && resolve(publicationBinding.db.dataRoot) !== resolve(coreDb.dataRoot))
      throw new Error('Native Policy publication cannot change its data root.');
    publicationBinding ??= { db: coreDb, publisherId: randomUUID() };
    publicationBinding.db = coreDb;
    if (installation) return installation;
    await installSnapshot(current);
  }

  return {
    current: () => current,
    bindNativePolicyPublication,
    publishWorkspaceConfiguration: async (workspaceId, name) => {
      WorkspaceIdSchema.parse(workspaceId);
      // Concurrent Workspace commands join the existing handoff before composing their own snapshot.
      while (installation) await installation;
      const previous = findWorkspaceConfig(current, workspaceId);
      if (previous?.config.workspace.name === name) {
        // A prior activation acknowledgement may have failed after installation.
        await installSnapshot(current);
        return;
      }
      const diagnostics: RuntimeConfigDiagnostic[] = [];
      const loaded =
        previous ??
        loadWorkspaceConfigs(requireDataRoot(options.dataRoot), diagnostics, workspaceId)[0];
      if (!loaded) throw new Error('Committed Workspace configuration is unavailable.');
      // A name edit owns only that field. Saved Policy and preference edits still require explicit reload.
      const config = WorkspaceConfigSchema.parse({
        ...loaded.config,
        workspace: { ...loaded.config.workspace, name },
      });
      await installSnapshot(
        createRuntimeConfigSnapshot({
          ...current,
          dataRoot: requireDataRoot(options.dataRoot),
          version: current.version + 1,
          loadedAt: new Date().toISOString(),
          workspaceConfigs: replaceWorkspaceConfigEntries(
            current.workspaceConfigs,
            [{ ...loaded, config }],
            workspaceId
          ),
          diagnostics: [...current.diagnostics, ...diagnostics],
        })
      );
    },
    getDataRoot: () => options.dataRoot,
    reloadRecoveredWorkspace: (workspaceId, freeze) => {
      if (installation) throw new Error('Runtime Policy publication is still pending.');
      WorkspaceIdSchema.parse(workspaceId);
      const dataRoot = requireDataRoot(options.dataRoot);
      if (!getControlStoreWorkerClient().ownsWorkspaceFreeze(dataRoot, workspaceId, freeze))
        throw new Error('Workspace recovery freeze is not current.');
      const diagnostics: RuntimeConfigDiagnostic[] = [];
      const configs = loadWorkspaceConfigs(dataRoot, diagnostics, workspaceId);
      if (configs.length !== 1) throw new Error('Restored Workspace configuration is unavailable.');
      const dataSources = loadWorkspaceDataSourceCatalogs(dataRoot, diagnostics, workspaceId);
      const mcpServers = loadWorkspaceMcpServerCatalogs(dataRoot, workspaceId);
      const sources = new Set([
        `DATA_ROOT/workspaces/${workspaceId}/config/workspace.jsonc`,
        `DATA_ROOT/workspaces/${workspaceId}/config/data-sources.jsonc`,
        `DATA_ROOT/workspaces/${workspaceId}/catalog/catalog.json`,
      ]);
      const next = createRuntimeConfigSnapshot({
        ...current,
        dataRoot,
        version: current.version + 1,
        loadedAt: new Date().toISOString(),
        workspaceConfigs: replaceWorkspaceConfigEntries(
          current.workspaceConfigs,
          configs,
          workspaceId
        ),
        workspaceDataSourceCatalogs: replaceWorkspaceConfigEntries(
          current.workspaceDataSourceCatalogs,
          dataSources,
          workspaceId
        ),
        workspaceMcpServerCatalogs: replaceWorkspaceConfigEntries(
          current.workspaceMcpServerCatalogs,
          mcpServers,
          workspaceId
        ),
        diagnostics: [
          ...current.diagnostics.filter((entry) => !sources.has(entry.source)),
          ...diagnostics,
        ],
      });
      const ready = installSnapshot(next, () => {
        if (!getControlStoreWorkerClient().ownsWorkspaceFreeze(dataRoot, workspaceId, freeze))
          throw new Error('Workspace recovery freeze is not current.');
      });
      return ready instanceof Promise ? ready.then(() => current) : current;
    },
    prepareReloadCandidate,
    checkListenerTlsCandidate,
    reload: (input) => {
      const startedAt = new Date().toISOString();
      let nextVersion = current.version + 1;
      const respond = (
        status: RuntimeConfigReloadResponse['status'],
        plan: RuntimeConfigReloadPlan
      ) => {
        const fence =
          !input.dryRun &&
          !nanoHostTransportFenced &&
          plan.requiresRestart.some((entry) => entry.path.startsWith('nanohost.'))
            ? fenceNanoHostTransport
            : undefined;
        // Latch before native readiness I/O. A failed acknowledgement must leave admission closed.
        if (fence) nanoHostTransportFenced = true;
        const response = {
          status,
          runtimeConfig: createRuntimeConfigStatus(),
          plan: reportCurrentRestart(plan),
        };
        return fence ? fence().then(() => response) : response;
      };
      const failed = (error: unknown) => {
        const message = redactRuntimeConfigReloadError(error, options.dataRoot);
        const plan = failedReloadPlan(current, nextVersion, message);

        lastFailedReload = reloadSummary(
          startedAt,
          input,
          current.version,
          current.version,
          'failed',
          message
        );

        return respond('failed', plan);
      };

      const run = (tlsRestart?: RuntimeConfigChange) => {
        nextVersion = current.version + 1;
        try {
          if (installation) throw new Error('Runtime Policy publication is still pending.');
          const { snapshot, plan: authoredPlan } = prepareReloadCandidate(
            requireDataRoot(options.dataRoot),
            input.mode
          );
          assertNoBlockingDiagnostics(snapshot);
          const plan = tlsRestart
            ? { ...authoredPlan, requiresRestart: [...authoredPlan.requiresRestart, tlsRestart] }
            : authoredPlan;

          if (input.mode === 'strict' && plan.requiresRestart.length > 0) {
            pendingRestart = plan.requiresRestart;
            lastReload = reloadSummary(
              startedAt,
              input,
              current.version,
              current.version,
              'rejected'
            );

            return respond('rejected', {
              ...plan,
              rejected: [
                ...plan.rejected,
                ...plan.requiresRestart.map((change) => ({
                  ...change,
                  action: 'rejected' as const,
                  category: 'rejected' as const,
                })),
              ],
            });
          }

          if (input.dryRun) {
            lastReload = reloadSummary(
              startedAt,
              input,
              current.version,
              current.version,
              'dry-run'
            );

            return respond('dry-run', plan);
          }

          const ready = installSnapshot(snapshot, undefined, () => {
            pendingRestart = plan.requiresRestart;
          });
          const complete = () => {
            lastReload = reloadSummary(
              startedAt,
              input,
              snapshot.version - 1,
              current.version,
              'applied'
            );
            return respond('applied', plan);
          };
          return ready instanceof Promise ? ready.then(complete, failed) : complete();
        } catch (error) {
          return failed(error);
        }
      };
      return options.checkListenerTlsChange ? checkListenerTlsCandidate().then(run, failed) : run();
    },
    bindNanoHostTransportFence: (fence) => {
      fenceNanoHostTransport = fence;
      return () => nanoHostTransportFenced;
    },
    reportCurrentRestart,
    status: createRuntimeConfigStatus,
  };

  /** A latched fence is a current process condition. It must stay outside candidate decisions. */
  function currentRestartReasons(restartChanges: RuntimeConfigChange[]): RuntimeConfigChange[] {
    if (!nanoHostTransportFenced) return restartChanges;
    return [
      ...restartChanges,
      change(
        NANO_HOST_TRANSPORT_RESTART_PATH,
        'restart-required',
        'requires-restart',
        'NanoHost transport admission is fenced until NanoCore restarts.'
      ),
    ];
  }

  /** Projects current restart reasons into a plan after candidate decisions finish. */
  function reportCurrentRestart(plan: RuntimeConfigReloadPlan): RuntimeConfigReloadPlan {
    return { ...plan, requiresRestart: currentRestartReasons(plan.requiresRestart) };
  }

  /** Creates status from the active snapshot, reload outcomes, and current restart reasons. */
  function createRuntimeConfigStatus(): RuntimeConfigStatus {
    return {
      currentVersion: current.version,
      loadedAt: current.loadedAt,
      lastReload,
      lastFailedReload,
      pendingRestart: currentRestartReasons(pendingRestart),
    };
  }
}

/** Rejects a catalog edit that removes the last context source for a still-listed model; new unknown models keep their warning. */
function assertCatalogContextRemovalIsValid(
  previous: RuntimeConfigSnapshot,
  next: RuntimeConfigSnapshot
): void {
  const profiles = next.providerRegistry.list().flatMap((profile) => {
    const before = previous.providerRegistry.get(profile.id);
    if (!before) return [];
    const key = before.vendor ?? before.id;
    const previousModels = previous.modelCatalog.providers[key]?.models;
    const nextModels = next.modelCatalog.providers[key]?.models;
    const models = profile.models.filter(
      (id) =>
        before.models.includes(id) &&
        previousModels?.[id]?.limit?.context !== undefined &&
        nextModels?.[id]?.limit?.context === undefined
    );
    return models.length ? [{ ...profile, models }] : [];
  });
  assertConfiguredModelsHaveKnownContext(new ProviderRegistry(profiles), next.gatewayConfig);
}

/**
 * Applies a runtime reload candidate while preserving restart-required live fields.
 *
 * @param previous Active runtime config snapshot.
 * @param next Candidate runtime config snapshot loaded from disk.
 * @param plan Semantic reload plan computed for the candidate.
 * @param options Active supply predicates for post-hold validation.
 * @returns Snapshot that exposes only changes safe for the running process.
 */
function applySafeRuntimeConfigReload(
  previous: RuntimeConfigSnapshot,
  next: RuntimeConfigSnapshot,
  plan: RuntimeConfigReloadPlan,
  options: LoadRuntimeConfigOptions
): RuntimeConfigSnapshot {
  const openKitConfig = cloneJsonValue(next.openKitConfig);
  const restartPaths = new Set(plan.requiresRestart.map((change) => change.path));
  const retainProviders = restartPaths.has('providers') || restartPaths.has('modelCatalog');
  const providerRegistry = retainProviders ? previous.providerRegistry : next.providerRegistry;
  let diagnostics = next.diagnostics;
  if (retainProviders) {
    // Unknown context in a saved Provider remains actionable before restart.
    const authoredContextWarning = diagnostics.find(
      (entry) => entry.code === gatewayCompositionCodes.unknownContext
    );
    diagnostics = [
      ...diagnostics.filter((entry) => !effectiveGatewayDiagnosticCodes.has(entry.code)),
      ...gatewayCompositionDiagnostics(next.gatewayConfig, providerRegistry, options).filter(
        (entry) =>
          entry.code !== gatewayCompositionCodes.unknownContext ||
          entry.message !== authoredContextWarning?.message
      ),
    ];
  }

  for (const restartChange of plan.requiresRestart) {
    // The optional NanoHost envelope has required children. Restore its whole prior shape across addition or removal so capacity cannot leave an invalid partial envelope.
    const path =
      restartChange.path.startsWith('nanohost.') &&
      (!previous.openKitConfig.nanohost || !next.openKitConfig.nanohost)
        ? 'nanohost'
        : restartChange.path;
    restorePath(openKitConfig, previous.openKitConfig, path);
  }

  return Object.freeze(
    createRuntimeConfigSnapshot({
      sources: next.sources,
      version: next.version,
      loadedAt: next.loadedAt,
      dataRoot: null,
      openKitConfig,
      modelCatalog: restartPaths.has('modelCatalog') ? previous.modelCatalog : next.modelCatalog,
      providerRegistry,
      providerDiagnostics: retainProviders
        ? previous.providerDiagnostics
        : next.providerDiagnostics,
      agentManifests: restartPaths.has('agents') ? previous.agentManifests : next.agentManifests,
      gatewayConfig: next.gatewayConfig,
      internalRoleProfiles: next.internalRoleProfiles,
      userConfigs: next.userConfigs,
      workspaceConfigs: next.workspaceConfigs,
      workspaceDataSourceCatalogs: next.workspaceDataSourceCatalogs,
      workspaceMcpServerCatalogs: next.workspaceMcpServerCatalogs,
      diagnostics,
    })
  );
}

/**
 * Clones JSON-compatible config data.
 *
 * @param value JSON-compatible config value.
 * @returns Deep cloned config value.
 */
function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Restores one dotted config path from the previous live config into a candidate config.
 *
 * @param target Candidate config object to mutate.
 * @param source Previous live config object.
 * @param path Dotted config path.
 */
function restorePath(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  path: string
): void {
  const parts = path.split('.');
  const sourceValue = readPath(source, path);
  let current: Record<string, unknown> = target;

  for (const part of parts.slice(0, -1)) {
    const next = current[part];

    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      current[part] = {};
    }

    current = current[part] as Record<string, unknown>;
  }

  const leaf = parts.at(-1);

  if (!leaf) {
    return;
  }

  if (sourceValue === undefined) {
    delete current[leaf];
    pruneEmptyPath(target, parts.slice(0, -1));
    return;
  }

  current[leaf] = cloneJsonValue(sourceValue);
}

/**
 * Removes empty objects left after restoring absent config fields.
 *
 * @param target Config object to prune.
 * @param path Dotted path parts to inspect.
 */
function pruneEmptyPath(target: Record<string, unknown>, path: string[]): void {
  for (let index = path.length; index > 0; index -= 1) {
    const parentPath = path.slice(0, index - 1);
    const key = path[index - 1];
    const parent = readObjectPath(target, parentPath);

    if (!key || !parent) {
      break;
    }

    const value = parent?.[key];

    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      delete parent[key];
      continue;
    }

    break;
  }
}

/**
 * Reads an object at a path of object keys.
 *
 * @param value Root object to read from.
 * @param path Object key path.
 * @returns Object at the path, or null.
 */
function readObjectPath(
  value: Record<string, unknown>,
  path: string[]
): Record<string, unknown> | null {
  return path.reduce<Record<string, unknown> | null>((current, part) => {
    if (!current) {
      return null;
    }

    const next = current[part];

    return typeof next === 'object' && next !== null && !Array.isArray(next)
      ? (next as Record<string, unknown>)
      : null;
  }, value);
}

/**
 * Creates an in-memory snapshot for callers that already have startup config pieces.
 *
 * @param input Runtime config snapshot input.
 * @returns Runtime config snapshot.
 */
export function createInMemoryRuntimeConfigSnapshot(
  input: RuntimeConfigSnapshotInput
): RuntimeConfigSnapshot {
  const providerState =
    input.providerRegistry || !input.dataRoot
      ? null
      : loadProviderRegistryFromDataRoot(input.dataRoot);
  const agentState =
    input.agentManifests || !input.dataRoot ? null : loadAgentManifests(input.dataRoot);

  return createRuntimeConfigSnapshot({
    dataRoot: input.dataRoot,
    openKitConfig: input.openKitConfig ?? {},
    modelCatalog: input.modelCatalog ??
      providerState?.modelCatalog ?? { schemaVersion: 1, providers: {} },
    providerRegistry:
      input.providerRegistry ?? providerState?.providerRegistry ?? new ProviderRegistry([]),
    providerDiagnostics:
      input.providerDiagnostics ??
      providerState?.providerDiagnostics ??
      createProviderDiagnostics({ profiles: [], diagnostics: [] }),
    agentManifests: input.agentManifests ?? agentState?.manifests ?? [],
    gatewayConfig:
      input.gatewayConfig ?? GatewayConfigSchema.parse({ schemaVersion: 1, logicalModels: [] }),
    internalRoleProfiles:
      input.internalRoleProfiles ??
      InternalRoleProfilesConfigSchema.parse({ schemaVersion: 1, profiles: [] }),
    userConfigs: (input.userConfigs ?? []).map((entry) => ({
      ...entry,
      config: UserConfigSchema.parse(entry.config),
    })),
    workspaceConfigs: (input.workspaceConfigs ?? []).map((entry) => ({
      ...entry,
      config: WorkspaceConfigSchema.parse(entry.config),
    })),
    workspaceDataSourceCatalogs: input.workspaceDataSourceCatalogs ?? [],
    workspaceMcpServerCatalogs: input.workspaceMcpServerCatalogs ?? [],
    version: input.version ?? 1,
    diagnostics: [],
    sources: [],
  });
}

/**
 * Computes a semantic reload plan between two snapshots.
 *
 * @param previous Active runtime config snapshot.
 * @param next Candidate runtime config snapshot.
 * @returns Runtime config reload plan.
 */
export function diffRuntimeConfig(
  previous: RuntimeConfigSnapshot,
  next: RuntimeConfigSnapshot
): RuntimeConfigReloadPlan {
  const applied: RuntimeConfigChange[] = [];
  const deferred: RuntimeConfigChange[] = [];
  const requiresRestart: RuntimeConfigChange[] = [];

  if (!equalSemantic(previous.modelCatalog, next.modelCatalog)) {
    requiresRestart.push(
      change(
        'modelCatalog',
        'restart-required',
        'requires-restart',
        'Model extension catalog changes require restart.'
      )
    );
  }
  if (!equalSemantic(providerSummary(previous), providerSummary(next))) {
    requiresRestart.push(
      change(
        'providers',
        'restart-required',
        'requires-restart',
        'Provider registry changes require restart.'
      )
    );
  }
  if (
    (previous.openKitConfig.security?.pauseAgentWork ?? false) !==
    (next.openKitConfig.security?.pauseAgentWork ?? false)
  ) {
    applied.push(
      change(
        'security.pauseAgentWork',
        'hot-swappable',
        'applied',
        'Agent work pause changed for admission and dispatch.'
      )
    );
  }
  if (!equalSemantic(previous.openKitConfig.defaults ?? {}, next.openKitConfig.defaults ?? {})) {
    applied.push(change('defaults', 'hot-swappable', 'applied', 'Runtime defaults changed.'));
  }
  if (
    !equalSemantic(
      previous.openKitConfig.policy?.workDataCapture,
      next.openKitConfig.policy?.workDataCapture
    )
  ) {
    applied.push(
      change(
        'policy.workDataCapture',
        'hot-swappable',
        'applied',
        'Work-data capture switch changed for later Turns.'
      )
    );
  }
  if (
    !equalSemantic(previous.openKitConfig.policy?.mediation, next.openKitConfig.policy?.mediation)
  ) {
    applied.push(
      change(
        'policy.mediation',
        'hot-swappable',
        'applied',
        'Authored Policy statements changed; native admission rechecks their exact revision before effects.'
      )
    );
  }
  if (!equalSemantic(previous.gatewayConfig, next.gatewayConfig)) {
    applied.push(
      change(
        'gateway',
        'hot-swappable',
        'applied',
        'Gateway logical models or private routes changed.'
      )
    );
  }
  if (!equalSemantic(agentSummary(previous), agentSummary(next))) {
    deferred.push(
      change(
        'agents',
        'session-scoped',
        'deferred',
        'Agent config changed for later composed setups and Turns.'
      )
    );
  }
  if (!equalSemantic(previous.internalRoleProfiles, next.internalRoleProfiles)) {
    deferred.push(
      change(
        'internalRoles',
        'session-scoped',
        'deferred',
        'Internal-role profiles changed for later role executions.'
      )
    );
  }
  if (!equalSemantic(previous.userConfigs, next.userConfigs)) {
    applied.push(change('users', 'hot-swappable', 'applied', 'User preferences changed.'));
  }
  if (!equalSemantic(workspaceConfigSummary(previous), workspaceConfigSummary(next))) {
    deferred.push(
      change(
        'workspaces',
        'session-scoped',
        'deferred',
        'Workspace config changed for future sessions.'
      )
    );
  }
  if (
    !equalSemantic(
      workspaceDataSourceCatalogSummary(previous),
      workspaceDataSourceCatalogSummary(next)
    )
  ) {
    deferred.push(
      change(
        'workspaceDataSources',
        'session-scoped',
        'deferred',
        'Workspace data source catalog changed for future sessions.'
      )
    );
  }
  if (
    !equalSemantic(
      workspaceMcpServerCatalogSummary(previous),
      workspaceMcpServerCatalogSummary(next)
    )
  ) {
    deferred.push(
      change(
        'workspaceMcpServers',
        'session-scoped',
        'deferred',
        'Workspace MCP server catalog changed for future sessions.'
      )
    );
  }

  for (const path of RESTART_REQUIRED_CONFIG_PATHS) {
    if (
      !equalSemantic(readPath(previous.openKitConfig, path), readPath(next.openKitConfig, path))
    ) {
      requiresRestart.push(
        change(path, 'restart-required', 'requires-restart', `${path} requires restart.`)
      );
    }
  }

  return {
    previousVersion: previous.version,
    nextVersion: next.version,
    applied,
    deferred,
    requiresRestart,
    ...runtimeConfigPlanDiagnostics(next),
  };
}

/**
 * Finds a parsed workspace config in one runtime snapshot.
 *
 * @param snapshot Runtime config snapshot to search.
 * @param workspaceId Workspace id to find.
 * @returns Loaded workspace config, or null when no file exists.
 */
export function findWorkspaceConfig(
  snapshot: RuntimeConfigSnapshot,
  workspaceId: string
): LoadedWorkspaceConfig | null {
  return snapshot.workspaceConfigs.find((config) => config.workspaceId === workspaceId) ?? null;
}

/**
 * Resolves the shared Workspace Agent preference and final Server fallback.
 *
 * @param snapshot Runtime config snapshot to inspect.
 * @param workspaceId Workspace whose default Agent should be selected.
 * @returns Selected Agent id, or null when neither scope selects one.
 */
export function resolveDefaultAgentId(
  snapshot: RuntimeConfigSnapshot,
  workspaceId: string,
  userId?: string
): string | null {
  return (
    findUserWorkspacePreference(snapshot, userId, workspaceId)?.agentId ??
    findWorkspaceConfig(snapshot, workspaceId)?.config.workspace.defaultAgentId ??
    snapshot.openKitConfig.defaults?.defaultAgentId ??
    null
  );
}

/** Finds one User's personal preference for a Workspace. */
export function findUserWorkspacePreference(
  snapshot: RuntimeConfigSnapshot,
  userId: string | undefined,
  workspaceId: string
): UserConfig['workspaces'][number] | null {
  if (!userId) {
    return null;
  }
  return (
    snapshot.userConfigs
      .find((entry) => entry.userId === userId)
      ?.config.workspaces.find((workspace) => workspace.workspaceId === workspaceId) ?? null
  );
}

/**
 * Rejects candidate snapshots that contain blocking loader diagnostics.
 *
 * @param snapshot Candidate runtime config snapshot.
 */
function assertNoBlockingDiagnostics(snapshot: RuntimeConfigSnapshot): void {
  const diagnostics = snapshot.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');

  if (diagnostics.length === 0) {
    return;
  }

  throw new Error(
    `Runtime config has blocking diagnostics: ${diagnostics
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
      .join('; ')}`
  );
}

/**
 * Creates one runtime config snapshot from resolved pieces.
 *
 * @param input Snapshot construction input.
 * @returns Runtime config snapshot.
 */
function createRuntimeConfigSnapshot(
  input: RuntimeConfigSnapshotConstructionInput
): RuntimeConfigSnapshot {
  const loadedAt = input.loadedAt ?? new Date().toISOString();
  const snapshot = {
    ...input,
    loadedAt,
    contentHash: '',
  };

  return {
    ...snapshot,
    contentHash: sha256CanonicalJson(snapshotSemanticSummary(snapshot)),
  };
}

/**
 * Maps OpenKit config loader diagnostics into runtime config diagnostics.
 */
function configDiagnostic(diagnostic: OpenKitConfigDiagnostic): RuntimeConfigDiagnostic {
  return {
    code: 'openkit_config.warning',
    message: diagnostic.message,
    severity: diagnostic.severity,
    source: 'DATA_ROOT/config/server.jsonc',
  };
}

/** Adds located, value-free warnings for ignored fields in one authored file. */
function addUnknownConfigDiagnostics(
  diagnostics: RuntimeConfigDiagnostic[],
  kind: TolerantConfigKind,
  raw: unknown,
  parsed: unknown,
  dataRoot: string,
  path: string
): void {
  const source = `DATA_ROOT/${relative(dataRoot, path)}`;
  for (const key of unknownConfigKeys(kind, raw, parsed)) {
    diagnostics.push({
      code: 'authored_config.unknown_key',
      message: unknownConfigKeyMessage(key),
      severity: 'warning',
      source,
    });
  }
}

/**
 * Creates one reload summary.
 */
function reloadSummary(
  at: string,
  input: RuntimeConfigReloadRequest,
  previousVersion: number,
  currentVersion: number,
  status: RuntimeConfigReloadSummary['status'],
  message: string | null = null
): RuntimeConfigReloadSummary {
  return {
    at,
    dryRun: input.dryRun ?? false,
    mode: input.mode,
    previousVersion,
    currentVersion,
    status,
    message,
  };
}

/**
 * Creates one failed reload plan.
 */
function failedReloadPlan(
  current: RuntimeConfigSnapshot,
  nextVersion: number,
  message: string
): RuntimeConfigReloadPlan {
  return {
    previousVersion: current.version,
    nextVersion,
    applied: [],
    deferred: [],
    requiresRestart: [],
    rejected: [
      change('config', 'rejected', 'rejected', `Runtime config reload failed: ${message}`),
    ],
    warnings: runtimeConfigWarnings(current),
  };
}

/** Keeps plans tied to the diagnostics of the snapshot the caller would install. */
function runtimeConfigPlanDiagnostics(
  snapshot: RuntimeConfigSnapshot
): Pick<RuntimeConfigReloadPlan, 'rejected' | 'warnings'> {
  return {
    rejected: snapshot.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
      ? [
          change(
            'config.diagnostics',
            'rejected',
            'rejected',
            'Runtime config contains blocking diagnostics.'
          ),
        ]
      : [],
    warnings: runtimeConfigWarnings(snapshot),
  };
}

/** Projects warning diagnostics through the existing redacted reload-plan channel. */
function runtimeConfigWarnings(
  snapshot: RuntimeConfigSnapshot
): RuntimeConfigReloadPlan['warnings'] {
  return snapshot.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'warning')
    .map((diagnostic) => ({
      code: diagnostic.code,
      message: `${diagnostic.source}: ${diagnostic.message}`,
    }));
}

/**
 * Redacts the configured data root from one reload failure.
 *
 * @param error Reload failure to project.
 * @param dataRoot Configured data root that must not enter public errors.
 * @returns Product-safe reload failure message.
 */
function redactRuntimeConfigReloadError(error: unknown, dataRoot: string | null): string {
  const message = error instanceof Error ? error.message : String(error);

  return dataRoot ? message.replaceAll(dataRoot, 'DATA_ROOT') : message;
}

/**
 * Creates one redacted runtime config change.
 */
function change(
  path: string,
  category: RuntimeConfigChange['category'],
  action: RuntimeConfigChange['action'],
  summary: string
): RuntimeConfigChange {
  return { path, category, action, summary };
}

/**
 * Requires a data root for live reload.
 */
function requireDataRoot(dataRoot: string | null): string {
  if (!dataRoot) {
    throw new Error('Runtime config reload requires a data root.');
  }

  return dataRoot;
}

/**
 * Reads a dotted path from an object.
 */
function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (typeof current !== 'object' || current === null || !(part in current)) {
      return undefined;
    }

    return (current as Record<string, unknown>)[part];
  }, value);
}

/**
 * Returns provider registry semantics with secret-bearing values fingerprinted.
 */
function providerSummary(snapshot: RuntimeConfigSnapshot): unknown {
  return snapshot.providerRegistry.list().map((profile) => redactSemanticSecrets(profile));
}

/**
 * Returns authored agent config semantics.
 */
function agentSummary(snapshot: RuntimeConfigSnapshot): unknown {
  return snapshot.agentManifests;
}

/**
 * Returns gateway fields that are safe to apply to future requests.
 */
/**
 * Creates a semantic snapshot summary for hashing.
 */
function snapshotSemanticSummary(snapshot: Omit<RuntimeConfigSnapshot, 'contentHash'>): unknown {
  return {
    openKitConfig: redactSemanticSecrets(snapshot.openKitConfig),
    providers: providerSummary(snapshot as RuntimeConfigSnapshot),
    modelCatalog: snapshot.modelCatalog,
    agentManifests: snapshot.agentManifests,
    gatewayConfig: snapshot.gatewayConfig,
    internalRoleProfiles: snapshot.internalRoleProfiles,
    userConfigs: snapshot.userConfigs,
    workspaceConfigs: workspaceConfigSummary(snapshot as RuntimeConfigSnapshot),
    workspaceDataSourceCatalogs: workspaceDataSourceCatalogSummary(
      snapshot as RuntimeConfigSnapshot
    ),
    workspaceMcpServerCatalogs: workspaceMcpServerCatalogSummary(snapshot as RuntimeConfigSnapshot),
  };
}

/** Loads a Server-scoped JSONC file, preserving known-field validation and reporting supported additive-key warnings. */
function loadServerScopedConfig<T>(
  path: string,
  schema: z.ZodType<T>,
  empty: unknown,
  warningContext?: {
    diagnostics: RuntimeConfigDiagnostic[];
    dataRoot: string;
    kind: TolerantConfigKind;
  }
): T {
  if (!existsSync(path)) {
    return schema.parse(empty);
  }
  const raw = parseJsoncObject(readFileSync(path, 'utf8'), path);
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid runtime config ${path}: ${z.prettifyError(result.error)}`);
  }
  if (warningContext)
    addUnknownConfigDiagnostics(
      warningContext.diagnostics,
      warningContext.kind,
      raw,
      result.data,
      warningContext.dataRoot,
      path
    );
  return result.data;
}

/** Loads every personal User preference config under DATA_ROOT/users. */
function loadUserConfigs(
  dataRoot: string,
  diagnostics: RuntimeConfigDiagnostic[]
): LoadedUserConfig[] {
  const usersRoot = join(dataRoot, 'users');
  if (!existsSync(usersRoot)) {
    return [];
  }

  const configs: LoadedUserConfig[] = [];
  for (const userEntry of readdirSync(usersRoot, { withFileTypes: true }).sort((left, right) =>
    compareCodeUnits(left.name, right.name)
  )) {
    if (!userEntry.isDirectory()) {
      continue;
    }
    const path = join(usersRoot, userEntry.name, 'config', 'user.jsonc');
    if (!existsSync(path)) {
      continue;
    }
    const parsed = parseJsoncObject(readFileSync(path, 'utf8'), path);
    const result = UserConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid User config ${path}: ${z.prettifyError(result.error)}`);
    }
    addUnknownConfigDiagnostics(diagnostics, 'user', parsed, result.data, dataRoot, path);
    configs.push({ userId: userEntry.name, path, config: result.data });
  }
  return configs;
}

/** Selects one admitted recovery target or the normal sorted Workspace directory census. */
function workspaceConfigDirectories(root: string, workspaceId?: string): string[] {
  if (workspaceId !== undefined) return [workspaceId];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareCodeUnits);
}

/** Replaces the target entry without changing sibling values or their order. */
function replaceWorkspaceConfigEntries<T extends { workspaceId: string }>(
  previous: readonly T[],
  replacement: readonly T[],
  workspaceId: string
): T[] {
  let replaced = false;
  const result = previous.flatMap((entry) => {
    if (entry.workspaceId !== workspaceId) return [entry];
    replaced = true;
    return [...replacement];
  });
  return replaced ? result : [...result, ...replacement];
}

/**
 * Loads every workspace config under DATA_ROOT/workspaces.
 *
 * @param dataRoot Data root to scan.
 * @returns Parsed workspace configs.
 */
function loadWorkspaceConfigs(
  dataRoot: string,
  diagnostics: RuntimeConfigDiagnostic[],
  workspaceId?: string,
  quarantinedWorkspaceIds?: Set<string>
): LoadedWorkspaceConfig[] {
  const workspacesRoot = join(dataRoot, 'workspaces');

  if (!existsSync(workspacesRoot)) {
    return [];
  }

  const configs: LoadedWorkspaceConfig[] = [];

  for (const id of workspaceConfigDirectories(workspacesRoot, workspaceId)) {
    const configPath = join(workspacesRoot, id, 'config', 'workspace.jsonc');

    if (!existsSync(configPath)) {
      continue;
    }

    if (quarantinedWorkspaceIds) {
      try {
        const parsed = parseJsoncObject(readFileSync(configPath, 'utf8'), configPath);
        const result = readRetainedV1(parsed, (record) => WorkspaceConfigSchema.safeParse(record));
        if (!result.success) {
          quarantineMalformedWorkspaceConfig(dataRoot, id, quarantinedWorkspaceIds);
          continue;
        }
        addUnknownConfigDiagnostics(
          diagnostics,
          'workspace',
          parsed,
          result.data,
          dataRoot,
          configPath
        );
        configs.push({
          workspaceId: id,
          path: configPath,
          config: result.data,
        });
      } catch {
        // Keep the original bytes. One Workspace cannot refuse the server load.
        quarantineMalformedWorkspaceConfig(dataRoot, id, quarantinedWorkspaceIds);
      }
      continue;
    }

    const parsed = parseJsoncObject(readFileSync(configPath, 'utf8'), configPath);
    let result: ReturnType<typeof WorkspaceConfigSchema.safeParse>;
    try {
      result = readRetainedV1(parsed, (record) => WorkspaceConfigSchema.safeParse(record));
    } catch {
      throw new Error(
        `Invalid workspace config ${configPath}: Unsupported retained record format.`
      );
    }
    if (!result.success) {
      throw new Error(`Invalid workspace config ${configPath}: ${z.prettifyError(result.error)}`);
    }
    addUnknownConfigDiagnostics(
      diagnostics,
      'workspace',
      parsed,
      result.data,
      dataRoot,
      configPath
    );
    configs.push({
      workspaceId: id,
      path: configPath,
      config: result.data,
    });
  }

  return configs;
}

/** Records the existing scope quarantine and excludes this Workspace from the current load. */
function quarantineMalformedWorkspaceConfig(
  dataRoot: string,
  workspaceId: string,
  quarantinedWorkspaceIds: Set<string>
): void {
  quarantinedWorkspaceIds.add(workspaceId);
  refuseScope(dataRoot, { scope: 'workspace', id: workspaceId, check: 'records' });
}

/**
 * Loads every workspace data source catalog under DATA_ROOT/workspaces.
 *
 * @param dataRoot Data root to scan.
 * @returns Parsed workspace data source catalogs.
 */
function loadWorkspaceDataSourceCatalogs(
  dataRoot: string,
  diagnostics: RuntimeConfigDiagnostic[],
  workspaceId?: string,
  quarantinedWorkspaceIds?: ReadonlySet<string>
): LoadedWorkspaceDataSourceCatalog[] {
  const workspacesRoot = join(dataRoot, 'workspaces');

  if (!existsSync(workspacesRoot)) {
    return [];
  }

  const catalogs: LoadedWorkspaceDataSourceCatalog[] = [];

  for (const id of workspaceConfigDirectories(workspacesRoot, workspaceId)) {
    if (quarantinedWorkspaceIds?.has(id)) continue;
    const catalogPath = join(workspacesRoot, id, 'config', 'data-sources.jsonc');

    if (!existsSync(catalogPath)) {
      continue;
    }

    const parsed = parseJsoncObject(readFileSync(catalogPath, 'utf8'), catalogPath);
    const catalog = parseWorkspaceDataSourceCatalog(parsed);
    addUnknownConfigDiagnostics(diagnostics, 'data-source', parsed, catalog, dataRoot, catalogPath);

    catalogs.push({
      workspaceId: id,
      path: catalogPath,
      catalog,
    });
  }

  return catalogs;
}

/** Loads every Workspace MCP server catalog under DATA_ROOT/workspaces. */
function loadWorkspaceMcpServerCatalogs(
  dataRoot: string,
  workspaceId?: string,
  quarantinedWorkspaceIds?: ReadonlySet<string>
): LoadedWorkspaceMcpServerCatalog[] {
  const workspacesRoot = join(dataRoot, 'workspaces');
  if (!existsSync(workspacesRoot)) return [];
  const catalogs: LoadedWorkspaceMcpServerCatalog[] = [];
  for (const id of workspaceConfigDirectories(workspacesRoot, workspaceId)) {
    if (quarantinedWorkspaceIds?.has(id)) continue;
    const catalogPath = join(workspacesRoot, id, 'catalog', 'catalog.json');
    if (!existsSync(catalogPath)) continue;
    catalogs.push({
      workspaceId: id,
      path: catalogPath,
      catalog: projectEffectiveWorkspaceMcpCatalog(loadWorkspaceResourceCatalog(dataRoot, id)),
    });
  }
  return catalogs;
}

/**
 * Returns stable workspace config semantics for diffing and hashing.
 */
function workspaceConfigSummary(snapshot: RuntimeConfigSnapshot): unknown {
  return snapshot.workspaceConfigs.map((entry) => ({
    workspaceId: entry.workspaceId,
    config: entry.config,
  }));
}

/**
 * Returns stable workspace data source catalog semantics for diffing and hashing.
 */
function workspaceDataSourceCatalogSummary(snapshot: RuntimeConfigSnapshot): unknown {
  return snapshot.workspaceDataSourceCatalogs.map((entry) => ({
    workspaceId: entry.workspaceId,
    catalog: entry.catalog,
  }));
}

/** Returns stable Workspace MCP catalog semantics for diffing and hashing. */
function workspaceMcpServerCatalogSummary(snapshot: RuntimeConfigSnapshot): unknown {
  return snapshot.workspaceMcpServerCatalogs.map((entry) => ({
    workspaceId: entry.workspaceId,
    catalog: entry.catalog,
  }));
}

/**
 * Compares two values after stable serialization.
 */
function equalSemantic(left: unknown, right: unknown): boolean {
  // Missing optional config is an absence comparison, outside the structured-value encoder.
  if (left === undefined || right === undefined) return left === right;
  return canonicalJsonText(left) === canonicalJsonText(right);
}

/**
 * Redacts or fingerprints secret-bearing semantic values.
 */
function redactSemanticSecrets(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSemanticSecrets(item));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactSemanticSecrets(entryValue, entryKey),
      ])
    );
  }

  if (isSecretKey(key)) {
    return value === undefined || value === null
      ? value
      : `secret:${sha256CanonicalJson(value).slice(0, 12)}`;
  }

  return value;
}

/**
 * Checks whether a key commonly carries secrets.
 */
function isSecretKey(key: string): boolean {
  return /apiKey|token|secret|clientSecret|auth/i.test(key);
}

/**
 * Redacts a source path for diagnostics.
 */
function redactSourcePath(path: string): string {
  const marker = 'config/';
  const index = path.lastIndexOf(marker);

  return index >= 0 ? path.slice(index) : (path.split('/').at(-1) ?? path);
}
