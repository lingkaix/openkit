# Provider Templates

These templates are copied into `OPENKIT_DATA_ROOT/config/providers/` when missing. Opt-in examples and the custom placeholder are installed as non-loadable `.example` files; they are not active Provider profiles.

## Templates

- `anthropic-worker-direct.provider.jsonc`: credential-free registry metadata for the pinned Pi worker route; the Pi AgentManifest and its VaultGrant own `ANTHROPIC_API_KEY` injection.
- `openai-default.provider.jsonc`: OpenAI direct provider using `vault://provider_openai`.
- `openrouter-default.provider.jsonc`: OpenRouter gateway provider using `vault://provider_openrouter`.
- `xai-grok-default.provider.jsonc`: xAI Grok direct provider using `vault://provider_xai`.
- `google-gemini-default.provider.jsonc`: Google Gemini direct provider using `vault://provider_google`.
- `openai-compatible-custom.provider.jsonc`: custom OpenAI-compatible example using `vault://provider_openai_compatible_custom`, installed with an additional `.example` suffix. Supply the real endpoint, model ID and required maximum context before activating it as a `.provider.jsonc` file.

## Credentials

Operators should keep credentials out of provider files and create the matching vault reference before enabling a provider.

The active starter provider ids and model ids are traceable to the vendored `models.dev` snapshot under `packages/models-dev-catalog/snapshots/2026-07-11/`.

The custom OpenAI-compatible template is operator-defined and intentionally has no upstream `models.dev` provider id. Its placeholder model has no real context limit; adding a fabricated limit to satisfy startup validation is not a supported activation procedure.

## Current OpenAI Flagships

`openai-flagship.provider.jsonc` and `openai-codex-subscription.provider.jsonc` are installed with a non-loadable `.example` suffix. They provide official `modelMetadata` overlays for models newer than the pinned inventory, using the existing [Gateway metadata contract](../../../../../docs/specs/20260526-llm_gateway_responses_api.md#provider-model-metadata). They do not replace an operator profile, select an account slot, or change the default Gateway routes automatically.

All four direct API models use the official 1,050,000-token context window. By Simon's product constraint, every Codex subscription model advertises a 256,000-token context window instead. Both templates retain the official 128,000-token maximum output, text/image input, text output, reasoning, and function calling. The direct API template uses the API IDs below; the subscription template prefixes each with `openai-codex/`. Metadata keys exactly match the corresponding `models` entries.

| API model ID | Knowledge cutoff | Reasoning efforts | Input / cached input / output USD per MTok |
| --- | --- | --- | --- |
| `gpt-6-astra` | 2026-04-30 | `low`, `medium`, `high`, `xhigh`, `max` | 10 / 1 / 50 |
| `gpt-5.6-sol` | 2026-02-16 | `none`, `low`, `medium`, `high`, `xhigh`, `max` | 4 / 0.40 / 20 |
| `gpt-5.6-terra` | 2026-02-16 | `none`, `low`, `medium`, `high`, `xhigh`, `max` | 2 / 0.20 / 12 |
| `gpt-5.6-luna` | 2026-02-16 | `none`, `low`, `medium`, `high`, `xhigh`, `max` | 0.20 / 0.02 / 1.20 |

Sources verified 2026-09-12: [OpenAI model index](https://developers.openai.com/api/docs/models), [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), and [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna). OpenAI also publishes `gpt-5.6` as a Sol alias; these templates use the canonical ID. Astra does not support `none`. Effort lists and cutoffs are documented here because `modelMetadata` has neither an effort enum nor a cutoff field; requests carry `reasoning.effort` through the existing Gateway request contract.

Costs are standard API base rates, not subscription charges or a complete pricing schedule. Astra's published cache-write rate is 12.50 USD/MTok. Long-input, service-tier, and tool charges are outside these flat overlay fields; the templates do not model those rates. Model configuration does not establish account entitlement.

For direct API access, merge `models` and `modelMetadata` into the existing `openai` profile, retaining any models still used by existing routes and the existing credential reference. Do not activate a second file with the same profile ID. For Codex subscription access, merge the prefixed entries into the selected OAuth profile, preserving its `id`, `vendor`, and `extensions.openkit.subscriptionAccount.accountSlotId`. When creating a profile from the example instead, replace `operator-selected-slot` with an existing account slot before removing `.example`; keep credentials in the account's Vault-backed store.

Add a single-route logical model to `gateway.jsonc`, substituting the actual profile ID:

```jsonc
{
  "id": "gpt-6-astra",
  "displayName": "GPT-6 Astra",
  "contextManagement": [{ "type": "compaction", "compactThreshold": 128000 }],
  "routes": [
    {
      "id": "codex-astra",
      "providerProfileId": "openai_codex",
      "providerModel": "openai-codex/gpt-6-astra"
    }
  ]
}
```

For API-key access use `providerProfileId: "openai"` and `providerModel: "gpt-6-astra"`. Select the new logical model explicitly or change `defaultLogicalModelId` intentionally. A GPT-6 route must name Astra itself, with no Sol fallback masquerading as GPT-6. OpenKit requires both `compactThreshold <= contextLimit` and `compactThreshold + outputLimit <= contextLimit`; the maximum is 128,000 for the capped Codex subscription context and 922,000 for direct API access. The example uses 128,000. A preexisting subscription threshold of 200,000 must be lowered to at most 128,000 when applying this cap. Validate the composed configuration, then follow its reported apply/restart requirement; running deployments are not rewritten by template updates.
