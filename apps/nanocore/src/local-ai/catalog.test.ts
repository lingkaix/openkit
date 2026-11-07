import { describe, expect, it } from 'vitest';
import { assertArtifactBytes, sha256Hex, speechArtifacts, speechDownloadBytes } from './catalog.js';

describe('speech catalog', () => {
  it('pins the linux x64 speech artifacts', () => {
    const artifacts = speechArtifacts('linux', 'x64');
    expect(artifacts.map((artifact) => artifact.publishPath)).toEqual([
      'models/sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
      'models/punct-ct-transformer-zh-en-2024-04-12-int8',
      'bin/sherpa-onnx-node-1.12.28',
      'bin/sherpa-onnx-linux-x64',
    ]);
    expect(artifacts.map((artifact) => [artifact.bytes, artifact.sha256, artifact.url])).toEqual([
      [
        165_783_878,
        '7305f7905bfcf77fa0b39388a313f3da35c68d971661a65475b56fb2162c8e63',
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2',
      ],
      [
        64_717_756,
        'c0d5aa5f8eeb686032345e180bedf39319dc2e0556781c6264bcadba8328a6e1',
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2',
      ],
      [
        10_008,
        '60dd744c1f2447cbb57a415fbba6594c5a374694fa8fb7e8bbf98b82f7959471',
        'https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-1.12.28.tgz',
      ],
      [
        10_033_144,
        '2c538aab789842e436d9f88e08f8e8cefd7036771ab446d48b750f743bf376e2',
        'https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-1.12.28.tgz',
      ],
    ]);
    expect(speechDownloadBytes('linux', 'x64')).toBe(
      artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0)
    );
  });

  it('has no speech runtime outside linux x64 and arm64', () => {
    expect(speechArtifacts('darwin', 'arm64')).toEqual([]);
    expect(speechArtifacts('linux', 'ia32')).toEqual([]);
    expect(speechDownloadBytes('darwin', 'arm64')).toBe(0);
  });

  it('refuses a body whose length or digest differs from the pin', () => {
    const pinned = { bytes: 4, sha256: sha256Hex(Buffer.from('good')) };
    expect(() => assertArtifactBytes(pinned, Buffer.from('bad!'))).toThrow(/digest/);
    expect(() => assertArtifactBytes(pinned, Buffer.from('no'))).toThrow(/length/);
    expect(() => assertArtifactBytes(pinned, Buffer.from('good'))).not.toThrow();
  });
});
