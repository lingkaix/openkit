---
id: story-pi-ai-gateway-real-provider
title: Validate pi-ai gateway routing with a real provider
persona: Release owner validating provider gateway readiness before v1
entrypoint: api
default_tool: shell
timeout_seconds: 900
requires_real_provider: true
requires_real_codex: false
contracts: docs/specs/20260703-pi_ai_provider_gateway_adoption.md, docs/specs/20260704-capability_usage_gateway_foundation.md
---

# Validate Pi-AI Gateway Routing With A Real Provider

## Purpose

Verify that NanoCore can route real non-streaming and streaming OpenAI-compatible public gateway requests through one configured non-custom pi-ai-backed provider, return product-safe assistant text, record each request and any provider-reported cache usage, and avoid leaking provider credentials or pi-ai-native vocabulary.

## Preconditions

- NanoCore can boot with a disposable data root.
- The operator explicitly opts in to real provider quota for this story run.
- At least one non-custom pi-ai-backed provider is configured for the story environment, selected as the default gateway provider, and lists the requested model with Chat Completions support.
- The selected provider has a valid real credential supplied through NanoCore provider configuration, an environment-backed secret reference, or a vault-backed secret reference.
- The story may target a local NanoCore stack, a staging NanoCore stack, or the a1 NanoCore server when the operator has deployed the current commit there.

## Required Opt-in Environment Variables

- `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1` confirms the operator accepts real provider usage.
- `OPENKIT_L6_GATEWAY_BASE_URL` points to the NanoCore base URL under test.
- `OPENKIT_L6_GATEWAY_PROVIDER_ID` names the configured provider under test.
- `OPENKIT_L6_GATEWAY_MODEL` names a model exposed by that provider.
- `OPENKIT_L6_GATEWAY_WORKSPACE_ID` names the disposable workspace used for attribution and evidence.
- `OPENKIT_L6_EVIDENCE_DIR` points to a writable evidence directory for redacted request, response, usage, audit, and health snapshots.

## Setup

- Deploy or start NanoCore from the commit under test.
- Configure the selected provider and model as the default gateway provider selection.
- Create or select a disposable workspace for usage attribution.
- Confirm the provider credential is resolvable without printing it.
- Confirm `/health` returns HTTP 200 and capture the provider registry summary with secrets redacted.
- Confirm diagnostics identifies the requested provider and model as the configured gateway default and matches them to one non-custom registry row whose public dispatch family is `provider-api`, lists the model, and does not mark Chat Completions unsupported.

## User-visible Steps

1. Send a workspace-attributed non-streaming `POST /v1/chat/completions` request through NanoCore with a short prompt and a fresh request id.
2. Confirm the HTTP response is OpenAI-compatible and contains non-empty assistant text after trimming.
3. Send a workspace-attributed streaming `POST /v1/chat/completions` request with the same provider and model but a different fresh request id.
4. Confirm the SSE stream emits text deltas and a terminal `[DONE]` marker.
5. Query the workspace capability-usage surface and confirm one successful `llm.chat_completions` CapabilityCall for each request id.
6. Summarize provider-reported `cache_read` and `cache_write` token quantities when present without requiring either metric or a cache hit.
7. Capture the existing redacted result and leak-scan evidence for health, provider readiness, both gateway requests, CapabilityCalls, and cache usage.

## Expected Outcomes

- The selected provider routes through NanoCore's internal pi-ai backend without requiring callers to know pi-ai exists.
- NanoCore accepts provider calls only after `/health` returns HTTP 200 and diagnostics matches the requested default provider and model to one eligible non-custom registry row whose public dispatch family is `provider-api`; S42 maps that non-Codex family to the internal pi-ai backend.
- The non-streaming response uses the public Chat Completions shape, contains non-empty assistant text after trimming, and contains no pi-ai-native provider names, api names, event names, stack traces, or internal option names.
- The streaming response uses the public Chat Completions SSE shape and terminates cleanly.
- The non-streaming and streaming requests use distinct request ids and each creates a successful `llm.chat_completions` CapabilityCall.
- Provider-reported `cache_read` and `cache_write` quantities are summarized as numeric token totals when present and as `unreported` when absent; neither a report nor a cache hit is required.
- Provider credentials, bearer tokens, cookies, and raw secret references are not present in response bodies, logs, evidence snapshots, or committed artifacts.
- If the provider rejects the request, the public error uses a stable gateway error code and redacts provider text.

## Deterministic Assertions

- `/health` returns HTTP 200 before diagnostics or provider calls begin.
- Diagnostics identifies the requested provider and model as the configured gateway default; the matching registry row has `dispatchFamily == provider-api`, `kind != custom`, lists the model, and has `gatewayCapabilities.chatCompletions != unsupported`.
- The non-streaming gateway call returns HTTP 200 with a `choices[0].message.content` string whose trimmed value is non-empty.
- The streaming gateway call returns HTTP 200 and includes `data: [DONE]`.
- The two gateway request ids are distinct, and the capability-usage response contains one successful `llm.chat_completions` CapabilityCall for each id.
- Matching `llm-gateway-adapter-reported:cache_read` and `llm-gateway-adapter-reported:cache_write` rows are summed separately into numeric token totals; a missing source is summarized as `unreported` and does not fail the story.
- No evidence file contains `apiKey`, `access_token`, `refresh_token`, `authorization`, `cookie`, or the configured fake secret marker if one was used for redaction checks.
- No public response body contains `pi-ai`, `anthropic-messages`, `openai-completions`, or provider credential material.

## Evidence To Collect

- Checkpoint snapshots after each of: NanoCore HTTP 200 health and eligible default-provider confirmation, the successful non-streaming request, the distinct-id streaming `[DONE]` marker, both successful CapabilityCalls, optional cache totals, and the existing credential-shape scan of the evidence directory.
- Story metadata and final assertion summary.
- NanoCore commit SHA, deployment target, provider id, model id, and health response.
- Redacted request and response bodies for non-streaming and streaming calls.
- Redacted capability-call and usage evidence snapshots for the attributed workspace.
- Redacted server logs for gateway routing, provider errors, and health checks.
- Final credential-leak scan summary for every evidence file.

## Cleanup

- Stop any local NanoCore process started for the story.
- Remove disposable data roots when the run is local.
- Preserve the evidence directory only after redaction checks pass.
- Do not commit real provider responses, account identifiers, raw request headers, raw authorization headers, cookies, or unredacted server logs.

## Failure Triage Notes

If the story fails because provider credentials or quota are unavailable, classify the result as an environment failure.

If the story fails because NanoCore returns a wrong public shape, leaks pi-ai vocabulary, loses usage attribution, or exposes credential-shaped material, classify it as a release-blocking product defect and reduce it into the lowest practical L1-L5 regression.

If the real provider returns a stable provider-side error, classify it by gateway error code and preserve only redacted evidence.
