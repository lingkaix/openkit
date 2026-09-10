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
  readonly limit?: { readonly context?: number; readonly output?: number };
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly cache_read?: number;
    readonly cache_write?: number;
  };
}

/** Known adapter USD rates after authored, catalog, and real stock inherit. */
export interface AdapterCostRates {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** Catalog plus authored operational metadata for one native model id. */
export interface EffectiveModelMetadata {
  readonly family?: string;
  readonly attachment?: boolean;
  readonly reasoning?: boolean;
  readonly tool_call?: boolean;
  readonly temperature?: boolean;
  readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] };
  readonly limit?: { readonly context?: number; readonly output?: number };
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly cache_read?: number;
    readonly cache_write?: number;
  };
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
  const model = resolveEffectiveModelMetadata(profile, modelId);
  const capabilities = new Set<string>();
  for (const modality of model.modalities?.input ?? []) capabilities.add(`input:${modality}`);
  for (const modality of model.modalities?.output ?? []) capabilities.add(`output:${modality}`);
  if (model.attachment) capabilities.add('attachment');
  if (model.reasoning) capabilities.add('reasoning');
  if (model.tool_call) capabilities.add('tool-calling');
  if (model.temperature) capabilities.add('temperature');
  const endpoints = gatewayCapabilitiesForProfile(profile);
  if (endpoints.chatCompletions !== 'unsupported') capabilities.add('chat-completions');
  if (endpoints.responses !== 'unsupported') capabilities.add('responses');

  const family =
    typeof model.family === 'string' && model.family.trim().length > 0 ? model.family : null;
  return { capabilities: [...capabilities].sort(), modelFamilyId: family };
}

/**
 * Merges pinned catalog metadata with authored Provider leaves for one native model id.
 *
 * @param profile Provider profile that lists the model.
 * @param nativeId Exact provider-native model id.
 * @returns Effective operational metadata; omitted optional leaves remain unknown.
 */
export function resolveEffectiveModelMetadata(
  profile: ProviderProfile,
  nativeId: string
): EffectiveModelMetadata {
  const catalogModel = lookupCatalogModel(profile, nativeId);
  const authored = profile.modelMetadata?.[nativeId];
  const effective: {
    family?: string;
    attachment?: boolean;
    reasoning?: boolean;
    tool_call?: boolean;
    temperature?: boolean;
    modalities?: { input?: readonly string[]; output?: readonly string[] };
    limit?: { context?: number; output?: number };
    cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  } = {};
  assignLeaf(effective, 'family', pickLeaf(authored?.family, catalogModel?.family));
  assignLeaf(effective, 'attachment', pickLeaf(authored?.attachment, catalogModel?.attachment));
  assignLeaf(effective, 'reasoning', pickLeaf(authored?.reasoning, catalogModel?.reasoning));
  assignLeaf(effective, 'tool_call', pickLeaf(authored?.tool_call, catalogModel?.tool_call));
  assignLeaf(effective, 'temperature', pickLeaf(authored?.temperature, catalogModel?.temperature));

  const modalities: { input?: readonly string[]; output?: readonly string[] } = {};
  assignLeaf(
    modalities,
    'input',
    pickLeaf(authored?.modalities?.input, catalogModel?.modalities?.input)
  );
  assignLeaf(
    modalities,
    'output',
    pickLeaf(authored?.modalities?.output, catalogModel?.modalities?.output)
  );
  if (modalities.input !== undefined || modalities.output !== undefined) {
    effective.modalities = modalities;
  }

  const limit: { context?: number; output?: number } = {};
  assignLeaf(limit, 'context', pickLeaf(authored?.limit?.context, catalogModel?.limit?.context));
  assignLeaf(limit, 'output', pickLeaf(authored?.limit?.output, catalogModel?.limit?.output));
  if (limit.context !== undefined || limit.output !== undefined) {
    effective.limit = limit;
  }

  const cost: { input?: number; output?: number; cache_read?: number; cache_write?: number } = {};
  assignLeaf(cost, 'input', pickLeaf(authored?.cost?.input, catalogModel?.cost?.input));
  assignLeaf(cost, 'output', pickLeaf(authored?.cost?.output, catalogModel?.cost?.output));
  assignLeaf(
    cost,
    'cache_read',
    pickLeaf(authored?.cost?.cache_read, catalogModel?.cost?.cache_read)
  );
  assignLeaf(
    cost,
    'cache_write',
    pickLeaf(authored?.cost?.cache_write, catalogModel?.cost?.cache_write)
  );
  if (
    cost.input !== undefined ||
    cost.output !== undefined ||
    cost.cache_read !== undefined ||
    cost.cache_write !== undefined
  ) {
    effective.cost = cost;
  }

  return effective;
}

