import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  RuntimeConfigChangeSchema,
  RuntimeConfigReloadPlanSchema,
  RuntimeConfigReloadRequest,
  RuntimeConfigReloadResponse,
  RuntimeConfigReloadSummarySchema,
  RuntimeConfigStaleSessionSchema,
  RuntimeConfigStatus,
} from '@openkit/app-api-schemas';
import {
  parseWorkspaceDataSourceCatalog,
  type WorkspaceConfig,
  WorkspaceConfigSchema,
  type WorkspaceDataSourceCatalog,
} from '@openkit/config-schema';
import { z } from 'zod';
import type { AgentManifest } from '../agents/manifest.js';

import { loadProviderRegistryFromDataRoot } from '../providers/data-root.js';
import type { ProviderDiagnosticsSnapshot } from '../providers/diagnostics.js';
import { createProviderDiagnostics } from '../providers/diagnostics.js';
import { ProviderRegistry } from '../providers/registry.js';
import { loadAgentManifests } from './agents-loader.js';
import { parseJsoncObject } from './jsonc.js';
import {
  loadOpenKitConfigWithDiagnostics,
  type OpenKitConfig,
  type OpenKitConfigDiagnostic,
} from './openkit-config.js';

type RuntimeConfigChange = z.infer<typeof RuntimeConfigChangeSchema>;
type RuntimeConfigReloadPlan = z.infer<typeof RuntimeConfigReloadPlanSchema>;
type RuntimeConfigReloadSummary = z.infer<typeof RuntimeConfigReloadSummarySchema>;
type RuntimeConfigStaleSession = z.infer<typeof RuntimeConfigStaleSessionSchema>;
type RuntimeConfigStaleSessionInput = Omit<RuntimeConfigStaleSession, 'choices'> & {
  choices?: RuntimeConfigStaleSession['choices'];
};

interface RuntimeConfigSnapshotConstructionInput {
  dataRoot: string | null;
  version: number;
  loadedAt?: string;
  sources: RuntimeConfigSource[];
  openKitConfig: OpenKitConfig;
  providerRegistry: ProviderRegistry;
  providerDiagnostics: ProviderDiagnosticsSnapshot;
  agentManifests: AgentManifest[];
  workspaceConfigs: LoadedWorkspaceConfig[];
  workspaceDataSourceCatalogs: LoadedWorkspaceDataSourceCatalog[];
  diagnostics: RuntimeConfigDiagnostic[];
}

/**
 * Runtime config source input loaded from disk.
 */
interface RuntimeConfigSource {
  /** Source kind. */
  kind:
    | 'server-config'
    | 'provider-profiles'
    | 'agent-configs'
    | 'workspace-configs'
    | 'workspace-data-source-catalogs';
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
  /** Redacted provider diagnostics. */
  providerDiagnostics: ProviderDiagnosticsSnapshot;
  /** Authored agent manifests. */
  agentManifests: AgentManifest[];
  /** Parsed workspace configs discovered under DATA_ROOT/workspaces. */
  workspaceConfigs: LoadedWorkspaceConfig[];
  /** Parsed workspace data source catalogs discovered under DATA_ROOT/workspaces. */
  workspaceDataSourceCatalogs: LoadedWorkspaceDataSourceCatalog[];
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
}

/**
 * Runtime config manager construction input.
 */
interface RuntimeConfigManagerOptions {
  /** Data root to reload from. */
  dataRoot: string | null;
  /** Optional initial snapshot for tests or already-loaded startup state. */
  initialSnapshot?: RuntimeConfigSnapshot;
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
  /** Provider diagnostics. */
  providerDiagnostics?: ProviderDiagnosticsSnapshot;
  /** Authored agent manifests. */
  agentManifests?: AgentManifest[];
  /** Parsed workspace configs. */
  workspaceConfigs?: LoadedWorkspaceConfig[];
  /** Parsed workspace data source catalogs. */
  workspaceDataSourceCatalogs?: LoadedWorkspaceDataSourceCatalog[];
  /** Snapshot version. */
  version?: number;
}

/**
 * Last-known-good runtime config manager.
 */
export interface RuntimeConfigManager {
  /** Returns the active runtime config snapshot. */
  current(): RuntimeConfigSnapshot;
  /** Reloads runtime config from the configured data root. */
  reload(input: RuntimeConfigReloadRequest): RuntimeConfigReloadResponse;
  /** Returns redacted runtime config status. */
  status(staleSessions?: RuntimeConfigStaleSession[]): RuntimeConfigStatus;
}

