import type {
  AgentEnvironmentCredentialDeclaration,
  AgentEnvironmentCredentialRequirement,
  GatewayConfig,
  UserConfig,
  WorkspaceConfig,
} from '@openkit/config-schema';
import { type ResolvedLogicalModel, resolveLogicalModelCatalog } from '../llm/logical-models.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { AgentManifest } from './manifest.js';

/** Blocking setup resolution diagnostic. */
export interface AgentSetupDiagnostic {
  code:
    | 'agent_setup.invalid_default_profile'
    | 'agent_setup.duplicate_credential_requirement'
    | 'agent_setup.missing_credential_binding'
    | 'agent_setup.logical_model_not_allowed'
    | 'agent_setup.logical_model_not_found'
    | 'agent_setup.unsupported_required_feature';
  message: string;
  severity: 'error';
  agentId: string;
}

/** Exact logical model set recorded into one composed setup and later AEP. */
export interface ResolvedAgentLogicalModels {
  preferredLogicalModelId: string;
  allowed: ResolvedLogicalModel[];
}

/** Agent setup composed for one Workspace, User, profile, and Turn preference. */
export interface ResolvedAgentSetup {
  manifest: ResolvedAgentManifest;
  profileId: string | null;
  logicalModels: ResolvedAgentLogicalModels;
}

/** Composed Agent Manifest whose reusable credential requirements are fully bound. */
export type ResolvedAgentManifest = Omit<AgentManifest, 'sandbox'> & {
  sandbox?: {
    backend?: NonNullable<NonNullable<AgentManifest['sandbox']>['backend']>;
    credentialDeclarations: AgentEnvironmentCredentialDeclaration[];
    filesystem: NonNullable<AgentManifest['sandbox']>['filesystem'];
    network: NonNullable<AgentManifest['sandbox']>['network'];
  };
};

/** Setup resolution result. */
export interface AgentSetupResolveResult {
  diagnostics: AgentSetupDiagnostic[];
  setup: ResolvedAgentSetup | null;
}

/** Inputs required to compose an Agent Manifest without exposing private Gateway routes. */
export interface AgentSetupResolverDependencies {
  providerRegistry: ProviderRegistry;
  gatewayConfig: GatewayConfig;
  workspaceConfig?: WorkspaceConfig;
  userConfig?: UserConfig;
  workspaceId?: string;
  selectedProfileId?: string | null;
  requestedLogicalModelId?: string | null;
  supportedRequiredFeatures?: readonly string[];
}

/** Resolves one immutable Agent setup from Server supply plus Workspace and User composition. */
export function resolveAgentSetup(
  config: AgentManifest,
  dependencies: AgentSetupResolverDependencies
): AgentSetupResolveResult {
  const diagnostics: AgentSetupDiagnostic[] = [];
  rejectUnsupportedRequiredFeatures(
    config.id,
    config.requiredFeatures ?? [],
    dependencies,
    diagnostics
  );

  const workspaceBinding = dependencies.workspaceConfig?.workspace.agents.find(
    (binding) => binding.agentId === config.id
  );
  const userPreference = dependencies.userConfig?.workspaces.find(
    (preference) => preference.workspaceId === dependencies.workspaceId
  );
  const profileId =
    dependencies.selectedProfileId ??
    userPreference?.profileId ??
    workspaceBinding?.profileId ??
    config.defaultProfileId ??
    null;
  const profile = profileId
    ? (config.profiles ?? []).find((candidate) => candidate.id === profileId)
    : undefined;

  if (profileId && !profile) {
    diagnostics.push({
      agentId: config.id,
      code: 'agent_setup.invalid_default_profile',
      message: `Agent ${config.id} profile ${profileId} is not declared in profiles.`,
      severity: 'error',
    });
  }

  let catalog: ResolvedLogicalModel[] = [];
  try {
    catalog = resolveLogicalModelCatalog(dependencies.gatewayConfig, dependencies.providerRegistry);
  } catch {
    diagnostics.push({
      agentId: config.id,
      code: 'agent_setup.logical_model_not_found',
      message: `Agent ${config.id} cannot resolve the current logical model catalog.`,
      severity: 'error',
    });
  }

  const allowedDeclaration =
    workspaceBinding?.allowedLogicalModelIds ??
    profile?.allowedLogicalModelIds ??
    config.models.allowedLogicalModelIds;
  const allowed =
    allowedDeclaration === 'all'
      ? catalog
      : allowedDeclaration.flatMap((id) => {
          const logicalModel = catalog.find((candidate) => candidate.id === id);
          if (!logicalModel) {
            diagnostics.push({
              agentId: config.id,
              code: 'agent_setup.logical_model_not_found',
              message: `Agent ${config.id} references missing logical model: ${id}.`,
              severity: 'error',
            });
            return [];
          }
          return [logicalModel];
        });
  const preferredLogicalModelId =
    dependencies.requestedLogicalModelId ??
    userPreference?.logicalModelId ??
    workspaceBinding?.preferredLogicalModelId ??
    profile?.preferredLogicalModelId ??
    config.models.preferredLogicalModelId;

  if (!allowed.some((logicalModel) => logicalModel.id === preferredLogicalModelId)) {
    diagnostics.push({
      agentId: config.id,
      code: 'agent_setup.logical_model_not_allowed',
      message: `Agent ${config.id} does not allow logical model: ${preferredLogicalModelId}.`,
      severity: 'error',
    });
  }

  const credentialDeclarations = resolveCredentialDeclarations(
    config.id,
    mergeById(
      config.sandbox?.credentialDeclarations ?? [],
      workspaceBinding?.sandbox?.credentialDeclarations ?? []
    ),
    workspaceBinding?.credentialBindings ?? [],
    diagnostics
  );

  if (diagnostics.length > 0) return { diagnostics, setup: null };

  const manifest = composeManifest(
    config,
    profileId,
    profile,
    workspaceBinding,
    preferredLogicalModelId,
    allowed,
    credentialDeclarations
  );
  return {
    diagnostics: [],
    setup: { manifest, profileId, logicalModels: { preferredLogicalModelId, allowed } },
  };
}

