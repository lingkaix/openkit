import type { ProviderModelDiagnostic } from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentLlmModelParameters,
  AgentEnvironmentLlmModelParametersSchema,
  type GatewayConfig,
  resolveProviderSubscriptionFamily,
} from '@openkit/config-schema';
import modelsDevCatalog from '@openkit/models-dev-catalog/snapshots/2026-10-01/api.json' with {
  type: 'json',
};
import { REASONING_EFFORT_LEVELS, type ReasoningEffort } from '@openkit/protocol';
import type { ProviderProfile } from '../config/providers-loader.js';
import { type LocalBackendId, probeLocalSupply } from '../local-ai/supply.js';
import {
  gatewayCapabilitiesForProfile,
  isProviderProfileDispatchable,
  providerRequiresCredentials,
} from '../providers/profile-capabilities.js';
import type { ProviderCredentialConfigured, ProviderRegistry } from '../providers/registry.js';
import type { ProviderSubscriptionAccountManager } from './provider-subscription-accounts.js';

interface ModelsDevModel {
  readonly family?: string;
  readonly attachment?: boolean;
  readonly reasoning?: boolean;
  /** Pinned control shapes; budget controls do not contribute ordered effort levels. */
  readonly reasoning_options?: readonly (
    | { readonly type: 'toggle' }
    | { readonly type: 'effort'; readonly values: readonly string[] }
    | { readonly type: 'budget_tokens'; readonly min?: number; readonly max?: number }
  )[];
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
  /** Effective replacement array of supported models.dev control shapes. */
  readonly reasoning_options?: readonly (
    | { readonly type: 'toggle' }
    | { readonly type: 'effort'; readonly values: readonly string[] }
  )[];
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

/** Private route metadata; Gateway supply eligibility never grants native Login authority. */
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
  /** Partial coherent metadata for deployment diagnostics, without requiring a complete adapter shape. */
  readonly contract?: {
    readonly context: number | null;
    readonly output: number | null;
    readonly inputModalities: readonly string[] | null;
    readonly reasoning: boolean | null;
  };
  /** Current available-member intersection in Core order; absent without reasoning, empty without declared levels. */
  readonly reasoningEffortLevels?: readonly ReasoningEffort[];
  readonly routes: readonly ResolvedLogicalModelRoute[];
}

/** Resolves retained logical IDs, authored contracts, ordered supply and the available-member effort intersection. */
export function resolveLogicalModelCatalog(
  config: GatewayConfig,
  providers: ProviderRegistry,
  subscriptionAccounts?: Pick<ProviderSubscriptionAccountManager, 'gatewayUnavailableReason'>,
  providerCredentialConfigured?: ProviderCredentialConfigured
): ResolvedLogicalModel[] {
  return resolveLogicalModelCatalogForConnection(
    'gateway',
    config,
    providers,
    subscriptionAccounts,
    providerCredentialConfigured
  );
}

/**
 * Resolves exact authored Codex native mappings without consulting Server Gateway credentials.
 * Explicit sets resolve only their IDs; `all` must represent every authored logical model.
 * Returned routes remain unavailable to Gateway selection: current Login authority is a separate owner.
 */
export function resolveHarnessLogicalModelCatalog(
  config: GatewayConfig,
  providers: ProviderRegistry,
  logicalModelIds: 'all' | readonly string[]
): ResolvedLogicalModel[] {
  return resolveLogicalModelCatalogForConnection(
    'harness',
    {
      ...config,
      logicalModels:
        logicalModelIds === 'all'
          ? config.logicalModels
          : config.logicalModels.filter((model) => logicalModelIds.includes(model.id)),
    },
    providers
  );
}

