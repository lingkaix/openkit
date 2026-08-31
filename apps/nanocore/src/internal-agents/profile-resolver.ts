import type {
  GatewayConfig,
  InternalRoleExecutionProfileSchema,
  InternalRoleProfilesConfig,
  UserConfig,
  WorkspaceConfig,
} from '@openkit/config-schema';
import type { z } from 'zod';
import { type ResolvedLogicalModel, resolveLogicalModelCatalog } from '../llm/logical-models.js';
import type { ProviderRegistry } from '../providers/registry.js';

type InternalRoleProfile = z.infer<typeof InternalRoleExecutionProfileSchema>;

/** Fully resolved internal-role profile and logical-model contract. */
export interface ResolvedInternalRoleProfile {
  readonly profile: InternalRoleProfile | null;
  readonly logicalModel: ResolvedLogicalModel;
  readonly logicalModels: readonly ResolvedLogicalModel[];
}

/** Resolves one role using explicit, User, Workspace, Server-profile, then Gateway preferences. */
export function resolveInternalRoleProfile(input: {
  readonly roleId: string;
  readonly workspaceId: string;
  readonly gatewayConfig: GatewayConfig;
  readonly profilesConfig: InternalRoleProfilesConfig;
  readonly providerRegistry: ProviderRegistry;
  readonly requestedLogicalModelId?: string;
  readonly userConfig?: UserConfig;
  readonly workspaceConfig?: WorkspaceConfig;
}): ResolvedInternalRoleProfile | null {
  const userRole = input.userConfig?.workspaces
    .find((workspace) => workspace.workspaceId === input.workspaceId)
    ?.internalRoles.find((role) => role.roleId === input.roleId);
  const workspaceRole = input.workspaceConfig?.workspace.internalRoles.find(
    (role) => role.roleId === input.roleId
  );
  const selectedProfileId = userRole?.profileId ?? workspaceRole?.profileId;
  const roleProfiles = input.profilesConfig.profiles.filter(
    (profile) => profile.roleId === input.roleId
  );
  const profile = selectedProfileId
    ? (input.profilesConfig.profiles.find(
        (candidate) => candidate.id === selectedProfileId && candidate.roleId === input.roleId
      ) ?? null)
    : roleProfiles.length === 1
      ? (roleProfiles[0] ?? null)
      : null;
  if (selectedProfileId && !profile) {
    return null;
  }

  const configuredPreferredLogicalModelId =
    userRole?.logicalModelId ??
    workspaceRole?.preferredLogicalModelId ??
    profile?.preferredLogicalModelId ??
    input.profilesConfig.defaultLogicalModelId ??
    input.gatewayConfig.defaultLogicalModelId;
  if (!configuredPreferredLogicalModelId) {
    return null;
  }

  const catalog = resolveLogicalModelCatalog(input.gatewayConfig, input.providerRegistry);
  const admittedIds = [
    configuredPreferredLogicalModelId,
    ...(profile?.compatibleLogicalModelIds ?? []),
  ];
  const logicalModels = [...new Set(admittedIds)]
    .map((id) => catalog.find((model) => model.id === id))
    .filter(
      (model): model is ResolvedLogicalModel =>
        Boolean(model) &&
        (profile?.requiredLogicalModelCapabilities ?? []).every((capability) =>
          model?.capabilities.includes(capability)
        )
    );
  const logicalModel = logicalModels.find(
    (model) => model.id === (input.requestedLogicalModelId ?? configuredPreferredLogicalModelId)
  );

  return logicalModel ? { logicalModel, logicalModels, profile } : null;
}