const RESTART_REQUIRED_CONFIG_PATHS = [
  'mode',
  'auth',
  'server',
  'gateway.openaiCompatible.enabled',
  'vault',
] as const;

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
  const providerLoadResult = loadProviderRegistryFromDataRoot(dataRoot, configLoadResult.config);
  const agentLoadResult = loadAgentManifests(dataRoot);
  const workspaceConfigs = loadWorkspaceConfigs(dataRoot);
  const workspaceDataSourceCatalogs = loadWorkspaceDataSourceCatalogs(dataRoot);
  const diagnostics: RuntimeConfigDiagnostic[] = [
    ...configLoadResult.diagnostics.map(configDiagnostic),
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
  ];
  const snapshot = createRuntimeConfigSnapshot({
    dataRoot,
    openKitConfig: configLoadResult.config,
    providerRegistry: providerLoadResult.providerRegistry,
    providerDiagnostics: providerLoadResult.providerDiagnostics,
    agentManifests: agentLoadResult.manifests,
    workspaceConfigs,
    workspaceDataSourceCatalogs,
    version: options.version ?? 1,
    diagnostics,
    sources: [
      {
        kind: 'server-config',
        path: configLoadResult.path ?? 'DATA_ROOT/config/server.jsonc',
      },
      { kind: 'provider-profiles', path: 'DATA_ROOT/config/providers/*.provider.jsonc' },
      { kind: 'agent-configs', path: 'DATA_ROOT/config/agents/*.agent.jsonc' },
      { kind: 'workspace-configs', path: 'DATA_ROOT/workspaces/*/config/workspace.jsonc' },
      {
        kind: 'workspace-data-source-catalogs',
        path: 'DATA_ROOT/workspaces/*/config/data-sources.jsonc',
      },
    ],
    ...(options.loadedAt ? { loadedAt: options.loadedAt } : {}),
  });

  return Object.freeze(snapshot);
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
  let current = options.initialSnapshot ?? loadRuntimeConfig(requireDataRoot(options.dataRoot));
  let lastReload: RuntimeConfigReloadSummary | null = null;
  let lastFailedReload: RuntimeConfigReloadSummary | null = null;
  let pendingRestart: RuntimeConfigChange[] = [];

  return {
    current: () => current,
    reload: (input) => {
      const startedAt = new Date().toISOString();
      const nextVersion = current.version + 1;

      try {
        const next = loadRuntimeConfig(requireDataRoot(options.dataRoot), { version: nextVersion });
        assertNoBlockingDiagnostics(next);
        const plan = diffRuntimeConfig(current, next);

        if (input.mode === 'strict' && plan.requiresRestart.length > 0) {
          pendingRestart = plan.requiresRestart;
          lastReload = reloadSummary(
            startedAt,
            input,
            current.version,
            current.version,
            'rejected'
          );

          return {
            status: 'rejected',
            runtimeConfig: createRuntimeConfigStatus(current, pendingRestart),
            plan: {
              ...plan,
              rejected: [
                ...plan.rejected,
                ...plan.requiresRestart.map((change) => ({
                  ...change,
                  action: 'rejected' as const,
                  category: 'rejected' as const,
                })),
              ],
            },
          };
        }

        if (input.dryRun) {
          lastReload = reloadSummary(startedAt, input, current.version, current.version, 'dry-run');

          return {
            status: 'dry-run',
            runtimeConfig: createRuntimeConfigStatus(current, pendingRestart),
            plan,
          };
        }

        current = applySafeRuntimeConfigReload(current, next, plan);
        pendingRestart = plan.requiresRestart;
        lastReload = reloadSummary(
          startedAt,
          input,
          current.version - 1,
          current.version,
          'applied'
        );

        return {
          status: 'applied',
          runtimeConfig: createRuntimeConfigStatus(current, pendingRestart),
          plan,
        };
      } catch (error) {
        const message = redactRuntimeConfigReloadError(error, options.dataRoot);
        const plan = failedReloadPlan(current.version, nextVersion, message);

        lastFailedReload = reloadSummary(
          startedAt,
          input,
          current.version,
          current.version,
          'failed',
          message
        );

        return {
          status: 'failed',
          runtimeConfig: createRuntimeConfigStatus(current, pendingRestart),
          plan,
        };
      }
    },
    status: (staleSessions = []) => ({
      ...createRuntimeConfigStatus(current, pendingRestart, staleSessions),
      lastReload,
      lastFailedReload,
    }),
  };

  /**
   * Creates a runtime config status using manager-owned summaries.
   */
  function createRuntimeConfigStatus(
    snapshot: RuntimeConfigSnapshot,
    restartChanges: RuntimeConfigChange[],
    staleSessions: RuntimeConfigStaleSession[] = []
  ): RuntimeConfigStatus {
    return {
      currentVersion: snapshot.version,
      loadedAt: snapshot.loadedAt,
      lastReload,
      lastFailedReload,
      pendingRestart: restartChanges,
      staleSessions,
    };
  }
}