/** Shares static contract admission while keeping the two connection holders' supply criteria separate. */
function resolveLogicalModelCatalogForConnection(
  mode: 'gateway' | 'harness',
  config: GatewayConfig,
  providers: ProviderRegistry,
  subscriptionAccounts?: Pick<ProviderSubscriptionAccountManager, 'gatewayUnavailableReason'>,
  providerCredentialConfigured?: ProviderCredentialConfigured
): ResolvedLogicalModel[] {
  if (mode === 'gateway' && !config.enabled) {
    return [];
  }

  return config.logicalModels.map((logicalModel) => {
    if (mode === 'harness') {
      const nativeIds = new Set<string>();
      for (const route of logicalModel.routes) {
        const profile = providers.get(route.providerProfileId);
        if (
          !profile ||
          profile.kind !== 'oauth' ||
          resolveSubscriptionFamily(profile) !== 'openai-codex' ||
          !profile.models.includes(route.providerModel)
        ) {
          throw new Error(
            `Logical model has no admitted Codex native mapping: ${logicalModel.id}.`
          );
        }
        nativeIds.add(route.providerModel);
      }
      if (nativeIds.size !== 1) {
        throw new Error(`Logical model has an ambiguous Codex native mapping: ${logicalModel.id}.`);
      }
    }
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
    if (mode === 'harness' && !modelParameters.success) {
      throw new Error(`Logical model has incomplete Codex native metadata: ${logicalModel.id}.`);
    }
    const routes = logicalModel.routes.map((route) => {
      if (mode === 'harness') {
        return { ...route, available: false, unavailableReason: 'harness_login_authority_pending' };
      }
      const profile = providers.get(route.providerProfileId);
      const unavailableReason =
        profile === null
          ? 'provider_profile_absent'
          : !profile.models.includes(route.providerModel)
            ? 'provider_model_delisted'
            : !isProviderProfileDispatchable(profile)
              ? 'provider_not_dispatchable'
              : afterLocalSupply(localSupplyReason(profile, route.providerModel), () =>
                  credentialUnavailableReason(
                    profile,
                    subscriptionAccounts,
                    providerCredentialConfigured
                  )
                );
      return { ...route, available: unavailableReason === null, unavailableReason };
    });
    const availableContracts = authoredContracts.filter(
      (contract, index): contract is NonNullable<typeof contract> =>
        contract !== null && (mode === 'harness' || routes[index]!.available)
    );
    const reasoningEffortLevels =
      availableContracts.length > 0 && availableContracts.every((contract) => contract.reasoning)
        ? REASONING_EFFORT_LEVELS.filter((level) =>
            availableContracts.every((contract) => contract.reasoningEffortLevels.includes(level))
          )
        : undefined;
    return {
      id: logicalModel.id,
      displayName: logicalModel.displayName,
      capabilities: intersectCapabilities(contracts.map((contract) => contract.capabilities)),
      contextManagement,
      contract: {
        context: minimumKnownLimit(contracts.map((contract) => contract.contextLimit)) ?? null,
        output: minimumKnownLimit(contracts.map((contract) => contract.outputLimit)) ?? null,
        inputModalities: inputModalities ?? null,
        reasoning:
          contracts.length > 0 && contracts.every((contract) => contract.reasoning !== undefined)
            ? contracts.every((contract) => contract.reasoning === true)
            : null,
      },
      modelFamilyId:
        families[0] != null && families.every((family) => family === families[0])
          ? families[0]!
          : null,
      ...(modelParameters.success ? { modelParameters: modelParameters.data } : {}),
      ...(reasoningEffortLevels !== undefined ? { reasoningEffortLevels } : {}),
      autoFailover: logicalModel.routing?.autoFailover ?? true,
      routes,
    };
  });
}

/** Finds one configured logical model, using the Gateway default only when no ID was supplied. */
export function resolveLogicalModel(
  config: GatewayConfig,
  providers: ProviderRegistry,
  logicalModelId?: string,
  subscriptionAccounts?: Pick<ProviderSubscriptionAccountManager, 'gatewayUnavailableReason'>,
  providerCredentialConfigured?: ProviderCredentialConfigured
): ResolvedLogicalModel | null {
  const selectedId = logicalModelId ?? config.defaultLogicalModelId;
  if (!selectedId) {
    return null;
  }
  return (
    resolveLogicalModelCatalog(
      config,
      providers,
      subscriptionAccounts,
      providerCredentialConfigured
    ).find((model) => model.id === selectedId) ?? null
  );
}

