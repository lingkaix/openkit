# Provider Templates

These JSONC templates are copied into `OPENKIT_DATA_ROOT/config/providers/` when missing.

## Templates

- `openai-default.provider.jsonc`: OpenAI direct provider using `vault://provider_openai`.
- `openrouter-default.provider.jsonc`: OpenRouter gateway provider using `vault://provider_openrouter`.
- `xai-grok-default.provider.jsonc`: xAI Grok direct provider using `vault://provider_xai`.
- `google-gemini-default.provider.jsonc`: Google Gemini direct provider using `vault://provider_google`.
- `openai-compatible-custom.provider.jsonc`: custom OpenAI-compatible placeholder using `vault://provider_openai_compatible_custom`.

## Credentials

Operators should keep credentials out of provider files and create the matching vault reference before enabling a provider.

The non-custom provider ids and starter model ids are traceable to the vendored `models.dev` snapshot under `packages/models-dev-catalog/snapshots/2026-07-11/`.

The custom OpenAI-compatible template is operator-defined and intentionally has no upstream `models.dev` provider id.
