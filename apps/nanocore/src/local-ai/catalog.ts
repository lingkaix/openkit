import { createHash } from 'node:crypto';

/** One pinned download. */
export interface LocalArtifact {
  readonly id: string;
  readonly license: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly archive: 'tar.bz2' | 'tar.gz' | 'file';
  /** Path relative to server/files/local-ai. A file artifact publishes fileName inside this directory. */
  readonly publishPath: string;
  /** File name inside publishPath when archive is `file`. */
  readonly fileName?: string;
}

const SENSE_VOICE_LICENSE =
  'Apache-2.0. Archive README points at ASLP-lab/WSYue-ASR (license: apache-2.0).';
const PUNCT_LICENSE = 'Apache-2.0. iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch.';
const SHERPA_LICENSE = 'Apache-2.0';

const senseVoice: LocalArtifact = {
  id: 'sense-voice-int8',
  license: SENSE_VOICE_LICENSE,
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2',
  bytes: 165_783_878,
  sha256: '7305f7905bfcf77fa0b39388a313f3da35c68d971661a65475b56fb2162c8e63',
  archive: 'tar.bz2',
  publishPath: 'models/sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
};

const punctuation: LocalArtifact = {
  id: 'ct-transformer-punct-int8',
  license: PUNCT_LICENSE,
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2',
  bytes: 64_717_756,
  sha256: 'c0d5aa5f8eeb686032345e180bedf39319dc2e0556781c6264bcadba8328a6e1',
  archive: 'tar.bz2',
  publishPath: 'models/punct-ct-transformer-zh-en-2024-04-12-int8',
};

const sherpaNode: LocalArtifact = {
  id: 'sherpa-onnx-node-1.12.28',
  license: SHERPA_LICENSE,
  url: 'https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-1.12.28.tgz',
  bytes: 10_008,
  sha256: '60dd744c1f2447cbb57a415fbba6594c5a374694fa8fb7e8bbf98b82f7959471',
  archive: 'tar.gz',
  publishPath: 'bin/sherpa-onnx-node-1.12.28',
};

const sherpaLinux: Record<string, LocalArtifact> = {
  x64: {
    id: 'sherpa-onnx-1.12.28-linux-x64',
    license: SHERPA_LICENSE,
    url: 'https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-1.12.28.tgz',
    bytes: 10_033_144,
    sha256: '2c538aab789842e436d9f88e08f8e8cefd7036771ab446d48b750f743bf376e2',
    archive: 'tar.gz',
    publishPath: 'bin/sherpa-onnx-linux-x64',
  },
  arm64: {
    id: 'sherpa-onnx-1.12.28-linux-arm64',
    license: SHERPA_LICENSE,
    url: 'https://registry.npmjs.org/sherpa-onnx-linux-arm64/-/sherpa-onnx-linux-arm64-1.12.28.tgz',
    bytes: 12_728_246,
    sha256: '98c099bed5a1440a8a156fdb0eb5e2b1cbd877618f7bdf515eb4fbc6e61ae44b',
    archive: 'tar.gz',
    publishPath: 'bin/sherpa-onnx-linux-arm64',
  },
};

/** Speech artifacts for one platform. The native package path is the one the sherpa loader requires. */
export function speechArtifacts(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): readonly LocalArtifact[] {
  if (platform !== 'linux') return [];
  const native = sherpaLinux[arch];
  if (!native) return [];
  return [senseVoice, punctuation, sherpaNode, native];
}

/** License text shown before a speech download. */
export function speechLicenseText(): string {
  return `${SENSE_VOICE_LICENSE} ${PUNCT_LICENSE} Runtime: ${SHERPA_LICENSE}.`;
}

/** Bytes of the speech weights and runtime for this platform. */
export function speechDownloadBytes(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): number {
  return speechArtifacts(platform, arch).reduce((sum, artifact) => sum + artifact.bytes, 0);
}

const LLAMA_LICENSE = 'MIT';
const QWEN_LICENSE = 'Apache-2.0 (Qwen/Qwen3-0.6B and Qwen/Qwen3-1.7B).';

