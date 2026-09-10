# Provider Templates

These templates are copied into `OPENKIT_DATA_ROOT/config/providers/` when missing. The custom placeholder is installed as a non-loadable `.example` file; it is not an active Provider profile.

## Templates

- `anthropic-worker-direct.provider.jsonc`: credential-free registry metadata for the pinned Pi worker route; the Pi AgentManifest and its VaultGrant own `ANTHROPIC_API_KEY` injection.
- `openai-default.provider.jsonc`: OpenAI direct provider using `vault://provider_openai`.
- `openrouter-default.provider.jsonc`: OpenRouter gateway provider using `vault://provider_openrouter`.
- `xai-grok-default.provider.jsonc`: xAI Grok direct provider using `vault://provider_xai`.
- `google-gemini-default.provider.jsonc`: Google Gemini direct provider using `vault://provider_google`.
- `openai-compatible-custom.provider.jsonc`: custom OpenAI-compatible example using `vault://provider_openai_compatible_custom`, installed with an additional `.example` suffix. Supply the real endpoint, model ID and required maximum context before activating it as a `.provider.jsonc` file.

## Credentials

Operators should keep credentials out of provider files and create the matching vault reference before enabling a provider.

The non-custom provider ids and starter model ids are traceable to the vendored `models.dev` snapshot under `packages/models-dev-catalog/snapshots/2026-07-11/`.

The custom OpenAI-compatible template is operator-defined and intentionally has no upstream `models.dev` provider id. Its placeholder model has no real context limit; adding a fabricated limit to satisfy startup validation is not a supported activation procedure.
