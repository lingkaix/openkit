# LLM

This directory owns LLM Gateway behavior, provider dispatch, upstream clients and adapters, provider-subscription accounts, public OpenAI-compatible projection, and usage observation.

## Boundaries

- Keep Gateway routes, dispatch, native and bridged request handling, upstream error normalization, provider-subscription account state, and prompt-cache behavior here.
- Publish logical model IDs only. Private Provider profile and native model route members remain Gateway-owned, and a logical model stays available while at least one configured route member is dispatchable.
- Preserve ordered pre-output route fallback today while leaving load balancing, quota rollover, and same-family account switching to accepted Gateway extensions.
- `../providers/` is the single owner of configured provider instances, profiles, credential references, and readiness projection.
- `../capability/` owns durable capability-call and usage ledger operations; LLM code records observations through that owner.
- Consume resolved credentials without serializing secret-bearing configuration or creating a second provider vocabulary.
- Provider-native payloads remain private while public responses preserve the documented OpenAI-compatible contract and redaction rules.
- Carry request cancellation through the dispatcher, upstream clients, stream converters, usage observers, route responses, and durable capability-call termination without allowing a late disconnect to rewrite an independent provider failure.
- Preserve `x-codex-turn-state` only through the pi-ai native Responses transport and the internal worker response boundary. Ordinary pi-ai providers never receive or publish this Codex-private state.
- Internal worker inference accepts only its distinct inference-family live token plus the narrow transport contract; the authenticated AEP still owns provider/model selection and durable lineage, privileged request fields remain server-owned, and worker-control or sandbox-binding values cannot authenticate inference.
- `worker-inference-runtime-hint.ts` validates the pinned Codex 0.153.4 canonical turn metadata, cross-checks its request-body and header projections, normalizes sub-agent kind, and strips native ids and cache lineage instead of forwarding or persisting them.
- `provider-subscription-accounts.ts` owns the internal strict account metadata, exact Core and encrypted-Vault classification, pair-scoped credential store and stock pi-ai runtime, mutation fence, reconciliation, and redacted lifecycle audit boundary for `openai-codex` and `xai`.
- `codex-quota.ts` implements the current strict direct Codex quota reader; [Provider Subscription Accounts](../../../../docs/specs/20260721-provider_subscription_accounts.md) owns its behavior.
- `provider-subscription-routes.ts` exposes the deployment-admin App API for both supported provider families, and every production Gateway path dispatches through `PiAiGatewayClient`.

## Verification

Run the focused Gateway, dispatcher, upstream client, provider-subscription, usage, converter, and prompt-cache tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).