const llamaBinary: Record<string, LocalArtifact> = {
  'linux-x64': {
    id: 'llama-cpp-b12182-linux-x64',
    license: LLAMA_LICENSE,
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12182/llama-b12182-bin-ubuntu-x64.tar.gz',
    bytes: 23_058_802,
    sha256: 'c1dbfdb9cbef7ee50b6ab08142d6424184d68b242906837770439ed118c57d99',
    archive: 'tar.gz',
    publishPath: 'bin/llama-b12182-linux-x64',
  },
  'linux-arm64': {
    id: 'llama-cpp-b12182-linux-arm64',
    license: LLAMA_LICENSE,
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12182/llama-b12182-bin-ubuntu-arm64.tar.gz',
    bytes: 18_731_999,
    sha256: '57a4c7f59d2e8c790872141f0f9299cd5cc53b20e3ef3fcf2a7f3344eb8f1e72',
    archive: 'tar.gz',
    publishPath: 'bin/llama-b12182-linux-arm64',
  },
  'darwin-arm64': {
    id: 'llama-cpp-b12182-macos-arm64',
    license: LLAMA_LICENSE,
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12182/llama-b12182-bin-macos-arm64.tar.gz',
    bytes: 16_698_597,
    sha256: '71cfee075e0c54852e225dafdc8dc79c32b26e8d45f052369b7d4f78d2ccf1a6',
    archive: 'tar.gz',
    publishPath: 'bin/llama-b12182-macos-arm64',
  },
};

const qwen06: LocalArtifact = {
  id: 'qwen3-0.6b-q4_k_m',
  license: QWEN_LICENSE,
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf',
  bytes: 396_705_472,
  sha256: 'ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a',
  archive: 'file',
  publishPath: 'models/qwen3-0.6b-q4_k_m',
  fileName: 'Qwen3-0.6B-Q4_K_M.gguf',
};

const qwen17: LocalArtifact = {
  id: 'qwen3-1.7b-q4_k_m',
  license: QWEN_LICENSE,
  url: 'https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf',
  bytes: 1_282_439_264,
  sha256: 'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5',
  archive: 'file',
  publishPath: 'models/qwen3-1.7b-q4_k_m',
  fileName: 'Qwen3-1.7B-Q4_K_M.gguf',
};

const llmWeights: Record<string, LocalArtifact> = {
  'qwen3-0.6b-q4_k_m': qwen06,
  'qwen3-1.7b-q4_k_m': qwen17,
};

/** Pinned llama.cpp runtime for this platform. macOS arm64 keeps the published Metal build. */
export function llamaRuntimeArtifact(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): LocalArtifact | undefined {
  return llamaBinary[`${platform}-${arch}`];
}

/** Pinned GGUF for one local LLM model id. */
export function llmWeightArtifact(modelId: string): LocalArtifact | undefined {
  return llmWeights[modelId];
}

/** Runtime plus the selected GGUF. An unknown platform or model yields nothing. */
export function llmArtifacts(
  modelId: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): readonly LocalArtifact[] {
  const runtime = llamaRuntimeArtifact(platform, arch);
  const weight = llmWeightArtifact(modelId);
  if (!runtime || !weight) return [];
  return [runtime, weight];
}

/** License text shown before an LLM download. */
export function llmLicenseText(): string {
  return `Runtime: ${LLAMA_LICENSE}. Weights: ${QWEN_LICENSE}`;
}

/** Bytes of the runtime and one GGUF. */
export function llmDownloadBytes(
  modelId: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): number {
  return llmArtifacts(modelId, platform, arch).reduce((sum, artifact) => sum + artifact.bytes, 0);
}

/** Arguments for one llama-server process. The model path is the published GGUF. */
export function llamaServerArguments(input: {
  readonly port: number;
  readonly modelPath: string;
  readonly threads?: number;
}): string[] {
  const threads = input.threads ?? 4;
  return [
    '--host',
    '127.0.0.1',
    '--port',
    String(input.port),
    '--threads',
    String(threads),
    '--threads-batch',
    String(threads),
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
    input.modelPath,
  ];
}

/** SHA-256 of complete bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Refuses a body whose length or digest differs from the pin.
 *
 * @param expected Pinned length and digest.
 * @param body Complete download body.
 */
export function assertArtifactBytes(
  expected: { readonly bytes: number; readonly sha256: string },
  body: Uint8Array
): void {
  if (body.byteLength !== expected.bytes) {
    throw new Error(`Artifact length ${body.byteLength} does not match ${expected.bytes}.`);
  }
  const digest = sha256Hex(body);
  if (digest !== expected.sha256) {
    throw new Error(`Artifact digest ${digest} does not match the pinned digest.`);
  }
}
