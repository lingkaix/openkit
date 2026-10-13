---
id: provider-credential-subscription-reply
title: Configure one provider and receive one reply
persona: Operator setting up a model for ordinary chat
entrypoint: web
default_tool: playwright
timeout_seconds: 600
requires_real_provider: true
requires_real_codex: false
contracts: docs/specs/20260721-provider_subscription_accounts.md, docs/core/vault.md, docs/specs/20260526-llm_gateway_responses_api.md, docs/specs/20260704-chat_mode_assistant.md, docs/specs/20260703-audit_usage_evidence_records.md
---

## Intent

Persona: An operator setting up a model for ordinary chat.

Ask: Connect one model provider, store its credential, attach one subscription, and get one ordinary reply. Do not show me the credential.

## Starting World

One persistent deployment has no provider, no stored credential, and no subscription for this attempt. A real provider account is available through the existing protected store.

## Setup

The stage manager supplies the provider account through the private parameter file and never puts a credential value in the story or the ask.

## Outcome Predicates

- Channel outside-in, tier required. The actor receives one ordinary assistant reply, and the visible model identity is only the logical model. `docs/specs/20260526-llm_gateway_responses_api.md` owns that public response.
- Channel outside-in, tier required. The credential value is absent from the reply and from every surface the actor saw. `docs/core/vault.md` owns the boundary that keeps secret material out of ordinary records.
- Channel inside-out, tier required. One provider profile, one Vault reference for that credential, and one subscription account slot are retained, and the public subscription status does not contain the secret. The records are the provider profile, the Vault reference, and the subscription account slot. `docs/specs/20260721-provider_subscription_accounts.md` owns the profile and the slot. `docs/core/vault.md` owns the Vault reference.
- Channel inside-out, tier required. The reply's completed assistant-message Item is on the addressed Thread. The record is that Item. `docs/specs/20260704-chat_mode_assistant.md` owns that Item.

## Perturbations

None.

## Integrity Invariants

usage-attribution

## Evidence To Collect

The stage manager keeps the public reply, the logical-model identity it shows, the redaction check, and the public usage read that `usage-attribution` needs. The stage manager does not keep the credential value.

## Cleanup

The stage manager removes an attempt-owned provider binding only when it created that binding for the attempt. The stage manager does not print the credential.

## Failure Triage Notes

- A product failure means the reply shows a provider profile, a native model, an account slot, or the credential, or the retained binding is not one provider, one credential, and one subscription.
- An environment failure means the credential or the quota is missing after the story was selected with the provider available.
- A tool failure means the browser-control tool fails on its own.
- An inconclusive result means the reply was never witnessed.
- The likely lower layer is the subscription-lifecycle test and the gateway test named by `docs/specs/20260529-test_strategy.md`.
