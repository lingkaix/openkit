# Pi AI Provider Gateway Adoption

Status: Accepted
Implementation: Implemented

## Owns

This spec owns NanoCore's adoption of the stock published `@earendil-works/pi-ai` package as an internal provider-adapter dependency, its exact version pin and upgrade-review rule, the prohibition on pi-ai vocabulary crossing OpenKit public boundaries, the no-fork/no-patch external-boundary rule, and the reconciliation gate between pi-ai's vendored model catalog and `@openkit/models-dev-catalog`.

## Does Not Own

This spec does not own the public Gateway HTTP surface, non-Codex backend selection or routing, request, response, streaming, cache, usage, credential, or provider-error mapping, fallback behavior, durable usage records, provider authorization, or vendor snapshot packaging. Those contracts remain with `docs/specs/20260526-llm_gateway_responses_api.md`, `docs/specs/20260708-pi_ai_unified_llm_backend.md`, `docs/specs/20260704-capability_usage_gateway_foundation.md`, and `docs/specs/20260522-vendor_snapshot_packages.md`.

## Core References

- `docs/core/agent-capability.md`
- `docs/core/metering.md`
- `docs/core/vault.md`
- `docs/core/audit.md`

Related specs:

- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260708-pi_ai_unified_llm_backend.md`
- `docs/specs/20260522-vendor_snapshot_packages.md`

## Summary

NanoCore adopts `@earendil-works/pi-ai` behind a strict internal boundary so OpenKit can reuse one reviewed provider-adapter dependency without exposing that dependency as product or protocol vocabulary. The dependency is exact-pinned, and each upgrade must reconcile its vendored model catalog against the repository's canonical models.dev snapshot.

## Goals / Non-goals

### Goals

- Adopt pi-ai as an internal provider-adapter dependency.
- Consume the stock published package without a repository-owned fork or source patch.
- Keep pi-ai types and vocabulary out of OpenKit protocol, public API, product, and authored provider configuration surfaces.
- Make dependency upgrades deliberate through an exact version pin.
- Detect unreviewed model identity and pricing drift against `@openkit/models-dev-catalog`.

### Non-goals

- Do not define which providers or endpoint families route through pi-ai.
- Do not define request, response, streaming, cache, usage, credential, provider-error, or fallback behavior.
- Do not make pi-ai's model registry an authorization or product-catalog authority.

## Background

Using one provider-adapter dependency avoids a separate hand-written adapter for each provider family. Because that dependency sits on an inference boundary and ships its own model data, OpenKit treats both its API and catalog as reviewed external inputs rather than public contracts.

## Decision

- `@earendil-works/pi-ai` is an internal implementation dependency and never OpenKit protocol, public API, product, or authored configuration vocabulary.
- OpenKit consumes the stock published dependency and does not fork, vendor, or locally patch pi-ai source. A missing capability must use a bounded local guard, defer the affected provider path, or wait for an upstream fix.
- The consuming package must pin one exact pi-ai version with no `^` or `~` range.
- `@openkit/models-dev-catalog` remains canonical for model-catalog identity and provider-template traceability.
- Every pi-ai upgrade must reconcile shared model identity and pricing against the models.dev snapshot before merge.
- `docs/specs/20260708-pi_ai_unified_llm_backend.md` solely owns non-Codex provider routing and all provider mapping behavior.

## Contract / Expected Behavior

### Public vocabulary boundary

- Pi-ai type names, event names, provider identifiers, API identifiers, option names, and error strings must not appear in `packages/protocol` schemas, public App API responses, Gateway response bodies or error envelopes, product UI, or authored provider configuration.
- Pi-ai-native detail may appear only in redacted restricted diagnostics. This rule prohibits vocabulary leakage but does not own Gateway error classification or mapping.
- Replacing pi-ai must not require a change to any OpenKit protocol schema, public endpoint, product term, or authored provider configuration file.

### Exact pin and upgrade review

- The consuming `package.json` must declare one exact pi-ai version.
- The pin must resolve to the stock published package. Repository-owned forks, vendored source copies, patched package artifacts, and local source patches are outside this boundary.
- An upgrade must review the pi-ai changelog, adapter-boundary changes, and vendored model-catalog changes under the external-boundary posture of `docs/specs/20260522-vendor_snapshot_packages.md`.
- Pi-ai's vendored model data is read-only at runtime, is never live-refreshed at boot, and never defines an OpenKit protocol surface.
- Missing adapter behavior must be handled by the smallest local guard, provider-family deferral, or upstream correction; it must not create a private pi-ai distribution.

### Models.dev reconciliation

- `@openkit/models-dev-catalog` decides model identity and provider-template traceability; pi-ai's vendored catalog does not supersede it.
- Repository validation must compare provider IDs, model IDs, and pricing for entries shared by both catalogs during a pi-ai upgrade.
- Provider ID and model ID mismatches have zero tolerance. The default relative price tolerance is 5% per token class; divergence beyond that tolerance blocks the upgrade until it is explicitly acknowledged in review.
- When shared entries differ within the accepted price tolerance, product-facing catalog data follows `@openkit/models-dev-catalog`.

## Current Implementation Projection

NanoCore declares the stock `@earendil-works/pi-ai` package at the exact version `0.80.3`. `packages/models-dev-catalog/scripts/validate.mjs` verifies the declared pi-ai version and performs the accepted catalog reconciliation, and root `check:repo` runs that validator. Provider routing and mapping implementation evidence belongs only to `docs/specs/20260708-pi_ai_unified_llm_backend.md`.

## Testing Strategy / Acceptance Criteria

- L0 verifies the exact dependency pin and runs the pi-ai/models.dev reconciliation validator.
- L2 boundary checks assert that pi-ai vocabulary does not enter protocol, public API, Gateway, product, or authored configuration surfaces.
- A pi-ai version change with an unacknowledged model identity mismatch or price divergence beyond tolerance fails repository verification.

Acceptance requires all three conditions: one exact pi-ai dependency version, no pi-ai public-vocabulary leakage, and a passing models.dev reconciliation gate.

## Risks & Mitigations

- Pi-ai API drift could cross the internal boundary; exact pinning and deliberate upgrade review constrain it.
- Missing upstream behavior could tempt a private fork; bounded local guards, provider deferral, or an upstream fix preserve the stock-package boundary.
- Catalog drift could silently change model identity or pricing; repository reconciliation blocks unreviewed divergence.
- Pi-ai vocabulary could become accidental product language; boundary conformance checks reject that leak.

## Links

- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260708-pi_ai_unified_llm_backend.md`
- `docs/specs/20260522-vendor_snapshot_packages.md`
- `packages/models-dev-catalog/README.md`
- pi-ai upstream: `https://github.com/earendil-works/pi/tree/main/packages/ai`
