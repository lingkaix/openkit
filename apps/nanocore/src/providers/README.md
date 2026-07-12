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
- `default-provider.ts` resolves role-specific Core and gateway defaults from the configured registry.
- `data-root.ts` assembles the registry from loaded profiles and server-configured provider projections.
- `llm-config.ts` projects configured instances into the LLM dispatch shape.
- `vault-credential-resolver.ts` owns explicit credential resolution and redaction boundaries.

## Verification

Run provider registry, profile, data-root, LLM config, dispatcher, diagnostics, and Gateway tests affected by the change, then run NanoCore typecheck, lint, and build.

## Related Design

- [Capability Usage Gateway Foundation](../../../../docs/specs/20260704-capability_usage_gateway_foundation.md)
- [Vault Secret Injection](../../../../docs/specs/20260703-vault_secret_injection.md)
