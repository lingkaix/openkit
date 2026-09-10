import { type GatewayConfig, resolveProviderSubscriptionFamily } from '@openkit/config-schema';
import modelsDevCatalog from '@openkit/models-dev-catalog/snapshots/2026-07-11/api.json' with {
  type: 'json',
};

import type { ProviderProfile } from '../config/providers-loader.js';
import { isProviderProfileDispatchable } from '../providers/llm-config.js';
import { gatewayCapabilitiesForProfile, type ProviderRegistry } from '../providers/registry.js';

interface ModelsDevModel {
  readonly family?: string;
  readonly attachment?: boolean;
  readonly reasoning?: boolean;
  readonly tool_call?: boolean;
  readonly temperature?: boolean;
  readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] };
}

interface ModelsDevProvider {
  readonly models?: Readonly<Record<string, ModelsDevModel>>;
}

const catalog = modelsDevCatalog as Readonly<Record<string, ModelsDevProvider>>;

/** Private route member resolved against current Server Provider supply. */
export interface ResolvedLogicalModelRoute {
  readonly id: string;
  readonly providerProfileId: string;
  readonly providerModel: string;
}

/** Product-visible logical model with optional catalog-derived contract fields. */
export interface ResolvedLogicalModel {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  /** Catalog family when inventory names one; null when family metadata is absent. */
  readonly modelFamilyId: string | null;
  readonly routes: readonly ResolvedLogicalModelRoute[];
}

/** Resolves configured logical models using optional catalog metadata and current Provider supply. */
export function resolveLogicalModelCatalog(
  config: GatewayConfig,
  providers: ProviderRegistry
): ResolvedLogicalModel[] {
  if (!config.enabled) {
    return [];
  }

  return config.logicalModels.flatMap((logicalModel) => {
    const authoredFamilies = logicalModel.routes.map((route) => {
      const profile = providers.get(route.providerProfileId);
      return profile === null ? null : modelContract(profile, route.providerModel).modelFamilyId;
    });
    const families = new Set(authoredFamilies);
    const unknownFamily = authoredFamilies.some((family) => family === null);
    if (unknownFamily ? logicalModel.routes.length !== 1 : families.size !== 1) {
      throw new Error(`Logical model routes cross model families: ${logicalModel.id}.`);
    }

    const eligibleRoutes = logicalModel.routes.filter((route) => {
      const profile = providers.get(route.providerProfileId);
      return profile !== null && isProviderProfileDispatchable(profile);
    });
    if (eligibleRoutes.length === 0) return [];
    const contracts = eligibleRoutes.map((route) => {
      const profile = providers.get(route.providerProfileId)!;
      if (!profile.models.includes(route.providerModel)) {
        throw new Error(`Logical model route model is not provided: ${route.id}.`);
      }
      return modelContract(profile, route.providerModel);
    });

    return [
      {
        id: logicalModel.id,
        displayName: logicalModel.displayName,
        capabilities: intersectCapabilities(contracts.map((contract) => contract.capabilities)),
        modelFamilyId: contracts[0]!.modelFamilyId,
        routes: eligibleRoutes.map((route) => ({ ...route })),
      },
    ];
  });
}

/** Finds one configured logical model, using the Gateway default only when no ID was supplied. */
export function resolveLogicalModel(
  config: GatewayConfig,
  providers: ProviderRegistry,
  logicalModelId?: string
): ResolvedLogicalModel | null {
  const selectedId = logicalModelId ?? config.defaultLogicalModelId;
  if (!selectedId) {
    return null;
  }
  return (
    resolveLogicalModelCatalog(config, providers).find((model) => model.id === selectedId) ?? null
  );
}

/**
 * Derives one route contract from optional catalog metadata and the Provider endpoint matrix.
 *
 * @param profile Provider profile that lists the model.
 * @param modelId Configured provider-native model id.
 * @returns Endpoint capabilities plus catalog flags when present, with null family when unknown.
 */
function modelContract(
  profile: ProviderProfile,
  modelId: string
): { capabilities: readonly string[]; modelFamilyId: string | null } {
  const modelNamespace = modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : null;
  const provider = providerCatalog(profile, modelNamespace);
  const subscriptionFamily = resolveProviderSubscriptionFamily(profile);
  const model = [
    modelId,
    ...(modelNamespace ? [modelId.slice(modelNamespace.length + 1)] : []),
    ...(subscriptionFamily && modelId.startsWith(`${subscriptionFamily}/`)
      ? [modelId.slice(subscriptionFamily.length + 1)]
      : []),
  ]
    .map((candidate) => provider?.models?.[candidate])
    .find((candidate) => candidate !== undefined);

  const capabilities = new Set<string>();
  if (model) {
    for (const modality of model.modalities?.input ?? []) capabilities.add(`input:${modality}`);
    for (const modality of model.modalities?.output ?? []) capabilities.add(`output:${modality}`);
    if (model.attachment) capabilities.add('attachment');
    if (model.reasoning) capabilities.add('reasoning');
    if (model.tool_call) capabilities.add('tool-calling');
    if (model.temperature) capabilities.add('temperature');
  }
  const endpoints = gatewayCapabilitiesForProfile(profile);
  if (endpoints.chatCompletions !== 'unsupported') capabilities.add('chat-completions');
  if (endpoints.responses !== 'unsupported') capabilities.add('responses');

  const family =
    typeof model?.family === 'string' && model.family.trim().length > 0 ? model.family : null;
  return { capabilities: [...capabilities].sort(), modelFamilyId: family };
}

function providerCatalog(
  profile: ProviderProfile,
  modelNamespace: string | null
): ModelsDevProvider | undefined {
  const subscriptionFamily = resolveProviderSubscriptionFamily(profile);
  const candidates = [
    subscriptionFamily === 'openai-codex' ? 'openai' : subscriptionFamily,
    profile.vendor,
    profile.id,
    modelNamespace,
  ];
  return candidates
    .flatMap((candidate) => (candidate ? [candidate, candidate.replaceAll('_', '-')] : []))
    .map((candidate) => catalog[candidate])
    .find((candidate) => candidate !== undefined);
}

function intersectCapabilities(capabilitySets: readonly (readonly string[])[]): string[] {
  const [first, ...rest] = capabilitySets;
  return (first ?? []).filter((capability) =>
    rest.every((capabilities) => capabilities.includes(capability))
  );
}
