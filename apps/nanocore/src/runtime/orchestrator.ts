import type { MaterializedWorkspaceRoot } from '@openkit/app-api-schemas';
import { resolveWorkspaceDataSourceReference } from '@openkit/config-schema';
import type { AgentSchema, TurnSchema } from '@openkit/protocol';
import type { z } from 'zod';
import type { AgentManifest, AuthoredAgentConfig } from '../agents/manifest.js';
import { type AgentReadiness, computeReadiness } from '../agents/readiness.js';
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
import type { ProviderRegistry } from '../providers/registry.js';
import type { WorkspaceDb } from '../storage/db.js';
import type { TurnExecutor, TurnStartRuntimeContext } from './types.js';

type AgentReadModel = z.infer<typeof AgentSchema>;

/**
 * Default agent manifest used when tests or local callers do not provide file-backed manifests.
 */
export const DEFAULT_AGENT_MANIFESTS: AgentManifest[] = [
  {
    adapter: 'codex-app-server',
    deployments: ['local'],
    displayName: 'Codex Agent',
    id: 'agent_codex_host',
    kind: 'custom',
    runtime: 'codex',
    version: '0.0.2',
  },
];

/**
 * Input for starting a turn through the minimal orchestrator.
 */
export interface StartTurnInput {
  /** Scheduler-owned agent session id used when a lease already reserved lineage. */
  agentSessionId?: string;
  /** Optional dependencies for tests and future orchestration expansion. */
  dependencies?: StartTurnDependencies;
  /** User input submitted for the turn. */
  input: string;
  /** Optional per-turn model override. */
  modelId?: string | null;
  /** Provider registry used for readiness evaluation. */
  providerRegistry: ProviderRegistry;
  /** Request id for the command that accepted the turn. */
  requestId?: string | null;
  /** Scheduler-owned non-secret sandbox binding reference for worker-control auth. */
  sandboxBindingRef?: string;
  /** File-backed store for workspace and turn records. */
  store: FsStore;
  /** Thread id that owns the turn. */
  threadId: string;
  /** Scheduler-owned turn id when a queue entry already reserved lineage. */
  turnId?: string;
  /** Runtime executor that performs the turn work. */
  turnExecutor: TurnExecutor;
  /** Optional per-request agent override. */
  agentId?: string | null;
  /** Optional authored agent configs used to produce resolved setup snapshots. */
  agentConfigs?: AuthoredAgentConfig[];
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
 * Resolves a model override to a compatible enabled agent.
 *
 * @param store Store that owns workspace resources.
 * @param workspaceId Workspace whose resources should be checked.
 * @param modelId Requested model override.
 * @returns Matching agent id, or null when no override was supplied.
 * @throws TurnStartValidationError when the model is missing, disabled, or unsupported.
 */
export function resolveModelAgentOverride(
  store: FsStore,
  workspaceId: string,
  modelId?: string | null
): string | null {
  if (!modelId) {
    return null;
  }

  const resources = store.getWorkspaceResources(workspaceId);
  const model = resources.models.find((candidate) => candidate.id === modelId);

  if (!model) {
    throw new TurnStartValidationError('model_not_found', `Model not found: ${modelId}.`);
  }

  if (!model.enabled) {
    throw new TurnStartValidationError('model_disabled', `Model is disabled: ${modelId}.`);
  }

  const defaultAgentId = store.getWorkspace(workspaceId).defaults?.defaultAgentId ?? null;
  const matchingAgents = resources.agents.filter(
    (agent) => agent.status === 'enabled' && agent.modelId === modelId
  );
  const matchingAgent =
    matchingAgents.find((agent) => agent.id === defaultAgentId) ?? matchingAgents[0] ?? null;

  if (!matchingAgent) {
    throw new TurnStartValidationError(
      'model_not_supported_by_agent',
      `No enabled agent supports model: ${modelId}.`
    );
  }

  return matchingAgent.id;
}

/**
 * Ensures the selected agent read model is compatible with the requested model.
 *
 * @param agent Product-visible agent read model.
 * @param modelId Requested model override.
 * @throws TurnStartValidationError when the agent does not support the model.
 */
function assertAgentSupportsModel(agent: AgentReadModel, modelId?: string | null): void {
  if (!modelId || agent.modelId === modelId) {
    return;
  }

  throw new TurnStartValidationError(
    'model_not_supported_by_agent',
    `Agent ${agent.id} does not support model: ${modelId}.`
  );
}

/**
 * Extracts catalog source references declared by the selected authored agent config.
 *
 * @param config Selected authored agent config.
 * @param workspaceRoots Materialized roots available for this turn.
 * @returns Root-id to sourceRef bindings for matching workspace inputs.
 */
function workspaceSourceRefsFromAgentConfig(
  config: AuthoredAgentConfig,
  workspaceRoots: MaterializedWorkspaceRoot[]
): Record<string, string> | undefined {
  const rootIds = new Set(workspaceRoots.map((root) => root.id));
  const sourceRefs: Record<string, string> = {};

  for (const workspaceInput of config.workspace?.inputs ?? []) {
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
  const workspace = input.store.getWorkspace(input.workspaceId);
  const modelAgentId = resolveModelAgentOverride(input.store, input.workspaceId, input.modelId);
  const selectedAgentId = input.agentId ?? modelAgentId;
  const override = selectedAgentId ? { agentId: selectedAgentId } : {};
  const selector = input.dependencies?.selectAgent ?? selectAgent;
  const selectedAgent = selector(
    { defaultAgentId: workspace.defaults?.defaultAgentId ?? null },
    override,
    input.agentManifests
  );

  if (!('id' in selectedAgent)) {
    throw new Error(selectedAgent.error.message);
  }

  const selectedAgentReadModel = input.store.getAgent(input.workspaceId, selectedAgent.id);
  assertAgentSupportsModel(selectedAgentReadModel, input.modelId);

  const selectedAgentConfig = input.agentConfigs?.find((config) => config.id === selectedAgent.id);
  const agentSetupResult = selectedAgentConfig
    ? resolveAgentSetup(selectedAgentConfig, { providerRegistry: input.providerRegistry })
    : { diagnostics: [], setup: null };

  if (agentSetupResult.diagnostics.length > 0) {
    throw new Error(
      agentSetupResult.diagnostics.map((diagnostic) => diagnostic.message).join('\n')
    );
  }

  const readiness = computeReadiness(selectedAgent, input.providerRegistry);
  const authoredWorkspaceSourceRefs = selectedAgentConfig
    ? workspaceSourceRefsFromAgentConfig(selectedAgentConfig, input.workspaceRoots ?? [])
    : undefined;
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
    input.configVersion ?? null,
    input.turnId ? { turnId: input.turnId } : {}
  );
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
    ...(agentSetupResult.setup?.backend
      ? {
          backendRequirements: {
            allowedKinds: agentSetupResult.setup.backend.allowedKinds,
            preferred: agentSetupResult.setup.backend.preferred,
            requiredCapabilities: agentSetupResult.setup.backend.requiredCapabilities,
          },
        }
      : {}),
    requestId: input.requestId ?? null,
    ...(input.sandboxBindingRef ? { sandboxBindingRef: input.sandboxBindingRef } : {}),
    ...(input.workspaceDataSourceCatalog
      ? { workspaceDataSourceCatalog: input.workspaceDataSourceCatalog }
      : {}),
    workspaceRoots: input.workspaceRoots ?? [],
    ...(Object.keys(workspaceSourceRefs).length > 0 ? { workspaceSourceRefs } : {}),
    workspaceCwd: input.workspaceCwd ?? null,
  });

  return {
    modelId: input.modelId ?? null,
    readiness,
    turn: input.store.getTurnById(turn.id),
    agent: selectedAgent,
    agentSetup: agentSetupResult.setup,
    agentSetupRecordId,
    agentSetupDiagnostics: agentSetupResult.diagnostics,
  };
}
