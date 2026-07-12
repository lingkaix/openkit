# OpenAI-Compatible Internal Facade

Status: Superseded
Implementation: N/A
Status Changed: 2026-07-03
Current Guidance: `docs/specs/20260526-llm_gateway_responses_api.md`, `docs/specs/20260703-worker_agent_capability.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

The public LLM Gateway Responses API and Worker Agent Capability contract absorbed OpenAI-compatible request mapping, provider routing, auth boundaries, and capability mediation. The internal facade slice lost authority because the removed internal route cannot remain a parallel gateway contract.

## Retention Reason

This document preserves the original internal route, SSE forwarding, provider selection, and error-envelope behavior so maintainers can interpret historical tests and migrations without extending the retired internal surface.

## Historical Scope

This spec described the NanoCore internal OpenAI-compatible chat-completions facade at `POST /internal/v1/chat/completions`.

The facade owned route enablement, server-mode auth posture, provider selection, chat-completions request mapping, SSE forwarding, and redacted OpenAI-compatible error envelopes for that internal route.

It did not own the public agent-facing LLM Gateway, Responses API support, provider registry source-of-truth rules, vault storage, usage ledgers, worker-side capability routing, or model/provider catalog behavior.

## Current Guidance

Current agent-facing LLM behavior belongs to `docs/specs/20260526-llm_gateway_responses_api.md`.

Worker-facing capability supply belongs to `docs/specs/20260703-worker_agent_capability.md`.

Worker runtimes should use the governed `inference.local` projection or the public LLM Gateway shape, not this internal `/internal` facade as a new extension point.

Because OpenKit is in active internal development, this route should be removed, folded into the LLM Gateway, or left as a temporary legacy implementation detail when touched. It must not receive new provider, model-list, Responses, tool, metering, audit, or worker-capability behavior.

## Historical Behavior

NanoCore exposed a minimal internal OpenAI-compatible chat-completions facade at `POST /internal/v1/chat/completions`.

The route mapped incoming OpenAI-style Chat Completions requests to the shared `OpenAICompatibleChatClient`.

Local mode enabled the route by default for developer workflows.

Server mode disabled the route by default and required explicit config opt-in before route registration.

When enabled in server mode, the route used the same session auth middleware as protected `/api/*` routes.

When disabled in server mode, the route was not registered and returned `404`.

## Historical Provider Selection

If `defaultProviderId` was configured, the referenced profile had to exist and be a `direct` or `custom` provider.

If no default provider was configured, NanoCore selected the first usable `direct` or `custom` profile from the provider registry.

The selected provider required `baseUrl`.

The request model took priority over the facade default model, which took priority over the provider profile default model.

## Historical Secret Handling

Provider profiles used `secretRef` as the supported credential reference form.

The facade resolved supported `secretRef` values such as `env:<NAME>` to process environment values for upstream calls.

The facade did not return `secretRef` values or resolved secret values in normal responses.

Current and future credential mediation belongs to the Vault and Agent Capability specs, not to this facade.

## Historical Error Behavior

The route returned OpenAI-compatible error envelopes for facade configuration failures, provider failures, and request failures.

Provider credential values, URL auth components, and raw secrets were intended to remain out of error payloads and diagnostics.

## Historical Tests

The historical implementation had tests for non-streaming request mapping, SSE forwarding, missing usable provider errors, server-mode disabled defaults, and server-mode auth enforcement when explicitly enabled.

Future test coverage should focus on the LLM Gateway and worker capability projections instead of adding new `/internal` facade behavior.

## Replacement Links

- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/core/agent-capability.md`
- `docs/core/vault.md`
