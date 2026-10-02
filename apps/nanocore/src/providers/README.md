# Providers

This directory owns configured provider instances, provider profiles, credential references, capability projection, readiness, and the data-root provider configuration surface.

## Boundaries

- The runtime provider registry is the single configured-instance owner; do not add a second static provider registry or parallel provider vocabulary.
- `../llm/` owns request dispatch, adapter behavior, provider-native payloads, usage observation, and public Gateway behavior.
- `vault-credential-resolver.ts` resolves explicit credential references through the Vault boundary; provider code must not inspect unrelated ambient credential keys.
- Configured instance identity, endpoint, model catalog, and credential scope must survive projection into dispatch without falling back to a colliding adapter id.
- Provider secrets must remain referenced by `secretRef` or backend-private material and must never be serialized into workspace resources, diagnostics, events, or generated config.

## File Map

- `registry.ts` owns configured provider instance lookup, readiness, and capability projection.
- `../config/providers-loader.ts` validates and loads provider profiles using the canonical `@openkit/config-schema` profile schema.
- `data-root.ts` assembles the registry from the canonical file-backed Provider profiles.
- `llm-config.ts` projects configured instances into the LLM dispatch shape.
- `vault-credential-resolver.ts` owns explicit credential resolution, live configured-key presence and redaction boundaries. Its presence predicate uses the same injected/env fallback as dispatch, then active Core Vault reference metadata; it performs no Vault material resolution or audited use and adds no readiness state.

## Verification

Run provider registry, profile, data-root, LLM config, dispatcher, diagnostics, and Gateway tests affected by the change, then run NanoCore typecheck, lint, and build.

## Related Design

- [Capability Usage Gateway Foundation](../../../../docs/specs/20260704-capability_usage_gateway_foundation.md)
- [Vault Secret Injection](../../../../docs/specs/20260703-vault_secret_injection.md)

`data-root.ts` captures the model extension catalog together with loaded Provider profiles. The registry contains projected extension-plus-profile metadata for listed models only; the loader never persists that projection into authored profiles.

`revokeVaultProviderCredential` removes the exact server-scoped Provider API key through existing backend revocation and Core dependent-state revocation. It validates both authorities before effects, rejects subscription-owned material and unsupported external references, and returns redacted failures without restoring material after a partial effect. Runtime-config profile deletion supplies deployment-admin and file-revision authority before invoking it.
