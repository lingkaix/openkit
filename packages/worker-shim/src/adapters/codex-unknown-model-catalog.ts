import { readFileSync } from 'node:fs';

/** Native catalog file name written under the Turn-private directory. */
export const CODEX_UNKNOWN_MODEL_CATALOG_FILE = 'model-catalog.json';

/** Exact pinned bundled metadata retained when the native catalog is replaced. */
const BUNDLED_MODELS = JSON.parse(
  readFileSync(
    new URL('../../snapshots/codex-0.153.4/bundled-models.json', import.meta.url),
    'utf8'
  )
) as { models: Array<{ slug: string }> };

const UNKNOWN_FALLBACK_PERSONALITY_SLUGS = new Set(['exp-codex-personality', 'gpt-5.2-codex']);
const DEFAULT_PERSONALITY_HEADER =
  "You are Codex, a coding agent based on GPT-5. You and the user share the same workspace and collaborate to achieve the user's goals.";
const LOCAL_FRIENDLY_TEMPLATE =
  'You optimize for team morale and being a supportive teammate as much as code quality.';
const LOCAL_PRAGMATIC_TEMPLATE = 'You are a deeply pragmatic, effective software engineer.';
const PERSONALITY_PLACEHOLDER = '{{ personality }}';

const FALLBACK_PROMPT_URL = new URL(
  '../../snapshots/codex-0.153.4/unknown-model-fallback-prompt.md',
  import.meta.url
);

/**
 * Reads the pinned Codex 0.153.4 default unknown-model instructions.
 *
 * @returns Pinned BASE_INSTRUCTIONS after native default-disabled plan-tool filtering.
 */
export function loadCodexUnknownModelFallbackPrompt(): string {
  return readFileSync(FALLBACK_PROMPT_URL, 'utf8');
}

/**
 * Checks the pinned native prefix/one-segment namespace lookup without replacing known metadata.
 *
 * @param model Exact selected logical model slug.
 * @returns Whether the pinned bundled catalog matches the model.
 */
export function hasPinnedCodexModelMetadata(model: string): boolean {
  const suffix = /^[A-Za-z0-9_-]+\/([^/]+)$/.exec(model)?.[1];
  return BUNDLED_MODELS.models.some(
    ({ slug }) => model.startsWith(slug) || suffix?.startsWith(slug) === true
  );
}

/**
 * Builds one secret-free native ModelsResponse reproducing pinned unknown-model fallback
 * metadata, changing only `apply_patch_tool_type` to freeform.
 *
 * Catalog JSON omits `model_messages` for the ordinary fallback path. Codex 0.153.4
 * `ModelsResponse` deserialize rejects a model missing both `base_instructions` and
 * `model_messages.instructions_template`, so the pinned native-default instructions are supplied as
 * `base_instructions` and promoted into the instruction template.
 *
 * @param slug Exact selected logical model slug.
 * @returns ModelsResponse JSON accepted by Codex 0.153.4 `model_catalog_json`.
 */
export function buildCodexUnknownModelCatalogJson(slug: string): string {
  const prompt = loadCodexUnknownModelFallbackPrompt();
  const personality = UNKNOWN_FALLBACK_PERSONALITY_SLUGS.has(slug);
  return `${JSON.stringify({
    models: [
      {
        apply_patch_tool_type: 'freeform',
        availability_nux: null,
        ...(personality
          ? {
              model_messages: {
                instructions_template: `${DEFAULT_PERSONALITY_HEADER}\n\n${PERSONALITY_PLACEHOLDER}\n\n${prompt}`,
                instructions_variables: {
                  personality_default: '',
                  personality_friendly: LOCAL_FRIENDLY_TEMPLATE,
                  personality_pragmatic: LOCAL_PRAGMATIC_TEMPLATE,
                },
              },
            }
          : { base_instructions: prompt }),
        context_window: 272_000,
        default_verbosity: null,
        description: null,
        display_name: slug,
        experimental_supported_tools: [],
        include_apps_usage_instructions: false,
        max_context_window: 272_000,
        priority: 99,
        shell_type: 'unified_exec',
        slug,
        support_verbosity: false,
        supported_in_api: true,
        supported_reasoning_levels: [],
        truncation_policy: { limit: 10_000, mode: 'bytes' },
        upgrade: null,
        visibility: 'none',
      },
      ...BUNDLED_MODELS.models,
    ],
  })}\n`;
}