/**
 * Applies a runtime reload candidate while preserving restart-required live fields.
 *
 * @param previous Active runtime config snapshot.
 * @param next Candidate runtime config snapshot loaded from disk.
 * @param plan Semantic reload plan computed for the candidate.
 * @returns Snapshot that exposes only changes safe for the running process.
 */
function applySafeRuntimeConfigReload(
  previous: RuntimeConfigSnapshot,
  next: RuntimeConfigSnapshot,
  plan: RuntimeConfigReloadPlan
): RuntimeConfigSnapshot {
  if (plan.requiresRestart.length === 0) {
    return next;
  }

  const openKitConfig = cloneJsonValue(next.openKitConfig);
  const restartPaths = new Set(plan.requiresRestart.map((change) => change.path));

  for (const restartChange of plan.requiresRestart) {
    restorePath(openKitConfig, previous.openKitConfig, restartChange.path);
  }

  return Object.freeze(
    createRuntimeConfigSnapshot({
      sources: next.sources,
      version: next.version,
      loadedAt: next.loadedAt,
      dataRoot: null,
      openKitConfig,
      providerRegistry: restartPaths.has('providers')
        ? previous.providerRegistry
        : next.providerRegistry,
      providerDiagnostics: restartPaths.has('providers')
        ? previous.providerDiagnostics
        : next.providerDiagnostics,
      agentManifests: restartPaths.has('agents') ? previous.agentManifests : next.agentManifests,
      workspaceConfigs: next.workspaceConfigs,
      workspaceDataSourceCatalogs: next.workspaceDataSourceCatalogs,
      diagnostics: next.diagnostics,
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
      : loadProviderRegistryFromDataRoot(input.dataRoot, input.openKitConfig ?? {});
  const agentState =
    input.agentManifests || !input.dataRoot ? null : loadAgentManifests(input.dataRoot);

  return createRuntimeConfigSnapshot({
    dataRoot: input.dataRoot,
    openKitConfig: input.openKitConfig ?? {},
    providerRegistry:
      input.providerRegistry ?? providerState?.providerRegistry ?? new ProviderRegistry([]),
    providerDiagnostics:
      input.providerDiagnostics ??
      providerState?.providerDiagnostics ??
      createProviderDiagnostics({ profiles: [], diagnostics: [] }),
    agentManifests: input.agentManifests ?? agentState?.manifests ?? [],
    workspaceConfigs: input.workspaceConfigs ?? [],
    workspaceDataSourceCatalogs: input.workspaceDataSourceCatalogs ?? [],
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
  const rejected: RuntimeConfigChange[] = [];

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
  if (!equalSemantic(previous.openKitConfig.defaults ?? {}, next.openKitConfig.defaults ?? {})) {
    applied.push(change('defaults', 'hot-swappable', 'applied', 'Runtime defaults changed.'));
  }
  if (!equalSemantic(gatewayHotSummary(previous), gatewayHotSummary(next))) {
    applied.push(
      change(
        'gateway.openaiCompatible.allowedProviderIds',
        'hot-swappable',
        'applied',
        'Gateway provider allowlist changed.'
      )
    );
  }
  if (!equalSemantic(agentSummary(previous), agentSummary(next))) {
    requiresRestart.push(
      change(
        'agents',
        'restart-required',
        'requires-restart',
        'Agent config changes require restart.'
      )
    );
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

  for (const path of RESTART_REQUIRED_CONFIG_PATHS) {
    if (
      !equalSemantic(readPath(previous.openKitConfig, path), readPath(next.openKitConfig, path))
    ) {
      requiresRestart.push(
        change(path, 'restart-required', 'requires-restart', `${path} requires restart.`)
      );
    }
  }

  if (next.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    rejected.push(
      change(
        'config.diagnostics',
        'rejected',
        'rejected',
        'Runtime config contains blocking diagnostics.'
      )
    );
  }

  return {
    previousVersion: previous.version,
    nextVersion: next.version,
    applied,
    deferred,
    requiresRestart,
    rejected,
    warnings: [],
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
 * Creates a redacted stale-session record.
 *
 * @param input Stale-session fields.
 * @returns Stale-session diagnostic payload.
 */
export function createRuntimeConfigStaleSession(
  input: RuntimeConfigStaleSessionInput
): RuntimeConfigStaleSession {
  return {
    ...input,
    choices: input.choices ?? [
      {
        kind: 'inspect',
        label: 'Inspect stale session details',
        recommended: true,
      },
      {
        kind: 'restart_session',
        label: 'Restart the stale session before continuing',
      },
      {
        kind: 'request_human',
        label: 'Ask the user how to handle the stale session',
      },
    ],
  };
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
    contentHash: hashSemantic(snapshotSemanticSummary(snapshot)),
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
    dryRun: input.dryRun,
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
  previousVersion: number,
  nextVersion: number,
  message: string
): RuntimeConfigReloadPlan {
  return {
    previousVersion,
    nextVersion,
    applied: [],
    deferred: [],
    requiresRestart: [],
    rejected: [
      change('config', 'rejected', 'rejected', `Runtime config reload failed: ${message}`),
    ],
    warnings: [],
  };
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
function gatewayHotSummary(snapshot: RuntimeConfigSnapshot): unknown {
  const gateway = snapshot.openKitConfig.gateway?.openaiCompatible;

  return {
    allowedProviderIds: gateway?.allowedProviderIds ?? [],
  };
}

/**
 * Creates a semantic snapshot summary for hashing.
 */
function snapshotSemanticSummary(snapshot: Omit<RuntimeConfigSnapshot, 'contentHash'>): unknown {
  return {
    openKitConfig: redactSemanticSecrets(snapshot.openKitConfig),
    providers: providerSummary(snapshot as RuntimeConfigSnapshot),
    agentManifests: snapshot.agentManifests,
    workspaceConfigs: workspaceConfigSummary(snapshot as RuntimeConfigSnapshot),
    workspaceDataSourceCatalogs: workspaceDataSourceCatalogSummary(
      snapshot as RuntimeConfigSnapshot
    ),
  };
}

/**
 * Loads every workspace config under DATA_ROOT/workspaces.
 *
 * @param dataRoot Data root to scan.
 * @returns Parsed workspace configs.
 */
function loadWorkspaceConfigs(dataRoot: string): LoadedWorkspaceConfig[] {
  const workspacesRoot = join(dataRoot, 'workspaces');

  if (!existsSync(workspacesRoot)) {
    return [];
  }

  const configs: LoadedWorkspaceConfig[] = [];

  for (const workspaceEntry of readdirSync(workspacesRoot, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name)
  )) {
    if (!workspaceEntry.isDirectory()) {
      continue;
    }

    const configPath = join(workspacesRoot, workspaceEntry.name, 'config', 'workspace.jsonc');

    if (!existsSync(configPath)) {
      continue;
    }

    const parsed = parseJsoncObject(readFileSync(configPath, 'utf8'), configPath);
    const result = WorkspaceConfigSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(`Invalid workspace config ${configPath}: ${z.prettifyError(result.error)}`);
    }

    configs.push({
      workspaceId: workspaceEntry.name,
      path: configPath,
      config: result.data,
    });
  }

  return configs;
}

/**
 * Loads every workspace data source catalog under DATA_ROOT/workspaces.
 *
 * @param dataRoot Data root to scan.
 * @returns Parsed workspace data source catalogs.
 */
function loadWorkspaceDataSourceCatalogs(dataRoot: string): LoadedWorkspaceDataSourceCatalog[] {
  const workspacesRoot = join(dataRoot, 'workspaces');

  if (!existsSync(workspacesRoot)) {
    return [];
  }

  const catalogs: LoadedWorkspaceDataSourceCatalog[] = [];

  for (const workspaceEntry of readdirSync(workspacesRoot, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name)
  )) {
    if (!workspaceEntry.isDirectory()) {
      continue;
    }

    const catalogPath = join(workspacesRoot, workspaceEntry.name, 'config', 'data-sources.jsonc');

    if (!existsSync(catalogPath)) {
      continue;
    }

    const parsed = parseJsoncObject(readFileSync(catalogPath, 'utf8'), catalogPath);

    catalogs.push({
      workspaceId: workspaceEntry.name,
      path: catalogPath,
      catalog: parseWorkspaceDataSourceCatalog(parsed),
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

/**
 * Compares two values after stable serialization.
 */
function equalSemantic(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

/**
 * Hashes a semantic value.
 */
function hashSemantic(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
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
      : `secret:${hashSemantic(value).slice(0, 12)}`;
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
 * Serializes objects with stable key ordering.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/**
 * Sorts object keys recursively for stable comparison.
 */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }

  return value;
}

/**
 * Redacts a source path for diagnostics.
 */
function redactSourcePath(path: string): string {
  const marker = 'config/';
  const index = path.lastIndexOf(marker);

  return index >= 0 ? path.slice(index) : (path.split('/').at(-1) ?? path);
}