/**
 * Derives one route contract from optional catalog metadata and the Provider endpoint matrix.
 *
 * @param profile Provider profile that lists the model.
 * @param modelId Configured provider-native model id.
 * @returns Endpoint capabilities, canonical effort levels and catalog flags, with null family when unknown.
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
  reasoning: boolean | undefined;
  reasoningEffortLevels: readonly ReasoningEffort[];
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
    reasoning: model.reasoning,
    reasoningEffortLevels: REASONING_EFFORT_LEVELS.filter((level) =>
      model.reasoning_options?.some((option) =>
        option.type === 'toggle' ? level === 'none' : option.values.includes(level)
      )
    ),
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
    reasoning_options?: NonNullable<EffectiveModelMetadata['reasoning_options']>;
    tool_call?: boolean;
    temperature?: boolean;
    modalities?: { input?: readonly string[]; output?: readonly string[] };
    limit?: { context?: number; output?: number };
    cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  } = {};
  assignLeaf(effective, 'family', pickLeaf(authored?.family, catalogModel?.family));
  assignLeaf(effective, 'attachment', pickLeaf(authored?.attachment, catalogModel?.attachment));
  assignLeaf(effective, 'reasoning', pickLeaf(authored?.reasoning, catalogModel?.reasoning));
  assignLeaf(
    effective,
    'reasoning_options',
    pickLeaf(
      authored?.reasoning_options,
      catalogModel?.reasoning_options?.filter((option) => option.type !== 'budget_tokens')
    )
  );
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

/** Projects effective native metadata using the same resolver as dispatch, with per-leaf provenance. */
export function resolveProviderModelDiagnostic(
  profile: ProviderProfile,
  nativeId: string
): ProviderModelDiagnostic {
  const effective = resolveEffectiveModelMetadata(profile, nativeId);
  const sources = profile.modelMetadataSources?.[nativeId];
  const leaf = <T>(path: string, value: T | undefined) => ({
    value: value ?? null,
    source:
      value === undefined
        ? null
        : (sources?.[path] ??
          (profile.modelMetadata &&
          !profile.modelMetadataSources &&
          readMetadataLeaf(profile.modelMetadata[nativeId], path) !== undefined
            ? ('profile-override' as const)
            : ('upstream-snapshot' as const))),
  });
  return {
    id: nativeId,
    context: leaf('limit.context', effective.limit?.context),
    output: leaf('limit.output', effective.limit?.output),
    inputModalities: leaf(
      'modalities.input',
      effective.modalities?.input ? [...effective.modalities.input] : undefined
    ),
    outputModalities: leaf(
      'modalities.output',
      effective.modalities?.output ? [...effective.modalities.output] : undefined
    ),
    reasoning: leaf('reasoning', effective.reasoning),
    reasoningEffortLevels: leaf(
      'reasoning_options',
      effective.reasoning_options === undefined
        ? undefined
        : effective.reasoning === false
          ? []
          : [...modelContract(profile, nativeId).reasoningEffortLevels]
    ),
    cost: {
      input: leaf('cost.input', effective.cost?.input),
      output: leaf('cost.output', effective.cost?.output),
      cache_read: leaf('cost.cache_read', effective.cost?.cache_read),
      cache_write: leaf('cost.cache_write', effective.cost?.cache_write),
    },
  };
}

/** Reads an already validated metadata leaf for profiles supplied directly rather than through the loader. */
function readMetadataLeaf(metadata: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined,
      metadata
    );
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

/** Closed transcription supply reasons. */
export type TranscriptionUnavailableReason =
  | 'provider_profile_absent'
  | 'provider_model_delisted'
  | 'provider_not_dispatchable'
  | 'provider_api_key_missing'
  | 'subscription_vault_unavailable'
  | 'subscription_account_absent'
  | 'subscription_account_logged_out'
  | 'subscription_account_integrity_unavailable'
  | 'gateway_disabled'
  | 'provider_base_url_missing'
  | 'local_backend_disabled'
  | 'local_model_not_downloaded'
  | 'local_backend_starting'
  | 'local_backend_unhealthy';

/** Resolved transcription chain. Absent when the Gateway file does not declare one. */
export type ResolvedTranscriptionRoute =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly autoFailover: boolean;
      readonly routes: readonly ResolvedLogicalModelRoute[];
    };

/**
 * Rejects every configured native model that lacks catalog or authored context.
 *
 * A model used only by the transcription route is exempt. The same provider and
 * model still need a context limit when a logical chat route names them.
 *
 * @param providers Loaded provider registry.
 * @param gateway Gateway file used to recognize a transcription-only model.
 * @throws When any listed model has no known positive context limit.
 */
export function assertConfiguredModelsHaveKnownContext(
  providers: ProviderRegistry,
  gateway?: Pick<GatewayConfig, 'logicalModels' | 'transcription'>
): void {
  const exempt = transcriptionOnlyModelKeys(gateway);
  for (const profile of providers.list()) {
    if (profile.extensions?.openkit?.localBackend?.backendId === 'sherpa-onnx-asr') continue;
    for (const modelId of profile.models) {
      if (exempt.has(`${profile.id}\0${modelId}`)) continue;
      if (!hasKnownContext(resolveEffectiveModelMetadata(profile, modelId))) {
        throw new Error(
          `Provider ${profile.id} model ${modelId} has no known positive context limit.`
        );
      }
    }
  }
}

/**
 * Projects the one transcription route without contacting upstream.
 *
 * Credential presence is optional so a caller that has already been admitted can
 * resolve the secret later, through the existing provider resolver.
 *
 * @param config Authored Gateway file.
 * @param providers Loaded provider registry.
 * @param subscriptionAccounts Subscription supply checker, when the process has one.
 * @param providerCredentialConfigured Presence check that does not have to resolve Vault material.
 * @param checkCredentials When false, credential reasons are left for the later resolver.
 * @returns Configured flag plus availability. An omitted member is not configured.
 */
