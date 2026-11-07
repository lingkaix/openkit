import { createHash } from 'node:crypto';

/** One pinned download. */
export interface LocalArtifact {
  readonly id: string;
  readonly license: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly archive: 'tar.bz2' | 'tar.gz';
  /** Path relative to server/files/local-ai. */
  readonly publishPath: string;
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
