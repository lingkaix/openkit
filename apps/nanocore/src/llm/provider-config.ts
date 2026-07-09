import { CODEX_OAUTH_DEFAULT_ACCOUNT_SLOT_ID } from '../providers/codex-oauth-profile.js';
import {
  findProviderSpec,
  type LLMProviderGatewayCapabilities,
  type LLMProviderSpec,
  listProviderSpecs,
} from './provider-registry.js';

/**
 * Source used to satisfy provider authentication.
 */
export type LLMProviderApiKeySource = 'stored' | 'env' | 'vault' | 'missing' | 'not-required';

/**
 * Named default provider/model selection slot.
 */
export interface LLMProviderDefaultSelection {
  /** Provider ID used for this default slot. */
  readonly providerId: string | null;
  /** Model name used for this default slot. */
  readonly model: string | null;
}

/**
 * Default provider/model selections for nanocore LLM consumers.
 */
export interface LLMProviderDefaults {
  /** Provider/model used by quick chat requests. */
  readonly quickChat: LLMProviderDefaultSelection;
  /** Provider/model used by internal nanocore tasks. */
  readonly internalTasks: LLMProviderDefaultSelection;
  /** Provider/model used by the OpenAI-compatible agent gateway. */
  readonly gateway: LLMProviderDefaultSelection;
}

/**
 * Input used to create or update a configured LLM provider.
 */
export interface UpsertLLMProviderConfigInput {
  /** Provider ID from the static provider registry. */
  readonly providerId: string;
  /** Optional configured model for this provider. */
  readonly model?: string | null;
  /** Optional configured base URL override. */
  readonly baseUrl?: string | null;
  /** Optional write-only API key. */
  readonly apiKey?: string | null;
  /** Optional OpenAI-compatible extra request headers. */
  readonly extraHeaders?: Record<string, string> | undefined;
  /** Optional OpenAI-compatible extra request body fields. */
  readonly extraBody?: Record<string, unknown> | undefined;
}

/**
 * Sanitized provider config returned to UI and diagnostics callers.
 */
export interface SanitizedLLMProviderConfig {
  /** Configured provider instance ID. */
  readonly id: string;
  /** Static provider spec ID. */
  readonly specId: string;
  /** Human-readable provider name. */
  readonly displayName: string;
  /** Configured model name, when selected. */
  readonly model: string | null;
  /** Effective base URL without secrets. */
  readonly baseUrl: string | null;
  /** Whether a stored, vault, or environment API key is available. */
  readonly hasApiKey: boolean;
  /** Non-secret source used for API-key resolution. */
  readonly apiKeySource: LLMProviderApiKeySource;
  /** Gateway support matrix for this configured provider. */
  readonly gatewayCapabilities: LLMProviderGatewayCapabilities;
  /** Non-secret Codex OAuth account slot reference used by subscription providers. */
  readonly codexOAuthAccountSlotId?: string;
  /** OpenAI-compatible extra headers allowed for this provider. */
  readonly extraHeaders: Record<string, string>;
  /** OpenAI-compatible extra body fields allowed for this provider. */
  readonly extraBody: Record<string, unknown>;
}

/**
 * Secret-bearing provider config used only by internal callers.
 */
export interface ResolvedLLMProviderConfig extends SanitizedLLMProviderConfig {
  /** Static provider metadata for routing and validation. */
  readonly spec: LLMProviderSpec;
  /** Resolved API key from stored config, vault, or environment, never returned through app APIs. */
  readonly apiKey: string | null;
}

/**
 * Provider list payload for Settings and app API callers.
 */
export interface LLMProviderList {
  /** Static supported provider metadata. */
  readonly specs: LLMProviderSpec[];
  /** Sanitized configured provider instances. */
  readonly configured: SanitizedLLMProviderConfig[];
  /** Current default provider/model selections. */
  readonly defaults: LLMProviderDefaults;
}

interface StoredLLMProviderConfig {
  id: string;
  specId: string;
  model: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  extraHeaders: Record<string, string>;
  extraBody: Record<string, unknown>;
}

const EMPTY_DEFAULT_SELECTION: LLMProviderDefaultSelection = {
  providerId: null,
  model: null,
};

/**
 * App-local in-memory LLM provider configuration store.
 */
export class LLMProviderConfigStore {
  private readonly providers = new Map<string, StoredLLMProviderConfig>();
  private defaults: LLMProviderDefaults = {
    quickChat: EMPTY_DEFAULT_SELECTION,
    internalTasks: EMPTY_DEFAULT_SELECTION,
    gateway: EMPTY_DEFAULT_SELECTION,
  };

  /**
   * Return all supported provider specs, sanitized configured providers, and defaults.
   *
   * @returns Provider list payload without secret values.
   */
  public listProviders(): LLMProviderList {
    return {
      specs: listProviderSpecs(),
      configured: [...this.providers.keys()].map((id) => this.getProvider(id)),
      defaults: this.getDefaults(),
    };
  }

