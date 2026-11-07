import type { ProviderProfile } from '@openkit/config-schema';

/** Built-in speech profile id. */
export const LOCAL_SPEECH_PROFILE_ID = 'openkit-local-speech';

/** Built-in small-LLM profile id. */
export const LOCAL_LLM_PROFILE_ID = 'openkit-local-llm';

/** Speech model id served by the SenseVoice int8 pipeline. */
export const LOCAL_SPEECH_MODEL_ID = 'sense-voice-zh-en-punct-int8';

/** Default title model. The runtime that serves it arrives with the LLM phase. */
export const LOCAL_LLM_DEFAULT_MODEL_ID = 'qwen3-0.6b-q4_k_m';

/** Optional larger title model. */
export const LOCAL_LLM_OPTIONAL_MODEL_ID = 'qwen3-1.7b-q4_k_m';

const llmMetadata = {
  cost: { cache_read: 0, cache_write: 0, input: 0, output: 0 },
  limit: { context: 6144, output: 128 },
  modalities: { input: ['text' as const], output: ['text' as const] },
  reasoning: false,
  temperature: true,
  tool_call: false,
};

/** Inert built-in profiles. Enable does not rewrite them. */
export function builtinLocalProfiles(): ProviderProfile[] {
  const speech: ProviderProfile = {
    id: LOCAL_SPEECH_PROFILE_ID,
    displayName: 'Local Speech',
    kind: 'local',
    vendor: 'openkit',
    models: [LOCAL_SPEECH_MODEL_ID],
    extensions: { openkit: { localBackend: { backendId: 'sherpa-onnx-asr' } } },
  };
  const llm: ProviderProfile = {
    id: LOCAL_LLM_PROFILE_ID,
    displayName: 'Local Small LLM',
    kind: 'local',
    vendor: 'openkit',
    defaultModel: LOCAL_LLM_DEFAULT_MODEL_ID,
    models: [LOCAL_LLM_DEFAULT_MODEL_ID, LOCAL_LLM_OPTIONAL_MODEL_ID],
    modelMetadata: {
      [LOCAL_LLM_DEFAULT_MODEL_ID]: llmMetadata,
      [LOCAL_LLM_OPTIONAL_MODEL_ID]: llmMetadata,
    },
    extensions: { openkit: { localBackend: { backendId: 'llama-cpp' } } },
  };
  return [speech, llm];
}
