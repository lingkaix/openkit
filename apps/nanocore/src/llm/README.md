# LLM

This directory owns LLM Gateway behavior, provider dispatch, upstream clients and adapters, Codex OAuth accounts, public OpenAI-compatible projection, and usage observation.

## Boundaries

- Keep Gateway routes, dispatch, native and bridged request handling, upstream error normalization, OAuth account state, and prompt-cache behavior here.
- `../providers/` is the single owner of configured provider instances, profiles, credential references, and readiness projection.
- `../capability/` owns durable capability-call and usage ledger operations; LLM code records observations through that owner.
- Consume resolved credentials without serializing secret-bearing configuration or creating a second provider vocabulary.
- Provider-native payloads remain private while public responses preserve the documented OpenAI-compatible contract and redaction rules.

## Verification

Run the focused Gateway, dispatcher, upstream client, OAuth, usage, converter, and prompt-cache tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).
