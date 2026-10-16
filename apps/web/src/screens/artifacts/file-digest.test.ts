import { Blob } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { sha256ArtifactFile } from './file-digest';

/** Independent exact originals frozen before the production file path. */
const corpus = JSON.parse(
  readFileSync(
    new NodeURL('../../../../../tests/fixtures/large-context/cases.json', import.meta.url),
    'utf8'
  )
) as {
  originals: Array<{ id: string; patternHex: string; repeats: number; sha256: string }>;
};

describe('Artifact file integrity before upload', () => {
  it.each(
    corpus.originals
  )('hashes the exact $id bytes without using whole-file reads', async (original) => {
    const bytes = Buffer.from(original.patternHex.repeat(original.repeats), 'hex');
    const file = new Blob([bytes]);
    const whole = vi.spyOn(file, 'arrayBuffer');
    const text = vi.spyOn(file, 'text');
    const slice = vi.spyOn(file, 'slice');
    expect(await sha256ArtifactFile(file as unknown as globalThis.Blob)).toBe(original.sha256);
    expect(whole).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    for (const [start, end] of slice.mock.calls)
      expect(Number(end) - Number(start)).toBeLessThanOrEqual(65_536);
  });
});
