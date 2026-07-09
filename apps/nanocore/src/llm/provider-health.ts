import { PiAiGatewayClient } from './pi-ai-client.js';
import type { LLMProviderConfigStore } from './provider-config.js';

/**
 * LLM provider health status.
 */
export type LLMProviderHealthStatus =
  | 'healthy'
  | 'unhealthy'
  | 'not_configured'
  | 'missing_api_key'
  | 'oauth_required';

/**
 * Sanitized health check result for one provider.
 */
export interface LLMProviderHealth {
  /** Provider ID requested by diagnostics. */
  readonly providerId: string;
  /** Sanitized provider health status. */
  readonly status: LLMProviderHealthStatus;
  /** Human-readable non-secret status message. */
  readonly message: string;
  /** ISO timestamp when the check completed. */
  readonly checkedAt: string;
  /** Number of models returned by the provider, when available. */
  readonly modelCount?: number;
}

/**
 * Construction options for LLM provider health checks.
 */
export interface LLMProviderHealthCheckerOptions {
  /** Provider config store used to resolve non-secret and secret-bearing config. */
  readonly configStore: LLMProviderConfigStore;
  /** Pi AI client used for provider model checks. */
  readonly client?: Pick<PiAiGatewayClient, 'listModels'>;
}

/**
 * Runs sanitized health checks for configured LLM providers.
 */
export class LLMProviderHealthChecker {
  private readonly configStore: LLMProviderConfigStore;
  private readonly client: Pick<PiAiGatewayClient, 'listModels'>;

  /**
   * Create a provider health checker.
   *
   * @param options Health checker dependencies.
   */
  public constructor(options: LLMProviderHealthCheckerOptions) {
    this.configStore = options.configStore;
    this.client = options.client ?? new PiAiGatewayClient();
  }

  /**
   * Check one provider without exposing API keys or OAuth tokens.
   *
   * @param providerId Provider ID to check.
   * @returns Sanitized provider health result.
   */
  public async checkProvider(providerId: string): Promise<LLMProviderHealth> {
    const checkedAt = new Date().toISOString();

    try {
      const provider = this.configStore.resolveProvider(providerId);

      if (provider.spec.isOAuth) {
        return {
          providerId: provider.id,
          status: 'oauth_required',
          message: `${provider.displayName} requires OAuth login before health checks can run.`,
          checkedAt,
        };
      }

      if (provider.spec.requiresApiKey && !provider.apiKey) {
        return {
          providerId: provider.id,
          status: 'missing_api_key',
          message: `${provider.displayName} requires an API key.`,
          checkedAt,
        };
      }

      const models = await this.client.listModels(provider);
      const modelCount = models.data.length;

      return {
        providerId: provider.id,
        status: 'healthy',
        message: `Provider returned ${modelCount} ${modelCount === 1 ? 'model' : 'models'}.`,
        checkedAt,
        modelCount,
      };
    } catch (error) {
      if ((error as Error).message.startsWith('LLM provider is not configured:')) {
        return {
          providerId,
          status: 'not_configured',
          message: `LLM provider is not configured: ${providerId}`,
          checkedAt,
        };
      }

      return {
        providerId,
        status: 'unhealthy',
        message: this.redactSecrets((error as Error).message),
        checkedAt,
      };
    }
  }

  private redactSecrets(message: string): string {
    return message.replace(/\bsk-[A-Za-z0-9._-]+/g, '[redacted]');
  }
}