/**
 * Returns whether effective metadata includes a sourced positive context limit.
 *
 * @param effective Merged catalog and authored metadata.
 * @returns True when `limit.context` is a positive integer.
 */
export function hasKnownContext(effective: EffectiveModelMetadata): boolean {
  const context = effective.limit?.context;
  return typeof context === 'number' && Number.isInteger(context) && context > 0;
}

/**
 * Leaf-merges authored and catalog cost onto real stock or pair adapter rates.
 *
 * @param inherited Real stock, template, or pair rates. Synthetic custom zeros are not inherited.
 * @param effective Merged catalog and authored metadata.
 * @returns Known leaves after inherit, and whether all four adapter rates are present.
 */
export function mergeAdapterCostRates(
  inherited: AdapterCostRates | undefined,
  effective: EffectiveModelMetadata
): { complete: boolean; rates: AdapterCostRates } {
  const rates: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } = {};
  assignLeaf(
    rates,
    'input',
    pickLeaf(knownRate(effective.cost?.input), knownRate(inherited?.input))
  );
  assignLeaf(
    rates,
    'output',
    pickLeaf(knownRate(effective.cost?.output), knownRate(inherited?.output))
  );
  assignLeaf(
    rates,
    'cacheRead',
    pickLeaf(knownRate(effective.cost?.cache_read), knownRate(inherited?.cacheRead))
  );
  assignLeaf(
    rates,
    'cacheWrite',
    pickLeaf(knownRate(effective.cost?.cache_write), knownRate(inherited?.cacheWrite))
  );
  return {
    complete: [rates.input, rates.output, rates.cacheRead, rates.cacheWrite].every(
      (value) => value !== undefined
    ),
    rates,
  };
}

/**
 * Returns whether all four adapter USD rates are known and finite.
 *
 * @param effective Merged catalog and authored metadata.
 * @param inherited Optional real stock, template, or pair rates.
 * @returns True when input, output, cache read, and cache write are finite nonnegative numbers.
 */
export function hasCompleteCostRates(
  effective: EffectiveModelMetadata,
  inherited?: AdapterCostRates
): boolean {
  return mergeAdapterCostRates(inherited, effective).complete;
}

/**
 * Rejects every configured native model that lacks catalog or authored context.
 *
 * @param providers Loaded provider registry.
 * @throws When any listed model has no known positive context limit.
 */
export function assertConfiguredModelsHaveKnownContext(providers: ProviderRegistry): void {
  for (const profile of providers.list()) {
    for (const modelId of profile.models) {
      if (!hasKnownContext(resolveEffectiveModelMetadata(profile, modelId))) {
        throw new Error(
          `Provider ${profile.id} model ${modelId} has no known positive context limit.`
        );
      }
    }
  }
}

function lookupCatalogModel(profile: ProviderProfile, modelId: string): ModelsDevModel | undefined {
  const modelNamespace = modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : null;
  const provider = providerCatalog(profile, modelNamespace);
  const subscriptionFamily = resolveSubscriptionFamily(profile);
  return [
    modelId,
    ...(modelNamespace ? [modelId.slice(modelNamespace.length + 1)] : []),
    ...(subscriptionFamily && modelId.startsWith(`${subscriptionFamily}/`)
      ? [modelId.slice(subscriptionFamily.length + 1)]
      : []),
  ]
    .map((candidate) => provider?.models?.[candidate])
    .find((candidate) => candidate !== undefined);
}

function providerCatalog(
  profile: ProviderProfile,
  modelNamespace: string | null
): ModelsDevProvider | undefined {
  const subscriptionFamily = resolveSubscriptionFamily(profile);
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

function resolveSubscriptionFamily(profile: ProviderProfile): string | null {
  try {
    return resolveProviderSubscriptionFamily(profile);
  } catch {
    return null;
  }
}

function knownRate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function pickLeaf<T>(authored: T | undefined, inherited: T | undefined): T | undefined {
  return authored !== undefined ? authored : inherited;
}

function assignLeaf<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function intersectCapabilities(capabilitySets: readonly (readonly string[])[]): string[] {
  const [first, ...rest] = capabilitySets;
  return (first ?? []).filter((capability) =>
    rest.every((capabilities) => capabilities.includes(capability))
  );
}
