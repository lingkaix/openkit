---
status: Accepted
implementation: Partial
---
# Pi AI Provider Gateway Adoption

## Owns

This spec owns NanoCore's adoption of the stock published `@earendil-works/pi-ai` package as the single internal LLM provider-adapter dependency, its exact version pin and upgrade-review rule, the prohibition on pi-ai vocabulary crossing OpenKit public boundaries, the no-fork/no-patch external-boundary rule, review of the provider-owned authentication and credential-store surface required by OpenKit, and reconciliation between pi-ai's vendored model catalog and `@openkit/models-dev-catalog`.

## Does Not Own

This spec does not own the public Gateway HTTP surface; provider routing or request, response, streaming, cache, usage, credential-input, and error mapping; subscription account slots, login lifecycle, quota, or Vault persistence; fallback behavior; durable usage records; provider authorization; or vendor snapshot packaging. Those contracts remain with `docs/specs/20260526-llm_gateway_responses_api.md`, `docs/specs/20260708-pi_ai_unified_llm_backend.md`, `docs/specs/20260721-provider_subscription_accounts.md`, `docs/specs/20260704-capability_usage_gateway_foundation.md`, and `docs/specs/20260522-vendor_snapshot_packages.md`.

## Core References

- `docs/core/agent-capability.md`
- `docs/core/metering.md`
- `docs/core/vault.md`
- `docs/core/audit.md`

Related specs:


## Related Docs

- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260708-pi_ai_unified_llm_backend.md`
- `docs/specs/20260721-provider_subscription_accounts.md`
- `docs/specs/20260522-vendor_snapshot_packages.md`

## Summary

NanoCore consumes one exact-pinned stock pi-ai release behind a strict internal boundary. OpenKit reuses pi-ai's provider adapters, native Responses support, provider-owned interactive login, automatic refresh, and custom `CredentialStore` integration without exposing the dependency as product, protocol, App API, Gateway, or authored configuration vocabulary.

The historical pre-unification upgrade baseline was `0.80.3`, the subscription-unification baseline was `0.80.10`, and the current accepted and implemented repository pin is `0.84.2`. The current pin retains the unified provider-authentication surface, custom credential storage, xAI device-code subscription login, and native Responses behavior while adding stock semantic carriage for Responses namespaces and custom tool calls. The implementation selects and records an exact release after package API, release notes, model-catalog, and focused behavior review; this spec does not use a floating `latest` target.

## Goals / Non-goals

### Goals

- Use pi-ai as the one stock provider-adapter and provider-authentication dependency.
- Consume provider-owned login and refresh through a custom OpenKit credential store rather than duplicating OAuth implementations.
- Keep pi-ai types, identifiers, events, options, errors, and auth vocabulary out of OpenKit public surfaces.
- Make every dependency upgrade deliberate through one exact version pin and recorded review.
- Detect unreviewed model identity and pricing drift against `@openkit/models-dev-catalog`.
- Preserve a replaceable internal boundary without a fork, patch, or vendored source copy.

### Non-goals

- Do not define which provider profile routes to which model API.
- Do not define OpenKit account-slot, login-status, quota, Vault, request, response, cache, usage, error, or fallback behavior.
- Do not let pi-ai's model registry, ambient credential resolution, auth file, or provider discovery become OpenKit authorization or durable authority.
- Do not expose pi-ai's default filesystem credential store or `auth.json` as an OpenKit storage contract.

## Decision

- `@earendil-works/pi-ai` is a private implementation dependency and never OpenKit protocol, public API, product, or authored-configuration vocabulary.
- OpenKit consumes a stock published release and does not fork, vendor, patch, or monkey-patch pi-ai source. A missing capability uses the smallest bounded local guard, defers the provider path, waits for upstream, or triggers a new design decision.
- The consuming package declares one exact version with no `^`, `~`, workspace override, patch artifact, or alternate source.
- The selected release must expose provider-owned login discovery, a custom `CredentialStore` integration, automatic OAuth refresh, native Codex Responses, and xAI subscription login and inference sufficient for the accepted account and backend specs.
- OpenKit injects its credential-store view and explicit provider settings. It must not let pi-ai read its default `auth.json`, execute credential commands, or fall through to ambient environment credentials for a configured OpenKit provider.
- `@openkit/models-dev-catalog` remains canonical for model identity and provider-template traceability. Pi-ai catalog data is reviewed input, never product authority.
- Every pi-ai upgrade reconciles the overlapping catalog and re-runs focused authentication, native Responses, streaming, usage, cache, turn-state, and redaction tests before merge.

## Public Vocabulary Boundary

- Pi-ai type names, event names, provider identifiers, API identifiers, option names, login callback shapes, credential shapes, and error strings must not appear in `packages/protocol`, public App API schemas, Gateway responses or errors, authored provider profiles, product UI, bundled CLI output, or the unified Skill contract.
- OpenKit schemas use provider-neutral terms such as provider profile, subscription provider, account slot, login interaction, status, quota, endpoint capability, and cache scope.
- Pi-ai-native detail may appear only in redacted restricted diagnostics or implementation tests. This permits debugging but does not transfer contract ownership.
- Replacing pi-ai must not require a change to an OpenKit public endpoint, schema, product term, or authored configuration file.

## Exact Pin And Upgrade Review

An upgrade is accepted only when one review record captures:

1. the exact package version and package integrity resolved from the stock registry
2. relevant release notes and breaking changes
3. provider-authentication surface changes, including `Models`, provider login discovery, `CredentialStore`, refresh, logout, and cancellation behavior
4. native Responses, streaming, response metadata hooks, request headers, usage, cancellation, and error behavior used by the unified adapter
5. xAI subscription login and Grok model support
6. OpenAI Codex login, refresh, native Responses, session or turn-state, and provider-private request behavior
7. the models.dev reconciliation result
8. a deliberate confirmation that no public pi-ai vocabulary or ambient credential path was introduced

The implementation plan started from the historical pre-unification `0.80.3` pin, selected `0.80.10` for unified auth and xAI, and then selected `0.84.2` for stock Responses namespace and custom-tool semantics. It must not pre-commit to a stale version number in a long-lived design document, but the implementation commit and completed change record must name the exact accepted pin.

Pi-ai vendored model data remains read-only at runtime, is never live-refreshed at NanoCore boot, and does not define OpenKit model authority. Any pi-ai dynamic-catalog feature is disabled or bounded behind OpenKit's explicit profile and catalog contract unless a later accepted design changes that owner.

## Authentication Integration Review

The reviewed pi-ai release must allow NanoCore to construct an isolated model/auth runtime with an injected custom credential store. OpenKit must not instantiate pi-ai's default file-backed auth owner and then copy, symlink, or swap its auth file.

The custom store contract must support provider-scoped read, write, removal, and serialized modification so pi-ai can complete initial login and automatic refresh without owning durable storage. OpenKit's slot-scoped view narrows that provider operation to one `(subscriptionProviderId, accountSlotId)` pair and persists material through Vault as specified by `docs/specs/20260721-provider_subscription_accounts.md`.

Provider login must be invoked through the reviewed programmatic provider-auth surface rather than by scripting the interactive pi CLI. Safe callback data may be projected into OpenKit login interactions; raw credentials and upstream errors stay internal. If the stock programmatic API cannot support one accepted provider flow, that provider remains unavailable until upstream or a new accepted boundary resolves the gap.

Pi-ai's documented support for a consumer subscription is evidence that the adapter exists, not authority for OpenKit to advertise unlimited or plan-included usage. Provider-effect authorization follows `docs/specs/20260721-provider_subscription_accounts.md`.

## Models.dev Reconciliation

- `@openkit/models-dev-catalog` decides model identity and provider-template traceability; pi-ai's vendored or refreshed catalog never supersedes it.
- Repository validation compares provider ids, model ids, and pricing for entries shared by both catalogs during a pi-ai upgrade.
- Provider-id and model-id mismatches have zero tolerance. The default relative price tolerance is 5% per token class; divergence beyond that tolerance blocks the upgrade until review records the exact provider, model, token class, models.dev price, and pi-ai price as one release-bound accepted difference. Repository validation still compares every shared entry and rejects any missing, stale, duplicate, or unobserved acknowledgement.
- When shared entries differ within the accepted price tolerance, product-facing catalog data follows `@openkit/models-dev-catalog`.
- New pi-ai provider or model entries do not become enabled merely because reconciliation can see them; authored OpenKit profiles remain the authority.

## Current Implementation Projection

NanoCore declares stock `@earendil-works/pi-ai` at exact version `0.84.2`, resolved from the registry with integrity `sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig==` and upstream `gitHead` `914cf1472e715297caa30db4b9535d534a9eb718`. `packages/models-dev-catalog/scripts/validate.mjs` verifies the exact declaration and performs catalog reconciliation, and root `check:repo` runs that validator. The package is private to NanoCore and current public surfaces use OpenKit vocabulary.

NanoCore now constructs one stock provider-only `Models` runtime with an injected Vault-backed `CredentialStore` per subscription pair. Provider-owned device-code login, cancellation signalling, refresh, logout, native Codex Responses, xAI inference, response metadata, streaming, usage, cache inputs, cancellation, and error interception are wired behind OpenKit-owned schemas and redaction. Default pi-ai auth files, ambient provider credentials, shell credential commands, patches, forks, and public pi-ai vocabulary remain absent.

The former Codex account and Responses implementations and their residual source have been physically removed. This spec remains `Partial` until the owner-governed Codex real-use runs establish the accepted pi-ai integration evidence.

## Accepted Design

NanoCore has one small pi-ai boundary module that constructs provider runtimes with explicit OpenKit configuration and credential inputs, then maps pi-ai events and errors into OpenKit-owned internal shapes. Account management supplies a slot-scoped custom credential store; inference supplies the selected model and bounded options. The integration imports only stock public pi-ai APIs and contains no copied provider logic.

## Testing Strategy / Acceptance Criteria

- L0 verifies one exact stock dependency pin, package integrity, no patch or alternate source, catalog reconciliation, and absence of pi-ai vocabulary from public packages and generated artifacts.
- L1 uses a conformance credential store to prove provider-scoped read, write, remove, modify, refresh persistence, cancellation, and failure redaction without filesystem or ambient fallback.
- L1 adapter tests cover native Codex Responses, xAI Responses or declared endpoint behavior, response metadata hooks, request headers, streaming, usage, cancellation, and errors for the exact pin.
- L2 public-boundary tests prove no pi-ai identifier, option, credential, or error leaks through App API, Gateway, Core Client, CLI, Skill, or Web projections.
- L3 opt-in real-provider evidence proves the exact pinned stock pi-ai boundary, injected-store use, provider-owned refresh when safely exercisable, and absence of ambient or default auth-file fallback.

Acceptance requires one exact stock pin, a documented upgrade review, passing catalog reconciliation, working injected credential storage and provider-owned refresh, completed real-use acceptance for the Codex subscription path, no ambient or default auth-file dependency, no private patch, and no public pi-ai vocabulary.

## Risks & Mitigations

- Pi-ai API drift could cross the internal boundary; exact pinning, one boundary module, and focused conformance tests constrain it.
- A default credential-resolution fallback could bypass Vault; injected-store tests and ambient-free process tests fail that path closed.
- Missing upstream behavior could tempt a private fork; provider deferral or an upstream fix preserves the stock-package boundary.
- Catalog drift could silently change model identity or pricing; repository reconciliation blocks unreviewed divergence.
- Upstream subscription documentation could be mistaken for an OpenKit entitlement guarantee; real-provider acceptance remains per provider and quota behavior stays independently specified.

## Rollout / Migration Plan

Remaining rollout is owned by this specification together with `docs/specs/20260708-pi_ai_unified_llm_backend.md` and `docs/specs/20260721-provider_subscription_accounts.md`. The first implementation gate selects the exact reviewed pi-ai release and lands its catalog and boundary tests before account, Gateway, or deletion work depends on the new API.

## Links

- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260708-pi_ai_unified_llm_backend.md`
- `docs/specs/20260721-provider_subscription_accounts.md`
- `docs/specs/20260522-vendor_snapshot_packages.md`

- pi-ai upstream: `https://github.com/earendil-works/pi/tree/main/packages/ai`
- pi provider documentation: `https://pi.dev/docs/latest/providers`
- pi unified-auth and xAI release: `https://pi.dev/news/releases/0.80.8`
