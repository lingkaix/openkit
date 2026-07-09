/**
 * Supported nanocore LLM provider backend implementations.
 */
export type LLMProviderBackend = 'codex-oauth' | 'pi-ai';

/**
 * Gateway support mode for one public OpenAI-compatible endpoint family.
 */
export type LLMGatewayEndpointCapability = 'native' | 'bridged' | 'unsupported';

/**
 * Gateway capability matrix exposed by one provider.
 */
export interface LLMProviderGatewayCapabilities {
  /** Provider support for `/v1/chat/completions`. */
  readonly chatCompletions: LLMGatewayEndpointCapability;
  /** Provider support for `/v1/responses`. */
  readonly responses: LLMGatewayEndpointCapability;
}

/**
 * Static app-local metadata for one LLM provider.
 */
export interface LLMProviderSpec {
  /** Stable provider identifier used by config and API payloads. */
  readonly id: string;
  /** Human-readable provider name for Settings and diagnostics. */
  readonly displayName: string;
  /** Runtime backend family used to instantiate a provider client. */
  readonly backend: LLMProviderBackend;
  /** Default base URL used when config does not override the endpoint. */
  readonly defaultBaseUrl: string | null;
  /** Environment variable name that can provide the API key. */
  readonly envKey: string | null;
  /** Lowercase model-name keywords used for provider matching. */
  readonly modelKeywords: readonly string[];
  /** Whether the provider can route many unrelated model IDs. */
  readonly isGateway: boolean;
  /** Whether the provider usually points at a local server. */
  readonly isLocal: boolean;
  /** Whether the provider authenticates through OAuth instead of API keys. */
  readonly isOAuth: boolean;
  /** Whether hosted calls require an API key or equivalent secret. */
  readonly requiresApiKey: boolean;
  /** Whether streaming is expected to work through this provider. */
  readonly supportsStreaming: boolean;
  /** Whether OpenAI-style tool calls are expected to work. */
  readonly supportsToolCalls: boolean;
  /** Whether the provider has a known reasoning/thinking option. */
  readonly supportsReasoning: boolean;
  /** Gateway support matrix for agent-facing OpenAI-compatible entry points. */
  readonly gatewayCapabilities: LLMProviderGatewayCapabilities;
  /** Whether user-supplied extra request headers are allowed. */
  readonly extraHeadersAllowed: boolean;
  /** Whether user-supplied extra request body fields are allowed. */
  readonly extraBodyAllowed: boolean;
  /** Optional provider-specific implementation notes. */
  readonly notes?: string;
}

/**
 * Static provider metadata inspired by Nanobot's registry-first provider design.
 */