function composeManifest(
  config: AgentManifest,
  profileId: string | null,
  profile: NonNullable<AgentManifest['profiles']>[number] | undefined,
  workspaceBinding: WorkspaceConfig['workspace']['agents'][number] | undefined,
  preferredLogicalModelId: string,
  allowed: ResolvedLogicalModel[],
  credentialDeclarations: AgentEnvironmentCredentialDeclaration[]
): ResolvedAgentManifest {
  const baseSandbox = config.sandbox;
  const workspaceSandbox = workspaceBinding?.sandbox;
  const backend = workspaceSandbox?.backend ?? baseSandbox?.backend;
  const { sandbox: _sandbox, ...base } = config;
  const composed = {
    ...base,
    ...(profileId ? { defaultProfileId: profileId } : {}),
    mcp: mergeById(config.mcp ?? [], profile?.mcp ?? [], workspaceBinding?.mcp ?? []),
    models: {
      preferredLogicalModelId,
      allowedLogicalModelIds: allowed.map((model) => model.id),
    },
    skills: mergeById(config.skills ?? [], profile?.skills ?? [], workspaceBinding?.skills ?? []),
  };
  if (!baseSandbox && !workspaceSandbox) return composed;
  return {
    ...composed,
    sandbox: {
      ...(backend ? { backend } : {}),
      credentialDeclarations,
      filesystem: mergeById(baseSandbox?.filesystem ?? [], workspaceSandbox?.filesystem ?? []),
      network: mergeById(baseSandbox?.network ?? [], workspaceSandbox?.network ?? []),
    },
  };
}

function resolveCredentialDeclarations(
  agentId: string,
  declarations: readonly (
    | AgentEnvironmentCredentialDeclaration
    | AgentEnvironmentCredentialRequirement
  )[],
  bindings: readonly { requirementId: string; vaultGrantId: string }[],
  diagnostics: AgentSetupDiagnostic[]
): AgentEnvironmentCredentialDeclaration[] {
  const bindingsByRequirement = new Map(
    bindings.map((binding) => [binding.requirementId, binding.vaultGrantId])
  );
  const requirementIds = new Set<string>();
  return declarations.flatMap((declaration) => {
    if ('vaultGrantId' in declaration) return [declaration];

    if (requirementIds.has(declaration.requirementId)) {
      diagnostics.push({
        agentId,
        code: 'agent_setup.duplicate_credential_requirement',
        message: `Agent ${agentId} repeats credential requirement: ${declaration.requirementId}.`,
        severity: 'error',
      });
      return [];
    }
    requirementIds.add(declaration.requirementId);

    const vaultGrantId = bindingsByRequirement.get(declaration.requirementId);
    if (!vaultGrantId) {
      if (declaration.required) {
        diagnostics.push({
          agentId,
          code: 'agent_setup.missing_credential_binding',
          message: `Agent ${agentId} requires Workspace credential binding: ${declaration.requirementId}.`,
          severity: 'error',
        });
      }
      return [];
    }

    const { purpose: _purpose, required: _required, ...resolved } = declaration;
    return [{ ...resolved, vaultGrantId }];
  });
}

function mergeById<T extends { id: string }>(...lists: readonly (readonly T[])[]): T[] {
  const merged = new Map<string, T>();
  for (const list of lists) for (const value of list) merged.set(value.id, value);
  return [...merged.values()];
}

function rejectUnsupportedRequiredFeatures(
  agentId: string,
  requiredFeatures: readonly string[],
  dependencies: AgentSetupResolverDependencies,
  diagnostics: AgentSetupDiagnostic[]
): void {
  const supported = new Set(dependencies.supportedRequiredFeatures ?? []);
  for (const feature of requiredFeatures) {
    if (!supported.has(feature)) {
      diagnostics.push({
        code: 'agent_setup.unsupported_required_feature',
        message: `Agent ${agentId} requires unsupported feature: ${feature}.`,
        severity: 'error',
        agentId,
      });
    }
  }
}