  /**
   * Create or update a provider configuration.
   *
   * @param input Provider config input that may contain a write-only API key.
   * @returns Sanitized provider config without raw secrets.
   */
  public upsertProvider(input: UpsertLLMProviderConfigInput): SanitizedLLMProviderConfig {
    const spec = this.requireSpec(input.providerId);
    const existing = this.providers.get(spec.id);

    if (spec.isOAuth && input.apiKey) {
      throw new Error(`${spec.displayName} uses OAuth and cannot store an API key.`);
    }

    const stored: StoredLLMProviderConfig = {
      id: spec.id,
      specId: spec.id,
      model: input.model ?? existing?.model ?? null,
      baseUrl: input.baseUrl ?? existing?.baseUrl ?? spec.defaultBaseUrl,
      apiKey: input.apiKey ?? existing?.apiKey ?? null,
      extraHeaders: spec.extraHeadersAllowed
        ? (input.extraHeaders ?? existing?.extraHeaders ?? {})
        : {},
      extraBody: spec.extraBodyAllowed ? (input.extraBody ?? existing?.extraBody ?? {}) : {},
    };

    this.providers.set(stored.id, stored);
    return this.sanitize(stored, spec);
  }

  /**
   * Return one sanitized configured provider.
   *
   * @param providerId Provider ID to read.
   * @returns Sanitized provider config without raw secrets.
   */
  public getProvider(providerId: string): SanitizedLLMProviderConfig {
    const spec = this.requireSpec(providerId);
    const stored = this.providers.get(spec.id);

    if (!stored) {
      throw new Error(`LLM provider is not configured: ${spec.id}`);
    }

    return this.sanitize(stored, spec);
  }

  /**
   * Return one configured provider with internally resolved secret material.
   *
   * @param providerId Provider ID to resolve.
   * @returns Secret-bearing provider config for internal use only.
   */
  public resolveProvider(providerId: string): ResolvedLLMProviderConfig {
    const spec = this.requireSpec(providerId);
    const stored = this.providers.get(spec.id);

    if (!stored) {
      throw new Error(`LLM provider is not configured: ${spec.id}`);
    }

    const apiKey = stored.apiKey ?? this.resolveEnvKey(spec);

    return {
      ...this.sanitize(stored, spec),
      spec,
      apiKey,
    };
  }

  /**
   * Return current default provider/model selections.
   *
   * @returns Defaults for quick chat, internal tasks, and gateway routing.
   */
  public getDefaults(): LLMProviderDefaults {
    return {
      quickChat: { ...this.defaults.quickChat },
      internalTasks: { ...this.defaults.internalTasks },
      gateway: { ...this.defaults.gateway },
    };
  }

  /**
   * Update default provider/model selections.
   *
   * @param input Partial default slots to replace.
   * @returns Updated defaults.
   */
  public updateDefaults(input: Partial<LLMProviderDefaults>): LLMProviderDefaults {
    this.defaults = {
      quickChat: this.normalizeDefault(input.quickChat ?? this.defaults.quickChat),
      internalTasks: this.normalizeDefault(input.internalTasks ?? this.defaults.internalTasks),
      gateway: this.normalizeDefault(input.gateway ?? this.defaults.gateway),
    };
    return this.getDefaults();
  }

  private requireSpec(providerId: string): LLMProviderSpec {
    const spec = findProviderSpec(providerId);

    if (!spec) {
      throw new Error(`Unknown LLM provider: ${providerId}`);
    }

    return spec;
  }

  private normalizeDefault(selection: LLMProviderDefaultSelection): LLMProviderDefaultSelection {
    if (!selection.providerId) {
      return EMPTY_DEFAULT_SELECTION;
    }

    const spec = this.requireSpec(selection.providerId);
    return {
      providerId: spec.id,
      model: selection.model ?? null,
    };
  }

  private sanitize(
    stored: StoredLLMProviderConfig,
    spec: LLMProviderSpec
  ): SanitizedLLMProviderConfig {
    const apiKeySource = this.getApiKeySource(stored, spec);

    return {
      id: stored.id,
      specId: stored.specId,
      displayName: spec.displayName,
      model: stored.model,
      baseUrl: stored.baseUrl,
      ...(spec.backend === 'codex-oauth'
        ? { codexOAuthAccountSlotId: CODEX_OAUTH_DEFAULT_ACCOUNT_SLOT_ID }
        : {}),
      hasApiKey: apiKeySource === 'stored' || apiKeySource === 'env' || apiKeySource === 'vault',
      apiKeySource,
      gatewayCapabilities: spec.gatewayCapabilities,
      extraHeaders: { ...stored.extraHeaders },
      extraBody: { ...stored.extraBody },
    };
  }

  private getApiKeySource(
    stored: StoredLLMProviderConfig,
    spec: LLMProviderSpec
  ): LLMProviderApiKeySource {
    if (!spec.requiresApiKey) {
      return 'not-required';
    }

    if (stored.apiKey) {
      return 'stored';
    }

    return this.resolveEnvKey(spec) ? 'env' : 'missing';
  }

  private resolveEnvKey(spec: LLMProviderSpec): string | null {
    if (!spec.envKey) {
      return null;
    }

    return process.env[spec.envKey] || null;
  }
}
