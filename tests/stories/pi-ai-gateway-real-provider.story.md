---
id: story-pi-ai-gateway-real-provider
title: Validate pi-ai gateway routing with a real provider
persona: Release owner validating provider gateway readiness before v1
entrypoint: api
default_tool: shell
timeout_seconds: 900
requires_real_provider: true
requires_real_codex: false
---

# Validate Pi-AI Gateway Routing With A Real Provider

## Purpose

Verify that NanoCore can route a real OpenAI-compatible public gateway request through the internal pi-ai backend, return product-safe OpenAI-compatible output, record durable usage when workspace attribution is present, and avoid leaking provider credentials or pi-ai-native vocabulary.

## Preconditions

- NanoCore can boot with a disposable data root.
- The operator explicitly opts in to real provider quota for this story run.
- At least one pi-ai-backed provider is configured for the story environment: `anthropic`, `google`, or `openrouter`.
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
- Configure the selected provider as the default gateway provider or pass it explicitly in the public gateway request when the deployment supports provider selection.
- Create or select a disposable workspace for usage attribution.
- Confirm the provider credential is resolvable without printing it.
- Capture the initial `/health` response and provider registry summary with secrets redacted.

## User-visible Steps

1. Send a non-streaming `POST /v1/chat/completions` request through NanoCore with a short prompt that asks for a one-sentence response.
2. Include OpenKit workspace attribution metadata for the disposable workspace.
3. Confirm the HTTP response is OpenAI-compatible and contains assistant text.
4. Send a streaming `POST /v1/chat/completions` request with the same provider and model.
5. Confirm the SSE stream emits text deltas and a terminal `[DONE]` marker.
6. Query the available product evidence surface for the workspace, such as capability-call, usage, audit, or diagnostics read models.
7. Capture redacted evidence snapshots for the successful request, streaming request, usage rows, and gateway health.

## Checkpoints

- Capture a checkpoint after NanoCore health and provider readiness are confirmed.
- Capture a checkpoint after the non-streaming gateway request succeeds.
- Capture a checkpoint after the streaming gateway request reaches `[DONE]`.
- Capture a checkpoint after durable usage and capability-call evidence are collected.
- Capture a checkpoint after the evidence directory is scanned for credential-shaped values.

## Expected Outcomes

- The selected provider routes through NanoCore's internal pi-ai backend without requiring callers to know pi-ai exists.
- The non-streaming response uses the public Chat Completions shape and contains no pi-ai-native provider names, api names, event names, stack traces, or internal option names.
- The streaming response uses the public Chat Completions SSE shape and terminates cleanly.
- Workspace-attributed requests create successful `llm.chat_completions` capability-call evidence and linked usage rows.
- Provider credentials, bearer tokens, cookies, and raw secret references are not present in response bodies, logs, evidence snapshots, or committed artifacts.
- If the provider rejects the request, the public error uses a stable gateway error code and redacts provider text.

## Deterministic Assertions

- `/health` returns a successful response before provider calls begin.
- The non-streaming gateway call returns HTTP 200 with a `choices[0].message.content` string.
- The streaming gateway call returns HTTP 200 and includes `data: [DONE]`.
- The evidence snapshot contains at least one successful `llm.chat_completions` capability call for the attributed workspace.
- The evidence snapshot contains at least one linked usage row for the attributed workspace when the provider reports usage.
- No evidence file contains `apiKey`, `access_token`, `refresh_token`, `authorization`, `cookie`, or the configured fake secret marker if one was used for redaction checks.
- No public response body contains `pi-ai`, `anthropic-messages`, `openai-completions`, or provider credential material.

## Evidence To Collect

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
