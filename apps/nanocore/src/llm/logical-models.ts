import {
  type AgentEnvironmentLlmModelParameters,
  AgentEnvironmentLlmModelParametersSchema,
  type GatewayConfig,
  resolveProviderSubscriptionFamily,
} from '@openkit/config-schema';
import modelsDevCatalog from '@openkit/models-dev-catalog/snapshots/2026-10-01/api.json' with {
  type: 'json',
};

import type { ProviderProfile } from '../config/providers-loader.js';
import { isProviderProfileDispatchable } from '../providers/llm-config.js';
import { gatewayCapabilitiesForProfile, type ProviderRegistry } from '../providers/registry.js';
import type { ProviderSubscriptionAccountManager } from './provider-subscription-accounts.js';

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
  /** Current supply eligibility, recomputed rather than retained as health state. */
  readonly available: boolean;
  /** Fixed supply reason when this member cannot be selected. */
  readonly unavailableReason: string | null;
}

/** Product-visible logical model with optional catalog-derived contract fields. */
export interface ResolvedLogicalModel {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  /** Required OpenKit-owned context policy admitted against every authored route. */
  readonly contextManagement: {
    readonly type: 'compaction';
    readonly compactThreshold: number;
  };
  /** Shared non-null family across members with known metadata; otherwise null. */
  readonly modelFamilyId: string | null;
  /** Complete minimum-limit and intersected-modality inputs when required values are known. */
  readonly modelParameters?: AgentEnvironmentLlmModelParameters;
  /** Omission of authored routing preserves automatic failover. */
  readonly autoFailover: boolean;
  readonly routes: readonly ResolvedLogicalModelRoute[];
}

/** Resolves retained logical IDs, coherent contracts, and every ordered member against current Provider and account supply. */
export function resolveLogicalModelCatalog(
  config: GatewayConfig,
  providers: ProviderRegistry,
  subscriptionAccounts?: Pick<ProviderSubscriptionAccountManager, 'gatewayUnavailableReason'>
): ResolvedLogicalModel[] {
  if (!config.enabled) {
    return [];
  }

  return config.logicalModels.map((logicalModel) => {
    const authoredContracts = logicalModel.routes.map((route) => {
      const profile = providers.get(route.providerProfileId);
      return profile?.models.includes(route.providerModel)
        ? modelContract(profile, route.providerModel)
        : null;
    });
    const contextManagement = logicalModel.contextManagement?.[0];
    if (!contextManagement) {
      throw new Error(`Logical model context management is missing: ${logicalModel.id}.`);
    }
    for (const contract of authoredContracts) {
      if (!contract) continue;
      if (
        contract.contextLimit === null ||
        contextManagement.compactThreshold > contract.contextLimit ||
        (contract.outputLimit !== null &&
          contextManagement.compactThreshold + contract.outputLimit > contract.contextLimit)
      ) {
        throw new Error(
          `Logical model context management exceeds a route limit: ${logicalModel.id}.`
        );
      }
    }

    const contracts = authoredContracts.filter((contract) => contract !== null);
    const families = contracts.map((contract) => contract.modelFamilyId);
    const inputModalities =
      contracts.length > 0 && contracts.every((contract) => contract.inputModalities !== undefined)
        ? intersectCapabilities(contracts.map((contract) => contract.inputModalities!))
        : undefined;
    const modelParameters = AgentEnvironmentLlmModelParametersSchema.safeParse({
      contextWindow: minimumKnownLimit(contracts.map((contract) => contract.contextLimit)),
      maxOutputTokens: minimumKnownLimit(contracts.map((contract) => contract.outputLimit)),
      inputModalities,
      reasoning: contracts.length > 0 && contracts.every((contract) => contract.reasoning === true),
    });
    return {
      id: logicalModel.id,
      displayName: logicalModel.displayName,
      capabilities: intersectCapabilities(contracts.map((contract) => contract.capabilities)),
      contextManagement,
      modelFamilyId:
        families[0] != null && families.every((family) => family === families[0])
          ? families[0]!
          : null,
      ...(modelParameters.success ? { modelParameters: modelParameters.data } : {}),
      autoFailover: logicalModel.routing?.autoFailover ?? true,
      routes: logicalModel.routes.map((route) => {
        const profile = providers.get(route.providerProfileId);
        const unavailableReason =
          profile === null
            ? 'provider_profile_absent'
            : !profile.models.includes(route.providerModel)
              ? 'provider_model_delisted'
              : !isProviderProfileDispatchable(profile)
                ? 'provider_not_dispatchable'
                : subscriptionUnavailableReason(profile, subscriptionAccounts);
        return { ...route, available: unavailableReason === null, unavailableReason };
      }),
    };
  });
}

/** Finds one configured logical model, using the Gateway default only when no ID was supplied. */
export function resolveLogicalModel(
  config: GatewayConfig,
  providers: ProviderRegistry,
  logicalModelId?: string,
  subscriptionAccounts?: Pick<ProviderSubscriptionAccountManager, 'gatewayUnavailableReason'>
): ResolvedLogicalModel | null {
  const selectedId = logicalModelId ?? config.defaultLogicalModelId;
  if (!selectedId) {
    return null;
  }
  return (
    resolveLogicalModelCatalog(config, providers, subscriptionAccounts).find(
      (model) => model.id === selectedId
    ) ?? null
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
): {
  capabilities: readonly string[];
  contextLimit: number | null;
  modelFamilyId: string | null;
  outputLimit: number | null;
  inputModalities?: readonly string[];
  reasoning: boolean;
} {
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
  return {
    capabilities: [...capabilities].sort(),
    contextLimit: model.limit?.context ?? null,
    modelFamilyId: family,
    outputLimit: model.limit?.output ?? null,
    ...(model.modalities?.input !== undefined ? { inputModalities: model.modalities.input } : {}),
    reasoning: model.reasoning === true,
  };
}

/**
 * Merges pinned snapshot metadata with loaded extension and profile leaves.
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

/** Reads the closed subscription family without inventing one for ordinary catalog lookup. */
function resolveSubscriptionFamily(
  profile: ProviderProfile
): ReturnType<typeof resolveProviderSubscriptionFamily> {
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

/** Reuses the subscription owner's strict network-free availability check for bound profiles. */
function subscriptionUnavailableReason(
  profile: ProviderProfile,
  accounts?: Pick<ProviderSubscriptionAccountManager, 'gatewayUnavailableReason'>
): string | null {
  const family = resolveSubscriptionFamily(profile);
  const slot = profile.extensions?.openkit?.subscriptionAccount?.accountSlotId;
  if (profile.kind !== 'oauth' || !family || !slot) return null;
  return accounts
    ? accounts.gatewayUnavailableReason({ subscriptionProviderId: family, accountSlotId: slot })
    : null;
}

/** Returns the minimum sourced limit without inventing values for missing supply. */
function minimumKnownLimit(limits: readonly (number | null | undefined)[]): number | undefined {
  const known = limits.filter((limit): limit is number => limit !== null && limit !== undefined);
  return known.length > 0 ? Math.min(...known) : undefined;
}

function intersectCapabilities(capabilitySets: readonly (readonly string[])[]): string[] {
  const [first, ...rest] = capabilitySets;
  return (first ?? []).filter((capability) =>
    rest.every((capabilities) => capabilities.includes(capability))
  );
}