export function resolveTranscriptionRoute(
  config: Pick<GatewayConfig, 'enabled' | 'transcription'>,
  providers: ProviderRegistry,
  subscriptionAccounts?: Pick<ProviderSubscriptionAccountManager, 'gatewayUnavailableReason'>,
  providerCredentialConfigured?: ProviderCredentialConfigured,
  checkCredentials = true
): ResolvedTranscriptionRoute {
  const transcription = config.transcription;
  if (!transcription) return { configured: false };
  const autoFailover = transcription.routing?.autoFailover ?? true;
  const routes = transcription.routes.map((member) =>
    resolveTranscriptionMember(
      member,
      config.enabled,
      providers,
      subscriptionAccounts,
      providerCredentialConfigured,
      checkCredentials
    )
  );
  return { configured: true, autoFailover, routes };
}

/** Resolves one speech member. Local supply is checked before credentials and base URL. */
function resolveTranscriptionMember(
  member: { id: string; providerProfileId: string; providerModel: string },
  gatewayEnabled: boolean,
  providers: ProviderRegistry,
  subscriptionAccounts:
    | Pick<ProviderSubscriptionAccountManager, 'gatewayUnavailableReason'>
    | undefined,
  providerCredentialConfigured: ProviderCredentialConfigured | undefined,
  checkCredentials: boolean
): ResolvedLogicalModelRoute {
  if (!gatewayEnabled) {
    return { ...member, available: false, unavailableReason: 'gateway_disabled' };
  }
  const profile = providers.get(member.providerProfileId);
  const unavailableReason: TranscriptionUnavailableReason | null =
    profile === null
      ? 'provider_profile_absent'
      : !profile.models.includes(member.providerModel)
        ? 'provider_model_delisted'
        : !isProviderProfileDispatchable(profile)
          ? 'provider_not_dispatchable'
          : afterLocalSupply(localSupplyReason(profile, member.providerModel), () =>
              profile.baseUrl
                ? checkCredentials
                  ? credentialReason(profile, subscriptionAccounts, providerCredentialConfigured)
                  : null
                : 'provider_base_url_missing'
            );
  return { ...member, available: unavailableReason === null, unavailableReason };
}

/** Returns provider/model pairs that appear only on the transcription chain. */
function transcriptionOnlyModelKeys(
  gateway: Pick<GatewayConfig, 'logicalModels' | 'transcription'> | undefined
): Set<string> {
  const chat = new Set<string>();
  for (const model of gateway?.logicalModels ?? []) {
    for (const route of model.routes)
      chat.add(`${route.providerProfileId}\0${route.providerModel}`);
  }
  const exempt = new Set<string>();
  for (const route of gateway?.transcription?.routes ?? []) {
    const key = `${route.providerProfileId}\0${route.providerModel}`;
    if (!chat.has(key)) exempt.add(key);
  }
  return exempt;
}

/** Local backends answer before credential and base-URL checks. Undefined means this is not one. */
function localSupplyReason(
  profile: ProviderProfile,
  providerModel: string
): TranscriptionUnavailableReason | null | undefined {
  const backendId = profile.extensions?.openkit?.localBackend?.backendId;
  if (!backendId) return undefined;
  const supply = probeLocalSupply(backendId as LocalBackendId, providerModel);
  return supply.available ? null : supply.reason;
}

/** Keeps a local decision, including available, from falling through to credential and base-URL checks. */
function afterLocalSupply<Reason extends string>(
  local: Reason | null | undefined,
  otherwise: () => Reason | null
): Reason | null {
  return local === undefined ? otherwise() : local;
}

/** Maps the existing credential presence result onto the closed reason set. */
function credentialReason(
  profile: ProviderProfile,
  subscriptionAccounts:
    | Pick<ProviderSubscriptionAccountManager, 'gatewayUnavailableReason'>
    | undefined,
  providerCredentialConfigured: ProviderCredentialConfigured | undefined
): TranscriptionUnavailableReason | null {
  const reason = credentialUnavailableReason(
    profile,
    subscriptionAccounts,
    providerCredentialConfigured
  );
  if (
    reason === 'provider_api_key_missing' ||
    reason === 'subscription_vault_unavailable' ||
    reason === 'subscription_account_absent' ||
    reason === 'subscription_account_logged_out' ||
    reason === 'subscription_account_integrity_unavailable'
  ) {
    return reason;
  }
  return null;
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

/** Checks bound subscription supply or required API-key presence without resolving Vault material. */
function credentialUnavailableReason(
  profile: ProviderProfile,
  accounts?: Pick<ProviderSubscriptionAccountManager, 'gatewayUnavailableReason'>,
  providerCredentialConfigured?: ProviderCredentialConfigured
): string | null {
  const family = resolveSubscriptionFamily(profile);
  const slot = profile.extensions?.openkit?.subscriptionAccount?.accountSlotId;
  if (profile.kind !== 'oauth' || !family || !slot) {
    return providerCredentialConfigured &&
      providerRequiresCredentials(profile) &&
      !providerCredentialConfigured(profile.secretRef)
      ? 'provider_api_key_missing'
      : null;
  }
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