export const LLM_PROVIDER_SPECS: readonly LLMProviderSpec[] = [
  {
    id: 'custom',
    displayName: 'Custom',
    backend: 'pi-ai',
    defaultBaseUrl: null,
    envKey: null,
    modelKeywords: [],
    isGateway: false,
    isLocal: false,
    isOAuth: false,
    requiresApiKey: false,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: false,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    extraHeadersAllowed: true,
    extraBodyAllowed: true,
    notes: 'Use for any OpenAI-compatible chat-completions endpoint.',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    backend: 'pi-ai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    modelKeywords: ['openai', 'gpt'],
    isGateway: false,
    isLocal: false,
    isOAuth: false,
    requiresApiKey: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: true,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
    extraHeadersAllowed: true,
    extraBodyAllowed: true,
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    backend: 'pi-ai',
    defaultBaseUrl: null,
    envKey: 'ANTHROPIC_API_KEY',
    modelKeywords: ['anthropic', 'claude'],
    isGateway: false,
    isLocal: false,
    isOAuth: false,
    requiresApiKey: true,
    supportsStreaming: true,
    supportsToolCalls: false,
    supportsReasoning: true,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    extraHeadersAllowed: false,
    extraBodyAllowed: false,
    notes: 'First non-OpenAI provider family routed through the internal pi-ai adapter.',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    backend: 'pi-ai',
    defaultBaseUrl: null,
    envKey: 'OPENROUTER_API_KEY',
    modelKeywords: ['openrouter'],
    isGateway: true,
    isLocal: false,
    isOAuth: false,
    requiresApiKey: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: true,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    extraHeadersAllowed: false,
    extraBodyAllowed: false,
    notes: 'Routed through the internal pi-ai adapter; OpenKit config remains the source of truth.',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    backend: 'pi-ai',
    defaultBaseUrl: 'https://api.deepseek.com',
    envKey: 'DEEPSEEK_API_KEY',
    modelKeywords: ['deepseek'],
    isGateway: false,
    isLocal: false,
    isOAuth: false,
    requiresApiKey: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: true,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    extraHeadersAllowed: true,
    extraBodyAllowed: true,
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot',
    backend: 'pi-ai',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    envKey: 'MOONSHOT_API_KEY',
    modelKeywords: ['moonshot', 'kimi'],
    isGateway: false,
    isLocal: false,
    isOAuth: false,
    requiresApiKey: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: true,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    extraHeadersAllowed: true,
    extraBodyAllowed: true,
  },
  {
    id: 'groq',
    displayName: 'Groq',
    backend: 'pi-ai',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    modelKeywords: ['groq'],
    isGateway: false,
    isLocal: false,
    isOAuth: false,
    requiresApiKey: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: false,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    extraHeadersAllowed: true,
    extraBodyAllowed: true,
  },
  {
    id: 'google',
    displayName: 'Gemini',
    backend: 'pi-ai',
    defaultBaseUrl: null,
    envKey: 'GOOGLE_GEMINI_API_KEY',
    modelKeywords: ['google', 'gemini', 'gemma'],
    isGateway: false,
    isLocal: false,
    isOAuth: false,
    requiresApiKey: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: false,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    extraHeadersAllowed: false,
    extraBodyAllowed: false,
    notes: 'Routed through the internal pi-ai adapter as provider id google.',
  },
  {
    id: 'dashscope',
    displayName: 'DashScope',
    backend: 'pi-ai',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKey: 'DASHSCOPE_API_KEY',
    modelKeywords: ['dashscope', 'qwen'],
    isGateway: false,
    isLocal: false,
    isOAuth: false,
    requiresApiKey: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: true,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    extraHeadersAllowed: true,
    extraBodyAllowed: true,
  },
  {
    id: 'zhipu',
    displayName: 'Zhipu',
    backend: 'pi-ai',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envKey: 'ZAI_API_KEY',
    modelKeywords: ['zhipu', 'glm', 'zai'],
    isGateway: false,
    isLocal: false,
    isOAuth: false,
    requiresApiKey: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: false,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    extraHeadersAllowed: true,
    extraBodyAllowed: true,
  },
  {
    id: 'siliconflow',
    displayName: 'SiliconFlow',
    backend: 'pi-ai',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    envKey: 'SILICONFLOW_API_KEY',
    modelKeywords: ['siliconflow'],
    isGateway: true,
    isLocal: false,
    isOAuth: false,
    requiresApiKey: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: true,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    extraHeadersAllowed: true,
    extraBodyAllowed: true,
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    backend: 'pi-ai',
    defaultBaseUrl: 'http://localhost:11434/v1',
    envKey: 'OLLAMA_API_KEY',
    modelKeywords: ['ollama'],
    isGateway: false,
    isLocal: true,
    isOAuth: false,
    requiresApiKey: false,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: false,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    extraHeadersAllowed: true,
    extraBodyAllowed: true,
  },
  {
    id: 'vllm',
    displayName: 'vLLM',
    backend: 'pi-ai',
    defaultBaseUrl: null,
    envKey: 'HOSTED_VLLM_API_KEY',
    modelKeywords: ['vllm'],
    isGateway: false,
    isLocal: true,
    isOAuth: false,
    requiresApiKey: false,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: true,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    extraHeadersAllowed: true,
    extraBodyAllowed: true,
  },
  {
    id: 'openai_codex',
    displayName: 'OpenAI Codex',
    backend: 'codex-oauth',
    defaultBaseUrl: 'https://chatgpt.com/backend-api',
    envKey: null,
    modelKeywords: ['openai-codex', 'openai_codex'],
    isGateway: false,
    isLocal: false,
    isOAuth: true,
    requiresApiKey: false,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsReasoning: true,
    gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
    extraHeadersAllowed: false,
    extraBodyAllowed: false,
    notes: 'Reserved OAuth provider for the OpenAI Codex internal API.',
  },
];

/**
 * Return a normalized provider identifier for lookups.
 *
 * @param id Provider identifier supplied by API, config, or model prefix.
 * @returns Normalized provider identifier.
 */
export function normalizeProviderId(id: string): string {
  return id.trim().toLowerCase().replaceAll('-', '_');
}

/**
 * Return a copy of the static provider registry.
 *
 * @returns Provider specs in matching priority order.
 */
export function listProviderSpecs(): LLMProviderSpec[] {
  return [...LLM_PROVIDER_SPECS];
}

/**
 * Find a provider spec by ID.
 *
 * @param id Provider identifier, accepting hyphen or underscore separators.
 * @returns Matching provider spec, or undefined when the ID is unknown.
 */
export function findProviderSpec(id: string): LLMProviderSpec | undefined {
  const normalized = normalizeProviderId(id);
  return LLM_PROVIDER_SPECS.find((provider) => provider.id === normalized);
}
