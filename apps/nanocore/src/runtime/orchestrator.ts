import type { MaterializedWorkspaceRoot } from '@openkit/app-api-schemas';
import {
  type GatewayConfig,
  resolveWorkspaceDataSourceReference,
  type UserConfig,
  type WorkspaceConfig,
} from '@openkit/config-schema';
import type { ActorRef, TurnSchema } from '@openkit/protocol';
import type { z } from 'zod';
import type { AgentManifest } from '../agents/manifest.js';
import { type AgentReadiness, computeReadiness, isAgentLaunchable } from '../agents/readiness.js';
import {
  type AgentSelectionDefaults,
  type AgentSelectionOverride,
  type AgentSelectionResult,
  selectAgent,
} from '../agents/selector.js';
import { recordResolvedAgentSetup } from '../agents/setup-ledger.js';
import {
  type AgentSetupDiagnostic,
  type ResolvedAgentSetup,
  resolveAgentSetup,
} from '../agents/setup-resolver.js';
import type { FsStore } from '../lib/store.js';
import type { ProviderCredentialResolver, ProviderRegistry } from '../providers/registry.js';
import type { WorkspaceDb } from '../storage/db.js';
import type { TurnExecutor, TurnStartRuntimeContext } from './types.js';

/**
 * Input for starting a turn through the minimal orchestrator.
 */
export interface StartTurnInput {
  /** Scheduler-owned AgentSession id used when a lease already reserved lineage. */
  agentSessionId?: string;
  /** Optional dependencies for tests and future orchestration expansion. */
  dependencies?: StartTurnDependencies;
  /** User input submitted for the turn. */
  input: string;
  /** Optional per-turn model override. */
  modelId?: string | null;
  /** Optional per-turn Agent profile override. */
  profileId?: string | null;
  /** Provider registry used for readiness evaluation. */
  providerRegistry: ProviderRegistry;
  /** Gateway logical model catalog used for Agent composition. */
  gatewayConfig: GatewayConfig;
  /** Workspace composition applied to the selected Agent. */
  workspaceConfig?: WorkspaceConfig;
  /** Personal preferences applied after Workspace composition. */
  userConfig?: UserConfig;
  /** Request id for the command that accepted the turn. */
  requestId?: string | null;
  /** Scheduler-owned non-secret sandbox binding reference for worker-control auth. */
  sandboxBindingRef?: string;
  /** Exact pre-lease SessionCompatibilityKey committed to the scheduler lease. */
  sessionCompatibilityKey?: string;
  /** File-backed store for workspace and turn records. */
  store: FsStore;
  /** Thread id that owns the turn. */
  threadId: string;
  /** Exact actor whose action triggered this turn. */
  triggerActor: ActorRef;
  /** Scheduler-owned turn id when a queue entry already reserved lineage. */
  turnId?: string;
  /** Runtime executor that performs the turn work. */
  turnExecutor: TurnExecutor;
  /** Optional per-request agent override. */
  agentId?: string | null;
  /** Resolved User, Workspace, or Server Agent fallback. */
  defaultAgentId?: string | null;
  /** Optional workspace database used to persist resolved setup lineage. */
  agentSetupWorkspaceDb?: WorkspaceDb;
  /** Available agent manifests. */
  agentManifests: AgentManifest[];
  /** Runtime config snapshot version captured for this turn. */
  configVersion?: number | null;
  /** Materialized workspace roots captured for this turn. */
  workspaceRoots?: MaterializedWorkspaceRoot[];
  /** Optional workspace data source catalog captured for sourceRef-backed roots. */
  workspaceDataSourceCatalog?: TurnStartRuntimeContext['workspaceDataSourceCatalog'];
  /** Optional Workspace MCP server catalog captured for the selected Agent. */
  workspaceMcpServerCatalog?: TurnStartRuntimeContext['workspaceMcpServerCatalog'];
  /** Optional root-id to sourceRef bindings captured for sourceRef-backed roots. */
  workspaceSourceRefs?: TurnStartRuntimeContext['workspaceSourceRefs'];
  /** Host-local working directory selected for worker startup. */
  workspaceCwd?: string | null;
  /** Workspace id that owns the thread. */
  workspaceId: string;
}

/**
 * Injectable start-turn orchestration dependencies.
 */
export interface StartTurnDependencies {
  /** Resolver used to prove provider profile credentials before turn admission. */
  providerCredentialResolver?: ProviderCredentialResolver;
  /** Agent selector implementation. */
  selectAgent?: (
    defaults: AgentSelectionDefaults,
    override: AgentSelectionOverride,
    manifests: AgentManifest[]
  ) => AgentSelectionResult;
}

