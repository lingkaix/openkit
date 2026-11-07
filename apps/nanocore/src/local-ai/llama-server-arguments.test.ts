import { describe, expect, it } from 'vitest';
import {
  llamaRuntimeArtifact,
  llamaServerArguments,
  llmArtifacts,
  llmWeightArtifact,
} from './catalog.js';
import {
  builtinLocalProfiles,
  LOCAL_LLM_DEFAULT_MODEL_ID,
  LOCAL_LLM_PROFILE_ID,
} from './profiles.js';

describe('llama backend profile and arguments', () => {
  it('keeps both GGUF rows and qwen3-0.6b as the default model', () => {
    const llm = builtinLocalProfiles().find((profile) => profile.id === LOCAL_LLM_PROFILE_ID);
    expect(llm?.defaultModel).toBe(LOCAL_LLM_DEFAULT_MODEL_ID);
    expect(llm?.models).toEqual(['qwen3-0.6b-q4_k_m', 'qwen3-1.7b-q4_k_m']);
    expect(llm?.extensions?.openkit?.localBackend).toEqual({ backendId: 'llama-cpp' });
    expect(llm?.modelMetadata?.[LOCAL_LLM_DEFAULT_MODEL_ID]?.limit).toEqual({
      context: 6144,
      output: 128,
    });
  });

  it('pins the Linux CPU runtimes and both GGUF rows', () => {
    expect(llamaRuntimeArtifact('linux', 'x64')).toMatchObject({
      bytes: 23_058_802,
      sha256: 'c1dbfdb9cbef7ee50b6ab08142d6424184d68b242906837770439ed118c57d99',
    });
    expect(llamaRuntimeArtifact('linux', 'arm64')).toMatchObject({
      bytes: 18_731_999,
      sha256: '57a4c7f59d2e8c790872141f0f9299cd5cc53b20e3ef3fcf2a7f3344eb8f1e72',
    });
    expect(llmWeightArtifact('qwen3-0.6b-q4_k_m')).toMatchObject({
      bytes: 396_705_472,
      sha256: 'ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a',
      fileName: 'Qwen3-0.6B-Q4_K_M.gguf',
    });
    expect(llmArtifacts('qwen3-0.6b-q4_k_m', 'linux', 'x64')).toHaveLength(2);
    expect(llmArtifacts('missing', 'linux', 'x64')).toEqual([]);
  });

  it('builds the fixed llama-server profile', () => {
    expect(llamaServerArguments({ port: 9, modelPath: '/models/Qwen3-0.6B-Q4_K_M.gguf' })).toEqual([
      '--host',
      '127.0.0.1',
      '--port',
      '9',
      '--threads',
      '4',
      '--threads-batch',
      '4',
      '--parallel',
      '1',
      '--ctx-size',
      '6144',
      '--cache-type-k',
      'q8_0',
      '--cache-type-v',
      'q8_0',
      '--reasoning',
      'off',
      '--no-webui',
      '--model',
      '/models/Qwen3-0.6B-Q4_K_M.gguf',
    ]);
  });
});
