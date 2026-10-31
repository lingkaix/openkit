import {
  PiAiGatewayClient,
  type PiAiGatewayClientOptions,
  PiAiGatewayConfigurationError,
} from '../llm/pi-ai-client.js';

let defaultReasoningSummaryClient: PiAiGatewayClient | undefined;

function reasoningSummaryClient(): PiAiGatewayClient {
  if (!defaultReasoningSummaryClient) {
    defaultReasoningSummaryClient = new PiAiGatewayClient();
  }
  return defaultReasoningSummaryClient;
}

/**
 * Completes a partial PiAiGatewayClient test double with the real G3 reasoning-summary helper.
 *
 * The helper runs on a client that owns the per-call model collection, matching production
 * where the dispatcher client and `resolveModel` share one `this.models` reference.
 */
export function asPiAiGatewayClientDouble(partial: Record<string, unknown>): PiAiGatewayClient {
  const withOpenKitResponsesReasoningSummary: PiAiGatewayClient['withOpenKitResponsesReasoningSummary'] =
    (provider, request, openkitOriginated, models) => {
      const modelCollection = models as NonNullable<PiAiGatewayClientOptions['models']> | undefined;
      const owned = modelCollection
        ? new PiAiGatewayClient({ models: modelCollection })
        : reasoningSummaryClient();
      try {
        return owned.withOpenKitResponsesReasoningSummary(
          provider,
          request,
          openkitOriginated,
          models
        );
      } catch (error) {
        // Fixture providers often have no catalog row and no base URL. The real helper
        // throws before a stubbed createResponses. Leaving the request unchanged keeps
        // that stub's oracle; a resolvable model still receives the G3 summary default.
        if (error instanceof PiAiGatewayConfigurationError) return request;
        throw error;
      }
    };
  return {
    ...partial,
    withOpenKitResponsesReasoningSummary,
  } as PiAiGatewayClient;
}
