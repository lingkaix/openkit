---
id: review-diagnostics-and-health
title: Review health and diagnostics
persona: Operator checking whether the deployment is fit to use
entrypoint: skill
default_tool: openkit
timeout_seconds: 600
requires_real_provider: false
requires_real_codex: false
contracts: docs/specs/20260704-nanocore_bootstrap_readiness.md, docs/specs/20260802-nanohost_runtime_and_transport.md, docs/specs/20260708-container_image_packaging.md, docs/core/vault.md, docs/specs/20260628-web_product_surface_projection.md
---

## Intent

Persona: An operator checking a running deployment.

Ask: Show me whether this deployment is healthy, show me the diagnostics, and do not reveal a raw secret.

## Starting World

One persistent deployment is running. One NanoHost runtime target is configured. The operator can read health, diagnostics, and that runtime target.

## Outcome Predicates

- Channel outside-in, tier required. The public health response and the Web entry show that the deployment is serving. `docs/specs/20260708-container_image_packaging.md` names the health observation. `docs/specs/20260628-web_product_surface_projection.md` owns the Web entry.
- Channel inside-out, tier required. The authenticated diagnostics boot projection shows readiness with an empty blocking set, and the diagnostics text contains no raw secret. The record is the diagnostics boot projection. `docs/specs/20260704-nanocore_bootstrap_readiness.md` owns that projection. `docs/core/vault.md` owns the secret boundary.
- Channel inside-out, tier required. The runtime-target read shows the configured target ready. The record is the runtime-target observation. `docs/specs/20260802-nanohost_runtime_and_transport.md` owns that observation.

## Perturbations

None.

## Integrity Invariants

None.

## Evidence To Collect

The stage manager keeps the public health response, the Web entry, the authenticated diagnostics read, and the runtime-target read.

## Cleanup

The stage manager does not change the deployment in order to make the review pass.

## Failure Triage Notes

- A product failure means diagnostics are not ready, the runtime target is not ready, or diagnostics contain a raw secret.
- An environment failure means the deployment cannot be read before a product result exists.
- A tool failure means the administrator client fails on its own.
- An inconclusive result means a required read was never witnessed.
- The likely lower layer is the readiness tests in `docs/specs/20260704-nanocore_bootstrap_readiness.md`.