/**
 * Handle returned after a turn has been accepted for execution.
 */
export interface TurnHandle {
  /** Model id selected for this turn, if a per-turn override was supplied. */
  modelId: string | null;
  /** Computed readiness for the selected agent at acceptance time. */
  readiness: AgentReadiness;
  /** Created turn record. */
  turn: z.infer<typeof TurnSchema>;
  /** Selected agent manifest. */
  agent: AgentManifest;
  /** Blocking setup diagnostics discovered during resolution. */
  agentSetupDiagnostics: AgentSetupDiagnostic[];
  /** Resolved agent setup for the selected authored config, when available. */
  agentSetup: ResolvedAgentSetup | null;
  /** Durable resolved setup record id, when recorded. */
  agentSetupRecordId: string | null;
}

/**
 * Validation failure that can be returned to UI clients as a typed API error.
 */
export class TurnStartValidationError extends Error {
  /** Protocol API error code. */
  public readonly code: string;
  /** HTTP status for the validation failure. */
  public readonly status: number;

  /**
   * Creates a turn-start validation error.
   *
   * @param code Protocol API error code.
   * @param message User-facing error message.
   * @param status HTTP status code.
   */
  public constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'TurnStartValidationError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Checks whether one Agent Manifest admits a logical model ID.
 *
 * @param manifest Agent manifest to inspect.
 * @param modelId Requested logical model ID.
 * @returns True when the Manifest admits the requested logical model.
 */
function manifestAllowsModel(manifest: AgentManifest, modelId: string): boolean {
  return (
    manifest.models.allowedLogicalModelIds === 'all' ||
    manifest.models.allowedLogicalModelIds.includes(modelId)
  );
}

/**
 * Ensures an explicitly selected Manifest admits the requested logical model.
 *
 * @param manifest Selected agent manifest.
 * @param modelId Requested model override.
 * @throws TurnStartValidationError when the selected manifest resolves another model.
 */
export function assertAgentManifestSupportsModel(
  manifest: AgentManifest,
  modelId?: string | null
): void {
  if (!modelId || manifestAllowsModel(manifest, modelId)) {
    return;
  }

  throw new TurnStartValidationError(
    'model_not_supported_by_agent',
    `Agent ${manifest.id} does not support model override: ${modelId}.`
  );
}

/**
 * Extracts catalog source references declared by the selected authored agent manifest.
 *
 * @param manifest Selected authored agent manifest.
 * @param workspaceRoots Materialized roots available for this turn.
 * @returns Root-id to sourceRef bindings for matching workspace inputs.
 */
export function workspaceSourceRefsFromAgentManifest(
  manifest: AgentManifest,
  workspaceRoots: MaterializedWorkspaceRoot[]
): Record<string, string> | undefined {
  const rootIds = new Set(workspaceRoots.map((root) => root.id));
  const sourceRefs: Record<string, string> = {};

  for (const workspaceInput of manifest.workspace?.inputs ?? []) {
    const id = typeof workspaceInput.id === 'string' ? workspaceInput.id : null;
    const sourceRef =
      typeof workspaceInput.sourceRef === 'string' ? workspaceInput.sourceRef : null;

    if (id && sourceRef && rootIds.has(id)) {
      sourceRefs[id] = sourceRef;
    }
  }

  return Object.keys(sourceRefs).length > 0 ? sourceRefs : undefined;
}

/**
 * Fails closed before turn creation when a workspace sourceRef cannot resolve.
 *
 * @param sourceRefs Root-id to sourceRef bindings selected for this turn.
 * @param workspaceRoots Materialized roots available for this turn.
 * @param catalog Optional workspace data source catalog.
 * @throws TurnStartValidationError when a matching sourceRef is unavailable.
 */
function assertWorkspaceSourceRefsReady(
  sourceRefs: Record<string, string>,
  workspaceRoots: MaterializedWorkspaceRoot[],
  catalog: StartTurnInput['workspaceDataSourceCatalog']
): void {
  for (const root of workspaceRoots) {
    const sourceRef = sourceRefs[root.id];

    if (!sourceRef) {
      continue;
    }

    if (!catalog) {
      throw new TurnStartValidationError(
        'workspace_data_source_blocked',
        `Workspace data source catalog required for sourceRef: ${sourceRef}`,
        409
      );
    }

    try {
      resolveWorkspaceDataSourceReference({
        access: root.access,
        catalog,
        slotKind: root.access === 'read-write' ? 'worktree' : 'input',
        sourceRef,
      });
    } catch (error) {
      throw new TurnStartValidationError(
        'workspace_data_source_blocked',
        error instanceof Error ? error.message : String(error),
        409
      );
    }
  }
}

/**
 * Starts a turn after resolving the active agent manifest.
 *
 * @param input Turn orchestration input.
 * @returns Accepted turn handle.
 * @throws Error when agent selection fails.
 */
export async function startTurn(input: StartTurnInput): Promise<TurnHandle> {
  input.store.getWorkspace(input.workspaceId);
  const defaultAgentId = input.defaultAgentId ?? null;
  const selectedAgentId = input.agentId;
  const override = selectedAgentId ? { agentId: selectedAgentId } : {};
  const selector = input.dependencies?.selectAgent ?? selectAgent;
  const selectedAgent = selector({ defaultAgentId }, override, input.agentManifests);

  if (!('id' in selectedAgent)) {
    throw new Error(selectedAgent.error.message);
  }
  assertAgentManifestSupportsModel(selectedAgent, input.modelId);

  const agentSetupResult = resolveAgentSetup(selectedAgent, {
    gatewayConfig: input.gatewayConfig,
    providerRegistry: input.providerRegistry,
    ...(input.profileId !== undefined ? { selectedProfileId: input.profileId } : {}),
    ...(input.modelId !== undefined ? { requestedLogicalModelId: input.modelId } : {}),
    workspaceId: input.workspaceId,
    ...(input.workspaceConfig ? { workspaceConfig: input.workspaceConfig } : {}),
    ...(input.userConfig ? { userConfig: input.userConfig } : {}),
  });

  if (agentSetupResult.diagnostics.length > 0) {
    throw new Error(
      agentSetupResult.diagnostics.map((diagnostic) => diagnostic.message).join('\n')
    );
  }

  const readiness = computeReadiness(selectedAgent);
  if (!isAgentLaunchable(readiness)) {
    throw new TurnStartValidationError(
      'agent_not_ready',
      `Agent ${selectedAgent.id} readiness is ${readiness.status}.`,
      409
    );
  }
  const authoredWorkspaceSourceRefs = workspaceSourceRefsFromAgentManifest(
    selectedAgent,
    input.workspaceRoots ?? []
  );
  const workspaceSourceRefs = {
    ...(authoredWorkspaceSourceRefs ?? {}),
    ...(input.workspaceSourceRefs ?? {}),
  };
  assertWorkspaceSourceRefsReady(
    workspaceSourceRefs,
    input.workspaceRoots ?? [],
    input.workspaceDataSourceCatalog
  );
  const turn = input.store.createTurn(
    input.workspaceId,
    input.threadId,
    input.input,
    input.triggerActor,
    input.configVersion ?? null,
    input.turnId ? { turnId: input.turnId } : {}
  );
  input.store.updateTurn(turn.id, { agentId: selectedAgent.id });
  const agentSetupRecordId =
    agentSetupResult.setup && input.agentSetupWorkspaceDb
      ? recordResolvedAgentSetup(input.agentSetupWorkspaceDb, {
          recordId: `ras_${turn.id}`,
          workspaceId: input.workspaceId,
          turnId: turn.id,
          requestId: input.requestId ?? null,
          setup: agentSetupResult.setup,
          createdAt: turn.startedAt ?? new Date().toISOString(),
        }).id
      : null;

  await input.turnExecutor.startTurn(input.store, turn.id, input.input, {
    ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
    ...(agentSetupResult.setup ? { agentSetup: agentSetupResult.setup } : {}),
    requestId: input.requestId ?? null,
    ...(input.sessionCompatibilityKey
      ? { sessionCompatibilityKey: input.sessionCompatibilityKey }
      : {}),
    triggerActor: input.triggerActor,
    ...(input.sandboxBindingRef ? { sandboxBindingRef: input.sandboxBindingRef } : {}),
    ...(input.workspaceDataSourceCatalog
      ? { workspaceDataSourceCatalog: input.workspaceDataSourceCatalog }
      : {}),
    ...(input.workspaceMcpServerCatalog
      ? { workspaceMcpServerCatalog: input.workspaceMcpServerCatalog }
      : {}),
    workspaceRoots: input.workspaceRoots ?? [],
    ...(Object.keys(workspaceSourceRefs).length > 0 ? { workspaceSourceRefs } : {}),
    workspaceCwd: input.workspaceCwd ?? null,
  });

  return {
    modelId: agentSetupResult.setup?.logicalModels.preferredLogicalModelId ?? null,
    readiness,
    turn: input.store.getTurnById(turn.id),
    agent: selectedAgent,
    agentSetup: agentSetupResult.setup,
    agentSetupRecordId,
    agentSetupDiagnostics: agentSetupResult.diagnostics,
  };
}
